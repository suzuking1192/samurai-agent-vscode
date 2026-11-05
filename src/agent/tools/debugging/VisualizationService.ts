/**
 * Visualization Service for Debugging Flow Graphs
 * 
 * Generates deterministic Mermaid flowcharts from execution graphs.
 * 
 * NOTE (2025-11): LLM-based mermaid beautification removed from core path
 * to guarantee deterministic, fast visualization for Samurai Agent beta.
 * If you need LLM-based fixes, use VisualizationLLMFixer.
 * 
 * Implements parity enforcement to prevent hallucinated nodes/edges.
 */

import { LLMProviderService } from '../../llm/llmProviderService';
import { GraphNode, GraphEdge, Evidence, NodeLocationMap, NodeVisualizationInfoMap, GraphCompressorInput } from './types';
import { RootCauseReport, VisualizationMeta } from './rootCauseTypes';
import { validateMermaid } from './MermaidValidator';
import { sanitizeMermaid } from '../../util/mermaidSanitizer';
import { classifyNodeRole, NodeContext } from './NodeRoleClassifier';
import { GraphCompressor } from './GraphCompressor';
import * as fs from 'fs';
import * as path from 'path';

const DETERMINISTIC_MERMAID_VERSION = "1.0.0";
const MAX_NODES_FOR_MERMAID = 20;
const MAX_EDGES_FOR_MERMAID = 300;
const MAX_LABEL_LENGTH = 70;
// Limit the number of nodes highlighted as suspect to avoid overwhelming the graph
const MAX_HIGHLIGHTED_SUSPECTS = 3;

const extractCssVariableFallback = (value: string): string => {
  if (!value.includes('var(')) {
    return value.trim();
  }

  // Simple parser for CSS variable with fallback: var(--token, fallback)
  const match = value.match(/^var\(\s*[^,]+,\s*([^)]+)\)$/);
  if (match && match[1]) {
    return match[1].trim();
  }

  // Fallback: return original without var() to avoid invalid Mermaid tokens
  return value.replace(/^var\(\s*|\)$/g, '').trim();
};

const MERMAID_NODE_TEXT_COLOR = extractCssVariableFallback('var(--mermaid-node-text-color, #111827)');
const MERMAID_EDGE_LABEL_COLOR = extractCssVariableFallback('var(--mermaid-edge-label-color, #334155)');
const MERMAID_EDGE_STROKE_COLOR = extractCssVariableFallback('var(--mermaid-edge-stroke-color, #94a3b8)');

const MERMAID_ROLE_CLASS_DEF_LINES = [
  {
    name: 'ui',
    fill: extractCssVariableFallback('var(--mermaid-role-ui-fill, #E2E8F0)'),
    stroke: extractCssVariableFallback('var(--mermaid-role-ui-stroke, #475569)')
  },
  {
    name: 'api',
    fill: extractCssVariableFallback('var(--mermaid-role-api-fill, #E0E7FF)'),
    stroke: extractCssVariableFallback('var(--mermaid-role-api-stroke, #4338CA)')
  },
  {
    name: 'data',
    fill: extractCssVariableFallback('var(--mermaid-role-data-fill, #E0F2F1)'),
    stroke: extractCssVariableFallback('var(--mermaid-role-data-stroke, #0F766E)')
  },
  {
    name: 'auth',
    fill: extractCssVariableFallback('var(--mermaid-role-auth-fill, #F1F5F9)'),
    stroke: extractCssVariableFallback('var(--mermaid-role-auth-stroke, #334155)')
  },
  {
    name: 'infra',
    fill: extractCssVariableFallback('var(--mermaid-role-infra-fill, #F3F4F6)'),
    stroke: extractCssVariableFallback('var(--mermaid-role-infra-stroke, #4B5563)')
  }
].map(({ name, fill, stroke }) =>
  `classDef ${name} fill:${fill},stroke:${stroke},color:${MERMAID_NODE_TEXT_COLOR},stroke-width:1px;`
);

const MERMAID_DEFAULT_LINK_STYLE = `linkStyle default stroke:${MERMAID_EDGE_STROKE_COLOR},color:${MERMAID_EDGE_LABEL_COLOR};`;

// Graph filtering constants for relevance-based filtering
const RELEVANT_UPSTREAM_HOPS = 2;
const RELEVANT_DOWNSTREAM_HOPS = 1;
const RELEVANT_MAX_NODES = 20; // safety cap

// Graph pruning constants for trivial node removal
const TRIVIAL_NODE_KEYWORDS = [
  'console.log',
  'console.warn',
  'console.error',
  'map',
  'filter',
  'forEach',
  'getAttribute',
  'setAttribute',
  'hasOwnProperty',
  'keys',
  'preventDefault',
  'push'
];

const TRIVIALITY_THRESHOLD = 50; // Nodes with score > this will be pruned
const HIGH_INDEGREE_THRESHOLD = 10; // Nodes with indegree > this are likely utilities
const LOW_LOC_THRESHOLD = 5; // Functions with LOC <= this are likely wrappers
const HIGH_LOC_THRESHOLD = 25; // Functions with LOC > this are protected from pruning

export interface MermaidDiagnostic {
  code: string;        // e.g., "NODE_LIMIT_REACHED", "INVALID_SYNTAX"
  message: string;
  line?: number;
  column?: number;
  detail?: string;     // e.g., "174 -> 120"
}

export interface VisualizationResult {
  mermaid: string;                 // best effort, always present (valid error graph if generation failed)
  meta: VisualizationMeta;
  isValid: boolean;               // result of validateMermaid
  diagnostics: MermaidDiagnostic[]; // structured issues
  sourceGraphVersion: string;     // e.g., "1.0.0"
  nodeLocationMap: NodeLocationMap; // Map from node ID to file location (uses normalized IDs)
  nodeInfoMap: NodeVisualizationInfoMap; // Map from node ID to tooltip metadata (uses normalized IDs)
  normalizedNodes?: GraphNode[]; // Normalized nodes with IDs matching the Mermaid diagram
  originalInvalidMermaid?: string; // original invalid mermaid graph (for debugging when isValid=false)
}

export interface ExecutionGraph {
  nodes: GraphNode[];
  edges: GraphEdge[];
}

export class VisualizationService {
  private graphCompressor: GraphCompressor;
  
  constructor(private llmProvider: LLMProviderService) {
    this.graphCompressor = new GraphCompressor(llmProvider);
  }

