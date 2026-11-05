/**
 * Graph Compressor for debugging code extraction
 * 
 * Compresses raw method-level graphs using rule-based pruning and optional LLM condensation
 * to produce focused, human-debuggable execution graphs
 */

import * as path from 'path';
import * as fs from 'fs';
import { parse } from '@babel/parser';
import traverse from '@babel/traverse';
import * as t from '@babel/types';
import * as ts from 'typescript';
import {
  Project,
  SourceFile,
  Node,
  CallExpression,
  NewExpression,
  SyntaxKind,
  Type as TsMorphType,
  Symbol as TsMorphSymbol,
  TypeChecker
} from 'ts-morph';
import { LLMProviderService } from '../../llm/llmProviderService';
import {
  MethodExecutionGraph,
  SymbolDef,
  SymbolCall,
  GraphCompressorInput,
  GraphCompressorOutput,
  Evidence,
  ImportExportRelation,
  LocalContext,
  LocalCallIndex,
  GraphNode,
  GraphEdge
} from './types';

interface CompressedNode {
  id: string;
  label: string;
  file?: string;
  kind: "symbol" | "file" | "group" | "route";
  line?: number;
  loc?: number;
  badges?: string[];
  originalIds?: string[]; // For grouped nodes
}

interface CompressedEdge {
  from: string;
  to: string;
  kind: "calls" | "imports" | "logical" | "grouped";
  confidence: number;
  evidence?: string[];
  line?: number;  // Line number where call occurs (for execution order)
  order?: number;  // Execution order within method (1, 2, 3, ...)
  originalKind?: GraphEdge["kind"];  // Preserve original edge kind for round-tripping
  label?: string;
}

interface CompressedGraph {
  nodes: CompressedNode[];
  edges: CompressedEdge[];
}

type GraphNodeBadge = NonNullable<GraphNode["badges"]>[number];
const VALID_GRAPH_NODE_BADGES: GraphNodeBadge[] = ['error', 'suspicious', 'lowConfidence', 'routeHandler', 'spine'];

interface BFSQueueItem {
  id: string;
  depth: number;
}

interface LLMCondensationResponse {
  nodes: Array<{
    keep?: string;
    group?: string[];
    as?: string;
  }>;
  edges?: Array<[string, string]>;
}

interface LLMResolutionResponse {
  resolved: Array<{
    from: string;
    to: string;
    targetSymbolId?: string;
    confidence: number;
    reasoning?: string;
  }>;
}

export class GraphCompressor {
  private readonly llmProvider: LLMProviderService;
  private readonly defaultLimits = {
    maxNodes: 150,
    maxDepth: 5,
    minConfidence: 0.45,
    targetNodeCount: 25
  };

  private static readonly BUILTIN_METHOD_NAMES = new Set<string>([
    'trim',
    'trimStart',
    'trimEnd',
    'replace',
    'replaceAll',
    'substring',
    'substr',
    'slice',
    'split',
    'join',
    'includes',
    'indexOf',
    'lastIndexOf',
    'toLowerCase',
    'toUpperCase',
    'padStart',
    'padEnd',
    'charAt',
    'charCodeAt',
    'startsWith',
    'endsWith',
    'repeat',
    'localeCompare',
    'match',
    'matchAll',
    'search',
    'map',
    'filter',
    'reduce',
    'reduceRight',
    'forEach',
    'find',
    'findIndex',
    'findLast',
    'findLastIndex',
    'some',
    'every',
    'push',
    'pop',
    'shift',
    'unshift',
    'splice',
    'concat',
    'flat',
    'flatMap',
    'sort',
    'reverse',
    'entries',
    'keys',
    'values',
    'fill',
    'copyWithin',
    'at',
    'toString',
    'valueOf',
    'test',
    'exec',
    'then',
    'catch',
    'finally',
    'resolve',
    'reject',
    'all',
    'any',
    'allSettled',
    'race',
    'from',
    'of',
    'isArray',
    'assign',
    'hasOwnProperty',
    'toUTCString',
    'toISOString',
    'now',
    'random',
    'floor',
    'ceil',
    'round',
    'abs',
    'max',
    'min'
  ]);

  private static readonly BUILTIN_BASE_IDENTIFIERS = new Set<string>([
    'Array',
    'ReadonlyArray',
    'String',
    'Number',
    'Boolean',
    'Object',
    'Math',
    'JSON',
    'Promise',
    'Symbol',
    'BigInt',
    'Date',
    'RegExp',
    'Set',
    'Map',
    'WeakSet',
    'WeakMap',
    'Reflect',
    'Proxy',
    'Intl',
    'URL',
    'Error',
    'TypeError',
    'RangeError',
    'AggregateError',
    'ArrayConstructor',
    'PromiseConstructor',
    'StringConstructor',
    'NumberConstructor',
    'BooleanConstructor'
  ]);

  private static readonly SMART_PARAM_MAX_NAME_LENGTH = 20;
  private static readonly SMART_PARAM_MAX_PARAMS_TO_SHOW = 3;
  
  // ts-morph project management
  private tsMorphProject?: Project;
  private processedFiles: Set<string> = new Set();
  private workspaceRoot: string = '';
  
  // Config path caching
  private configPathCache: Map<string, { configPath?: string; reason: string }> = new Map();

  constructor(llmProvider: LLMProviderService) {
    this.llmProvider = llmProvider;
  }

  /**
   * Main compression method
   */
  public async compress(input: GraphCompressorInput): Promise<GraphCompressorOutput> {
    const limits = { ...this.defaultLimits, ...(input.limits || {}) };
    const methodGraph = input.methodGraph;

    // Hard LLM budget guard (global, shared across both paths)
    let llmCalls = 0;
    const maxCalls = input.llm?.maxCalls ?? 3;  // default 3
    const canCallLLM = () => input.llm?.enabled === true && llmCalls < maxCalls;
    const useLLM = input.llm?.enabled === true;
    const markLLM = () => { llmCalls++; };
    let usedCondensation = false;

    // Detect if we should use local trace approach
    const unresolvedEdges = methodGraph.symbolEdges.filter((e: SymbolCall) => e.via === "unresolved");
    const totalEdges = methodGraph.symbolEdges.length;
    const unresolvedRatio = totalEdges > 0 ? unresolvedEdges.length / totalEdges : 1;

    // Trigger on high unresolved OR tiny usable graph (< 10 resolved edges)
    const isTinyUsableGraph = totalEdges > 0 && totalEdges * (1 - unresolvedRatio) < 10;
    const isHighUnresolved = unresolvedRatio > 0.5 || isTinyUsableGraph;

    const shouldUseLocalTrace = useLLM && isHighUnresolved && canCallLLM();

    // Step 1: Build seed set
    const seedIds = this.buildSeedSet(input.focus, undefined as Evidence | undefined, methodGraph);

    // Step 2: Rule-based pruning (exclude simpleGraphSize from limits as it's not used by pruneWithRules)
    const { simpleGraphSize, ...pruneLimits } = limits;
    let prunedGraph = this.pruneWithRules(methodGraph, seedIds, pruneLimits as Required<GraphCompressorInput["limits"]>, input.focus);

    let selected: SymbolCall[] = [];
    const ratio = unresolvedRatio; // Use ratio calculated above

    if (shouldUseLocalTrace) {
      // NEW PATH: Local trace approach
      
      // Step 1: Build coarse path from focus
      const coarsePath = this.buildCoarsePath(input.focus, methodGraph);
      
      // Step 2: Collect local context (read source files)
      const localContext = this.collectLocalContext(coarsePath, input.focus, methodGraph);
      
      // Step 3: LLM identify spine (1 call)
      if (canCallLLM()) {
        try {
          const spineResult = await this.llmIdentifySpine(
            localContext,
            input.focus,
            input.llm as NonNullable<GraphCompressorInput["llm"]> & { enabled: true }
          );
          markLLM();
          
          // Fallback if LLM returns empty/MAX_TOKENS or spine too short
          // Allow algorithmic path even with 1 spine item (better than fallback)
          if (!spineResult?.spine?.length || spineResult.spine.length === 0) {
            prunedGraph = this.buildMinimalSpineGraphFromCoarsePath(coarsePath, input.focus);
            // Build output inline (same format as below)
            const unresolvedEdges: SymbolCall[] = prunedGraph.edges
              .filter((e: CompressedEdge) => e.evidence?.includes("unresolved"))
              .map((e: CompressedEdge) => {
                const matchingEdge = methodGraph.symbolEdges.find((s: SymbolCall) => s.callerId === e.from && s.calleeId === e.to);
                return {
                  callerId: e.from,
                  calleeId: e.to,
                  file: matchingEdge?.file || "",
                  confidence: e.confidence,
                  via: "unresolved" as const
                };
              });
            return {
              nodes: prunedGraph.nodes,
              edges: prunedGraph.edges,
              meta: {
                prunedCount: methodGraph.symbols.length - prunedGraph.nodes.length,
                unresolvedEdges: unresolvedEdges,
                source: "coarse-path+llm-local-trace" as const,
                llm: {
                  usedCalls: llmCalls,
                  maxCalls: maxCalls,
                  condensation: false,
                  selectedUnresolved: 0,
                  unresolvedRatio: ratio
                }
              }
            };
          }

          // Step 2: ts-morph: Build deep call index with cross-file traversal (no LLM)
          // Reduced limits to prevent stack overflow
          const deepTraversalHops = Math.min(6, limits?.maxDepth ?? 6); // Reduced from 10 to 6
          const deepTraversalNodes = Math.min(600, (limits?.maxNodes ?? 150) * 3); // Reduced from 7x to 3x
          const callIndex = await this.buildDeepCallIndexWithTsMorph(
            spineResult.spine,
            localContext,
            methodGraph,
            { maxHops: deepTraversalHops, maxNodes: deepTraversalNodes }
          );

          // Step 3: LLM: Rank calls for expansion (1 call)
          let rankedCalls: Record<string, Array<{ name: string; file?: string; priority: 1 | 2 | 3 }>> = {};
          if (canCallLLM()) {
            rankedCalls = await this.llmRankCallsForExpansion(
              spineResult.spine,
              localContext,
              callIndex,
              input.llm as NonNullable<GraphCompressorInput["llm"]> & { enabled: true }
            );
            markLLM();
          }

          // Step 4: ts-morph: Walk like human with depth-aware expansion (no LLM)
          // Reduced limits to prevent stack overflow
          const walkHops = Math.min(6, limits?.maxDepth ?? 6); // Reduced from 10 to 6
          const walkNodes = Math.min(450, limits?.maxNodes ? limits.maxNodes * 3 : 450); // Reduced from 4x to 3x
          const humanEdges = this.walkLikeHuman({
            spine: spineResult.spine,
            ctx: localContext,
            index: callIndex,
            ranked: rankedCalls,
            maxHops: walkHops,
            maxNodes: walkNodes
          });
          
          console.log(`[GraphCompressor] walkLikeHuman produced ${humanEdges.length} edges (${humanEdges.filter(e => e.kind === 'forward').length} forward, ${humanEdges.filter(e => e.kind === 'backward').length} backward, ${humanEdges.filter(e => e.kind === 'loop').length} loops)`);

          // Step 5: LLM filter if graph too dense (> 100 edges)
          let filteredEdges = humanEdges;
          if (humanEdges.length > 100 && canCallLLM()) {
            try {
              filteredEdges = await this.llmFilterImportantPaths(
                humanEdges,
                input.focus,
                input.llm as NonNullable<GraphCompressorInput["llm"]> & { enabled: true }
              );
              markLLM();
              console.log(`[GraphCompressor] LLM filtered ${humanEdges.length} → ${filteredEdges.length} edges`);
            } catch (error) {
              console.warn(`[GraphCompressor] LLM filtering failed, using all edges:`, error);
              // Continue with unfiltered edges on error
            }
          }

          // Step 6: Build directed graph
          // Extract workspaceRoot from file paths in spine
          let workspaceRoot = process.cwd();
          if (spineResult.spine.length > 0 && spineResult.spine[0].file) {
            const firstFile = spineResult.spine[0].file;
            if (path.isAbsolute(firstFile)) {
              // Find common root by going up directories until we find package.json or tsconfig.json
              let currentDir = path.dirname(firstFile);
              while (currentDir !== path.dirname(currentDir)) {
                const packageJson = path.join(currentDir, 'package.json');
                const tsconfigJson = path.join(currentDir, 'tsconfig.json');
                if (fs.existsSync(packageJson) || fs.existsSync(tsconfigJson)) {
                  workspaceRoot = currentDir;
                  break;
                }
                currentDir = path.dirname(currentDir);
              }
            }
          }
          
          prunedGraph = this.buildDirectedDebugGraph({
            spine: spineResult.spine,
            edges: filteredEdges,
            ctx: localContext,
            workspaceRoot
          });

          // Step 7: Filter out low-connectivity nodes (nodes with only 1-2 edges)
          // This removes unimportant nodes while keeping spine nodes and well-connected nodes
          prunedGraph = this.filterLowConnectivityNodes(
            prunedGraph,
            spineResult.spine,
            3  // Minimum 3 edges to keep a node (removes nodes with 1-2 edges)
          );

          usedCondensation = false;
        } catch (error) {
          console.warn('[GraphCompressor] LLM local trace failed, falling back to rule-pruned graph:', error);
          // Fall back to minimal spine graph
          const coarsePath = this.buildCoarsePath(input.focus, methodGraph);
          prunedGraph = this.buildMinimalSpineGraphFromCoarsePath(coarsePath, input.focus);
        }
      }
    } else {
      // EXISTING PATH: Graph compression approach
      
      // Step 3: Optional LLM condensation
      if (canCallLLM()) {
        try {
          prunedGraph = await this.condenseWithLLM(
            prunedGraph,
            input.focus,
            undefined,
            input.llm as NonNullable<GraphCompressorInput["llm"]> & { enabled: true },
            methodGraph
          );
          markLLM();
          usedCondensation = true;
        } catch (error) {
          console.warn('[GraphCompressor] LLM condensation failed, using rule-pruned graph:', error);
        }
      }

      // Step 4: Tier 3 LLM symbol resolution (if needed)
      if (ratio > 0.3 && totalEdges >= 20 && canCallLLM()) {
        try {
          // First, pick important unresolved edges
          selected = await this.pickImportantUnresolved(
            unresolvedEdges,
            methodGraph,
            input.focus,
            undefined,
            input.llm as NonNullable<GraphCompressorInput["llm"]> & { enabled: true },
            10  // Hard cap at 10
          );
          markLLM();

          // Then recover symbols for selected edges, if budget remains
          if (canCallLLM() && selected.length > 0) {
            const recovered = await this.recoverUnresolvedSymbols(
              selected,
              methodGraph,
              input.llm as NonNullable<GraphCompressorInput["llm"]> & { enabled: true },
              maxCalls - llmCalls  // Pass remaining budget
            );
            
            // Merge recovered edges into pruned graph
            for (const recoveredEdge of recovered) {
              // Only add if both caller and callee are in pruned graph
              const callerInGraph = prunedGraph.nodes.some(n => n.id === recoveredEdge.callerId);
              const calleeInGraph = prunedGraph.nodes.some(n => n.id === recoveredEdge.calleeId);

              if (callerInGraph && calleeInGraph) {
                // Add edge if not already present
                const edgeExists = prunedGraph.edges.some(
                  e => e.from === recoveredEdge.callerId && e.to === recoveredEdge.calleeId
                );
                if (!edgeExists) {
                  prunedGraph.edges.push({
                    from: recoveredEdge.callerId,
                    to: recoveredEdge.calleeId,
                    kind: "calls",
                    confidence: recoveredEdge.confidence,
                    evidence: ["llm-recovered"]
                  });
                }
              }
            }
          }
        } catch (error) {
          console.warn('[GraphCompressor] LLM symbol resolution failed:', error);
        }
      }

      // Log warning if budget exhausted
      if (useLLM && llmCalls >= maxCalls && ratio > 0.3) {
        console.warn(`[GraphCompressor] LLM budget exhausted (${llmCalls}/${maxCalls} calls), skipping further LLM steps`);
      }
    }

    // Ensure seed nodes are preserved in final output
    for (const seedId of seedIds) {
      if (!prunedGraph.nodes.some((n: CompressedNode) => n.id === seedId)) {
        const orig = methodGraph.symbols.find((s: SymbolDef) => s.id === seedId);
        if (orig) {
          prunedGraph.nodes.push({
            id: orig.id,
            label: orig.name,
            file: orig.file,
            kind: "symbol" as const,
            line: orig.startLine,
            badges: ["seed"]
          });
        }
      }
    }

    // Warn if compressed graph has no edges
    if (prunedGraph.edges.length === 0) {
      console.warn('[GraphCompressor] Compressed graph has 0 edges — downstream slicer may produce odd results');
      // Minimally connect seed nodes if we have any
      if (seedIds.size > 0 && prunedGraph.nodes.length > 1) {
        const seedNodes = Array.from(seedIds).filter(id => 
          prunedGraph.nodes.some(n => n.id === id)
        );
        // Connect first seed to others (simple fallback)
        for (let i = 1; i < seedNodes.length && i < 5; i++) {
          prunedGraph.edges.push({
            from: seedNodes[0],
            to: seedNodes[i],
            kind: "logical" as const,
            confidence: 0.3,
            evidence: ["seed-fallback"]
          });
        }
      }
    }

    // Build output
    const unresolved: SymbolCall[] = prunedGraph.edges
      .filter((e: CompressedEdge) => e.evidence?.includes("unresolved"))
      .map((e: CompressedEdge) => {
        const matchingEdge = methodGraph.symbolEdges.find((s: SymbolCall) => s.callerId === e.from && s.calleeId === e.to);
        return {
          callerId: e.from,
          calleeId: e.to,
          file: matchingEdge?.file || "",
          confidence: e.confidence,
          via: "unresolved" as const
        };
      });

    // Determine source type
    const sourceType = shouldUseLocalTrace ? "coarse-path+llm-local-trace" : (useLLM ? "static+llm" : "static-only");

    // Build simple graph (top 10-20 nodes)
    // Use original methodGraph if prunedGraph is too small (to ensure we get a meaningful simple graph)
    let simpleGraph: GraphCompressorOutput["simpleGraph"] | undefined;
    try {
      // If prunedGraph is too small (less than 5 nodes), build simpleGraph from original methodGraph
      // Otherwise build from prunedGraph
      let graphToUse: CompressedGraph;
      if (prunedGraph.nodes.length < 5) {
        // Convert methodGraph to CompressedGraph format for simpleGraph building
        // This ensures we have all the edges from the original graph
        graphToUse = {
          nodes: methodGraph.symbols.map(s => ({
            id: s.id,
            label: s.name,
            file: s.file,
            kind: (s.kind === 'method' || s.kind === 'function' ? 'symbol' : 'symbol') as 'symbol',
            line: s.startLine,
            badges: []
          })),
          edges: methodGraph.symbolEdges.map(e => ({
            from: e.callerId,
            to: e.calleeId,
            kind: 'calls' as const,
            confidence: e.confidence,
            evidence: e.via === 'unresolved' ? ['unresolved'] : undefined
          }))
        };
        console.log(`[GraphCompressor] Building simpleGraph from methodGraph: ${graphToUse.nodes.length} nodes, ${graphToUse.edges.length} edges`);
      } else {
        graphToUse = prunedGraph;
      }
      
      const mustIncludeIds = this.identifyMustIncludeNodes(graphToUse, input.focus);
      const simpleGraphSize = Math.max(10, Math.min(20, input.limits?.simpleGraphSize ?? 15));
      simpleGraph = this.buildSimpleGraph(graphToUse, mustIncludeIds, input.focus, simpleGraphSize);
      console.log(`[GraphCompressor] Generated simple graph: ${simpleGraph.nodes.length} nodes (from ${simpleGraph.meta?.totalOriginalNodes || graphToUse.nodes.length} original), ${simpleGraph.edges.length} edges`);
    } catch (error) {
      console.warn('[GraphCompressor] Failed to generate simple graph:', error);
      // Continue without simple graph
    }

    return {
      nodes: prunedGraph.nodes,
      edges: prunedGraph.edges,
      meta: {
        prunedCount: methodGraph.symbols.length - prunedGraph.nodes.length,
        unresolvedEdges: unresolved,
        source: sourceType as "static-only" | "static+llm" | "coarse-path+llm-local-trace",
        llm: useLLM ? {
          usedCalls: llmCalls,
          maxCalls: maxCalls,
          condensation: usedCondensation,
          selectedUnresolved: selected.length,
          unresolvedRatio: ratio
        } : undefined
      },
      simpleGraph
    };
  }

  /**
   * Extract curated subgraph from ExecutionGraph using node importance scoring
   * This is a public method that can be called from VisualizationService
   * when no root cause is found or filtered graph is empty.
   */
  public extractCuratedSubGraph(
    nodes: GraphNode[],
    edges: GraphEdge[],
    focus: GraphCompressorInput["focus"],
    minNodes: number = 20,
    maxNodes: number = 50
  ): { nodes: GraphNode[]; edges: GraphEdge[] } {
    if (nodes.length === 0) {
      return { nodes: [], edges: [] };
    }

    // Convert ExecutionGraph to CompressedGraph format
    const compressedNodes: CompressedNode[] = nodes.map(node => ({
      id: node.id,
      label: node.label,
      file: node.file,
      kind: node.kind === 'file' ? 'file' : node.kind === 'route' ? 'route' : 'symbol',
      line: node.line,
      loc: node.loc,
      badges: node.badges as string[] | undefined
    }));

    const compressedEdges: CompressedEdge[] = edges.map(edge => ({
      from: edge.from,
      to: edge.to,
      kind: edge.kind === 'calls' ? 'calls' : edge.kind === 'imports' ? 'imports' : 'logical',
      confidence: edge.confidence,
      evidence: edge.evidence,
      originalKind: edge.kind
    }));

    const compressedGraph: CompressedGraph = {
      nodes: compressedNodes,
      edges: compressedEdges
    };

    // Compute node depths
    const nodeDepths = this.computeNodeDepths(compressedGraph);

    // Score all nodes using existing scoring logic
    const scores = this.scoreNodesByImportance(compressedGraph, focus, nodeDepths);

    // Identify must-include nodes (error nodes, entry nodes, etc.)
    const mustIncludeIds = new Set<string>();
    for (const node of compressedNodes) {
      if (node.badges?.includes('error') || 
          node.badges?.includes('entry') || 
          node.badges?.includes('seed') ||
          node.badges?.includes('spine')) {
        mustIncludeIds.add(node.id);
      }
    }

    // Also include nodes from focus
    if (focus.entrySymbols) {
      for (const entry of focus.entrySymbols) {
        if (entry.id) {
          mustIncludeIds.add(entry.id);
        } else if (entry.name) {
          const matchingNode = compressedNodes.find(n => 
            (entry.name && n.label === entry.name) || 
            (entry.name && n.label.includes(entry.name)) ||
            (entry.name && n.id === entry.name)
          );
          if (matchingNode) {
            mustIncludeIds.add(matchingNode.id);
          }
        }
      }
    }

    if (focus.errorFrames) {
      for (const frame of focus.errorFrames) {
        const matchingNodes = compressedNodes.filter(n => n.file === frame.file);
        for (const node of matchingNodes) {
          mustIncludeIds.add(node.id);
        }
      }
    }

    // Compute node degrees for connectivity
    const nodeDegrees = this.computeNodeDegrees(compressedGraph);
    const edgeMap = new Map<string, Set<string>>();
    for (const edge of compressedEdges) {
      if (!edgeMap.has(edge.from)) {
        edgeMap.set(edge.from, new Set());
      }
      edgeMap.get(edge.from)!.add(edge.to);
    }

    // Identify bridge nodes (nodes on paths between must-include nodes)
    const bridgeNodes = new Set<string>();
    const mustIncludeList = Array.from(mustIncludeIds);
    for (let i = 0; i < mustIncludeList.length; i++) {
      for (let j = i + 1; j < mustIncludeList.length; j++) {
        const fromId = mustIncludeList[i];
        const toId = mustIncludeList[j];
        const path = this.findShortestPath(fromId, toId, edgeMap);
        if (path) {
          for (let k = 1; k < path.length - 1; k++) {
            bridgeNodes.add(path[k]);
          }
        }
      }
    }

    // Sort nodes by score, excluding already selected ones
    const nodesByScore = Array.from(compressedNodes)
      .filter(n => !mustIncludeIds.has(n.id))
      .sort((a, b) => {
        const scoreA = scores.get(a.id) || 0;
        const scoreB = scores.get(b.id) || 0;
        return scoreB - scoreA; // Descending
      });

    // Select top N nodes
    const selectedNodes = new Set<string>(mustIncludeIds);
    const targetSize = Math.max(minNodes, Math.min(maxNodes, compressedNodes.length));
    const remainingSlots = Math.max(0, targetSize - selectedNodes.size);
    
    for (let i = 0; i < remainingSlots && i < nodesByScore.length; i++) {
      selectedNodes.add(nodesByScore[i].id);
    }

    // Add bridge nodes to ensure connectivity
    for (const bridgeId of bridgeNodes) {
      selectedNodes.add(bridgeId);
    }

    // Ensure suspect/root cause nodes have at least 10 neighboring nodes for context
    const suspectNodes = new Set<string>(mustIncludeIds); // Error nodes, entry nodes, etc. are suspect nodes
    const MIN_NEIGHBORS = 10;

    // Build adjacency map for incoming edges (reuse edgeMap for outgoing edges)
    const incomingEdges = new Map<string, Set<string>>(); // nodeId -> Set<neighborId>
    
    for (const edge of compressedEdges) {
      // Incoming edges
      if (!incomingEdges.has(edge.to)) {
        incomingEdges.set(edge.to, new Set());
      }
      incomingEdges.get(edge.to)!.add(edge.from);
    }

    // For each suspect node, ensure it has at least MIN_NEIGHBORS neighbors
    for (const suspectId of suspectNodes) {
      // Skip if suspect node doesn't exist in the graph
      if (!compressedNodes.some(n => n.id === suspectId)) {
        continue;
      }

      // Collect all neighbors (both incoming and outgoing)
      const neighbors = new Set<string>();
      const outgoing = edgeMap.get(suspectId) || new Set();
      const incoming = incomingEdges.get(suspectId) || new Set();
      
      for (const neighborId of outgoing) {
        neighbors.add(neighborId);
      }
      for (const neighborId of incoming) {
        neighbors.add(neighborId);
      }

      // Count how many neighbors are already in selectedNodes
      let selectedNeighborCount = 0;
      for (const neighborId of neighbors) {
        if (selectedNodes.has(neighborId)) {
          selectedNeighborCount++;
        }
      }

      // If we have fewer than MIN_NEIGHBORS, add missing neighbors
      if (selectedNeighborCount < MIN_NEIGHBORS) {
        const missingNeighbors = Array.from(neighbors)
          .filter(neighborId => !selectedNodes.has(neighborId))
          .map(neighborId => {
            const node = compressedNodes.find(n => n.id === neighborId);
            return node ? { id: neighborId, score: scores.get(neighborId) || 0 } : null;
          })
          .filter((n): n is { id: string; score: number } => n !== null)
          .sort((a, b) => b.score - a.score); // Sort by score descending (highest first)

        // Add missing neighbors until we reach MIN_NEIGHBORS or hit maxNodes limit
        const needed = MIN_NEIGHBORS - selectedNeighborCount;
        for (let i = 0; i < Math.min(needed, missingNeighbors.length); i++) {
          // Check if we're still within maxNodes limit
          if (selectedNodes.size >= targetSize) {
            break;
          }
          selectedNodes.add(missingNeighbors[i].id);
        }
      }
    }

    // Filter nodes and edges
    const filteredNodes = compressedNodes.filter(n => selectedNodes.has(n.id));
    const filteredEdges = compressedEdges.filter(e => 
      selectedNodes.has(e.from) && selectedNodes.has(e.to)
    );

    // Convert back to ExecutionGraph format
    const resultNodes: GraphNode[] = filteredNodes.map(node => {
      const normalizedBadges = node.badges?.filter(
        (badge): badge is GraphNodeBadge =>
          VALID_GRAPH_NODE_BADGES.includes(badge as GraphNodeBadge)
      );

      return {
        id: node.id,
        label: node.label,
        file: node.file,
        kind: node.kind === 'route' ? 'route' : node.kind === 'file' ? 'file' : node.kind === 'symbol' ? 'symbol' : 'file',
        line: node.line,
        loc: node.loc,
        badges: normalizedBadges
      };
    });

    const resultEdges: GraphEdge[] = filteredEdges.map(edge => ({
      from: edge.from,
      to: edge.to,
      kind: edge.originalKind ?? (edge.kind === 'calls' ? 'calls' : edge.kind === 'imports' ? 'imports' : 'calls'),
      confidence: edge.confidence,
      evidence: edge.evidence,
      label: edge.label
    }));

    return {
      nodes: resultNodes,
      edges: resultEdges
    };
  }

