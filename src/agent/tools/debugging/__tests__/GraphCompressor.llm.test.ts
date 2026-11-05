/**
 * Integration test for GraphCompressor with actual LLM calls
 * Tests graph compression and condensation using Gemini 2.5 Flash model
 * 
 * Requires: Add your Gemini API key to test-config/gemini-test-key.json
 */

import * as path from 'path';
import * as fs from 'fs';
import { AstProgramBuilder } from '../AstProgramBuilder';
import { GraphCompressor, convertCompressedToMethodGraph } from '../GraphCompressor';
import { StaticSlicer } from '../StaticSlicer';
import { LLMProviderService } from '../../../llm/llmProviderService';
import { GeminiChatClient } from '../../../llm/geminiChatClient';
import { GlobalDataStore } from '../../../../persistence/globalDataStore';
import { MethodExecutionGraph } from '../types';

interface TestKeyConfig {
  geminiApiKey: string;
  model: string;
  note?: string;
}

function loadTestKey(): string | null {
  const testKeyPath = path.join(process.cwd(), 'test-config', 'gemini-test-key.json');
  
  if (!fs.existsSync(testKeyPath)) {
    console.warn(`\n⚠️  Test key file not found: ${testKeyPath}`);
    console.warn('   Please create test-config/gemini-test-key.json with your Gemini API key');
    console.warn('   Example: { "geminiApiKey": "your-key-here", "model": "gemini-2.5-flash" }\n');
    return null;
  }

  try {
    const content = fs.readFileSync(testKeyPath, 'utf8');
    const config: TestKeyConfig = JSON.parse(content);
    
    if (!config.geminiApiKey || config.geminiApiKey === 'YOUR_GEMINI_API_KEY_HERE') {
      console.warn(`\n⚠️  Please add your actual Gemini API key to ${testKeyPath}\n`);
      return null;
    }

    return config.geminiApiKey;
  } catch (error) {
    console.error(`Error loading test key: ${error}`);
    return null;
  }
}

function createLLMProviderWithTestKey(geminiApiKey: string): LLMProviderService {
  // Create a mock GlobalDataStore with test API key
  const globalDataStore = {
    loadGlobalSettings: () => ({
      type: 'success' as const,
      payload: {
        id: 'test-settings',
        userId: 'test-user',
        openaiApiKey: '',
        geminiApiKey: geminiApiKey,
        claudeApiKey: '',
        defaultProvider: 'google',
        defaultModel: 'gemini-2.5-flash',
        defaultMode: 'default',
        fontSize: 14,
        showTokenCounts: true,
        showCostEstimates: true,
        autoSaveInterval: 30,
        maxHistoryItems: 100,
        enableNotifications: true,
        customApiEndpoints: {},
        metadata: {},
        createdAt: new Date(),
        updatedAt: new Date()
      }
    }),
    saveGlobalSettings: () => ({ type: 'success' as const })
  } as any;

  const llmProvider = new LLMProviderService(globalDataStore);
  
  // Register Gemini client
  llmProvider.registerClient('google', new GeminiChatClient());

  return llmProvider;
}

function visualizeResults(
  original: { nodes: any[]; edges: any[] },
  compressed: { nodes: any[]; edges: any[] },
  compressedWithLLM: { nodes: any[]; edges: any[] } | null,
  meta: any,
  metaWithLLM: any | null
) {
  console.log('\n' + '='.repeat(80));
  console.log('GRAPH COMPRESSION RESULTS WITH LLM');
  console.log('='.repeat(80));

  console.log('\nOriginal Graph:');
  console.log(`  Nodes: ${original.nodes.length}`);
  console.log(`  Edges: ${original.edges.length}`);

  console.log('\nCompressed (Rule-based only):');
  console.log(`  Nodes: ${compressed.nodes.length} (reduced by ${original.nodes.length - compressed.nodes.length}, ${((original.nodes.length - compressed.nodes.length) / original.nodes.length * 100).toFixed(1)}%)`);
  console.log(`  Edges: ${compressed.edges.length} (reduced by ${original.edges.length - compressed.edges.length}, ${((original.edges.length - compressed.edges.length) / original.edges.length * 100).toFixed(1)}%)`);
  console.log(`  Source: ${meta.source}`);

  if (compressedWithLLM && metaWithLLM) {
    console.log('\nCompressed (With LLM Condensation):');
    console.log(`  Nodes: ${compressedWithLLM.nodes.length} (reduced by ${original.nodes.length - compressedWithLLM.nodes.length}, ${((original.nodes.length - compressedWithLLM.nodes.length) / original.nodes.length * 100).toFixed(1)}%)`);
    console.log(`  Edges: ${compressedWithLLM.edges.length} (reduced by ${original.edges.length - compressedWithLLM.edges.length}, ${((original.edges.length - compressedWithLLM.edges.length) / original.edges.length * 100).toFixed(1)}%)`);
    console.log(`  Source: ${metaWithLLM.source}`);
    
    console.log('\nLLM Compression Additional Reduction:');
    console.log(`  Nodes: ${compressed.nodes.length} → ${compressedWithLLM.nodes.length} (${((compressed.nodes.length - compressedWithLLM.nodes.length) / compressed.nodes.length * 100).toFixed(1)}% further reduction)`);
  }

  console.log('\n' + '='.repeat(80) + '\n');
}

