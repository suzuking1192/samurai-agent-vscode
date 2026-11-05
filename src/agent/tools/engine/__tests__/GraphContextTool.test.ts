/**
 * Tests for GraphContextTool
 */

// Mock dependencies BEFORE importing the module under test
jest.mock('vscode', () => ({
  workspace: {
    workspaceFolders: [
      {
        uri: {
          fsPath: '/test/workspace'
        }
      }
    ]
  }
}));

jest.mock('fs', () => ({
  existsSync: jest.fn(),
  statSync: jest.fn()
}));

jest.mock('typescript', () => ({
  ScriptTarget: {
    ES2020: 2
  },
  ModuleKind: {
    ESNext: 99
  },
  ModuleResolutionKind: {
    NodeNext: 100
  },
  JsxEmit: {
    ReactJSX: 4
  }
}));

jest.mock('ts-morph', () => ({
  Project: jest.fn().mockImplementation(() => ({
    getSourceFile: jest.fn(),
    addSourceFileAtPath: jest.fn()
  }))
}));

jest.mock('../../utils/StaticGraphBuilder');
jest.mock('../../debugging/VisualizationService');

// Now import after mocks are set up
import { GraphContextTool } from '../GraphContextTool';
import { StaticGraphBuilder } from '../../utils/StaticGraphBuilder';
import { VisualizationService } from '../../debugging/VisualizationService';
import { LLMProviderService } from '../../../llm/llmProviderService';
import * as vscode from 'vscode';
import * as fs from 'fs';
import { GraphNode, GraphEdge } from '../../debugging/types';

const MockStaticGraphBuilder = StaticGraphBuilder as jest.MockedClass<typeof StaticGraphBuilder>;
const MockVisualizationService = VisualizationService as jest.MockedClass<typeof VisualizationService>;

