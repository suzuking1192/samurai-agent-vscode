/**
 * LLM Graph Polisher for debugging code extraction
 * 
 * Takes static, deterministic graphs and refines them using LLM analysis
 * Adds missing hops, fixes directions, and tags suspicious nodes
 * Operates with strict safety guardrails to prevent hallucination
 */

import { 
  GraphNode, 
  GraphEdge, 
  Evidence 
} from './types';

// Input DTO for LLM polishing
export interface GraphPolishInput {
  graph: {
    nodes: Array<{
      id: string;
      kind: string;
      label: string;
      file?: string;
      line?: number;
      badges?: string[];
    }>;
    edges: Array<{
      from: string;
      to: string;
      kind: string;
      confidence: number;
      evidence?: string[];
      label?: string;
    }>;
  };
  codeSnippets: Array<{
    file: string;
    snippet: string;
    reason: string;
  }>;
  astFacts: Array<{
    file: string;
    exports?: string[];
    imports?: Array<{ from: string; kind: 'import' | 'reexport' | 'dynamicImport' }>;
    routes?: string[];
  }>;
  evidence: {
    frames: Array<{ file: string; line: number; method?: string }>;
    route?: string;
    logSignatures?: string[];
  };
  whitelistNodeIds: string[];
  repoHints?: {
    style?: 'nextjs' | 'express' | 'react' | 'node-lib';
    srcRoot?: string;
  };
}

// Output patch from LLM
export interface GraphPolishPatch {
  addEdges?: Array<{
    from: string;
    to: string;
    kind: string;
    reason: string;
  }>;
  dropEdges?: Array<{
    from: string;
    to: string;
    kind?: string;
    reason: string;
  }>;
  relabel?: Array<{
    id: string;
    addBadges?: ('error' | 'suspicious' | 'lowConfidence' | 'routeHandler')[];
  }>;
  notes?: string[];
}

export interface LLMConfig {
  model: string;
  temperature: number;
  maxTokens: number;
}

export class GraphPolisher {
  /**
   * Check if polishing should be triggered
   */
  public static shouldTriggerPolish(
    nodes: GraphNode[],
    edges: GraphEdge[],
    evidence?: Evidence
  ): boolean {
    const density = edges.length / Math.max(1, nodes.length);
    
    // Trigger if low density
    if (density < 0.4) return true;
    
    // Trigger if tiny graph
    if (nodes.length < 8) return true;
    
    // Trigger if missing imports warning is set
    if (evidence?.warnings?.some(w => w.toLowerCase().includes('import'))) return true;
    
    // Trigger if circular imports detected
    const hasCircularImports = edges.some(e => 
      e.kind === 'imports' && nodes.some(n => 
        n.id === e.from && n.badges?.includes('suspicious')
      )
    );
    if (hasCircularImports) return true;
    
    // Check for routing mentions but no routes
    const hasRouteMentions = JSON.stringify(evidence).toLowerCase().includes('route') &&
      !edges.some(e => e.kind === 'calls' && e.from.includes('route'));
    if (hasRouteMentions) return true;
    
    return false;
  }

  /**
   * Compress graph for LLM - limit size and focus on relevant subgraph
   */
  public static compressGraphForLLM(
    nodes: GraphNode[],
    edges: GraphEdge[],
    maxNodes: number = 40,
    maxEdges: number = 60,
    focusNodeId?: string
  ): { nodes: GraphNode[]; edges: GraphEdge[] } {
    if (nodes.length <= maxNodes && edges.length <= maxEdges) {
      return { nodes, edges };
    }
    
    // If we have a focus node, keep nodes within 2 hops
    if (focusNodeId) {
      return this.extractSubgraph(nodes, edges, focusNodeId, 2, maxNodes, maxEdges);
    }
    
    // Otherwise, keep nodes with most edges (importance heuristic)
    const nodeImportance = new Map<string, number>();
    for (const edge of edges) {
      const fromCount = nodeImportance.get(edge.from) || 0;
      const toCount = nodeImportance.get(edge.to) || 0;
      nodeImportance.set(edge.from, fromCount + 1);
      nodeImportance.set(edge.to, toCount + 1);
    }
    
    const topNodes = Array.from(nodeImportance.entries())
      .sort((a, b) => b[1] - a[1])
      .slice(0, maxNodes)
      .map(([id]) => id);
    
    const nodeSet = new Set(topNodes);
    const filteredNodes = nodes.filter(n => nodeSet.has(n.id));
    const filteredEdges = edges.filter(e => 
      nodeSet.has(e.from) && nodeSet.has(e.to)
    ).slice(0, maxEdges);
    
    return { nodes: filteredNodes, edges: filteredEdges };
  }

