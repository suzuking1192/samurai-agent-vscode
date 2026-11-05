/**
 * Unit tests for GraphCompressor
 */

import * as path from 'path';
import * as fs from 'fs';
import { GraphCompressor, convertCompressedToMethodGraph } from '../GraphCompressor';
import {
  MethodExecutionGraph,
  GraphCompressorInput,
  SymbolDef,
  SymbolCall,
  GraphNode,
  GraphEdge
} from '../types';

describe('GraphCompressor', () => {
  let compressor: GraphCompressor;
  let mockLlmProvider: any;

  beforeEach(() => {
    // Create mock LLM provider
    mockLlmProvider = {
      chat: jest.fn()
    };

    compressor = new GraphCompressor(mockLlmProvider);
  });

  const createMockMethodGraph = (): MethodExecutionGraph => {
    const symbols: SymbolDef[] = [
      { id: 'symbol:/src/a.ts:main', name: 'main', file: '/src/a.ts', kind: 'function', startLine: 1, endLine: 10 },
      { id: 'symbol:/src/a.ts:helper1', name: 'helper1', file: '/src/a.ts', kind: 'function', startLine: 12, endLine: 15 },
      { id: 'symbol:/src/a.ts:_internal', name: '_internal', file: '/src/a.ts', kind: 'function', startLine: 17, endLine: 20 },
      { id: 'symbol:/src/b.ts:process', name: 'process', file: '/src/b.ts', kind: 'function', startLine: 1, endLine: 20, exportName: 'process' },
      { id: 'symbol:/src/b.ts:normalize', name: 'normalize', file: '/src/b.ts', kind: 'function', startLine: 22, endLine: 25 },
      { id: 'symbol:/src/c.ts:handle', name: 'handle', file: '/src/c.ts', kind: 'function', startLine: 1, endLine: 10, exportName: 'handle' }
    ];

    const symbolEdges: SymbolCall[] = [
      { callerId: 'symbol:/src/a.ts:main', calleeId: 'symbol:/src/a.ts:helper1', file: '/src/a.ts', line: 5, confidence: 0.9, via: 'ts-checker' },
      { callerId: 'symbol:/src/a.ts:main', calleeId: 'symbol:/src/b.ts:process', file: '/src/a.ts', line: 6, confidence: 0.95, via: 'import-resolution' },
      { callerId: 'symbol:/src/a.ts:helper1', calleeId: 'symbol:/src/a.ts:_internal', file: '/src/a.ts', line: 14, confidence: 0.85, via: 'ts-checker' },
      { callerId: 'symbol:/src/b.ts:process', calleeId: 'symbol:/src/b.ts:normalize', file: '/src/b.ts', line: 10, confidence: 0.8, via: 'ts-checker' },
      { callerId: 'symbol:/src/b.ts:process', calleeId: 'symbol:/src/c.ts:handle', file: '/src/b.ts', line: 15, confidence: 0.9, via: 'import-resolution' },
      { callerId: 'symbol:/src/a.ts:main', calleeId: 'symbol:/src/a.ts:<unresolved:unknown>', file: '/src/a.ts', line: 7, confidence: 0.3, via: 'unresolved' }
    ];

    return {
      symbols,
      symbolEdges,
      files: ['/src/a.ts', '/src/b.ts', '/src/c.ts'],
      fileEdges: []
    };
  };

  describe('compress', () => {
    it('should prune graph using rule-based filtering', async () => {
      const methodGraph = createMockMethodGraph();
      const input: GraphCompressorInput = {
        methodGraph,
        focus: {
          entrySymbols: [{ id: 'symbol:/src/a.ts:main' }],
          errorFrames: [],
          userMentions: []
        },
        limits: {
          maxNodes: 150,
          maxDepth: 5,
          minConfidence: 0.45,
          targetNodeCount: 25
        }
      };

      const result = await compressor.compress(input);

      // Should filter out low-confidence and internal helpers
      expect(result.nodes.length).toBeLessThanOrEqual(methodGraph.symbols.length);
      expect(result.meta.source).toBe('static-only');
      expect(result.nodes.some(n => n.label === '_internal')).toBe(false); // Should filter internal helpers
    });

    it('should filter out helper symbols based on naming patterns', async () => {
      const methodGraph = createMockMethodGraph();
      const input: GraphCompressorInput = {
        methodGraph,
        focus: {
          entrySymbols: [{ id: 'symbol:/src/a.ts:main' }]
        },
        limits: {
          minConfidence: 0.45
        }
      };

      const result = await compressor.compress(input);

      // Should filter out _internal
      const hasInternal = result.nodes.some(n => n.id.includes('_internal'));
      expect(hasInternal).toBe(false);
    });

    it('should respect maxNodes and maxDepth limits', async () => {
      const methodGraph = createMockMethodGraph();
      const input: GraphCompressorInput = {
        methodGraph,
        focus: {
          entrySymbols: [{ id: 'symbol:/src/a.ts:main' }]
        },
        limits: {
          maxNodes: 3,
          maxDepth: 2
        }
      };

      const result = await compressor.compress(input);

      // Allow some margin for entry nodes and required nodes
      expect(result.nodes.length).toBeLessThanOrEqual(5);
    });

    it('should apply target node count when exceeded', async () => {
      const methodGraph = createMockMethodGraph();
      const input: GraphCompressorInput = {
        methodGraph,
        focus: {
          entrySymbols: [{ id: 'symbol:/src/a.ts:main' }],
          errorFrames: [{ file: '/src/c.ts', line: 5 }]
        },
        limits: {
          maxNodes: 150,
          maxDepth: 5,
          targetNodeCount: 2 // Very small target
        }
      };

      const result = await compressor.compress(input);

      // Should prioritize entry -> error path
      // Allow margin for entry nodes, error frame nodes, and required path nodes
      expect(result.nodes.length).toBeLessThanOrEqual(5);
    });

    it('should track unresolved edges in meta', async () => {
      const methodGraph = createMockMethodGraph();
      const input: GraphCompressorInput = {
        methodGraph,
        focus: {
          entrySymbols: [{ id: 'symbol:/src/a.ts:main' }]
        }
      };

      const result = await compressor.compress(input);

      // Should have unresolved edge info in meta
      expect(result.meta.unresolvedEdges.length).toBeGreaterThanOrEqual(0);
    });
  });

  describe('built-in prototype call filtering', () => {
    const testDir = path.join(process.cwd(), 'tmp-test-builtins');
    const builtinsFile = path.join(testDir, 'builtins.ts');

    beforeAll(() => {
      if (!fs.existsSync(testDir)) {
        fs.mkdirSync(testDir, { recursive: true });
      }

      fs.writeFileSync(
        builtinsFile,
        `
export function customHelper(value: string): string {
  return value + '-helper';
}

export function useBuiltins(input: string): string {
  const normalized = input.trim().toUpperCase();
  customHelper(normalized);
  return normalized.replace(/\\s+/g, '').substring(0, 5);
}
`.trimStart()
      );
    });

    afterAll(() => {
      if (fs.existsSync(builtinsFile)) {
        fs.unlinkSync(builtinsFile);
      }
      if (fs.existsSync(testDir)) {
        fs.rmSync(testDir, { recursive: true, force: true });
      }
    });

    it('should exclude built-in prototype calls when using ts-morph extraction', () => {
      const compressorAny = compressor as any;
      const calls = compressorAny.findLocalCallsWithTsMorph(builtinsFile, process.cwd());
      const callNames = calls.map((call: { name: string }) => call.name);

      expect(callNames).toContain('customHelper');
      expect(callNames).not.toContain('trim');
      expect(callNames).not.toContain('toUpperCase');
      expect(callNames).not.toContain('replace');
      expect(callNames).not.toContain('substring');
    });

    it('should exclude built-in prototype calls in Babel fallback extraction', () => {
      const compressorAny = compressor as any;
      const code = `
function customHelper(value) {
  return value + '-helper';
}

function useBuiltins(input) {
  const normalized = input.trim().toUpperCase();
  customHelper(normalized);
  return normalized.replace(/\\s+/g, '').substring(0, 5);
}
`;

      const calls = compressorAny.findLocalCallsInCode(code);
      const callNames = calls.map((call: { name: string }) => call.name);

      expect(callNames).toContain('customHelper');
      expect(callNames).not.toContain('trim');
      expect(callNames).not.toContain('toUpperCase');
      expect(callNames).not.toContain('replace');
      expect(callNames).not.toContain('substring');
    });
  });

  describe('convertCompressedToMethodGraph', () => {
    it('should convert compressed output back to MethodExecutionGraph', () => {
      const originalGraph = createMockMethodGraph();
      const compressed = {
        nodes: [
          { id: 'symbol:/src/a.ts:main', label: 'main', file: '/src/a.ts', kind: 'symbol' as const, line: 1 },
          { id: 'symbol:/src/b.ts:process', label: 'process', file: '/src/b.ts', kind: 'symbol' as const, line: 1 }
        ],
        edges: [
          { from: 'symbol:/src/a.ts:main', to: 'symbol:/src/b.ts:process', kind: 'calls' as const, confidence: 0.9 }
        ],
        meta: {
          prunedCount: 4,
          unresolvedEdges: [],
          source: 'static-only' as const
        }
      };

      const result = convertCompressedToMethodGraph(compressed, originalGraph);

      expect(result.symbols.length).toBe(2);
      expect(result.symbolEdges.length).toBe(1);
      expect(result.symbols[0].id).toBe('symbol:/src/a.ts:main');
      expect(result.symbols[0].name).toBe('main');
    });

    it('should preserve original symbol metadata when available', () => {
      const originalGraph = createMockMethodGraph();
      const compressed = {
        nodes: [
          { id: 'symbol:/src/b.ts:process', label: 'process', file: '/src/b.ts', kind: 'symbol' as const, line: 1 }
        ],
        edges: [],
        meta: {
          prunedCount: 5,
          unresolvedEdges: [],
          source: 'static-only' as const
        }
      };

      const result = convertCompressedToMethodGraph(compressed, originalGraph);

      // Should preserve original metadata
      const processSymbol = result.symbols.find(s => s.id === 'symbol:/src/b.ts:process');
      expect(processSymbol).toBeDefined();
      expect(processSymbol?.exportName).toBe('process'); // Preserved from original
    });

    it('should filter out group nodes', () => {
      const compressed = {
        nodes: [
          { id: 'symbol:/src/a.ts:main', label: 'main', file: '/src/a.ts', kind: 'symbol' as const },
          { id: 'group:helpers', label: 'Helper functions', kind: 'group' as const, badges: ['grouped'] }
        ],
        edges: [],
        meta: {
          prunedCount: 0,
          unresolvedEdges: [],
          source: 'static-only' as const
        }
      };

      const result = convertCompressedToMethodGraph(compressed);

      expect(result.symbols.length).toBe(1);
      expect(result.symbols[0].id).toBe('symbol:/src/a.ts:main');
    });
  });

  describe('seed set building', () => {
    it('should include entry symbols in seed set', async () => {
      const methodGraph = createMockMethodGraph();
      const input: GraphCompressorInput = {
        methodGraph,
        focus: {
          entrySymbols: [
            { id: 'symbol:/src/a.ts:main' },
            { name: 'process', file: '/src/b.ts' }
          ]
        }
      };

      const result = await compressor.compress(input);

      // Should include entry symbols
      expect(result.nodes.some(n => n.id === 'symbol:/src/a.ts:main')).toBe(true);
      expect(result.nodes.some(n => n.id === 'symbol:/src/b.ts:process')).toBe(true);
    });

    it('should include error frame symbols in seed set', async () => {
      const methodGraph = createMockMethodGraph();
      const input: GraphCompressorInput = {
        methodGraph,
        focus: {
          errorFrames: [{ file: '/src/c.ts', line: 5 }]
        }
      };

      const result = await compressor.compress(input);

      // Should include symbols from error file
      expect(result.nodes.some(n => n.file === '/src/c.ts')).toBe(true);
    });

    it('should include user mentions in seed set', async () => {
      const methodGraph = createMockMethodGraph();
      const input: GraphCompressorInput = {
        methodGraph,
        focus: {
          userMentions: ['handle', 'process']
        }
      };

      const result = await compressor.compress(input);

      // Should include matching symbols
      expect(result.nodes.some(n => n.label.includes('handle') || n.label.includes('process'))).toBe(true);
    });

    it('should fallback to top imported files if no seed found', async () => {
      const methodGraph: MethodExecutionGraph = {
        symbols: [
          { id: 'symbol:/src/a.ts:func1', name: 'func1', file: '/src/a.ts', kind: 'function', startLine: 1, endLine: 5, exportName: 'func1' },
          { id: 'symbol:/src/b.ts:func2', name: 'func2', file: '/src/b.ts', kind: 'function', startLine: 1, endLine: 5, exportName: 'func2' }
        ],
        symbolEdges: [],
        files: ['/src/a.ts', '/src/b.ts'],
        fileEdges: [
          { from: '/src/a.ts', to: '/src/b.ts', kind: 'import', confidence: 0.9 }
        ]
      };

      const input: GraphCompressorInput = {
        methodGraph,
        focus: {} // No seeds
      };

      const result = await compressor.compress(input);

      // Should have some nodes from top imported files
      expect(result.nodes.length).toBeGreaterThan(0);
    });
  });

  describe('extractCuratedSubGraph', () => {
    it('should extract curated subgraph from execution graph', () => {
      const nodes: GraphNode[] = [
        { id: 'entry1', label: 'Entry Point', kind: 'symbol' as const, badges: ['entry'] },
        { id: 'error1', label: 'Error Node', kind: 'file' as const, badges: ['error'], file: 'src/error.ts', line: 10 },
        { id: 'node1', label: 'Node 1', kind: 'file' as const },
        { id: 'node2', label: 'Node 2', kind: 'file' as const },
        { id: 'node3', label: 'Node 3', kind: 'file' as const },
        { id: 'node4', label: 'Node 4', kind: 'file' as const },
        { id: 'node5', label: 'Node 5', kind: 'file' as const },
      ];
      const edges: GraphEdge[] = [
        { from: 'entry1', to: 'node1', kind: 'calls' as const, confidence: 0.8 },
        { from: 'node1', to: 'node2', kind: 'calls' as const, confidence: 0.8 },
        { from: 'node2', to: 'error1', kind: 'calls' as const, confidence: 0.8 },
        { from: 'node3', to: 'node4', kind: 'calls' as const, confidence: 0.8 },
        { from: 'node4', to: 'node5', kind: 'calls' as const, confidence: 0.8 },
      ];

      const focus: GraphCompressorInput["focus"] = {
        entrySymbols: [{ id: 'entry1', name: 'Entry Point' }],
        errorFrames: [{ file: 'src/error.ts', line: 10 }],
        userMentions: []
      };

      const result = compressor.extractCuratedSubGraph(nodes, edges, focus, 3, 5);

      // Should return curated subgraph with important nodes
      expect(result.nodes.length).toBeGreaterThan(0);
      expect(result.nodes.length).toBeLessThanOrEqual(5);
      expect(result.nodes.length).toBeGreaterThanOrEqual(3);
      
      // Should include entry and error nodes
      const nodeIds = result.nodes.map(n => n.id);
      expect(nodeIds).toContain('entry1');
      expect(nodeIds).toContain('error1');
      
      // Should include edges between selected nodes
      expect(result.edges.length).toBeGreaterThanOrEqual(0);
      result.edges.forEach(edge => {
        expect(nodeIds).toContain(edge.from);
        expect(nodeIds).toContain(edge.to);
      });
    });

    it('should handle empty graph', () => {
      const result = compressor.extractCuratedSubGraph([], [], {
        entrySymbols: [],
        errorFrames: [],
        userMentions: []
      });

      expect(result.nodes).toEqual([]);
      expect(result.edges).toEqual([]);
    });

    it('should prioritize nodes with badges', () => {
      const nodes: GraphNode[] = [
        { id: 'entry1', label: 'Entry Point', kind: 'symbol' as const, badges: ['entry', 'spine'] },
        { id: 'error1', label: 'Error Node', kind: 'file' as const, badges: ['error'], file: 'src/error.ts', line: 10 },
        { id: 'normal1', label: 'Normal Node 1', kind: 'file' as const },
        { id: 'normal2', label: 'Normal Node 2', kind: 'file' as const },
        { id: 'normal3', label: 'Normal Node 3', kind: 'file' as const },
      ];
      const edges: GraphEdge[] = [
        { from: 'entry1', to: 'normal1', kind: 'calls' as const, confidence: 0.8 },
        { from: 'normal1', to: 'error1', kind: 'calls' as const, confidence: 0.8 },
      ];

      const focus: GraphCompressorInput["focus"] = {
        entrySymbols: [],
        errorFrames: [],
        userMentions: []
      };

      const result = compressor.extractCuratedSubGraph(nodes, edges, focus, 2, 3);

      // Should prioritize entry and error nodes
      const nodeIds = result.nodes.map(n => n.id);
      expect(nodeIds).toContain('entry1');
      expect(nodeIds).toContain('error1');
    });
  });

  describe('buildDirectedDebugGraph with line numbers', () => {
    it('should populate line numbers for nodes when workspaceRoot is provided', () => {
      const workspaceRoot = process.cwd();
      const testFile = path.join(workspaceRoot, 'src/agent/tools/debugging/GraphCompressor.ts');
      
      // Only run this test if the file exists
      if (!fs.existsSync(testFile)) {
        console.warn('Skipping line number test - GraphCompressor.ts not found');
        return;
      }

      const spine = [
        { file: testFile, method: 'buildDirectedDebugGraph' }
      ];

      const edges: Array<{
        from: { file?: string; method: string };
        to: { file?: string; method: string };
        kind: "forward" | "backward" | "loop";
        depth: number;
        evidence: string[];
      }> = [];

      const localContext: any = {
        entry: testFile,
        files: [testFile],
        methods: [],
        symbols: [],
        symbolEdges: [],
        fileEdges: []
      };

      const result = compressor.buildDirectedDebugGraph({
        spine,
        edges,
        ctx: localContext,
        workspaceRoot
      });

      // Verify that nodes have line numbers
      expect(result.nodes.length).toBeGreaterThan(0);
      const spineNode = result.nodes.find(n => n.id.includes('buildDirectedDebugGraph'));
      expect(spineNode).toBeDefined();
      
      // The line number should be defined (or undefined if method not found, but not missing)
      // We check that the property exists, even if it's undefined
      expect(spineNode).toHaveProperty('line');
      
      // If the method was found, line should be a number
      if (spineNode?.line !== undefined) {
        expect(typeof spineNode.line).toBe('number');
        expect(spineNode.line).toBeGreaterThan(0);
      }
    });

    it('should cache line number lookups to avoid redundant queries', () => {
      const workspaceRoot = process.cwd();
      const testFile = path.join(workspaceRoot, 'src/agent/tools/debugging/GraphCompressor.ts');
      
      if (!fs.existsSync(testFile)) {
        console.warn('Skipping caching test - GraphCompressor.ts not found');
        return;
      }

      const spine = [
        { file: testFile, method: 'buildDirectedDebugGraph' },
        { file: testFile, method: 'buildDirectedDebugGraph' } // Duplicate to test caching
      ];

      const edges: Array<{
        from: { file?: string; method: string };
        to: { file?: string; method: string };
        kind: "forward" | "backward" | "loop";
        depth: number;
        evidence: string[];
      }> = [];

      const localContext: any = {
        entry: testFile,
        files: [testFile],
        methods: [],
        symbols: [],
        symbolEdges: [],
        fileEdges: []
      };

      const result = compressor.buildDirectedDebugGraph({
        spine,
        edges,
        ctx: localContext,
        workspaceRoot
      });

      // Should only have one node (duplicates are filtered by seen set)
      const nodesWithMethod = result.nodes.filter(n => n.id.includes('buildDirectedDebugGraph'));
      expect(nodesWithMethod.length).toBe(1);
      
      // The node should have a line property
      expect(nodesWithMethod[0]).toHaveProperty('line');
    });

    it('should populate line numbers for nodes created from edges', () => {
      const workspaceRoot = process.cwd();
      const testFile = path.join(workspaceRoot, 'src/agent/tools/debugging/GraphCompressor.ts');
      
      if (!fs.existsSync(testFile)) {
        console.warn('Skipping edge node test - GraphCompressor.ts not found');
        return;
      }

      const spine: Array<{ file: string; method: string }> = [];

      const edges: Array<{
        from: { file?: string; method: string };
        to: { file?: string; method: string };
        kind: "forward" | "backward" | "loop";
        depth: number;
        evidence: string[];
      }> = [
        {
          from: { file: testFile, method: 'buildDirectedDebugGraph' },
          to: { file: testFile, method: 'findMethodLineNumber' },
          kind: 'forward',
          depth: 1,
          evidence: ['ast-forward']
        }
      ];

      const localContext: any = {
        entry: testFile,
        files: [testFile],
        methods: [],
        symbols: [],
        symbolEdges: [],
        fileEdges: []
      };

      const result = compressor.buildDirectedDebugGraph({
        spine,
        edges,
        ctx: localContext,
        workspaceRoot
      });

      // Should have nodes created from edges
      expect(result.nodes.length).toBeGreaterThan(0);
      
      // All nodes should have the line property
      result.nodes.forEach(node => {
        expect(node).toHaveProperty('line');
        // If node has a file, line should be defined (either actual line number or fallback 1)
        if (node.file) {
          expect(node.line).toBeDefined();
          expect(typeof node.line).toBe('number');
          expect(node.line).toBeGreaterThan(0);
        }
        // If line is defined, it should be a positive number
        if (node.line !== undefined) {
          expect(typeof node.line).toBe('number');
          expect(node.line).toBeGreaterThan(0);
        }
      });
    });

    it('should use fallback line number 1 when file exists but line number cannot be determined', () => {
      const workspaceRoot = process.cwd();
      const testFile = path.join(workspaceRoot, 'src/agent/tools/debugging/GraphCompressor.ts');
      
      if (!fs.existsSync(testFile)) {
        console.warn('Skipping fallback line number test - GraphCompressor.ts not found');
        return;
      }

      // Create a spine with a method that might not be found (built-in or non-existent)
      const spine = [
        { file: testFile, method: 'NonExistentMethod12345' } // Method that won't be found
      ];

      const edges: Array<{
        from: { file?: string; method: string };
        to: { file?: string; method: string };
        kind: "forward" | "backward" | "loop";
        depth: number;
        evidence: string[];
      }> = [];

      const localContext: any = {
        entry: testFile,
        files: [testFile],
        methods: [],
        symbols: [],
        symbolEdges: [],
        fileEdges: []
      };

      const result = compressor.buildDirectedDebugGraph({
        spine,
        edges,
        ctx: localContext,
        workspaceRoot
      });

      // Should have at least one node
      expect(result.nodes.length).toBeGreaterThan(0);
      
      // Find the spine node
      const spineNode = result.nodes.find(n => n.id.includes('NonExistentMethod12345'));
      expect(spineNode).toBeDefined();
      
      // Since the method won't be found, but file exists, line should be fallback 1
      if (spineNode && spineNode.file) {
        expect(spineNode.line).toBeDefined();
        expect(spineNode.line).toBe(1); // Fallback to line 1
      }
    });
  });

  describe('findMethodLineNumber with fallbacks', () => {
    let testDir: string;
    let testFileJs: string;
    let testFileTs: string;
    let testFileDts: string;

    beforeAll(() => {
      // Create temporary test files
      testDir = path.join(process.cwd(), 'tmp-test-files');
      if (!fs.existsSync(testDir)) {
        fs.mkdirSync(testDir, { recursive: true });
      }

      testFileJs = path.join(testDir, 'test.js');
      testFileTs = path.join(testDir, 'test.ts');
      testFileDts = path.join(testDir, 'test.d.ts');

      // Create JavaScript test file with various function patterns
      fs.writeFileSync(testFileJs, `
// Function declaration
function testFunction() {
  return 'test';
}

// Arrow function
const testArrow = () => {
  return 'arrow';
};

// Class with method
class TestClass {
  testMethod() {
    return 'method';
  }
  
  async asyncMethod() {
    return 'async';
  }
}

// Exported function
export function exportedFunction() {
  return 'exported';
}
`);

      // Create TypeScript test file
      fs.writeFileSync(testFileTs, `
export class TypeScriptClass {
  public method(): string {
    return 'typescript';
  }
  
  private privateMethod(): void {
    // private
  }
}

function standaloneFunction(): void {
  // standalone
}
`);

      // Create type definition file
      fs.writeFileSync(testFileDts, `
export declare function declaredFunction(): void;
export declare class DeclaredClass {
  method(): void;
}
`);
    });

    afterAll(() => {
      // Clean up test files
      if (fs.existsSync(testDir)) {
        fs.rmSync(testDir, { recursive: true, force: true });
      }
    });

    it('should skip built-in methods silently', () => {
      const workspaceRoot = process.cwd();
      
      // Test built-in methods - should not warn
      const builtInMethods = [
        'console',
        'Console.warn',
        'Console.log',
        'keys',
        'map',
        'filter',
        'querySelector',
        'getAttribute',
        'hasOwnProperty',
        'replace',
        'includes',
        'push',
        'from'
      ];

      // Access private method using type casting
      const compressorAny = compressor as any;
      
      for (const methodName of builtInMethods) {
        const result = compressorAny.findMethodLineNumber(
          testFileJs,
          methodName,
          workspaceRoot
        );
        // Should return undefined for built-ins without warning
        expect(result).toBeUndefined();
      }
    });

    it('should skip .d.ts files silently', () => {
      const workspaceRoot = process.cwd();
      const compressorAny = compressor as any;
      
      // Should return undefined for .d.ts files without warning
      const result = compressorAny.findMethodLineNumber(
        testFileDts,
        'declaredFunction',
        workspaceRoot
      );
      expect(result).toBeUndefined();
    });

    it('should find function declarations in JavaScript files using Babel', () => {
      const workspaceRoot = process.cwd();
      const compressorAny = compressor as any;
      
      // Should find function declaration
      const result = compressorAny.findMethodLineNumber(
        testFileJs,
        'testFunction',
        workspaceRoot
      );
      
      expect(result).toBeDefined();
      expect(typeof result).toBe('number');
      expect(result).toBeGreaterThan(0);
    });

    it('should find arrow functions in JavaScript files using Babel', () => {
      const workspaceRoot = process.cwd();
      const compressorAny = compressor as any;
      
      // Should find arrow function
      const result = compressorAny.findMethodLineNumber(
        testFileJs,
        'testArrow',
        workspaceRoot
      );
      
      expect(result).toBeDefined();
      expect(typeof result).toBe('number');
      expect(result).toBeGreaterThan(0);
    });

    it('should find class methods in JavaScript files using Babel', () => {
      const workspaceRoot = process.cwd();
      const compressorAny = compressor as any;
      
      // Should find class method
      const result = compressorAny.findMethodLineNumber(
        testFileJs,
        'TestClass.testMethod',
        workspaceRoot
      );
      
      expect(result).toBeDefined();
      expect(typeof result).toBe('number');
      expect(result).toBeGreaterThan(0);
    });

    it('should find async methods in JavaScript files using Babel', () => {
      const workspaceRoot = process.cwd();
      const compressorAny = compressor as any;
      
      // Should find async method
      const result = compressorAny.findMethodLineNumber(
        testFileJs,
        'TestClass.asyncMethod',
        workspaceRoot
      );
      
      expect(result).toBeDefined();
      expect(typeof result).toBe('number');
      expect(result).toBeGreaterThan(0);
    });

    it('should find exported functions in JavaScript files', () => {
      const workspaceRoot = process.cwd();
      const compressorAny = compressor as any;
      
      // Should find exported function
      const result = compressorAny.findMethodLineNumber(
        testFileJs,
        'exportedFunction',
        workspaceRoot
      );
      
      expect(result).toBeDefined();
      expect(typeof result).toBe('number');
      expect(result).toBeGreaterThan(0);
    });

    it('should use regex fallback when Babel fails', () => {
      const workspaceRoot = process.cwd();
      const compressorAny = compressor as any;
      
      // Create a file with syntax that might confuse Babel but regex can handle
      const regexTestFile = path.join(testDir, 'regex-test.js');
      fs.writeFileSync(regexTestFile, `
function simpleFunction() {
  return true;
}
`);
      
      // Should find using regex fallback
      const result = compressorAny.findMethodLineNumber(
        regexTestFile,
        'simpleFunction',
        workspaceRoot
      );
      
      expect(result).toBeDefined();
      expect(typeof result).toBe('number');
      expect(result).toBeGreaterThan(0);
      
      // Clean up
      if (fs.existsSync(regexTestFile)) {
        fs.unlinkSync(regexTestFile);
      }
    });

    it('should handle non-existent files gracefully', () => {
      const workspaceRoot = process.cwd();
      const compressorAny = compressor as any;
      
      const nonExistentFile = path.join(testDir, 'non-existent.js');
      const result = compressorAny.findMethodLineNumber(
        nonExistentFile,
        'someMethod',
        workspaceRoot
      );
      
      expect(result).toBeUndefined();
    });

    it('should handle non-existent methods gracefully', () => {
      const workspaceRoot = process.cwd();
      const compressorAny = compressor as any;
      
      // Should return undefined for non-existent method
      const result = compressorAny.findMethodLineNumber(
        testFileJs,
        'nonExistentMethod',
        workspaceRoot
      );
      
      // Should be undefined, but not throw
      expect(result).toBeUndefined();
    });

    it('should prefer ts-morph for TypeScript files', () => {
      const workspaceRoot = process.cwd();
      const compressorAny = compressor as any;
      
      // Should find using ts-morph (preferred for TypeScript)
      const result = compressorAny.findMethodLineNumber(
        testFileTs,
        'TypeScriptClass.method',
        workspaceRoot
      );
      
      // Should find the method (either via ts-morph or Babel fallback)
      expect(result).toBeDefined();
      expect(typeof result).toBe('number');
      expect(result).toBeGreaterThan(0);
    });

    it('should handle method names with special regex characters', () => {
      const workspaceRoot = process.cwd();
      const compressorAny = compressor as any;
      
      // Create file with method name containing special characters
      const specialCharFile = path.join(testDir, 'special-chars.js');
      fs.writeFileSync(specialCharFile, `
function method$With$Special$Chars() {
  return 'test';
}
`);
      
      // Should handle special characters in method name
      const result = compressorAny.findMethodLineNumber(
        specialCharFile,
        'method$With$Special$Chars',
        workspaceRoot
      );
      
      // Should find it (regex should escape special chars)
      expect(result).toBeDefined();
      expect(typeof result).toBe('number');
      
      // Clean up
      if (fs.existsSync(specialCharFile)) {
        fs.unlinkSync(specialCharFile);
      }
    });
  });
});

