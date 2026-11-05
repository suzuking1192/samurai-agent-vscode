/**
 * Static Slicer for debugging code extraction
 * 
 * Builds bounded slices with priority-guided expansion, runtime overlay, and safe LLM refinement
 * Implements sophisticated graph analysis with evidence-based prioritization
 */

import * as path from 'path';
import { 
  Evidence, 
  CandidateFile, 
  CandidateSymbolRef, 
  GraphNode, 
  GraphEdge, 
  RootSpec, 
  SliceLimits,
  TsProgram,
  ImportExportRelation,
  CallRelation,
  MethodExecutionGraph
} from './types';

// Enhanced interfaces for better functionality
interface FrontierItem {
  node: GraphNode;
  priority: number;
  depth: number;
  from?: string;
  via?: GraphEdge;
}

interface RuntimeOverlay {
  anchors: Array<{
    nodeId: string;
    file: string;
    line: number;
    logId?: string;
    why: string[];
  }>;
  failNodeId?: string;
  failReasons?: string[];
}

interface GraphPatch {
  addEdges?: Array<{
    from: string;
    to: string;
    kind: 'imports' | 'exports' | 'calls' | 'dynamicImport' | 'logFlow' | 'runtimePath';
    reason: string;
  }>;
  dropEdges?: Array<{
    from: string;
    to: string;
    reason: string;
  }>;
  raiseConfidence?: Array<{
    from: string;
    to: string;
    delta: number;
    reason: string;
  }>;
  relabel?: Array<{
    id: string;
    addBadges?: ('error' | 'suspicious' | 'lowConfidence' | 'routeHandler')[];
  }>;
}

interface LLMConfig {
  model: string;
  temperature: number;
  maxTokens: number;
}

export class StaticSlicer {
  private readonly defaultLimits: SliceLimits = {
    maxNodes: 50,
    maxDepth: 5,
    confidenceThreshold: 0.2
  };

  /**
   * Build static slice with priority-guided expansion and runtime overlay
   */
  public buildSlice(
    roots: RootSpec,
    importRelations: ImportExportRelation[],
    callRelations: CallRelation[],
    limits: SliceLimits = this.defaultLimits,
    evidence?: Evidence,
    llmConfig?: LLMConfig,
    whitelist?: string[],
    methodGraph?: MethodExecutionGraph
  ): { nodes: GraphNode[]; edges: GraphEdge[]; runtime?: RuntimeOverlay } {
    // 1) Create nodes/edges with priority expansion
    // Prioritize symbol-level graph if available
    const { nodes, edges } = methodGraph && methodGraph.symbolEdges.length > 0
      ? this.expandSliceWithPriorityAndSymbols(
          roots,
          importRelations,
          callRelations,
          limits,
          evidence,
          methodGraph
        )
      : this.expandSliceWithPriority(
          roots,
          importRelations,
          callRelations,
          limits,
          evidence
        );

    // 2) Align logs → runtime overlay
    const overlay = evidence ? this.alignLogsToGraph(evidence, nodes, edges) : undefined;

    // 3) Optional LLM refinement with verification
    let finalNodes = nodes;
    let finalEdges = edges;
    
    if (llmConfig && whitelist?.length) {
      const refined = this.refineGraphWithLLM(
        { nodes, edges },
        overlay,
        whitelist,
        llmConfig
      );
      finalNodes = refined.nodes;
      finalEdges = refined.edges;
    }

    // 4) Prune dominated edges and cap fanout
    const prunedEdges = this.pruneDominatedEdges(finalEdges, limits.confidenceThreshold);

    // 5) Apply heuristics and tag badges
    this.applyHeuristics(new Map(finalNodes.map(n => [n.id, n])), prunedEdges, roots);

    // 6) Graph quality diagnostics
    const density = prunedEdges.length / Math.max(1, finalNodes.length);
    if (density < 0.4) {
      console.warn('[StaticSlicer] Low graph density detected:', {
        nodes: finalNodes.length,
        edges: prunedEdges.length,
        density: density.toFixed(2),
        imports: importRelations.length,
        calls: callRelations.length
      });
    }

    return {
      nodes: finalNodes,
      edges: prunedEdges,
      runtime: overlay
    };
  }