describe('GraphContextTool', () => {
  let graphContextTool: GraphContextTool;
  let mockLLMProvider: jest.Mocked<LLMProviderService>;
  let mockBuilder: jest.Mocked<StaticGraphBuilder>;
  let mockVizService: jest.Mocked<VisualizationService>;

  const mockGraphNodes: GraphNode[] = [
    {
      id: 'symbol:/test/workspace/src/test.ts:testFunction',
      label: 'testFunction',
      file: '/test/workspace/src/test.ts',
      kind: 'symbol',
      line: 1,
      badges: ['spine'],
      analysis: '',
      importance: 0
    }
  ];

  const mockGraphEdges: GraphEdge[] = [];

  const mockNormalizedNodes: GraphNode[] = [
    {
      id: 'symbol__test_workspace_src_test_ts_testFunction', // Normalized ID (special chars replaced)
      label: 'testFunction',
      file: '/test/workspace/src/test.ts',
      kind: 'symbol',
      line: 1,
      badges: ['spine'],
      analysis: '',
      importance: 0
    }
  ];

  const mockVizResult = {
    mermaid: 'graph TD\n    A[testFunction]',
    isValid: true,
    meta: {
      nodeCount: 1,
      edgeCount: 0
    },
    diagnostics: [],
    sourceGraphVersion: '1.0.0',
    nodeLocationMap: {
      'symbol__test_workspace_src_test_ts_testFunction': {
        filePath: '/test/workspace/src/test.ts',
        line: 1
      }
    },
    nodeInfoMap: {},
    normalizedNodes: mockNormalizedNodes
  };

  beforeEach(() => {
    // Setup LLM Provider mock
    mockLLMProvider = {
      chat: jest.fn()
    } as any;

    // Setup StaticGraphBuilder mock - now uses buildGraphFromEpicenter
    mockBuilder = {
      buildGraphFromEpicenter: jest.fn().mockResolvedValue({
        nodes: mockGraphNodes,
        edges: mockGraphEdges
      })
    } as any;
    MockStaticGraphBuilder.mockImplementation(() => mockBuilder as any);

    // Setup VisualizationService mock
    mockVizService = {
      generateVisualization: jest.fn().mockResolvedValue(mockVizResult)
    } as any;
    MockVisualizationService.mockImplementation(() => mockVizService as any);

    // Setup fs mocks
    (fs.existsSync as jest.Mock).mockReturnValue(true);
    (fs.statSync as jest.Mock).mockReturnValue({ isFile: () => true });

    // Create tool instance
    graphContextTool = new GraphContextTool(mockLLMProvider);
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  describe('execute', () => {
    it('should return error when no workspace folder is open', async () => {
      const originalMock = (vscode.workspace as any).workspaceFolders;
      (vscode.workspace as any).workspaceFolders = undefined;

      const result = await graphContextTool.execute({
        filePath: 'src/test.ts'
      });

      expect(result.success).toBe(false);
      expect(result.summary).toBe('No workspace open.');

      // Restore original mock
      (vscode.workspace as any).workspaceFolders = originalMock;
    });

    it('should return error when file does not exist', async () => {
      (fs.existsSync as jest.Mock).mockReturnValue(false);

      const result = await graphContextTool.execute({
        filePath: 'src/nonexistent.ts'
      });

      expect(result.success).toBe(false);
      expect(result.summary).toBe('File not found: src/nonexistent.ts');
    });

    it('should return error when no graph nodes generated', async () => {
      mockBuilder.buildGraphFromEpicenter.mockResolvedValue({
        nodes: [],
        edges: []
      });

      const result = await graphContextTool.execute({
        filePath: 'src/test.ts'
      });

      expect(result.success).toBe(false);
      expect(result.summary).toContain('No graph nodes generated');
    });

    it('should successfully build and compress graph with visualization', async () => {
      const result = await graphContextTool.execute({
        filePath: 'src/test.ts'
      });

      expect(result.success).toBe(true);
      expect(result.summary).toContain('Graph generated around test.ts');
      expect(result.summary).toContain('1 nodes');
      expect(result.summary).toContain('Visualization updated');
      
      // Check structuredData contains mermaid and graph data
      expect(result.structuredData).toBeDefined();
      expect(result.structuredData?.mermaid).toBe(mockVizResult.mermaid);
      expect(result.structuredData?.nodes).toHaveLength(1);
      expect(result.structuredData?.edges).toHaveLength(0);
      expect(result.structuredData?.isValid).toBe(true);
      // Check that normalizedNodes are used (with IDs matching Mermaid diagram)
      expect(result.structuredData?.nodes).toEqual(mockNormalizedNodes);
      // Check that nodeLocationMap is included
      expect(result.structuredData?.nodeLocationMap).toBeDefined();
      expect(result.structuredData?.nodeLocationMap).toEqual(mockVizResult.nodeLocationMap);
      
      // Check evidence contains agent graph JSON
      expect(result.evidence).toBeDefined();
      expect(result.evidence).toHaveLength(1);
      expect(result.evidence?.[0].file).toBe('graph-analysis.json');
      const agentGraph = JSON.parse(result.evidence?.[0].text || '{}');
      expect(agentGraph.nodes).toHaveLength(1);
      expect(agentGraph.nodes[0]).toHaveProperty('id');
      expect(agentGraph.nodes[0]).toHaveProperty('file');
      expect(agentGraph.edges).toHaveLength(0);
    });

    it('should use default depth of 1 when not specified', async () => {
      await graphContextTool.execute({
        filePath: 'src/test.ts'
      });

      expect(mockBuilder.buildGraphFromEpicenter).toHaveBeenCalledWith(
        expect.stringContaining('src/test.ts'),
        '/test/workspace',
        1, // default depth (from params.depth || 1)
        undefined, // no focusSymbol
        mockLLMProvider
      );
    });

    it('should use custom depth when specified', async () => {
      await graphContextTool.execute({
        filePath: 'src/test.ts',
        depth: 2
      });

      expect(mockBuilder.buildGraphFromEpicenter).toHaveBeenCalledWith(
        expect.stringContaining('src/test.ts'),
        '/test/workspace',
        2,
        undefined,
        mockLLMProvider
      );
    });

    it('should pass focus symbol to buildGraphFromEpicenter when provided', async () => {
      await graphContextTool.execute({
        filePath: 'src/test.ts',
        focusSymbol: 'myFunction',
        depth: 4
      });

      expect(mockBuilder.buildGraphFromEpicenter).toHaveBeenCalledWith(
        expect.stringContaining('src/test.ts'),
        '/test/workspace',
        4,
        'myFunction', // focusSymbol passed directly
        mockLLMProvider
      );
    });

    // Note: Symbol extraction logic is now handled inside buildGraphFromEpicenter
    // These tests verify that focusSymbol is passed correctly

    it('should return structured data with mermaid, nodes, edges, and isValid', async () => {
      const result = await graphContextTool.execute({
        filePath: 'src/test.ts'
      });

      // structuredData should use normalizedNodes from vizResult (with IDs matching Mermaid diagram)
      expect(result.structuredData).toBeDefined();
      expect(result.structuredData?.mermaid).toBe(mockVizResult.mermaid);
      expect(result.structuredData?.isValid).toBe(mockVizResult.isValid);
      
      // Verify nodes are normalized nodes from vizResult (not original executionGraph)
      expect(result.structuredData?.nodes).toBeDefined();
      expect(Array.isArray(result.structuredData?.nodes)).toBe(true);
      expect(result.structuredData?.nodes).toHaveLength(1);
      // Should use normalized nodes with normalized IDs matching Mermaid diagram
      expect(result.structuredData?.nodes).toEqual(mockNormalizedNodes);
      expect(result.structuredData?.nodes[0]).toMatchObject({
        id: 'symbol__test_workspace_src_test_ts_testFunction', // Normalized ID
        kind: 'symbol',
        label: 'testFunction',
        file: '/test/workspace/src/test.ts',
        line: 1,
        badges: ['spine']
      });
      
      // Verify edges are from executionGraph
      expect(result.structuredData?.edges).toBeDefined();
      expect(Array.isArray(result.structuredData?.edges)).toBe(true);
      expect(result.structuredData?.edges).toHaveLength(0);
      
      // Verify that nodeLocationMap is included with normalized IDs
      expect(result.structuredData?.nodeLocationMap).toBeDefined();
      expect(result.structuredData?.nodeLocationMap).toEqual(mockVizResult.nodeLocationMap);
    });

    it('should call VisualizationService with correct parameters', async () => {
      await graphContextTool.execute({
        filePath: 'src/test.ts',
        visualizationMode: 'behavior-first'
      });

      expect(mockVizService.generateVisualization).toHaveBeenCalledWith(
        expect.objectContaining({
          nodes: expect.arrayContaining([
            expect.objectContaining({
              id: 'symbol:/test/workspace/src/test.ts:testFunction',
              kind: 'symbol',
              label: 'testFunction'
            })
          ]),
          edges: []
        }),
        undefined, // No RootCauseReport
        'behavior-first',
        'auto',
        '/test/workspace'
      );
    });

    it('should use default visualizationMode when not specified', async () => {
      await graphContextTool.execute({
        filePath: 'src/test.ts'
      });

      expect(mockVizService.generateVisualization).toHaveBeenCalledWith(
        expect.any(Object),
        undefined,
        'hard-error', // Default mode
        'auto',
        '/test/workspace'
      );
    });

    it('should pass graph nodes and edges directly to visualization', async () => {
      const customNodes: GraphNode[] = [
        {
          id: 'symbol1',
          label: 'Symbol1',
          kind: 'symbol',
          file: '/test/file.ts',
          line: 1,
          badges: [],
          analysis: '',
          importance: 0
        },
        {
          id: 'symbol2',
          label: 'Symbol2',
          kind: 'symbol',
          file: '/test/file.ts',
          line: 2,
          badges: [],
          analysis: '',
          importance: 0
        }
      ];
      const customEdges: GraphEdge[] = [
        {
          from: 'symbol1',
          to: 'symbol2',
          kind: 'calls',
          confidence: 0.9,
          evidence: []
        }
      ];

      mockBuilder.buildGraphFromEpicenter.mockResolvedValue({
        nodes: customNodes,
        edges: customEdges
      });

      await graphContextTool.execute({
        filePath: 'src/test.ts'
      });

      const callArgs = mockVizService.generateVisualization.mock.calls[0];
      const executionGraph = callArgs[0];
      expect(executionGraph.nodes).toHaveLength(2);
      expect(executionGraph.nodes).toEqual(customNodes);
      expect(executionGraph.edges).toHaveLength(1);
      expect(executionGraph.edges).toEqual(customEdges);
    });

    it('should include agent graph in evidence with correct structure', async () => {
      const result = await graphContextTool.execute({
        filePath: 'src/test.ts'
      });

      expect(result.evidence).toBeDefined();
      expect(result.evidence?.[0].file).toBe('graph-analysis.json');
      
      const agentGraph = JSON.parse(result.evidence?.[0].text || '{}');
      expect(agentGraph).toHaveProperty('nodes');
      expect(agentGraph).toHaveProperty('edges');
      expect(agentGraph.nodes[0]).toHaveProperty('id');
      expect(agentGraph.nodes[0]).toHaveProperty('file');
      // Badges may be undefined if not present in executionGraph
      if (agentGraph.nodes[0].badges !== undefined) {
        expect(agentGraph.nodes[0]).toHaveProperty('badges');
      }
      // Edges should only have from/to, not kind or other properties
      if (agentGraph.edges && agentGraph.edges.length > 0) {
        expect(agentGraph.edges[0]).not.toHaveProperty('kind');
        expect(agentGraph.edges[0]).toHaveProperty('from');
        expect(agentGraph.edges[0]).toHaveProperty('to');
      }
      
      // Verify agentGraph uses executionGraph nodes (filtered, no group nodes)
      // by checking it matches the executionGraph passed to VisualizationService
      const vizCallArgs = mockVizService.generateVisualization.mock.calls[0];
      const executionGraph = vizCallArgs[0];
      expect(agentGraph.nodes).toHaveLength(executionGraph.nodes.length);
      expect(agentGraph.nodes.map((n: any) => n.id)).toEqual(
        executionGraph.nodes.map((n: any) => n.id)
      );
      expect(agentGraph.edges).toHaveLength(executionGraph.edges.length);
    });

    it('should handle buildGraphFromEpicenter errors gracefully', async () => {
      const error = new Error('Graph building failed');
      mockBuilder.buildGraphFromEpicenter.mockRejectedValue(error);

      const result = await graphContextTool.execute({
        filePath: 'src/test.ts'
      });

      expect(result.success).toBe(false);
      expect(result.summary).toContain('Graph generation failed');
      expect(result.summary).toContain('Graph building failed');
    });

    it('should handle visualization service errors gracefully', async () => {
      const error = new Error('Visualization failed');
      mockVizService.generateVisualization.mockRejectedValue(error);

      const result = await graphContextTool.execute({
        filePath: 'src/test.ts'
      });

      expect(result.success).toBe(false);
      expect(result.summary).toContain('Graph generation failed');
      expect(result.summary).toContain('Visualization failed');
    });

    it('should resolve absolute paths correctly', async () => {
      await graphContextTool.execute({
        filePath: '/test/workspace/src/test.ts'
      });

      expect(mockBuilder.buildGraphFromEpicenter).toHaveBeenCalledWith(
        '/test/workspace/src/test.ts',
        '/test/workspace',
        expect.any(Number),
        undefined,
        mockLLMProvider
      );
    });

    it('should resolve relative paths from workspace root', async () => {
      await graphContextTool.execute({
        filePath: 'src/test.ts'
      });

      expect(mockBuilder.buildGraphFromEpicenter).toHaveBeenCalledWith(
        expect.stringContaining('/test/workspace/src/test.ts'),
        '/test/workspace',
        expect.any(Number),
        undefined,
        mockLLMProvider
      );
    });

    it('should fallback to executionGraph.nodes when normalizedNodes is not provided', async () => {
      // Mock vizResult without normalizedNodes
      const vizResultWithoutNormalized = {
        ...mockVizResult,
        normalizedNodes: undefined
      };
      mockVizService.generateVisualization.mockResolvedValueOnce(vizResultWithoutNormalized);

      const result = await graphContextTool.execute({
        filePath: 'src/test.ts'
      });

      // Should fallback to executionGraph.nodes when normalizedNodes is undefined
      expect(result.structuredData?.nodes).toBeDefined();
      expect(result.structuredData?.nodes).toHaveLength(1);
      // Should use original nodes from executionGraph
      expect(result.structuredData?.nodes[0].id).toBe('symbol:/test/workspace/src/test.ts:testFunction');
    });

    it('should include nodeLocationMap in structuredData when available', async () => {
      const result = await graphContextTool.execute({
        filePath: 'src/test.ts'
      });

      // Should include nodeLocationMap from vizResult
      expect(result.structuredData?.nodeLocationMap).toBeDefined();
      expect(result.structuredData?.nodeLocationMap).toEqual(mockVizResult.nodeLocationMap);
    });
  });
});