  /**
   * Step 1: Build seed set from focus and evidence
   */
  private buildSeedSet(
    focus: GraphCompressorInput["focus"],
    evidence: Evidence | undefined,
    methodGraph: MethodExecutionGraph
  ): Set<string> {
    const seedIds = new Set<string>();

    // Add entry symbols
    if (focus.entrySymbols) {
      for (const entry of focus.entrySymbols) {
        if (entry.id) {
          seedIds.add(entry.id);
        } else if (entry.name) {
          // Try exact match first
          let symbol = methodGraph.symbols.find(
            s => s.name === entry.name
          );

          // If not found, try partial match (e.g., "handleDebugging" matches "SamuraiAgent.handleDebugging")
          if (!symbol && entry.name) {
            const nameToMatch = entry.name;
            symbol = methodGraph.symbols.find(s =>
              s.name === nameToMatch ||
              s.name.endsWith(`.${nameToMatch}`) ||
              s.name.includes(nameToMatch)
            );
          }

          // If found, add to seed set
          if (symbol) {
            seedIds.add(symbol.id);
          }
        }
      }
    }

    // Add error frame symbols
    if (focus.errorFrames) {
      for (const frame of focus.errorFrames) {
        const symbolsInFile = methodGraph.symbols.filter(s => s.file === frame.file);
        if (frame.line) {
          // Find symbol closest to error line
          const closest = symbolsInFile.reduce((best, current) => {
            if (!best || !current.startLine) return current;
            const bestDist = Math.abs((best.startLine || 0) - frame.line!);
            const currentDist = Math.abs(current.startLine - frame.line!);
            return currentDist < bestDist ? current : best;
          }, undefined as SymbolDef | undefined);
          if (closest) {
            seedIds.add(closest.id);
          }
        } else {
          // Add all symbols in error file
          for (const symbol of symbolsInFile) {
            seedIds.add(symbol.id);
          }
        }
      }
    }

    // Add user mentions
    if (focus.userMentions) {
      for (const mention of focus.userMentions) {
        const matching = methodGraph.symbols.filter(s =>
          s.name.toLowerCase().includes(mention.toLowerCase()) ||
          (s.file && s.file.toLowerCase().includes(mention.toLowerCase()))
        );
        for (const symbol of matching) {
          seedIds.add(symbol.id);
        }
      }
    }

    // Add log signatures
    if (evidence?.logSignatures) {
      for (const signature of evidence.logSignatures) {
        const token = this.extractTopToken(signature);
        if (token) {
          const matching = methodGraph.symbols.filter(s =>
            s.name.toLowerCase().includes(token.toLowerCase())
          );
          for (const symbol of matching.slice(0, 3)) {
            seedIds.add(symbol.id);
          }
        }
      }
    }

    // Fallback: top-5 most imported files' exported symbols
    if (seedIds.size === 0) {
      const fileImportCounts = new Map<string, number>();
      for (const edge of methodGraph.fileEdges) {
        fileImportCounts.set(edge.to, (fileImportCounts.get(edge.to) || 0) + 1);
      }
      const topFiles = Array.from(fileImportCounts.entries())
        .sort((a, b) => b[1] - a[1])
        .slice(0, 5)
        .map(([file]) => file);

      for (const file of topFiles) {
        const exportedSymbols = methodGraph.symbols.filter(
          s => s.file === file && s.exportName
        );
        for (const symbol of exportedSymbols.slice(0, 2)) {
          seedIds.add(symbol.id);
        }
      }
    }

    return seedIds;
  }

  /**
   * Step 2: Rule-based pruning with BFS expansion
   */
  private pruneWithRules(
    methodGraph: MethodExecutionGraph,
    seedIds: Set<string>,
    limits: Required<GraphCompressorInput["limits"]>,
    focus: GraphCompressorInput["focus"]
  ): CompressedGraph {
    const keptNodes = new Set<string>(seedIds);
    const keptEdges: CompressedEdge[] = [];
    const seen = new Set<string>();

    // Build indices
    const symbolById = new Map<string, SymbolDef>();
    for (const symbol of methodGraph.symbols) {
      symbolById.set(symbol.id, symbol);
    }

    const edgesByCaller = new Map<string, SymbolCall[]>();
    for (const edge of methodGraph.symbolEdges) {
      if (!edgesByCaller.has(edge.callerId)) {
        edgesByCaller.set(edge.callerId, []);
      }
      edgesByCaller.get(edge.callerId)!.push(edge);
    }

    // BFS queue
    const queue: BFSQueueItem[] = Array.from(seedIds).map(id => ({ id, depth: 0 }));

    // BFS expansion
    while (queue.length > 0 && keptNodes.size < (limits?.maxNodes || 150)) {
      const { id, depth } = queue.shift()!;

      if (seen.has(id) || depth >= (limits?.maxDepth || 5)) continue;
      seen.add(id);

      const outgoing = edgesByCaller.get(id) || [];

      // Filter and cap fan-out
      const filtered = outgoing
        .filter(e => {
          // Confidence threshold
          if (e.confidence < (limits?.minConfidence || 0.45)) return false;

          // Skip unresolved if confidence is too low
          if (e.via === "unresolved" && e.confidence < 0.4) return false;

          // Helper symbol filtering
          const callee = symbolById.get(e.calleeId);
          if (callee) {
            const name = callee.name.toLowerCase();
            if (
              name.startsWith('_') ||
              name.startsWith('use') ||
              name.includes('utils') ||
              name.includes('helper') ||
              name.includes('config') ||
              (name.includes('get') && name.includes('utils'))
            ) {
              return false;
            }
          }

          return true;
        })
        .slice(0, 4); // Fan-out cap

      for (const edge of filtered) {
        keptEdges.push({
          from: edge.callerId,
          to: edge.calleeId,
          kind: "calls",
          confidence: edge.confidence,
          evidence: edge.via === "unresolved" ? ["unresolved"] : undefined
        });

        if (!keptNodes.has(edge.calleeId)) {
          keptNodes.add(edge.calleeId);
          queue.push({ id: edge.calleeId, depth: depth + 1 });
        }
      }
    }

    // Convert to compressed graph
    let compressedNodes: CompressedNode[] = Array.from(keptNodes).map(id => {
      const symbol = symbolById.get(id);
      if (!symbol) {
        return {
          id,
          label: id.includes('<unresolved:') ? id.split('<unresolved:')[1].replace('>', '') : id,
          kind: "symbol" as const,
          badges: ["lowConfidence"]
        };
      }

      return {
        id: symbol.id,
        label: symbol.name,
        file: symbol.file,
        kind: "symbol" as const,
        line: symbol.startLine,
        badges: symbol.exportName ? [] : ["lowConfidence"]
      };
    });

    // Apply target node count if exceeded
    if (limits?.targetNodeCount && compressedNodes.length > limits.targetNodeCount) {
      compressedNodes = this.applyTargetNodeCount(
        compressedNodes,
        keptEdges,
        focus,
        limits.targetNodeCount
      );
    }

    return {
      nodes: compressedNodes,
      edges: keptEdges
    };
  }

  /**
   * Apply target node count by keeping critical paths and dropping low-degree helpers
   */
  private applyTargetNodeCount(
    nodes: CompressedNode[],
    edges: CompressedEdge[],
    focus: GraphCompressorInput["focus"],
    targetCount: number
  ): CompressedNode[] {
    // Build graph for path analysis
    const inDegree = new Map<string, number>();
    const outDegree = new Map<string, number>();
    const adjacency = new Map<string, string[]>();

    for (const edge of edges) {
      // Update degrees
      outDegree.set(edge.from, (outDegree.get(edge.from) || 0) + 1);
      inDegree.set(edge.to, (inDegree.get(edge.to) || 0) + 1);

      // Build adjacency
      if (!adjacency.has(edge.from)) {
        adjacency.set(edge.from, []);
      }
      adjacency.get(edge.from)!.push(edge.to);
    }

    // Find critical paths (entry → error frames)
    const entryIds = new Set<string>();
    if (focus.entrySymbols) {
      for (const entry of focus.entrySymbols) {
        if (entry.id) entryIds.add(entry.id);
      }
    }

    const errorIds = new Set<string>();
    if (focus.errorFrames) {
      for (const frame of focus.errorFrames) {
        // Find symbols in error file
        for (const node of nodes) {
          if (node.file === frame.file) {
            errorIds.add(node.id);
          }
        }
      }
    }

    // Keep all nodes on paths from entry to error
    const keepSet = new Set<string>();
    const visited = new Set<string>();

    const dfs = (nodeId: string, isOnPath: boolean) => {
      if (visited.has(nodeId)) return;
      visited.add(nodeId);

      if (isOnPath || entryIds.has(nodeId) || errorIds.has(nodeId)) {
        keepSet.add(nodeId);
        isOnPath = true;
      }

      const neighbors = adjacency.get(nodeId) || [];
      for (const neighbor of neighbors) {
        dfs(neighbor, isOnPath || errorIds.has(neighbor));
      }
    };

    for (const entryId of entryIds) {
      dfs(entryId, true);
    }

    // If still too many, drop lowest-degree helpers
    const candidates = nodes.filter(n => !keepSet.has(n.id));
    candidates.sort((a, b) => {
      const aTotal = (inDegree.get(a.id) || 0) + (outDegree.get(a.id) || 0);
      const bTotal = (inDegree.get(b.id) || 0) + (outDegree.get(b.id) || 0);
      return aTotal - bTotal; // Keep higher degree first
    });

    const toKeep = candidates.slice(0, Math.max(0, targetCount - keepSet.size));
    for (const node of toKeep) {
      keepSet.add(node.id);
    }

    return nodes.filter(n => keepSet.has(n.id));
  }

  /**
   * Step 3: LLM condensation (optional)
   */
  private async condenseWithLLM(
    prunedGraph: CompressedGraph,
    focus: GraphCompressorInput["focus"],
    evidence: Evidence | undefined,
    llmConfig: NonNullable<GraphCompressorInput["llm"]> & { enabled: true },
    methodGraph: MethodExecutionGraph
  ): Promise<CompressedGraph> {
    const prompt = this.buildCondensationPrompt(prunedGraph, focus, evidence);

    const response = await this.llmProvider.chat({
      id: `graph-compress-${Date.now()}`,
      provider: "auto",
      model: llmConfig.model,
      messages: [
        {
          role: "system",
          content: "You are a code analysis assistant. Condense execution graphs to show only the essential debugging path."
        },
        {
          role: "user",
          content: prompt
        }
      ],
      metadata: {
        type: "graph_compression"
      },
      createdAt: new Date(),
      updatedAt: new Date(),
      maxTokens: Math.max(llmConfig.maxTokens || 4000, 8000),  // Increase for longer responses
      temperature: llmConfig.temperature || 0.3
    });

    if (response.type === "error" || !response.payload) {
      const errorMsg = response.error || "LLM condensation failed";
      // Check if it's a MAX_TOKENS error and handle gracefully
      if (errorMsg.includes('MAX_TOKENS') || errorMsg.includes('max tokens') || errorMsg.includes('Empty')) {
        console.warn('[GraphCompressor] LLM condensation hit MAX_TOKENS or returned empty, using rule-pruned graph');
        return prunedGraph;
      }
      throw new Error(errorMsg);
    }

    const llmResponse = response.payload;
    if ('error' in llmResponse) {
      const errorMsg = llmResponse.error || "LLM condensation failed";
      // Check if it's a MAX_TOKENS error and handle gracefully
      if (errorMsg.includes('MAX_TOKENS') || errorMsg.includes('max tokens')) {
        console.warn('[GraphCompressor] LLM condensation response hit MAX_TOKENS, using rule-pruned graph');
        return prunedGraph;
      }
      throw new Error(errorMsg);
    }
    
    // llmResponse is LLMResponse at this point
    const content = llmResponse.content || "";

    // Handle empty content (MAX_TOKENS case - response was truncated)
    if (!content || content.trim() === '') {
      console.warn('[GraphCompressor] LLM condensation returned empty content (likely MAX_TOKENS), using rule-pruned graph');
      return prunedGraph;
    }

    // Parse LLM response
    const parsed = this.parseCondensationResponse(content);
    if (!parsed) {
      console.warn('[GraphCompressor] Failed to parse LLM condensation response');
      return prunedGraph;
    }

    // Apply grouping and filtering from LLM response
    return this.applyLLMCondensation(parsed, prunedGraph, methodGraph);
  }

  /**
   * Build condensation prompt for LLM
   */
  private buildCondensationPrompt(
    graph: CompressedGraph,
    focus: GraphCompressorInput["focus"],
    evidence: Evidence | undefined
  ): string {
    const entrypoints = focus.entrySymbols?.map((e: { id?: string; name?: string }) => e.name || e.id).join(", ") || "unknown";
    const errorFrames = focus.errorFrames?.map((f: { file: string; line?: number }) => `${path.basename(f.file)}:${f.line || ''}`).join(", ") || "none";

    // Limit nodes/edges to prevent prompt from being too long (max ~50 nodes)
    const maxNodes = 50;
    const limitedNodes = graph.nodes.slice(0, maxNodes);
    const nodeIds = new Set(limitedNodes.map(n => n.id));
    const limitedEdges = graph.edges.filter(e => nodeIds.has(e.from) && nodeIds.has(e.to)).slice(0, maxNodes);

    const nodesJson = JSON.stringify(
      limitedNodes.map(n => ({
        id: n.id,
        label: n.label,
        file: n.file ? path.basename(n.file) : undefined,
        line: n.line
      })),
      null,
      0  // Compact JSON
    );

    const edgesJson = JSON.stringify(
      limitedEdges.map(e => ({
        from: e.from,
        to: e.to,
        conf: e.confidence.toFixed(2)
      })),
      null,
      0  // Compact JSON
    );

    return `Condense this execution graph to show only the essential path from entry to error.

Entry: ${entrypoints}
Error: ${errorFrames}

Graph (${limitedNodes.length} nodes, ${limitedEdges.length} edges):
Nodes: ${nodesJson}
Edges: ${edgesJson}

Output JSON:
{
  "nodes": [
    { "keep": "node-id" },
    { "group": ["id1", "id2"], "as": "Helpers" }
  ],
  "edges": [["from-id", "to-id"]]
}

Rules: Keep entry→error path. Group helpers (*Utils, normalize*). Max 15-20 nodes.`;
  }

  /**
   * Parse LLM condensation response
   */
  private parseCondensationResponse(content: string): LLMCondensationResponse | null {
    try {
      // Extract JSON from markdown code blocks if present
      const jsonMatch = content.match(/```(?:json)?\s*(\{[\s\S]*\})\s*```/);
      const jsonStr = jsonMatch ? jsonMatch[1] : content;

      const parsed = JSON.parse(jsonStr) as LLMCondensationResponse;
      return parsed;
    } catch (error) {
      console.warn('[GraphCompressor] Failed to parse condensation response:', error);
      return null;
    }
  }

  /**
   * Apply LLM condensation to graph
   */
  private applyLLMCondensation(
    parsed: LLMCondensationResponse,
    graph: CompressedGraph,
    methodGraph: MethodExecutionGraph
  ): CompressedGraph {
    const keptNodeIds = new Set<string>();
    const groupedNodes = new Map<string, { originalIds: string[]; label: string }>();
    const newNodes: CompressedNode[] = [];
    const newEdges: CompressedEdge[] = [];

    // Process node instructions
    for (const nodeInst of parsed.nodes || []) {
      if (nodeInst.keep) {
        keptNodeIds.add(nodeInst.keep);
      } else if (nodeInst.group && nodeInst.as) {
        const groupId = `group:${nodeInst.as.toLowerCase().replace(/\s+/g, '-')}`;
        groupedNodes.set(groupId, {
          originalIds: nodeInst.group,
          label: nodeInst.as
        });
        for (const origId of nodeInst.group) {
          keptNodeIds.add(origId);
        }
      }
    }

    // Add kept nodes
    for (const node of graph.nodes) {
      if (keptNodeIds.has(node.id)) {
        // Check if this node should be grouped
        let grouped = false;
        for (const [groupId, group] of groupedNodes.entries()) {
          if (group.originalIds.includes(node.id)) {
            grouped = true;
            break;
          }
        }
        if (!grouped) {
          newNodes.push(node);
        }
      }
    }

    // Add group nodes
    for (const [groupId, group] of groupedNodes.entries()) {
      newNodes.push({
        id: groupId,
        label: group.label,
        kind: "group",
        badges: ["grouped"],
        originalIds: group.originalIds
      });
    }

    // Rebuild edges
    for (const edge of graph.edges) {
      // Map original IDs to kept/grouped IDs
      const fromId = this.mapToGroupedId(edge.from, groupedNodes);
      const toId = this.mapToGroupedId(edge.to, groupedNodes);

      if (fromId && toId && keptNodeIds.has(edge.from) && keptNodeIds.has(edge.to)) {
        // Check if edge already exists
        const exists = newEdges.some(e => e.from === fromId && e.to === toId);
        if (!exists) {
          newEdges.push({
            from: fromId,
            to: toId,
            kind: edge.from !== fromId || edge.to !== toId ? "grouped" : edge.kind,
            confidence: edge.confidence,
            evidence: [...(edge.evidence || []), "llm-condensed"],
            originalKind: edge.originalKind
          });
        }
      }
    }

    // Apply LLM-suggested edges if provided
    if (parsed.edges) {
      for (const [from, to] of parsed.edges) {
        const fromId = this.mapToGroupedId(from, groupedNodes) || from;
        const toId = this.mapToGroupedId(to, groupedNodes) || to;

        if (keptNodeIds.has(from) && keptNodeIds.has(to)) {
          const exists = newEdges.some(e => e.from === fromId && e.to === toId);
          if (!exists) {
            newEdges.push({
              from: fromId,
              to: toId,
              kind: "logical",
              confidence: 0.35,
              evidence: ["llm-suggested"]
            });
          }
        }
      }
    }

    return {
      nodes: newNodes,
      edges: newEdges
    };
  }

  /**
   * Map original node ID to grouped ID if it belongs to a group
   */
  private mapToGroupedId(
    nodeId: string,
    groupedNodes: Map<string, { originalIds: string[]; label: string }>
  ): string | null {
    for (const [groupId, group] of groupedNodes.entries()) {
      if (group.originalIds.includes(nodeId)) {
        return groupId;
      }
    }
    return nodeId;
  }

  /**
   * Pick important unresolved edges using LLM
   */
  private async pickImportantUnresolved(
    unresolvedEdges: SymbolCall[],
    methodGraph: MethodExecutionGraph,
    focus: GraphCompressorInput["focus"],
    evidence: Evidence | undefined,
    llmConfig: NonNullable<GraphCompressorInput["llm"]> & { enabled: true },
    maxCount: number = 10
  ): Promise<SymbolCall[]> {
    // Build edge list with stable IDs (limit to 100 for prompt size)
    const items = unresolvedEdges.slice(0, 100).map(e => {
      const caller = methodGraph.symbols.find(s => s.id === e.callerId);
      const calleeName = e.calleeId.includes('<unresolved:')
        ? e.calleeId.replace('<unresolved:', '').replace('>', '')
        : e.calleeId;
      return {
        edgeId: `${e.callerId}-->${e.calleeId}`,  // Stable format
        caller: caller?.name || e.callerId,
        callee: calleeName,
        file: caller ? path.basename(caller.file) : 'unknown'
      };
    });

    // Build concise prompt
    const entrypoints = focus.entrySymbols?.map((e: { id?: string; name?: string }) => e.name || e.id).join(", ") || "unknown";
    const errorFrames = focus.errorFrames?.map((f: { file: string; line?: number }) => `${path.basename(f.file)}:${f.line || ''}`).join(", ") || "none";

    // Filter out items with unknown files to reduce prompt size
    const filteredItems = items.filter(item => item.file !== 'unknown');
    
    const edgesJson = JSON.stringify(
      filteredItems.map(item => ({
        edgeId: item.edgeId,
        caller: item.caller,
        callee: item.callee,
        file: item.file
      })),
      null,
      0  // Compact JSON
    );

    const prompt = `You will see:
1. Error frames: ${errorFrames}
2. Entry symbols: ${entrypoints}
3. Unresolved edges (each has edgeId = callerId-->calleeId)

${edgesJson}

Pick at most ${maxCount} edgeIds that, if resolved, would help connect entry → error.

Return JSON only:
{"importantEdges": ["id1","id2",...]}`;

    // Make LLM call
    const callId = `pick-important-${Date.now()}`;
    const response = await this.llmProvider.chat({
      id: callId,
      provider: "auto",
      model: llmConfig.model,
      messages: [
        {
          role: "system",
          content: "You are a code analysis assistant. Select the most important unresolved symbol edges for debugging."
        },
        {
          role: "user",
          content: prompt
        }
      ],
      metadata: {
        type: "unresolved_selection"
      },
      createdAt: new Date(),
      updatedAt: new Date(),
      maxTokens: Math.max(llmConfig.maxTokens || 4000, 8000),  // Increase for longer responses
      temperature: llmConfig.temperature || 0.3
    });

    if (response.type === "error" || !response.payload) {
      console.warn(`[GraphCompressor] pickImportantUnresolved failed (${callId}):`, response.error);
      return [];
    }

    const llmResponse = response.payload;
    if ('error' in llmResponse) {
      console.warn(`[GraphCompressor] pickImportantUnresolved LLM error (${callId}):`, llmResponse.error);
      return [];
    }
    
    // llmResponse is LLMResponse at this point
    const content = llmResponse.content || "";
    
    if (!content || content.trim() === '') {
      console.warn(`[GraphCompressor] pickImportantUnresolved returned empty content (${callId})`);
      return [];
    }

    // Parse response
    try {
      const jsonMatch = content.match(/```(?:json)?\s*(\{[\s\S]*\})\s*```/);
      const jsonStr = jsonMatch ? jsonMatch[1] : content;
      const parsed = JSON.parse(jsonStr) as { importantEdges?: string[] };

      if (!parsed.importantEdges || !Array.isArray(parsed.importantEdges)) {
        console.warn(`[GraphCompressor] Invalid pickImportantUnresolved response format (${callId})`);
        return [];
      }

      // Map returned IDs back to SymbolCall objects
      const returnedIds = new Set(parsed.importantEdges);
      const selected = unresolvedEdges.filter(e =>
        returnedIds.has(`${e.callerId}-->${e.calleeId}`)
      ).slice(0, maxCount);  // Hard cap at 10

      return selected;
    } catch (error) {
      console.warn(`[GraphCompressor] Failed to parse pickImportantUnresolved response (${callId}):`, error);
      return [];
    }
  }

  /**
   * Step 4: Tier 3 LLM Symbol Resolution
   */
  private async recoverUnresolvedSymbols(
    unresolvedEdges: SymbolCall[],
    methodGraph: MethodExecutionGraph,
    llmConfig: NonNullable<GraphCompressorInput["llm"]> & { enabled: true },
    remainingCalls: number  // NEW: budget remaining
  ): Promise<SymbolCall[]> {
    // Early return if no budget
    if (remainingCalls <= 0) {
      return [];
    }

    // Hard cap input edges to 10
    const edgesToProcess = unresolvedEdges.slice(0, 10);

    // Batch with smaller size (5 per batch = max 2 batches)
    const batches: SymbolCall[][] = [];
    for (let i = 0; i < edgesToProcess.length; i += 5) {
      batches.push(edgesToProcess.slice(i, i + 5));
    }

    const recovered: SymbolCall[] = [];

    // Track budget in loop
    let remaining = remainingCalls;
    for (const batch of batches) {
      if (remaining <= 0) break;

      const context = this.buildResolutionContext(batch, methodGraph);
      const prompt = this.buildResolutionPrompt(batch, context);

      const response = await this.llmProvider.chat({
        id: `symbol-resolve-${Date.now()}`,
        provider: "auto",
        model: llmConfig.model,
        messages: [
          {
            role: "system",
            content: "You are a code analysis assistant. Resolve unresolved symbol calls by matching them to actual symbols in the codebase."
          },
          {
            role: "user",
            content: prompt
          }
        ],
        metadata: {
          type: "symbol_resolution"
        },
        createdAt: new Date(),
        updatedAt: new Date(),
        maxTokens: Math.max(llmConfig.maxTokens || 4000, 8000),  // Increase for longer responses
        temperature: llmConfig.temperature || 0.2
      });

      // Decrement remaining budget after call
      remaining--;

      if (response.type === "error" || !response.payload) {
        console.warn(`[GraphCompressor] LLM symbol resolution failed for batch (${batch.length} edges):`, response.error || 'Unknown error');
        continue;
      }

      const llmResponse = response.payload;
      if ('error' in llmResponse) {
        const errorMsg = llmResponse.error || "LLM symbol resolution failed";
        // Check if it's a MAX_TOKENS error - this is expected and we can skip this batch
        if (errorMsg.includes('MAX_TOKENS') || errorMsg.includes('max tokens') || errorMsg.includes('Empty')) {
          console.warn(`[GraphCompressor] LLM symbol resolution hit MAX_TOKENS for batch (${batch.length} edges), skipping`);
        } else {
          console.warn('[GraphCompressor] LLM symbol resolution error:', errorMsg);
        }
        continue;
      }
      
      // llmResponse is LLMResponse at this point
      const content = llmResponse.content || "";

      // Handle empty content (MAX_TOKENS case - response was truncated)
      if (!content || content.trim() === '') {
        console.warn(`[GraphCompressor] LLM symbol resolution returned empty content for batch (${batch.length} edges), skipping`);
        continue;
      }

      // Parse response
      const parsed = this.parseResolutionResponse(content);
      if (parsed) {
        for (const resolved of parsed.resolved) {
          const originalEdge = batch.find(
            e => e.callerId === resolved.from && e.calleeId === resolved.to
          );
          if (originalEdge && resolved.targetSymbolId) {
            recovered.push({
              ...originalEdge,
              calleeId: resolved.targetSymbolId,
              confidence: resolved.confidence,
              via: "llm-polish"
            });
          }
        }
      }
    }

    return recovered;
  }