  /**
   * Priority-guided slice expansion with symbol-level graph
   */
  private expandSliceWithPriorityAndSymbols(
    roots: RootSpec,
    importRelations: ImportExportRelation[],
    callRelations: CallRelation[],
    limits: SliceLimits,
    evidence: Evidence | undefined,
    methodGraph: MethodExecutionGraph
  ): { nodes: GraphNode[]; edges: GraphEdge[] } {
    const nodes = new Map<string, GraphNode>();
    const edges: GraphEdge[] = [];
    const seen = new Set<string>();
    
    // Build symbol index by ID
    const symbolById = new Map<string, typeof methodGraph.symbols[0]>();
    for (const symbol of methodGraph.symbols) {
      symbolById.set(symbol.id, symbol);
    }
    
    // Build symbol call index
    const symbolCallsByCaller = new Map<string, (typeof methodGraph.symbolEdges[0])[]>();
    for (const call of methodGraph.symbolEdges) {
      if (!symbolCallsByCaller.has(call.callerId)) {
        symbolCallsByCaller.set(call.callerId, []);
      }
      symbolCallsByCaller.get(call.callerId)!.push(call);
    }
    
    // Build file import index
    const normalizePath = (filePath: string): string => {
      if (!filePath) return '';
      try {
        const isAbsolute = path.isAbsolute(filePath);
        const normalized = isAbsolute ? path.normalize(filePath) : path.resolve(filePath);
        return normalized.replace(/\\/g, '/');
      } catch {
        return filePath.replace(/\\/g, '/');
      }
    };
    
    const idxByFrom = new Map<string, ImportExportRelation[]>();
    for (const rel of importRelations) {
      const normalized = normalizePath(rel.from);
      if (!idxByFrom.has(normalized)) {
        idxByFrom.set(normalized, []);
      }
      idxByFrom.get(normalized)!.push(rel);
    }
    
    // Priority queue
    const pq: FrontierItem[] = [];
    const heapPush = (item: FrontierItem) => {
      pq.push(item);
      this.heapifyUp(pq, pq.length - 1);
    };
    const heapPop = (): FrontierItem | undefined => {
      if (pq.length === 0) return undefined;
      const top = pq[0];
      pq[0] = pq[pq.length - 1];
      pq.pop();
      if (pq.length > 0) this.heapifyDown(pq, 0);
      return top;
    };
    
    // Initialize with root nodes - prioritize symbols
    const rootNodes: GraphNode[] = [];
    const errorFiles = new Set(roots.errorFrames.map(f => f.file));
    
    // Add error frame nodes
    for (const frame of roots.errorFrames) {
      const nodeId = `file:${frame.file}`;
      rootNodes.push({
        id: nodeId,
        kind: 'file',
        label: this.getFileName(frame.file),
        file: frame.file,
        line: frame.line,
        badges: ['error']
      });
    }
    
    // Add symbol nodes from topSymbols
    for (const symbolRef of roots.topSymbols) {
      const symbolId = `symbol:${symbolRef.file}:${symbolRef.symbol}`;
      const symbol = symbolById.get(symbolId);
      if (symbol) {
        rootNodes.push({
          id: symbol.id,
          kind: 'symbol',
          label: symbol.name,
          file: symbol.file,
          line: symbol.startLine,
          badges: []
        });
      } else {
        rootNodes.push({
          id: symbolId,
          kind: 'symbol',
          label: symbolRef.symbol,
          file: symbolRef.file,
          line: symbolRef.startLine,
          badges: []
        });
      }
    }
    
    // Add user mention nodes
    for (const mention of roots.userMentions) {
      rootNodes.push({
        id: `mention:${mention}`,
        kind: 'symbol',
        label: mention,
        badges: []
      });
    }
    
    // Fallback files
    if (rootNodes.length === 0 && Array.isArray(roots.fallbackFiles)) {
      for (const filePath of roots.fallbackFiles) {
        rootNodes.push({
          id: `file:${filePath}`,
          kind: 'file',
          label: this.getFileName(filePath),
          file: filePath,
          badges: ['lowConfidence']
        });
      }
    }
    
    // Initialize priority queue
    for (const rootNode of rootNodes) {
      nodes.set(rootNode.id, rootNode);
      const priority = this.calculateFrontierPriority(rootNode, { errorFiles, route: evidence?.route }, importRelations);
      heapPush({ node: rootNode, priority, depth: 0 });
    }
    
    // Priority-guided expansion with symbol layer priority
    while (pq.length > 0 && nodes.size < limits.maxNodes) {
      const { node, priority, depth, via } = heapPop()!;
      
      if (seen.has(node.id) || depth > limits.maxDepth) continue;
      seen.add(node.id);
      
      if (via && via.confidence >= limits.confidenceThreshold) {
        edges.push(via);
      }
      
      // If it's a symbol node, expand through symbol edges first
      if (node.kind === 'symbol' && node.file) {
        const symbolCalls = symbolCallsByCaller.get(node.id) || [];
        
        for (const call of symbolCalls) {
          const calleeSymbol = symbolById.get(call.calleeId);
          
          if (calleeSymbol) {
            const calleeNode: GraphNode = {
              id: calleeSymbol.id,
              kind: 'symbol',
              label: calleeSymbol.name,
              file: calleeSymbol.file,
              line: calleeSymbol.startLine,
              badges: call.via === 'unresolved' ? ['lowConfidence'] : []
            };
            
            const edge: GraphEdge = {
              from: node.id,
              to: calleeNode.id,
              kind: 'calls',
              confidence: call.confidence
            };
            
            if (edge.confidence >= limits.confidenceThreshold && !edges.some(e => e.from === edge.from && e.to === edge.to && e.kind === edge.kind)) {
              edges.push(edge);
            }
            
            if (!nodes.has(calleeNode.id)) {
              nodes.set(calleeNode.id, calleeNode);
              const fileNode = this.createFileNode(calleeSymbol.file);
              if (!nodes.has(fileNode.id)) {
                nodes.set(fileNode.id, fileNode);
              }
              const nPriority = this.calculateFrontierPriority(calleeNode, { errorFiles, route: evidence?.route }, importRelations);
              heapPush({ node: calleeNode, priority: nPriority, depth: depth + 1, via: edge });
            }
          }
        }
        
        // If symbol calls are few, also expand through file imports
        if (symbolCalls.length < 3 && node.file) {
          const fileImports = idxByFrom.get(normalizePath(node.file)) || [];
          for (const rel of fileImports.slice(0, 3)) {
            const target = this.createFileNode(rel.to);
            const edge: GraphEdge = {
              from: node.id,
              to: target.id,
              kind: rel.kind === 'import' ? 'imports' : 'exports',
              confidence: rel.confidence || this.getConfidenceByProvenance(rel.kind)
            };
            if (edge.confidence >= limits.confidenceThreshold && !edges.some(e => e.from === edge.from && e.to === edge.to)) {
              edges.push(edge);
            }
            if (!nodes.has(target.id)) {
              nodes.set(target.id, target);
              const targetSymbols = methodGraph.symbols.filter(s => s.file === target.file && s.exportName).slice(0, 2);
              for (const symbol of targetSymbols) {
                const symbolNode: GraphNode = {
                  id: symbol.id,
                  kind: 'symbol',
                  label: symbol.name,
                  file: symbol.file,
                  line: symbol.startLine,
                  badges: ['lowConfidence']
                };
                if (!nodes.has(symbolNode.id)) {
                  nodes.set(symbolNode.id, symbolNode);
                  edges.push({
                    from: target.id,
                    to: symbolNode.id,
                    kind: 'calls',
                    confidence: 0.3
                  });
                }
              }
              heapPush({ node: target, priority: priority * 0.7, depth: depth + 1, via: edge });
            }
          }
        }
        continue;
      }
      
      // For file nodes, fallback to file-level expansion
      // This continues with the standard expansion logic below
    }
    
    // Fallback to file-level expansion for file nodes
    const fileExpansion = this.expandSliceWithPriority(roots, importRelations, callRelations, limits, evidence);
    for (const fileNode of fileExpansion.nodes) {
      if (!nodes.has(fileNode.id)) {
        nodes.set(fileNode.id, fileNode);
      }
    }
    for (const fileEdge of fileExpansion.edges) {
      if (!edges.some(e => e.from === fileEdge.from && e.to === fileEdge.to && e.kind === fileEdge.kind)) {
        edges.push(fileEdge);
      }
    }
    
    return {
      nodes: Array.from(nodes.values()),
      edges
    };
  }