  /**
   * Save debug output as JSON file (similar to samuraiAgent.saveDebugOutputJSON)
   */
  private saveCheckpointJSON(
    content: any,
    workspaceRoot: string,
    subdirectory: string,
    filename?: string
  ): string | null {
    try {
      const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
      const outputDir = path.join(workspaceRoot, 'debug-output', subdirectory);
      
      if (!fs.existsSync(outputDir)) {
        fs.mkdirSync(outputDir, { recursive: true });
      }
      
      const finalFilename = filename || `${timestamp}.json`;
      const filePath = path.join(outputDir, finalFilename);
      fs.writeFileSync(filePath, JSON.stringify(content, null, 2), 'utf8');
      return filePath;
    } catch (error) {
      console.error(`[Visualization] Failed to save checkpoint JSON:`, error);
      return null;
    }
  }

  /**
   * Calculates lines of code for a node's function body
   * Returns null if LOC cannot be calculated
   */
  private _calculateNodeLOC(node: GraphNode, workspaceRoot?: string): number | null {
    if (!node.file) {
      return null;
    }

    try {
      const filePath = path.isAbsolute(node.file)
        ? node.file
        : workspaceRoot
        ? path.join(workspaceRoot, node.file)
        : node.file;

      if (!fs.existsSync(filePath)) {
        return null;
      }

      const content = fs.readFileSync(filePath, 'utf8');
      const lines = content.split('\n');

      let startLine = 1;
      let endLine = lines.length;

      // If span is available, convert character positions to line numbers
      if (node.span) {
        let charCount = 0;
        for (let i = 0; i < lines.length; i++) {
          const lineLength = lines[i].length + 1; // +1 for newline
          if (charCount <= node.span.start && charCount + lineLength > node.span.start) {
            startLine = i + 1;
            break;
          }
          charCount += lineLength;
        }
        charCount = 0;
        for (let i = 0; i < lines.length; i++) {
          const lineLength = lines[i].length + 1;
          if (charCount <= node.span.end && charCount + lineLength > node.span.end) {
            endLine = i + 1;
            break;
          }
          charCount += lineLength;
        }
      } else if (node.line) {
        // If only line is available, try to find function boundaries
        // This is a simplified heuristic: find opening/closing braces
        startLine = node.line;
        endLine = node.line;

        // Search backwards for function start (opening brace or function declaration)
        for (let i = node.line - 1; i >= 0; i--) {
          const line = lines[i];
          if (line.includes('{') || line.match(/(function|const|let|var|async)\s+\w+\s*[=:]/)) {
            startLine = i + 1;
            break;
          }
        }

        // Search forwards for function end (closing brace)
        let braceDepth = 0;
        let foundOpeningBrace = false;
        for (let i = Math.max(0, startLine - 1); i < lines.length; i++) {
          const line = lines[i];
          const openBraces = (line.match(/{/g) || []).length;
          const closeBraces = (line.match(/}/g) || []).length;

          if (openBraces > 0) {
            foundOpeningBrace = true;
          }

          if (foundOpeningBrace) {
            braceDepth += openBraces - closeBraces;
            if (braceDepth <= 0 && closeBraces > 0) {
              endLine = i + 1;
              break;
            }
          }
        }

        // If we couldn't find boundaries, use a small window around the line
        if (endLine === node.line) {
          startLine = Math.max(1, node.line - 2);
          endLine = Math.min(lines.length, node.line + 10);
        }
      } else {
        // No location info available
        return null;
      }

      // Calculate LOC (body only, excluding signature)
      // Try to find the opening brace to get body start
      let bodyStartLine = startLine;
      for (let i = startLine - 1; i < endLine && i < lines.length; i++) {
        if (lines[i].includes('{')) {
          bodyStartLine = i + 2; // Start after the opening brace line
          break;
        }
      }

      // Find closing brace for body end
      let bodyEndLine = endLine;
      for (let i = endLine - 1; i >= startLine - 1 && i >= 0; i--) {
        if (lines[i].includes('}')) {
          bodyEndLine = i; // End before the closing brace line
          break;
        }
      }

      const loc = Math.max(0, bodyEndLine - bodyStartLine + 1);
      return loc > 0 ? loc : null;
    } catch (error) {
      console.debug(`[Visualization] Failed to calculate LOC for node ${node.id}:`, error);
      return null;
    }
  }

  /**
   * Calculates triviality score for a node
   * Higher score means the node is more trivial/unimportant
   */
  private _getNodeTrivialityScore(
    node: GraphNode,
    indegree: number,
    workspaceRoot?: string
  ): number {
    let score = 0;

    const loc = node.loc ?? this._calculateNodeLOC(node, workspaceRoot);

    // ---
    // 1. PROTECTION HEURISTICS (Signal)
    // ---
    if (node.badges?.includes('spine')) {
      score -= 1000;
    }

    if (typeof loc === 'number' && loc >= HIGH_LOC_THRESHOLD) {
      score -= 200;
    }

    // ---
    // 2. PRUNING HEURISTICS (Noise)
    // ---
    // A. "Ghost" Node Heuristic (NEW!)
    if (!node.line || node.line <= 0) {
      score += 200;
    }

    // B. Library / Type Files
    if (node.file && (node.file.includes('node_modules/') || node.file.endsWith('.d.ts'))) {
      score += 1000;
    }

    // C. Trivial Keywords
    if (node.label && TRIVIAL_NODE_KEYWORDS.includes(node.label)) {
      score += 50;
    }

    if (indegree > HIGH_INDEGREE_THRESHOLD) {
      score += 100;
    }

    if (typeof loc === 'number' && loc > 0 && loc <= LOW_LOC_THRESHOLD) {
      score += 100;
    }

    return score;
  }

