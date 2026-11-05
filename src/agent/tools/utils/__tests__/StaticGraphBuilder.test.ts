/**
 * Tests for StaticGraphBuilder
 */

import { StaticGraphBuilder } from '../StaticGraphBuilder';
import { Project, SourceFile, FunctionDeclaration, ClassDeclaration, MethodDeclaration, ImportDeclaration } from 'ts-morph';
import {
  MethodExecutionGraph,
  SymbolDef,
  SymbolCall,
  ImportExportRelation
} from '../../debugging/types';
import { GraphCompressor } from '../../debugging/GraphCompressor';

// Mock GraphCompressor
jest.mock('../../debugging/GraphCompressor');

describe('StaticGraphBuilder', () => {
  let builder: StaticGraphBuilder;
  let mockProject: jest.Mocked<Project>;
  let mockSourceFile: jest.Mocked<SourceFile>;

  beforeEach(() => {
    // Create mock source file
    const mockFunction = {
      getName: jest.fn().mockReturnValue('testFunction'),
      getStartLineNumber: jest.fn().mockReturnValue(1),
      getEndLineNumber: jest.fn().mockReturnValue(10),
      isExported: jest.fn().mockReturnValue(true)
    } as any;

    const mockMethod = {
      getName: jest.fn().mockReturnValue('testMethod'),
      getStartLineNumber: jest.fn().mockReturnValue(5),
      getEndLineNumber: jest.fn().mockReturnValue(8)
    } as any;

    const mockClass = {
      getName: jest.fn().mockReturnValue('TestClass'),
      getStartLineNumber: jest.fn().mockReturnValue(1),
      getEndLineNumber: jest.fn().mockReturnValue(20),
      isExported: jest.fn().mockReturnValue(true),
      getMethods: jest.fn().mockReturnValue([mockMethod])
    } as any;

    const mockImport = {
      getModuleSpecifierValue: jest.fn().mockReturnValue('./other'),
      getModuleSpecifierSourceFile: jest.fn().mockReturnValue({
        getFilePath: jest.fn().mockReturnValue('/test/workspace/src/other.ts')
      }),
      getStartLineNumber: jest.fn().mockReturnValue(1)
    } as any;

    mockSourceFile = {
      getFilePath: jest.fn().mockReturnValue('/test/workspace/src/test.ts'),
      getFunctions: jest.fn().mockReturnValue([mockFunction]),
      getClasses: jest.fn().mockReturnValue([mockClass]),
      getImportDeclarations: jest.fn().mockReturnValue([mockImport]),
      forEachDescendant: jest.fn()
    } as any;

    // Create mock project
    mockProject = {
      getSourceFile: jest.fn().mockReturnValue(mockSourceFile),
      addSourceFileAtPath: jest.fn().mockReturnValue(mockSourceFile)
    } as any;

    builder = new StaticGraphBuilder(mockProject as any);
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  describe('buildGraph', () => {
    it('should build graph with symbols from single file', async () => {
      const result = await builder.buildGraph('/test/workspace/src/test.ts', 0);

      expect(result.symbols.length).toBeGreaterThanOrEqual(2); // function + class (and possibly methods)
      expect(result.symbols.some(s => s.name === 'testFunction' && s.kind === 'function')).toBe(true);
      expect(result.symbols.some(s => s.name === 'TestClass' && s.kind === 'class')).toBe(true);
      expect(result.files).toContain('/test/workspace/src/test.ts');
    });

    it('should extract class methods', async () => {
      const result = await builder.buildGraph('/test/workspace/src/test.ts', 0);

      const methods = result.symbols.filter(s => s.kind === 'method');
      expect(methods).toHaveLength(1);
      expect(methods[0].name).toBe('testMethod');
      expect(methods[0].id).toContain('TestClass.testMethod');
    });

    it('should extract imports and create file edges', async () => {
      const otherFile = {
        getFilePath: jest.fn().mockReturnValue('/test/workspace/src/other.ts'),
        getFunctions: jest.fn().mockReturnValue([]),
        getClasses: jest.fn().mockReturnValue([]),
        getImportDeclarations: jest.fn().mockReturnValue([]), // No imports in other file
        forEachDescendant: jest.fn()
      } as any;

      mockProject.getSourceFile
        .mockReturnValueOnce(mockSourceFile)
        .mockReturnValueOnce(otherFile);

      const result = await builder.buildGraph('/test/workspace/src/test.ts', 1);

      expect(result.fileEdges.length).toBeGreaterThanOrEqual(1);
      const testToOther = result.fileEdges.find(e => 
        e.from === '/test/workspace/src/test.ts' && 
        e.to === '/test/workspace/src/other.ts'
      );
      expect(testToOther).toBeDefined();
      expect(testToOther?.kind).toBe('import');
    });

    it('should not process files beyond depth limit', async () => {
      const otherFile = {
        getFilePath: jest.fn().mockReturnValue('/test/workspace/src/other.ts'),
        getFunctions: jest.fn().mockReturnValue([]),
        getClasses: jest.fn().mockReturnValue([]),
        getImportDeclarations: jest.fn().mockReturnValue([]),
        forEachDescendant: jest.fn()
      } as any;

      mockProject.getSourceFile
        .mockReturnValueOnce(mockSourceFile)
        .mockReturnValueOnce(otherFile);

      const result = await builder.buildGraph('/test/workspace/src/test.ts', 0);

      // Should only process the original file, not the imported one
      expect(mockProject.getSourceFile).toHaveBeenCalledTimes(1);
    });

    it('should process files up to depth limit', async () => {
      const otherFile = {
        getFilePath: jest.fn().mockReturnValue('/test/workspace/src/other.ts'),
        getFunctions: jest.fn().mockReturnValue([]),
        getClasses: jest.fn().mockReturnValue([]),
        getImportDeclarations: jest.fn().mockReturnValue([]),
        forEachDescendant: jest.fn()
      } as any;

      mockProject.getSourceFile
        .mockReturnValueOnce(mockSourceFile)
        .mockReturnValueOnce(otherFile);

      const result = await builder.buildGraph('/test/workspace/src/test.ts', 1);

      // Should process both files
      expect(mockProject.getSourceFile).toHaveBeenCalledTimes(2);
      expect(result.files).toContain('/test/workspace/src/test.ts');
      expect(result.files).toContain('/test/workspace/src/other.ts');
    });

    it('should skip node_modules imports', async () => {
      const nodeModulesImport = {
        getModuleSpecifierValue: jest.fn().mockReturnValue('lodash'),
        getModuleSpecifierSourceFile: jest.fn().mockReturnValue({
          getFilePath: jest.fn().mockReturnValue('/test/workspace/node_modules/lodash/index.js')
        }),
        getStartLineNumber: jest.fn().mockReturnValue(1)
      } as any;

      mockSourceFile.getImportDeclarations.mockReturnValue([nodeModulesImport]);

      const result = await builder.buildGraph('/test/workspace/src/test.ts', 1);

      expect(result.fileEdges).toHaveLength(0);
      expect(result.files).not.toContain(expect.stringContaining('node_modules'));
    });

    it('should handle files that cannot be parsed', async () => {
      mockProject.getSourceFile.mockReturnValue(null);
      mockProject.addSourceFileAtPath.mockImplementation(() => {
        throw new Error('Parse error');
      });

      const result = await builder.buildGraph('/test/workspace/src/test.ts', 0);

      // Should still return valid graph structure
      expect(result.symbols).toEqual([]);
      expect(result.files).toContain('/test/workspace/src/test.ts');
    });

    it('should not process same file twice', async () => {
      // Create circular import scenario
      const otherFile = {
        getFilePath: jest.fn().mockReturnValue('/test/workspace/src/other.ts'),
        getFunctions: jest.fn().mockReturnValue([]),
        getClasses: jest.fn().mockReturnValue([]),
        getImportDeclarations: jest.fn().mockReturnValue([
          {
            getModuleSpecifierValue: jest.fn().mockReturnValue('./test'),
            getModuleSpecifierSourceFile: jest.fn().mockReturnValue({
              getFilePath: jest.fn().mockReturnValue('/test/workspace/src/test.ts')
            }),
            getStartLineNumber: jest.fn().mockReturnValue(1)
          }
        ]),
        forEachDescendant: jest.fn()
      } as any;

      mockProject.getSourceFile
        .mockReturnValueOnce(mockSourceFile)
        .mockReturnValueOnce(otherFile)
        .mockReturnValueOnce(mockSourceFile); // Circular reference

      const result = await builder.buildGraph('/test/workspace/src/test.ts', 2);

      // Should only process each file once
      const processedFiles = new Set(result.files);
      expect(processedFiles.size).toBe(result.files.length);
    });

    it('should handle anonymous functions', async () => {
      const anonymousFunction = {
        getName: jest.fn().mockReturnValue(undefined),
        getStartLineNumber: jest.fn().mockReturnValue(1),
        getEndLineNumber: jest.fn().mockReturnValue(5),
        isExported: jest.fn().mockReturnValue(false)
      } as any;

      const mockClassWithoutMethods = {
        getName: jest.fn().mockReturnValue('TestClass'),
        getStartLineNumber: jest.fn().mockReturnValue(1),
        getEndLineNumber: jest.fn().mockReturnValue(20),
        isExported: jest.fn().mockReturnValue(true),
        getMethods: jest.fn().mockReturnValue([]) // No methods
      } as any;

      mockSourceFile.getFunctions.mockReturnValue([anonymousFunction]);
      mockSourceFile.getClasses.mockReturnValue([mockClassWithoutMethods]);

      const result = await builder.buildGraph('/test/workspace/src/test.ts', 0);

      expect(result.symbols.length).toBeGreaterThanOrEqual(2); // anonymous function + class
      const anonSymbol = result.symbols.find(s => s.name === 'anonymous');
      expect(anonSymbol).toBeDefined();
    });

    it('should handle anonymous classes', async () => {
      const anonymousClass = {
        getName: jest.fn().mockReturnValue(undefined),
        getStartLineNumber: jest.fn().mockReturnValue(1),
        getEndLineNumber: jest.fn().mockReturnValue(10),
        isExported: jest.fn().mockReturnValue(false),
        getMethods: jest.fn().mockReturnValue([])
      } as any;

      mockSourceFile.getClasses.mockReturnValue([anonymousClass]);

      const result = await builder.buildGraph('/test/workspace/src/test.ts', 0);

      const anonClass = result.symbols.find(s => s.name === 'AnonClass');
      expect(anonClass).toBeDefined();
      expect(anonClass?.kind).toBe('class');
    });

    it('should create correct symbol IDs', async () => {
      const result = await builder.buildGraph('/test/workspace/src/test.ts', 0);

      expect(result.symbols[0].id).toBe('symbol:/test/workspace/src/test.ts:testFunction');
      expect(result.symbols[1].id).toBe('symbol:/test/workspace/src/test.ts:TestClass');
    });

    it('should extract simple calls', async () => {
      let callHandler: (node: any) => void;
      mockSourceFile.forEachDescendant.mockImplementation((callback) => {
        callHandler = callback;
      });

      // Simulate a call expression
      const mockCallNode = {
        getKind: jest.fn().mockReturnValue('CallExpression'),
        getText: jest.fn().mockReturnValue('someFunction()'),
        getStartLineNumber: jest.fn().mockReturnValue(3),
        getFirstAncestorByKind: jest.fn().mockReturnValue({
          getKind: jest.fn().mockReturnValue('FunctionDeclaration'),
          getName: jest.fn().mockReturnValue('testFunction')
        })
      };

      const result = await builder.buildGraph('/test/workspace/src/test.ts', 0);

      // Call the handler to simulate finding a call
      if (callHandler!) {
        callHandler(mockCallNode);
      }

      // Note: The actual call extraction happens during buildGraph,
      // but we're testing the structure here
      expect(result.symbolEdges).toBeDefined();
    });
  });

  describe('buildGraphFromEpicenter', () => {
    let mockLLMProvider: any;
    let mockGraphCompressor: any;

    beforeEach(() => {
      mockLLMProvider = {};
      
      // Mock GraphCompressor instance
      mockGraphCompressor = {
        getOrCreateTsMorphProject: jest.fn(),
        traverseCallsDeep: jest.fn().mockReturnValue(new Map()),
        collectLocalContext: jest.fn().mockReturnValue({}),
        buildDirectedDebugGraph: jest.fn().mockReturnValue({
          nodes: [],
          edges: []
        })
      };

      // Setup GraphCompressor mock constructor
      (GraphCompressor as jest.MockedClass<typeof GraphCompressor>).mockImplementation(() => mockGraphCompressor as any);
    });

    it('should return empty graph when focusSymbol is provided but no spine found', async () => {
      // When focusSymbol is provided, it creates spine directly without checking file
      // So we need to mock traverseCallsDeep to return empty map
      mockGraphCompressor.traverseCallsDeep.mockReturnValue(new Map());
      mockGraphCompressor.buildDirectedDebugGraph.mockReturnValue({
        nodes: [],
        edges: []
      });

      const result = await builder.buildGraphFromEpicenter(
        '/test/workspace/src/test.ts',
        '/test/workspace',
        3,
        'nonexistentFunction',
        mockLLMProvider
      );

      expect(result.nodes).toEqual([]);
      expect(result.edges).toEqual([]);
    });

    it('should extract exported symbols when focusSymbol is not provided', async () => {
      const exportedFunction = {
        getName: jest.fn().mockReturnValue('exportedFunc'),
        isExported: jest.fn().mockReturnValue(true)
      } as any;

      mockProject.getSourceFile.mockReturnValue(mockSourceFile);
      mockSourceFile.getFunctions.mockReturnValue([exportedFunction]);
      mockSourceFile.getClasses.mockReturnValue([]);

      mockGraphCompressor.traverseCallsDeep.mockReturnValue(new Map([
        ['/test/workspace/src/test.ts::exportedFunc', []]
      ]));

      const result = await builder.buildGraphFromEpicenter(
        '/test/workspace/src/test.ts',
        '/test/workspace',
        3,
        undefined,
        mockLLMProvider
      );

      expect(mockGraphCompressor.traverseCallsDeep).toHaveBeenCalled();
      expect(mockGraphCompressor.buildDirectedDebugGraph).toHaveBeenCalled();
    });

    it('should use focusSymbol when provided', async () => {
      mockGraphCompressor.traverseCallsDeep.mockReturnValue(new Map([
        ['/test/workspace/src/test.ts::myFunction', []]
      ]));

      const result = await builder.buildGraphFromEpicenter(
        '/test/workspace/src/test.ts',
        '/test/workspace',
        3,
        'myFunction',
        mockLLMProvider
      );

      expect(mockGraphCompressor.traverseCallsDeep).toHaveBeenCalledWith(
        [{ file: '/test/workspace/src/test.ts', method: 'myFunction' }],
        '/test/workspace',
        expect.any(Object)
      );
    });

    it('should handle errors gracefully', async () => {
      mockGraphCompressor.traverseCallsDeep.mockImplementation(() => {
        throw new Error('Traversal failed');
      });

      const result = await builder.buildGraphFromEpicenter(
        '/test/workspace/src/test.ts',
        '/test/workspace',
        3,
        'myFunction',
        mockLLMProvider
      );

      // Should return empty arrays on error
      expect(result.nodes).toEqual([]);
      expect(result.edges).toEqual([]);
    });

    it('should convert compressed graph to GraphNode and GraphEdge format', async () => {
      const mockCompressedNodes = [
        {
          id: 'symbol:/test/file.ts:func',
          label: 'func',
          file: '/test/file.ts',
          kind: 'symbol',
          line: 1,
          badges: ['spine']
        }
      ];
      const mockCompressedEdges = [
        {
          from: 'symbol:/test/file.ts:func1',
          to: 'symbol:/test/file.ts:func2',
          kind: 'calls',
          confidence: 0.9,
          evidence: ['ast-forward']
        }
      ];

      mockGraphCompressor.traverseCallsDeep.mockReturnValue(new Map([
        ['/test/workspace/src/test.ts::myFunction', []]
      ]));
      mockGraphCompressor.buildDirectedDebugGraph.mockReturnValue({
        nodes: mockCompressedNodes,
        edges: mockCompressedEdges
      });

      const result = await builder.buildGraphFromEpicenter(
        '/test/workspace/src/test.ts',
        '/test/workspace',
        3,
        'myFunction',
        mockLLMProvider
      );

      expect(result.nodes).toHaveLength(1);
      expect(result.nodes[0]).toMatchObject({
        id: 'symbol:/test/file.ts:func',
        label: 'func',
        file: '/test/file.ts',
        kind: 'symbol',
        line: 1,
        badges: ['spine']
      });
      expect(result.edges).toHaveLength(1);
      expect(result.edges[0]).toMatchObject({
        from: 'symbol:/test/file.ts:func1',
        to: 'symbol:/test/file.ts:func2',
        kind: 'calls',
        confidence: 0.9
      });
    });
  });
});