  /**
   * Priority-guided slice expansion using binary heap
   */
  private expandSliceWithPriority(
    roots: RootSpec,
    importRelations: ImportExportRelation[],
    callRelations: CallRelation[],
    limits: SliceLimits,
    evidence?: Evidence
  ): { nodes: GraphNode[]; edges: GraphEdge[] } {
    const nodes = new Map<string, GraphNode>();
    const edges: GraphEdge[] = [];
    const seen = new Set<string>();

    // Build indices for efficient lookup with path normalization
    // Normalize paths to ensure matching works regardless of path format
    const normalizePath = (filePath: string): string => {
      if (!filePath) return '';
      // Normalize path separators and resolve relative paths
      try {
        // Handle both absolute and relative paths
        const isAbsolute = path.isAbsolute(filePath);
        const normalized = isAbsolute 
          ? path.normalize(filePath)
          : path.resolve(filePath);
        // Normalize to forward slashes for consistency
        return normalized.replace(/\\/g, '/');
      } catch {
        // Fallback: just normalize separators
        return filePath.replace(/\\/g, '/');
      }
    };
    
    const idxByFrom = new Map<string, ImportExportRelation[]>();
    for (const rel of importRelations) {
      const normalized = normalizePath(rel.from);
      if (!idxByFrom.has(normalized)) {
        idxByFrom.set(normalized, []);
      }
      idxByFrom.get(normalized)!.push(rel);
    }
    
    // Build reverse index for incoming imports
    const idxByTo = new Map<string, ImportExportRelation[]>();
    for (const rel of importRelations) {
      const normalized = normalizePath(rel.to);
      if (!idxByTo.has(normalized)) {
        idxByTo.set(normalized, []);
      }
      idxByTo.get(normalized)!.push(rel);
    }
    
    const idxByFileCalls = new Map<string, CallRelation[]>();
    for (const rel of callRelations) {
      const normalized = normalizePath(rel.file);
      if (!idxByFileCalls.has(normalized)) {
        idxByFileCalls.set(normalized, []);
      }
      idxByFileCalls.get(normalized)!.push(rel);
    }

    // Create priority queue (simple array-based heap)
    const pq: FrontierItem[] = [];
    const heapPush = (item: FrontierItem) => {
      pq.push(item);
      this.heapifyUp(pq, pq.length - 1);
    };
    const heapPop = (): FrontierItem | undefined => {
      if (pq.length === 0) return undefined;
      const top = pq[0];
      pq[0] = pq[pq.length - 1];
      pq.pop();
      if (pq.length > 0) this.heapifyDown(pq, 0);
      return top;
    };

    // Initialize with root nodes
    const rootNodes = this.identifyRoots(roots);
    const errorFiles = new Set(roots.errorFrames.map(f => f.file));
    
    for (const rootNode of rootNodes) {
      nodes.set(rootNode.id, rootNode);
      const priority = this.calculateFrontierPriority(rootNode, { errorFiles, route: evidence?.route }, importRelations);
      heapPush({ node: rootNode, priority, depth: 0 });
    }

    // Priority-guided expansion
    while (pq.length > 0 && nodes.size < limits.maxNodes) {
      const { node, priority, depth, via } = heapPop()!;
      
      if (seen.has(node.id) || depth > limits.maxDepth) continue;
      seen.add(node.id);
      
      if (via && via.confidence >= limits.confidenceThreshold) {
        edges.push(via);
      }

      // Handle symbol-only roots (user mentions with no file)
      if (!node.file) {
        const guessedFiles = this.guessFilesForLabel(node.label, importRelations, evidence);
        for (const guessedFile of guessedFiles) {
          const fileNode = this.createFileNode(guessedFile);
          if (!nodes.has(fileNode.id)) {
            nodes.set(fileNode.id, fileNode);
          }
          const guessEdge: GraphEdge = {
            from: node.id,
            to: fileNode.id,
            kind: 'logFlow',
            confidence: 0.35
          };
          edges.push(guessEdge);
          const nPriority = this.calculateFrontierPriority(fileNode, { errorFiles, route: evidence?.route }, importRelations);
          heapPush({ node: fileNode, priority: nPriority, depth: depth + 1, via: guessEdge });
        }
        // Don't try to expand undefined file further
        continue;
      }

      // Add neighbors from imports (with path normalization)
      const importRels = idxByFrom.get(normalizePath(node.file!)) || [];
      for (const rel of importRels) {
        const target = this.createFileNode(rel.to);
        const edge: GraphEdge = {
          from: node.id,
          to: target.id,
          kind: rel.kind === 'import' ? 'imports' : 'exports',
          confidence: rel.confidence || this.getConfidenceByProvenance(rel.kind)
        };
        
        // Add edge if confidence is high enough (even if node already exists)
        if (edge.confidence >= limits.confidenceThreshold) {
          // Check if edge already exists
          const edgeExists = edges.some(e => e.from === edge.from && e.to === edge.to && e.kind === edge.kind);
          if (!edgeExists) {
            edges.push(edge);
          }
        }
        
        if (!nodes.has(target.id)) {
          nodes.set(target.id, target);
          const nPriority = this.calculateFrontierPriority(target, { errorFiles, route: evidence?.route }, importRelations);
          heapPush({ node: target, priority: nPriority, depth: depth + 1, via: edge });
        }
      }

      // Add neighbors from calls (with path normalization)
      const callRels = idxByFileCalls.get(normalizePath(node.file!)) || [];
      for (const rel of callRels) {
        // Skip internal same-file calls from file nodes (too much noise)
        if (rel.file === node.file && node.kind === 'file') {
          continue;
        }
        
        // Special-case framework/router patterns: connect to file instead of symbol
        let target: GraphNode;
        if (rel.caller === 'router' || rel.caller === 'route') {
          target = this.createFileNode(rel.file);
        } else {
          target = this.createSymbolNode(rel.file, rel.callee, rel.line);
        }
        
        const edge: GraphEdge = {
          from: node.id,
          to: target.id,
          kind: 'calls',
          confidence: rel.confidence
        };
        
        // Add edge if confidence is high enough (even if node already exists)
        if (edge.confidence >= limits.confidenceThreshold) {
          // Check if edge already exists
          const edgeExists = edges.some(e => e.from === edge.from && e.to === edge.to && e.kind === edge.kind);
          if (!edgeExists) {
            edges.push(edge);
          }
        }
        
        if (!nodes.has(target.id)) {
          nodes.set(target.id, target);
          const nPriority = this.calculateFrontierPriority(target, { errorFiles, route: evidence?.route }, importRelations);
          heapPush({ node: target, priority: nPriority, depth: depth + 1, via: edge });
        }
      }

      // Add reverse import edges (who imports this file)
      const incomingImports = idxByTo.get(normalizePath(node.file!)) || [];
      for (const rel of incomingImports) {
        const sourceNode = this.createFileNode(rel.from);
        const importedByEdge: GraphEdge = {
          from: node.id,
          to: sourceNode.id,
          kind: 'importedBy',
          confidence: 0.4
        };
        
        // Add edge if confidence is high enough
        if (importedByEdge.confidence >= limits.confidenceThreshold) {
          const edgeExists = edges.some(e => e.from === importedByEdge.from && e.to === importedByEdge.to && e.kind === importedByEdge.kind);
          if (!edgeExists) {
            edges.push(importedByEdge);
          }
        }
        
        if (!nodes.has(sourceNode.id)) {
          nodes.set(sourceNode.id, sourceNode);
          const nPriority = this.calculateFrontierPriority(sourceNode, { errorFiles, route: evidence?.route }, importRelations);
          heapPush({ node: sourceNode, priority: nPriority, depth: depth + 1, via: importedByEdge });
        }
      }
    }

    return {
      nodes: Array.from(nodes.values()),
      edges
    };
  }