  /**
   * Prunes trivial nodes from the graph and rewires edges
   * Removes nodes with high triviality scores and creates transitive edges
   */
  private _pruneTrivialNodes(
    graph: ExecutionGraph,
    workspaceRoot?: string
  ): ExecutionGraph {
    if (graph.nodes.length === 0) {
      return graph;
    }

    // Build edge maps for efficient traversal
    const incomingEdges = new Map<string, GraphEdge[]>();
    const outgoingEdges = new Map<string, GraphEdge[]>();

    for (const edge of graph.edges) {
      // Build incoming edges map
      if (!incomingEdges.has(edge.to)) {
        incomingEdges.set(edge.to, []);
      }
      incomingEdges.get(edge.to)!.push(edge);

      // Build outgoing edges map
      if (!outgoingEdges.has(edge.from)) {
        outgoingEdges.set(edge.from, []);
      }
      outgoingEdges.get(edge.from)!.push(edge);
    }

    // Calculate triviality scores for all nodes
    const nodeScores = new Map<string, number>();
    for (const node of graph.nodes) {
      const indegree = (incomingEdges.get(node.id) || []).length;
      const score = this._getNodeTrivialityScore(node, indegree, workspaceRoot);
      nodeScores.set(node.id, score);
    }

    // Identify trivial nodes (score > threshold)
    const trivialNodeIds = new Set<string>();
    for (const [nodeId, score] of nodeScores.entries()) {
      if (score > TRIVIALITY_THRESHOLD) {
        trivialNodeIds.add(nodeId);
      }
    }

    // Edge case: If all nodes are trivial, skip pruning
    if (trivialNodeIds.size === graph.nodes.length) {
      console.debug('[Visualization] All nodes are trivial, skipping pruning');
      return graph;
    }

    // Edge case: If no nodes are trivial, return original graph
    if (trivialNodeIds.size === 0) {
      return graph;
    }

    // Build transitive edges for each trivial node
    const transitiveEdges = new Map<string, Set<string>>(); // from -> Set<to>
    const edgeConfidences = new Map<string, number>(); // "from->to" -> confidence

    // Helper function to find all non-trivial descendants through trivial nodes
    const findNonTrivialDescendants = (nodeId: string, visited: Set<string> = new Set()): Array<{ nodeId: string; confidence: number }> => {
      if (visited.has(nodeId)) {
        return [];
      }
      visited.add(nodeId);

      const children = (outgoingEdges.get(nodeId) || []).map(e => ({ nodeId: e.to, confidence: e.confidence }));
      const result: Array<{ nodeId: string; confidence: number }> = [];

      for (const child of children) {
        if (trivialNodeIds.has(child.nodeId)) {
          // Continue through trivial nodes
          const descendants = findNonTrivialDescendants(child.nodeId, visited);
          for (const desc of descendants) {
            result.push({ nodeId: desc.nodeId, confidence: Math.min(child.confidence, desc.confidence) });
          }
        } else {
          // Found non-trivial descendant
          result.push(child);
        }
      }

      return result;
    };

    for (const trivialNodeId of trivialNodeIds) {
      // Find all parent nodes (callers) - only non-trivial ones
      const parents = (incomingEdges.get(trivialNodeId) || [])
        .map(e => e.from)
        .filter(parent => !trivialNodeIds.has(parent));

      // Find all non-trivial descendants (including through chains of trivial nodes)
      const descendants = findNonTrivialDescendants(trivialNodeId);

      // Create transitive edges: for each parent-descendant pair
      for (const parent of parents) {
        const parentToTrivial = incomingEdges.get(trivialNodeId)?.find(e => e.from === parent);
        const baseConfidence = parentToTrivial?.confidence || 0.5;

        for (const descendant of descendants) {
          // Skip self-loops
          if (parent === descendant.nodeId) {
            continue;
          }

          // Track confidence (use minimum of parent->trivial and path to descendant)
          const confidence = Math.min(baseConfidence, descendant.confidence);

          // Add transitive edge
          const edgeKey = `${parent}->${descendant.nodeId}`;
          if (!transitiveEdges.has(parent)) {
            transitiveEdges.set(parent, new Set());
          }
          transitiveEdges.get(parent)!.add(descendant.nodeId);
          
          // Use minimum confidence if edge already exists
          const existingConfidence = edgeConfidences.get(edgeKey);
          if (existingConfidence === undefined || confidence < existingConfidence) {
            edgeConfidences.set(edgeKey, confidence);
          }
        }
      }
    }

    // Build new graph with only non-trivial nodes
    const prunedNodes = graph.nodes.filter(node => !trivialNodeIds.has(node.id));

    // Edge case: If pruning results in empty graph, keep at least one node
    if (prunedNodes.length === 0) {
      console.debug('[Visualization] Pruning resulted in empty graph, keeping first node');
      return {
        nodes: [graph.nodes[0]],
        edges: []
      };
    }

    // Build new edges: transitive edges + original edges between non-trivial nodes
    const prunedEdges: GraphEdge[] = [];

    // Add transitive edges
    for (const [from, toSet] of transitiveEdges.entries()) {
      for (const to of toSet) {
        const edgeKey = `${from}->${to}`;
        const confidence = edgeConfidences.get(edgeKey) || 0.5;
        
        // Check if edge already exists (avoid duplicates)
        const existingEdge = prunedEdges.find(e => e.from === from && e.to === to);
        if (!existingEdge) {
          prunedEdges.push({
            from,
            to,
            kind: 'calls' as const,
            confidence
          });
        }
      }
    }

    // Add original edges between non-trivial nodes
    for (const edge of graph.edges) {
      if (!trivialNodeIds.has(edge.from) && !trivialNodeIds.has(edge.to)) {
        // Check if a transitive edge already exists (prefer original edge)
        const hasTransitiveEdge = prunedEdges.some(
          e => e.from === edge.from && e.to === edge.to
        );
        if (!hasTransitiveEdge) {
          prunedEdges.push(edge);
        }
      }
    }

    console.debug(
      `[Visualization] Pruned ${trivialNodeIds.size} trivial nodes: ${graph.nodes.length} -> ${prunedNodes.length} nodes, ${graph.edges.length} -> ${prunedEdges.length} edges`
    );

    return {
      nodes: prunedNodes,
      edges: prunedEdges
    };
  }