describe('GraphCompressor with Actual LLM Calls', () => {
  const workspaceRoot = process.cwd();
  let geminiApiKey: string | null;

  beforeAll(() => {
    geminiApiKey = loadTestKey();
  });

  it('should compress graph with LLM condensation using Gemini 2.5 Flash', async () => {
    if (!geminiApiKey) {
      console.log('⏭️  Skipping LLM test - API key not configured');
      return;
    }

    console.log('\n[TEST] Building method-level graph...');

    // Build method graph
    const astBuilder = new AstProgramBuilder(workspaceRoot);
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

    console.log(`[TEST] Original graph: ${symbols.length} symbols, ${symbolCalls.length} symbol edges`);

    // Sample original graph for comparison
    const originalNodes = methodGraph.symbols
      .filter(s => s.name.includes('handleDebugging') || s.name.includes('extractForDebugging'))
      .slice(0, 20)
      .map(s => ({
        id: s.id,
        label: s.name,
        file: s.file,
        kind: 'symbol' as const,
        line: s.startLine
      }));

    const originalEdges = methodGraph.symbolEdges
      .filter(e => originalNodes.some(n => n.id === e.callerId || n.id === e.calleeId))
      .slice(0, 20)
      .map(e => ({
        from: e.callerId,
        to: e.calleeId,
        kind: 'calls' as const,
        confidence: e.confidence
      }));

    // Test 1: Compression WITHOUT LLM
    console.log('\n[TEST] Testing rule-based compression (no LLM)...');
    const llmProvider = createLLMProviderWithTestKey(geminiApiKey);
    const compressor = new GraphCompressor(llmProvider);

    const compressedWithoutLLM = await compressor.compress({
      methodGraph,
      focus: {
        entrySymbols: [
          { name: 'handleDebugging' },
          { name: 'extractForDebugging' }
        ],
        errorFrames: [],
        userMentions: ['StaticSlicer', 'GraphCompressor', 'EvidenceParser']
      },
      limits: {
        maxNodes: 100,
        maxDepth: 5,
        minConfidence: 0.45,
        targetNodeCount: 30
      }
    });

    console.log(`  ✓ Rule-based compression: ${compressedWithoutLLM.nodes.length} nodes`);

    // Test 2: Compression WITH LLM
    console.log('\n[TEST] Testing LLM condensation with Gemini 2.5 Flash...');
    
    const compressedWithLLM = await compressor.compress({
      methodGraph,
      focus: {
        entrySymbols: [
          { name: 'handleDebugging' },
          { name: 'extractForDebugging' }
        ],
        errorFrames: [],
        userMentions: ['StaticSlicer', 'GraphCompressor', 'EvidenceParser']
      },
      llm: {
        enabled: true,
        model: 'gemini-2.5-flash',
        maxTokens: 2000,
        temperature: 0.3
      },
      limits: {
        maxNodes: 100,
        maxDepth: 5,
        minConfidence: 0.45,
        targetNodeCount: 20
      }
    });

    console.log(`  ✓ LLM condensation: ${compressedWithLLM.nodes.length} nodes`);
    console.log(`  ✓ Source: ${compressedWithLLM.meta.source}`);

    // Verify handleDebugging is captured
    const hasHandleDebugging = compressedWithLLM.nodes.some(n =>
      n.label.includes('handleDebugging') || n.id.includes('handleDebugging')
    );

    console.log(`\n[TEST] handleDebugging captured: ${hasHandleDebugging ? '✓ YES' : '✗ NO'}`);
    
    if (hasHandleDebugging) {
      const handleDebuggingNodes = compressedWithLLM.nodes.filter(n =>
        n.label.includes('handleDebugging') || n.id.includes('handleDebugging')
      );
      console.log('  handleDebugging nodes:');
      handleDebuggingNodes.forEach(node => {
        console.log(`    - ${node.label} (line: ${node.line || 'N/A'})`);
      });
    }

    // Show visualization
    visualizeResults(
      { nodes: originalNodes, edges: originalEdges },
      { nodes: compressedWithoutLLM.nodes, edges: compressedWithoutLLM.edges },
      { nodes: compressedWithLLM.nodes, edges: compressedWithLLM.edges },
      compressedWithoutLLM.meta,
      compressedWithLLM.meta
    );

    // Show top nodes from LLM compression
    if (compressedWithLLM.nodes.length > 0) {
      console.log('Top 15 nodes from LLM-compressed graph:');
      compressedWithLLM.nodes.slice(0, 15).forEach((node, idx) => {
        const badges = node.badges && node.badges.length > 0 ? ` [${node.badges.join(', ')}]` : '';
        const fileDisplay = node.file ? path.basename(node.file) : 'N/A';
        console.log(`  ${String(idx + 1).padStart(3)}. ${node.label.padEnd(45)} (${node.kind})${badges}`);
        console.log(`       ${fileDisplay}${node.line ? `:${node.line}` : ''}`);
      });
    }

    // Assertions
    expect(compressedWithoutLLM.nodes.length).toBeGreaterThan(0);
    expect(compressedWithLLM.nodes.length).toBeGreaterThan(0);
    expect(compressedWithLLM.meta.source).toBe('static+llm');
    expect(hasHandleDebugging).toBe(true);
  }, 120000); // 2 minute timeout for LLM calls

  it('should recover unresolved symbols using LLM with Gemini 2.5 Flash', async () => {
    if (!geminiApiKey) {
      console.log('⏭️  Skipping LLM test - API key not configured');
      return;
    }

    console.log('\n[TEST] Testing LLM symbol resolution...');

    // Build a focused graph with many unresolved edges
    const astBuilder = new AstProgramBuilder(workspaceRoot);
    const tsProgram = astBuilder.buildTsProgram(workspaceRoot);
    const symbolIndex = astBuilder.buildSymbolIndex(tsProgram);
    const symbolCalls = astBuilder.extractSymbolCallGraph(tsProgram, symbolIndex);

    // Filter to symbols related to handleDebugging
    const handleDebuggingSymbol = Array.from(symbolIndex.values())
      .flat()
      .find(s => s.name.includes('handleDebugging'));

    if (!handleDebuggingSymbol) {
      console.log('⏭️  Skipping - handleDebugging symbol not found');
      return;
    }

    const symbols: import('../types').SymbolDef[] = [];
    for (const fileSymbols of symbolIndex.values()) {
      symbols.push(...fileSymbols);
    }

    // Filter to a subset for testing
    const focusedSymbols = symbols.filter(s =>
      s.file === handleDebuggingSymbol.file || 
      s.name.includes('extractForDebugging') ||
      s.name.includes('handleDebugging')
    );

    const focusedEdges = symbolCalls.filter(e =>
      focusedSymbols.some(s => s.id === e.callerId || s.id === e.calleeId)
    );

    const unresolvedCount = focusedEdges.filter(e => e.via === 'unresolved').length;
    const totalCount = focusedEdges.length;
    const ratio = totalCount > 0 ? unresolvedCount / totalCount : 0;

    console.log(`  Unresolved ratio: ${(ratio * 100).toFixed(1)}% (${unresolvedCount}/${totalCount})`);

    if (ratio <= 0.3 || totalCount < 20) {
      console.log('  ⏭️  Not enough unresolved edges to test LLM recovery');
      return;
    }

    const methodGraph: MethodExecutionGraph = {
      symbols: focusedSymbols,
      symbolEdges: focusedEdges,
      files: Array.from(tsProgram.sourceFiles.keys()),
      fileEdges: []
    };

    const llmProvider = createLLMProviderWithTestKey(geminiApiKey);
    const compressor = new GraphCompressor(llmProvider);

    const compressed = await compressor.compress({
      methodGraph,
      focus: {
        entrySymbols: [{ id: handleDebuggingSymbol.id }]
      },
      llm: {
        enabled: true,
        model: 'gemini-2.5-flash',
        maxTokens: 2000,
        temperature: 0.2
      },
      limits: {
        maxNodes: 50,
        maxDepth: 3,
        minConfidence: 0.35, // Lower threshold to allow unresolved edges
        targetNodeCount: 20
      }
    });

    console.log(`\n  ✓ Compression completed`);
    console.log(`  Nodes: ${compressed.nodes.length}`);
    console.log(`  Edges: ${compressed.edges.length}`);
    console.log(`  Unresolved edges in meta: ${compressed.meta.unresolvedEdges.length}`);

    // Check if any edges were recovered
    const llmRecoveredEdges = compressed.edges.filter(e =>
      e.evidence?.some(ev => ev.includes('llm-recovered') || ev.includes('llm-suggested'))
    );

    if (llmRecoveredEdges.length > 0) {
      console.log(`\n  ✓ LLM recovered ${llmRecoveredEdges.length} edges:`);
      llmRecoveredEdges.slice(0, 10).forEach((edge, idx) => {
        const fromNode = compressed.nodes.find(n => n.id === edge.from);
        const toNode = compressed.nodes.find(n => n.id === edge.to);
        const fromLabel = fromNode ? fromNode.label : edge.from.substring(0, 40);
        const toLabel = toNode ? toNode.label : edge.to.substring(0, 40);
        console.log(`    ${idx + 1}. ${fromLabel} → ${toLabel} (conf: ${edge.confidence.toFixed(2)})`);
      });
    }

    expect(compressed.nodes.length).toBeGreaterThan(0);
  }, 180000); // 3 minute timeout for LLM symbol resolution

  it('should show full execution path from handleDebugging with LLM', async () => {
    if (!geminiApiKey) {
      console.log('⏭️  Skipping LLM test - API key not configured');
      return;
    }

    console.log('\n[TEST] Building full execution path from handleDebugging with LLM...');

    const astBuilder = new AstProgramBuilder(workspaceRoot);
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

    // Find handleDebugging
    const handleDebugging = symbols.find(s =>
      s.name === 'SamuraiAgent.handleDebugging' ||
      (s.name.includes('handleDebugging') && path.basename(s.file) === 'samuraiAgent.ts')
    );

    if (!handleDebugging) {
      console.log('⏭️  handleDebugging not found');
      return;
    }

    console.log(`  ✓ Found handleDebugging: ${handleDebugging.name} (line ${handleDebugging.startLine})`);

    const llmProvider = createLLMProviderWithTestKey(geminiApiKey);
    const compressor = new GraphCompressor(llmProvider);

    // Compress with LLM focusing on handleDebugging execution path
    const compressed = await compressor.compress({
      methodGraph,
      focus: {
        entrySymbols: [{ id: handleDebugging.id }],
        errorFrames: [],
        userMentions: []
      },
      llm: {
        enabled: true,
        model: 'gemini-2.5-flash',
        maxTokens: 3000,
        temperature: 0.3
      },
      limits: {
        maxNodes: 50,
        maxDepth: 5,
        minConfidence: 0.35,
        targetNodeCount: 25
      }
    });

    console.log(`\n  ✓ Compressed graph: ${compressed.nodes.length} nodes, ${compressed.edges.length} edges`);

    // Build final slice
    const compressedMethodGraph = convertCompressedToMethodGraph(compressed, methodGraph);
    const staticSlicer = new StaticSlicer();
    const slice = staticSlicer.buildSlice(
      {
        errorFrames: [],
        topSymbols: [],
        userMentions: ['handleDebugging']
      },
      importRelations,
      callRelations,
      {
        maxNodes: 50,
        maxDepth: 5,
        confidenceThreshold: 0.2
      },
      undefined,
      {
        model: 'gemini-2.5-flash',
        temperature: 0.3,
        maxTokens: 2000
      },
      undefined,
      compressedMethodGraph
    );

    console.log(`\n  ✓ Final slice: ${slice.nodes.length} nodes, ${slice.edges.length} edges`);

    // Show execution path
    const handleDebuggingNode = slice.nodes.find(n =>
      n.label.includes('handleDebugging') || n.id.includes('handleDebugging')
    );

    if (handleDebuggingNode) {
      console.log('\n  Execution path from handleDebugging:');
      const edgesFrom = slice.edges.filter(e => e.from === handleDebuggingNode.id);
      const edgesTo = slice.edges.filter(e => e.to === handleDebuggingNode.id);

      console.log(`    Edges FROM handleDebugging: ${edgesFrom.length}`);
      edgesFrom.slice(0, 10).forEach((edge, idx) => {
        const toNode = slice.nodes.find(n => n.id === edge.to);
        const toLabel = toNode ? toNode.label : edge.to.substring(0, 50);
        console.log(`      ${idx + 1}. handleDebugging → ${toLabel}`);
      });

      console.log(`\n    Edges TO handleDebugging: ${edgesTo.length}`);
      edgesTo.slice(0, 5).forEach((edge, idx) => {
        const fromNode = slice.nodes.find(n => n.id === edge.from);
        const fromLabel = fromNode ? fromNode.label : edge.from.substring(0, 50);
        console.log(`      ${idx + 1}. ${fromLabel} → handleDebugging`);
      });
    }

    expect(slice.nodes.length).toBeGreaterThan(0);
    expect(handleDebuggingNode).toBeDefined();
  }, 180000);
});