  /**
   * Calculate frontier priority for priority queue
   */
  private calculateFrontierPriority(
    node: GraphNode,
    evidence: { errorFiles: Set<string>; route?: string },
    importRelations: ImportExportRelation[]
  ): number {
    // Error proximity (0-1)
    const errProximity = node.file && evidence.errorFiles.has(node.file) ? 1 : 0;
    
    // Evidence boost (0-1)
    const evidenceBoost = this.calculateEvidenceBoost(node, evidence);
    
    // Centrality hint (0-1)
    const centralityHint = this.calculateCentralityHint(node.file!, importRelations);
    
    // Name match (0-1)
    const nameMatch = this.calculateNameMatch(node.label, evidence.route || '');
    
    return Math.min(1, 0.45 * errProximity + 0.25 * evidenceBoost + 0.2 * centralityHint + 0.1 * nameMatch);
  }

  /**
   * Calculate evidence boost for node
   */
  private calculateEvidenceBoost(
    node: GraphNode,
    evidence: { errorFiles: Set<string>; route?: string }
  ): number {
    let boost = 0;
    
    // Stack frame boost
    if (node.file && evidence.errorFiles.has(node.file)) {
      boost += 0.8;
    }
    
    // Route match boost
    if (evidence.route && node.label.toLowerCase().includes(evidence.route.toLowerCase())) {
      boost += 0.6;
    }
    
    // Symbol name boost
    if (node.kind === 'symbol' && node.label.length > 3) {
      boost += 0.3;
    }
    
    return Math.min(1, boost);
  }

  /**
   * Calculate centrality hint from import graph
   */
  private calculateCentralityHint(filePath: string, importRelations: ImportExportRelation[]): number {
    const incoming = importRelations.filter(r => r.to === filePath).length;
    const outgoing = importRelations.filter(r => r.from === filePath).length;
    const total = importRelations.length;
    
    if (total === 0) return 0;
    
    return (incoming + outgoing) / total;
  }