  /**
   * Filters graph to include only relevant nodes and edges based on hypotheses and root cause
   * Expands BFS from seed nodes (hypotheses.relatedNodes, suspects, error nodes, failPath)
   */
  private filterRelevantGraph(
    graph: ExecutionGraph,
    report?: RootCauseReport
  ): ExecutionGraph {
    // Guardrail 4: Short-circuit if no report
    if (!report) {
      return graph;
    }

    const seedNodeIds = new Set<string>();
    const nodeMap = new Map<string, GraphNode>(graph.nodes.map(n => [n.id, n]));

    // Collect seed nodes from hypotheses' relatedNodes
    if (report.hypotheses) {
      for (const hypothesis of report.hypotheses) {
        if (hypothesis.relatedNodes) {
          for (const nodeId of hypothesis.relatedNodes) {
            if (nodeMap.has(nodeId)) {
              seedNodeIds.add(nodeId);
            }
          }
        }
      }
    }

    // Collect suspect nodes from likelyRootCause (using existing extractSuspects logic)
    const suspects = this.extractSuspects(graph.nodes, report.likelyRootCause || '');
    for (const suspectId of suspects) {
      seedNodeIds.add(suspectId);
    }

    // Collect error nodes (nodes with 'error' badge)
    for (const node of graph.nodes) {
      if (node.badges?.includes('error')) {
        seedNodeIds.add(node.id);
      }
    }

    // Collect nodes from failPath
    if (report.failPath) {
      for (const failPathItem of report.failPath) {
        if (failPathItem.nodeId && nodeMap.has(failPathItem.nodeId)) {
          seedNodeIds.add(failPathItem.nodeId);
        }
      }
    }

    // If no seed nodes found, return original graph
    if (seedNodeIds.size === 0) {
      return graph;
    }

    // Build edge maps for BFS
    const outgoingEdges = new Map<string, GraphEdge[]>();
    const incomingEdges = new Map<string, GraphEdge[]>();
    
    for (const edge of graph.edges) {
      if (!outgoingEdges.has(edge.from)) {
        outgoingEdges.set(edge.from, []);
      }
      outgoingEdges.get(edge.from)!.push(edge);
      
      if (!incomingEdges.has(edge.to)) {
        incomingEdges.set(edge.to, []);
      }
      incomingEdges.get(edge.to)!.push(edge);
    }

    // BFS expansion from seed nodes
    const relevantNodeIds = new Set<string>(seedNodeIds);
    const visited = new Set<string>(seedNodeIds);
    const queue: Array<{ nodeId: string; hop: number; direction: 'upstream' | 'downstream' }> = [];

    // Initialize queue with seed nodes
    for (const seedId of seedNodeIds) {
      queue.push({ nodeId: seedId, hop: 0, direction: 'downstream' });
      queue.push({ nodeId: seedId, hop: 0, direction: 'upstream' });
    }

    // BFS expansion with hop limits
    let queueIndex = 0;
    while (queueIndex < queue.length && relevantNodeIds.size < RELEVANT_MAX_NODES) {
      const { nodeId, hop, direction } = queue[queueIndex++];

      if (direction === 'downstream' && hop < RELEVANT_DOWNSTREAM_HOPS) {
        // Expand downstream (following outgoing edges)
        const edges = outgoingEdges.get(nodeId) || [];
        for (const edge of edges) {
          if (!visited.has(edge.to) && relevantNodeIds.size < RELEVANT_MAX_NODES) {
            visited.add(edge.to);
            relevantNodeIds.add(edge.to);
            queue.push({ nodeId: edge.to, hop: hop + 1, direction: 'downstream' });
          }
        }
      } else if (direction === 'upstream' && hop < RELEVANT_UPSTREAM_HOPS) {
        // Expand upstream (following incoming edges)
        const edges = incomingEdges.get(nodeId) || [];
        for (const edge of edges) {
          if (!visited.has(edge.from) && relevantNodeIds.size < RELEVANT_MAX_NODES) {
            visited.add(edge.from);
            relevantNodeIds.add(edge.from);
            queue.push({ nodeId: edge.from, hop: hop + 1, direction: 'upstream' });
          }
        }
      }
    }

    // Filter nodes and edges
    const filteredNodes = graph.nodes.filter(n => relevantNodeIds.has(n.id));
    const filteredEdges = graph.edges.filter(
      e => relevantNodeIds.has(e.from) && relevantNodeIds.has(e.to)
    );

    return {
      nodes: filteredNodes,
      edges: filteredEdges
    };
  }

  /**
   * Normalizes graph for Mermaid generation with size guardrails
   */
  private normalizeGraphForMermaid(
    graph: ExecutionGraph,
    suspects: Set<string>
  ): { normalized: ExecutionGraph; normalizedSuspects: Set<string>; diagnostics: MermaidDiagnostic[] } {
    const diagnostics: MermaidDiagnostic[] = [];
    let nodes = [...graph.nodes];
    let edges = [...graph.edges];

    // Node cap
    if (nodes.length > MAX_NODES_FOR_MERMAID) {
      const originalCount = nodes.length;
      // Sort and prioritize
      nodes = nodes
        .sort((a, b) => {
          const aScore = this.getNodePriority(a, suspects);
          const bScore = this.getNodePriority(b, suspects);
          return bScore - aScore;
        })
        .slice(0, MAX_NODES_FOR_MERMAID);
      
      diagnostics.push({
        code: "NODE_LIMIT_REACHED",
        message: `Graph truncated to ${MAX_NODES_FOR_MERMAID} nodes`,
        detail: `${originalCount} -> ${MAX_NODES_FOR_MERMAID}`
      });
    }

    // Edge cap
    if (edges.length > MAX_EDGES_FOR_MERMAID) {
      const originalCount = edges.length;
      edges = edges
        .sort((a, b) => b.confidence - a.confidence)
        .slice(0, MAX_EDGES_FOR_MERMAID);
      
      diagnostics.push({
        code: "EDGE_LIMIT_REACHED",
        message: `Graph truncated to ${MAX_EDGES_FOR_MERMAID} edges`,
        detail: `${originalCount} -> ${MAX_EDGES_FOR_MERMAID}`
      });
    }

    // Guardrail: Ensure we have at least one node
    if (nodes.length === 0 && graph.nodes.length > 0) {
      // Fallback: use the first node from original graph
      nodes = [graph.nodes[0]];
      diagnostics.push({
        code: "EMPTY_GRAPH_PREVENTED",
        message: "Graph normalization resulted in empty graph, using fallback node"
      });
    }

    // Build idMap during normalization to track original -> normalized ID mapping
    const idMap = new Map<string, string>();

    // Truncate labels and normalize node IDs
    nodes = nodes.map(node => {
      const originalId = node.id;
      const label = this.sanitizeLabel(node.label || node.id);
      const truncatedLabel = label.length > MAX_LABEL_LENGTH 
        ? label.slice(0, MAX_LABEL_LENGTH - 1) + '…'
        : label;
      
      // Ensure node ID doesn't start with number
      let normalizedId = node.id;
      if (/^\d/.test(normalizedId)) {
        normalizedId = '_' + normalizedId;
      }
      
      // Ensure only allowed chars in ID
      normalizedId = normalizedId.replace(/[^a-zA-Z0-9_]/g, '_');
      
      // Track ID mapping if it changed
      if (originalId !== normalizedId) {
        idMap.set(originalId, normalizedId);
      }
      
      return {
        ...node,
        id: normalizedId,
        label: truncatedLabel
      };
    });

    // Remap suspect IDs to normalized IDs using idMap
    const normalizedSuspects = new Set<string>();
    for (const suspectId of suspects) {
      const normalizedId = idMap.get(suspectId) || suspectId;
      // Only include if the normalized ID exists in the normalized nodes
      if (nodes.some(n => n.id === normalizedId)) {
        normalizedSuspects.add(normalizedId);
      }
    }

    const limitedSuspects = this.limitSuspectHighlights(nodes, normalizedSuspects, MAX_HIGHLIGHTED_SUSPECTS);
    if (limitedSuspects.size < normalizedSuspects.size) {
      diagnostics.push({
        code: "SUSPECT_HIGHLIGHT_LIMIT",
        message: `Suspect highlights limited to ${MAX_HIGHLIGHTED_SUSPECTS}`,
        detail: `${normalizedSuspects.size} -> ${limitedSuspects.size}`
      });
    }

    // Filter edges to only include those between selected nodes
    const nodeIds = new Set(nodes.map(n => n.id));
    edges = edges
      .filter(e => {
        const from = idMap.get(e.from) || e.from;
        const to = idMap.get(e.to) || e.to;
        return nodeIds.has(from) && nodeIds.has(to);
      })
      .map(edge => ({
        ...edge,
        from: idMap.get(edge.from) || edge.from,
        to: idMap.get(edge.to) || edge.to
      }));

    // Guardrail: If all edges were filtered out but we have nodes, create at least one edge
    if (edges.length === 0 && nodes.length > 1) {
      // Create a simple edge between first two nodes
      edges = [{
        from: nodes[0].id,
        to: nodes[1].id,
        kind: 'calls' as const,
        confidence: 0.5
      }];
      diagnostics.push({
        code: "EMPTY_EDGES_PREVENTED",
        message: "All edges filtered out, created fallback edge to prevent empty graph"
      });
    } else if (edges.length === 0 && nodes.length === 1) {
      // If only one node, create a self-loop to ensure graph is valid
      edges = [{
        from: nodes[0].id,
        to: nodes[0].id,
        kind: 'calls' as const,
        confidence: 0.5
      }];
      diagnostics.push({
        code: "SINGLE_NODE_EDGE_CREATED",
        message: "Created self-loop edge for single-node graph"
      });
    }

    return {
      normalized: { nodes, edges },
      normalizedSuspects: limitedSuspects,
      diagnostics
    };
  }