  /**
   * Build context for symbol resolution
   */
  private buildResolutionContext(
    unresolvedEdges: SymbolCall[],
    methodGraph: MethodExecutionGraph
  ): {
    callerSource: Map<string, string>;
    fileExports: Map<string, string[]>;
    callerImports: Map<string, ImportExportRelation[]>;
  } {
    const callerSource = new Map<string, string>();
    const fileExports = new Map<string, string[]>();
    const callerImports = new Map<string, ImportExportRelation[]>();

    // Get unique caller files
    const callerFiles = new Set(
      unresolvedEdges
        .map(e => {
          const caller = methodGraph.symbols.find(s => s.id === e.callerId);
          return caller?.file;
        })
        .filter((f): f is string => !!f)
    );

    // Extract source code snippets for callers
    for (const file of callerFiles) {
      try {
        if (fs.existsSync(file)) {
          // Guard against huge files (remote FS, monorepos)
          const stat = fs.statSync(file);
          if (stat.size > 200_000) continue; // Skip files > 200KB
          
          const content = fs.readFileSync(file, 'utf8');
          const lines = content.split('\n');

          // Find callers in this file
          const callersInFile = unresolvedEdges
            .map(e => {
              const caller = methodGraph.symbols.find(s => s.id === e.callerId && s.file === file);
              return caller;
            })
            .filter((c): c is SymbolDef => !!c);

          for (const caller of callersInFile) {
            if (caller.startLine && caller.endLine) {
              const start = Math.max(0, caller.startLine - 3);  // Reduced from -5 to -3
              const end = Math.min(lines.length, caller.endLine + 3);  // Reduced from +5 to +3
              const snippet = lines.slice(Math.max(0, start - 1), end).join('\n');
              // Limit snippet size to 1000 chars
              const truncated = snippet.length > 1000 ? snippet.substring(0, 1000) + '...' : snippet;
              callerSource.set(caller.id, truncated);
            }
          }
        }
      } catch (error) {
        // Skip files we can't read
      }
    }

    // Get file exports
    for (const file of callerFiles) {
      const exports = methodGraph.symbols
        .filter(s => s.file === file && s.exportName)
        .map(s => s.name);
      fileExports.set(file, exports);
    }

    // Get caller imports
    for (const file of callerFiles) {
      const imports = methodGraph.fileEdges.filter(e => e.from === file);
      callerImports.set(file, imports);
    }

    return { callerSource, fileExports, callerImports };
  }

  /**
   * Build resolution prompt
   */
  private buildResolutionPrompt(
    unresolvedEdges: SymbolCall[],
    context: {
      callerSource: Map<string, string>;
      fileExports: Map<string, string[]>;
      callerImports: Map<string, ImportExportRelation[]>;
    }
  ): string {
    const edgesJson = JSON.stringify(
      unresolvedEdges.map(e => ({
        callerId: e.callerId,
        calleeId: e.calleeId,
        file: e.file
      })),
      null,
      2
    );

    // Limit context to prevent prompt from being too long
    let contextStr = "Context:\n";
    let contextCount = 0;
    const maxContext = 5;  // Limit to 5 callers max
    for (const [callerId, source] of context.callerSource.entries()) {
      if (contextCount >= maxContext) break;
      // Truncate source to 300 chars (reduced from 500)
      const truncatedSource = source.length > 300 ? source.substring(0, 300) + '...' : source;
      contextStr += `\nCaller ${callerId.substring(0, 60)}:\n\`\`\`\n${truncatedSource}\n\`\`\`\n`;
      contextCount++;
    }

    return `Resolve unresolved symbol calls by matching to actual symbols.

Edges (${unresolvedEdges.length}):
${edgesJson}

${contextStr}

Output JSON:
{"resolved": [{"from": "caller-id", "to": "unresolved-id", "targetSymbolId": "symbol:file:name", "confidence": 0.4}]}`;
  }

  /**
   * Parse resolution response
   */
  private parseResolutionResponse(content: string): LLMResolutionResponse | null {
    try {
      const jsonMatch = content.match(/```(?:json)?\s*(\{[\s\S]*\})\s*```/);
      const jsonStr = jsonMatch ? jsonMatch[1] : content;
      const parsed = JSON.parse(jsonStr) as LLMResolutionResponse;
      return parsed;
    } catch (error) {
      console.warn('[GraphCompressor] Failed to parse resolution response:', error);
      return null;
    }
  }

  /**
   * Extract top token from log signature
   */
  private extractTopToken(signature: string): string | null {
    const match = signature.match(/([A-Z][a-zA-Z0-9]+|[a-z][a-zA-Z0-9]*)/);
    return match ? match[1] : null;
  }

  /**
   * Build coarse path from focus (files + candidate methods)
   */
  public buildCoarsePath(
    focus: GraphCompressorInput["focus"],
    methodGraph: MethodExecutionGraph
  ): {
    files: string[];
    methods?: string[];
  } {
    const files = new Set<string>();
    const methods: string[] = [];

    // Extract files from entrySymbols
    if (focus.entrySymbols) {
      for (const entry of focus.entrySymbols) {
        // entrySymbols don't have file property, so we skip file matching
        if (entry.id) {
          const symbol = methodGraph.symbols.find(s => s.id === entry.id);
          if (symbol?.file) {
            files.add(symbol.file);
            if (symbol.name) methods.push(symbol.name);
          }
        } else if (entry.name) {
          const symbol = methodGraph.symbols.find(s => s.name === entry.name || s.name.endsWith(`.${entry.name}`));
          if (symbol?.file) {
            files.add(symbol.file);
            if (symbol.name) methods.push(symbol.name);
          }
        }
      }
    }

    // Extract files from errorFrames
    if (focus.errorFrames) {
      for (const frame of focus.errorFrames) {
        if (frame.file) {
          files.add(frame.file);
        }
      }
    }

    // Extract files from userMentions (match in methodGraph)
    if (focus.userMentions) {
      for (const mention of focus.userMentions) {
        const matchingSymbols = methodGraph.symbols.filter(s =>
          s.name.toLowerCase().includes(mention.toLowerCase()) ||
          path.basename(s.file).toLowerCase().includes(mention.toLowerCase())
        );
        for (const symbol of matchingSymbols.slice(0, 3)) {
          if (symbol.file) {
            files.add(symbol.file);
            if (symbol.name) methods.push(symbol.name);
          }
        }
      }
    }

    // Deduplicate and return top 3-4 files
    const fileArray = Array.from(files).slice(0, 4);
    const methodArray = Array.from(new Set(methods)).slice(0, 10);

    return {
      files: fileArray,
      methods: methodArray.length > 0 ? methodArray : undefined
    };
  }

  /**
   * Collect local context from source files (with file size cap)
   */
  public collectLocalContext(
    coarsePath: {
      files: string[];
      methods?: string[];
    },
    focus: GraphCompressorInput["focus"],
    methodGraph: MethodExecutionGraph
  ): LocalContext {
    const MAX_CHARS_PER_METHOD = 1200; // Per-method limit

    const files: LocalContext["files"] = [];
    let entry = "";
    let error: string | undefined;

    // Determine entry from focus
    if (focus.entrySymbols?.[0]) {
      const entrySym = focus.entrySymbols[0];
      if (entrySym.name) {
        entry = entrySym.name;
      } else if (entrySym.id) {
        const symbol = methodGraph.symbols.find(s => s.id === entrySym.id);
        if (symbol?.name) entry = symbol.name;
      }
    }

    // Determine error location
    if (focus.errorFrames?.[0]) {
      const frame = focus.errorFrames[0];
      error = `${path.basename(frame.file)}:${frame.line || 0}`;
    }

    // Process each file (max 4)
    for (const filePath of coarsePath.files.slice(0, 4)) {
      try {
        if (!fs.existsSync(filePath)) continue;
        
        const stat = fs.statSync(filePath);
        if (stat.size > 200_000) continue; // Skip huge files
        
        const content = fs.readFileSync(filePath, 'utf8');
        const lines = content.split('\n');
        
        // Extract imports/exports
        const imports: string[] = [];
        const exports: string[] = [];
        
        for (const line of lines.slice(0, 100)) { // Check first 100 lines
          if (line.trim().startsWith('import ')) {
            imports.push(line.trim());
          } else if (line.trim().startsWith('export ')) {
            exports.push(line.trim());
          }
        }

        // Extract methods using symbol info from methodGraph
        const methods: LocalContext["files"][0]["methods"] = [];
        
        if (coarsePath.methods) {
          for (const methodName of coarsePath.methods.slice(0, 5)) {
            const symbol = methodGraph.symbols.find(s => 
              (s.name === methodName || s.name.endsWith(`.${methodName}`)) && s.file === filePath
            );
            if (symbol && symbol.startLine && symbol.endLine) {
              const methodCode = lines.slice(symbol.startLine - 1, symbol.endLine).join('\n');
              const truncatedCode = methodCode.length > MAX_CHARS_PER_METHOD
                ? methodCode.substring(0, MAX_CHARS_PER_METHOD) + '\n// ... truncated ...'
                : methodCode;
              
              methods.push({
                name: symbol.name,
                start: symbol.startLine,
                end: symbol.endLine,
                code: truncatedCode
              });
            }
          }
        }

        // If no methods found, get a sample of exported functions from this file
        if (methods.length === 0) {
          const fileSymbols = methodGraph.symbols
            .filter(s => s.file === filePath && s.startLine && s.endLine)
            .slice(0, 3);
          
          for (const symbol of fileSymbols) {
            const methodCode = lines.slice(symbol.startLine! - 1, symbol.endLine!).join('\n');
            const truncatedCode = methodCode.length > MAX_CHARS_PER_METHOD
              ? methodCode.substring(0, MAX_CHARS_PER_METHOD) + '\n// ... truncated ...'
              : methodCode;
            
            methods.push({
              name: symbol.name,
              start: symbol.startLine!,
              end: symbol.endLine!,
              code: truncatedCode
            });
          }
        }

        files.push({
          path: filePath,
          imports: imports.slice(0, 20), // Limit imports
          exports: exports.slice(0, 20), // Limit exports
          methods: methods.slice(0, 10) // Limit methods
        });
      } catch (error) {
        console.warn(`[GraphCompressor] Failed to read file ${filePath}:`, error);
        // Continue to next file
      }
    }

    return {
      entry,
      error,
      files
    };
  }

  /**
   * LLM: Identify execution spine from local context
   */
  private async llmIdentifySpine(
    localContext: LocalContext,
    focus: GraphCompressorInput["focus"],
    llmConfig: NonNullable<GraphCompressorInput["llm"]> & { enabled: true }
  ): Promise<{
    entry: string;
    spine: Array<{
      file: string;
      method: string;
      reason: string;
    }>;
    possibleBefore?: Array<{file: string; method: string}>;
    possibleAfter?: Array<{file: string; method: string}>;
  }> {
    const callId = `spine-${Date.now()}`;
    
    // Build prompt
    let prompt = `You are analyzing code to identify the execution spine for debugging.

Entry point: ${localContext.entry || 'unknown'}
${localContext.error ? `Error location: ${localContext.error}` : ''}

Files and methods:

`;

    for (const file of localContext.files) {
      prompt += `\n## File: ${path.basename(file.path)}\n`;
      prompt += `Imports: ${file.imports.slice(0, 5).join(', ')}\n`;
      prompt += `Exports: ${file.exports.slice(0, 5).join(', ')}\n`;
      
      for (const method of file.methods) {
        prompt += `\n### Method: ${method.name} (lines ${method.start}-${method.end})\n`;
        prompt += `${method.code.substring(0, 800)}\n`;
      }
    }

    prompt += `\n\nTask: Identify the execution spine - the chain of methods that form the main execution path from the entry point to the error (if any).

Output JSON only:
{
  "entry": "${localContext.entry}",
  "spine": [
    {"file": "filename.ts", "method": "MethodName", "reason": "why this method is in the spine"},
    ...
  ],
  "possibleBefore": [...],
  "possibleAfter": [...]
}`;

    try {
      const response = await this.llmProvider.chat({
        id: callId,
        provider: '',
        model: llmConfig.model,
        messages: [
          {
            role: 'user',
            content: prompt
          }
        ],
        temperature: llmConfig.temperature ?? 0.3,
        maxTokens: llmConfig.maxTokens ?? 8000,
        metadata: {},
        createdAt: new Date(),
        updatedAt: new Date()
      });

      if (response.type !== 'success' || !response.payload) {
        console.warn(`[GraphCompressor] llmIdentifySpine failed for call ${callId}`);
        return { entry: localContext.entry, spine: [] };
      }

      const llmResponse = response.payload;
      if ('error' in llmResponse) {
        console.warn(`[GraphCompressor] llmIdentifySpine LLM error (${callId}):`, llmResponse.error);
        return { entry: localContext.entry, spine: [] };
      }

      // llmResponse is LLMResponse at this point
      const content = llmResponse.content || '';
      
      // Parse JSON from response
      const jsonMatch = content.match(/```(?:json)?\s*(\{[\s\S]*\})\s*```/);
      const jsonStr = jsonMatch ? jsonMatch[1] : content.trim();
      
      try {
        const parsed = JSON.parse(jsonStr);
        
        // Normalize file paths from LLM to match actual file paths in LocalContext
        // This function is generic and works for any workspace structure
        const normalizeSpineFile = (llmFile: string): string => {
          const fileName = path.basename(llmFile);
          
          // First, try to match against actual files in localContext (most reliable)
          for (const file of localContext.files) {
            const contextFileName = path.basename(file.path);
            if (contextFileName === fileName) {
              console.log(`[GraphCompressor] llmIdentifySpine: Normalized spine file from "${llmFile}" to "${file.path}" (matched by basename in context)`);
              return file.path; // Use actual file path from context
            }
          }
          
          // If not found in context, search workspace for file by name
          // Extract workspace root from first file in context or use process.cwd()
          let workspaceRoot = process.cwd();
          if (localContext.files.length > 0 && localContext.files[0].path) {
            // Find workspace root by going up from context file until we find package.json/tsconfig.json
            let current = path.dirname(localContext.files[0].path);
            for (let i = 0; i < 10; i++) {
              if (fs.existsSync(path.join(current, 'package.json')) || 
                  fs.existsSync(path.join(current, 'tsconfig.json')) ||
                  fs.existsSync(path.join(current, 'jsconfig.json'))) {
                workspaceRoot = current;
                break;
              }
              const parent = path.dirname(current);
              if (parent === current) break;
              current = parent;
            }
          }
          
          // If LLM returned a relative path, try to resolve it
          if (!path.isAbsolute(llmFile) && !llmFile.startsWith('/')) {
            // Try the exact relative path first
            const exactPath = path.join(workspaceRoot, llmFile);
            if (fs.existsSync(exactPath)) {
              console.log(`[GraphCompressor] llmIdentifySpine: Normalized spine file from "${llmFile}" to "${exactPath}" (found at exact relative path)`);
              return exactPath;
            }
            
            // If not found at exact path, search workspace for file with matching basename
            // This is a simple recursive search that works for any project structure
            const findFileInWorkspace = (dir: string, targetName: string, maxDepth: number = 5, currentDepth: number = 0): string | null => {
              if (currentDepth >= maxDepth) return null;
              
              try {
                const entries = fs.readdirSync(dir, { withFileTypes: true });
                
                for (const entry of entries) {
                  // Skip node_modules, .git, dist, build, etc.
                  if (entry.isDirectory() && 
                      (entry.name.startsWith('.') || 
                       entry.name === 'node_modules' || 
                       entry.name === 'dist' || 
                       entry.name === 'build' ||
                       entry.name === '.next' ||
                       entry.name === 'coverage')) {
                    continue;
                  }
                  
                  const fullPath = path.join(dir, entry.name);
                  
                  if (entry.isFile() && entry.name === targetName) {
                    return fullPath;
                  }
                  
                  if (entry.isDirectory()) {
                    const found = findFileInWorkspace(fullPath, targetName, maxDepth, currentDepth + 1);
                    if (found) return found;
                  }
                }
              } catch (err) {
                // Skip directories we can't read
              }
              
              return null;
            };
            
            const foundPath = findFileInWorkspace(workspaceRoot, fileName, 5);
            if (foundPath) {
              console.log(`[GraphCompressor] llmIdentifySpine: Normalized spine file from "${llmFile}" to "${foundPath}" (found via workspace search)`);
              return foundPath;
            }
          }
          
          // Return as-is if we can't resolve (will be caught later with file existence check)
          console.warn(`[GraphCompressor] llmIdentifySpine: Could not normalize spine file "${llmFile}", keeping as-is (will check existence later)`);
          return llmFile;
        };
        
        const normalizedSpine = (parsed.spine || []).map((s: any) => {
          const normalizedFile = normalizeSpineFile(s.file);
          if (normalizedFile !== s.file) {
            console.log(`[GraphCompressor] Normalized spine file: ${s.file} -> ${normalizedFile}`);
          }
          return {
            file: normalizedFile,
            method: s.method,
            reason: s.reason || ''
          };
        });
        
        return {
          entry: parsed.entry || localContext.entry,
          spine: normalizedSpine,
          possibleBefore: parsed.possibleBefore || [],
          possibleAfter: parsed.possibleAfter || []
        };
      } catch (parseError) {
        console.warn(`[GraphCompressor] Failed to parse spine response for call ${callId}:`, parseError);
        return { entry: localContext.entry, spine: [] };
      }
    } catch (error) {
      console.warn(`[GraphCompressor] llmIdentifySpine failed for call ${callId}:`, error);
      return { entry: localContext.entry, spine: [] };
    }
  }


  /**
   * Build directed graph from spine + AST edges (with beta guards)
   */
  public buildDirectedDebugGraph(opts: {
    spine: Array<{ file: string; method: string }>;
    edges: Array<{
      from: { file?: string; method: string };
      to: { file?: string; method: string };
      kind: "forward" | "backward" | "loop";
      depth: number;
      evidence: string[];
      line?: number;  // Line number where call occurs
      order?: number;  // Execution order within method
      label?: string;
    }>;
    ctx: LocalContext;
    workspaceRoot?: string;  // Workspace root for ts-morph operations
  }): CompressedGraph {
    const MAX_DEPTH = 6; // Hard cap on depth
    const nodes: CompressedNode[] = [];
    const edges: CompressedEdge[] = [];
    const seen = new Set<string>();
    const loopSet = new Set<string>(); // Guard against duplicate loops

    // Cache for line number lookups to avoid redundant ts-morph queries
    const lineNumberCache = new Map<string, number | undefined>();
    
    // Helper to get line number with caching
    const getLineNumber = (filePath: string | undefined, methodName: string, workspaceRoot?: string): number | undefined => {
      if (!filePath || !workspaceRoot) {
        return undefined;
      }
      const cacheKey = `${filePath}::${methodName}`;
      if (lineNumberCache.has(cacheKey)) {
        return lineNumberCache.get(cacheKey);
      }
      const lineNumber = this.findMethodLineNumber(filePath, methodName, workspaceRoot);
      lineNumberCache.set(cacheKey, lineNumber);
      return lineNumber;
    };

    // Helper to normalize method ID
    const methodId = (file: string | undefined, name: string): string => {
      const normalizedFile = file ?? "unknown";
      const normalizedName = name;
      return `method:${normalizedFile}:${normalizedName}`;
    };

    // 1. Add spine nodes (guaranteed)
    for (const s of opts.spine) {
      const id = methodId(s.file, s.method);
      if (!seen.has(id)) {
        seen.add(id);
        const lineNumber = getLineNumber(s.file, s.method, opts.workspaceRoot);
        nodes.push({
          id,
          label: s.method,
          file: s.file,
          kind: "symbol",
          badges: ["spine"],
          line: s.file ? (lineNumber ?? 1) : undefined // Fallback to line 1 if file exists but line number is undefined
        });
      }
    }

    // 2. Add structural edges spine[i] -> spine[i+1]
    for (let i = 0; i < opts.spine.length - 1; i++) {
      const from = opts.spine[i];
      const to = opts.spine[i + 1];
      const fromId = methodId(from.file, from.method);
      const toId = methodId(to.file, to.method);
      edges.push({
        from: fromId,
        to: toId,
        kind: "calls",
        confidence: 0.55, // Structural edges have higher confidence
        evidence: ["structural-spine"]
      });
    }

    // Track structural-spine edges to avoid duplicates
    const spineEdgeKeys = new Set<string>();
    for (let i = 0; i < opts.spine.length - 1; i++) {
      const fromId = methodId(opts.spine[i].file, opts.spine[i].method);
      const toId = methodId(opts.spine[i + 1].file, opts.spine[i + 1].method);
      spineEdgeKeys.add(`${fromId}->${toId}`);
    }

    // Track all existing edges to prevent duplicates and enable merge/replace
    // Edge key format: fromId::toId::kind (all edges become "calls" in final graph)
    // Map from duplicateCheckKey to edge index in edges array
    const existingEdges = new Map<string, number>();
    // Add spine edges to existingEdges (spine edges are at indices 0 to opts.spine.length - 2)
    for (let i = 0; i < opts.spine.length - 1; i++) {
      const fromId = methodId(opts.spine[i].file, opts.spine[i].method);
      const toId = methodId(opts.spine[i + 1].file, opts.spine[i + 1].method);
      const edgeKey = `${fromId}::${toId}::calls`;
      existingEdges.set(edgeKey, i);
    }

    // 3. Process edges from walkLikeHuman
    for (const edge of opts.edges) {
      // Enforce depth cap
      if (edge.depth > MAX_DEPTH) continue;

      const fromId = methodId(edge.from.file, edge.from.method);
      const toId = methodId(edge.to.file, edge.to.method);

      // Skip if this is a structural-spine edge (already added)
      const edgeKey = `${fromId}->${toId}`;
      if (spineEdgeKeys.has(edgeKey)) {
        continue;
      }

      // Ensure nodes exist
      if (!seen.has(fromId)) {
        seen.add(fromId);
        const fromLineNumber = getLineNumber(edge.from.file, edge.from.method, opts.workspaceRoot);
        nodes.push({
          id: fromId,
          label: edge.from.method,
          file: edge.from.file,
          kind: "symbol",
          badges: edge.kind === "backward" ? ["ast-backward"] : ["ast-forward"],
          line: edge.from.file ? (fromLineNumber ?? 1) : undefined // Fallback to line 1 if file exists but line number is undefined
        });
      }

      if (!seen.has(toId)) {
        seen.add(toId);
        const toLineNumber = getLineNumber(edge.to.file, edge.to.method, opts.workspaceRoot);
        nodes.push({
          id: toId,
          label: edge.to.method,
          file: edge.to.file,
          kind: "symbol",
          badges: edge.kind === "loop" ? ["ast-loop"] : ["ast-forward"],
          line: edge.to.file ? (toLineNumber ?? 1) : undefined // Fallback to line 1 if file exists but line number is undefined
        });
      }

      // Check for duplicate loops
      if (edge.kind === "loop" && loopSet.has(edgeKey)) {
        continue; // Skip duplicate loop
      }
      if (edge.kind === "loop") {
        loopSet.add(edgeKey);
      }

      // Determine confidence based on evidence
      let confidence = 0.4;
      if (edge.evidence.includes("structural-spine")) {
        confidence = 0.55;
      } else if (edge.evidence.includes("p1")) {
        confidence = 0.55;
      } else if (edge.evidence.includes("p2")) {
        confidence = 0.45;
      } else if (edge.kind === "backward") {
        confidence = 0.4; // Backward edges have lower confidence
      } else if (edge.kind === "loop") {
        confidence = 0.35;
      }
      
      // Adjust confidence for cross-file edges (slightly lower)
      if (edge.evidence.includes("cross-file")) {
        confidence = Math.min(confidence, 0.45);
      }

      // Check for duplicate edges before adding
      // All edges become "calls" in the final graph, so use "calls" as the kind
      const duplicateCheckKey = `${fromId}::${toId}::calls`;
      const existingEdgeIndex = existingEdges.get(duplicateCheckKey);
      
      if (existingEdgeIndex !== undefined) {
        // Fetch the already-emitted edge
        const existingEdge = edges[existingEdgeIndex];
        
        // Determine if the new edge is better than the existing one
        const newEdgeHasHigherConfidence = confidence > existingEdge.confidence;
        const newEdgeHasASTEvidence = edge.evidence.some(e => 
          e.includes("ast") || e.includes("structural") || e.includes("p1") || e.includes("p2")
        );
        const existingEdgeHasASTEvidence = existingEdge.evidence?.some(e => 
          e.includes("ast") || e.includes("structural") || e.includes("p1") || e.includes("p2")
        ) || false;
        const newEdgeHasASTButExistingDoesnt = newEdgeHasASTEvidence && !existingEdgeHasASTEvidence;
        
        const newEdgeHasLineData = edge.line !== undefined;
        const existingEdgeHasLineData = existingEdge.line !== undefined;
        const newEdgeHasLineButExistingDoesnt = newEdgeHasLineData && !existingEdgeHasLineData;
        
        const newEdgeHasOrderData = edge.order !== undefined;
        const existingEdgeHasOrderData = existingEdge.order !== undefined;
        const newEdgeHasOrderButExistingDoesnt = newEdgeHasOrderData && !existingEdgeHasOrderData;
        
        // Check if new edge is better: higher confidence, or has AST evidence/line/order data missing from existing
        const shouldReplaceOrMerge = newEdgeHasHigherConfidence || 
          newEdgeHasASTButExistingDoesnt || 
          newEdgeHasLineButExistingDoesnt || 
          newEdgeHasOrderButExistingDoesnt;
        
        if (shouldReplaceOrMerge) {
          // Merge/replace: update priority/confidence and add missing metadata
          const mergedEvidence = new Set(existingEdge.evidence || []);
          edge.evidence.forEach(e => mergedEvidence.add(e));
          
          edges[existingEdgeIndex] = {
            ...existingEdge,
            confidence: Math.max(existingEdge.confidence, confidence),
            evidence: Array.from(mergedEvidence),
            line: existingEdge.line ?? edge.line,
            order: existingEdge.order ?? edge.order,
            originalKind: existingEdge.originalKind,
            label: existingEdge.label ?? edge.label
          };
        }
        // If existing edge is equal-or-better, skip the new edge
        continue;
      }
      
      // Add to existingEdges to prevent future duplicates
      const newEdgeIndex = edges.length;
      existingEdges.set(duplicateCheckKey, newEdgeIndex);

      edges.push({
        from: fromId,
        to: toId,
        kind: "calls",
        confidence,
        evidence: edge.evidence,
        line: edge.line,  // Preserve line number
        order: edge.order,  // Preserve execution order
        label: edge.label
      });
    }

    // Return with metadata (if CompressedGraph interface supports it)
    return { nodes, edges };
  }