  /**
   * Calculate name match score
   */
  private calculateNameMatch(label: string, route: string): number {
    if (!route) return 0;
    
    const labelTokens = label.toLowerCase().split(/[^a-zA-Z0-9]/);
    const routeTokens = route.toLowerCase().split(/[^a-zA-Z0-9]/);
    
    const matches = labelTokens.filter(token => 
      routeTokens.some(routeToken => token.includes(routeToken) || routeToken.includes(token))
    ).length;
    
    return Math.min(1, matches / Math.max(labelTokens.length, routeTokens.length));
  }

  /**
   * Get confidence by provenance
   */
  private getConfidenceByProvenance(kind: string): number {
    switch (kind) {
      case 'import': return 0.95;
      case 'reexport': return 0.7;
      case 'dynamicImport': return 0.4;
      default: return 0.8;
    }
  }

  /**
   * Create file node with stable ID
   */
  private createFileNode(filePath: string): GraphNode {
    const nodeId = `file:${filePath}`;
    return {
      id: nodeId,
      kind: 'file',
      label: this.getFileName(filePath),
      file: filePath,
      badges: []
    };
  }

  /**
   * Create symbol node with stable ID
   */
  private createSymbolNode(file: string, symbol: string, line?: number): GraphNode {
    const nodeId = `symbol:${file}:${symbol}:${line || 0}`;
    return {
      id: nodeId,
      kind: 'symbol',
      label: symbol,
      file,
      line,
      badges: []
    };
  }

  /**
   * Align logs to graph for runtime overlay
   */
  private alignLogsToGraph(
    evidence: Evidence,
    nodes: GraphNode[],
    edges: GraphEdge[]
  ): RuntimeOverlay {
    const anchors: RuntimeOverlay['anchors'] = [];
    const byFile = new Map<string, GraphNode[]>();
    
    // Group nodes by file
    for (const node of nodes) {
      if (node.file) {
        if (!byFile.has(node.file)) {
          byFile.set(node.file, []);
        }
        byFile.get(node.file)!.push(node);
      }
    }

    // 1) Stack frames → anchors
    for (const frame of evidence.frames) {
      const candidates = byFile.get(frame.file) || [];
      const best = candidates.sort((a, b) => {
        const distA = Math.abs((a.line || 0) - frame.line);
        const distB = Math.abs((b.line || 0) - frame.line);
        return distA - distB;
      })[0];
      
      if (best) {
        anchors.push({
          nodeId: best.id,
          file: frame.file,
          line: frame.line,
          why: ['stackFrame']
        });
      }
    }

    // 2) Route → route node
    if (evidence.route) {
      const routeNode = nodes.find(n => 
        n.kind === 'route' && n.label.includes(evidence.route!)
      );
      if (routeNode) {
        anchors.push({
          nodeId: routeNode.id,
          file: routeNode.file || '',
          line: routeNode.line || 0,
          why: ['routeMatch']
        });
      }
    }

    // 3) Log signatures → fuzzy file match
    for (const signature of evidence.logSignatures || []) {
      const token = this.extractTopToken(signature);
      if (!token) continue;
      
      const hit = nodes.find(n => 
        n.label.toLowerCase().includes(token) || 
        (n.file || '').toLowerCase().includes(token)
      );
      
      if (hit) {
        anchors.push({
          nodeId: hit.id,
          file: hit.file || '',
          line: hit.line || 0,
          why: ['logSignature']
        });
      }
    }

    // 4) Choose fail node
    const failNodeId = this.chooseFailNode(anchors, nodes, edges);

    return { anchors, failNodeId, failReasons: [] };
  }

  /**
   * Extract top token from log signature
   */
  private extractTopToken(signature: string): string | null {
    // Extract function/component names from log signatures
    const match = signature.match(/([A-Z][a-zA-Z0-9]+|[a-z][a-zA-Z0-9]*)/);
    return match ? match[1] : null;
  }

  /**
   * Choose most likely failure node
   */
  private chooseFailNode(
    anchors: RuntimeOverlay['anchors'],
    nodes: GraphNode[],
    edges: GraphEdge[]
  ): string | undefined {
    if (anchors.length === 0) return undefined;

    // Find the most downstream anchored node
    const anchoredIds = new Set(anchors.map(a => a.nodeId));
    const nodeMap = new Map(nodes.map(n => [n.id, n]));
    
    // Simple heuristic: node with most incoming edges from anchored nodes
    let bestNode = anchors[0].nodeId;
    let maxScore = 0;
    
    for (const anchor of anchors) {
      const node = nodeMap.get(anchor.nodeId);
      if (!node) continue;
      
      const incomingFromAnchored = edges.filter(e => 
        anchoredIds.has(e.from) && e.to === anchor.nodeId
      ).length;
      
      if (incomingFromAnchored > maxScore) {
        maxScore = incomingFromAnchored;
        bestNode = anchor.nodeId;
      }
    }
    
    return bestNode;
  }

  /**
   * Refine graph with safe LLM assistance
   */
  private refineGraphWithLLM(
    graph: { nodes: GraphNode[]; edges: GraphEdge[] },
    overlay: RuntimeOverlay | undefined,
    whitelist: string[],
    llmConfig: LLMConfig
  ): { nodes: GraphNode[]; edges: GraphEdge[] } {
    try {
      // Pass A: Log disambiguation
      const patchA = this.callLLMDisambiguate(graph, overlay, whitelist, llmConfig);
      const graphA = this.applyPatchSafely(graph, patchA, whitelist);
      
      // Pass B: Missing hop hypothesis
      const patchB = this.callLLMMissingHops(graphA, overlay, whitelist, llmConfig);
      return this.applyPatchSafely(graphA, patchB, whitelist);
    } catch (error) {
      console.warn('LLM refinement failed, using original graph:', error);
      return graph;
    }
  }