  private limitSuspectHighlights(
    nodes: GraphNode[],
    suspects: Set<string>,
    maxHighlighted: number
  ): Set<string> {
    if (suspects.size <= maxHighlighted) {
      return new Set(suspects);
    }

    const suspectNodes = nodes
      .filter(node => suspects.has(node.id))
      .sort((a, b) => {
        const aScore = this.getNodePriority(a, suspects);
        const bScore = this.getNodePriority(b, suspects);
        if (aScore === bScore) {
          return (a.label || a.id).localeCompare(b.label || b.id);
        }
        return bScore - aScore;
      })
      .slice(0, maxHighlighted);

    return new Set(suspectNodes.map(node => node.id));
  }

  /**
   * Main orchestrator method for generating visualizations
   */
  async generateVisualization(
    graph: ExecutionGraph,
    report: RootCauseReport | undefined,
    mode: 'hard-error'|'soft-error'|'behavior-first',
    model: string, // Kept for API compatibility, unused
    workspaceRoot?: string // Optional workspace root for saving checkpoints
  ): Promise<VisualizationResult> {
    const startTime = Date.now();
    const collectedDiagnostics: MermaidDiagnostic[] = [];
    
    try {
      // Filter graph to relevant nodes based on hypotheses and root cause
      const relevantGraph = report
        ? this.filterRelevantGraph(graph, report)
        : graph;

      // Guardrail 1: Fallback if filtered graph is empty or no root cause found
      // Use curated subgraph extraction when:
      // - Filtered graph is empty (no seed nodes found)
      // - Report is undefined or has no hypotheses
      // - Original graph is too large and filtered graph is empty
      let finalGraph = relevantGraph;
      if (relevantGraph.nodes.length === 0 || 
          !report || 
          !report.hypotheses || 
          report.hypotheses.length === 0 ||
          (graph.nodes.length > MAX_NODES_FOR_MERMAID && relevantGraph.nodes.length === 0)) {
        
        console.debug('[Visualization] Using curated subgraph extraction (filtered graph empty or no root cause)');
        
        // Extract focus information from graph and report
        const focus: GraphCompressorInput["focus"] = {
          entrySymbols: [],
          errorFrames: [],
          userMentions: []
        };

        // Extract error frames from error nodes
        const errorNodes = graph.nodes.filter(n => n.badges?.includes('error'));
        if (errorNodes.length > 0) {
          focus.errorFrames = errorNodes
            .filter(n => n.file && n.line)
            .map(n => ({ file: n.file!, line: n.line! }));
        }

        // Extract entry symbols from entry nodes
        const entryNodes = graph.nodes.filter(n => {
          const badges = n.badges || [];
          return (badges as string[]).includes('entry') || 
                 (badges as string[]).includes('seed') || 
                 (badges as string[]).includes('spine');
        });
        if (entryNodes.length > 0) {
          focus.entrySymbols = entryNodes.map(n => ({
            id: n.id,
            name: n.label,
            file: n.file
          }));
        }

        // Extract from failPath if available
        if (report?.failPath && report.failPath.length > 0) {
          for (const failPathItem of report.failPath) {
            if (failPathItem.file && failPathItem.line) {
              focus.errorFrames = focus.errorFrames || [];
              focus.errorFrames.push({ file: failPathItem.file, line: failPathItem.line });
            }
          }
        }

        // Use curated subgraph extraction
        const curatedGraph = this.graphCompressor.extractCuratedSubGraph(
          graph.nodes,
          graph.edges,
          focus,
          20, // minNodes
          20  // maxNodes
        );

        if (curatedGraph.nodes.length > 0) {
          finalGraph = curatedGraph;
          console.debug(`[Visualization] Extracted curated subgraph: ${curatedGraph.nodes.length} nodes, ${curatedGraph.edges.length} edges`);
        } else {
          // Final fallback: use original graph
          finalGraph = graph;
          console.debug('[Visualization] Curated extraction returned empty, using original graph');
        }
      }

      // Guardrail 5: Log filtering results
      if (report) {
        console.debug(
          `[Visualization] filtered graph: ${graph.nodes.length} -> ${finalGraph.nodes.length} nodes, ${graph.edges.length} -> ${finalGraph.edges.length} edges`
        );
      } else {
        console.debug('[Visualization] no report provided, skipping relevance filter');
      }

      // Prune trivial nodes from the graph (before normalization)
      finalGraph = this._pruneTrivialNodes(finalGraph, workspaceRoot);

      // Extract suspect nodes from root cause analysis
      let suspects = this.extractSuspects(finalGraph.nodes, report?.likelyRootCause || '');
      
      // Add hypothesis-related nodes to suspects for highlighting
      if (report?.hypotheses) {
        for (const hypothesis of report.hypotheses) {
          if (hypothesis.relatedNodes) {
            for (const nodeId of hypothesis.relatedNodes) {
              // Verify node exists in the final graph before adding
              if (finalGraph.nodes.some(n => n.id === nodeId)) {
                suspects.add(nodeId);
              }
            }
          }
        }
      }
      
      // Normalize graph with guardrails (operates on pruned graph)
      const { normalized, normalizedSuspects, diagnostics: normalizationDiagnostics } = this.normalizeGraphForMermaid(finalGraph, suspects);
      collectedDiagnostics.push(...normalizationDiagnostics);
      
      // Build node location map from normalized graph nodes
      // IMPORTANT: Use normalized.node.id which matches the IDs used in Mermaid diagram
      const nodeLocationMap: NodeLocationMap = {};
      const nodeInfoMap: NodeVisualizationInfoMap = {};
      for (const node of normalized.nodes) {
        if (node.file) {
          // Use normalized node ID (which matches what's in Mermaid diagram)
          nodeLocationMap[node.id] = {
            filePath: node.file,
            line: node.line // Already 1-based from GraphNode
          };
        }

        const analysis =
          typeof node.analysis === 'string' ? node.analysis.trim() : undefined;
        const hasAnalysis = !!analysis;
        const hasImportance =
          typeof node.importance === 'number' && !Number.isNaN(node.importance);

        if (hasAnalysis || hasImportance) {
          const normalizedImportance = hasImportance
            ? Math.min(1, Math.max(0, node.importance as number))
            : undefined;
          const sanitizedLabel = node.label ? this.sanitizeLabel(node.label) : undefined;

          nodeInfoMap[node.id] = {
            ...(sanitizedLabel ? { label: sanitizedLabel } : {}),
            ...(hasAnalysis ? { analysis } : {}),
            ...(normalizedImportance !== undefined
              ? { importance: normalizedImportance }
              : {})
          };
        }
      }
      
      // Debug logging: verify nodeLocationMap has normalized IDs
      if (nodeLocationMap && Object.keys(nodeLocationMap).length > 0) {
        const sampleIds = Object.keys(nodeLocationMap).slice(0, 3);
        console.debug(`[Visualization] nodeLocationMap created with ${Object.keys(nodeLocationMap).length} entries. Sample IDs: ${sampleIds.join(', ')}`);
      }
      
      // Checkpoint 8a: Pre-Mermaid Graph (normalized graph right before mermaid conversion)
      if (workspaceRoot) {
        const graphSummary = {
          timestamp: new Date().toISOString(),
          summary: {
            nodeCount: normalized.nodes.length,
            edgeCount: normalized.edges.length,
            nodeTypes: normalized.nodes.reduce((acc, node) => {
              acc[node.kind] = (acc[node.kind] || 0) + 1;
              return acc;
            }, {} as Record<string, number>),
            edgeTypes: normalized.edges.reduce((acc, edge) => {
              acc[edge.kind] = (acc[edge.kind] || 0) + 1;
              return acc;
            }, {} as Record<string, number>),
            errorNodes: normalized.nodes.filter(node => node.badges?.includes('error')).length,
            suspectNodes: normalized.nodes.filter(node => normalizedSuspects.has(node.id)).length
          },
          sampleNodes: normalized.nodes.slice(0, 10).map(node => ({
            id: node.id,
            label: node.label,
            kind: node.kind,
            file: node.file,
            line: node.line,
            badges: node.badges
          })),
          sampleEdges: normalized.edges.slice(0, 10).map(edge => ({
            from: edge.from,
            to: edge.to,
            kind: edge.kind,
            confidence: edge.confidence
          })),
          fullGraph: normalized
        };
        const checkpointPath = this.saveCheckpointJSON(
          graphSummary,
          workspaceRoot,
          'checkpoints',
          '08a-pre-mermaid-graph.json'
        );
        if (checkpointPath) {
          console.log('[Visualization] Checkpoint 8a - Pre-Mermaid Graph saved:', checkpointPath);
        }
      }
      
      // Multi-pass deterministic repair
      const attempts: { mermaid: string; pass: string }[] = [];
      
      // Pass 1: Generate base mermaid
      const pass1Mermaid = this.toMermaidDeterministic(normalized, normalizedSuspects, mode);
      attempts.push({ mermaid: pass1Mermaid, pass: "base" });
      
      // Pass 2: Sanitize
      const sanitizationResult = sanitizeMermaid(pass1Mermaid);
      if (sanitizationResult.fixes.length > 0) {
        collectedDiagnostics.push({
          code: "SANITIZATION_APPLIED",
          message: `Applied sanitization fixes: ${sanitizationResult.fixes.join(', ')}`
        });
      }
      attempts.push({ mermaid: sanitizationResult.mermaid, pass: "sanitize" });
      
      // Pass 3: Fix structural issues
      const pass3Mermaid = this.fixStructuralIssues(sanitizationResult.mermaid, normalized);
      attempts.push({ mermaid: pass3Mermaid, pass: "structural" });
      
      // Pass 4: Final layout normalization
      const pass4Mermaid = this.finalLayoutPass(pass3Mermaid);
      attempts.push({ mermaid: pass4Mermaid, pass: "layout" });
      
      // Validate each pass and return first valid result
      for (const attempt of attempts) {
        const validation = await validateMermaid(attempt.mermaid);
        
        if (validation.isValid) {
          const duration = Date.now() - startTime;
          console.debug('[Visualization] pass=%s valid=%s nodes=%d edges=%d time=%dms', 
            attempt.pass, true, normalized.nodes.length, normalized.edges.length, duration);
          
          const meta: VisualizationMeta = {
            nodeCount: normalized.nodes.length,
            edgeCount: normalized.edges.length,
            truncated: finalGraph.nodes.length > normalized.nodes.length || finalGraph.edges.length > normalized.edges.length,
            mode,
            source: 'deterministic'
          };
          
          // Convert validation warnings to diagnostics
          const validationDiagnostics: MermaidDiagnostic[] = (validation.warnings || []).map(w => ({
            code: "VALIDATION_WARNING",
            message: w
          }));
          
      return {
            mermaid: attempt.mermaid,
            meta,
            isValid: true,
            diagnostics: [...collectedDiagnostics, ...validationDiagnostics],
            sourceGraphVersion: DETERMINISTIC_MERMAID_VERSION,
            nodeLocationMap,
            nodeInfoMap,
            normalizedNodes: normalized.nodes // Include normalized nodes with IDs matching Mermaid diagram
          };
        }
        
        // Collect validation errors as diagnostics
        if (validation.errors && validation.errors.length > 0) {
          collectedDiagnostics.push(...validation.errors.map(e => {
            // Detect infrastructure failures vs syntax errors
            const isInfrastructureError = e.includes('Mermaid CLI infrastructure failure') ||
                                        e.includes('node:internal/modules/esm/resolve') ||
                                        e.includes('Cannot find module') ||
                                        e.includes('MODULE_NOT_FOUND') ||
                                        e.includes('command not found') ||
                                        e.includes('ENOENT');
            
            return {
              code: isInfrastructureError ? "VALIDATION_INFRASTRUCTURE_FAILURE" : "INVALID_SYNTAX",
              message: e
            };
          }));
        }
        
        // Collect validation warnings as diagnostics
        if (validation.warnings && validation.warnings.length > 0) {
          collectedDiagnostics.push(...validation.warnings.map(w => ({
            code: "VALIDATION_WARNING",
            message: w
          })));
        }
      }
      
      // None passed - return valid error graph with collected diagnostics
      const lastAttempt = attempts[attempts.length - 1];
      const finalValidation = await validateMermaid(lastAttempt.mermaid);
      
      const duration = Date.now() - startTime;
      console.debug('[Visualization] pass=%s valid=%s nodes=%d edges=%d time=%dms', 
        lastAttempt.pass, false, normalized.nodes.length, normalized.edges.length, duration);
      
      const meta: VisualizationMeta = {
        nodeCount: normalized.nodes.length,
        edgeCount: normalized.edges.length,
        truncated: finalGraph.nodes.length > normalized.nodes.length || finalGraph.edges.length > normalized.edges.length,
        mode,
        source: 'deterministic'
      };
      
      // Find the best attempt with meaningful content for originalInvalidMermaid
      let originalInvalidMermaid = lastAttempt.mermaid;
      
      // Ensure originalInvalidMermaid has meaningful content (not just "flowchart TD")
      const isMeaningful = (mermaid: string): boolean => {
        const trimmed = mermaid.trim();
        if (!trimmed || trimmed === 'flowchart TD' || trimmed === 'graph TD') {
          return false;
        }
        // Check if it has node definitions or other content
        const lines = trimmed.split('\n').filter(l => l.trim() && !l.trim().startsWith('%'));
        return lines.length > 1;
      };
      
      if (!isMeaningful(originalInvalidMermaid)) {
        // Find the first attempt with meaningful content
        for (const attempt of attempts.reverse()) {
          if (isMeaningful(attempt.mermaid)) {
            originalInvalidMermaid = attempt.mermaid;
            break;
          }
        }
        
        // If still no meaningful content, generate a minimal valid graph from normalized nodes
        if (!isMeaningful(originalInvalidMermaid) && normalized.nodes.length > 0) {
          const minimalMermaid = this.toMermaidDeterministic(normalized, normalizedSuspects, mode);
          if (isMeaningful(minimalMermaid)) {
            originalInvalidMermaid = minimalMermaid;
          } else {
            // Last resort: generate a basic graph with at least one node
            const nodeId = normalized.nodes[0].id;
            const nodeLabel = normalized.nodes[0].label || 'Node';
            originalInvalidMermaid = `flowchart TD
    ${nodeId}["${nodeLabel}"]
    style ${nodeId} fill:#f9f,stroke:#333,stroke-width:2px`;
          }
        }
      }
      
      // Generate a valid error Mermaid graph instead of returning invalid lastAttempt.mermaid
      const errorMermaid = this.generateErrorMermaidGraph(
        normalized.nodes.length,
        normalized.edges.length,
        collectedDiagnostics
      );
      
      return {
        mermaid: errorMermaid,
        meta,
        isValid: false,
        diagnostics: collectedDiagnostics,
        sourceGraphVersion: DETERMINISTIC_MERMAID_VERSION,
        nodeLocationMap,
        nodeInfoMap,
        normalizedNodes: normalized.nodes, // Include normalized nodes with IDs matching Mermaid diagram
        originalInvalidMermaid // Store original invalid graph for debugging (always has meaningful content)
      };
      
    } catch (error) {
      console.error('[VisualizationService] Error generating visualization:', error);
      throw new Error(`Visualization generation failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /**
   * Generates a valid error Mermaid graph when layout validation fails
   */
  private generateErrorMermaidGraph(
    nodeCount: number,
    edgeCount: number,
    diagnostics: MermaidDiagnostic[]
  ): string {
    const errorMessages = diagnostics.length > 0
      ? diagnostics.map(d => d.message).join('; ')
      : 'The graph layout could not be computed';
    
    // Sanitize the error label for Mermaid compatibility
    const errorLabel = this.sanitizeLabel(
      `Visualization Failed: The graph layout could not be computed (${nodeCount} nodes, ${edgeCount} edges). ${errorMessages}`
    );
    
    return `flowchart TD
    ERROR_NODE[("${errorLabel}")]
    style ERROR_NODE fill:#f00,color:#fff,stroke:#b30000,stroke-width:3px`;
  }

  /**
   * Fixes structural issues in mermaid diagram
   */
  private fixStructuralIssues(mermaid: string, graph: ExecutionGraph): string {
    const lines = mermaid.split('\n');
    const result: string[] = [];
    const nodeIds = new Set(graph.nodes.map(n => n.id));
    const seenNodes = new Set<string>();
    
    for (const line of lines) {
      // Drop edges to missing nodes
      const edgeMatch = line.match(/^(\s*)(\w+)\s*([-.]*)\|?([^|]*)\|?\s*(\w+)/);
      if (edgeMatch) {
        const [, indent, from, arrows, label, to] = edgeMatch;
        if (nodeIds.has(from) && nodeIds.has(to)) {
          result.push(line);
        }
        // Skip edges with missing nodes
        continue;
      }
      
      // Ensure no duplicate node IDs
      const nodeMatch = line.match(/^(\s*)(\w+)\[/);
      if (nodeMatch) {
        const [, indent, nodeId] = nodeMatch;
        if (!seenNodes.has(nodeId)) {
          seenNodes.add(nodeId);
          result.push(line);
        }
        // Skip duplicate nodes
        continue;
      }
      
      // Keep other lines (flowchart TD, style, etc.)
      result.push(line);
    }
    
    return result.join('\n');
  }

  /**
   * Final layout pass - ensures proper graph type and normalization
   */
  private finalLayoutPass(mermaid: string): string {
    let result = mermaid.trim();
    const lines = result.split('\n');
    
    // Ensure first line is flowchart TD or graph TD
    if (!lines[0].trim().startsWith('flowchart') && !lines[0].trim().startsWith('graph')) {
      result = 'flowchart TD\n' + result;
    } else if (lines[0].trim().startsWith('graph') && !lines[0].includes('TD') && !lines[0].includes('LR')) {
      // Replace graph with flowchart TD if direction not specified
      lines[0] = 'flowchart TD';
      result = lines.join('\n');
    }
    
    // Remove duplicate empty lines
    result = result.replace(/\n{3,}/g, '\n\n');
    
    return result;
  }

  /**
   * Generates deterministic Mermaid from graph data (no LLM)
   */
  private toMermaidDeterministic(
    graph: ExecutionGraph,
    suspects: Set<string>,
    mode: 'hard-error'|'soft-error'|'behavior-first'
  ): string {
    // Validation: ensure at least some nodes are included
    if (!graph.nodes || graph.nodes.length === 0) {
      console.debug('[Visualization] Empty graph detected, returning minimal Mermaid stub');
      // Return a minimal valid Mermaid diagram instead of throwing
      return 'flowchart TD\n    %% No nodes to display';
    }

    const lines: string[] = ['flowchart TD'];
    
    // Add role-based class definitions and neutral link styling
    lines.push(...MERMAID_ROLE_CLASS_DEF_LINES);
    lines.push(MERMAID_DEFAULT_LINK_STYLE);
    lines.push('');
    
    // Use all nodes (already normalized with guardrails)
    const sortedNodes = [...graph.nodes]
      .sort((a, b) => {
        // Priority: error badges > high confidence > suspects > others
        const aScore = this.getNodePriority(a, suspects);
        const bScore = this.getNodePriority(b, suspects);
        return bScore - aScore;
      });
    
    // Generate node definitions with role classes
    for (const node of sortedNodes) {
      const label = this.sanitizeLabel(node.label || node.id);
      
      // Build NodeContext for role classification
      const nodeContext: NodeContext = {
        id: node.id,
        filePath: node.file,
        fileName: node.file ? node.file.split('/').pop() : undefined,
        symbolName: node.kind === 'symbol' ? node.label : undefined
      };
      
      const role = classifyNodeRole(nodeContext);
      const roleClass = role !== "unknown" ? `:::${role}` : "";
      
      lines.push(`${node.id}["${label}"]${roleClass}`);
    }
    
    // Generate edge definitions
    const nodeIds = new Set(sortedNodes.map(n => n.id));
    for (const edge of graph.edges) {
      // Only include edges between nodes that are in our selected set
      if (nodeIds.has(edge.from) && nodeIds.has(edge.to)) {
        const edgeStyle = this.getEdgeStyle(edge);
        const edgeLabel = this.sanitizeEdgeLabel(edge.label ?? edge.kind);
        lines.push(`${edge.from} ${edgeStyle}|${edgeLabel}| ${edge.to}`);
      }
    }
    
    // Generate node styles (combine role-based with suspect/error styling)
    for (const node of sortedNodes) {
      const styles = this.getNodeStyles(node, suspects, mode);
      if (styles.length > 0) {
        lines.push(`style ${node.id} ${styles.join(',')}`);
      }
    }
    
    return lines.join('\n');
  }

  /**
   * Extracts suspect node IDs by fuzzy matching against root cause text
   */
  private extractSuspects(nodes: GraphNode[], rootCause: string): Set<string> {
    const suspects = new Set<string>();
    
    if (!rootCause || typeof rootCause !== 'string') {
      return suspects;
    }
    
    const rootCauseLower = rootCause.toLowerCase();
    
    for (const node of nodes) {
      // Match against file path
      if (node.file) {
        const fileName = node.file.split('/').pop()?.toLowerCase() || '';
        if (rootCauseLower.includes(fileName) || fileName.includes(rootCauseLower.split('.')[0])) {
          suspects.add(node.id);
          continue;
        }
      }
      
      // Match against label
      if (node.label) {
        const labelLower = node.label.toLowerCase();
        if (rootCauseLower.includes(labelLower) || labelLower.includes(rootCauseLower)) {
          suspects.add(node.id);
          continue;
        }
      }
      
      // Match against function names in root cause
      const functionMatches = rootCauseLower.match(/\b\w+\(/g);
      if (functionMatches) {
        for (const match of functionMatches) {
          const funcName = match.slice(0, -1); // Remove the '('
          if (node.label?.toLowerCase().includes(funcName)) {
            suspects.add(node.id);
            break;
          }
        }
      }
    }
    
    return suspects;
  }

  /**
   * Sanitizes node labels for Mermaid compatibility
   */
  private sanitizeLabel(label: string): string {
    return label
      .replace(/[`|{}]/g, '') // Remove problematic characters
      .replace(/\n/g, ' ') // Replace newlines with spaces
      .slice(0, MAX_LABEL_LENGTH) // Truncate to max label length
      .trim();
  }

  private sanitizeEdgeLabel(label?: string): string {
    if (!label) {
      return 'calls';
    }
    const sanitized = this.sanitizeLabel(label);
    if (!this.isSafeMermaidEdgeLabel(sanitized)) {
      return 'calls';
    }
    return sanitized;
  }

  private isSafeMermaidEdgeLabel(label: string): boolean {
    if (!label) {
      return false;
    }

    if (label.includes('=>') || label.includes('->')) {
      return false;
    }

    if (/[(){}[\]]/.test(label)) {
      return false;
    }

    return /^[A-Za-z0-9][A-Za-z0-9 _.\-:/]*$/.test(label);
  }

  /**
   * Gets node priority for sorting (higher = more important)
   */
  private getNodePriority(node: GraphNode, suspects: Set<string>): number {
    let score = 0;
    
    // Error badges get highest priority
    if (node.badges?.includes('error')) score += 100;
    if (node.badges?.includes('suspicious')) score += 50;
    
    // Suspects get high priority
    if (suspects.has(node.id)) score += 75;
    
    // File nodes get medium priority
    if (node.kind === 'file') score += 25;
    
    // Symbol nodes get lower priority
    if (node.kind === 'symbol') score += 10;
    
    return score;
  }

  /**
   * Gets edge style based on kind
   */
  private getEdgeStyle(edge: GraphEdge): string {
    switch (edge.kind) {
      case 'calls':
        return '-->';
      case 'imports':
      case 'exports':
      case 'reexports':
        return '-.->';
      default:
        return '-->';
    }
  }

  /**
   * Gets node styles based on badges, suspects, and mode
   */
  private getNodeStyles(
    node: GraphNode,
    suspects: Set<string>,
    mode: 'hard-error'|'soft-error'|'behavior-first'
  ): string[] {
    const styles: string[] = [];
    
    // Suspect nodes get red highlighting
    if (suspects.has(node.id)) {
      styles.push('fill:#ff6b6b', 'stroke:#b30000', 'stroke-width:2px');
    }
    
    // Error badges get dashed border
    if (node.badges?.includes('error')) {
      styles.push('stroke:#ff6b6b', 'stroke-dasharray:4 2');
    }
    
    // Mode-specific highlighting
    if (mode === 'hard-error' && node.badges?.includes('error')) {
      styles.push('fill:#ff8c42'); // Orange for error frames
    } else if (mode === 'soft-error' && node.kind === 'file' && node.file?.includes('route')) {
      styles.push('fill:#4a9eff'); // Blue for route handlers
    } else if (mode === 'behavior-first' && node.badges?.includes('routeHandler')) {
      styles.push('fill:#4a9eff'); // Blue for entrypoints
    }
    
    return styles;
  }

}
