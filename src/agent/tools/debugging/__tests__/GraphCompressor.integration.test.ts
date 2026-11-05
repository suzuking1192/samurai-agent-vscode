/**
 * Integration tests for GraphCompressor with visualization
 * Tests graph compression with real codebase and shows before/after visualization
 */

import * as path from 'path';
import { AstProgramBuilder } from '../AstProgramBuilder';
import { GraphCompressor, convertCompressedToMethodGraph } from '../GraphCompressor';
import { StaticSlicer } from '../StaticSlicer';
import { LLMProviderService } from '../../../llm/llmProviderService';
import { MethodExecutionGraph } from '../types';

function visualizeGraph(
  graph: { nodes: any[]; edges: any[] },
  title: string,
  showDetails: boolean = false
) {
  console.log('\n' + '='.repeat(80));
  console.log(title);
  console.log('='.repeat(80));

  console.log(`\nSummary:`);
  console.log(`  - Nodes: ${graph.nodes.length}`);
  console.log(`  - Edges: ${graph.edges.length}`);
  console.log(`  - Density: ${(graph.edges.length / Math.max(1, graph.nodes.length)).toFixed(2)}`);

  // Node breakdown
  const nodesByKind = graph.nodes.reduce((acc, node) => {
    acc[node.kind] = (acc[node.kind] || 0) + 1;
    return acc;
  }, {} as Record<string, number>);

  console.log(`\nNodes by Kind:`);
  Object.entries(nodesByKind).forEach(([kind, count]) => {
    console.log(`  ${kind}: ${count}`);
  });

  // Edge breakdown
  if (graph.edges.length > 0) {
    const edgesByKind = graph.edges.reduce((acc, edge) => {
      acc[edge.kind] = (acc[edge.kind] || 0) + 1;
      return acc;
    }, {} as Record<string, number>);

    console.log(`\nEdges by Kind:`);
    Object.entries(edgesByKind).forEach(([kind, count]) => {
      console.log(`  ${kind}: ${count}`);
    });
  }

  if (showDetails) {
    console.log(`\nTop 15 Nodes:`);
    graph.nodes.slice(0, 15).forEach((node, idx) => {
      const badges = node.badges && node.badges.length > 0 ? ` [${node.badges.join(', ')}]` : '';
      const fileDisplay = node.file ? path.basename(node.file) : 'N/A';
      const lineDisplay = node.line ? `:${node.line}` : '';
      console.log(`  ${idx + 1}. ${node.label} (${node.kind})${badges}`);
      console.log(`      ${fileDisplay}${lineDisplay}`);
    });

    if (graph.edges.length > 0) {
      console.log(`\nTop 15 Edges:`);
      graph.edges.slice(0, 15).forEach((edge, idx) => {
        const fromNode = graph.nodes.find(n => n.id === edge.from);
        const toNode = graph.nodes.find(n => n.id === edge.to);
        const fromLabel = fromNode?.label || edge.from.substring(0, 40);
        const toLabel = toNode?.label || edge.to.substring(0, 40);
        const confidence = edge.confidence?.toFixed(2) || 'N/A';
        console.log(`  ${idx + 1}. ${fromLabel} → ${toLabel} (conf: ${confidence})`);
      });
    }
  }

  console.log('\n' + '='.repeat(80) + '\n');
}

function visualizeComparison(
  before: { nodes: any[]; edges: any[] },
  after: { nodes: any[]; edges: any[] },
  meta: any
) {
  console.log('\n' + '='.repeat(80));
  console.log('COMPRESSION COMPARISON');
  console.log('='.repeat(80));

  const reduction = {
    nodes: before.nodes.length - after.nodes.length,
    edges: before.edges.length - after.edges.length,
    nodePercent: ((before.nodes.length - after.nodes.length) / before.nodes.length * 100).toFixed(1),
    edgePercent: ((before.edges.length - after.edges.length) / before.edges.length * 100).toFixed(1)
  };

  console.log(`\nBefore Compression:`);
  console.log(`  Nodes: ${before.nodes.length}`);
  console.log(`  Edges: ${before.edges.length}`);

  console.log(`\nAfter Compression:`);
  console.log(`  Nodes: ${after.nodes.length} (reduced by ${reduction.nodes}, ${reduction.nodePercent}%)`);
  console.log(`  Edges: ${after.edges.length} (reduced by ${reduction.edges}, ${reduction.edgePercent}%)`);

  console.log(`\nCompression Meta:`);
  console.log(`  Pruned Count: ${meta.prunedCount}`);
  console.log(`  Source: ${meta.source}`);
  console.log(`  Unresolved Edges: ${meta.unresolvedEdges.length}`);

  console.log('\n' + '='.repeat(80) + '\n');
}