  /**
   * Call LLM for log disambiguation
   */
  private callLLMDisambiguate(
    graph: { nodes: GraphNode[]; edges: GraphEdge[] },
    overlay: RuntimeOverlay | undefined,
    whitelist: string[],
    llmConfig: LLMConfig
  ): GraphPatch {
    // Simplified implementation - in practice, this would call an actual LLM
    // For now, return empty patch to avoid external dependencies
    return {
      addEdges: [],
      dropEdges: [],
      raiseConfidence: [],
      relabel: []
    };
  }

  /**
   * Call LLM for missing hop hypothesis
   */
  private callLLMMissingHops(
    graph: { nodes: GraphNode[]; edges: GraphEdge[] },
    overlay: RuntimeOverlay | undefined,
    whitelist: string[],
    llmConfig: LLMConfig
  ): GraphPatch {
    // Simplified implementation - in practice, this would call an actual LLM
    // For now, return empty patch to avoid external dependencies
    return {
      addEdges: [],
      dropEdges: [],
      raiseConfidence: [],
      relabel: []
    };
  }

  /**
   * Apply patch safely with verification
   */
  private applyPatchSafely(
    graph: { nodes: GraphNode[]; edges: GraphEdge[] },
    patch: GraphPatch,
    whitelist: string[]
  ): { nodes: GraphNode[]; edges: GraphEdge[] } {
    const nodes = [...graph.nodes];
    const edges = [...graph.edges];
    
    // Apply addEdges with verification
    if (patch.addEdges) {
      for (const addEdge of patch.addEdges) {
        if (this.verifyEdge(addEdge, whitelist)) {
          edges.push({
            from: addEdge.from,
            to: addEdge.to,
            kind: addEdge.kind,
            confidence: 0.35, // LLM-suggested edges get lower confidence
            evidence: ['llmHypothesis']
          });
        }
      }
    }
    
    // Apply dropEdges
    if (patch.dropEdges) {
      for (const dropEdge of patch.dropEdges) {
        const index = edges.findIndex(e => 
          e.from === dropEdge.from && e.to === dropEdge.to
        );
        if (index >= 0) {
          edges.splice(index, 1);
        }
      }
    }
    
    // Apply confidence adjustments
    if (patch.raiseConfidence) {
      for (const raise of patch.raiseConfidence) {
        const edge = edges.find(e => 
          e.from === raise.from && e.to === raise.to
        );
        if (edge) {
          edge.confidence = Math.min(1, edge.confidence + Math.min(0.15, raise.delta));
        }
      }
    }
    
    // Apply relabeling
    if (patch.relabel) {
      for (const relabel of patch.relabel) {
        const node = nodes.find(n => n.id === relabel.id);
        if (node && relabel.addBadges) {
          node.badges = [...(node.badges || []), ...relabel.addBadges];
        }
      }
    }
    
    return { nodes, edges };
  }

  /**
   * Verify edge suggestion against whitelist and local evidence
   */
  private verifyEdge(edge: { from: string; to: string; kind: string }, whitelist: string[]): boolean {
    // Check if both endpoints are in whitelist
    const fromInWhitelist = whitelist.some(w => edge.from.includes(w));
    const toInWhitelist = whitelist.some(w => edge.to.includes(w));
    
    return fromInWhitelist && toInWhitelist;
  }

  /**
   * Prune dominated edges - keep best edge per kind instead of one per pair
   */
  private pruneDominatedEdges(edges: GraphEdge[], threshold: number): GraphEdge[] {
    const keep: GraphEdge[] = [];
    const byPair = new Map<string, GraphEdge[]>();
    
    // Group edges by from->to pair (without kind)
    for (const edge of edges) {
      if (edge.confidence < threshold) continue;
      
      const key = `${edge.from}->${edge.to}`;
      if (!byPair.has(key)) {
        byPair.set(key, []);
      }
      byPair.get(key)!.push(edge);
    }
    
    // For each pair, keep the best edge for each kind
    for (const edgeGroup of byPair.values()) {
      const byKind = new Map<string, GraphEdge[]>();
      
      // Group by kind within this pair
      for (const edge of edgeGroup) {
        if (!byKind.has(edge.kind)) {
          byKind.set(edge.kind, []);
        }
        byKind.get(edge.kind)!.push(edge);
      }
      
      // Keep strongest edge for each kind
      for (const edgesOfKind of byKind.values()) {
        edgesOfKind.sort((a, b) => b.confidence - a.confidence);
        keep.push(edgesOfKind[0]);
      }
    }
    
    return keep;
  }

  /**
   * Identify root nodes from specification
   */
  private identifyRoots(roots: RootSpec): GraphNode[] {
    const rootNodes: GraphNode[] = [];
    
    // Add error frame nodes
    for (const frame of roots.errorFrames) {
      const nodeId = `file:${frame.file}`;
      rootNodes.push({
        id: nodeId,
        kind: 'file',
        label: this.getFileName(frame.file),
        file: frame.file,
        line: frame.line,
        badges: ['error']
      });
    }
    
    // Add top symbol nodes
    for (const symbol of roots.topSymbols) {
      const nodeId = `symbol:${symbol.file}:${symbol.symbol}:${symbol.startLine}`;
      rootNodes.push({
        id: nodeId,
        kind: 'symbol',
        label: symbol.symbol,
        file: symbol.file,
        line: symbol.startLine,
        badges: []
      });
    }
    
    // Add user mention nodes
    for (const mention of roots.userMentions) {
      const nodeId = `mention:${mention}`;
      rootNodes.push({
        id: nodeId,
        kind: 'symbol',
        label: mention,
        badges: []
      });
    }
    
    if (rootNodes.length === 0 && Array.isArray(roots.fallbackFiles)) {
      for (const filePath of roots.fallbackFiles) {
        const nodeId = `file:${filePath}`;
        rootNodes.push({
          id: nodeId,
          kind: 'file',
          label: this.getFileName(filePath),
          file: filePath,
          badges: ['lowConfidence']
        });
      }
    }
    
    return rootNodes;
  }

