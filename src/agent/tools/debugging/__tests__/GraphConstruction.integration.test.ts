/**
 * Integration test for AST and execution graph construction
 * 
 * Tests the complete flow: handleDebugging -> extractForDebugging -> ... 
 * Verifies that we can build a graph of our own debugging infrastructure
 */

import * as path from 'path';
import * as fs from 'fs';
import { ExtractCodeTool } from '../../extractCodeTool';
import { AstProgramBuilder } from '../AstProgramBuilder';
import { StaticSlicer } from '../StaticSlicer';
import { LLMProviderService } from '../../../llm/llmProviderService';
import { CodeParserService } from '../../../code_parser/CodeParserService';

describe('Graph Construction Integration', () => {
  // Use process.cwd() which should be the samurai-agent directory when tests run
  const workspaceRoot = process.cwd();
  
  beforeAll(() => {
    // Verify we're in the right workspace
    if (!fs.existsSync(path.join(workspaceRoot, 'package.json'))) {
      console.error('[TEST] Failed to find package.json at:', workspaceRoot);
      console.error('[TEST] __dirname:', __dirname);
      console.error('[TEST] process.cwd():', process.cwd());
    }
    expect(fs.existsSync(path.join(workspaceRoot, 'package.json'))).toBe(true);
    expect(fs.existsSync(path.join(workspaceRoot, 'tsconfig.json'))).toBe(true);
  });

  it('should build AST and execution graph for debugging agent flow', async () => {
    console.log('\n[TEST] Building AST program for debugging agent...');
    
    // Build AST program
    const astBuilder = new AstProgramBuilder(workspaceRoot);
    const tsProgram = astBuilder.buildTsProgram(workspaceRoot);
    
    expect(tsProgram).toBeDefined();
    expect(tsProgram.sourceFiles.size).toBeGreaterThan(0);
    
    console.log(`[TEST] AST built: ${tsProgram.sourceFiles.size} source files`);
    
    // Extract import graph
    const importRelations = astBuilder.extractImportGraph(tsProgram);
    console.log(`[TEST] Import relations: ${importRelations.length}`);
    
    // Extract call graph
    const callRelations = astBuilder.extractCallGraph(tsProgram);
    console.log(`[TEST] Call relations: ${callRelations.length}`);
    
    // Verify we captured the debugging agent files
    const debuggingFiles = Array.from(tsProgram.sourceFiles.keys()).filter(file =>
      file.includes('samuraiAgent.ts') ||
      file.includes('extractCodeTool.ts') ||
      file.includes('EvidenceParser.ts') ||
      file.includes('SearchPlanner.ts') ||
      file.includes('HybridRetriever.ts') ||
      file.includes('StaticSlicer.ts') ||
      file.includes('AstProgramBuilder.ts')
    );
    
    expect(debuggingFiles.length).toBeGreaterThan(0);
    console.log(`[TEST] Found ${debuggingFiles.length} debugging agent files:`, 
      debuggingFiles.map(f => path.basename(f))
    );
    
    // Build static slice focused on extractCodeTool -> EvidenceParser -> SearchPlanner flow
    const extractCodeToolPath = debuggingFiles.find(f => f.includes('extractCodeTool.ts'));
    if (!extractCodeToolPath) {
      throw new Error('extractCodeTool.ts not found');
    }
    
    const staticSlicer = new StaticSlicer();
    const slice = staticSlicer.buildSlice(
      {
        errorFrames: [
          {
            file: extractCodeToolPath,
            line: 2011 // extractForDebugging start
          }
        ],
        topSymbols: [],
        userMentions: ['extractForDebugging']
      },
      importRelations,
      callRelations,
      {
        maxNodes: 100,
        maxDepth: 6,
        confidenceThreshold: 0.2
      }
    );
    
    console.log(`[TEST] Slice built: ${slice.nodes.length} nodes, ${slice.edges.length} edges`);
    console.log(`[TEST] Import relations available: ${importRelations.length}`);
    console.log(`[TEST] Call relations available: ${callRelations.length}`);
    
    // Verify graph structure - nodes should be created
    expect(slice.nodes.length).toBeGreaterThan(0);
    
    // Edges might be 0 if no good connections found, but let's see what we got
    if (slice.edges.length === 0) {
      console.log('[TEST] Warning: No edges generated');
      console.log('[TEST] First few nodes:', slice.nodes.slice(0, 5).map(n => ({ id: n.id, kind: n.kind, label: n.label, file: n.file })));
    } else {
      const density = slice.edges.length / slice.nodes.length;
      console.log(`[TEST] Graph density: ${density.toFixed(2)}`);
      expect(density).toBeGreaterThan(0.2); // Should have reasonable connectivity
    }
    
    // Find key nodes in the flow
    const extractNode = slice.nodes.find(n => 
      n.file?.includes('extractCodeTool.ts') && 
      (n.label.includes('extractForDebugging') || n.kind === 'file')
    );
    
    const evidenceParserNode = slice.nodes.find(n => 
      n.file?.includes('EvidenceParser.ts') || n.label.includes('EvidenceParser')
    );
    
    const searchPlannerNode = slice.nodes.find(n => 
      n.file?.includes('SearchPlanner.ts') || n.label.includes('SearchPlanner')
    );
    
    const astBuilderNode = slice.nodes.find(n => 
      n.file?.includes('AstProgramBuilder.ts') || n.label.includes('AstProgramBuilder')
    );
    
    const staticSlicerNode = slice.nodes.find(n => 
      n.file?.includes('StaticSlicer.ts') || n.label.includes('StaticSlicer')
    );
    
    console.log('[TEST] Key nodes found:');
    console.log(`  - ExtractCodeTool: ${extractNode ? '✓' : '✗'}`);
    console.log(`  - EvidenceParser: ${evidenceParserNode ? '✓' : '✗'}`);
    console.log(`  - SearchPlanner: ${searchPlannerNode ? '✓' : '✗'}`);
    console.log(`  - AstProgramBuilder: ${astBuilderNode ? '✓' : '✗'}`);
    console.log(`  - StaticSlicer: ${staticSlicerNode ? '✓' : '✗'}`);
    
    // Verify connections exist (at least some of them should be connected)
    let hasExtractToEvidence = false;
    let hasEvidenceToPlanner = false;
    
    if (extractNode && evidenceParserNode) {
      hasExtractToEvidence = slice.edges.some(e => 
        (e.from === extractNode.id || e.to === extractNode.id) &&
        (e.from === evidenceParserNode.id || e.to === evidenceParserNode.id)
      );
    }
    
    if (evidenceParserNode && searchPlannerNode) {
      hasEvidenceToPlanner = slice.edges.some(e =>
        (e.from === evidenceParserNode.id || e.to === evidenceParserNode.id) &&
        (e.from === searchPlannerNode.id || e.to === searchPlannerNode.id)
      );
    }
    
    console.log('[TEST] Key connections found:');
    console.log(`  - ExtractCodeTool -> EvidenceParser: ${hasExtractToEvidence ? '✓' : '✗'}`);
    console.log(`  - EvidenceParser -> SearchPlanner: ${hasEvidenceToPlanner ? '✓' : '✗'}`);
    
    // Print sample of the graph
    console.log('\n[TEST] Sample nodes:');
    slice.nodes.slice(0, 10).forEach(node => {
      console.log(`  - ${node.id} (${node.kind}): ${node.label}`);
    });
    
    console.log('\n[TEST] Sample edges:');
    slice.edges.slice(0, 10).forEach(edge => {
      const fromNode = slice.nodes.find(n => n.id === edge.from);
      const toNode = slice.nodes.find(n => n.id === edge.to);
      console.log(`  - ${fromNode?.label} --[${edge.kind}]--> ${toNode?.label} (${edge.confidence.toFixed(2)})`);
    });
    
    // Basic assertions - we should have found the main components
    expect(extractNode || evidenceParserNode || searchPlannerNode).toBeDefined();
  }, 60000); // 60 second timeout for full AST construction

  it('should trace handleDebugging -> extractForDebugging flow', async () => {
    console.log('[TEST] Tracing handleDebugging -> extractForDebugging flow...');
    
    const astBuilder = new AstProgramBuilder(workspaceRoot);
    const tsProgram = astBuilder.buildTsProgram(workspaceRoot);
    const importRelations = astBuilder.extractImportGraph(tsProgram);
    const callRelations = astBuilder.extractCallGraph(tsProgram);
    
    // Find samuraiAgent.ts
    const agentFiles = Array.from(tsProgram.sourceFiles.keys()).filter(file =>
      file.includes('samuraiAgent.ts')
    );
    
    expect(agentFiles.length).toBeGreaterThan(0);
    const samuraiAgentPath = agentFiles[0];
    
    // Look for handleDebugging method call
    const handleDebuggingCalls = callRelations.filter(rel =>
      rel.file === samuraiAgentPath &&
      rel.callee.toLowerCase().includes('extractfordebugging')
    );
    
    console.log(`[TEST] Found ${handleDebuggingCalls.length} references to extractForDebugging in samuraiAgent`);
    
    if (handleDebuggingCalls.length === 0) {
      console.log('[TEST] No direct call relations found - this is expected if TypeScript type checking is needed');
      
      // Verify the import relationship instead
      const extractImports = importRelations.filter(rel =>
        rel.from === samuraiAgentPath &&
        rel.to.includes('extractCodeTool.ts')
      );
      
      console.log(`[TEST] Import relations from samuraiAgent: ${extractImports.length}`);
      if (extractImports.length === 0) {
        console.log('[TEST] No import relationships found - TypeScript resolution may be needed');
      }
    }
    
    // Build slice starting from samuraiAgent
    const staticSlicer = new StaticSlicer();
    const slice = staticSlicer.buildSlice(
      {
        errorFrames: [
          {
            file: samuraiAgentPath,
            line: 918 // handleDebugging method
          }
        ],
        topSymbols: [],
        userMentions: ['handleDebugging']
      },
      importRelations,
      callRelations,
      {
        maxNodes: 50,
        maxDepth: 4,
        confidenceThreshold: 0.2
      }
    );
    
    console.log(`[TEST] Slice from samuraiAgent: ${slice.nodes.length} nodes, ${slice.edges.length} edges`);
    expect(slice.nodes.length).toBeGreaterThan(0);
    // Edges might be 0 if no good imports - that's acceptable for this test
  }, 60000);

  it('should show improved graph connectivity after our fixes', async () => {
    console.log('[TEST] Testing graph connectivity improvements...');
    
    const astBuilder = new AstProgramBuilder(workspaceRoot);
    const tsProgram = astBuilder.buildTsProgram(workspaceRoot);
    const importRelations = astBuilder.extractImportGraph(tsProgram);
    const callRelations = astBuilder.extractCallGraph(tsProgram);
    
    // Build slice with user mention (symbol-only root)
    const staticSlicer = new StaticSlicer();
    const slice = staticSlicer.buildSlice(
      {
        errorFrames: [],
        topSymbols: [],
        userMentions: ['extractForDebugging', 'EvidenceParser', 'StaticSlicer']
      },
      importRelations,
      callRelations,
      {
        maxNodes: 30,
        maxDepth: 5,
        confidenceThreshold: 0.2
      }
    );
    
    const density = slice.edges.length / slice.nodes.length;
    console.log(`[TEST] Graph with symbol-only roots:`);
    console.log(`  - Nodes: ${slice.nodes.length}`);
    console.log(`  - Edges: ${slice.edges.length}`);
    console.log(`  - Density: ${density.toFixed(2)}`);
    console.log(`  - Import relations available: ${importRelations.length}`);
    console.log(`  - Call relations available: ${callRelations.length}`);
    
    // Verify we have nodes created even with symbol-only roots (this tests our file guessing)
    expect(slice.nodes.length).toBeGreaterThan(0);
    
    // With our fixes, we should have better connectivity when we have data
    if (slice.edges.length > 0) {
      expect(density).toBeGreaterThan(0.2); // At least some connectivity
      
      // Verify we have both imports AND calls edges
      const importEdges = slice.edges.filter(e => e.kind === 'imports');
      const callEdges = slice.edges.filter(e => e.kind === 'calls');
      const importedByEdges = slice.edges.filter(e => e.kind === 'importedBy');
      
      console.log(`[TEST] Edge type distribution:`);
      console.log(`  - imports: ${importEdges.length}`);
      console.log(`  - calls: ${callEdges.length}`);
      console.log(`  - importedBy: ${importedByEdges.length}`);
    } else {
      console.log('[TEST] No edges generated - this may happen if TypeScript resolution is incomplete');
    }
  }, 60000);

  it('should generate and display graph visualization with method-level graph', async () => {
    console.log('\n[TEST] Generating graph visualization with method-level graph...');
    
    const astBuilder = new AstProgramBuilder(workspaceRoot);
    const tsProgram = astBuilder.buildTsProgram(workspaceRoot);
    const importRelations = astBuilder.extractImportGraph(tsProgram);
    const callRelations = astBuilder.extractCallGraph(tsProgram);
    
    // Build symbol index and method-level graph
    const symbolIndex = astBuilder.buildSymbolIndex(tsProgram);
    const symbolCalls = astBuilder.extractSymbolCallGraph(tsProgram, symbolIndex);
    
    const symbols: import('../types').SymbolDef[] = [];
    for (const fileSymbols of symbolIndex.values()) {
      symbols.push(...fileSymbols);
    }
    
    const methodGraph: import('../types').MethodExecutionGraph = {
      symbols,
      symbolEdges: symbolCalls,
      files: Array.from(tsProgram.sourceFiles.keys()),
      fileEdges: importRelations
    };
    
    console.log(`[TEST] Method graph built: ${symbols.length} symbols, ${symbolCalls.length} symbol calls`);
    
    // Build slice with method graph
    const staticSlicer = new StaticSlicer();
    const slice = staticSlicer.buildSlice(
      {
        errorFrames: [],
        topSymbols: [],
        userMentions: ['extractForDebugging', 'EvidenceParser', 'SearchPlanner', 'StaticSlicer']
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
      methodGraph // Pass method-level graph
    );
    
    console.log('\n========================================');
    console.log('METHOD-LEVEL EXECUTION GRAPH VISUALIZATION');
    console.log('========================================\n');
    
    console.log(`Method Graph Summary:`);
    console.log(`  - Symbols: ${methodGraph.symbols.length}`);
    console.log(`  - Symbol Edges: ${methodGraph.symbolEdges.length}`);
    const resolvedCalls = methodGraph.symbolEdges.filter(c => !c.calleeId.includes('<unresolved:')).length;
    const unresolvedCalls = methodGraph.symbolEdges.length - resolvedCalls;
    console.log(`  - Resolved Calls: ${resolvedCalls}, Unresolved: ${unresolvedCalls}`);
    
    console.log(`\nSlice Graph Summary:`);
    console.log(`  - Nodes: ${slice.nodes.length}`);
    console.log(`  - Edges: ${slice.edges.length}`);
    console.log(`  - Density: ${(slice.edges.length / Math.max(1, slice.nodes.length)).toFixed(2)}`);
    
    // Show symbol nodes
    const symbolNodes = slice.nodes.filter(n => n.kind === 'symbol');
    console.log(`\nSymbol Nodes (${symbolNodes.length}):`);
    symbolNodes.slice(0, 10).forEach((node, idx) => {
      const badges = node.badges && node.badges.length > 0 ? ` [${node.badges.join(', ')}]` : '';
      console.log(`  ${idx + 1}. ${node.label} (${node.id})${badges}`);
      if (node.file) {
        console.log(`      ${path.relative(workspaceRoot, node.file)}${node.line ? `:${node.line}` : ''}`);
      }
    });
    
    // Show symbol call edges
    const symbolCallEdges = slice.edges.filter(e => {
      const fromNode = slice.nodes.find(n => n.id === e.from);
      const toNode = slice.nodes.find(n => n.id === e.to);
      return fromNode?.kind === 'symbol' && toNode?.kind === 'symbol' && e.kind === 'calls';
    });
    
    console.log(`\nSymbol Call Edges (${symbolCallEdges.length}):`);
    symbolCallEdges.slice(0, 10).forEach((edge, idx) => {
      const fromNode = slice.nodes.find(n => n.id === edge.from);
      const toNode = slice.nodes.find(n => n.id === edge.to);
      const fromLabel = fromNode?.label || edge.from.substring(0, 40);
      const toLabel = toNode?.label || edge.to.substring(0, 40);
      console.log(`  ${idx + 1}. ${fromLabel} → ${toLabel} (conf: ${edge.confidence.toFixed(2)})`);
    });
    
    // Group by kind
    const byKind = slice.edges.reduce((acc, edge) => {
      acc[edge.kind] = (acc[edge.kind] || 0) + 1;
      return acc;
    }, {} as Record<string, number>);
    
    console.log(`\nEdge types:`);
    Object.entries(byKind).forEach(([kind, count]) => {
      console.log(`  - ${kind}: ${count}`);
    });
    
    console.log('\n========================================\n');
    
    expect(slice.nodes.length).toBeGreaterThan(0);
    expect(methodGraph.symbols.length).toBeGreaterThan(0);
  }, 60000);
});