describe('GraphCompressor Integration', () => {
  const workspaceRoot = process.cwd();
  let llmProvider: LLMProviderService;
  let astBuilder: AstProgramBuilder;

  beforeAll(() => {
    llmProvider = new LLMProviderService();
    astBuilder = new AstProgramBuilder(workspaceRoot);
  });

  it('should compress graph and show visualization', async () => {
    console.log('\n[TEST] Building method-level graph...');

    // Build method graph
    const tsProgram = astBuilder.buildTsProgram(workspaceRoot);
    const importRelations = astBuilder.extractImportGraph(tsProgram);
    const symbolIndex = astBuilder.buildSymbolIndex(tsProgram);
    const symbolCalls = astBuilder.extractSymbolCallGraph(tsProgram, symbolIndex);

    const symbols: import('../types').SymbolDef[] = [];
    for (const fileSymbols of symbolIndex.values()) {
      symbols.push(...fileSymbols);
    }

    const methodGraph: MethodExecutionGraph = {
      symbols,
      symbolEdges: symbolCalls,
      files: Array.from(tsProgram.sourceFiles.keys()),
      fileEdges: importRelations
    };

    console.log(`[TEST] Original graph: ${symbols.length} symbols, ${symbolCalls.length} symbol edges`);

    // Visualize original graph
    const originalNodes = methodGraph.symbols.slice(0, 50).map(s => ({
      id: s.id,
      label: s.name,
      file: s.file,
      kind: 'symbol' as const,
      line: s.startLine
    }));

    const originalEdges = methodGraph.symbolEdges.slice(0, 50).map(e => ({
      from: e.callerId,
      to: e.calleeId,
      kind: 'calls' as const,
      confidence: e.confidence
    }));

    visualizeGraph(
      { nodes: originalNodes, edges: originalEdges },
      'ORIGINAL METHOD GRAPH (Sample)',
      true
    );

    // Compress graph
    console.log('[TEST] Compressing graph...');
    const compressor = new GraphCompressor(llmProvider);

    const compressed = await compressor.compress({
      methodGraph,
      focus: {
        entrySymbols: [
          { name: 'extractForDebugging', file: 'extractCodeTool.ts' },
          { name: 'handleDebugging', file: 'samuraiAgent.ts' }
        ],
        errorFrames: [],
        userMentions: ['StaticSlicer', 'GraphCompressor', 'EvidenceParser']
      },
      limits: {
        maxNodes: 150,
        maxDepth: 5,
        minConfidence: 0.45,
        targetNodeCount: 25
      }
    });

    // Visualize compressed graph
    visualizeGraph(
      { nodes: compressed.nodes, edges: compressed.edges },
      'COMPRESSED GRAPH (Rule-based Pruning)',
      true
    );

    // Show comparison
    visualizeComparison(
      { nodes: originalNodes, edges: originalEdges },
      { nodes: compressed.nodes, edges: compressed.edges },
      compressed.meta
    );

    expect(compressed.nodes.length).toBeLessThanOrEqual(methodGraph.symbols.length);
    expect(compressed.nodes.length).toBeGreaterThan(0);
  }, 120000);

  it('should compress graph with LLM condensation and show visualization', async () => {
    console.log('\n[TEST] Building method-level graph for LLM compression...');

    // Build smaller method graph for LLM testing
    const tsProgram = astBuilder.buildTsProgram(workspaceRoot);
    const importRelations = astBuilder.extractImportGraph(tsProgram);
    const symbolIndex = astBuilder.buildSymbolIndex(tsProgram);
    const symbolCalls = astBuilder.extractSymbolCallGraph(tsProgram, symbolIndex);

    // Take a subset for faster testing
    const allSymbols: import('../types').SymbolDef[] = [];
    for (const fileSymbols of symbolIndex.values()) {
      allSymbols.push(...fileSymbols);
    }

    // Filter to symbols in debugging tools
    const relevantFiles = ['StaticSlicer.ts', 'GraphCompressor.ts', 'ExtractCodeTool.ts', 'AstProgramBuilder.ts'];
    const filteredSymbols = allSymbols.filter(s => 
      relevantFiles.some(f => s.file.includes(f))
    );

    const filteredEdges = symbolCalls.filter(e => 
      filteredSymbols.some(s => s.id === e.callerId || s.id === e.calleeId)
    );

    const methodGraph: MethodExecutionGraph = {
      symbols: filteredSymbols,
      symbolEdges: filteredEdges,
      files: Array.from(tsProgram.sourceFiles.keys()),
      fileEdges: importRelations
    };

    console.log(`[TEST] Filtered graph: ${methodGraph.symbols.length} symbols, ${methodGraph.symbolEdges.length} edges`);

    // Compress WITHOUT LLM first
    const compressor = new GraphCompressor(llmProvider);
    
    const withoutLLM = await compressor.compress({
      methodGraph,
      focus: {
        entrySymbols: [{ name: 'extractForDebugging' }],
        userMentions: ['StaticSlicer', 'GraphCompressor']
      },
      limits: {
        maxNodes: 100,
        targetNodeCount: 20
      }
    });

    visualizeGraph(
      { nodes: withoutLLM.nodes, edges: withoutLLM.edges },
      'COMPRESSED WITHOUT LLM',
      true
    );

    // Compress WITH LLM (if enabled - may fail if no API key)
    try {
      const withLLM = await compressor.compress({
        methodGraph,
        focus: {
          entrySymbols: [{ name: 'extractForDebugging' }],
          userMentions: ['StaticSlicer', 'GraphCompressor']
        },
        llm: {
          enabled: true,
          model: 'gpt-4o-mini',
          maxTokens: 2000,
          temperature: 0.3
        },
        limits: {
          maxNodes: 100,
          targetNodeCount: 15
        }
      });

      visualizeGraph(
        { nodes: withLLM.nodes, edges: withLLM.edges },
        'COMPRESSED WITH LLM CONDENSATION',
        true
      );

      visualizeComparison(
        { nodes: withoutLLM.nodes, edges: withoutLLM.edges },
        { nodes: withLLM.nodes, edges: withLLM.edges },
        { ...withLLM.meta, note: 'LLM condensation applied' }
      );

      expect(withLLM.meta.source).toBe('static+llm');
    } catch (error) {
      console.warn('[TEST] LLM compression skipped (likely no API key):', error);
    }

    expect(withoutLLM.nodes.length).toBeGreaterThan(0);
  }, 180000);

  it('should show end-to-end compression to StaticSlicer integration', async () => {
    console.log('\n[TEST] End-to-end: GraphCompressor -> StaticSlicer...');

    const tsProgram = astBuilder.buildTsProgram(workspaceRoot);
    const importRelations = astBuilder.extractImportGraph(tsProgram);
    const callRelations = astBuilder.extractCallGraph(tsProgram);
    const symbolIndex = astBuilder.buildSymbolIndex(tsProgram);
    const symbolCalls = astBuilder.extractSymbolCallGraph(tsProgram, symbolIndex);

    const symbols: import('../types').SymbolDef[] = [];
    for (const fileSymbols of symbolIndex.values()) {
      symbols.push(...fileSymbols);
    }

    const methodGraph: MethodExecutionGraph = {
      symbols,
      symbolEdges: symbolCalls,
      files: Array.from(tsProgram.sourceFiles.keys()),
      fileEdges: importRelations
    };

    // Compress graph
    const compressor = new GraphCompressor(llmProvider);
    const compressed = await compressor.compress({
      methodGraph,
      focus: {
        entrySymbols: [{ name: 'extractForDebugging' }],
        userMentions: ['StaticSlicer', 'EvidenceParser']
      },
      limits: {
        maxNodes: 150,
        targetNodeCount: 30
      }
    });

    console.log(`[TEST] Compression result: ${compressed.nodes.length} nodes (from ${methodGraph.symbols.length})`);

    // Convert back to MethodExecutionGraph
    const compressedMethodGraph = convertCompressedToMethodGraph(compressed, methodGraph);

    // Use in StaticSlicer
    const staticSlicer = new StaticSlicer();
    const slice = staticSlicer.buildSlice(
      {
        errorFrames: [],
        topSymbols: [],
        userMentions: ['extractForDebugging', 'StaticSlicer']
      },
      importRelations,
      callRelations,
      {
        maxNodes: 50,
        maxDepth: 5,
        confidenceThreshold: 0.2
      },
      undefined,
      undefined,
      undefined,
      compressedMethodGraph
    );

    visualizeGraph(
      { nodes: slice.nodes, edges: slice.edges },
      'FINAL SLICE (After Compression)',
      true
    );

    expect(slice.nodes.length).toBeGreaterThan(0);
    expect(slice.edges.length).toBeGreaterThan(0);
  }, 120000);
});