  /**
   * Apply heuristics and tag nodes
   */
  private applyHeuristics(
    nodes: Map<string, GraphNode>,
    edges: GraphEdge[],
    roots: RootSpec
  ): void {
    // Detect suspicious patterns
    this.detectSuspiciousPatterns(nodes, edges);
    
    // Tag low confidence nodes
    this.tagLowConfidenceNodes(nodes, edges);
    
    // Tag error-related nodes
    this.tagErrorNodes(nodes, roots);
    
    // Detect circular imports
    this.detectCircularImports(nodes, edges);
  }

  /**
   * Detect suspicious patterns
   */
  private detectSuspiciousPatterns(
    nodes: Map<string, GraphNode>,
    edges: GraphEdge[]
  ): void {
    // Detect export mismatches
    const exportEdges = edges.filter(edge => edge.kind === 'exports');
    const importEdges = edges.filter(edge => edge.kind === 'imports');
    
    for (const exportEdge of exportEdges) {
      const hasMatchingImport = importEdges.some(importEdge => 
        importEdge.to === exportEdge.to
      );
      
      if (!hasMatchingImport) {
        const node = nodes.get(exportEdge.to);
        if (node) {
          node.badges = [...(node.badges || []), 'suspicious'];
        }
      }
    }
    
    // Detect dynamic imports
    for (const node of nodes.values()) {
      if (node.label.includes('import(') || node.label.includes('require(')) {
        node.badges = [...(node.badges || []), 'lowConfidence'];
      }
    }
  }

  /**
   * Detect circular imports using iterative DFS to avoid stack overflow
   */
  private detectCircularImports(
    nodes: Map<string, GraphNode>,
    edges: GraphEdge[]
  ): void {
    // Early return if no import edges
    const importEdges = edges.filter(e => e.kind === 'imports');
    if (importEdges.length === 0) {
      return;
    }
    
    // Log for large graphs for monitoring
    if (importEdges.length > 100) {
      console.log(`[StaticSlicer] Detecting circular imports in large graph: ${importEdges.length} edges`);
    }
    
    const graph = new Map<string, string[]>();
    
    // Build adjacency list
    for (const edge of importEdges) {
      if (!graph.has(edge.from)) {
        graph.set(edge.from, []);
      }
      graph.get(edge.from)!.push(edge.to);
    }
    
    // Detect cycles using iterative DFS with explicit stack
    const visited = new Set<string>();
    const recStack = new Set<string>();
    const maxIterations = 10000; // Safety limit to prevent infinite loops
    let iterationCount = 0;
    
    for (const nodeId of graph.keys()) {
      if (visited.has(nodeId)) continue;
      
      // Iterative DFS using explicit stack
      // Stack element: { node: string, neighbors: string[], neighborIndex: number, state: 'entry' | 'exit' }
      const stack: Array<{ node: string; neighbors: string[]; neighborIndex: number; state: 'entry' | 'exit' }> = [];
      stack.push({ node: nodeId, neighbors: graph.get(nodeId) || [], neighborIndex: 0, state: 'entry' });
      
      while (stack.length > 0 && iterationCount < maxIterations) {
        iterationCount++;
        const current = stack[stack.length - 1];
        
        if (current.state === 'entry') {
          // First time visiting this node
          if (visited.has(current.node)) {
            // Already fully processed, backtrack
            stack.pop();
            continue;
          }
          
          if (recStack.has(current.node)) {
            // Found a cycle - mark nodes as suspicious
            const node = nodes.get(current.node);
            if (node) {
              node.badges = [...(node.badges || []), 'suspicious'];
            }
            
            // Mark all nodes in current recursion stack as suspicious
            for (const stackItem of stack) {
              if (recStack.has(stackItem.node)) {
                const n = nodes.get(stackItem.node);
                if (n) {
                  n.badges = [...(n.badges || []), 'suspicious'];
                }
              }
            }
            
            // Backtrack from cycle
            stack.pop();
            continue;
          }
          
          // Mark as visiting (in current path)
          visited.add(current.node);
          recStack.add(current.node);
          
          // Change to exit state to process neighbors
          current.state = 'exit';
        } else {
          // Processing neighbors - check if there are more to process
          if (current.neighborIndex < current.neighbors.length) {
            const neighbor = current.neighbors[current.neighborIndex];
            current.neighborIndex++;
            
            // Check if neighbor is in recursion stack (cycle detection)
            if (recStack.has(neighbor)) {
              // Found a cycle - mark both nodes as suspicious
              const node = nodes.get(current.node);
              const neighborNode = nodes.get(neighbor);
              if (node) {
                node.badges = [...(node.badges || []), 'suspicious'];
              }
              if (neighborNode) {
                neighborNode.badges = [...(neighborNode.badges || []), 'suspicious'];
              }
            } else {
              // Push neighbor onto stack to explore
              const neighbors = graph.get(neighbor) || [];
              stack.push({ node: neighbor, neighbors, neighborIndex: 0, state: 'entry' });
            }
          } else {
            // All neighbors processed, backtrack
            stack.pop();
            recStack.delete(current.node);
          }
        }
      }
      
      // Safety check
      if (iterationCount >= maxIterations) {
        console.warn('[StaticSlicer] Circular import detection hit iteration limit, some cycles may not be detected');
        break;
      }
    }
    
    if (importEdges.length > 100) {
      console.log(`[StaticSlicer] Circular import detection completed in ${iterationCount} iterations`);
    }
  }