  /**
   * Filter out low-connectivity nodes (nodes with only 1-2 edges)
   * Keeps spine nodes and nodes with 3+ edges
   */
  private filterLowConnectivityNodes(
    graph: CompressedGraph,
    spine: Array<{ file: string; method: string }>,
    minEdges: number = 3
  ): CompressedGraph {
    // Build spine node set
    const spineNodeIds = new Set<string>();
    for (const s of spine) {
      const spineId = `method:${s.file}:${s.method}`;
      spineNodeIds.add(spineId);
      // Also try alternative formats
      const altId = `method:${s.file}::${s.method}`;
      spineNodeIds.add(altId);
    }

    // Count edges per node
    const nodeEdgeCount = new Map<string, number>();
    for (const edge of graph.edges) {
      nodeEdgeCount.set(edge.from, (nodeEdgeCount.get(edge.from) || 0) + 1);
      nodeEdgeCount.set(edge.to, (nodeEdgeCount.get(edge.to) || 0) + 1);
    }

    // Identify nodes to keep
    const nodesToKeep = new Set<string>();
    for (const node of graph.nodes) {
      const edgeCount = nodeEdgeCount.get(node.id) || 0;
      const isSpine = spineNodeIds.has(node.id) || 
                     node.badges?.includes('spine');
      
      // Keep spine nodes and nodes with 3+ edges
      if (isSpine || edgeCount >= minEdges) {
        nodesToKeep.add(node.id);
      }
    }

    // Filter nodes and edges
    const filteredNodes = graph.nodes.filter(n => nodesToKeep.has(n.id));
    const filteredEdges = graph.edges.filter(e => 
      nodesToKeep.has(e.from) && nodesToKeep.has(e.to)
    );

    const removedNodes = graph.nodes.length - filteredNodes.length;
    const removedEdges = graph.edges.length - filteredEdges.length;
    
    if (removedNodes > 0 || removedEdges > 0) {
      console.log(`[GraphCompressor] filterLowConnectivityNodes: Removed ${removedNodes} nodes (with < ${minEdges} edges) and ${removedEdges} edges`);
    }

    return { nodes: filteredNodes, edges: filteredEdges };
  }

  /**
   * Identify must-include nodes (spine, entry, error/root nodes)
   */
  private identifyMustIncludeNodes(
    graph: CompressedGraph,
    focus: GraphCompressorInput["focus"]
  ): Set<string> {
    const mustInclude = new Set<string>();

    // Find spine nodes (badges includes 'spine')
    for (const node of graph.nodes) {
      if (node.badges?.includes('spine')) {
        mustInclude.add(node.id);
      }
    }

    // Find entry nodes (check badges or match entrySymbols)
    for (const node of graph.nodes) {
      // Check badges for entry indication
      if (node.badges?.includes('entry') || node.badges?.includes('seed')) {
        mustInclude.add(node.id);
      }
      // Also check if node matches entrySymbols
      if (focus.entrySymbols) {
        for (const entry of focus.entrySymbols) {
          if (entry.id === node.id || 
              (entry.name && (node.label === entry.name || node.label.includes(entry.name)))) {
            mustInclude.add(node.id);
          }
        }
      }
    }

    // Find error/root nodes from focus.errorFrames and focus.entrySymbols
    if (focus.errorFrames) {
      for (const frame of focus.errorFrames) {
        // Try to find nodes in the error file
        for (const node of graph.nodes) {
          if (node.file === frame.file) {
            // If line matches or not specified, include it
            if (!frame.line || node.line === frame.line) {
              mustInclude.add(node.id);
            }
          }
        }
      }
    }

    if (focus.entrySymbols) {
      for (const entry of focus.entrySymbols) {
        if (entry.id) {
          mustInclude.add(entry.id);
          // Also try to match by symbol ID pattern
          for (const node of graph.nodes) {
            const entryIdParts = entry.id.split(':');
            const entryMethodName = entryIdParts.length > 0 ? entryIdParts[entryIdParts.length - 1] : '';
            if (node.id === entry.id || 
                node.id.includes(entryMethodName) ||
                (entry.id.includes(':') && node.id.endsWith(':' + entryMethodName))) {
              mustInclude.add(node.id);
            }
          }
        }
        if (entry.name) {
          // Try to find by name (exact match first, then partial)
          for (const node of graph.nodes) {
            const nodeLabel = node.label || '';
            const entryName = entry.name || '';
            
            // Exact match
            if (nodeLabel === entryName) {
              mustInclude.add(node.id);
              continue;
            }
            
            // Partial match (method name without class prefix)
            if (entryName.includes('.')) {
              const methodName = entryName.split('.').pop() || '';
              if (nodeLabel === methodName || nodeLabel.endsWith('.' + methodName)) {
                mustInclude.add(node.id);
                continue;
              }
            }
            
            // Contains match (for methods like "buildExecutionGraph")
            if (nodeLabel.toLowerCase().includes(entryName.toLowerCase()) || 
                entryName.toLowerCase().includes(nodeLabel.toLowerCase())) {
              mustInclude.add(node.id);
              continue;
            }
          }
        }
      }
    }

    return mustInclude;
  }

  // Constants for noise detection
  private readonly NOISE_NAMES = new Set([
    "log", "warn", "error", "info",
    "slice", "splice", "replace", "stringify", "parseInt", "parseFloat",
    "toString", "valueOf",
    "map", "filter", "reduce", "forEach",
    "setTimeout", "setInterval"
  ]);


  /**
   * Check if a node name is a known noise/built-in function
   */
  private isNoiseName(name: string): boolean {
    return this.NOISE_NAMES.has(name.toLowerCase());
  }

  /**
   * Check if a file path is infrastructure (node_modules, dist, build, etc.)
   */
  private isInfraPath(filePath: string): boolean {
    return (
      filePath.includes("node_modules") ||
      filePath.includes("dist/") ||
      filePath.includes("build/") ||
      filePath.includes("__generated__") ||
      filePath.includes("vendor/") ||
      filePath.endsWith(".d.ts")
    );
  }


  /**
   * Compute in-degree and out-degree for each node
   */
  private computeNodeDegrees(graph: CompressedGraph): Map<string, { in: number; out: number }> {
    const degrees = new Map<string, { in: number; out: number }>();
    
    // Initialize all nodes with 0 degrees
    for (const node of graph.nodes) {
      degrees.set(node.id, { in: 0, out: 0 });
    }
    
    // Count edges
    for (const edge of graph.edges) {
      const fromDegrees = degrees.get(edge.from) || { in: 0, out: 0 };
      fromDegrees.out++;
      degrees.set(edge.from, fromDegrees);
      
      const toDegrees = degrees.get(edge.to) || { in: 0, out: 0 };
      toDegrees.in++;
      degrees.set(edge.to, toDegrees);
    }
    
    return degrees;
  }

  /**
   * Detect utility-shape nodes (get/set/to/from/is/has prefix + utils/helpers/lib path + degree == 1)
   */
  private isUtilityShapeNode(
    node: CompressedNode,
    degrees: Map<string, { in: number; out: number }>
  ): boolean {
    const name = (node.label || '').toLowerCase();
    const nodeDegrees = degrees.get(node.id) || { in: 0, out: 0 };
    const totalDegree = nodeDegrees.in + nodeDegrees.out;
    
    // Check for utility prefixes
    const utilityPrefixes = ['get', 'set', 'to', 'from', 'is', 'has'];
    const hasUtilityPrefix = utilityPrefixes.some(prefix => name.startsWith(prefix));
    
    // Check for utility paths
    const filePath = node.file || '';
    const isUtilityPath = filePath.includes('utils/') || 
                         filePath.includes('helpers/') || 
                         filePath.includes('lib/');
    
    // Utility node: has prefix + utility path + low degree
    return hasUtilityPrefix && isUtilityPath && totalDegree <= 1;
  }

  /**
   * Check if node is must-include
   */
  private isMustIncludeNode(node: CompressedNode, mustIncludeIds: Set<string>): boolean {
    return mustIncludeIds.has(node.id);
  }

  /**
   * Compute depth for each node via BFS from entry nodes
   */
  private computeNodeDepths(graph: CompressedGraph): Map<string, number> {
    const depths = new Map<string, number>();
    const nodeMap = new Map(graph.nodes.map(n => [n.id, n]));
    
    // Find entry nodes (starting points) - check badges or nodes with no incoming edges
    const entryNodes = graph.nodes.filter(n => 
      n.badges?.includes('entry') || n.badges?.includes('seed') || n.badges?.includes('spine')
    );
    if (entryNodes.length === 0) {
      // Fallback: use nodes with no incoming edges or spine nodes
      const hasIncoming = new Set(graph.edges.map(e => e.to));
      entryNodes.push(...graph.nodes.filter(n => 
        !hasIncoming.has(n.id) || n.badges?.includes('spine')
      ));
    }

    // BFS from entry nodes
    const queue: Array<{ id: string; depth: number }> = [];
    const visited = new Set<string>();

    for (const entry of entryNodes) {
      queue.push({ id: entry.id, depth: 0 });
      visited.add(entry.id);
      depths.set(entry.id, 0);
    }

    while (queue.length > 0) {
      const current = queue.shift()!;
      const currentDepth = depths.get(current.id) || current.depth;

      // Find outgoing edges
      for (const edge of graph.edges) {
        if (edge.from === current.id) {
          const neighborId = edge.to;
          if (!visited.has(neighborId)) {
            visited.add(neighborId);
            const neighborDepth = currentDepth + 1;
            depths.set(neighborId, neighborDepth);
            queue.push({ id: neighborId, depth: neighborDepth });
          } else {
            // Update if found shorter path
            const existingDepth = depths.get(neighborId) || Infinity;
            if (currentDepth + 1 < existingDepth) {
              depths.set(neighborId, currentDepth + 1);
            }
          }
        }
      }
    }

    // Set depth 0 for unvisited nodes (isolated)
    for (const node of graph.nodes) {
      if (!depths.has(node.id)) {
        depths.set(node.id, 0);
      }
    }

    return depths;
  }

  /**
   * Score nodes by importance (base score + edge-based score)
   */
  private scoreNodesByImportance(
    graph: CompressedGraph,
    focus: GraphCompressorInput["focus"],
    nodeDepths: Map<string, number>
  ): Map<string, number> {
    const scores = new Map<string, number>();
    const nodeMap = new Map(graph.nodes.map(n => [n.id, n]));
    
    // Compute node degrees for utility-shape detection
    const nodeDegrees = this.computeNodeDegrees(graph);
    
    // Get error file if available
    const errorFile = focus.errorFrames?.[0]?.file;

    // Step 1: Base scores (self signals)
    for (const node of graph.nodes) {
      let baseScore = 1; // Base value

      if (node.badges?.includes('spine')) {
        baseScore += 10;
      }
      // Check if node is an entry node (via badges or entrySymbols match)
      if (node.badges?.includes('entry') || node.badges?.includes('seed')) {
        baseScore += 6;
      } else if (focus.entrySymbols?.some(e => {
        return e.id === node.id || (e.name && (node.label === e.name || node.label.includes(e.name)));
      })) {
        baseScore += 6;
      }
      // Check if node is in error file
      if (errorFile && node.file === errorFile) {
        baseScore += 4;
      }
      // Check if node is an error/root node (heuristic: entry symbols or error frames)
      if (focus.entrySymbols?.some(e => {
        if (e.id === node.id) return true;
        if (e.name && (node.label === e.name || node.label.includes(e.name))) return true;
        return false;
      }) || focus.errorFrames?.some(f => f.file === node.file)) {
        baseScore += 12;
      }

      // Utility-shape penalty: -3 if utility-shape node
      if (this.isUtilityShapeNode(node, nodeDegrees)) {
        baseScore -= 3;
      }

      scores.set(node.id, baseScore);
    }

    // Step 2: Edge-based scores (relational, with caps)
    // Count edges per neighbor pair for fan-out capping
    const edgeCountPerNeighbor = new Map<string, Map<string, number>>();
    
    for (const edge of graph.edges) {
      const from = edge.from;
      const to = edge.to;
      
      if (!edgeCountPerNeighbor.has(from)) {
        edgeCountPerNeighbor.set(from, new Map());
      }
      const neighborCounts = edgeCountPerNeighbor.get(from)!;
      neighborCounts.set(to, (neighborCounts.get(to) || 0) + 1);
    }

    // Add edge-based scores for outgoing edges (per neighbor, with caps)
    const processedNeighbors = new Map<string, Set<string>>(); // from -> Set<to> (to track which neighbors we've already scored)
    
    for (const edge of graph.edges) {
      const fromNode = nodeMap.get(edge.from);
      const toNode = nodeMap.get(edge.to);
      
      if (!fromNode || !toNode) continue;

      // Track which neighbors we've processed for this node
      if (!processedNeighbors.has(edge.from)) {
        processedNeighbors.set(edge.from, new Set());
      }
      const neighborsProcessed = processedNeighbors.get(edge.from)!;
      
      // Only process each unique neighbor once (use count for capping)
      if (neighborsProcessed.has(edge.to)) {
        continue; // Already processed this neighbor
      }
      neighborsProcessed.add(edge.to);

      const neighborCounts = edgeCountPerNeighbor.get(edge.from);
      const countToThisNeighbor = neighborCounts?.get(edge.to) || 1;

      // Determine weight and cap based on neighbor type
      let weight = 1.0;
      let cap = 3;
      
      if (toNode.badges?.includes('spine')) {
        weight = 3.0;
        cap = 3;
      } else if (toNode.badges?.includes('entry') || toNode.badges?.includes('seed') || 
                 focus.entrySymbols?.some(e => {
                   return e.id === toNode.id || (e.name && (toNode.label === e.name || toNode.label.includes(e.name)));
                 })) {
        weight = 2.0;
        cap = 2;
      } else {
        const depth = nodeDepths.get(edge.to) || 0;
        if (depth >= 5) {
          weight = 1.5;
        }
      }

      // Add score with cap
      const cappedCount = Math.min(countToThisNeighbor, cap);
      scores.set(edge.from, (scores.get(edge.from) || 0) + cappedCount * weight);
    }

    // Add edge-based scores for incoming edges (being called is valuable)
    for (const edge of graph.edges) {
      scores.set(edge.to, (scores.get(edge.to) || 0) + 0.5);
    }

    return scores;
  }

  /**
   * Build simple graph with top N nodes, ensuring must-include nodes and connectivity
   */
  private buildSimpleGraph(
    graph: CompressedGraph,
    mustIncludeIds: Set<string>,
    focus: GraphCompressorInput["focus"],
    topN: number
  ): CompressedGraph['nodes'] extends Array<infer T> ? { nodes: T[]; edges: CompressedEdge[]; meta: { source: "auto-pruned"; totalOriginalNodes: number } } : never {
    // Clamp topN to 10-20
    const targetSize = Math.max(10, Math.min(20, topN));
    const originalNodeCount = graph.nodes.length;

    // Compute depths if needed
    const nodeDepths = this.computeNodeDepths(graph);

    // Score all nodes
    const scores = this.scoreNodesByImportance(graph, focus, nodeDepths);

    // Step 1: Always include must-include nodes
    const selectedNodes = new Set<string>(mustIncludeIds);

    // Step 2: Compute node degrees and identify bridge nodes
    const nodeDegrees = this.computeNodeDegrees(graph);
    const nodeMap = new Map(graph.nodes.map(n => [n.id, n]));
    const edgeMap = new Map<string, Set<string>>(); // from -> Set<to>
    
    for (const edge of graph.edges) {
      if (!edgeMap.has(edge.from)) {
        edgeMap.set(edge.from, new Set());
      }
      edgeMap.get(edge.from)!.add(edge.to);
    }

    // Identify bridge nodes (nodes on paths between must-include nodes)
    const bridgeNodes = new Set<string>();
    const mustIncludeList = Array.from(mustIncludeIds);
    for (let i = 0; i < mustIncludeList.length; i++) {
      for (let j = i + 1; j < mustIncludeList.length; j++) {
        const fromId = mustIncludeList[i];
        const toId = mustIncludeList[j];
        const path = this.findShortestPath(fromId, toId, edgeMap);
        if (path) {
          // Mark intermediate nodes as bridge nodes (skip start and end)
          for (let k = 1; k < path.length - 1; k++) {
            bridgeNodes.add(path[k]);
          }
        }
      }
    }

    // Step 3: Apply enhanced filtering pipeline when selecting top-scored nodes
    const MIN_NAME_LENGTH = 5;
    let noiseFilteredCount = 0;
    let infraFilteredCount = 0;
    let shortNameFilteredCount = 0;

    const nodesByScore = Array.from(graph.nodes)
      .filter(n => !selectedNodes.has(n.id))
      .filter(n => {
        // Keep if must-include
        if (this.isMustIncludeNode(n, mustIncludeIds)) return true;
        
        // Keep if bridge node (connectivity-preserving)
        if (bridgeNodes.has(n.id)) return true;
        
        // Drop if noise name
        const nodeLabel = n.label || '';
        if (this.isNoiseName(nodeLabel)) {
          noiseFilteredCount++;
          return false;
        }
        
        // Drop if infra path
        if (n.file && this.isInfraPath(n.file)) {
          infraFilteredCount++;
          return false;
        }
        
        // Drop if short name (unless bridge)
        if (nodeLabel.length < MIN_NAME_LENGTH) {
          shortNameFilteredCount++;
          return false;
        }
        
        // Keep if high degree (>= 5)
        const degrees = nodeDegrees.get(n.id) || { in: 0, out: 0 };
        if (degrees.in + degrees.out >= 5) return true;
        
        // Keep otherwise (will be filtered by score)
        return true;
      })
      .sort((a, b) => {
        const scoreA = scores.get(a.id) || 0;
        const scoreB = scores.get(b.id) || 0;
        return scoreB - scoreA; // Descending
      });

    // Step 4: Fill remaining slots with top-scored nodes
    const remainingSlots = Math.max(0, targetSize - selectedNodes.size);
    for (let i = 0; i < remainingSlots && i < nodesByScore.length; i++) {
      selectedNodes.add(nodesByScore[i].id);
    }
    
    // Also add bridge nodes that weren't selected (preserve connectivity)
    for (const bridgeId of bridgeNodes) {
      if (!selectedNodes.has(bridgeId)) {
        selectedNodes.add(bridgeId);
      }
    }

    // Step 5: Remove isolated nodes (no in/out edges) except must-include and bridge nodes
    const nodesToKeep = new Set<string>(selectedNodes);
    const hasIncoming = new Set<string>();
    const hasOutgoing = new Set<string>();

    for (const edge of graph.edges) {
      if (selectedNodes.has(edge.from) && selectedNodes.has(edge.to)) {
        hasOutgoing.add(edge.from);
        hasIncoming.add(edge.to);
      }
    }

    // Remove isolated nodes except must-include and bridge nodes
    for (const nodeId of selectedNodes) {
      if (!mustIncludeIds.has(nodeId) && !bridgeNodes.has(nodeId)) {
        const hasConnections = hasIncoming.has(nodeId) || hasOutgoing.has(nodeId);
        if (!hasConnections) {
          nodesToKeep.delete(nodeId);
        }
      }
    }

    // Step 6: Create subgraph
    let filteredNodes = graph.nodes.filter(n => nodesToKeep.has(n.id));
    
    // Ensure connectivity: add edges between selected nodes
    // IMPORTANT: Filter edges first, then we'll add connectivity edges for must-include nodes
    let filteredEdges = graph.edges.filter(e => {
      const fromExists = nodesToKeep.has(e.from);
      const toExists = nodesToKeep.has(e.to);
      return fromExists && toExists;
    });
    
    // Log for debugging
    if (filteredEdges.length === 0 && graph.edges.length > 0) {
      console.log(`[GraphCompressor.buildSimpleGraph] Warning: No edges after filtering. Graph has ${graph.edges.length} edges, nodesToKeep has ${nodesToKeep.size} nodes`);
      // Show sample of what's missing
      const sampleEdges = graph.edges.slice(0, 5);
      const sampleNodes = Array.from(nodesToKeep).slice(0, 5);
      console.log(`[GraphCompressor.buildSimpleGraph] Sample edges:`, sampleEdges.map(e => `${e.from} -> ${e.to}`));
      console.log(`[GraphCompressor.buildSimpleGraph] Sample selected nodes:`, sampleNodes);
      console.log(`[GraphCompressor.buildSimpleGraph] Sample edge endpoints match:`, sampleEdges.map(e => ({
        from: e.from,
        fromMatch: nodesToKeep.has(e.from),
        to: e.to,
        toMatch: nodesToKeep.has(e.to)
      })));
    }
    
    // If we have must-include nodes, ensure there are edges connecting them
    // Reuse the edgeMap built earlier in Step 2
    if (mustIncludeIds.size > 1) {
      const mustIncludeList = Array.from(mustIncludeIds);
      const filteredEdgeSet = new Set(filteredEdges.map(e => `${e.from}->${e.to}`));
      
      for (let i = 0; i < mustIncludeList.length; i++) {
        for (let j = 0; j < mustIncludeList.length; j++) {
          if (i === j) continue;
          
          const fromId = mustIncludeList[i];
          const toId = mustIncludeList[j];
          
          // Only add edges if both nodes are in the filtered set
          if (!nodesToKeep.has(fromId) || !nodesToKeep.has(toId)) continue;
          
          // Check if there's already an edge
          const edgeKey = `${fromId}->${toId}`;
          if (filteredEdgeSet.has(edgeKey)) continue;
          
          // Try to find a direct edge in the original graph
          const directEdge = graph.edges.find(e => 
            e.from === fromId && e.to === toId
          );
          
          if (directEdge) {
            filteredEdges.push(directEdge);
            filteredEdgeSet.add(edgeKey);
          } else {
            // Check if there's a path through the graph (via edgeMap from Step 2)
            const path = this.findShortestPath(fromId, toId, edgeMap);
            if (path && path.length > 1 && path.length <= 4) {
              // If there's a path (up to 3 hops), include intermediate nodes and edges
              for (let k = 0; k < path.length; k++) {
                const pathNodeId = path[k];
                // Include intermediate nodes in the graph if they're in the original graph
                if (!nodesToKeep.has(pathNodeId) && nodeMap.has(pathNodeId)) {
                  nodesToKeep.add(pathNodeId);
                  filteredNodes.push(nodeMap.get(pathNodeId)!);
                }
              }
              
              // Add all edges along that path
              for (let k = 0; k < path.length - 1; k++) {
                const pathFrom = path[k];
                const pathTo = path[k + 1];
                const pathEdgeKey = `${pathFrom}->${pathTo}`;
                
                if (!filteredEdgeSet.has(pathEdgeKey)) {
                  const pathEdge = graph.edges.find(e => e.from === pathFrom && e.to === pathTo);
                  if (pathEdge) {
                    filteredEdges.push(pathEdge);
                    filteredEdgeSet.add(pathEdgeKey);
                  }
                }
              }
            }
          }
        }
      }
      
      // Update filteredNodes to include any newly added intermediate nodes
      const updatedFilteredNodes = graph.nodes.filter(n => nodesToKeep.has(n.id));
      // Replace filteredNodes if we added intermediate nodes
      if (updatedFilteredNodes.length > filteredNodes.length) {
        filteredNodes.length = 0;
        filteredNodes.push(...updatedFilteredNodes);
      }
    }

    // Calculate total filtered count
    const totalFilteredCount = originalNodeCount - filteredNodes.length;

    return {
      nodes: filteredNodes,
      edges: filteredEdges,
      meta: {
        source: "auto-pruned" as const,
        totalOriginalNodes: originalNodeCount,
        filteredCount: totalFilteredCount,
        noiseFilteredCount: noiseFilteredCount,
        infraFilteredCount: infraFilteredCount,
        shortNameFilteredCount: shortNameFilteredCount
      }
    } as any;
  }

  /**
   * Helper: Find shortest path between two nodes using BFS
   */
  private findShortestPath(
    fromId: string,
    toId: string,
    edgeMap: Map<string, Set<string>>
  ): string[] | null {
    const visited = new Set<string>();
    const queue: Array<{ id: string; path: string[] }> = [{ id: fromId, path: [fromId] }];
    visited.add(fromId);

    while (queue.length > 0) {
      const current = queue.shift()!;
      
      if (current.id === toId) {
        return current.path;
      }

      const neighbors = edgeMap.get(current.id) || new Set();
      for (const neighbor of neighbors) {
        if (!visited.has(neighbor)) {
          visited.add(neighbor);
          queue.push({ id: neighbor, path: [...current.path, neighbor] });
        }
      }
    }

    return null;
  }


  /**
   * Build minimal spine graph from coarse path (fallback)
   */
  private buildMinimalSpineGraphFromCoarsePath(
    coarsePath: {
      files: string[];
      methods?: string[];
    },
    focus: GraphCompressorInput["focus"]
  ): CompressedGraph {
    const nodes: CompressedNode[] = [];
    const edges: CompressedEdge[] = [];

    // Add nodes for files
    for (const file of coarsePath.files.slice(0, 4)) {
      nodes.push({
        id: `file:${file}`,
        label: path.basename(file),
        file: file,
        kind: "file"
      });
    }

    // Add nodes for methods if available
    if (coarsePath.methods) {
      for (const method of coarsePath.methods.slice(0, 5)) {
        nodes.push({
          id: `method:${method}`,
          label: method,
          kind: "symbol"
        });
      }
    }

    // Connect files in order
    for (let i = 0; i < nodes.length - 1; i++) {
      if (nodes[i].kind === "file" && nodes[i + 1]?.kind === "file") {
        edges.push({
          from: nodes[i].id,
          to: nodes[i + 1].id,
          kind: "logical",
          confidence: 0.3,
          evidence: ["coarse-path-fallback"]
        });
      }
    }

    // Connect entry symbols if available
    if (focus.entrySymbols) {
      for (const entry of focus.entrySymbols) {
        if (entry.name) {
          const entryNode = nodes.find(n => n.label === entry.name || n.label.endsWith(`.${entry.name}`));
          if (entryNode && nodes.length > 1) {
            // Connect to first file node
            const firstFileNode = nodes.find(n => n.kind === "file");
            if (firstFileNode && entryNode.id !== firstFileNode.id) {
              edges.push({
                from: entryNode.id,
                to: firstFileNode.id,
                kind: "logical",
                confidence: 0.3,
                evidence: ["entry-fallback"]
              });
            }
          }
        }
      }
    }

    return { nodes, edges };
  }

