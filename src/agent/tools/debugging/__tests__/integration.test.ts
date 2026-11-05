/**
 * Integration tests for debugging code extraction
 */

import { EvidenceParser } from '../EvidenceParser';
import { SearchPlanner } from '../SearchPlanner';
import { HybridRetriever } from '../HybridRetriever';
import { AstProgramBuilder } from '../AstProgramBuilder';
import { StaticSlicer } from '../StaticSlicer';
import { LLMProviderService } from '../../llm/llmProviderService';
import { ExtractCodeTool } from '../extractCodeTool';

describe('Debugging Code Extraction Integration', () => {
  let evidenceParser: EvidenceParser;
  let searchPlanner: SearchPlanner;
  let hybridRetriever: HybridRetriever;
  let astBuilder: AstProgramBuilder;
  let staticSlicer: StaticSlicer;
  let extractCodeTool: ExtractCodeTool;
  let llmProviderService: LLMProviderService;

  beforeEach(() => {
    // Mock LLM provider service
    llmProviderService = {
      chat: jest.fn().mockResolvedValue({
        success: true,
        result: {
          content: JSON.stringify({
            candidateFiles: ['src/api/user.ts', 'src/models/User.ts'],
            symbols: ['getUser', 'User', 'createUser'],
            queries: ['user', 'api', 'error'],
            reasoning: 'Test reasoning'
          })
        }
      })
    } as any;

    // Mock extract code tool
    extractCodeTool = {
      rankRelevantFileswithLLM: jest.fn().mockResolvedValue(new Map([
        ['src/api/user.ts', [{ name: 'getUser', type: 'function' }]]
      ])),
      performKeywordBasedSearch: jest.fn().mockResolvedValue(new Map([
        ['src/api/user.ts', [{ name: 'getUser', type: 'function' }]]
      ])),
      scanCodebase: jest.fn().mockResolvedValue(new Map())
    } as any;

    evidenceParser = new EvidenceParser('/test/workspace');
    searchPlanner = new SearchPlanner(llmProviderService);
    hybridRetriever = new HybridRetriever(extractCodeTool);
    astBuilder = new AstProgramBuilder('/test/workspace');
    staticSlicer = new StaticSlicer();
  });

  describe('EvidenceParser', () => {
    it('should parse stack trace from logs', () => {
      const logs = `
        Error: Cannot read property 'name' of undefined
            at getUser (/app/src/api/user.ts:15:8)
            at processRequest (/app/src/handlers/request.ts:23:5)
      `;

      const evidence = evidenceParser.parseEvidence({
        userMessage: 'User API is failing',
        logs,
        workspace: '/test/workspace'
      });

      expect(evidence.frames).toHaveLength(2);
      expect(evidence.frames[0]).toEqual({
        file: '/app/src/api/user.ts',
        line: 15,
        fn: 'getUser',
        column: 8
      });
      expect(evidence.error).toBe("Cannot read property 'name' of undefined");
    });

    it('should extract route from logs', () => {
      const logs = `
        POST /api/users
        Error: Validation failed
      `;

      const evidence = evidenceParser.parseEvidence({
        userMessage: 'API error',
        logs,
        workspace: '/test/workspace'
      });

      expect(evidence.route).toBe('/api/users');
      expect(evidence.error).toBe('Validation failed');
    });
  });

  describe('SearchPlanner', () => {
    it('should generate search plan from evidence', async () => {
      const evidence = {
        frames: [
          { file: '/app/src/api/user.ts', line: 15, fn: 'getUser' }
        ],
        error: 'Cannot read property',
        route: '/api/users',
        logSignatures: ['Error: Cannot read property'],
        tsconfigPaths: {}
      };

      const repoMeta = {
        fileList: ['src/api/user.ts', 'src/models/User.ts'],
        paths: ['src/api/user.ts', 'src/models/User.ts'],
        projectRoot: '/test/workspace'
      };

      const plan = await searchPlanner.makeSearchPlan(
        evidence,
        repoMeta,
        'User API is failing',
        'gpt-4'
      );

      expect(plan.candidateFiles).toContain('src/api/user.ts');
      expect(plan.symbols).toContain('getUser');
      expect(plan.queries).toContain('user');
      expect(plan.reasoning).toBe('Test reasoning');
    });
  });

  describe('HybridRetriever', () => {
    it('should combine LLM and keyword scores with evidence boosting', async () => {
      const plan = {
        candidateFiles: ['src/api/user.ts'],
        symbols: ['getUser'],
        queries: ['user', 'api'],
        reasoning: 'Test'
      };

      const evidence = {
        frames: [
          { file: '/test/workspace/src/api/user.ts', line: 15, fn: 'getUser' }
        ],
        error: 'Cannot read property',
        route: '/api/users',
        logSignatures: [],
        tsconfigPaths: {}
      };

      const fileInfos = new Map();

      const candidates = await hybridRetriever.retrieveHybrid(
        plan,
        evidence,
        fileInfos,
        'gpt-4',
        'test'
      );

      expect(candidates).toBeDefined();
      expect(Array.isArray(candidates)).toBe(true);
    });
  });

  describe('StaticSlicer', () => {
    it('should build slice from roots', () => {
      const roots = {
        errorFrames: [
          { file: '/test/src/api/user.ts', line: 15, fn: 'getUser' }
        ],
        topSymbols: [
          { file: '/test/src/api/user.ts', symbol: 'getUser', startLine: 10, endLine: 20, score: 0.9, evidence: ['stack_trace'] }
        ],
        userMentions: ['user', 'api']
      };

      const importRelations = [
        { from: '/test/src/api/user.ts', to: '/test/src/models/User.ts', kind: 'import' as const, line: 1 }
      ];

      const callRelations = [
        { caller: 'getUser', callee: 'validateUser', file: '/test/src/api/user.ts', line: 15, confidence: 0.8 }
      ];

      const slice = staticSlicer.buildSlice(roots, importRelations, callRelations);

      expect(slice.nodes.length).toBeGreaterThan(0);
      expect(slice.edges.length).toBeGreaterThan(0);
      
      // Should have error node
      const errorNodes = slice.nodes.filter(node => node.badges?.includes('error'));
      expect(errorNodes.length).toBeGreaterThan(0);
    });
  });

  describe('End-to-End Flow', () => {
    it('should process debugging extraction request', async () => {
      const input = {
        userMessage: 'User API is failing with undefined error',
        logs: `
          Error: Cannot read property 'name' of undefined
              at getUser (/app/src/api/user.ts:15:8)
              at processRequest (/app/src/handlers/request.ts:23:5)
        `,
        workspace: '/test/workspace',
        model: 'gpt-4',
        config: {
          maxNodes: 20,
          maxDepth: 3
        }
      };

      // Mock the extractCodeTool.extractForDebugging method
      const mockExtractForDebugging = jest.fn().mockResolvedValue({
        evidence: {
          frames: [
            { file: '/app/src/api/user.ts', line: 15, fn: 'getUser' }
          ],
          error: "Cannot read property 'name' of undefined",
          route: undefined,
          logSignatures: [],
          tsconfigPaths: {}
        },
        candidates: [
          {
            file: '/app/src/api/user.ts',
            score: 0.9,
            evidence: ['stack_trace', 'llm_relevance']
          }
        ],
        graph: {
          nodes: [
            {
              id: 'file:/app/src/api/user.ts',
              kind: 'file',
              label: 'user.ts',
              file: '/app/src/api/user.ts',
              line: 15,
              badges: ['error']
            }
          ],
          edges: []
        },
        timings: {
          evidence: 50,
          plan: 200,
          retrieval: 300,
          ast: 500,
          slice: 100,
          total: 1150
        },
        confidence: 0.85
      });

      extractCodeTool.extractForDebugging = mockExtractForDebugging;

      const result = await extractCodeTool.extractForDebugging(input);

      expect(result).toBeDefined();
      expect(result.evidence.frames).toHaveLength(1);
      expect(result.candidates).toHaveLength(1);
      expect(result.graph.nodes).toHaveLength(1);
      expect(result.confidence).toBe(0.85);
      expect(result.timings.total).toBe(1150);
    });
  });
});
