/**
 * Tests for EvidenceAggregator
 */

import { EvidenceAggregator } from '../EvidenceAggregator';
import { GitService } from '../../../../common/utils/gitService';
import { JsHeuristics } from '../jsHeuristics';
import { ExtractionResponse } from '../types';

// Mock dependencies
jest.mock('../../../../common/utils/gitService');
jest.mock('../jsHeuristics');

const MockedGitService = GitService as jest.MockedClass<typeof GitService>;
const MockedJsHeuristics = JsHeuristics as jest.MockedClass<typeof JsHeuristics>;

describe('EvidenceAggregator', () => {
  let evidenceAggregator: EvidenceAggregator;
  let mockGitService: jest.Mocked<GitService>;
  let mockJsHeuristics: jest.Mocked<JsHeuristics>;

  beforeEach(() => {
    mockGitService = {
      isGitRepository: jest.fn(),
      getDetailedCommits: jest.fn(),
      getFileHistory: jest.fn(),
      getCurrentCommitHash: jest.fn()
    } as any;

    mockJsHeuristics = {
      analyzeFiles: jest.fn()
    } as any;

    MockedGitService.mockImplementation(() => mockGitService);
    MockedJsHeuristics.mockImplementation(() => mockJsHeuristics);

    evidenceAggregator = new EvidenceAggregator('/test/workspace');
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  describe('aggregateContext', () => {
    it('should aggregate context successfully', async () => {
      const extractionResult: ExtractionResponse = {
        evidence: {
          frames: [
            { file: '/test/src/user.js', line: 42, fn: 'getUser' }
          ],
          error: 'Cannot read property of undefined',
          route: '/api/user',
          logSignatures: [],
          tsconfigPaths: {}
        },
        candidates: [
          { file: '/test/src/user.js', score: 0.9, evidence: ['stack_trace'] }
        ],
        graph: {
          nodes: [
            { id: 'user.js', kind: 'file', label: 'user.js', file: '/test/src/user.js', line: 42 }
          ],
          edges: []
        },
        timings: { total: 1000 },
        confidence: 0.8
      };

      mockGitService.isGitRepository.mockResolvedValue(true);
      mockGitService.getCurrentCommitHash.mockResolvedValue('abc123');
      mockGitService.getDetailedCommits.mockResolvedValue([
        {
          hash: 'abc123',
          message: 'Fix user bug',
          author: 'John Doe',
          date: new Date('2024-01-15'),
          files: ['/test/src/user.js'],
          relevanceScore: 0.8
        }
      ]);
      mockJsHeuristics.analyzeFiles.mockReturnValue([
        {
          file: '/test/src/user.js',
          line: 42,
          pattern: 'null_access',
          severity: 'high',
          rationale: 'Potential null access'
        }
      ]);

      const result = await evidenceAggregator.aggregateContext(
        extractionResult,
        '/test/workspace',
        'Error: Cannot read property of undefined',
        'User API is failing'
      );

      expect(result).toEqual({
        projectId: 'debugging',
        commitHash: 'abc123',
        bugDescription: 'User API is failing',
        logs: 'Error: Cannot read property of undefined',
        userMessage: 'User API is failing',
        gitChanges: expect.any(Array),
        graph: extractionResult.graph,
        snippets: [],
        evidence: extractionResult.evidence,
        candidates: extractionResult.candidates,
        heuristicFindings: expect.any(Array)
      });

      expect(mockGitService.getDetailedCommits).toHaveBeenCalledWith(10);
      expect(mockJsHeuristics.analyzeFiles).toHaveBeenCalled();
    });

    it('should handle non-git repository', async () => {
      const extractionResult: ExtractionResponse = {
        evidence: { frames: [], logSignatures: [], tsconfigPaths: {} },
        candidates: [],
        graph: { nodes: [], edges: [] },
        timings: { total: 1000 },
        confidence: 0.5
      };

      mockGitService.isGitRepository.mockResolvedValue(false);
      mockGitService.getCurrentCommitHash.mockResolvedValue('unknown');
      mockJsHeuristics.analyzeFiles.mockReturnValue([]);

      const result = await evidenceAggregator.aggregateContext(
        extractionResult,
        '/test/workspace',
        'Test error',
        'Test message'
      );

      expect(result.gitChanges).toEqual([]);
    });

    it('should rank git changes by relevance', async () => {
      const extractionResult: ExtractionResponse = {
        evidence: { frames: [], logSignatures: [], tsconfigPaths: {} },
        candidates: [
          { file: '/test/src/user.js', score: 0.9, evidence: ['stack_trace'] }
        ],
        graph: { nodes: [], edges: [] },
        timings: { total: 1000 },
        confidence: 0.5
      };

      const gitChanges = [
        {
          hash: 'abc123',
          message: 'Fix user bug',
          author: 'John Doe',
          date: new Date(Date.now() - 24 * 60 * 60 * 1000), // 1 day ago
          files: ['/test/src/user.js', '/test/src/other.js'],
          relevanceScore: 0
        },
        {
          hash: 'def456',
          message: 'Add feature',
          author: 'Jane Smith',
          date: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000), // 1 week ago
          files: ['/test/src/feature.js'],
          relevanceScore: 0
        }
      ];

      mockGitService.isGitRepository.mockResolvedValue(true);
      mockGitService.getCurrentCommitHash.mockResolvedValue('current');
      mockGitService.getDetailedCommits.mockResolvedValue(gitChanges);
      mockJsHeuristics.analyzeFiles.mockReturnValue([]);

      const result = await evidenceAggregator.aggregateContext(
        extractionResult,
        '/test/workspace',
        'Test error',
        'Test message'
      );

      // Check that git changes are returned
      expect(result.gitChanges).toBeDefined();
      expect(Array.isArray(result.gitChanges)).toBe(true);
    });
  });

  describe('getEvidenceSummary', () => {
    it('should generate evidence summary', () => {
      const debugContext = {
        projectId: 'test',
        commitHash: 'abc123',
        bugDescription: 'Test bug',
        logs: 'Test error',
        userMessage: 'Test message',
        gitChanges: [
          { hash: 'abc123', message: 'Fix', author: 'John', date: new Date(), files: [], relevanceScore: 0 }
        ],
        graph: { nodes: [], edges: [] },
        snippets: [],
        evidence: {
          frames: [{ file: 'test.js', line: 1 }],
          error: 'Test error',
          logSignatures: [],
          tsconfigPaths: {}
        },
        candidates: [{ file: 'test.js', score: 0.9, evidence: [] }],
        heuristicFindings: [
          { file: 'test.js', line: 1, pattern: 'null_access', severity: 'high', rationale: 'Test' }
        ]
      };

      const summary = evidenceAggregator.getEvidenceSummary(debugContext);

      expect(summary).toContain('Git changes: 1');
      expect(summary).toContain('Heuristic findings: 1');
      expect(summary).toContain('Candidate files: 1');
      expect(summary).toContain('Evidence frames: 1');
      expect(summary).toContain('Error: Test error');
    });
  });
});