  /**
   * Helper to create consistent method keys (file::method format)
   */
  private methodKey(file: string | undefined, name: string): string {
    return `${file ?? "unknown"}::${name}`;
  }

  /**
   * Find tsconfig.json path with enhanced detection including child directories
   * Returns config path and reason for logging
   */
  private findTsConfigPath(workspaceRoot: string, entryPaths: string[] = []): { configPath?: string; reason: string } {
    // Check cache first
    const cacheKey = `${workspaceRoot}:${entryPaths.join(',')}`;
    if (this.configPathCache.has(cacheKey)) {
      return this.configPathCache.get(cacheKey)!;
    }

    // 1. Nearest-first heuristic: Try same directory as each entry file first
    for (const entryPath of entryPaths) {
      if (entryPath) {
        const entryDir = path.dirname(entryPath);
        const configs = ['tsconfig.json', 'jsconfig.json', 'tsconfig.app.json', 'tsconfig.build.json'];
        for (const configName of configs) {
          const candidate = path.join(entryDir, configName);
          if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) {
            const result = { configPath: candidate, reason: `nearest to ${entryPath}` };
            this.configPathCache.set(cacheKey, result);
            return result;
          }
        }
        
        // Check parent subdirs (e.g., if entry is in src/, check parent/tsconfig.json)
        let current = entryDir;
        for (let i = 0; i < 3; i++) {
          const parent = path.dirname(current);
          if (parent === current) break;
          for (const configName of configs) {
            const candidate = path.join(parent, configName);
            if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) {
              const result = { configPath: candidate, reason: `found in parent directory of ${entryPath}` };
              this.configPathCache.set(cacheKey, result);
              return result;
            }
          }
          current = parent;
        }
      }
    }

    // 2. Use TypeScript's own resolver to walk up from workspace root
    const tsConfigPath = ts.findConfigFile(workspaceRoot, ts.sys.fileExists, 'tsconfig.json');
    const jsConfigPath = ts.findConfigFile(workspaceRoot, ts.sys.fileExists, 'jsconfig.json');
    
    if (tsConfigPath) {
      // Check if it's a solution-style config with references
      if (this.isSolutionWithReferences(tsConfigPath)) {
        const referencedProject = this.pickReferencedProject(tsConfigPath, entryPaths);
        if (referencedProject) {
          const result = { configPath: referencedProject, reason: 'matched referenced project' };
          this.configPathCache.set(cacheKey, result);
          return result;
        }
      }
      const result = { configPath: tsConfigPath, reason: 'found via TS resolver from workspaceRoot' };
      this.configPathCache.set(cacheKey, result);
      return result;
    }
    
    if (jsConfigPath) {
      const result = { configPath: jsConfigPath, reason: 'found jsconfig.json via TS resolver' };
      this.configPathCache.set(cacheKey, result);
      return result;
    }

    // 3. Check workspace root directly
    const configs = ['tsconfig.json', 'jsconfig.json', 'tsconfig.app.json', 'tsconfig.build.json'];
    for (const configName of configs) {
      const candidate = path.join(workspaceRoot, configName);
      if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) {
        const result = { configPath: candidate, reason: `found ${configName} at workspace root` };
        this.configPathCache.set(cacheKey, result);
        return result;
      }
    }

    // 4. Child directory fallback: If workspace root has package.json but no tsconfig.json,
    // check common subdirs (monorepo patterns)
    const hasPackageJson = fs.existsSync(path.join(workspaceRoot, 'package.json'));
    if (hasPackageJson) {
      const childConfig = this.checkChildDirectories(workspaceRoot, entryPaths);
      if (childConfig) {
        this.configPathCache.set(cacheKey, childConfig);
        return childConfig;
      }
      
      const monorepoConfig = this.scanLikelySubdirs(workspaceRoot, entryPaths);
      if (monorepoConfig) {
        this.configPathCache.set(cacheKey, monorepoConfig);
        return monorepoConfig;
      }
    }

    // 5. No config found
    const result = { configPath: undefined, reason: 'none found; using allowJs fallback' };
    this.configPathCache.set(cacheKey, result);
    return result;
  }

  /**
   * Check if tsconfig.json is a solution-style config with references
   */
  private isSolutionWithReferences(configPath: string): boolean {
    try {
      const content = fs.readFileSync(configPath, 'utf8');
      const config = JSON.parse(content);
      return Array.isArray(config.references) && config.references.length > 0;
    } catch {
      return false;
    }
  }

  /**
   * Pick the referenced project that contains the entry files
   */
  private pickReferencedProject(configPath: string, entryPaths: string[]): string | undefined {
    try {
      const content = fs.readFileSync(configPath, 'utf8');
      const config = JSON.parse(content);
      if (!Array.isArray(config.references)) return undefined;

      const configDir = path.dirname(configPath);
      
      for (const ref of config.references) {
        if (typeof ref === 'object' && ref.path) {
          const refPath = path.resolve(configDir, ref.path);
          const refConfigPath = path.join(refPath, 'tsconfig.json');
          
          if (fs.existsSync(refConfigPath)) {
            // Check if any entry files are in this referenced project
            for (const entryPath of entryPaths) {
              if (entryPath && entryPath.startsWith(refPath)) {
                return refConfigPath;
              }
            }
            
            // If no entry paths, check if this is the first referenced project
            // (heuristic for monorepos)
            if (entryPaths.length === 0) {
              return refConfigPath;
            }
          }
        }
      }
    } catch {
      // Ignore parse errors
    }
    return undefined;
  }

  /**
   * Scan common monorepo subdirectories for tsconfig.json
   */
  private scanLikelySubdirs(workspaceRoot: string, entryPaths: string[]): { configPath?: string; reason: string } | undefined {
    const commonPatterns = ['apps', 'packages', 'lib', 'src'];
    
    for (const entryPath of entryPaths) {
      if (!entryPath) continue;
      
      // Check if entry path contains common monorepo patterns
      for (const pattern of commonPatterns) {
        const patternIndex = entryPath.indexOf(path.sep + pattern + path.sep);
        if (patternIndex !== -1) {
          // Extract the path up to and including the pattern
          const subPath = entryPath.substring(0, patternIndex + pattern.length + 1);
          const configs = ['tsconfig.json', 'jsconfig.json'];
          for (const configName of configs) {
            const candidate = path.join(subPath, configName);
            if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) {
              return { configPath: candidate, reason: `found in ${pattern} subdirectory` };
            }
          }
        }
      }
    }
    
    return undefined;
  }

  /**
   * Check child directories of workspace root for tsconfig.json
   * Especially useful when workspace root has package.json but no tsconfig.json
   */
  private checkChildDirectories(workspaceRoot: string, entryPaths: string[]): { configPath?: string; reason: string } | undefined {
    try {
      const entries = fs.readdirSync(workspaceRoot, { withFileTypes: true });
      const configs = ['tsconfig.json', 'jsconfig.json'];
      
      // First, check directories that contain entry files
      for (const entryPath of entryPaths) {
        if (!entryPath) continue;
        try {
          const relativePath = path.relative(workspaceRoot, entryPath);
          const firstSegment = relativePath.split(path.sep)[0];
          if (firstSegment && firstSegment !== '..' && firstSegment !== '.') {
            const childDir = path.join(workspaceRoot, firstSegment);
            if (fs.existsSync(childDir) && fs.statSync(childDir).isDirectory()) {
              for (const configName of configs) {
                const candidate = path.join(childDir, configName);
                if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) {
                  return { configPath: candidate, reason: `found in child directory containing entry files` };
                }
              }
            }
          }
        } catch {
          // Ignore errors for individual entry paths
        }
      }
      
      // Then check all direct child directories (limited to avoid performance issues)
      const checkedDirs = new Set<string>();
      for (const entry of entries) {
        if (entry.isDirectory() && !entry.name.startsWith('.') && entry.name !== 'node_modules') {
          checkedDirs.add(entry.name);
          if (checkedDirs.size > 10) break; // Limit to avoid checking too many dirs
          
          const childDir = path.join(workspaceRoot, entry.name);
          for (const configName of configs) {
            const candidate = path.join(childDir, configName);
            if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) {
              return { configPath: candidate, reason: `found in child directory ${entry.name}` };
            }
          }
        }
      }
    } catch {
      // Ignore errors
    }
    
    return undefined;
  }

  /**
   * Initialize ts-morph Project for TypeScript analysis
   * Reuses project instance if already initialized
   */
  private initializeTsMorphProject(workspaceRoot: string, entryPaths: string[] = []): Project {
    if (this.tsMorphProject && this.workspaceRoot === workspaceRoot) {
      return this.tsMorphProject;
    }

    // Clear cache if workspace root changed
    if (this.workspaceRoot && this.workspaceRoot !== workspaceRoot) {
      this.configPathCache.clear();
    }

    // Find tsconfig.json path with enhanced detection
    const { configPath, reason } = this.findTsConfigPath(workspaceRoot, entryPaths);
    
    if (configPath) {
      console.log(`[GraphCompressor] Found tsconfig: ${configPath} (${reason})`);
    } else {
      console.log(`[GraphCompressor] No tsconfig found (${reason}), using fallback compiler options`);
    }

    try {
      const project = new Project({
        tsConfigFilePath: configPath,
        skipAddingFilesFromTsConfig: !configPath,
        skipFileDependencyResolution: false,
        skipLoadingLibFiles: false,
        compilerOptions: configPath ? undefined : {
          allowJs: true,
          checkJs: false,
          skipLibCheck: true,
          target: ts.ScriptTarget.ES2020,
          module: ts.ModuleKind.ESNext,
          moduleResolution: ts.ModuleResolutionKind.NodeNext,
          jsx: ts.JsxEmit.ReactJSX,
        }
      });

      this.tsMorphProject = project;
      this.workspaceRoot = workspaceRoot;
      this.processedFiles.clear(); // Reset processed files cache
      
      return project;
    } catch (error) {
      console.warn(`[GraphCompressor] Failed to initialize ts-morph project:`, error);
      // Try fallback: create project without tsconfig
      const project = new Project({
        compilerOptions: {
          allowJs: true,
          checkJs: false,
          skipLibCheck: true,
          target: ts.ScriptTarget.ES2020,
          module: ts.ModuleKind.ESNext,
          moduleResolution: ts.ModuleResolutionKind.NodeNext,
          jsx: ts.JsxEmit.ReactJSX,
        }
      });
      
      this.tsMorphProject = project;
      this.workspaceRoot = workspaceRoot;
      return project;
    }
  }

  /**
   * Get or create ts-morph Project instance
   */
  public getOrCreateTsMorphProject(workspaceRoot: string, entryPaths: string[] = []): Project {
    if (!this.tsMorphProject || this.workspaceRoot !== workspaceRoot) {
      return this.initializeTsMorphProject(workspaceRoot, entryPaths);
    }
    return this.tsMorphProject;
  }

  private isTypeScriptLibFile(sourceFile: SourceFile | undefined): boolean {
    if (!sourceFile || !sourceFile.isDeclarationFile()) {
      return false;
    }
    const normalized = sourceFile.getFilePath().replace(/\\/g, '/');
    if (normalized.includes('/node_modules/typescript/lib/')) {
      return true;
    }
    return /\/lib\.[^/]+\.d\.ts$/i.test(normalized);
  }

  private isTypeScriptLibSymbol(symbol: TsMorphSymbol | undefined): boolean {
    if (!symbol) {
      return false;
    }
    const declarations = symbol.getDeclarations();
    if (!declarations || declarations.length === 0) {
      return false;
    }
    return declarations.every((decl) => this.isTypeScriptLibFile(decl.getSourceFile()));
  }

  private isBuiltInTsType(type: TsMorphType | undefined): boolean {
    if (!type) {
      return false;
    }

    if (type.isUnion()) {
      const unionTypes = type.getUnionTypes();
      let hasBuiltIn = false;
      for (const unionType of unionTypes) {
        if (this.isBuiltInTsType(unionType)) {
          hasBuiltIn = true;
          continue;
        }
        const unionFlags = unionType.getFlags();
        const isNullable =
          (unionFlags & ts.TypeFlags.Null) !== 0 ||
          (unionFlags & ts.TypeFlags.Undefined) !== 0 ||
          (unionFlags & ts.TypeFlags.VoidLike) !== 0;
        if (!isNullable) {
          return false;
        }
      }
      return hasBuiltIn;
    }

    const flags = type.getFlags();
    if (
      (flags & ts.TypeFlags.StringLike) !== 0 ||
      (flags & ts.TypeFlags.NumberLike) !== 0 ||
      (flags & ts.TypeFlags.BooleanLike) !== 0 ||
      (flags & ts.TypeFlags.BigIntLike) !== 0 ||
      (flags & ts.TypeFlags.ESSymbolLike) !== 0
    ) {
      return true;
    }

    const symbol = type.getSymbol();
    if (symbol) {
      if (GraphCompressor.BUILTIN_BASE_IDENTIFIERS.has(symbol.getName())) {
        return true;
      }
      if (this.isTypeScriptLibSymbol(symbol)) {
        return true;
      }
    }

    const typeText = type.getText(undefined, ts.TypeFormatFlags.UseFullyQualifiedType);
    if (!typeText) {
      return false;
    }

    const normalized = typeText.replace(/\s+/g, '');
    if (/^string(\[\])?$/i.test(normalized)) {
      return true;
    }
    if (/^(?:Array|ReadonlyArray)<.*>$/.test(normalized)) {
      return true;
    }
    if (normalized.endsWith('[]')) {
      return true;
    }

    return false;
  }

  private isBuiltInPrototypeCall(callExpr: CallExpression, typeChecker: TypeChecker): boolean {
    const callee = callExpr.getExpression();
    if (!Node.isPropertyAccessExpression(callee) && !Node.isElementAccessExpression(callee)) {
      return false;
    }

    let methodName: string | undefined;
    let nameNode: Node | undefined;
    if (Node.isPropertyAccessExpression(callee)) {
      methodName = callee.getName();
      nameNode = callee.getNameNode();
    } else {
      const arg = callee.getArgumentExpression();
      if (Node.isStringLiteral(arg) || Node.isNumericLiteral(arg)) {
        methodName = arg.getText().replace(/['"]/g, '');
        nameNode = arg;
      }
    }

    if (!methodName) {
      return false;
    }

    try {
      const symbol = nameNode ? typeChecker.getSymbolAtLocation(nameNode) : undefined;
      if (this.isTypeScriptLibSymbol(symbol)) {
        return true;
      }
    } catch {
      // best-effort only
    }

    try {
      const targetExpression = Node.isPropertyAccessExpression(callee)
        ? callee.getExpression()
        : callee.getExpression();
      const targetType = typeChecker.getTypeAtLocation(targetExpression);
      if (this.isBuiltInTsType(targetType) && GraphCompressor.BUILTIN_METHOD_NAMES.has(methodName)) {
        return true;
      }
    } catch {
      // ignore type resolution errors
    }

    if (Node.isPropertyAccessExpression(callee)) {
      const baseText = callee.getExpression().getText();
      if (GraphCompressor.BUILTIN_BASE_IDENTIFIERS.has(baseText) && GraphCompressor.BUILTIN_METHOD_NAMES.has(methodName)) {
        return true;
      }
    }

    return false;
  }

  private shouldSkipBuiltInMemberFromBabel(methodName: string, fullExpression?: string): boolean {
    if (!fullExpression || !GraphCompressor.BUILTIN_METHOD_NAMES.has(methodName)) {
      return false;
    }

    const parts = fullExpression.split('.');
    if (parts.length < 2) {
      return false;
    }

    const firstBase = parts[0];
    const lastBase = parts[parts.length - 2] || parts[0];
    const literalRegex = /^(['"`].*['"`]|\d+(\.\d+)?|0x[\da-f]+)$/i;

    if (GraphCompressor.BUILTIN_BASE_IDENTIFIERS.has(firstBase) || GraphCompressor.BUILTIN_BASE_IDENTIFIERS.has(lastBase)) {
      return true;
    }

    if (literalRegex.test(firstBase) || literalRegex.test(lastBase)) {
      return true;
    }

    const immediateBase = lastBase || firstBase;
    if (immediateBase === 'this' || immediateBase === 'super') {
      return true;
    }

    if (/^[a-z_][a-z0-9_$]*$/i.test(immediateBase)) {
      const firstChar = immediateBase.charAt(0);
      if (firstChar === firstChar.toLowerCase()) {
        return true;
      }
    }

    return false;
  }

  private resolveSymbolMetadata(symbol: TsMorphSymbol | undefined, filePath: string): {
    targetFile?: string;
    fullPath?: string;
  } {
    const result: { targetFile?: string; fullPath?: string } = {};
    if (!symbol) {
      return result;
    }

    const declarations = symbol.getDeclarations();
    if (declarations && declarations.length > 0) {
      const decl = declarations[0];
      const declFile = decl.getSourceFile();
      if (declFile) {
        const declPath = declFile.getFilePath();
        if (declPath && declPath !== filePath) {
          result.targetFile = declPath;
        }
      }
    }

    try {
      const fullyQualified = symbol.getFullyQualifiedName();
      if (fullyQualified) {
        result.fullPath = fullyQualified;
      }
    } catch {
      // Ignore qualified name failures
    }

    return result;
  }

  private extractCallInfoFromExpression(
    callExpr: CallExpression,
    typeChecker: TypeChecker,
    filePath: string,
    skipBuiltIns: Set<string>
  ): {
    name: string;
    fullExpression?: string;
    isMethodCall: boolean;
    line: number;
    targetFile?: string;
    fullPath?: string;
    edgeLabel?: string;
  } | null {
    const line = callExpr.getStartLineNumber();
    const expression = callExpr.getExpression();
    let callName: string | null = null;
    let fullExpression: string | null = null;
    let isMethodCall = false;
    let targetFile: string | undefined;
    let fullPath: string | undefined;
    const edgeLabel = this._normalizeSmartEdgeLabel(this._getSmartEdgeLabel(callExpr));

    if (Node.isIdentifier(expression)) {
      callName = expression.getText();
      fullExpression = callName;

      if (skipBuiltIns.has(callName)) {
        return null;
      }

      try {
        const symbol = typeChecker.getSymbolAtLocation(expression);
        const metadata = this.resolveSymbolMetadata(symbol, filePath);
        targetFile = metadata.targetFile;
        fullPath = metadata.fullPath;
      } catch {
        // ignore resolution issues
      }
    } else if (Node.isPropertyAccessExpression(expression) || Node.isElementAccessExpression(expression)) {
      isMethodCall = true;

      if (Node.isPropertyAccessExpression(expression)) {
        callName = expression.getName();
        const objText = expression.getExpression().getText();
        fullExpression = `${objText}.${callName}`;
      } else {
        const arg = expression.getArgumentExpression();
        if (Node.isStringLiteral(arg) || Node.isNumericLiteral(arg)) {
          callName = arg.getText().replace(/['"]/g, '');
          const objText = expression.getExpression().getText();
          fullExpression = `${objText}[${arg.getText()}]`;
        } else {
          return null;
        }
      }

      if (!callName) {
        return null;
      }

      if (this.isBuiltInPrototypeCall(callExpr, typeChecker)) {
        return null;
      }

      let symbol: TsMorphSymbol | undefined;
      try {
        symbol = typeChecker.getSymbolAtLocation(expression);
      } catch {
        // ignore
      }

      if (!symbol && Node.isPropertyAccessExpression(expression)) {
        try {
          symbol = typeChecker.getSymbolAtLocation(expression.getNameNode());
        } catch {
          // ignore
        }
      }

      if (!symbol && Node.isElementAccessExpression(expression)) {
        const arg = expression.getArgumentExpression();
        if (arg) {
          try {
            symbol = typeChecker.getSymbolAtLocation(arg);
          } catch {
            // ignore
          }
        }
      }

      const metadata = this.resolveSymbolMetadata(symbol, filePath);
      targetFile = metadata.targetFile;
      fullPath = metadata.fullPath;
    } else {
      return null;
    }

    if (!callName) {
      return null;
    }

    return {
      name: callName,
      fullExpression: fullExpression || callName,
      isMethodCall,
      line,
      targetFile,
      fullPath,
      edgeLabel
    };
  }

  /**
   * Generates a clean, readable edge label based on a "smart parameter" heuristic.
   * @param callExpr The ts-morph CallExpression node.
   * @returns A string for the Mermaid edge label.
   */
  private _getSmartEdgeLabel(callExpr: CallExpression): string {
    try {
      return this._buildSmartEdgeLabelFromArguments(callExpr.getArguments());
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.warn(`[GraphCompressor] Error getting edge label: ${message}`);
      return "calls";
    }
  }

  private _buildSmartEdgeLabelFromArguments(args: Node[]): string {
    const argTexts = (args || []).map(arg => arg.getText());
    return this._buildSmartEdgeLabelFromTexts(argTexts);
  }

  private _buildSmartEdgeLabelFromBabelArgs(
    args: Array<t.Expression | t.SpreadElement | t.ArgumentPlaceholder>,
    code: string
  ): string {
    if (!args || args.length === 0) {
      return "calls";
    }

    const argTexts = args.map(arg => {
      if (!arg) {
        return '';
      }

      const start = (arg as any).start;
      const end = (arg as any).end;

      if (typeof start === 'number' && typeof end === 'number' && end >= start) {
        return code.slice(start, end).trim();
      }

      if (t.isSpreadElement(arg)) {
        const inner = arg.argument as any;
        const innerStart = inner?.start;
        const innerEnd = inner?.end;
        if (typeof innerStart === 'number' && typeof innerEnd === 'number' && innerEnd >= innerStart) {
          return `...${code.slice(innerStart, innerEnd).trim()}`;
        }
      }

      return '';
    });

    return this._buildSmartEdgeLabelFromTexts(argTexts);
  }

  private _buildSmartEdgeLabelFromTexts(argTexts: Array<string | undefined>): string {
    if (!argTexts || argTexts.length === 0) {
      return "calls";
    }

    const cleaned = argTexts
      .map(text => (text ?? '').trim())
      .filter(text => text.length > 0);

    if (cleaned.length === 0) {
      return "calls";
    }

    const truncated = cleaned.map(text => {
      if (text.length > GraphCompressor.SMART_PARAM_MAX_NAME_LENGTH) {
        return text.substring(0, GraphCompressor.SMART_PARAM_MAX_NAME_LENGTH) + '...';
      }
      return text;
    });

    if (truncated.length <= GraphCompressor.SMART_PARAM_MAX_PARAMS_TO_SHOW) {
      return truncated.join(', ');
    }

    return `${truncated[0]}, ...`;
  }

  private _normalizeSmartEdgeLabel(label: string): string | undefined {
    const trimmed = label.trim();
    if (!trimmed || trimmed === 'calls') {
      return undefined;
    }
    return trimmed;
  }

  /**
   * Extract method calls using ts-morph (primary) with Babel fallback (with line numbers)
   * Used for full file parsing to enable line-range filtering
   */
  private findLocalCallsWithTsMorph(
    filePath: string,
    workspaceRoot: string
  ): Array<{
    name: string;
    fullExpression?: string;
    isMethodCall: boolean;
    line: number;
    targetFile?: string;  // Resolved file path if cross-file
    fullPath?: string;   // Fully qualified method path
    edgeLabel?: string;
  }> {
    const calls: Array<{
      name: string;
      fullExpression?: string;
      isMethodCall: boolean;
      line: number;
      targetFile?: string;
      fullPath?: string;
      edgeLabel?: string;
    }> = [];

    try {
      const project = this.getOrCreateTsMorphProject(workspaceRoot, [filePath]);
      
      // Check file size limit
      if (fs.existsSync(filePath)) {
        const stat = fs.statSync(filePath);
        if (stat.size > 200_000) {
          console.warn(`[GraphCompressor] Skipping large file ${path.basename(filePath)} (${stat.size} bytes)`);
          return [];
        }
      }

      // Add file to project if not already added
      let sourceFile = project.getSourceFile(filePath);
      if (!sourceFile) {
        try {
          sourceFile = project.addSourceFileAtPath(filePath);
        } catch (error) {
          console.warn(`[GraphCompressor] Failed to add file to ts-morph project: ${filePath}`, error);
          return [];
        }
      }

      if (!sourceFile) {
        return [];
      }

      const typeChecker = project.getTypeChecker();
      const skipBuiltIns = new Set([
        'console', 'require', 'setTimeout', 'setInterval', 'clearTimeout', 
        'clearInterval', 'Array', 'Object', 'Date', 'RegExp', 'Map', 'Set'
      ]);

      // Traverse all call expressions and new expressions
      sourceFile.forEachDescendant((node: Node) => {
        try {
          if (Node.isCallExpression(node)) {
            const info = this.extractCallInfoFromExpression(
              node as CallExpression,
              typeChecker,
              filePath,
              skipBuiltIns
            );
            if (info) {
              calls.push(info);
            }
          } else if (Node.isNewExpression(node)) {
            const newExpr = node as NewExpression;
            const line = newExpr.getStartLineNumber();
            
            const expression = newExpr.getExpression();
            if (Node.isIdentifier(expression)) {
              const callName = expression.getText();
              
              // Skip built-in constructors
              if (skipBuiltIns.has(callName)) {
                return;
              }

              let targetFile: string | undefined;
              let fullPath: string | undefined;

              // Try to resolve constructor to get file location
              try {
                const symbol = typeChecker.getSymbolAtLocation(expression);
                if (symbol) {
                  const declarations = symbol.getDeclarations();
                  if (declarations && declarations.length > 0) {
                    const decl = declarations[0];
                    const declFile = decl.getSourceFile();
                    if (declFile && declFile.getFilePath() !== filePath) {
                      targetFile = declFile.getFilePath();
                    }
                    
                    const fullyQualified = symbol.getFullyQualifiedName();
                    if (fullyQualified) {
                      fullPath = fullyQualified;
                    }
                  }
                }
              } catch (err) {
                // Resolution failed, continue
              }

              const edgeLabel = this._normalizeSmartEdgeLabel(
                this._buildSmartEdgeLabelFromArguments(newExpr.getArguments())
              );

              calls.push({
                name: callName,
                fullExpression: `new ${callName}`,
                isMethodCall: false,
                line,
                targetFile,
                fullPath,
                edgeLabel
              });
            }
          }
        } catch (err) {
          // Skip individual node errors, continue traversal
        }
      });
    } catch (error) {
      console.warn(`[GraphCompressor] ts-morph parsing failed for ${filePath}, falling back to Babel:`, error);
      // Fallback to Babel
      try {
        const code = fs.readFileSync(filePath, 'utf8');
        const babelCalls = this.findLocalCallsInCodeWithLines(code, filePath);
        return babelCalls.map(c => ({
          name: c.name,
          fullExpression: c.fullExpression,
          isMethodCall: c.isMethodCall,
          line: c.line,
          edgeLabel: c.edgeLabel
        }));
      } catch (fallbackError) {
        console.warn(`[GraphCompressor] Babel fallback also failed for ${filePath}:`, fallbackError);
        return [];
      }
    }

    return calls;
  }

  /**
   * Extract calls from a specific method using ts-morph
   */
  private findCallsInMethodWithTsMorph(
    filePath: string,
    methodName: string,
    startLine: number,
    endLine: number,
    workspaceRoot: string
  ): Array<{
    name: string;
    fullExpression?: string;
    isMethodCall: boolean;
    line: number;
    targetFile?: string;
    fullPath?: string;
    edgeLabel?: string;
  }> {
    try {
      const project = this.getOrCreateTsMorphProject(workspaceRoot, [filePath]);
      
      // Add file to project if not already added
      let sourceFile = project.getSourceFile(filePath);
      if (!sourceFile) {
        try {
          sourceFile = project.addSourceFileAtPath(filePath);
        } catch (error) {
          console.warn(`[GraphCompressor] Failed to add file to ts-morph project: ${filePath}`, error);
          return [];
        }
      }

      if (!sourceFile) {
        return [];
      }

      // Find the method node by traversing and matching name/line range
      let targetNode: Node | null = null;
      const methodNameOnly = methodName.split('.').pop() || methodName;
      const useLineRange = startLine !== -1 && endLine !== -1;
      
      // When lines are -1, find method by name only using ts-morph class API
      if (!useLineRange) {
        // Try to find method in classes first (most common case)
        const classes = sourceFile.getClasses();
        console.log(`[GraphCompressor] findCallsInMethodWithTsMorph: Found ${classes.length} classes in ${filePath}, searching for method "${methodNameOnly}"`);
        for (const classDecl of classes) {
          const className = classDecl.getName();
          const method = classDecl.getMethod(methodNameOnly);
          if (method) {
            console.log(`[GraphCompressor] findCallsInMethodWithTsMorph: Found method "${methodNameOnly}" in class "${className}"`);
            targetNode = method as Node;
            break;
          }
          // Also check for property declarations (arrow functions)
          const properties = classDecl.getProperties();
          for (const prop of properties) {
            if (prop.getName() === methodNameOnly) {
              console.log(`[GraphCompressor] findCallsInMethodWithTsMorph: Found property method "${methodNameOnly}" in class "${className}"`);
              targetNode = prop as Node;
              break;
            }
          }
          if (targetNode) break;
        }
        
        // If not found in classes, search all functions/methods
        if (!targetNode) {
          sourceFile.forEachDescendant((node) => {
            if (targetNode) return; // Already found
            
            if (Node.isMethodDeclaration(node) || Node.isFunctionDeclaration(node)) {
              const nameNode = node.getNameNode();
              if (nameNode && nameNode.getText() === methodNameOnly) {
                targetNode = node;
              }
            } else if (Node.isPropertyDeclaration(node) && node.getName() === methodNameOnly) {
              // Property with initializer (arrow function)
              targetNode = node;
            }
          });
        }
      } else {
        // Original logic: find by line range + name
        sourceFile.forEachDescendant((node) => {
          if (targetNode) return; // Already found
          
          const nodeStart = node.getStartLineNumber();
          const nodeEnd = node.getEndLineNumber();
          
          // Check if node is in the method's line range
          if (nodeStart >= startLine && nodeEnd <= endLine) {
            // Try to match method name
            if (Node.isMethodDeclaration(node) || Node.isFunctionDeclaration(node)) {
              const nameNode = node.getNameNode();
              if (nameNode && nameNode.getText() === methodNameOnly) {
                targetNode = node;
              }
            } else if (Node.isPropertyDeclaration(node) && node.getName() === methodNameOnly) {
              // Property with initializer (arrow function)
              targetNode = node;
            }
          }
        });
      }

      if (!targetNode) {
        // Fallback: get all calls in the line range (or all calls if lines are -1)
        console.warn(`[GraphCompressor] findCallsInMethodWithTsMorph: Method node not found for ${methodName} in ${filePath} (useLineRange: ${useLineRange})`);
        const allCalls = this.findLocalCallsWithTsMorph(filePath, workspaceRoot);
        console.log(`[GraphCompressor] findCallsInMethodWithTsMorph: Fallback found ${allCalls.length} calls from entire file`);
        if (!useLineRange) {
          // When lines are -1, return all calls from file (filtered by method name if possible)
          console.warn(`[GraphCompressor] findCallsInMethodWithTsMorph: Returning all ${allCalls.length} calls from file (method-specific extraction failed)`);
          return allCalls;
        }
        const filtered = allCalls.filter(c => c.line >= startLine && c.line <= endLine);
        console.log(`[GraphCompressor] findCallsInMethodWithTsMorph: Filtered to ${filtered.length} calls in range [${startLine}, ${endLine}]`);
        return filtered;
      }

      console.log(`[GraphCompressor] findCallsInMethodWithTsMorph: Found method node for ${methodName} in ${filePath}, extracting calls from method body...`);

      // Extract calls from this method node
      const typeChecker = project.getTypeChecker();
      const skipBuiltIns = new Set([
        'console', 'require', 'setTimeout', 'setInterval', 'clearTimeout', 
        'clearInterval', 'Array', 'Object', 'Date', 'RegExp', 'Map', 'Set'
      ]);
      const calls: Array<{
        name: string;
        fullExpression?: string;
        isMethodCall: boolean;
        line: number;
        targetFile?: string;
        fullPath?: string;
        edgeLabel?: string;
      }> = [];

      // Type guard: ensure targetNode is not null
      // After the check above, targetNode is guaranteed to be non-null
      const nodeToProcess: Node = targetNode as Node;
      nodeToProcess.forEachDescendant((node: Node) => {
        try {
          if (Node.isCallExpression(node)) {
            const info = this.extractCallInfoFromExpression(
              node as CallExpression,
              typeChecker,
              filePath,
              skipBuiltIns
            );
            if (info) {
              calls.push(info);
            }
          } else if (Node.isNewExpression(node)) {
            const newExpr = node as NewExpression;
            const line = newExpr.getStartLineNumber();
            
            const expression = newExpr.getExpression();
            if (Node.isIdentifier(expression)) {
              const callName = expression.getText();
              
              if (skipBuiltIns.has(callName)) {
                return;
              }

              let targetFile: string | undefined;
              let fullPath: string | undefined;

              try {
                const symbol = typeChecker.getSymbolAtLocation(expression);
                if (symbol) {
                  const declarations = symbol.getDeclarations();
                  if (declarations && declarations.length > 0) {
                    const decl = declarations[0];
                    const declFile = decl.getSourceFile();
                    if (declFile && declFile.getFilePath() !== filePath) {
                      targetFile = declFile.getFilePath();
                    }
                    const fullyQualified = symbol.getFullyQualifiedName();
                    if (fullyQualified) {
                      fullPath = fullyQualified;
                    }
                  }
                }
              } catch (err) {
                // Continue
              }

              calls.push({
                name: callName,
                fullExpression: `new ${callName}`,
                isMethodCall: false,
                line,
                targetFile,
                fullPath,
                edgeLabel: this._normalizeSmartEdgeLabel(
                  this._buildSmartEdgeLabelFromArguments(newExpr.getArguments())
                )
              });
            }
          }
        } catch (err) {
          // Skip individual node errors
        }
      });

      console.log(`[GraphCompressor] findCallsInMethodWithTsMorph: Extracted ${calls.length} total calls from ${methodName} in ${filePath}`);
      if (calls.length > 0) {
        const searchPlannerCalls = calls.filter(c => c.name.includes('SearchPlanner') || c.name.includes('makeSearchPlan') || c.name.includes('generateSearchPlan'));
        if (searchPlannerCalls.length > 0) {
          console.log(`[GraphCompressor] findCallsInMethodWithTsMorph: Found ${searchPlannerCalls.length} SearchPlanner-related calls:`, searchPlannerCalls.map(c => `${c.name} (${c.targetFile || 'same-file'})`).join(', '));
        }
      }
      
      return calls;
    } catch (error) {
      console.warn(`[GraphCompressor] ts-morph method extraction failed for ${filePath}#${methodName}, falling back to Babel:`, error);
      // Fallback to Babel
      try {
        const code = fs.readFileSync(filePath, 'utf8');
        const lines = code.split('\n');
        const methodCode = lines.slice(startLine - 1, endLine).join('\n');
        const babelCalls = this.findLocalCallsInCode(methodCode, filePath, methodName);
        return babelCalls.map(c => ({
          name: c.name,
          fullExpression: c.fullExpression,
          isMethodCall: c.isMethodCall,
          line: startLine, // Approximate
          edgeLabel: c.edgeLabel
        }));
      } catch (fallbackError) {
        return [];
      }
    }
  }

  /**
   * Check if a method name represents a built-in/native method that doesn't have source locations
   */
  private isBuiltInMethod(methodName: string, filePath?: string): boolean {
    // Skip type definition files - they don't have actual implementations
    if (filePath && filePath.endsWith('.d.ts')) {
      return true;
    }

    // Skip node_modules - these are external dependencies
    if (filePath && filePath.includes('node_modules')) {
      return true;
    }

    const parts = methodName.split('.');
    
    // Check for built-in global objects and their methods
    if (parts.length === 1) {
      const name = parts[0];
      // Built-in globals
      if (['console', 'require', 'setTimeout', 'setInterval', 'clearTimeout', 
           'clearInterval', 'Array', 'Object', 'Date', 'RegExp', 'Map', 'Set',
           'Promise', 'JSON', 'Math', 'Number', 'String', 'Boolean', 'Symbol',
           'BigInt', 'Error', 'TypeError', 'ReferenceError'].includes(name)) {
        return true;
      }
    } else if (parts.length === 2) {
      const [objectName, method] = parts;
      
      // Console methods (Console.warn, Console.log, etc.)
      if (objectName === 'Console' || objectName === 'console') {
        return true;
      }
      
      // Array/Object/Date/etc. static methods
      if (['Array', 'Object', 'Date', 'RegExp', 'Map', 'Set', 'Promise', 
           'JSON', 'Math', 'Number', 'String', 'Boolean', 'Symbol'].includes(objectName)) {
        return true;
      }
      
      // DOM methods (querySelector, getAttribute, etc.)
      if (['querySelector', 'querySelectorAll', 'getAttribute', 'setAttribute',
           'addEventListener', 'removeEventListener', 'createElement', 'appendChild',
           'removeChild', 'getElementById', 'getElementsByClassName', 'getElementsByTagName',
           'hasOwnProperty', 'toString', 'valueOf', 'keys', 'values', 'entries',
           'map', 'filter', 'reduce', 'forEach', 'find', 'findIndex', 'some', 'every',
           'includes', 'indexOf', 'push', 'pop', 'shift', 'unshift', 'slice', 'splice',
           'replace', 'split', 'join', 'trim', 'substring', 'substr', 'toLowerCase',
           'toUpperCase', 'charAt', 'charCodeAt', 'from', 'of', 'isArray', 'assign',
           'create', 'defineProperty', 'getOwnPropertyDescriptor', 'freeze', 'seal'].includes(method)) {
        return true;
      }
    }
    
    return false;
  }

  /**
   * Find method line number using Babel AST parsing
   * Handles JavaScript files, arrow functions, and variable assignments
   */
  private findMethodLineNumberWithBabel(
    filePath: string,
    methodName: string
  ): number | undefined {
    try {
      if (!fs.existsSync(filePath)) {
        return undefined;
      }

      const code = fs.readFileSync(filePath, 'utf8');
      const parts = methodName.split('.');
      
      try {
        const ast = parse(code, {
          sourceType: 'module',
          plugins: [
            'typescript',
            'jsx',
            'decorators-legacy',
            'classProperties',
            'topLevelAwait'
          ],
          allowAwaitOutsideFunction: true,
          allowReturnOutsideFunction: true
        });

        let foundLine: number | undefined;

        traverse(ast, {
          // Function declarations: function methodName() {}
          FunctionDeclaration(path) {
            if (parts.length === 1 && path.node.id && path.node.id.name === parts[0]) {
              const line = path.node.loc?.start.line;
              if (line) {
                foundLine = line;
                path.stop();
              }
            }
          },
          
          // Arrow functions: const methodName = () => {}
          VariableDeclarator(path) {
            if (parts.length === 1 && 
                t.isIdentifier(path.node.id) && 
                path.node.id.name === parts[0] &&
                (t.isArrowFunctionExpression(path.node.init) || 
                 t.isFunctionExpression(path.node.init))) {
              const line = path.node.loc?.start.line;
              if (line) {
                foundLine = line;
                path.stop();
              }
            }
          },
          
          // Class methods: class ClassName { methodName() {} }
          ClassMethod(path) {
            if (parts.length === 2) {
              const [className, actualMethodName] = parts;
              // Check if we're in the right class
              const classDeclaration = path.findParent(p => t.isClassDeclaration(p.node));
              if (classDeclaration && 
                  t.isClassDeclaration(classDeclaration.node) &&
                  classDeclaration.node.id &&
                  classDeclaration.node.id.name === className &&
                  t.isIdentifier(path.node.key) &&
                  path.node.key.name === actualMethodName) {
                const line = path.node.loc?.start.line;
                if (line) {
                  foundLine = line;
                  path.stop();
                }
              }
            } else if (parts.length === 1) {
              // Try to find method in any class
              if (t.isIdentifier(path.node.key) && path.node.key.name === parts[0]) {
                const line = path.node.loc?.start.line;
                if (line) {
                  foundLine = line;
                  path.stop();
                }
              }
            }
          },
          
          // Class declarations: class ClassName {}
          ClassDeclaration(path) {
            if (parts.length === 2) {
              const [className] = parts;
              if (path.node.id && path.node.id.name === className) {
                // Found the class, now look for the method
                // This is handled by ClassMethod above
              }
            }
          }
        });

        return foundLine;
      } catch (parseError) {
        // Babel parsing failed, will fall back to regex
        return undefined;
      }
    } catch (error) {
      return undefined;
    }
  }

  /**
   * Find method line number using regex patterns as final fallback
   */
  private findMethodLineNumberWithRegex(
    filePath: string,
    methodName: string
  ): number | undefined {
    try {
      if (!fs.existsSync(filePath)) {
        return undefined;
      }

      const code = fs.readFileSync(filePath, 'utf8');
      const lines = code.split('\n');
      const parts = methodName.split('.');

      // Escape special regex characters in method/class names
      const escapeRegex = (str: string): string => {
        return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      };

      // Patterns to match function definitions
      const patterns: RegExp[] = [];

      if (parts.length === 1) {
        const name = escapeRegex(parts[0]);
        // Function declaration: function name() {}
        patterns.push(new RegExp(`^\\s*(?:export\\s+)?(?:async\\s+)?function\\s+${name}\\s*\\(`));
        // Arrow function: const name = () => {}
        patterns.push(new RegExp(`^\\s*(?:export\\s+)?(?:const|let|var)\\s+${name}\\s*=\\s*(?:async\\s+)?\\([^)]*\\)\\s*=>`));
        // Method in class: name() {}
        patterns.push(new RegExp(`^\\s*(?:async\\s+)?${name}\\s*\\([^)]*\\)\\s*[={]`));
      } else if (parts.length === 2) {
        const [className, actualMethodName] = parts;
        const escapedClassName = escapeRegex(className);
        const escapedMethodName = escapeRegex(actualMethodName);
        
        // Class declaration: class ClassName {}
        const classPattern = new RegExp(`^\\s*(?:export\\s+)?class\\s+${escapedClassName}\\s*[\\{:]`);
        // Method in class: methodName() {}
        const methodPattern = new RegExp(`^\\s*(?:async\\s+)?${escapedMethodName}\\s*\\([^)]*\\)\\s*[={]`);
        
        // First find the class, then find the method after it
        let classLine = -1;
        for (let i = 0; i < lines.length; i++) {
          if (classPattern.test(lines[i])) {
            classLine = i;
            break;
          }
        }
        
        if (classLine >= 0) {
          // Look for the method after the class declaration
          for (let i = classLine + 1; i < lines.length; i++) {
            if (methodPattern.test(lines[i])) {
              return i + 1; // 1-based line number
            }
          }
        }
        
        // Fallback: just search for the method name
        patterns.push(methodPattern);
      }

      // Search for patterns
      for (const pattern of patterns) {
        for (let i = 0; i < lines.length; i++) {
          if (pattern.test(lines[i])) {
            return i + 1; // 1-based line number
          }
        }
      }

      return undefined;
    } catch (error) {
      return undefined;
    }
  }

  /**
   * Find the line number of a method definition using ts-morph
   * Handles both standalone functions and class methods
   * Falls back to Babel AST parsing and regex if ts-morph fails
   */
  private findMethodLineNumber(
    filePath: string,
    methodName: string,
    workspaceRoot: string
  ): number | undefined {
    // Step 1: Check if it's a built-in method - skip silently
    if (this.isBuiltInMethod(methodName, filePath)) {
      return undefined;
    }

    // Step 2: Try ts-morph (works best for TypeScript files)
    try {
      const project = this.getOrCreateTsMorphProject(workspaceRoot, [filePath]);
      
      // Add file to project if not already added
      let sourceFile = project.getSourceFile(filePath);
      if (!sourceFile) {
        try {
          sourceFile = project.addSourceFileAtPath(filePath);
        } catch (error) {
          // ts-morph failed, will try Babel fallback
        }
      }

      if (sourceFile) {
        // Parse methodName by splitting on '.' to handle two formats:
        // 1. "activate" (standalone function)
        // 2. "ClassName.methodName" (class method)
        const parts = methodName.split('.');

        if (parts.length === 1) {
          // It's a standalone function
          const func = sourceFile.getFunction(parts[0]);
          if (func) {
            return func.getStartLineNumber();
          }
        } else if (parts.length === 2) {
          // It's a class method, e.g., "ClassName.methodName"
          const [className, actualMethodName] = parts;
          const classNode = sourceFile.getClass(className);
          if (classNode) {
            const methodNode = classNode.getMethod(actualMethodName);
            if (methodNode) {
              return methodNode.getStartLineNumber();
            }
          }
        }
      }
    } catch (error) {
      // ts-morph failed, will try Babel fallback
    }

    // Step 3: Try Babel AST parsing (works for JavaScript files and arrow functions)
    const babelLineNumber = this.findMethodLineNumberWithBabel(filePath, methodName);
    if (babelLineNumber !== undefined) {
      return babelLineNumber;
    }

    // Step 4: Try regex fallback (last resort)
    const regexLineNumber = this.findMethodLineNumberWithRegex(filePath, methodName);
    if (regexLineNumber !== undefined) {
      return regexLineNumber;
    }

    // Step 5: All methods failed - only warn if it's not a built-in
    // (Built-ins are already handled silently in step 1)
    console.warn(`[GraphCompressor] Could not find line number for: ${methodName} in ${filePath}`);
    return undefined;
  }

  /**
   * Extract method calls from code using Babel AST parsing (with line numbers)
   * Used for full file parsing to enable line-range filtering (FALLBACK)
   */
  private findLocalCallsInCodeWithLines(
    code: string,
    filePath?: string
  ): Array<{
    name: string;
    fullExpression?: string;
    isMethodCall: boolean;
    line: number;  // Line number where call was found
    edgeLabel?: string;
  }> {
    const calls: Array<{ name: string; fullExpression?: string; isMethodCall: boolean; line: number; edgeLabel?: string }> = [];
    const extractMember = this.extractMethodNameFromMemberExpression.bind(this);
    const shouldSkipBuiltInMember = this.shouldSkipBuiltInMemberFromBabel.bind(this);
    const computeEdgeLabel = (
      args: readonly (t.Expression | t.SpreadElement | t.ArgumentPlaceholder)[] | null | undefined
    ): string | undefined => {
      if (!args || args.length === 0) {
        return undefined;
      }
      const label = this._buildSmartEdgeLabelFromBabelArgs(Array.from(args), code);
      return this._normalizeSmartEdgeLabel(label);
    };

    try {
      const ast = parse(code, {
        sourceType: 'module',
        plugins: [
          'typescript',
          'jsx',
          'decorators-legacy',
          'classProperties',
          'topLevelAwait'
        ],
        allowAwaitOutsideFunction: true,
        allowReturnOutsideFunction: true
      });

      traverse(ast, {
        CallExpression: (path) => {
          const { node } = path;
          const line = node.loc?.start?.line || (node.start ? code.substring(0, node.start).split('\n').length : 1);
          const edgeLabel = computeEdgeLabel(node.arguments);

          if (t.isIdentifier(node.callee)) {
            const name = node.callee.name;
            if (!['console', 'require', 'setTimeout', 'setInterval', 'clearTimeout', 'clearInterval'].includes(name)) {
              calls.push({
                name,
                fullExpression: name,
                isMethodCall: false,
                line,
                edgeLabel
              });
            }
            return;
          }

          if (t.isMemberExpression(node.callee)) {
            const methodName = extractMember(node.callee);
            if (!methodName) {
              return;
            }
            if (shouldSkipBuiltInMember(methodName.name, methodName.full)) {
              return;
            }
            calls.push({
              name: methodName.name,
              fullExpression: methodName.full,
              isMethodCall: true,
              line,
              edgeLabel
            });
          }
        },

        NewExpression: (path) => {
          const { node } = path;
          const line = node.loc?.start?.line || (node.start ? code.substring(0, node.start).split('\n').length : 1);
          const edgeLabel = computeEdgeLabel(node.arguments ?? []);

          if (t.isIdentifier(node.callee)) {
            const name = node.callee.name;
            if (!['Array', 'Object', 'Date', 'RegExp', 'Map', 'Set'].includes(name)) {
              calls.push({
                name,
                fullExpression: `new ${name}`,
                isMethodCall: false,
                line,
                edgeLabel
              });
            }
            return;
          }

          if (t.isMemberExpression(node.callee)) {
            const methodName = extractMember(node.callee);
            if (!methodName) {
              return;
            }
            if (shouldSkipBuiltInMember(methodName.name, methodName.full)) {
              return;
            }
            calls.push({
              name: methodName.name,
              fullExpression: `new ${methodName.full}`,
              isMethodCall: true,
              line,
              edgeLabel
            });
          }
        }
      });
    } catch (error) {
      console.warn(`[GraphCompressor] Failed to parse full file ${filePath}:`, error);
    }

    return calls;
  }

  /**
   * Extract method calls from code using Babel AST parsing
   * Returns array of call names with context (e.g., "this.method", "obj.foo", "bar")
   */
  private findLocalCallsInCode(
    code: string,
    filePath?: string,
    methodName?: string
  ): Array<{
    name: string;           // e.g., "method", "foo", "bar"
    fullExpression?: string; // e.g., "this.method", "obj.foo", "bar"
    isMethodCall: boolean;  // true for method calls, false for function calls
    crossFile?: boolean;    // true if call likely targets another file
    edgeLabel?: string;
  }> {
    const calls: Array<{ name: string; fullExpression?: string; isMethodCall: boolean; crossFile?: boolean; edgeLabel?: string }> = [];
    
    // Fix: Capture extractMember helper before traverse (this context issue)
    const extractMember = this.extractMethodNameFromMemberExpression.bind(this);
    const shouldSkipBuiltInMember = this.shouldSkipBuiltInMemberFromBabel.bind(this);
    
    const processCallExpressions = (ast: t.File | t.Program) => {
      traverse(ast, {
        CallExpression(path) {
          const { node } = path;
          
          // Skip calls like console.log, require(), etc.
          if (t.isIdentifier(node.callee)) {
            const name = node.callee.name;
            // Skip common built-ins
            if (
              ['console', 'require', 'setTimeout', 'setInterval', 'clearTimeout', 'clearInterval'].includes(name) ||
              GraphCompressor.BUILTIN_METHOD_NAMES.has(name)
            ) {
              return;
            }
            calls.push({
              name,
              fullExpression: name,
              isMethodCall: false
            });
          } else if (t.isMemberExpression(node.callee)) {
            // Handle obj.method() or this.method()
            // Fix: Use captured helper, not this.extractMethodNameFromMemberExpression
            const methodName = extractMember(node.callee);
            if (methodName) {
              if (shouldSkipBuiltInMember(methodName.name, methodName.full)) {
                return;
              }
              calls.push({
                name: methodName.name,
                fullExpression: methodName.full,
                isMethodCall: true
              });
            }
          }
        },
        
        NewExpression(path) {
          // Handle new ClassName() constructor calls
          const { node } = path;
          if (t.isIdentifier(node.callee)) {
            const name = node.callee.name;
            // Filter non-flow constructors (UI components, DTOs, infra)
            const isNonFlowCtor = /^([A-Z]|Http|Axios|Logger)/.test(name);
            // Skip built-in constructors
            if (!['Array', 'Object', 'Date', 'RegExp', 'Map', 'Set'].includes(name)) {
              calls.push({
                name,
                fullExpression: `new ${name}`,
                isMethodCall: false
                // Note: isNonFlowCtor can be used later for priority filtering
              });
            }
          } else if (t.isMemberExpression(node.callee)) {
            // Fix: Use captured helper
            const methodName = extractMember(node.callee);
            if (methodName) {
              if (shouldSkipBuiltInMember(methodName.name, methodName.full)) {
                return;
              }
              calls.push({
                name: methodName.name,
                fullExpression: `new ${methodName.full}`,
                isMethodCall: true
              });
            }
          }
        }
      });
    };
    
    try {
      // Parse code with TypeScript support
      const ast = parse(code, {
        sourceType: 'module',
        plugins: [
          'typescript',
          'jsx',
          'decorators-legacy',
          'classProperties',
          'topLevelAwait'
        ],
        allowAwaitOutsideFunction: true,
        allowReturnOutsideFunction: true
      });
      
      processCallExpressions(ast);
    } catch (error) {
      // Fix: Wrap snippet in dummy function when parsing fails
      // Clean the code first: strip TS modifiers and imports
      try {
        const cleanedCode = this.cleanMethodSnippet(code);
        if (!cleanedCode || cleanedCode.trim().length === 0) {
          // Empty after cleaning, fall back to regex
          const context = filePath && methodName ? `${filePath}#${methodName}` : 'unknown';
          console.warn(`[GraphCompressor] Code snippet empty after cleaning for ${context}, using regex fallback`);
          return this.findLocalCallsInCodeRegexFallback(code);
        }
        
        const wrapped = `function __temp__() {\n${cleanedCode}\n}`;
        const ast = parse(wrapped, {
          sourceType: 'module',
          plugins: [
            'typescript',
            'jsx',
            'decorators-legacy',
            'classProperties',
            'topLevelAwait'
          ],
          allowAwaitOutsideFunction: true,
          allowReturnOutsideFunction: true
        });
        
        processCallExpressions(ast);
      } catch (err2) {
        // Final fallback to regex
        const context = filePath && methodName ? `${filePath}#${methodName}` : 'unknown';
        console.warn(`[GraphCompressor] Babel parsing failed for ${context}, using regex fallback:`, err2);
        return this.findLocalCallsInCodeRegexFallback(code);
      }
    }
    
    // Deduplicate while preserving order
    const seen = new Set<string>();
    const unique: typeof calls = [];
    for (const call of calls) {
      const key = call.fullExpression || call.name;
      if (!seen.has(key)) {
        seen.add(key);
        unique.push(call);
      }
    }
    
    // Log when no calls found (with file + method context)
    if (unique.length === 0 && filePath && methodName) {
      console.warn(`[GraphCompressor] No AST calls found in ${filePath}#${methodName}`);
    }
    
    return unique;
  }

  /**
   * Clean method snippet: strip TS modifiers, remove imports, extract body
   */
  private cleanMethodSnippet(code: string): string {
    const lines = code.split('\n');
    const cleaned: string[] = [];
    let inBody = false;
    let braceDepth = 0;
    let foundOpeningBrace = false;
    
    for (const line of lines) {
      const trimmed = line.trim();
      
      // Skip import/export statements
      if (trimmed.startsWith('import ') || trimmed.startsWith('export ')) {
        continue;
      }
      
      // Track braces to find method body
      const openBraces = (trimmed.match(/{/g) || []).length;
      const closeBraces = (trimmed.match(/}/g) || []).length;
      
      // Remove TypeScript modifiers from line
      let cleanedLine = trimmed;
      // Remove multiple modifiers (e.g., "public async")
      cleanedLine = cleanedLine.replace(/^(public|private|protected|static|async|readonly)\s+/g, '');
      cleanedLine = cleanedLine.replace(/\s+(public|private|protected|static|async|readonly)\s+/g, ' ');
      
      // If we found an opening brace, we're in the body
      if (openBraces > 0 && !foundOpeningBrace) {
        foundOpeningBrace = true;
        inBody = true;
        // Extract just the body part (after the opening brace)
        const braceIndex = cleanedLine.indexOf('{');
        if (braceIndex >= 0 && braceIndex < cleanedLine.length - 1) {
          // Include content after opening brace
          cleaned.push(cleanedLine.substring(braceIndex + 1));
        } else if (braceIndex >= 0) {
          // Opening brace at end, continue on next line
          continue;
        }
      } else if (foundOpeningBrace) {
        // We're in the body, include the line
        braceDepth += openBraces - closeBraces;
        if (braceDepth <= 0) {
          // Reached closing brace, include up to the closing brace
          const braceIndex = cleanedLine.indexOf('}');
          if (braceIndex >= 0) {
            cleaned.push(cleanedLine.substring(0, braceIndex));
            break; // Stop after closing brace
          }
        }
        cleaned.push(cleanedLine);
      } else {
        // Before body - try to extract method signature
        // Skip if it's just a method declaration without body
        if (trimmed.includes('(') && !trimmed.includes('{')) {
          continue; // Skip signature lines without body
        }
        // If it has both signature and body on one line
        if (trimmed.includes('(') && trimmed.includes('{')) {
          const bodyStart = trimmed.indexOf('{');
          if (bodyStart >= 0) {
            cleaned.push(trimmed.substring(bodyStart + 1));
            foundOpeningBrace = true;
            inBody = true;
            braceDepth = (trimmed.match(/{/g) || []).length - 1; // Subtract 1 since we skipped the first {
          }
        }
      }
    }
    
    // If we didn't extract a body, try simpler approach: just remove modifiers and imports
    if (!inBody || cleaned.length === 0) {
      return lines
        .map(line => {
          let cleaned = line.trim();
          // Remove TypeScript modifiers
          cleaned = cleaned.replace(/^(public|private|protected|static|async|readonly)\s+/g, '');
          cleaned = cleaned.replace(/\s+(public|private|protected|static|async|readonly)\s+/g, ' ');
          // Skip import/export
          if (cleaned.startsWith('import ') || cleaned.startsWith('export ')) {
            return '';
          }
          return cleaned;
        })
        .filter(line => line.length > 0)
        .join('\n');
    }
    
    return cleaned.join('\n');
  }

  /**
   * Extract method name from Babel MemberExpression
   * Handles: this.method, obj.method, module.sub.method, etc.
   * Must be called with correct this context (use bind())
   */
  private extractMethodNameFromMemberExpression(
    expr: t.MemberExpression
  ): { name: string; full: string } | null {
    const parts: string[] = [];
    
    // Recursively extract property chain
    let current: t.Expression | t.Super = expr;
    
    while (t.isMemberExpression(current)) {
      if (t.isIdentifier(current.property)) {
        parts.unshift(current.property.name);
      } else if (t.isStringLiteral(current.property)) {
        parts.unshift(current.property.value);
      } else {
        // Can't extract name
        return null;
      }
      
      current = current.object;
    }
    
    // Get the base (obj, this, module, etc.)
    if (t.isIdentifier(current)) {
      parts.unshift(current.name);
    } else if (t.isThisExpression(current)) {
      parts.unshift('this');
    } else if (t.isSuper(current)) {
      parts.unshift('super');
    } else {
      // Can't extract base
      return null;
    }
    
    // Return last part as method name, full chain as full expression
    if (parts.length === 0) return null;
    
    return {
      name: parts[parts.length - 1],
      full: parts.join('.')
    };
  }

  /**
   * Regex fallback for when Babel parsing fails
   */
  private findLocalCallsInCodeRegexFallback(code: string): Array<{
    name: string;
    fullExpression?: string;
    isMethodCall: boolean;
  }> {
    // Keep existing regex implementation as fallback
    const calls = new Set<string>();
    const patterns = [
      /(\w+)\(/g,
      /\.(\w+)\(/g,
      /this\.(\w+)\(/g
    ];
    
    const skipList = new Set([
      'if', 'for', 'while', 'switch', 'catch', 'console', 'setTimeout',
      'setInterval', 'clearTimeout', 'clearInterval', 'return', 'throw',
      'new', 'typeof', 'instanceof', 'await', 'async', 'function'
    ]);
    
    for (const pattern of patterns) {
      pattern.lastIndex = 0;
      let match;
      while ((match = pattern.exec(code)) !== null) {
        const methodName = match[1];
        if (
          methodName &&
          !skipList.has(methodName) &&
          !GraphCompressor.BUILTIN_METHOD_NAMES.has(methodName) &&
          /^[a-zA-Z_$][a-zA-Z0-9_$]*$/.test(methodName)
        ) {
          calls.add(methodName);
        }
      }
    }
    
    return Array.from(calls).map(name => ({
      name,
      fullExpression: name,
      isMethodCall: false
    }));
  }

  /**
   * Deep cross-file traversal using ts-morph
   * BFS traversal starting from spine methods, following calls up to maxHops depth
   */
  public traverseCallsDeep(
    spine: Array<{ file: string; method: string }>,
    workspaceRoot: string,
    opts: { maxHops?: number; maxNodes?: number; maxFiles?: number } = {}
  ): Map<string, Array<{
    name: string;
    file: string;
    depth: number;
    fullPath?: string;
    crossFile: boolean;
    line?: number;  // Line number where call occurs
    order?: number;  // Execution order within method
    edgeLabel?: string;
  }>> {
    // Use adaptive limits: higher for spine methods, lower for others
    const maxHops = opts.maxHops ?? 6; // Reduced from 10 to 6 to prevent stack overflow
    const maxNodes = opts.maxNodes ?? 450; // Reduced from 1500 to 450 (3x multiplier)
    const maxFiles = opts.maxFiles ?? 50; // Restored to 50
    
    // Spine methods get deeper traversal (6 hops) vs regular methods (4 hops) - reduced to prevent stack overflow
    const spineMaxHops = 6;
    const regularMaxHops = 4;

    const callGraph = new Map<string, Array<{
      name: string;
      file: string;
      depth: number;
      fullPath?: string;
      crossFile: boolean;
      line?: number;  // Line number where call occurs
      order?: number;  // Execution order within method
      edgeLabel?: string;
    }>>();

    // Track processed files and methods
    const processedMethods = new Set<string>();
    let processedFileCount = 0;
    
    // Track methods processed per depth to limit breadth expansion
    // This allows deeper exploration by limiting breadth at each depth
    const methodsPerDepth = new Map<number, number>();
    const maxMethodsPerDepth = 80; // Limit breadth per depth for non-spine methods (allows deeper exploration)

    // Extract workspace root if not provided
    let actualWorkspaceRoot = workspaceRoot;
    if (!actualWorkspaceRoot && spine.length > 0 && spine[0].file) {
      // Derive from first spine file
      actualWorkspaceRoot = path.dirname(spine[0].file);
      // Try to find tsconfig.json or package.json parent
      let current = actualWorkspaceRoot;
      for (let i = 0; i < 10; i++) {
        if (fs.existsSync(path.join(current, 'tsconfig.json')) || 
            fs.existsSync(path.join(current, 'package.json'))) {
          actualWorkspaceRoot = current;
          break;
        }
        const parent = path.dirname(current);
        if (parent === current) break;
        current = parent;
      }
    }

    // Helper to check if method is a spine method
    const isSpineMethod = (file: string, method: string): boolean => {
      return spine.some(s => s.file === file && s.method === method);
    };
    
    // BFS queue: {file, method, depth, isSpine}
    interface QueueItem {
      file: string;
      method: string;
      depth: number;
      isSpine: boolean;
    }
    const queue: QueueItem[] = [];
    const spineQueue: QueueItem[] = [];
    const regularQueue: QueueItem[] = [];
    
    // Initialize queue with spine methods (depth 0) - prioritize them
    for (const spineItem of spine) {
      const key = this.methodKey(spineItem.file, spineItem.method);
      if (!processedMethods.has(key) && processedMethods.size < maxNodes) {
        const item = { file: spineItem.file, method: spineItem.method, depth: 0, isSpine: true };
        spineQueue.push(item);
        processedMethods.add(key);
        if (!callGraph.has(key)) {
          callGraph.set(key, []);
        }
      }
    }
    
    // Start with spine methods first
    queue.push(...spineQueue);

    // Process queue with priority: spine methods first, then regular methods
    while ((spineQueue.length > 0 || regularQueue.length > 0 || queue.length > 0) && 
           processedMethods.size < maxNodes && 
           processedFileCount < maxFiles) {
      // Prioritize: process spine queue first (prioritize deeper items), then regular queue
      let current: QueueItem | undefined;
      if (spineQueue.length > 0) {
        // For spine methods, prioritize deeper items first (depth-first exploration)
        spineQueue.sort((a, b) => b.depth - a.depth); // Deeper items first
        current = spineQueue.shift()!;
      } else if (regularQueue.length > 0) {
        current = regularQueue.shift()!;
      } else if (queue.length > 0) {
        current = queue.shift()!;
      } else {
        break;
      }
      
      // Use adaptive depth limits: spine methods get deeper traversal
      const effectiveMaxHops = current.isSpine ? spineMaxHops : regularMaxHops;
      if (current.depth >= effectiveMaxHops) {
        continue; // Skip if exceeded depth limit
      }

      const currentKey = this.methodKey(current.file, current.method);
      const isCurrentSpine = current.isSpine || isSpineMethod(current.file, current.method);

      try {
        // Check if file exists
        if (!fs.existsSync(current.file)) {
          console.warn(`[GraphCompressor] traverseCallsDeep: File does not exist: ${current.file} for method ${current.method}`);
          continue;
        }

        // Extract calls from this method using ts-morph
        console.log(`[GraphCompressor] traverseCallsDeep: Extracting calls from ${currentKey} (file: ${current.file}, method: ${current.method})`);
        const calls = this.findCallsInMethodWithTsMorph(
          current.file,
          current.method,
          -1, // startLine - use -1 to get all calls (will be handled by ts-morph)
          -1, // endLine
          actualWorkspaceRoot
        );

        console.log(`[GraphCompressor] traverseCallsDeep: findCallsInMethodWithTsMorph returned ${calls.length} calls for ${currentKey}`);
        if (calls.length > 0) {
          console.log(`[GraphCompressor] traverseCallsDeep: Sample calls from ${currentKey}:`, calls.slice(0, 5).map(c => `${c.name} (${c.targetFile || 'same-file'})`).join(', '));
        }

        // If ts-morph failed, try fallback: find method in file and get line range
        if (calls.length === 0) {
          console.warn(`[GraphCompressor] traverseCallsDeep: No calls found via ts-morph for ${currentKey}, trying fallback...`);
          // Try to find method line range from local context or file
          try {
            const allCalls = this.findLocalCallsWithTsMorph(current.file, actualWorkspaceRoot);
            if (allCalls.length > 0) {
              console.log(`[GraphCompressor] traverseCallsDeep: Fallback found ${allCalls.length} calls from file`);
              // Use all calls from file as approximation
              calls.push(...allCalls);
            } else {
              console.warn(`[GraphCompressor] traverseCallsDeep: Fallback also found 0 calls for ${currentKey}`);
            }
          } catch (err) {
            console.warn(`[GraphCompressor] Failed to extract calls for ${currentKey}:`, err);
          }
        }

        // Log extraction results
        if (calls.length > 0) {
          console.log(`[GraphCompressor] traverseCallsDeep: Extracted ${calls.length} calls from ${currentKey}${isCurrentSpine ? ' (spine)' : ''}`);
        } else {
          console.warn(`[GraphCompressor] traverseCallsDeep: No calls extracted from ${currentKey}${isCurrentSpine ? ' (spine)' : ''} - this method may have no calls or extraction failed`);
        }

        // Add calls to graph with adaptive limits: spine methods get 200 calls, regular methods get 50
        const currentCalls = callGraph.get(currentKey) || [];
        const callLimit = isCurrentSpine ? 200 : 50; // Higher limit for spine methods
        const callsToProcess = calls.slice(0, callLimit);
        
        if (calls.length > callLimit) {
          console.warn(`[GraphCompressor] Truncated ${calls.length - callLimit} calls from ${currentKey} (limit: ${callLimit})`);
        }
        for (const call of callsToProcess) {
          const targetFile = call.targetFile || current.file;
          const callName = call.name;
          const targetKey = this.methodKey(targetFile, callName);
          const isCrossFile = call.targetFile !== undefined && call.targetFile !== current.file;

          // Log important calls (especially SearchPlanner methods)
          if (callName.includes('SearchPlanner') || callName.includes('makeSearchPlan') || callName.includes('generateSearchPlan')) {
            console.log(`[GraphCompressor] traverseCallsDeep: Found SearchPlanner call! ${currentKey} -> ${callName} (targetFile: ${targetFile}, crossFile: ${isCrossFile})`);
          }

          // Add to forward index with line number
          currentCalls.push({
            name: callName,
            file: targetFile,
            depth: current.depth + 1,
            fullPath: call.fullPath,
            crossFile: isCrossFile,
            line: call.line,  // Preserve line number for execution order
            edgeLabel: call.edgeLabel
          });

          // Add to queue if not processed and within limits
          // Check if the callee is a spine method or part of spine chain
          const isCalleeSpine = isSpineMethod(targetFile, callName);
          const calleeEffectiveMaxHops = isCalleeSpine ? spineMaxHops : regularMaxHops;
          
          // Allow deeper exploration for spine methods even when close to limit
          // For spine methods, allow up to 95% of limit for deep exploration
          // For regular methods, use full limit but limit breadth per depth
          const nodeLimit = (isCalleeSpine || (isCurrentSpine && current.depth < 6)) 
            ? Math.floor(maxNodes * 0.95)  // Allow spine methods to go deeper
            : maxNodes;
          
          // Limit breadth per depth for non-spine methods to allow deeper exploration
          const nextDepth = current.depth + 1;
          const depthCount = methodsPerDepth.get(nextDepth) || 0;
          const isSpineItem = isCalleeSpine || (isCurrentSpine && current.depth < 6);
          const depthLimitOK = isSpineItem || depthCount < maxMethodsPerDepth;
          
          if (!processedMethods.has(targetKey) && 
              processedMethods.size < nodeLimit && 
              current.depth + 1 < calleeEffectiveMaxHops &&
              processedFileCount < maxFiles &&
              depthLimitOK) {
            const newItem: QueueItem = { 
              file: targetFile, 
              method: callName, 
              depth: current.depth + 1,
              isSpine: isCalleeSpine || (isCurrentSpine && current.depth < 6) // Consider spine chain up to depth 6 to allow deeper exploration
            };
            
            // Prioritize spine methods in queue
            if (newItem.isSpine) {
              spineQueue.push(newItem);
            } else {
              regularQueue.push(newItem);
            }
            
            processedMethods.add(targetKey);
            
            // Track depth usage for breadth limiting
            methodsPerDepth.set(nextDepth, (methodsPerDepth.get(nextDepth) || 0) + 1);
            
            // Track file processing
            if (!this.processedFiles.has(targetFile)) {
              this.processedFiles.add(targetFile);
              processedFileCount++;
            }
          }
        }

        // Sort calls by line number and assign execution order
        currentCalls.sort((a, b) => {
          const aLine = a.line ?? 999999; // Put calls without line numbers at end
          const bLine = b.line ?? 999999;
          return aLine - bLine;
        });
        
        // Assign execution order (1, 2, 3, ...)
        currentCalls.forEach((call, index) => {
          call.order = index + 1;
        });

        callGraph.set(currentKey, currentCalls);
        
        // Progress logging every 10 methods
        if (processedMethods.size % 10 === 0) {
          console.log(`[GraphCompressor] traverseCallsDeep progress: ${processedMethods.size}/${maxNodes} methods, ${processedFileCount}/${maxFiles} files, depth ${current.depth}/${maxHops}`);
        }
      } catch (error) {
        console.warn(`[GraphCompressor] Error traversing ${currentKey} at depth ${current.depth}:`, error);
      }
    }

    console.log(`[GraphCompressor] traverseCallsDeep: processed ${processedMethods.size} methods, ${processedFileCount} files`);
    return callGraph;
  }

  /**
   * Find callers of a method using ts-morph's findReferences API
   */
  private findCallersWithTsMorph(
    methodName: string,
    filePath: string,
    workspaceRoot: string
  ): Array<{ file: string; method: string; line?: number }> {
    const callers: Array<{ file: string; method: string; line?: number }> = [];

    try {
      const project = this.getOrCreateTsMorphProject(workspaceRoot, [filePath]);
      
      // Add file to project if not already added
      let sourceFile = project.getSourceFile(filePath);
      if (!sourceFile) {
        try {
          sourceFile = project.addSourceFileAtPath(filePath);
        } catch (error) {
          console.warn(`[GraphCompressor] Failed to add file to ts-morph project: ${filePath}`, error);
          return [];
        }
      }

      if (!sourceFile) {
        return [];
      }

      // Find method declaration by name
      let methodDeclaration: Node | null = null;
      const shortMethodName = methodName.split('.').pop()!;

      sourceFile.forEachDescendant((node) => {
        if (methodDeclaration) return; // Already found

        if (Node.isMethodDeclaration(node) || Node.isFunctionDeclaration(node)) {
          const nameNode = node.getNameNode();
          if (nameNode && nameNode.getText() === shortMethodName) {
            methodDeclaration = node;
          }
        } else if (Node.isPropertyDeclaration(node) && node.getName() === shortMethodName) {
          methodDeclaration = node;
        } else if (Node.isVariableDeclaration(node)) {
          const nameNode = node.getNameNode();
          if (nameNode && nameNode.getText() === shortMethodName) {
            methodDeclaration = node;
          }
        }
      });

      if (!methodDeclaration) {
        // Method not found - return empty
        return [];
      }

      // Find references using ts-morph
      const projectLanguageService = project.getLanguageService();
      const typeChecker = project.getTypeChecker();

      try {
        // Find all references using project language service
        const referencedSymbols = projectLanguageService.findReferences(methodDeclaration);

          if (referencedSymbols && referencedSymbols.length > 0) {
            for (const referencedSymbol of referencedSymbols) {
              // Get all reference entries for this symbol
              const referenceEntries = referencedSymbol.getReferences();
              for (const entry of referenceEntries) {
                const refNode = entry.getNode();
                if (refNode) {
                  const refFile = refNode.getSourceFile();
                  if (refFile) {
                    const refFilePath = refFile.getFilePath();
                    const refLine = refNode.getStartLineNumber();

                    // Skip if it's the declaration itself
                    // After the check above, methodDeclaration is guaranteed to be non-null
                    const declNode: Node = methodDeclaration as Node;
                    if (refFilePath === filePath && refLine === declNode.getStartLineNumber()) {
                      continue;
                    }

                    // Try to find the containing method/function
                    let containingMethod: string | undefined;
                    const parent = refNode.getParent();
                    let currentNode: Node | null = parent ? parent : null;

                    while (currentNode) {
                      if (Node.isMethodDeclaration(currentNode) || Node.isFunctionDeclaration(currentNode)) {
                        const nameNode = currentNode.getNameNode();
                        if (nameNode) {
                          containingMethod = nameNode.getText();
                          break;
                        }
                      } else if (Node.isPropertyDeclaration(currentNode)) {
                        containingMethod = currentNode.getName();
                        break;
                      } else if (Node.isVariableDeclaration(currentNode)) {
                        const nameNode = currentNode.getNameNode();
                        if (nameNode) {
                          containingMethod = nameNode.getText();
                          break;
                        }
                      }
                      const nextParent = currentNode.getParent();
                      currentNode = nextParent ? nextParent : null;
                    }

                    if (containingMethod) {
                      callers.push({
                        file: refFilePath,
                        method: containingMethod,
                        line: refLine
                      });
                    }
                  }
                }
              }
            }
          }
      } catch (err) {
        console.warn(`[GraphCompressor] Error finding references for ${filePath}#${methodName}:`, err);
      }
    } catch (error) {
      console.warn(`[GraphCompressor] ts-morph findCallers failed for ${filePath}#${methodName}, using fallback:`, error);
      // Fallback: keyword search (simple grep-like approach)
      try {
        const shortMethodName = methodName.split('.').pop()!;
        const code = fs.readFileSync(filePath, 'utf8');
        const lines = code.split('\n');
        const searchPattern = new RegExp(`\\b${shortMethodName}\\s*\\(`, 'g');
        
        for (let i = 0; i < lines.length; i++) {
          if (searchPattern.test(lines[i])) {
            // Try to find containing method
            const containingMethod = this.extractContainingMethod(lines, i);
            if (containingMethod) {
              callers.push({
                file: filePath,
                method: containingMethod,
                line: i + 1
              });
            }
          }
        }
      } catch (fallbackError) {
        // Final fallback failed
      }
    }

    return callers;
  }

  /**
   * Helper to extract containing method name from code lines
   */
  private extractContainingMethod(lines: string[], lineIndex: number): string | undefined {
    // Look backward for method declaration
    for (let i = lineIndex; i >= 0; i--) {
      const line = lines[i];
      // Match: "methodName(" or "methodName {" or "async methodName"
      const methodMatch = line.match(/(?:async\s+)?(\w+)\s*(?:\(|\{)/);
      if (methodMatch) {
        return methodMatch[1];
      }
    }
    return undefined;
  }

  /**
   * Build deep call index using ts-morph with cross-file traversal
   * Replaces buildLocalCallIndex for local trace path
   */
  private async buildDeepCallIndexWithTsMorph(
    spine: Array<{ file: string; method: string }>,
    ctx: LocalContext,
    methodGraph: MethodExecutionGraph,
    opts: { maxHops?: number; maxNodes?: number } = {}
  ): Promise<LocalCallIndex> {
    const forward: LocalCallIndex["forward"] = {};
    const backward: LocalCallIndex["backward"] = {};

    // Extract workspace root from file paths
    let workspaceRoot = '';
    const entryPaths: string[] = [];
    
    // Collect entry paths from spine and context files
    for (const spineItem of spine) {
      if (spineItem.file && !entryPaths.includes(spineItem.file)) {
        entryPaths.push(spineItem.file);
      }
    }
    for (const file of ctx.files) {
      if (file.path && !entryPaths.includes(file.path)) {
        entryPaths.push(file.path);
      }
    }
    
    if (ctx.files.length > 0 && ctx.files[0].path) {
      workspaceRoot = path.dirname(ctx.files[0].path);
      // Try to find tsconfig.json or package.json parent
      let current = workspaceRoot;
      for (let i = 0; i < 10; i++) {
        if (fs.existsSync(path.join(current, 'tsconfig.json')) || 
            fs.existsSync(path.join(current, 'package.json'))) {
          workspaceRoot = current;
          break;
        }
        const parent = path.dirname(current);
        if (parent === current) break;
        current = parent;
      }
    }

    // Initialize ts-morph project
    try {
      this.getOrCreateTsMorphProject(workspaceRoot, entryPaths);
    } catch (error) {
      console.warn(`[GraphCompressor] Failed to initialize ts-morph project, falling back to Babel:`, error);
      // Fallback to existing buildLocalCallIndex
      return this.buildLocalCallIndex(ctx);
    }

    // Step 1: Deep forward traversal
    console.log(`[GraphCompressor] buildDeepCallIndexWithTsMorph: Starting deep traversal with spine:`, spine.map(s => `${s.file}::${s.method}`));
    const deepCallGraph = this.traverseCallsDeep(spine, workspaceRoot, {
      maxHops: opts.maxHops ?? 6,
      maxNodes: opts.maxNodes ?? 500,
      maxFiles: 50
    });

    console.log(`[GraphCompressor] buildDeepCallIndexWithTsMorph: Deep traversal returned ${deepCallGraph.size} methods`);
    
    // Build forward index from deep traversal (preserve line numbers and execution order)
    for (const [methodKey, calls] of deepCallGraph.entries()) {
      forward[methodKey] = calls.map(c => ({
        name: c.name,
        file: c.file,
        crossFile: c.crossFile,
        depth: c.depth,
        fullPath: c.fullPath,
        line: c.line,  // Preserve line number
        order: c.order,  // Preserve execution order
        label: c.edgeLabel
      }));
      if (calls.length > 0) {
        console.log(`[GraphCompressor]   Added ${calls.length} calls for key: ${methodKey}`);
      }
    }

    // Step 2: Backward tracking using findReferences
    const processedBackward = new Set<string>();
    for (const spineItem of spine) {
      const spineKey = this.methodKey(spineItem.file, spineItem.method);
      
      if (processedBackward.has(spineKey)) {
        continue;
      }

      try {
        const callers = this.findCallersWithTsMorph(
          spineItem.method,
          spineItem.file,
          workspaceRoot
        );

        // Track backward edges
        if (!backward[spineKey]) {
          backward[spineKey] = [];
        }

        for (const caller of callers.slice(0, 10)) { // Limit to 10 callers per method
          backward[spineKey].push({
            name: caller.method,
            file: caller.file,
            crossFile: caller.file !== spineItem.file,
            depth: 1, // Direct callers
            fullPath: undefined // Could be resolved if needed
          });

          // Also add reverse edge in forward index
          const callerKey = this.methodKey(caller.file, caller.method);
          if (!forward[callerKey]) {
            forward[callerKey] = [];
          }
          
          // Check if edge already exists
          const exists = forward[callerKey].some(c => 
            c.name === spineItem.method && c.file === spineItem.file
          );
          if (!exists) {
            forward[callerKey].push({
              name: spineItem.method,
              file: spineItem.file,
              crossFile: caller.file !== spineItem.file,
              depth: 0, // Direct call
              fullPath: undefined
            });
          }

          processedBackward.add(spineKey);
        }
      } catch (error) {
        console.warn(`[GraphCompressor] Failed to find callers for ${spineKey}:`, error);
      }
    }

    const totalForwardCalls = Object.values(forward).reduce((sum, calls) => sum + calls.length, 0);
    console.log(`[GraphCompressor] buildDeepCallIndexWithTsMorph: ${Object.keys(forward).length} methods with forward calls (${totalForwardCalls} total), ${Object.keys(backward).length} methods with backward calls`);
    
    // Log sample keys for debugging
    if (Object.keys(forward).length > 0) {
      const sampleKeys = Object.keys(forward).slice(0, 3);
      console.log(`[GraphCompressor] Sample forward keys: ${sampleKeys.join(', ')}`);
      for (const key of sampleKeys) {
        console.log(`[GraphCompressor]   ${key}: ${forward[key].length} calls`);
      }
    } else {
      console.warn(`[GraphCompressor] buildDeepCallIndexWithTsMorph: No forward calls found! Spine:`, spine.map(s => `${s.file}::${s.method}`));
    }
    
    return { forward, backward };
  }

  /**
   * Build local call index (forward and backward) from AST analysis
   * Includes cross-file resolution within LocalContext (LEGACY - kept as fallback)
   */
  private buildLocalCallIndex(ctx: LocalContext): LocalCallIndex {
    const forward: LocalCallIndex["forward"] = {};
    const backward: LocalCallIndex["backward"] = {};

    // 1. Build local symbol directory: shortName -> [file paths]
    // This enables cross-file resolution within LocalContext
    const localSymbols = new Map<string, string[]>();
    for (const f of ctx.files) {
      for (const m of f.methods) {
        const shortName = m.name.split('.').pop()!; // Get last part (handle A.B.C)
        if (!localSymbols.has(shortName)) {
          localSymbols.set(shortName, []);
        }
        localSymbols.get(shortName)!.push(f.path);
      }
    }

    // 2. Parse full files once (more reliable than snippets)
    const fileCallMaps = new Map<string, Map<number, Array<{ name: string; fullExpression?: string; isMethodCall: boolean; edgeLabel?: string }>>>();
    
    for (const file of ctx.files) {
      if (!file.path || !fs.existsSync(file.path)) continue;
      
      try {
        const stat = fs.statSync(file.path);
        // Parse full file if it's reasonable size (< 100KB)
        if (stat.size < 100_000) {
          const fullContent = fs.readFileSync(file.path, 'utf8');
          const callsWithLines = this.findLocalCallsInCodeWithLines(fullContent, file.path);
          
          // Debug: log full file parse results
          console.log(`[GraphCompressor] Parsed full file ${path.basename(file.path)}: found ${callsWithLines.length} total calls`);
          
          // Map calls to line numbers for filtering
          const callMap = new Map<number, Array<{ name: string; fullExpression?: string; isMethodCall: boolean; edgeLabel?: string }>>();
          for (const call of callsWithLines) {
            if (!callMap.has(call.line)) {
              callMap.set(call.line, []);
            }
            callMap.get(call.line)!.push({
              name: call.name,
              fullExpression: call.fullExpression,
              isMethodCall: call.isMethodCall,
              edgeLabel: call.edgeLabel
            });
          }
          fileCallMaps.set(file.path, callMap);
        }
      } catch (error) {
        // File parsing failed, will fall back to snippet parsing
        console.warn(`[GraphCompressor] Failed to parse full file ${file.path}:`, error);
      }
    }
    
    // 3. Build call indices
    for (const file of ctx.files) {
      for (const m of file.methods) {
        const srcKey = this.methodKey(file.path, m.name);
        
        // Get calls from full file parse if available, filtered by method line range
        let callResults: Array<{ name: string; fullExpression?: string; isMethodCall: boolean; crossFile?: boolean; edgeLabel?: string }>;
        
        const fileCallMap = file.path ? fileCallMaps.get(file.path) : undefined;
        if (fileCallMap && m.start && m.end) {
          // Filter calls that are within method line range
          const methodCalls: Array<{ name: string; fullExpression?: string; isMethodCall: boolean; edgeLabel?: string }> = [];
          for (let line = m.start; line <= m.end; line++) {
            const callsAtLine = fileCallMap.get(line) || [];
            methodCalls.push(...callsAtLine);
          }
          callResults = methodCalls;
          
          // Debug: log if we got calls from full file parse
          if (methodCalls.length > 0) {
            console.log(`[GraphCompressor] Found ${methodCalls.length} calls in ${file.path}#${m.name} via full file parse`);
          }
        } else {
          // Fallback to snippet parsing (with cleaning)
          callResults = this.findLocalCallsInCode(m.code, file.path, m.name);
          
          // Debug: log snippet parsing results
          if (callResults.length > 0) {
            console.log(`[GraphCompressor] Found ${callResults.length} calls in ${file.path}#${m.name} via snippet parse`);
          }
        }
        
        forward[srcKey] = [];

        for (const callResult of callResults) {
          const callName = callResult.name;
          
          // Try to resolve call to another file in LocalContext
          const candidates = localSymbols.get(callName);
          const targetFile = candidates?.[0]; // TODO: disambiguate if >1 candidate
          
          const isCrossFile = Boolean(targetFile && targetFile !== file.path);
          
          // Forward edge with cross-file hint
          forward[srcKey].push({
            name: callName,
            file: targetFile ?? file.path,
            crossFile: isCrossFile,
            label: callResult.edgeLabel
          });

          // Backward edge
          const dstKey = this.methodKey(targetFile ?? file.path, callName);
          if (!backward[dstKey]) backward[dstKey] = [];
          backward[dstKey].push({ name: m.name, file: file.path });
        }
      }
    }

    return { forward, backward };
  }

  /**
   * LLM: Rank calls for expansion (single call for all spine methods)
   * Prioritizes which branches are execution-flow relevant
   */
  private async llmRankCallsForExpansion(
    spine: Array<{ file: string; method: string }>,
    ctx: LocalContext,
    index: LocalCallIndex,
    llmConfig: NonNullable<GraphCompressorInput["llm"]> & { enabled: true }
  ): Promise<Record<string, Array<{ name: string; file?: string; reason: string; priority: 1 | 2 | 3 }>>> {
    const callId = `rank-${Date.now()}`;
    
    // Build prompt with spine methods and their AST-found calls
    let prompt = `You are analyzing a debugging pipeline. For each method I give you, I'll also give you the *actual* calls inside that method (already extracted from code).

Mark calls that are part of the **main execution / data / plan / slice / LLM** path as **priority 1**.
Mark calls that are helpers or utilities as **priority 3**.
Mark calls that are moderately important as **priority 2**.

Output JSON only:
{
  "filePath::methodName": [
    { "name": "...", "file": "...", "reason": "...", "priority": 1 }
  ]
}

Spine methods:\n`;

    for (const s of spine) {
      // Try to find matching key - spine might have basename or full path
      let key = this.methodKey(s.file, s.method);
      let calls = index.forward[key] || [];
      
      // If no calls found, try alternative key formats
      if (calls.length === 0) {
        // Try with full path if we have basename, or basename if we have full path
        const altKeys = [];
        if (s.file && !s.file.includes('/')) {
          // Spine has basename, try finding full path from ctx
          for (const file of ctx.files) {
            if (path.basename(file.path) === s.file) {
              altKeys.push(this.methodKey(file.path, s.method));
            }
          }
        } else if (s.file) {
          // Spine has full path, try basename
          altKeys.push(this.methodKey(path.basename(s.file), s.method));
        }
        
        for (const altKey of altKeys) {
          const altCalls = index.forward[altKey] || [];
          if (altCalls.length > 0) {
            key = altKey;
            calls = altCalls;
            console.log(`[GraphCompressor] Found calls using alternative key: "${altKey}" (${calls.length} calls)`);
            break;
          }
        }
      }
      
      console.log(`[GraphCompressor] llmRankCallsForExpansion: key="${key}", file="${s.file}", method="${s.method}", found ${calls.length} calls`);
      
      prompt += `\n${s.method} in ${s.file}:\n`;
      if (calls.length === 0) {
        prompt += `  (no calls found in method body)\n`;
      } else {
        for (const call of calls.slice(0, 20)) { // Limit to 20 calls per method
          const crossFileNote = call.crossFile ? ` [cross-file]` : '';
          prompt += `  - ${call.name}${crossFileNote}\n`;
        }
      }
    }

    try {
      const response = await this.llmProvider.chat({
        id: callId,
        provider: '',
        model: llmConfig.model,
        messages: [
          {
            role: 'user',
            content: prompt
          }
        ],
        temperature: llmConfig.temperature ?? 0.3,
        maxTokens: llmConfig.maxTokens ?? 8000,
        metadata: {},
        createdAt: new Date(),
        updatedAt: new Date()
      });

      if (response.type !== 'success' || !response.payload) {
        console.warn(`[GraphCompressor] llmRankCallsForExpansion failed for call ${callId}`);
        return {};
      }

      const llmResponse = response.payload;
      if ('error' in llmResponse) {
        console.warn(`[GraphCompressor] llmRankCallsForExpansion LLM error (${callId}):`, llmResponse.error);
        return {};
      }

      // llmResponse is LLMResponse at this point
      const content = llmResponse.content || '';
      
      // Parse JSON
      const jsonMatch = content.match(/```(?:json)?\s*(\{[\s\S]*\})\s*```/);
      const jsonStr = jsonMatch ? jsonMatch[1] : content.trim();
      
      try {
        const parsed = JSON.parse(jsonStr);
        // Return the parsed ranking
        return parsed as Record<string, Array<{ name: string; file?: string; reason: string; priority: 1 | 2 | 3 }>>;
      } catch (parseError) {
        console.warn(`[GraphCompressor] Failed to parse ranking response for call ${callId}:`, parseError);
        return {};
      }
    } catch (error) {
      console.warn(`[GraphCompressor] llmRankCallsForExpansion failed for call ${callId}:`, error);
      return {};
    }
  }

  /**
   * LLM: Filter dense graph to keep only important execution paths
   * Single LLM call to identify which edges are relevant to debugging
   */
  private async llmFilterImportantPaths(
    edges: Array<{
      from: { file: string | undefined; method: string };
      to: { file: string | undefined; method: string };
      kind: "forward" | "backward" | "loop";
      depth: number;
      evidence: string[];
    }>,
    focus: GraphCompressorInput["focus"],
    llmConfig: NonNullable<GraphCompressorInput["llm"]> & { enabled: true }
  ): Promise<Array<{
    from: { file: string | undefined; method: string };
    to: { file: string | undefined; method: string };
    kind: "forward" | "backward" | "loop";
    depth: number;
    evidence: string[];
  }>> {
    const callId = `filter-${Date.now()}`;
    
    // Build unique set of nodes from edges
    const nodeSet = new Set<string>();
    for (const edge of edges) {
      const fromKey = this.methodKey(edge.from.file, edge.from.method);
      const toKey = this.methodKey(edge.to.file, edge.to.method);
      nodeSet.add(fromKey);
      nodeSet.add(toKey);
    }
    
    // Build edge list with readable IDs
    const edgeList = edges.slice(0, 300).map((edge, idx) => {
      const fromKey = this.methodKey(edge.from.file, edge.from.method);
      const toKey = this.methodKey(edge.to.file, edge.to.method);
      return {
        edgeId: `e${idx}`,
        from: fromKey,
        to: toKey,
        kind: edge.kind,
        depth: edge.depth,
        evidence: edge.evidence.join(', ')
      };
    });
    
    // Build prompt
    const entryMethods = focus.entrySymbols?.map(s => s.name).join(', ') || 'unknown';
    const errorFrames = focus.errorFrames?.slice(0, 5).map(f => `${f.file}:${f.line}`).join(', ') || 'unknown';
    
    let prompt = `You are analyzing a complete call graph for debugging. The graph is dense (${edges.length} edges, ${nodeSet.size} nodes).

Entry methods: ${entryMethods}
Error locations: ${errorFrames}

Your task: Identify which edges form the **most important execution paths** from entry → error. Keep only edges that are:
1. Directly on the main execution path (entry → core logic → error)
2. Critical callers (backward edges) that lead to entry
3. Key helper methods called by main path methods
4. Cross-file edges that connect important modules

Filter out:
- Low-level utility calls (priority 3)
- Deep recursive paths (depth > 8)
- Unimportant backward edges (not called by entry path)
- Isolated nodes not connected to entry or error

Edge list (${edgeList.length} edges):
`;
    
    for (const edge of edgeList) {
      prompt += `\n${edge.edgeId}: ${edge.from} --[${edge.kind}, depth:${edge.depth}]--> ${edge.to} (evidence: ${edge.evidence})`;
    }
    
    prompt += `\n\nOutput JSON only with edgeIds to keep:
{
  "keepEdges": ["e0", "e1", "e2", ...]
}`;

    try {
      const response = await this.llmProvider.chat({
        id: callId,
        provider: '',
        model: llmConfig.model,
        messages: [
          {
            role: 'user',
            content: prompt
          }
        ],
        temperature: llmConfig.temperature ?? 0.3,
        maxTokens: llmConfig.maxTokens ?? 8000,
        metadata: {},
        createdAt: new Date(),
        updatedAt: new Date()
      });

      if (response.type !== 'success' || !response.payload) {
        console.warn(`[GraphCompressor] llmFilterImportantPaths failed for call ${callId}`);
        return edges; // Return original edges if LLM fails
      }

      const llmResponse = response.payload;
      if ('error' in llmResponse) {
        console.warn(`[GraphCompressor] llmFilterImportantPaths LLM error (${callId}):`, llmResponse.error);
        return edges; // Return original edges if LLM error
      }

      // llmResponse is LLMResponse at this point
      const content = llmResponse.content || '';
      
      // Parse JSON
      const jsonMatch = content.match(/```(?:json)?\s*(\{[\s\S]*\})\s*```/);
      const jsonStr = jsonMatch ? jsonMatch[1] : content.trim();
      
      try {
        const parsed = JSON.parse(jsonStr);
        const keepEdgeIds = new Set<string>(parsed.keepEdges || []);
        
        // Build set of entry/spine method keys using names from entrySymbols
        const entryKeys = new Set<string>();
        const entryNames = new Set<string>();
        if (focus.entrySymbols) {
          for (const entry of focus.entrySymbols) {
            if (entry.name) {
              entryNames.add(entry.name);
              // Try multiple key formats for matching
              entryKeys.add(this.methodKey('unknown', entry.name)); // fallback key
              // Also try with basename extraction
              if (entry.name.includes('.')) {
                const className = entry.name.split('.')[0];
                const methodName = entry.name.split('.').slice(1).join('.');
                entryKeys.add(this.methodKey('unknown', methodName));
              }
            }
          }
        }
        
        // Filter edges based on LLM selection
        const filtered = edges.filter((edge, idx) => {
          const edgeId = `e${idx}`;
          const fromKey = this.methodKey(edge.from.file, edge.from.method);
          const toKey = this.methodKey(edge.to.file, edge.to.method);
          
          // Always keep spine edges (depth 0 or evidence includes "structural-spine")
          if (edge.depth === 0 || edge.evidence.includes('structural-spine')) {
            return true;
          }
          
          // Always keep edges connecting spine/entry methods
          // Check by key match or by name match
          const fromMethodName = edge.from.method;
          const toMethodName = edge.to.method;
          const matchesEntry = entryNames.has(fromMethodName) || 
                              entryNames.has(toMethodName) ||
                              entryNames.has(edge.from.file ? `${edge.from.file}::${fromMethodName}` : fromMethodName) ||
                              entryNames.has(edge.to.file ? `${edge.to.file}::${toMethodName}` : toMethodName);
          
          if (matchesEntry || entryKeys.has(fromKey) || entryKeys.has(toKey)) {
            return true;
          }
          
          // Always keep edges that are part of deep chains from spine/entry methods (depth <= 3 from entry)
          // This ensures deep calls from extractForDebugging and similar methods are traced
          if (edge.depth <= 3 && (edge.evidence.includes('ast-forward') || edge.evidence.includes('cross-file'))) {
            return true;
          }
          
          // Keep if LLM selected it
          return keepEdgeIds.has(edgeId);
        });
        
        console.log(`[GraphCompressor] llmFilterImportantPaths: filtered ${edges.length} → ${filtered.length} edges (kept ${filtered.length - edges.length + filtered.length} spine edges)`);
        return filtered;
      } catch (parseError) {
        console.warn(`[GraphCompressor] Failed to parse filter response for call ${callId}:`, parseError);
        return edges; // Return original edges if parsing fails
      }
    } catch (error) {
      console.warn(`[GraphCompressor] llmFilterImportantPaths failed for call ${callId}:`, error);
      return edges; // Return original edges on error
    }
  }

  /**
   * Helper: Check if a method key is in the spine
   */
  private isSpineMethod(key: string, spine: Array<{ file: string; method: string }>): boolean {
    return spine.some(s => this.methodKey(s.file, s.method) === key);
  }

  /**
   * Helper: Check if we should expand backward (only if ranked as important)
   */
  private shouldExpandBackward(
    key: string,
    ranked: Record<string, Array<{ name: string; file?: string; priority: 1 | 2 | 3 }>>
  ): boolean {
    const rankedCalls = ranked[key];
    if (!rankedCalls || rankedCalls.length === 0) return false;
    // Expand if any call has priority <= 2
    return rankedCalls.some(r => r.priority <= 2);
  }

  /**
   * Walk like human: AST-driven BFS that expands only priority 1-2 nodes
   */
  private walkLikeHuman(opts: {
    spine: Array<{ file: string; method: string }>;
    ctx: LocalContext;
    index: LocalCallIndex;
    ranked: Record<string, Array<{ name: string; file?: string; priority: 1 | 2 | 3 }>>;
    maxHops?: number;          // e.g. 6
    maxNodes?: number;         // e.g. 200
  }): Array<{
    from: { file: string | undefined; method: string };
    to: { file: string | undefined; method: string };
    kind: "forward" | "backward" | "loop";
    depth: number;
    evidence: string[];
    line?: number;  // Line number where call occurs
    order?: number;  // Execution order within method
    label?: string;
  }> {
    const maxHops = opts.maxHops ?? 6;
    const maxNodes = opts.maxNodes ?? 200;
    const q: Array<{ file?: string; method: string; depth: number }> = [];
    const seen = new Set<string>();
    const edges: Array<{
      from: { file: string | undefined; method: string };
      to: { file: string | undefined; method: string };
      kind: "forward" | "backward" | "loop";
      depth: number;
      evidence: string[];
      line?: number;  // Line number where call occurs
      order?: number;  // Execution order within method
      label?: string;
    }> = [];

    // Seed with spine
    for (const s of opts.spine) {
      q.push({ file: s.file, method: s.method, depth: 0 });
      seen.add(this.methodKey(s.file, s.method));
    }

    while (q.length && edges.length < maxNodes) {
      // Prioritize deeper items first (depth-first exploration for spine methods)
      // Only sort when needed (when queue has mixed spine/regular items)
      if (q.length > 1 && q.some(item => {
        const key = this.methodKey(item.file || '', item.method);
        return this.isSpineMethod(key, opts.spine) && item.depth > 0;
      })) {
        q.sort((a, b) => {
          const aKey = this.methodKey(a.file || '', a.method);
          const bKey = this.methodKey(b.file || '', b.method);
          const aIsSpine = this.isSpineMethod(aKey, opts.spine);
          const bIsSpine = this.isSpineMethod(bKey, opts.spine);
          if (aIsSpine && !bIsSpine) return -1;
          if (!aIsSpine && bIsSpine) return 1;
          // For spine methods, prioritize deeper items; for others, use FIFO (breadth-first)
          if (aIsSpine) return b.depth - a.depth; // Deeper first for spine
          return 0; // FIFO for regular methods
        });
      }
      const cur = q.shift()!;
      let curKey = this.methodKey(cur.file, cur.method);
      
      // Try to find matching key in index (might be basename or full path)
      let fwd = opts.index.forward[curKey] || [];
      let rankedForCur = opts.ranked[curKey] || [];
      
      // If no match, try alternative keys
      if (fwd.length === 0 || rankedForCur.length === 0) {
        // Try with full path if we have basename
        if (cur.file && !cur.file.includes('/')) {
          for (const file of opts.ctx.files) {
            if (path.basename(file.path) === cur.file) {
              const altKey = this.methodKey(file.path, cur.method);
              const altFwd = opts.index.forward[altKey] || [];
              const altRanked = opts.ranked[altKey] || [];
              if (altFwd.length > 0 || altRanked.length > 0) {
                curKey = altKey;
                fwd = altFwd;
                rankedForCur = altRanked;
                break;
              }
            }
          }
        } else if (cur.file) {
          // Try with basename if we have full path
          const altKey = this.methodKey(path.basename(cur.file), cur.method);
          const altFwd = opts.index.forward[altKey] || [];
          const altRanked = opts.ranked[altKey] || [];
          if (altFwd.length > 0 || altRanked.length > 0) {
            curKey = altKey;
            fwd = altFwd;
            rankedForCur = altRanked;
          }
        }
      }
      
      const priorityByName = new Map(
        rankedForCur.map(r => [r.name, r.priority])
      );
      
      console.log(`[GraphCompressor] walkLikeHuman: key="${curKey}", found ${fwd.length} forward calls, ${rankedForCur.length} ranked calls`);

      for (const callee of fwd) {
        const calleeKey = this.methodKey(callee.file, callee.name);
        const priority = priorityByName.get(callee.name) ?? 3;
        
        // Use depth from deep index if available, otherwise calculate from current depth
        const calleeDepth = callee.depth !== undefined ? callee.depth : cur.depth + 1;

        // Build evidence array with cross-file hint and depth if applicable
        const evidence: string[] = ["ast-forward", `p${priority}`];
        if (callee.crossFile) {
          evidence.push("cross-file");
        }
        if (calleeDepth > 0) {
          evidence.push(`depth-${calleeDepth}`);
        }
        if (callee.line !== undefined) {
          evidence.push(`line-${callee.line}`);
        }
        if (callee.order !== undefined) {
          evidence.push(`order-${callee.order}`);
        }

        edges.push({
          from: { file: cur.file, method: cur.method },
          to: { file: callee.file, method: callee.name },
          kind: "forward",
          depth: calleeDepth,
          evidence,
          line: callee.line,  // Preserve line number
          order: callee.order,  // Preserve execution order
          label: callee.label
        });

        // Expand only important ones and respect depth limit from deep index
        // For spine methods, expand ALL calls (priority 1-3); for regular methods, only priority 1-2
        const curKey = this.methodKey(cur.file || '', cur.method);
        const isCurrentSpine = this.isSpineMethod(curKey, opts.spine);
        const priorityThreshold = isCurrentSpine ? 3 : 2; // Spine methods: expand all, regular: only p1-2
        
        // Use calleeDepth (from index) for expansion check, not cur.depth + 1
        // This allows expansion of deeper calls from the index
        const shouldExpand = calleeDepth <= maxHops && 
                             priority <= priorityThreshold && 
                             !seen.has(calleeKey);
        if (shouldExpand) {
          seen.add(calleeKey);
          q.push({ file: callee.file, method: callee.name, depth: calleeDepth });
        }

        // Loop detection: if callee is in spine
        if (priority <= 2 && this.isSpineMethod(calleeKey, opts.spine)) {
          edges.push({
            from: { file: cur.file, method: cur.method },
            to: { file: callee.file, method: callee.name },
            kind: "loop",
            depth: cur.depth + 1,
            evidence: ["ast-loop"]
          });
        }
      }

      // 2) Backward from AST/deep index
      const bwd = opts.index.backward[curKey] || [];
      for (const caller of bwd) {
        const callerKey = this.methodKey(caller.file, caller.name);
        
        // Use depth from deep index if available
        const callerDepth = caller.depth !== undefined ? caller.depth : Math.max(0, cur.depth - 1);
        
        const evidence: string[] = ["ast-backward"];
        if (caller.crossFile) {
          evidence.push("cross-file");
        }
        if (callerDepth > 0) {
          evidence.push(`depth-${callerDepth}`);
        }

        edges.push({
          from: { file: caller.file, method: caller.name },
          to: { file: cur.file, method: cur.method },
          kind: "backward",
          depth: callerDepth,
          evidence
        });

        // Expand backward only if ranked as important and within depth limit
        const shouldExpandBackward = !seen.has(callerKey) && 
                                     this.shouldExpandBackward(callerKey, opts.ranked) &&
                                     callerDepth >= 0 &&
                                     cur.depth + 1 <= maxHops;
        if (shouldExpandBackward) {
          seen.add(callerKey);
          q.push({ file: caller.file, method: caller.name, depth: Math.max(0, cur.depth - 1) });
        }
      }
    }

    return edges;
  }
}

/**
 * Convert compressed graph output to MethodExecutionGraph format for StaticSlicer
 * @param compressed - The compressed graph output
 * @param originalGraph - Optional original graph to preserve symbol metadata
 */
export function convertCompressedToMethodGraph(
  compressed: GraphCompressorOutput,
  originalGraph?: MethodExecutionGraph
): MethodExecutionGraph {
  // Build symbol map from original graph if available
  const symbolById = originalGraph
    ? new Map(originalGraph.symbols.map(s => [s.id, s]))
    : new Map<string, SymbolDef>();

  const symbols = compressed.nodes
    .filter((n: { kind: string }) => n.kind !== "group")
    .map((n: { id: string; label: string; file?: string; kind: string; line?: number }) => {
      // Try to find original symbol to preserve metadata
      const original = symbolById.get(n.id);
      if (original) {
        return original;
      }

      // Fallback: create minimal symbol
      return {
        id: n.id,
        name: n.label,
        file: n.file ?? "",
        startLine: n.line ?? 1,
        endLine: n.line ?? 1,
        kind: (n.kind === "symbol" ? "function" : "variable") as "function" | "method" | "class" | "variable" | "namespace"
      };
    });

  const symbolEdges = compressed.edges.map(e => ({
    callerId: e.from,
    calleeId: e.to,
    file: "",
    confidence: e.confidence,
    via: (() => {
      if (!e.evidence || e.evidence.length === 0) return "ts-checker" as const;
      if (e.evidence.includes('llm-recovered')) return "llm-polish" as const;
      // llm-suggested edges are not real calls, treat as ts-checker
      if (e.evidence.includes('llm-suggested')) return "ts-checker" as const;
      return "ts-checker" as const;
    })()
  }));

  const files = [...new Set(compressed.nodes.filter(n => n.file).map(n => n.file!))];

  return {
    symbols,
    symbolEdges,
    files,
    fileEdges: originalGraph?.fileEdges || [] // Preserve original file edges
  };
}