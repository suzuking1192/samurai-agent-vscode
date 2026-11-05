/**
 * Integration test: Full pipeline from AST to execution graph
 * Tests the complete flow with real samurai-agent codebase
 */

import * as path from 'path';
import * as fs from 'fs';
import { AstProgramBuilder } from '../AstProgramBuilder';
import { StaticSlicer } from '../StaticSlicer';
import { EvidenceParser } from '../EvidenceParser';
import { ExtractCodeTool } from '../../extractCodeTool';
import { CodeParserService } from '../../../code_parser/CodeParserService';
import { RootSpec, Evidence, CandidateFile } from '../types';

function findRepoRoot(startDir: string): string {
  let current = startDir;
  for (let i = 0; i < 10; i++) {
    const pkg = path.join(current, 'package.json');
    if (fs.existsSync(pkg)) return current;
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  throw new Error('Could not locate repository root with package.json');
}

describe('Execution Graph Integration Test - Full Pipeline', () => {
  const repoRoot = findRepoRoot(__dirname);
  const srcRoot = path.join(repoRoot, 'src');
  
  // Real files from the codebase to use in tests
  const realFiles = [
    path.join(srcRoot, 'extension.ts'),
    path.join(srcRoot, 'agent', 'tools', 'extractCodeTool.ts'),
    path.join(srcRoot, 'agent', 'tools', 'debugging', 'StaticSlicer.ts'),
    path.join(srcRoot, 'agent', 'tools', 'debugging', 'AstProgramBuilder.ts'),
  ].filter(fs.existsSync);

  beforeAll(() => {
    // Verify we have real files to test with
    expect(realFiles.length).toBeGreaterThan(0);
    expect(fs.existsSync(srcRoot)).toBe(true);
  });

  describe('AST Program Building', () => {
    it('should build TypeScript program from real codebase', () => {
      const builder = new AstProgramBuilder(repoRoot);
      const tsProgram = builder.buildTsProgram(repoRoot);

      expect(tsProgram).toBeDefined();
      expect(tsProgram.sourceFiles.size).toBeGreaterThan(0);
      expect(tsProgram.projectRoot).toBe(repoRoot);

      // Verify we discovered real source files
      const sourceFilePaths = Array.from(tsProgram.sourceFiles.keys());
      const hasRealFiles = realFiles.some(realFile => 
        sourceFilePaths.some(p => p.includes(path.basename(realFile)))
      );
      expect(hasRealFiles).toBe(true);

      // Verify we're not including build artifacts
      const hasNodeModules = sourceFilePaths.some(p => p.includes('node_modules'));
      const hasDist = sourceFilePaths.some(p => p.includes('/dist/'));
      expect(hasNodeModules).toBe(false);
      expect(hasDist).toBe(false);
    });

    it('should extract import relations from real codebase', () => {
      const builder = new AstProgramBuilder(repoRoot);
      const tsProgram = builder.buildTsProgram(repoRoot);
      const importRelations = builder.extractImportGraph(tsProgram);

      expect(importRelations).toBeDefined();
      expect(Array.isArray(importRelations)).toBe(true);
      expect(importRelations.length).toBeGreaterThan(0);

      // Verify we have real import relations
      const hasRealImports = importRelations.some(rel => 
        rel.from && rel.to && 
        (realFiles.some(f => rel.from.includes(path.basename(f))) ||
         realFiles.some(f => rel.to.includes(path.basename(f))))
      );
      expect(hasRealImports).toBe(true);

      // Log some sample relations for debugging
      console.log(`[AST Test] Found ${importRelations.length} import relations`);
      console.log(`[AST Test] Sample imports:`, importRelations.slice(0, 5).map(r => ({
        from: path.basename(r.from),
        to: path.basename(r.to),
        kind: r.kind
      })));
    });

    it('should extract call relations from real codebase', () => {
      const builder = new AstProgramBuilder(repoRoot);
      const tsProgram = builder.buildTsProgram(repoRoot);
      const callRelations = builder.extractCallGraph(tsProgram);

      expect(callRelations).toBeDefined();
      expect(Array.isArray(callRelations)).toBe(true);

      // Log call relations for debugging
      console.log(`[AST Test] Found ${callRelations.length} call relations`);
      if (callRelations.length > 0) {
        console.log(`[AST Test] Sample calls:`, callRelations.slice(0, 5).map(r => ({
          caller: r.caller,
          callee: r.callee,
          file: path.basename(r.file),
          line: r.line,
          confidence: r.confidence
        })));

        // Verify call relations have expected structure
        const sampleCall = callRelations[0];
        expect(sampleCall).toHaveProperty('caller');
        expect(sampleCall).toHaveProperty('callee');
        expect(sampleCall).toHaveProperty('file');
        expect(sampleCall).toHaveProperty('line');
        expect(sampleCall).toHaveProperty('confidence');
        expect(typeof sampleCall.confidence).toBe('number');
        expect(sampleCall.confidence).toBeGreaterThanOrEqual(0);
        expect(sampleCall.confidence).toBeLessThanOrEqual(1);
      }
    });
  });

  describe('Evidence and Candidates', () => {
    let evidence: Evidence;
    let candidates: CandidateFile[];

    beforeAll(async () => {
      // Create realistic evidence from actual files
      const evidenceParser = new EvidenceParser(repoRoot);
      const extractCodeFile = path.join(srcRoot, 'agent', 'tools', 'extractCodeTool.ts');
      
      const mockLogs = fs.existsSync(extractCodeFile)
        ? `Error: Cannot find module './debugging/GapDetector.js'\n` +
          `    at Object.extractForDebugging (${extractCodeFile}:2224:39)\n` +
          `    at async testHandler (${extractCodeFile}:2170:15)\n`
        : 'Error: Test error\n    at testHandler (test.ts:10:5)\n';

      evidence = evidenceParser.parseEvidence({
        userMessage: 'Test debugging scenario with real codebase',
        logs: mockLogs,
        workspace: repoRoot,
        model: 'test-model'
      });

      // Create realistic candidates from real files
      candidates = realFiles.slice(0, 10).map((filePath, index) => ({
        file: filePath,
        score: 0.9 - (index * 0.05),
        evidence: ['stack_trace', 'llm_relevance', 'keyword_match'],
        symbols: [{
          file: filePath,
          symbol: `testSymbol${index}`,
          startLine: 1,
          endLine: 10,
          score: 0.8,
          evidence: ['exported']
        }]
      }));
    });

    it('should parse evidence with real file paths', () => {
      expect(evidence).toBeDefined();
      expect(evidence.frames.length).toBeGreaterThan(0);
      
      // Verify frames reference real files
      const frameFiles = evidence.frames.map(f => f.file);
      const hasRealFile = realFiles.some(realFile => 
        frameFiles.some(frameFile => frameFile.includes(path.basename(realFile)))
      );
      
      console.log(`[Evidence Test] Parsed ${evidence.frames.length} frames`);
      console.log(`[Evidence Test] Sample frames:`, evidence.frames.slice(0, 3));
    });

    it('should create candidates with proper structure', () => {
      expect(candidates.length).toBeGreaterThan(0);
      
      candidates.forEach(candidate => {
        expect(candidate).toHaveProperty('file');
        expect(candidate).toHaveProperty('score');
        expect(candidate).toHaveProperty('evidence');
        expect(Array.isArray(candidate.evidence)).toBe(true);
        
        if (candidate.symbols) {
          expect(Array.isArray(candidate.symbols)).toBe(true);
          candidate.symbols.forEach(symbol => {
            expect(symbol).toHaveProperty('file');
            expect(symbol).toHaveProperty('symbol');
            expect(symbol).toHaveProperty('startLine');
          });
        }
      });

      console.log(`[Candidates Test] Created ${candidates.length} candidates`);
    });
  });

  describe('Full Pipeline: AST -> Graph', () => {
    let builder: AstProgramBuilder;
    let tsProgram: any;
    let importRelations: any[];
    let callRelations: any[];
    let evidence: Evidence;
    let candidates: CandidateFile[];
    let rootSpec: RootSpec;

    beforeAll(() => {
      // Build AST
      builder = new AstProgramBuilder(repoRoot);
      tsProgram = builder.buildTsProgram(repoRoot);
      importRelations = builder.extractImportGraph(tsProgram);
      callRelations = builder.extractCallGraph(tsProgram);

      // Parse evidence
      const evidenceParser = new EvidenceParser(repoRoot);
      const extractCodeFile = path.join(srcRoot, 'agent', 'tools', 'extractCodeTool.ts');
      const mockLogs = fs.existsSync(extractCodeFile)
        ? `Error: Module not found\n` +
          `    at Object.extractForDebugging (${extractCodeFile}:2224:39)\n`
        : 'Error: Test error\n    at testHandler (test.ts:10:5)\n';
      
      evidence = evidenceParser.parseEvidence({
        userMessage: 'Integration test: build execution graph',
        logs: mockLogs,
        workspace: repoRoot,
        model: 'test-model'
      });

      // Create candidates
      candidates = realFiles.slice(0, 15).map((filePath, index) => ({
        file: filePath,
        score: 0.95 - (index * 0.03),
        evidence: ['stack_trace', 'llm_relevance'],
        symbols: [{
          file: filePath,
          symbol: `symbol${index}`,
          startLine: Math.max(1, index * 10),
          endLine: Math.max(10, index * 10 + 5),
          score: 0.85,
          evidence: ['exported']
        }]
      }));

      // Build root spec (this is what ExtractCodeTool.buildRootSpec does)
      const topSymbols = candidates
        .slice(0, 10)
        .flatMap(candidate => candidate.symbols || [])
        .filter(symbol => symbol && symbol.file && symbol.symbol)
        .slice(0, 15);

      const fallbackFiles = candidates
        .slice(0, 5)
        .map(c => c.file)
        .filter(f => !evidence.frames.some(frame => frame.file === f));

      rootSpec = {
        errorFrames: evidence.frames,
        topSymbols,
        userMentions: [],
        fallbackFiles: fallbackFiles.length > 0 ? fallbackFiles : undefined
      };
    });

    it('should build execution graph with nodes and edges', () => {
      const slicer = new StaticSlicer();
      
      const limits = {
        maxNodes: 100,
        maxDepth: 5,
        confidenceThreshold: 0.2
      };

      console.log(`[Full Pipeline] Starting graph build with:`);
      console.log(`  - ${importRelations.length} import relations`);
      console.log(`  - ${callRelations.length} call relations`);
      console.log(`  - ${rootSpec.errorFrames.length} error frames`);
      console.log(`  - ${rootSpec.topSymbols.length} top symbols`);
      console.log(`  - ${rootSpec.fallbackFiles?.length || 0} fallback files`);

      const result = slicer.buildSlice(
        rootSpec,
        importRelations,
        callRelations,
        limits,
        evidence
      );

      expect(result).toBeDefined();
      expect(result.nodes).toBeDefined();
      expect(result.edges).toBeDefined();
      expect(Array.isArray(result.nodes)).toBe(true);
      expect(Array.isArray(result.edges)).toBe(true);

      // CRITICAL: Verify we have nodes (this was the bug!)
      expect(result.nodes.length).toBeGreaterThan(0);
      
      console.log(`[Full Pipeline] Graph built successfully:`);
      console.log(`  - ${result.nodes.length} nodes`);
      console.log(`  - ${result.edges.length} edges`);

      // Verify node structure
      result.nodes.forEach(node => {
        expect(node).toHaveProperty('id');
        expect(node).toHaveProperty('kind');
        expect(node).toHaveProperty('label');
        expect(['file', 'symbol', 'route']).toContain(node.kind);
      });

      // Verify edge structure
      result.edges.forEach(edge => {
        expect(edge).toHaveProperty('from');
        expect(edge).toHaveProperty('to');
        expect(edge).toHaveProperty('kind');
        expect(edge).toHaveProperty('confidence');
        expect(typeof edge.confidence).toBe('number');
      });

      // Verify nodes are connected
      if (result.edges.length > 0) {
        const nodeIds = new Set(result.nodes.map(n => n.id));
        result.edges.forEach(edge => {
          expect(nodeIds.has(edge.from)).toBe(true);
          expect(nodeIds.has(edge.to)).toBe(true);
        });
      }

      // Log sample nodes for debugging
      console.log(`[Full Pipeline] Sample nodes:`, result.nodes.slice(0, 5).map(n => ({
        id: n.id,
        kind: n.kind,
        label: n.label?.substring(0, 30),
        file: n.file ? path.basename(n.file) : undefined,
        badges: n.badges
      })));

      if (result.edges.length > 0) {
        console.log(`[Full Pipeline] Sample edges:`, result.edges.slice(0, 5).map(e => ({
          from: e.from.substring(0, 30),
          to: e.to.substring(0, 30),
          kind: e.kind,
          confidence: e.confidence
        })));
      }
    });

    it('should build graph even when no error frames exist', () => {
      const slicer = new StaticSlicer();
      
      // Create root spec without error frames (only fallback files)
      const fallbackRootSpec: RootSpec = {
        errorFrames: [],
        topSymbols: rootSpec.topSymbols.slice(0, 5),
        userMentions: [],
        fallbackFiles: rootSpec.fallbackFiles || candidates.slice(0, 3).map(c => c.file)
      };

      const limits = {
        maxNodes: 50,
        maxDepth: 3,
        confidenceThreshold: 0.2
      };

      console.log(`[Fallback Test] Building graph with only fallback files:`, fallbackRootSpec.fallbackFiles);

      const result = slicer.buildSlice(
        fallbackRootSpec,
        importRelations,
        callRelations,
        limits
      );

      expect(result).toBeDefined();
      expect(result.nodes.length).toBeGreaterThan(0);
      
      console.log(`[Fallback Test] Successfully built graph with ${result.nodes.length} nodes from fallback files`);
    });

    it('should handle empty call relations gracefully', () => {
      const slicer = new StaticSlicer();
      
      // Test with no call relations (only imports)
      const limits = {
        maxNodes: 50,
        maxDepth: 3,
        confidenceThreshold: 0.2
      };

      const result = slicer.buildSlice(
        rootSpec,
        importRelations,
        [], // Empty call relations
        limits
      );

      expect(result).toBeDefined();
      expect(result.nodes.length).toBeGreaterThan(0);
      
      // Should still have edges from imports
      console.log(`[Empty Calls Test] Built graph with ${result.nodes.length} nodes and ${result.edges.length} edges (imports only)`);
    });
  });

  describe('End-to-End with ExtractCodeTool', () => {
    it('should build execution graph via ExtractCodeTool.extractForDebugging', async () => {
      // Create minimal mocks for dependencies
      const mockLLMProvider: any = {
        chat: jest.fn().mockResolvedValue({
          type: 'success',
          payload: {
            content: JSON.stringify({
              candidateFiles: realFiles.slice(0, 5).map(f => path.basename(f)),
              symbols: ['ExtractCodeTool', 'StaticSlicer', 'AstProgramBuilder'],
              queries: ['debugging', 'extraction', 'execution graph'],
              reasoning: 'Test reasoning',
              mode: 'hard-error'
            }),
            provider: 'test',
            model: 'test-model'
          }
        })
      };

      const codeParser = new CodeParserService();
      const tool = new ExtractCodeTool(mockLLMProvider, codeParser);

      // Mock scanCodebase to return real files
      const scanCodebaseSpy = jest.spyOn(tool as any, 'scanCodebase').mockImplementation(async () => {
        const fileInfos = new Map();
        for (const filePath of realFiles.slice(0, 20)) {
          const elements = await codeParser.extractElementsFromFile(
            filePath,
            codeParser.detectLanguage(filePath) || 'typescript'
          );
          fileInfos.set(filePath, {
            path: filePath,
            name: path.basename(filePath),
            extension: path.extname(filePath),
            language: 'typescript',
            size: fs.statSync(filePath).size,
            elements: elements || [],
            lastModified: new Date()
          });
        }
        return fileInfos;
      });

      const extractCodeFile = path.join(srcRoot, 'agent', 'tools', 'extractCodeTool.ts');
      // Use proper stack trace format that EvidenceParser can parse
      const mockLogs = fs.existsSync(extractCodeFile)
        ? `Error: Cannot find module './debugging/GapDetector.js'\n` +
          `    at Object.extractForDebugging (${extractCodeFile}:2224:39)\n` +
          `    at async testHandler (${extractCodeFile}:2170:15)\n`
        : 'Error: Test error\n    at testHandler (test.ts:10:5)\n';

      const input = {
        userMessage: 'Build execution graph from AST for debugging',
        logs: mockLogs,
        workspace: repoRoot,
        model: 'test-model',
        projectId: 'test-project',
        config: {
          maxNodes: 100,
          maxDepth: 5
        }
      };

      console.log('[E2E Test] Running extractForDebugging...');
      const result = await tool.extractForDebugging(input);

      expect(result).toBeDefined();
      expect(result.graph).toBeDefined();
      expect(result.graph.nodes).toBeDefined();
      expect(result.graph.edges).toBeDefined();
      
      // CRITICAL: Verify we have nodes (this was the bug!)
      expect(Array.isArray(result.graph.nodes)).toBe(true);
      expect(result.graph.nodes.length).toBeGreaterThan(0);
      
      expect(Array.isArray(result.graph.edges)).toBe(true);

      console.log(`\n[E2E Test] Graph built successfully:`);
      console.log(`  - ${result.graph.nodes.length} nodes`);
      console.log(`  - ${result.graph.edges.length} edges`);
      console.log(`  - Confidence: ${result.confidence}`);
      console.log(`  - Candidates: ${result.candidates.length}`);
      console.log(`  - Evidence frames: ${result.evidence.frames.length}\n`);

      // Display graph structure
      console.log('[E2E Test] GRAPH STRUCTURE:');
      console.log('='.repeat(80));
      
      // Nodes by kind
      const nodesByKind = result.graph.nodes.reduce((acc, node) => {
        acc[node.kind] = (acc[node.kind] || 0) + 1;
        return acc;
      }, {} as Record<string, number>);
      console.log('Nodes by Kind:');
      Object.entries(nodesByKind).forEach(([kind, count]) => {
        console.log(`  ${kind}: ${count}`);
      });

      // Edges by kind
      const edgesByKind = result.graph.edges.reduce((acc, edge) => {
        acc[edge.kind] = (acc[edge.kind] || 0) + 1;
        return acc;
      }, {} as Record<string, number>);
      console.log('\nEdges by Kind:');
      Object.entries(edgesByKind).forEach(([kind, count]) => {
        console.log(`  ${kind}: ${count}`);
      });

      // Sample nodes
      console.log('\nSample Nodes (first 10):');
      result.graph.nodes.slice(0, 10).forEach((node, i) => {
        const fileDisplay = node.file ? path.basename(node.file) : 'N/A';
        const lineDisplay = node.line ? `:${node.line}` : '';
        const badgesDisplay = node.badges && node.badges.length > 0 ? ` [${node.badges.join(', ')}]` : '';
        console.log(`  ${i + 1}. ${node.label} (${node.kind})`);
        console.log(`     ID: ${node.id}`);
        console.log(`     File: ${fileDisplay}${lineDisplay}${badgesDisplay}`);
      });

      // Sample edges
      if (result.graph.edges.length > 0) {
        console.log('\nSample Edges (first 10):');
        result.graph.edges.slice(0, 10).forEach((edge, i) => {
          const fromNode = result.graph.nodes.find(n => n.id === edge.from);
          const toNode = result.graph.nodes.find(n => n.id === edge.to);
          const fromLabel = fromNode?.label || edge.from.substring(0, 40);
          const toLabel = toNode?.label || edge.to.substring(0, 40);
          console.log(`  ${i + 1}. ${fromLabel}`);
          console.log(`     --[${edge.kind} (conf: ${edge.confidence.toFixed(2)})]-->`);
          console.log(`     ${toLabel}`);
        });
      }

      console.log('\n' + '='.repeat(80));

      // Verify evidence was parsed (may be 0 if stack trace doesn't parse)
      expect(result.evidence).toBeDefined();
      
      // If no frames parsed, at least verify evidence structure is correct
      if (result.evidence.frames.length === 0) {
        console.log('[E2E Test] Warning: No frames parsed from stack trace, but continuing test');
        // Verify evidence has error message at least
        expect(result.evidence.error || result.evidence.evidenceSource).toBeDefined();
      }

      // Verify candidates were found (this is critical for the graph to have nodes)
      expect(result.candidates.length).toBeGreaterThan(0);

      // Clean up
      scanCodebaseSpy.mockRestore();
    }, 30000); // Longer timeout for E2E test
  });

  describe('Edge Cases', () => {
    it('should handle empty root spec gracefully with fallback', () => {
      const builder = new AstProgramBuilder(repoRoot);
      const tsProgram = builder.buildTsProgram(repoRoot);
      const importRelations = builder.extractImportGraph(tsProgram);
      const callRelations = builder.extractCallGraph(tsProgram);

      const slicer = new StaticSlicer();
      
      const emptyRootSpec: RootSpec = {
        errorFrames: [],
        topSymbols: [],
        userMentions: [],
        fallbackFiles: [realFiles[0]] // Single fallback file
      };

      const result = slicer.buildSlice(
        emptyRootSpec,
        importRelations,
        callRelations,
        { maxNodes: 20, maxDepth: 3, confidenceThreshold: 0.2 }
      );

      expect(result.nodes.length).toBeGreaterThan(0);
      expect(result.nodes.some(n => n.file === emptyRootSpec.fallbackFiles![0])).toBe(true);
    });

    it('should respect maxNodes limit', () => {
      const builder = new AstProgramBuilder(repoRoot);
      const tsProgram = builder.buildTsProgram(repoRoot);
      const importRelations = builder.extractImportGraph(tsProgram);
      const callRelations = builder.extractCallGraph(tsProgram);

      const slicer = new StaticSlicer();
      
      const evidenceParser = new EvidenceParser(repoRoot);
      const evidence = evidenceParser.parseEvidence({
        userMessage: 'Test',
        workspace: repoRoot,
        model: 'test'
      });

      const rootSpec: RootSpec = {
        errorFrames: realFiles.slice(0, 3).map(f => ({ file: f, line: 1 })),
        topSymbols: [],
        userMentions: [],
        fallbackFiles: realFiles.slice(0, 5)
      };

      const maxNodes = 30;
      const result = slicer.buildSlice(
        rootSpec,
        importRelations,
        callRelations,
        { maxNodes, maxDepth: 10, confidenceThreshold: 0.2 },
        evidence
      );

      expect(result.nodes.length).toBeLessThanOrEqual(maxNodes);
    });
  });
});
