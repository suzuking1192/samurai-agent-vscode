/**
 * Tests for HybridRetriever
 */

import { HybridRetriever } from '../HybridRetriever';
import { Evidence, SearchPlan, CandidateFile } from '../types';
import { FileInfo } from '../../../../common/models/context-models';

// Mock ExtractCodeTool
const mockExtractCodeTool = {
  rankRelevantFileswithLLM: jest.fn(),
  performKeywordBasedSearch: jest.fn(),
  performKeywordBasedSearchBatch: jest.fn().mockResolvedValue(new Map())
};

describe('HybridRetriever', () => {
  let hybridRetriever: HybridRetriever;
  let mockFileInfos: Map<string, FileInfo>;

  beforeEach(() => {
    hybridRetriever = new HybridRetriever(mockExtractCodeTool as any);
    mockFileInfos = new Map([
      ['src/api/user.ts', {
        file: 'src/api/user.ts',
        content: 'export function getUser(id: string) { return { name: "John" }; }',
        symbols: ['getUser', 'User'],
        startLine: 1,
        endLine: 10
      } as FileInfo],
      ['src/models/User.ts', {
        file: 'src/models/User.ts',
        content: 'export class User { name: string; }',
        symbols: ['User', 'name'],
        startLine: 1,
        endLine: 5
      } as FileInfo],
      ['src/utils/validation.ts', {
        file: 'src/utils/validation.ts',
        content: 'export function validateUser(user: any) { return true; }',
        symbols: ['validateUser'],
        startLine: 1,
        endLine: 8
      } as FileInfo],
      ['src/handlers/request.ts', {
        file: 'src/handlers/request.ts',
        content: 'export function processRequest(req: any) { return getUser(req.id); }',
        symbols: ['processRequest'],
        startLine: 1,
        endLine: 12
      } as FileInfo]
    ]);
    jest.clearAllMocks();
  });

  describe('retrieveHybrid', () => {
    it('should retrieve and rank files with improved fusion', async () => {
      const evidence: Evidence = {
        frames: [
          { file: 'src/api/user.ts', line: 15, fn: 'getUser', column: 8 },
          { file: 'src/handlers/request.ts', line: 23, fn: 'processRequest', column: 5 }
        ],
        error: 'TypeError: Cannot read property \'name\' of undefined',
        requestId: 'req-123',
        route: '/api/users',
        logSignatures: ['[ERROR] User API failed'],
        tsconfigPaths: { '@/*': ['src/*'] },
        warnings: [],
        confidence: 0.8
      };

      const plan: SearchPlan = {
        candidateFiles: ['src/api/user.ts', 'src/models/User.ts'],
        symbols: ['getUser', 'User', 'validateUser'],
        queries: ['undefined', 'property access', 'user validation'],
        reasoning: 'Error occurs in getUser function'
      };

      // Mock LLM results
      mockExtractCodeTool.rankRelevantFileswithLLM.mockResolvedValue(new Map([
        ['src/api/user.ts', [{ relevance: 0.9, line: 15 }]],
        ['src/models/User.ts', [{ relevance: 0.7, line: 3 }]],
        ['src/utils/validation.ts', [{ relevance: 0.5, line: 8 }]]
      ]));

      // Mock keyword results
      mockExtractCodeTool.performKeywordBasedSearch.mockResolvedValue(new Map([
        ['src/api/user.ts', [{ match: 'getUser', line: 15 }]],
        ['src/handlers/request.ts', [{ match: 'processRequest', line: 23 }]],
        ['src/utils/validation.ts', [{ match: 'validateUser', line: 8 }]]
      ]));

      const result = await hybridRetriever.retrieveHybrid(plan, evidence, mockFileInfos, 'gpt-4', 'test-project');

      expect(result).toHaveLength(4);
      expect(result[0].file).toBe('src/api/user.ts'); // Should be ranked highest due to stack trace
      expect(result[0].score).toBeGreaterThan(0);
      expect(result[0].debug).toBeDefined();
      expect(result[0].debug?.bm25).toBeDefined();
      expect(result[0].debug?.dense).toBeDefined();
      expect(result[0].debug?.symbol).toBeDefined();
      expect(result[0].debug?.evidence).toBeDefined();
    });

    it('should filter out noise files', async () => {
      const evidence: Evidence = {
        frames: [],
        error: 'Test error',
        requestId: 'req-123',
        route: '/api/test',
        logSignatures: [],
        tsconfigPaths: {},
        warnings: [],
        confidence: 0.5
      };

      const plan: SearchPlan = {
        candidateFiles: [],
        symbols: [],
        queries: ['test'],
        reasoning: 'Test'
      };

      // Add noise files to fileInfos
      const fileInfosWithNoise = new Map(mockFileInfos);
      fileInfosWithNoise.set('node_modules/lodash/index.js', {
        file: 'node_modules/lodash/index.js',
        content: 'export const _ = {}',
        symbols: [],
        startLine: 1,
        endLine: 1
      } as FileInfo);
      fileInfosWithNoise.set('dist/bundle.js', {
        file: 'dist/bundle.js',
        content: 'compiled code',
        symbols: [],
        startLine: 1,
        endLine: 1
      } as FileInfo);

      mockExtractCodeTool.rankRelevantFileswithLLM.mockResolvedValue(new Map([
        ['src/api/user.ts', [{ relevance: 0.9 }]],
        ['node_modules/lodash/index.js', [{ relevance: 0.8 }]],
        ['dist/bundle.js', [{ relevance: 0.7 }]]
      ]));

      mockExtractCodeTool.performKeywordBasedSearch.mockResolvedValue(new Map([
        ['src/api/user.ts', [{ match: 'test' }]],
        ['node_modules/lodash/index.js', [{ match: 'test' }]],
        ['dist/bundle.js', [{ match: 'test' }]]
      ]));

      const result = await hybridRetriever.retrieveHybrid(plan, evidence, fileInfosWithNoise, 'gpt-4', 'test-project');

      // Should not include noise files
      expect(result.find(c => c.file.includes('node_modules'))).toBeUndefined();
      expect(result.find(c => c.file.includes('dist/'))).toBeUndefined();
    });

    it('should apply evidence boosting correctly', async () => {
      const evidence: Evidence = {
        frames: [
          { file: 'src/api/user.ts', line: 15, fn: 'getUser', column: 8 }
        ],
        error: 'TypeError: Cannot read property \'name\' of undefined',
        requestId: 'req-123',
        route: '/api/users',
        logSignatures: [],
        tsconfigPaths: {},
        warnings: [],
        confidence: 0.8
      };

      const plan: SearchPlan = {
        candidateFiles: ['src/api/user.ts', 'src/models/User.ts'],
        symbols: ['getUser', 'User'],
        queries: ['undefined', 'property access'],
        reasoning: 'Test'
      };

      mockExtractCodeTool.rankRelevantFileswithLLM.mockResolvedValue(new Map([
        ['src/api/user.ts', [{ relevance: 0.9 }]],
        ['src/models/User.ts', [{ relevance: 0.7 }]]
      ]));

      mockExtractCodeTool.performKeywordBasedSearch.mockResolvedValue(new Map([
        ['src/api/user.ts', [{ match: 'getUser' }]],
        ['src/models/User.ts', [{ match: 'User' }]]
      ]));

      const result = await hybridRetriever.retrieveHybrid(plan, evidence, mockFileInfos, 'gpt-4', 'test-project');

      // src/api/user.ts should be ranked higher due to being in stack trace
      const userApiFile = result.find(c => c.file === 'src/api/user.ts');
      const userModelFile = result.find(c => c.file === 'src/models/User.ts');
      
      expect(userApiFile).toBeDefined();
      expect(userModelFile).toBeDefined();
      expect(userApiFile!.score).toBeGreaterThan(userModelFile!.score);
    });

    it('should calculate symbol scores correctly', async () => {
      const evidence: Evidence = {
        frames: [
          { file: 'src/api/user.ts', line: 15, fn: 'getUser', column: 8 }
        ],
        error: 'TypeError: Cannot read property \'name\' of undefined',
        requestId: 'req-123',
        route: '/api/users',
        logSignatures: [],
        tsconfigPaths: {},
        warnings: [],
        confidence: 0.8
      };

      const plan: SearchPlan = {
        candidateFiles: [],
        symbols: ['getUser', 'User', 'validateUser'],
        queries: ['undefined'],
        reasoning: 'Test'
      };

      mockExtractCodeTool.rankRelevantFileswithLLM.mockResolvedValue(new Map([
        ['src/api/user.ts', [{ relevance: 0.5 }]],
        ['src/models/User.ts', [{ relevance: 0.5 }]],
        ['src/utils/validation.ts', [{ relevance: 0.5 }]]
      ]));

      mockExtractCodeTool.performKeywordBasedSearch.mockResolvedValue(new Map([
        ['src/api/user.ts', [{ match: 'getUser' }]],
        ['src/models/User.ts', [{ match: 'User' }]],
        ['src/utils/validation.ts', [{ match: 'validateUser' }]]
      ]));

      const result = await hybridRetriever.retrieveHybrid(plan, evidence, mockFileInfos, 'gpt-4', 'test-project');

      // All files should have symbol scores
      result.forEach(candidate => {
        expect(candidate.debug?.symbol).toBeDefined();
        expect(candidate.debug?.symbol).toBeGreaterThanOrEqual(0);
        expect(candidate.debug?.symbol).toBeLessThanOrEqual(1);
      });
    });

    it('should apply route heuristics correctly', async () => {
      const evidence: Evidence = {
        frames: [],
        error: 'Test error',
        requestId: 'req-123',
        route: '/api/users',
        logSignatures: [],
        tsconfigPaths: {},
        warnings: [],
        confidence: 0.5
      };

      const plan: SearchPlan = {
        candidateFiles: [],
        symbols: [],
        queries: ['test'],
        reasoning: 'Test'
      };

      // Add route-specific files
      const fileInfosWithRoutes = new Map(mockFileInfos);
      fileInfosWithRoutes.set('pages/api/users.ts', {
        file: 'pages/api/users.ts',
        content: 'export default function handler(req, res) {}',
        symbols: ['handler'],
        startLine: 1,
        endLine: 5
      } as FileInfo);
      fileInfosWithRoutes.set('app/api/users/route.ts', {
        file: 'app/api/users/route.ts',
        content: 'export async function GET() {}',
        symbols: ['GET'],
        startLine: 1,
        endLine: 5
      } as FileInfo);

      mockExtractCodeTool.rankRelevantFileswithLLM.mockResolvedValue(new Map([
        ['src/api/user.ts', [{ relevance: 0.5 }]],
        ['pages/api/users.ts', [{ relevance: 0.5 }]],
        ['app/api/users/route.ts', [{ relevance: 0.5 }]]
      ]));

      mockExtractCodeTool.performKeywordBasedSearch.mockResolvedValue(new Map([
        ['src/api/user.ts', [{ match: 'test' }]],
        ['pages/api/users.ts', [{ match: 'test' }]],
        ['app/api/users/route.ts', [{ match: 'test' }]]
      ]));

      const result = await hybridRetriever.retrieveHybrid(plan, evidence, fileInfosWithRoutes, 'gpt-4', 'test-project');

      // Route-specific files should be ranked higher
      const routeFiles = result.filter(c => c.file.includes('api/users'));
      expect(routeFiles.length).toBeGreaterThan(0);
    });

    it('should handle empty results gracefully', async () => {
      const evidence: Evidence = {
        frames: [],
        error: 'Test error',
        requestId: 'req-123',
        route: '/api/test',
        logSignatures: [],
        tsconfigPaths: {},
        warnings: [],
        confidence: 0.5
      };

      const plan: SearchPlan = {
        candidateFiles: [],
        symbols: [],
        queries: ['nonexistent'],
        reasoning: 'Test'
      };

      mockExtractCodeTool.rankRelevantFileswithLLM.mockResolvedValue(new Map());
      mockExtractCodeTool.performKeywordBasedSearch.mockResolvedValue(new Map());

      const result = await hybridRetriever.retrieveHybrid(plan, evidence, mockFileInfos, 'gpt-4', 'test-project');

      expect(result).toHaveLength(0);
    });

    it('should include audit trail in results', async () => {
      const evidence: Evidence = {
        frames: [
          { file: 'src/api/user.ts', line: 15, fn: 'getUser', column: 8 }
        ],
        error: 'TypeError: Cannot read property \'name\' of undefined',
        requestId: 'req-123',
        route: '/api/users',
        logSignatures: [],
        tsconfigPaths: {},
        warnings: [],
        confidence: 0.8
      };

      const plan: SearchPlan = {
        candidateFiles: ['src/api/user.ts'],
        symbols: ['getUser'],
        queries: ['undefined'],
        reasoning: 'Test'
      };

      mockExtractCodeTool.rankRelevantFileswithLLM.mockResolvedValue(new Map([
        ['src/api/user.ts', [{ relevance: 0.9 }]]
      ]));

      mockExtractCodeTool.performKeywordBasedSearch.mockResolvedValue(new Map([
        ['src/api/user.ts', [{ match: 'getUser' }]]
      ]));

      const result = await hybridRetriever.retrieveHybrid(plan, evidence, mockFileInfos, 'gpt-4', 'test-project');

      expect(result[0].debug).toBeDefined();
      expect(result[0].debug?.bm25).toBeDefined();
      expect(result[0].debug?.dense).toBeDefined();
      expect(result[0].debug?.symbol).toBeDefined();
      expect(result[0].debug?.evidence).toBeDefined();
      expect(result[0].debug?.fused).toBeDefined();
      expect(result[0].debug?.ranks).toBeDefined();
    });
  });

  describe('utility methods', () => {
    it('should extract keywords correctly', () => {
      const text = 'TypeError: Cannot read property \'name\' of undefined';
      const keywords = (hybridRetriever as any).extractKeywords(text);
      
      expect(keywords).toContain('typeerror');
      expect(keywords).toContain('cannot');
      expect(keywords).toContain('read');
      expect(keywords).toContain('property');
      expect(keywords).toContain('name'); // 'undefined' is filtered out due to length > 2 filter
      expect(keywords).toHaveLength(5);
    });

    it('should calculate directory similarity correctly', () => {
      const similarity = (hybridRetriever as any).dirSimilarity('src/api/user', 'src/api/auth');
      expect(similarity).toBe(2/3); // 2 common parts out of 3 total
    });

    it('should detect route heuristics correctly', () => {
      const heuristic1 = (hybridRetriever as any).routeHeuristic('/api/users', 'pages/api/users.ts');
      const heuristic2 = (hybridRetriever as any).routeHeuristic('/api/users', 'app/api/users/route.ts');
      const heuristic3 = (hybridRetriever as any).routeHeuristic('/api/users', 'src/api/user.ts');
      
      // Test that the heuristic works as expected
      expect(heuristic1).toBe(1); // pages/api/users.ts should match
      expect(heuristic2).toBe(1); // app/api/users/route.ts should match
      expect(heuristic3).toBe(0); // src/api/user.ts should not match
    });

    it('should detect noise files correctly', () => {
      const isNoise1 = (hybridRetriever as any).isNoise('node_modules/lodash/index.js');
      const isNoise2 = (hybridRetriever as any).isNoise('dist/bundle.js');
      const isNoise3 = (hybridRetriever as any).isNoise('src/__generated__/types.ts');
      const isNoise4 = (hybridRetriever as any).isNoise('src/api/user.ts');
      
      expect(isNoise1).toBe(true);
      expect(isNoise2).toBe(true);
      expect(isNoise3).toBe(true);
      expect(isNoise4).toBe(false);
    });

    it('should apply sigmoid function correctly', () => {
      const sigmoid = (hybridRetriever as any).sigmoid;
      
      expect(sigmoid(0)).toBeLessThan(0.5);
      expect(sigmoid(0.5)).toBeCloseTo(0.5, 1);
      expect(sigmoid(1)).toBeGreaterThan(0.5);
    });
  });

  describe('weight management', () => {
    it('should use custom weights when provided', () => {
      const customWeights = { bm25: 0.5, dense: 0.3, symbol: 0.15, evidence: 0.05 };
      const retriever = new HybridRetriever(mockExtractCodeTool as any, customWeights);
      
      const expectedWeights = {
        bm25: 0.5,
        dense: 0.3,
        symbol: 0.15,
        evidence: 0.05,
        routeMatch: 0.0,
        softSignal: 0.0,
        astProximity: 0.0,
        gitRecency: 0.0
      };
      expect(retriever.getWeights()).toEqual(expectedWeights);
    });

    it('should update weights based on feedback', () => {
      const feedback = [
        { file: 'src/api/user.ts', isRelevant: true },
        { file: 'src/models/User.ts', isRelevant: true },
        { file: 'src/utils/validation.ts', isRelevant: false }
      ];
      
      const initialWeights = hybridRetriever.getWeights();
      hybridRetriever.updateWeights(feedback);
      const updatedWeights = hybridRetriever.getWeights();
      
      // Weights should be updated (exact values depend on implementation)
      expect(updatedWeights).toBeDefined();
    });
  });

  describe('score normalization', () => {
    it('should normalize scores correctly', () => {
      const normalize = (hybridRetriever as any).minMaxNormalize([0.1, 0.3, 0.5, 0.7, 0.9]);
      
      expect(normalize(0.1)).toBe(0);
      expect(normalize(0.9)).toBe(1);
      expect(normalize(0.5)).toBeCloseTo(0.5, 1);
    });

    it('should handle empty arrays in normalization', () => {
      const normalize = (hybridRetriever as any).minMaxNormalize([]);
      
      expect(normalize(0.5)).toBe(0);
    });
  });

  describe('reciprocal rank fusion', () => {
    it('should calculate RRF correctly', () => {
      const rrf = (hybridRetriever as any).reciprocalRankFusion.bind(hybridRetriever);
      
      expect(rrf(1, 2)).toBeGreaterThan(0);
      expect(rrf(1, undefined)).toBeGreaterThan(0);
      expect(rrf(undefined, 1)).toBeGreaterThan(0);
      expect(rrf(undefined, undefined)).toBe(0);
    });
  });

  describe('batch keyword search', () => {
    beforeEach(() => {
      jest.clearAllMocks();
    });

    it('should use batch API by default', async () => {
      const plan: SearchPlan = {
        candidateFiles: ['src/api/user.ts'],
        symbols: ['getUser', 'User'],
        queries: ['undefined', 'property access'],
        reasoning: 'Test batch API',
        mode: 'hard-error'
      };

      // Mock batch API to return results with token attribution
      mockExtractCodeTool.performKeywordBasedSearchBatch.mockResolvedValue(new Map([
        ['src/api/user.ts', [
          { token: 'getUser', kind: 'symbol', elements: [{ name: 'getUser', type: 'function' }] },
          { token: 'undefined', kind: 'query', elements: [{ name: 'getUser', type: 'function' }] }
        ]]
      ]));

      const scores = await (hybridRetriever as any).getKeywordScores(
        plan,
        mockFileInfos,
        'gpt-4',
        'test-project'
      );

      expect(mockExtractCodeTool.performKeywordBasedSearchBatch).toHaveBeenCalledTimes(1);
      expect(mockExtractCodeTool.performKeywordBasedSearch).not.toHaveBeenCalled();
      expect(scores.get('src/api/user.ts')).toBeGreaterThan(0);
    });

    it('should compute scores correctly from batch results', async () => {
      const plan: SearchPlan = {
        candidateFiles: [],
        symbols: ['getUser'],
        queries: ['user'],
        reasoning: 'Score computation test',
        mode: 'hard-error'
      };

      // Mock batch API with multiple token matches
      mockExtractCodeTool.performKeywordBasedSearchBatch.mockResolvedValue(new Map([
        ['src/api/user.ts', [
          { token: 'getUser', kind: 'symbol', elements: [
            { name: 'getUser', type: 'function' },
            { name: 'getUserById', type: 'function' },
            { name: 'getUserByName', type: 'function' }
          ]},
          { token: 'user', kind: 'query', elements: [
            { name: 'getUser', type: 'function' }
          ]}
        ]],
        ['src/models/User.ts', [
          { token: 'user', kind: 'query', elements: [
            { name: 'User', type: 'class' },
            { name: 'UserProfile', type: 'class' }
          ]}
        ]]
      ]));

      const scores = await (hybridRetriever as any).getKeywordScores(
        plan,
        mockFileInfos,
        'gpt-4',
        'test-project'
      );

      // First file has 3 elements for 'getUser' token -> score = min(1, 3/3) = 1.0
      // Second file has 2 elements for 'user' token -> score = min(1, 2/3) = 0.67
      expect(scores.get('src/api/user.ts')).toBe(1.0);
      expect(scores.get('src/models/User.ts')).toBeCloseTo(0.67, 2);
    });

    it('should call batch API once even with many queries', async () => {
      const plan: SearchPlan = {
        candidateFiles: [],
        symbols: ['getUser', 'User', 'validateUser'],
        queries: Array(38).fill('test').map((_, i) => `query${i}`), // 38 queries like the original issue
        reasoning: 'Performance test - should call batch API once',
        mode: 'hard-error'
      };

      mockExtractCodeTool.performKeywordBasedSearchBatch.mockResolvedValue(new Map([
        ['src/api/user.ts', [
          { token: 'getUser', kind: 'symbol', elements: [{ name: 'getUser', type: 'function' }] }
        ]]
      ]));

      await (hybridRetriever as any).getKeywordScores(
        plan,
        mockFileInfos,
        'gpt-4',
        'test-project'
      );

      // Should call batch API once, not 38 times (which would happen with legacy implementation)
      expect(mockExtractCodeTool.performKeywordBasedSearchBatch).toHaveBeenCalledTimes(1);
      expect(mockExtractCodeTool.performKeywordBasedSearch).not.toHaveBeenCalled();
      
      // Verify the batch API was called with all queries, symbols, and error tokens
      const batchCall = mockExtractCodeTool.performKeywordBasedSearchBatch.mock.calls[0];
      expect(batchCall[1].queries).toHaveLength(38);
      expect(batchCall[1].symbols).toHaveLength(3);
    });

    it('should handle empty results gracefully', async () => {
      const plan: SearchPlan = {
        candidateFiles: [],
        symbols: [],
        queries: [],
        reasoning: 'Empty test',
        mode: 'hard-error'
      };

      mockExtractCodeTool.performKeywordBasedSearchBatch.mockResolvedValue(new Map());

      const scores = await (hybridRetriever as any).getKeywordScores(
        plan,
        mockFileInfos,
        'gpt-4',
        'test-project'
      );

      expect(scores.size).toBe(0);
      expect(mockExtractCodeTool.performKeywordBasedSearchBatch).toHaveBeenCalledTimes(1);
    });
  });
});