  /**
   * Extract subgraph around a focal node
   */
  private static extractSubgraph(
    nodes: GraphNode[],
    edges: GraphEdge[],
    focusId: string,
    maxHops: number,
    maxNodes: number,
    maxEdges: number
  ): { nodes: GraphNode[]; edges: GraphEdge[] } {
    const nodeMap = new Map(nodes.map(n => [n.id, n]));
    const edgeMap = new Map<string, GraphEdge[]>();
    
    for (const edge of edges) {
      if (!edgeMap.has(edge.from)) edgeMap.set(edge.from, []);
      edgeMap.get(edge.from)!.push(edge);
    }
    
    const visited = new Set<string>([focusId]);
    const frontier = [focusId];
    let currentHop = 0;
    
    // BFS from focus node
    while (frontier.length > 0 && currentHop < maxHops && visited.size < maxNodes) {
      const levelSize = frontier.length;
      currentHop++;
      
      for (let i = 0; i < levelSize; i++) {
        const nodeId = frontier.shift()!;
        const neighbors = edgeMap.get(nodeId) || [];
        
        for (const edge of neighbors) {
          if (!visited.has(edge.to) && visited.size < maxNodes) {
            visited.add(edge.to);
            frontier.push(edge.to);
          }
        }
      }
    }
    
    const filteredNodes = nodes.filter(n => visited.has(n.id));
    const filteredEdges = edges.filter(e => 
      visited.has(e.from) && visited.has(e.to)
    ).slice(0, maxEdges);
    
    return { nodes: filteredNodes, edges: filteredEdges };
  }

  /**
   * Call LLM to generate polish patch
   */
  public static async callLLMPolisher(
    input: GraphPolishInput,
    llmConfig: LLMConfig
  ): Promise<GraphPolishPatch> {
    // TODO: Implement actual LLM call
    // For now, return empty patch to avoid external dependencies
    // In production, this would:
    // 1. Format system prompt describing the task
    // 2. Format user prompt with compressed graph + snippets
    // 3. Call LLM API with structured output request
    // 4. Parse JSON response
    // 5. Validate against whitelist
    
    console.log('[GraphPolisher] LLM polishing not yet implemented, returning empty patch');
    
    return {
      addEdges: [],
      dropEdges: [],
      relabel: [],
      notes: []
    };
  }

  /**
   * Apply polish patch to graph with safety checks
   */
  public static applyGraphPolish(
    base: { nodes: GraphNode[]; edges: GraphEdge[] },
    patch: GraphPolishPatch,
    whitelist: Set<string>
  ): { nodes: GraphNode[]; edges: GraphEdge[] } {
    const nodes = [...base.nodes];
    const edges = [...base.edges];
    
    // 1. Add edges with whitelist verification
    for (const add of patch.addEdges ?? []) {
      if (!whitelist.has(add.from) || !whitelist.has(add.to)) {
        console.warn('[GraphPolisher] Skipping addEdge for non-whitelisted node:', add);
        continue;
      }
      
      // Don't override high-confidence static edges
      const existing = edges.find(e => 
        e.from === add.from && e.to === add.to && e.kind === add.kind
      );
      if (existing && existing.confidence > 0.7) {
        continue;
      }
      
      edges.push({
        from: add.from,
        to: add.to,
        kind: add.kind as any,
        confidence: 0.35,
        evidence: ['llmPolish', ...(add.reason ? [add.reason] : [])]
      });
    }
    
    // 2. Drop edges
    for (const drop of patch.dropEdges ?? []) {
      const idx = edges.findIndex(e => 
        e.from === drop.from && 
        e.to === drop.to && 
        (!drop.kind || e.kind === drop.kind)
      );
      if (idx >= 0) {
        edges.splice(idx, 1);
      }
    }
    
    // 3. Relabel nodes
    for (const rel of patch.relabel ?? []) {
      const node = nodes.find(n => n.id === rel.id);
      if (!node) continue;
      
      if (rel.addBadges?.length) {
        node.badges = Array.from(new Set([...(node.badges || []), ...rel.addBadges]));
      }
    }
    
    return { nodes, edges };
  }

  /**
   * Main polish function that orchestrates the process
   */
  public static async polish(
    graph: { nodes: GraphNode[]; edges: GraphEdge[] },
    evidence: Evidence,
    codeSnippets: Array<{ file: string; snippet: string; reason: string }>,
    whitelist: string[],
    llmConfig: LLMConfig
  ): Promise<{ nodes: GraphNode[]; edges: GraphEdge[]; notes: string[] }> {
    // Check if should trigger
    if (!this.shouldTriggerPolish(graph.nodes, graph.edges, evidence)) {
      return { nodes: graph.nodes, edges: graph.edges, notes: [] };
    }
    
    // Compress graph for LLM
    const errorNodeId = graph.nodes.find(n => 
      n.badges?.includes('error') || evidence.frames.some(f => f.file === n.file)
    )?.id;
    
    const compressed = this.compressGraphForLLM(
      graph.nodes, 
      graph.edges,
      40,
      60,
      errorNodeId
    );
    
    // Prepare input
    const input: GraphPolishInput = {
      graph: {
        nodes: compressed.nodes.map(n => ({
          id: n.id,
          kind: n.kind,
          label: n.label,
          file: n.file,
          line: n.line,
          badges: n.badges
        })),
        edges: compressed.edges.map(e => ({
          from: e.from,
          to: e.to,
          kind: e.kind,
          confidence: e.confidence,
          evidence: e.evidence,
          label: e.label
        }))
      },
      codeSnippets,
      astFacts: [],
      evidence: {
        frames: evidence.frames,
        route: evidence.route,
        logSignatures: evidence.logSignatures
      },
      whitelistNodeIds: whitelist
    };
    
    // Call LLM
    const patch = await this.callLLMPolisher(input, llmConfig);
    
    // Apply patch
    const whitelistSet = new Set(whitelist);
    const polished = this.applyGraphPolish(graph, patch, whitelistSet);
    
    return {
      nodes: polished.nodes,
      edges: polished.edges,
      notes: patch.notes || []
    };
  }
}