  /**
   * Tag low confidence nodes
   */
  private tagLowConfidenceNodes(
    nodes: Map<string, GraphNode>,
    edges: GraphEdge[]
  ): void {
    for (const edge of edges) {
      if (edge.confidence < 0.5) {
        const node = nodes.get(edge.to);
        if (node && !node.badges?.includes('lowConfidence')) {
          node.badges = [...(node.badges || []), 'lowConfidence'];
        }
      }
    }
  }

  /**
   * Tag error-related nodes
   */
  private tagErrorNodes(
    nodes: Map<string, GraphNode>,
    roots: RootSpec
  ): void {
    const errorFiles = new Set(roots.errorFrames.map(f => f.file));
    
    for (const node of nodes.values()) {
      if (node.file && errorFiles.has(node.file)) {
        if (!node.badges?.includes('error')) {
          node.badges = [...(node.badges || []), 'error'];
        }
      }
    }
  }

  /**
   * Utility: Group array by key function
   */
  private groupBy<T, K>(array: T[], keyFn: (item: T) => K): Map<K, T[]> {
    const groups = new Map<K, T[]>();
    for (const item of array) {
      const key = keyFn(item);
      if (!groups.has(key)) {
        groups.set(key, []);
      }
      groups.get(key)!.push(item);
    }
    return groups;
  }

  /**
   * Utility: Heap operations
   */
  private heapifyUp(heap: FrontierItem[], index: number): void {
    while (index > 0) {
      const parentIndex = Math.floor((index - 1) / 2);
      if (heap[parentIndex].priority >= heap[index].priority) break;
      [heap[parentIndex], heap[index]] = [heap[index], heap[parentIndex]];
      index = parentIndex;
    }
  }

  private heapifyDown(heap: FrontierItem[], index: number): void {
    while (true) {
      let largest = index;
      const left = 2 * index + 1;
      const right = 2 * index + 2;
      
      if (left < heap.length && heap[left].priority > heap[largest].priority) {
        largest = left;
      }
      
      if (right < heap.length && heap[right].priority > heap[largest].priority) {
        largest = right;
      }
      
      if (largest === index) break;
      
      [heap[index], heap[largest]] = [heap[largest], heap[index]];
      index = largest;
    }
  }

  /**
   * Get file name from path
   */
  private getFileName(filePath: string): string {
    const parts = filePath.split('/');
    return parts[parts.length - 1];
  }

  /**
   * Calculate node importance score
   */
  private calculateNodeImportance(node: GraphNode, edges: GraphEdge[]): number {
    let score = 0;
    
    // Base score from badges
    if (node.badges?.includes('error')) score += 1.0;
    if (node.badges?.includes('suspicious')) score += 0.5;
    if (node.badges?.includes('lowConfidence')) score -= 0.3;
    
    // Score from incoming edges
    const incomingEdges = edges.filter(edge => edge.to === node.id);
    score += incomingEdges.length * 0.1;
    
    // Score from outgoing edges
    const outgoingEdges = edges.filter(edge => edge.from === node.id);
    score += outgoingEdges.length * 0.1;
    
    return Math.max(0, score);
  }

  /**
   * Sort nodes by importance
   */
  public sortNodesByImportance(nodes: GraphNode[], edges: GraphEdge[]): GraphNode[] {
    return nodes.sort((a, b) => {
      const scoreA = this.calculateNodeImportance(a, edges);
      const scoreB = this.calculateNodeImportance(b, edges);
      return scoreB - scoreA;
    });
  }

  /**
   * Guess candidate files for a symbol label when file is unknown
   */
  private guessFilesForLabel(label: string, importRelations: ImportExportRelation[], evidence?: Evidence): string[] {
    const candidates = new Map<string, number>();
    
    // Search import relations for files that might contain this symbol
    const lowerLabel = label.toLowerCase();
    for (const rel of importRelations) {
      // Check if the 'to' file path or name matches the label
      const toLower = rel.to.toLowerCase();
      const toName = this.getFileName(rel.to).toLowerCase();
      
      if (toName.includes(lowerLabel) || toLower.includes(lowerLabel)) {
        const score = candidates.get(rel.to) || 0;
        candidates.set(rel.to, score + 1);
      }
      
      // Check import symbol if available
      if (rel.symbol && rel.symbol.toLowerCase().includes(lowerLabel)) {
        const score = candidates.get(rel.to) || 0;
        candidates.set(rel.to, score + 2); // Higher score for symbol match
      }
    }
    
    // Check evidence frames for hints
    if (evidence?.frames) {
      for (const frame of evidence.frames) {
        const frameName = this.getFileName(frame.file).toLowerCase();
        if (frameName.includes(lowerLabel) || frame.file.toLowerCase().includes(lowerLabel)) {
          const score = candidates.get(frame.file) || 0;
          candidates.set(frame.file, score + 1.5);
        }
      }
    }
    
    // Return top 2 candidates sorted by score
    const sorted = Array.from(candidates.entries())
      .sort((a, b) => b[1] - a[1])
      .slice(0, 2)
      .map(([file]) => file);
    
    return sorted;
  }
}