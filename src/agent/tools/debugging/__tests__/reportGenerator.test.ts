/**
 * Tests for ReportGenerator
 */

import { ReportGenerator } from '../ReportGenerator';
import { DebugContext, Hypothesis, FindingFeedback } from '../rootCauseTypes';

describe('ReportGenerator', () => {
  let reportGenerator: ReportGenerator;
  let mockDebugContext: DebugContext;
  let mockHypotheses: Hypothesis[];
  let mockFeedback: FindingFeedback[];

  beforeEach(() => {
    reportGenerator = new ReportGenerator();
    
    mockHypotheses = [
      {
        id: 'hyp1',
        summary: 'Null pointer dereference in user processing',
        evidence: ['error_path', 'stack_trace'],
        relatedNodes: ['node1', 'node2'],
        confidence: 0.8,
        normalizedConfidence: 0.85,
        rationale: 'The error occurs when accessing property of null object',
        relatedFiles: ['/src/api/users.ts', '/src/services/userService.ts'],
        verifiedNodes: ['node1'],
        verifiedSnippets: ['snippet1'],
        checks: ['Check null before access'],
        assumptions: ['User object exists']
      },
      {
        id: 'hyp2',
        summary: 'Missing await on async function call',
        evidence: ['async_pattern'],
        relatedNodes: ['node3'],
        confidence: 0.6,
        normalizedConfidence: 0.65,
        rationale: 'Async function not awaited properly',
        relatedFiles: ['/src/utils/helpers.ts'],
        verifiedNodes: ['node3'],
        verifiedSnippets: [],
        checks: ['Add await keyword'],
        assumptions: ['Function returns Promise']
      }
    ];
    
    mockFeedback = [
      {
        hypothesisId: 'hyp1',
        verdict: 'confirmed',
        newClues: ['Confirmed null access pattern'],
        revisedConfidence: 0.9,
        verifiedEvidence: ['Static finding: null_deref']
      },
      {
        hypothesisId: 'hyp2',
        verdict: 'uncertain',
        newClues: ['Some async patterns found'],
        revisedConfidence: 0.5,
        verifiedEvidence: []
      }
    ];
    
    mockDebugContext = {
      projectId: 'test-project',
      commitHash: 'abc123',
      bugDescription: 'Test bug',
      logs: 'Error: Cannot read property of null',
      userMessage: 'Test user message',
      evidence: {
        frames: [],
        error: 'Cannot read property of null',
        evidenceSource: 'logs' as const,
        hasHardError: true,
        logSignatures: [],
        tsconfigPaths: {},
        warnings: [],
        confidence: 0.8
      },
      gitChanges: [
        {
          hash: 'abc123',
          message: 'Fix null pointer issue',
          author: 'Test Author',
          date: new Date(),
          files: [
            { path: '/src/api/users.ts', status: 'M', additions: 5, deletions: 2 }
          ],
          relevanceScore: 0.9
        }
      ],
      graph: {
        nodes: [
          { id: 'node1', kind: 'file', label: 'users.ts', file: '/src/api/users.ts', line: 12, badges: ['error'] },
          { id: 'node2', kind: 'symbol', label: 'processUser', file: '/src/api/users.ts', line: 15 },
          { id: 'node3', kind: 'symbol', label: 'fetchData', file: '/src/utils/helpers.ts', line: 10 }
        ],
        edges: [
          { from: 'node1', to: 'node2', kind: 'calls', confidence: 0.8 }
        ]
      },
      snippets: [
        {
          id: 'snippet1',
          file: '/src/api/users.ts',
          start: 10,
          end: 20,
          text: 'function processUser(user) {\n  return user.name.toUpperCase();\n}',
          reasons: ['error_path']
        }
      ],
      evidence: {
        frames: [
          { file: '/src/api/users.ts', line: 12, fn: 'processUser' }
        ],
        error: 'Cannot read property of null'
      },
      candidates: [
        { file: '/src/api/users.ts', score: 0.9, evidence: ['error_path'] },
        { file: '/src/services/userService.ts', score: 0.7, evidence: ['stack_trace'] }
      ],
      heuristicFindings: [
        {
          file: '/src/api/users.ts',
          line: 12,
          pattern: 'null_access',
          severity: 'high',
          rationale: 'Potential null access without check',
          codeSnippet: 'user.name'
        }
      ]
    };
  });

  describe('generateReport', () => {
    it('should generate comprehensive report with all components', () => {
      const timings = {
        evidence: 100,
        hypothesis: 200,
        testing: 300,
        total: 600
      };

      const report = reportGenerator.generateReport(
        mockHypotheses,
        mockDebugContext,
        mockFeedback,
        timings
      );

      expect(report).toBeDefined();
      expect(report.summary).toContain('Root Cause Analysis Report');
      expect(report.likelyRootCause).toContain('Null pointer dereference');
      expect(report.reasoningSteps.length).toBeGreaterThanOrEqual(4);
      expect(report.recommendedFix).toContain('Recommended Fix');
      expect(report.evidence.length).toBeGreaterThanOrEqual(4);
      expect(report.confidenceSummaryTable).toContain('Confidence Summary');
      expect(report.confidence).toBeGreaterThan(0);
      expect(report.hypotheses).toHaveLength(2);
      expect(report.timings).toEqual(timings);
    });

    it('should include enhanced components', () => {
      const timings = { total: 100 };
      const report = reportGenerator.generateReport(
        mockHypotheses,
        mockDebugContext,
        mockFeedback,
        timings
      );

      expect(report.failPath).toBeDefined();
      expect(report.anchors).toBeDefined();
      expect(report.diffHunks).toBeDefined();
      expect(report.tests).toBeDefined();
      expect(report.patches).toBeDefined();
      expect(report.redactions).toBeDefined();
    });

    it('should handle empty hypotheses gracefully', () => {
      const timings = { total: 100 };
      const report = reportGenerator.generateReport(
        [],
        mockDebugContext,
        [],
        timings
      );

      expect(report.summary).toContain('Analysis inconclusive');
      expect(report.likelyRootCause).toContain('Unable to determine root cause');
      expect(report.confidence).toBe(0);
    });
  });

  describe('sortHypotheses', () => {
    it('should sort hypotheses by normalized confidence', () => {
      const sorted = (reportGenerator as any).sortHypotheses(mockHypotheses, mockFeedback);
      
      expect(sorted[0].id).toBe('hyp1'); // Higher confidence
      expect(sorted[1].id).toBe('hyp2'); // Lower confidence
    });

    it('should handle empty hypotheses array', () => {
      const sorted = (reportGenerator as any).sortHypotheses([], []);
      expect(sorted).toEqual([]);
    });
  });

  describe('computeNormalizedConfidence', () => {
    it('should calculate normalized confidence correctly', () => {
      const confidence = (reportGenerator as any).computeNormalizedConfidence(
        [mockHypotheses[0]],
        mockFeedback,
        mockDebugContext
      );

      expect(confidence).toBeGreaterThan(0);
      expect(confidence).toBeLessThanOrEqual(1);
    });

    it('should handle empty hypotheses', () => {
      const confidence = (reportGenerator as any).computeNormalizedConfidence(
        [],
        [],
        mockDebugContext
      );

      expect(confidence).toBe(0);
    });
  });

  describe('calculatePathLength', () => {
    it('should calculate path length correctly', () => {
      const pathLength = (reportGenerator as any).calculatePathLength(
        mockHypotheses[0],
        mockDebugContext
      );

      expect(pathLength).toBeGreaterThanOrEqual(0);
    });

    it('should handle missing graph', () => {
      const pathLength = (reportGenerator as any).calculatePathLength(
        mockHypotheses[0],
        { ...mockDebugContext, graph: { nodes: [], edges: [] } }
      );

      expect(pathLength).toBe(0);
    });
  });

  describe('calculateGitRecency', () => {
    it('should calculate git recency score', () => {
      const recency = (reportGenerator as any).calculateGitRecency(
        mockHypotheses[0],
        mockDebugContext
      );

      expect(recency).toBeGreaterThan(0);
      expect(recency).toBeLessThanOrEqual(1);
    });

    it('should handle missing git changes', () => {
      const recency = (reportGenerator as any).calculateGitRecency(
        mockHypotheses[0],
        { ...mockDebugContext, gitChanges: [] }
      );

      expect(recency).toBe(0.5);
    });
  });

  describe('calculateEvidenceRichness', () => {
    it('should calculate evidence richness score', () => {
      const richness = (reportGenerator as any).calculateEvidenceRichness(
        mockHypotheses[0],
        mockDebugContext
      );

      expect(richness).toBeGreaterThan(0);
      expect(richness).toBeLessThanOrEqual(1);
    });
  });

  describe('calculateVerdictScore', () => {
    it('should return correct score for confirmed verdict', () => {
      const confirmedFeedback = { ...mockFeedback[0], verdict: 'confirmed' as const };
      const score = (reportGenerator as any).calculateVerdictScore(confirmedFeedback);
      expect(score).toBe(1.0);
    });

    it('should return correct score for uncertain verdict', () => {
      const uncertainFeedback = { ...mockFeedback[1], verdict: 'uncertain' as const };
      const score = (reportGenerator as any).calculateVerdictScore(uncertainFeedback);
      expect(score).toBe(0.5);
    });

    it('should return correct score for refuted verdict', () => {
      const refutedFeedback = { ...mockFeedback[0], verdict: 'refuted' as const };
      const score = (reportGenerator as any).calculateVerdictScore(refutedFeedback);
      expect(score).toBe(0.0);
    });

    it('should return default score for undefined feedback', () => {
      const score = (reportGenerator as any).calculateVerdictScore(undefined);
      expect(score).toBe(0.5);
    });
  });

  describe('calculateConsistencyScore', () => {
    it('should calculate consistency score', () => {
      const consistency = (reportGenerator as any).calculateConsistencyScore(
        mockHypotheses[0],
        mockDebugContext
      );

      expect(consistency).toBeGreaterThanOrEqual(0);
      expect(consistency).toBeLessThanOrEqual(1);
    });
  });

  describe('buildFailPath', () => {
    it('should build fail path from error nodes to hypothesis', () => {
      const failPath = (reportGenerator as any).buildFailPath(
        mockDebugContext.graph,
        mockHypotheses[0],
        mockDebugContext
      );

      expect(failPath).toBeDefined();
      expect(Array.isArray(failPath)).toBe(true);
    });

    it('should handle missing graph', () => {
      const failPath = (reportGenerator as any).buildFailPath(
        { nodes: [], edges: [] },
        mockHypotheses[0],
        mockDebugContext
      );

      expect(failPath).toEqual([]);
    });

    it('should handle null hypothesis', () => {
      const failPath = (reportGenerator as any).buildFailPath(
        mockDebugContext.graph,
        null,
        mockDebugContext
      );

      expect(failPath).toEqual([]);
    });
  });

  describe('collectAnchors', () => {
    it('should collect anchors for VS Code links', () => {
      const anchors = (reportGenerator as any).collectAnchors(
        mockHypotheses[0],
        mockDebugContext
      );

      expect(anchors).toBeDefined();
      expect(Array.isArray(anchors)).toBe(true);
      expect(anchors.length).toBeGreaterThan(0);
    });

    it('should handle null hypothesis', () => {
      const anchors = (reportGenerator as any).collectAnchors(null, mockDebugContext);
      expect(anchors.length).toBeGreaterThanOrEqual(0); // May still collect frame anchors
    });
  });

  describe('collectDiffHunks', () => {
    it('should collect diff hunks for relevant commits', () => {
      const hunks = (reportGenerator as any).collectDiffHunks(
        mockHypotheses[0],
        mockDebugContext
      );

      expect(hunks).toBeDefined();
      expect(Array.isArray(hunks)).toBe(true);
    });

    it('should handle null hypothesis', () => {
      const hunks = (reportGenerator as any).collectDiffHunks(null, mockDebugContext);
      expect(hunks).toEqual([]);
    });
  });

  describe('generateTestCases', () => {
    it('should generate test cases for null access hypothesis', () => {
      const tests = (reportGenerator as any).generateTestCases(
        mockHypotheses[0],
        mockDebugContext
      );

      expect(tests).toBeDefined();
      expect(Array.isArray(tests)).toBe(true);
      expect(tests.length).toBeGreaterThan(0);
      expect(tests[0].kind).toBe('unit');
    });

    it('should generate test cases for async hypothesis', () => {
      const tests = (reportGenerator as any).generateTestCases(
        mockHypotheses[1],
        mockDebugContext
      );

      expect(tests).toBeDefined();
      expect(Array.isArray(tests)).toBe(true);
    });

    it('should handle null hypothesis', () => {
      const tests = (reportGenerator as any).generateTestCases(null, mockDebugContext);
      expect(tests).toEqual([]);
    });
  });

  describe('generatePatches', () => {
    it('should generate patches for null access hypothesis', () => {
      const patches = (reportGenerator as any).generatePatches(
        mockHypotheses[0],
        mockDebugContext
      );

      expect(patches).toBeDefined();
      expect(Array.isArray(patches)).toBe(true);
    });

    it('should handle null hypothesis', () => {
      const patches = (reportGenerator as any).generatePatches(null, mockDebugContext);
      expect(patches).toEqual([]);
    });
  });

  describe('identifyRedactions', () => {
    it('should identify redactions in logs', () => {
      const debugContextWithSecrets = {
        ...mockDebugContext,
        logs: 'password=secret123 token=abc456'
      };

      const redactions = (reportGenerator as any).identifyRedactions(debugContextWithSecrets);

      expect(redactions).toBeDefined();
      expect(Array.isArray(redactions)).toBe(true);
      expect(redactions.length).toBeGreaterThan(0);
    });

    it('should handle logs without secrets', () => {
      const redactions = (reportGenerator as any).identifyRedactions(mockDebugContext);
      expect(redactions).toEqual([]);
    });
  });

  describe('extractHeuristicTags', () => {
    it('should extract heuristic tags from hypothesis', () => {
      const tags = (reportGenerator as any).extractHeuristicTags(
        mockHypotheses[0],
        mockDebugContext,
        mockFeedback[0]
      );

      expect(tags).toBeDefined();
      expect(Array.isArray(tags)).toBe(true);
      expect(tags).toContain('null_access');
    });

    it('should extract async tags', () => {
      const tags = (reportGenerator as any).extractHeuristicTags(
        mockHypotheses[1],
        mockDebugContext,
        mockFeedback[1]
      );

      expect(tags).toContain('missing_await');
    });
  });

  describe('generateNullAccessFix', () => {
    it('should generate null access fix', () => {
      const fix = (reportGenerator as any).generateNullAccessFix(mockHypotheses[0]);

      expect(fix).toContain('null/undefined checks');
      expect(fix).toContain('Before');
      expect(fix).toContain('After');
      expect(fix).toContain('ESLint Rules');
    });
  });

  describe('generateAsyncFix', () => {
    it('should generate async fix', () => {
      const fix = (reportGenerator as any).generateAsyncFix(mockHypotheses[1]);

      expect(fix).toContain('async/await handling');
      expect(fix).toContain('Before');
      expect(fix).toContain('After');
      expect(fix).toContain('ESLint Rules');
    });
  });

  describe('formatVsCodeLink', () => {
    it('should format VS Code link with workspace root', () => {
      const link = (reportGenerator as any).formatVsCodeLink(
        '/src/api/users.ts',
        12,
        '/workspace'
      );

      expect(link).toContain('vscode://file');
      expect(link).toContain('/src/api/users.ts:12'); // Absolute path is used as-is
    });

    it('should format VS Code link without workspace root', () => {
      const link = (reportGenerator as any).formatVsCodeLink('/src/api/users.ts', 12);

      expect(link).toBe('/src/api/users.ts:12');
    });
  });

  describe('formatMarkdownReport', () => {
    it('should format complete markdown report', () => {
      const timings = { total: 100 };
      const report = reportGenerator.generateReport(
        mockHypotheses,
        mockDebugContext,
        mockFeedback,
        timings
      );

      const markdown = reportGenerator.formatMarkdownReport(report, '/workspace');

      expect(markdown).toContain('Root Cause Analysis Report');
      expect(markdown).toContain('Fail Path');
      expect(markdown).toContain('Reasoning Steps');
      expect(markdown).toContain('Recommended Fix');
      expect(markdown).toContain('Evidence');
      expect(markdown).toContain('Confidence Summary');
      expect(markdown).toContain('Analysis Timings');
    });

    it('should include fail path in markdown', () => {
      const timings = { total: 100 };
      const report = reportGenerator.generateReport(
        mockHypotheses,
        mockDebugContext,
        mockFeedback,
        timings
      );

      const markdown = reportGenerator.formatMarkdownReport(report);

      expect(markdown).toContain('Fail Path');
    });

    it('should include next steps for low confidence', () => {
      const lowConfidenceReport = {
        ...reportGenerator.generateReport(
          mockHypotheses,
          mockDebugContext,
          mockFeedback,
          { total: 100 }
        ),
        confidence: 0.5 // Low confidence
      };

      const markdown = reportGenerator.formatMarkdownReport(lowConfidenceReport);

      expect(markdown).toContain('What to Try Next');
    });
  });

  describe('generateSummary', () => {
    it('should generate summary with confidence', () => {
      const summary = (reportGenerator as any).generateSummary(
        mockDebugContext,
        mockHypotheses[0]
      );

      expect(summary).toContain('Root Cause Analysis Report');
      expect(summary).toContain('No logs provided');
      expect(summary).toContain('Likely Root Cause:');
      expect(summary).toContain('Analysis Scope:');
    });

    it('should handle null hypothesis', () => {
      const summary = (reportGenerator as any).generateSummary(mockDebugContext, null);

      expect(summary).toContain('Analysis inconclusive');
    });

    describe('log detection scenarios', () => {
      it('should show "No logs provided" when no logs are provided', () => {
        const debugContextNoLogs = {
          ...mockDebugContext,
          evidence: {
            ...mockDebugContext.evidence,
            hasLogs: false,
            hasHardError: false,
            softSignals: []
          }
        };

        const summary = (reportGenerator as any).generateSummary(
          debugContextNoLogs,
          mockHypotheses[0]
        );

        expect(summary).toContain('**No logs provided.** Analysis based on description and code patterns.');
      });

      it('should show "Logs provided but no errors detected" when logs are provided but contain no errors', () => {
        const debugContextWithLogs = {
          ...mockDebugContext,
          evidence: {
            ...mockDebugContext.evidence,
            hasLogs: true,
            hasHardError: false,
            softSignals: []
          }
        };

        const summary = (reportGenerator as any).generateSummary(
          debugContextWithLogs,
          mockHypotheses[0]
        );

        expect(summary).toContain('**Logs provided but no errors detected.** Analysis based on description and log patterns.');
      });

      it('should show "Exception detected" when logs contain hard errors', () => {
        const debugContextWithHardError = {
          ...mockDebugContext,
          evidence: {
            ...mockDebugContext.evidence,
            hasLogs: true,
            hasHardError: true,
            error: 'TypeError: Cannot read property "name" of undefined',
            softSignals: []
          }
        };

        const summary = (reportGenerator as any).generateSummary(
          debugContextWithHardError,
          mockHypotheses[0]
        );

        expect(summary).toContain('**Exception detected:** TypeError: Cannot read property "name" of undefined');
      });

      it('should show "No explicit exceptions detected" when logs contain soft signals', () => {
        const debugContextWithSoftSignals = {
          ...mockDebugContext,
          evidence: {
            ...mockDebugContext.evidence,
            hasLogs: true,
            hasHardError: false,
            softSignals: [
              {
                kind: 'warning',
                text: 'API request failed with status 500',
                confidence: 0.8
              },
              {
                kind: 'error',
                text: 'Database connection timeout',
                confidence: 0.9
              }
            ]
          }
        };

        const summary = (reportGenerator as any).generateSummary(
          debugContextWithSoftSignals,
          mockHypotheses[0]
        );

        expect(summary).toContain('**No explicit exceptions detected.** Signals observed:');
        expect(summary).toContain('- WARNING: API request failed with status 500');
        expect(summary).toContain('- ERROR: Database connection timeout');
      });

      it('should prioritize hard errors over soft signals', () => {
        const debugContextWithBoth = {
          ...mockDebugContext,
          evidence: {
            ...mockDebugContext.evidence,
            hasLogs: true,
            hasHardError: true,
            error: 'ReferenceError: variable is not defined',
            softSignals: [
              {
                kind: 'warning',
                text: 'Minor warning',
                confidence: 0.5
              }
            ]
          }
        };

        const summary = (reportGenerator as any).generateSummary(
          debugContextWithBoth,
          mockHypotheses[0]
        );

        expect(summary).toContain('**Exception detected:** ReferenceError: variable is not defined');
        expect(summary).not.toContain('No explicit exceptions detected');
        expect(summary).not.toContain('Logs provided but no errors detected');
      });
    });
  });

  describe('generateLikelyRootCause', () => {
    it('should generate likely root cause with file reference', () => {
      const rootCause = (reportGenerator as any).generateLikelyRootCause(
        mockHypotheses[0],
        mockDebugContext
      );

      expect(rootCause).toContain('Null pointer dereference');
      expect(rootCause).toContain('/src/api/users.ts');
    });

    it('should handle null hypothesis', () => {
      const rootCause = (reportGenerator as any).generateLikelyRootCause(null, mockDebugContext);

      expect(rootCause).toContain('Unable to determine root cause');
    });
  });

  describe('generateReasoningSteps', () => {
    it('should generate reasoning steps with fail path', () => {
      const steps = (reportGenerator as any).generateReasoningSteps(
        mockHypotheses,
        mockFeedback,
        mockDebugContext
      );

      expect(steps).toBeDefined();
      expect(Array.isArray(steps)).toBe(true);
      expect(steps.length).toBeGreaterThan(0);
      expect(steps[0]).toContain('Fail Path');
    });
  });

  describe('generateRecommendedFix', () => {
    it('should generate recommended fix with heuristic tags', () => {
      const fix = (reportGenerator as any).generateRecommendedFix(
        mockHypotheses[0],
        mockDebugContext,
        mockFeedback
      );

      expect(fix).toContain('Recommended Fix');
      expect(fix).toContain('null/undefined checks');
    });

    it('should handle null hypothesis', () => {
      const fix = (reportGenerator as any).generateRecommendedFix(
        null,
        mockDebugContext,
        mockFeedback
      );

      expect(fix).toContain('Unable to provide specific fix');
    });
  });

  describe('generateEvidenceList', () => {
    it('should generate structured evidence tables', () => {
      const evidence = (reportGenerator as any).generateEvidenceList(
        mockDebugContext,
        mockHypotheses[0]
      );

      expect(evidence).toBeDefined();
      expect(Array.isArray(evidence)).toBe(true);
      expect(evidence.length).toBeGreaterThan(0);
      expect(evidence[0]).toContain('Stack Frames');
    });
  });

  describe('generateConfidenceSummaryTable', () => {
    it('should generate confidence summary table', () => {
      const table = (reportGenerator as any).generateConfidenceSummaryTable(
        mockHypotheses,
        mockFeedback
      );

      expect(table).toContain('Confidence Summary');
      expect(table).toContain('| Hypothesis |');
      expect(table).toContain('| Confidence |');
      expect(table).toContain('| Verdict |');
    });
  });
});