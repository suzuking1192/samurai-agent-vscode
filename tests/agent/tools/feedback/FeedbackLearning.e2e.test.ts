/**
 * End-to-End tests for Human Feedback Learning System
 * Tests complete user workflow from feedback collection to improved debugging accuracy
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { FeedbackStore } from '../../../src/agent/tools/feedback/FeedbackStore';
import { FeedbackCollector } from '../../../src/agent/tools/feedback/FeedbackCollector';
import { FeedbackRetriever } from '../../../src/agent/tools/feedback/FeedbackRetriever';
import { FeedbackRecord } from '../../../src/agent/tools/feedback/FeedbackTypes';

describe('Feedback Learning E2E', () => {
  let tempDir: string;
  let feedbackStore: FeedbackStore;
  let feedbackCollector: FeedbackCollector;
  let feedbackRetriever: FeedbackRetriever;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'feedback-e2e-test-'));
    feedbackStore = new FeedbackStore(tempDir);
    feedbackCollector = new FeedbackCollector(feedbackStore, tempDir);
    feedbackRetriever = new FeedbackRetriever();
  });

  afterEach(() => {
    if (fs.existsSync(tempDir)) {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  describe('Complete User Workflow', () => {
    it('should simulate 5 debugging rounds with feedback and show improvement', async () => {
      // Simulate 5 debugging rounds with similar authentication issues
      const debuggingRounds = [
        {
          issue: 'Login returns 401 error',
          files: ['auth/middleware.ts', 'auth/validation.ts'],
          mode: 'hard-error' as const,
          userFeedback: 'positive' as const,
          hypothesis: 'Missing JWT token validation',
          fix: 'Added proper token validation in middleware',
          reproTag: 'auth-401'
        },
        {
          issue: 'Authentication failing with 401',
          files: ['auth/middleware.ts'],
          mode: 'hard-error' as const,
          userFeedback: 'positive' as const,
          hypothesis: 'Token validation logic error',
          fix: 'Fixed token validation logic',
          reproTag: 'auth-401'
        },
        {
          issue: 'Login authentication error',
          files: ['auth/middleware.ts', 'auth/validation.ts'],
          mode: 'hard-error' as const,
          userFeedback: 'partial' as const,
          hypothesis: 'Database connection issue',
          fix: 'Fixed database connection',
          reproTag: 'auth-401'
        },
        {
          issue: 'User login 401 error',
          files: ['auth/middleware.ts'],
          mode: 'hard-error' as const,
          userFeedback: 'positive' as const,
          hypothesis: 'Missing JWT token validation',
          fix: 'Added proper token validation in middleware',
          reproTag: 'auth-401'
        },
        {
          issue: 'Authentication 401 error',
          files: ['auth/middleware.ts', 'auth/validation.ts'],
          mode: 'hard-error' as const,
          userFeedback: 'positive' as const,
          hypothesis: 'Token validation logic error',
          fix: 'Fixed token validation logic',
          reproTag: 'auth-401'
        }
      ];

      const feedbackHistory: FeedbackRecord[] = [];
      const accuracyScores: number[] = [];

      // Simulate each debugging round
      for (let i = 0; i < debuggingRounds.length; i++) {
        const round = debuggingRounds[i];
        
        // Record feedback from previous round (if any)
        if (i > 0) {
          const previousRound = debuggingRounds[i - 1];
          const feedback = {
            result: previousRound.userFeedback,
            summary: `Round ${i}: ${previousRound.issue}`,
            likelyRootCause: previousRound.hypothesis,
            relatedFiles: previousRound.files,
            mode: previousRound.mode,
            confidence: 0.8,
            bugDescription: previousRound.issue,
            hypothesisId: `hyp-${i}`,
            recommendedFixSnippet: previousRound.fix,
            effect: previousRound.userFeedback === 'positive' ? 'fixed' : 
                   previousRound.userFeedback === 'partial' ? 'mitigated' : 'unrelated',
            reproTag: previousRound.reproTag,
            note: `Round ${i} feedback`
          };

          await feedbackCollector.record(feedback, `commit-${i}`);
          feedbackHistory.push(feedback as FeedbackRecord);
        }

        // Load feedback into retriever
        const allFeedback = feedbackStore.load();
        feedbackRetriever.loadRecords(allFeedback);

        // Simulate retrieval for current round
        const query = {
          bugDescription: round.issue,
          relatedFiles: round.files,
          mode: round.mode,
          topK: 3
        };

        const retrievedExamples = feedbackRetriever.getRelevantExamples(query);
        
        // Calculate accuracy score based on retrieved examples
        const positiveExamples = retrievedExamples.filter(e => e.result === 'positive');
        const partialExamples = retrievedExamples.filter(e => e.result === 'partial');
        const negativeExamples = retrievedExamples.filter(e => e.result === 'negative');
        
        // Weighted accuracy score
        const accuracyScore = (positiveExamples.length * 1.0 + 
                              partialExamples.length * 0.5 + 
                              negativeExamples.length * 0.2) / retrievedExamples.length;
        
        accuracyScores.push(accuracyScore || 0);
      }

      // Verify improvement over time
      expect(accuracyScores.length).toBe(5);
      
      // First round should have no examples (no feedback yet)
      expect(accuracyScores[0]).toBe(0);
      
      // Later rounds should have higher accuracy scores
      const laterRounds = accuracyScores.slice(2);
      const earlyRounds = accuracyScores.slice(0, 2);
      
      const avgLaterAccuracy = laterRounds.reduce((a, b) => a + b, 0) / laterRounds.length;
      const avgEarlyAccuracy = earlyRounds.reduce((a, b) => a + b, 0) / earlyRounds.length;
      
      expect(avgLaterAccuracy).toBeGreaterThan(avgEarlyAccuracy);
    });

    it('should demonstrate learning from different types of issues', async () => {
      // Simulate learning from different issue types
      const issueTypes = [
        {
          type: 'authentication',
          issues: [
            { description: 'Login 401 error', files: ['auth/middleware.ts'], mode: 'hard-error' as const },
            { description: 'Token validation failed', files: ['auth/validation.ts'], mode: 'hard-error' as const },
            { description: 'Authentication timeout', files: ['auth/middleware.ts'], mode: 'soft-error' as const }
          ],
          feedback: 'positive' as const,
          reproTag: 'auth-issues'
        },
        {
          type: 'database',
          issues: [
            { description: 'Database connection timeout', files: ['db/connection.ts'], mode: 'hard-error' as const },
            { description: 'Query execution failed', files: ['db/query.ts'], mode: 'hard-error' as const },
            { description: 'Database pool exhausted', files: ['db/pool.ts'], mode: 'soft-error' as const }
          ],
          feedback: 'positive' as const,
          reproTag: 'db-issues'
        },
        {
          type: 'api',
          issues: [
            { description: 'API rate limiting', files: ['api/rate-limiter.ts'], mode: 'soft-error' as const },
            { description: 'API endpoint not found', files: ['api/routes.ts'], mode: 'hard-error' as const },
            { description: 'API response timeout', files: ['api/client.ts'], mode: 'soft-error' as const }
          ],
          feedback: 'partial' as const,
          reproTag: 'api-issues'
        }
      ];

      // Record feedback for each issue type
      for (const issueType of issueTypes) {
        for (let i = 0; i < issueType.issues.length; i++) {
          const issue = issueType.issues[i];
          const feedback = {
            result: issueType.feedback,
            summary: `${issueType.type} issue: ${issue.description}`,
            likelyRootCause: `Root cause for ${issue.description}`,
            relatedFiles: issue.files,
            mode: issue.mode,
            confidence: 0.8,
            bugDescription: issue.description,
            reproTag: issueType.reproTag,
            note: `Feedback for ${issueType.type} issue`
          };

          await feedbackCollector.record(feedback, `commit-${issueType.type}-${i}`);
        }
      }

      // Load all feedback
      const allFeedback = feedbackStore.load();
      feedbackRetriever.loadRecords(allFeedback);

      // Test retrieval for each issue type
      for (const issueType of issueTypes) {
        const testIssue = issueType.issues[0];
        const query = {
          bugDescription: testIssue.description,
          relatedFiles: testIssue.files,
          mode: testIssue.mode,
          topK: 3
        };

        const retrievedExamples = feedbackRetriever.getRelevantExamples(query);
        
        // Should retrieve examples from the same issue type
        const sameTypeExamples = retrievedExamples.filter(e => 
          e.reproTag === issueType.reproTag
        );
        
        expect(sameTypeExamples.length).toBeGreaterThan(0);
        expect(sameTypeExamples[0].reproTag).toBe(issueType.reproTag);
      }
    });

    it('should handle mixed feedback scenarios', async () => {
      // Simulate mixed feedback scenarios
      const mixedScenarios = [
        {
          issue: 'Database connection issue',
          files: ['db/connection.ts'],
          mode: 'hard-error' as const,
          feedback: 'positive' as const,
          hypothesis: 'Connection pool size too small',
          fix: 'Increased connection pool size',
          reproTag: 'db-connection'
        },
        {
          issue: 'Database connection issue',
          files: ['db/connection.ts'],
          mode: 'hard-error' as const,
          feedback: 'negative' as const,
          hypothesis: 'Network timeout issue',
          fix: 'Increased network timeout',
          reproTag: 'db-connection'
        },
        {
          issue: 'Database connection issue',
          files: ['db/connection.ts'],
          mode: 'hard-error' as const,
          feedback: 'positive' as const,
          hypothesis: 'Connection pool size too small',
          fix: 'Increased connection pool size',
          reproTag: 'db-connection'
        }
      ];

      // Record mixed feedback
      for (let i = 0; i < mixedScenarios.length; i++) {
        const scenario = mixedScenarios[i];
        const feedback = {
          result: scenario.feedback,
          summary: `Scenario ${i + 1}: ${scenario.issue}`,
          likelyRootCause: scenario.hypothesis,
          relatedFiles: scenario.files,
          mode: scenario.mode,
          confidence: 0.8,
          bugDescription: scenario.issue,
          hypothesisId: `hyp-${i}`,
          recommendedFixSnippet: scenario.fix,
          effect: scenario.feedback === 'positive' ? 'fixed' : 
                 scenario.feedback === 'partial' ? 'mitigated' : 'unrelated',
          reproTag: scenario.reproTag,
          note: `Scenario ${i + 1} feedback`
        };

        await feedbackCollector.record(feedback, `commit-${i}`);
      }

      // Load feedback
      const allFeedback = feedbackStore.load();
      feedbackRetriever.loadRecords(allFeedback);

      // Test retrieval
      const query = {
        bugDescription: 'Database connection issue',
        relatedFiles: ['db/connection.ts'],
        mode: 'hard-error' as const,
        topK: 3
      };

      const retrievedExamples = feedbackRetriever.getRelevantExamples(query);

      // Should prioritize positive examples over negative
      const positiveExamples = retrievedExamples.filter(e => e.result === 'positive');
      const negativeExamples = retrievedExamples.filter(e => e.result === 'negative');

      expect(positiveExamples.length).toBeGreaterThan(negativeExamples.length);
      
      if (positiveExamples.length > 0 && negativeExamples.length > 0) {
        expect(positiveExamples[0].score).toBeGreaterThan(negativeExamples[0].score);
      }
    });
  });

  describe('Real-World Scenarios', () => {
    it('should handle complex multi-file issues', async () => {
      const complexIssue = {
        result: 'positive' as const,
        summary: 'Complex authentication flow issue',
        likelyRootCause: 'Missing validation in multiple middleware layers',
        relatedFiles: [
          'auth/middleware.ts',
          'auth/validation.ts',
          'auth/jwt.ts',
          'auth/permissions.ts',
          'api/routes.ts'
        ],
        mode: 'hard-error' as const,
        confidence: 0.9,
        bugDescription: 'User authentication fails in complex flow with multiple validation steps',
        hypothesisId: 'hyp-complex-1',
        recommendedFixSnippet: 'Added validation in all middleware layers',
        effect: 'fixed' as const,
        reproTag: 'auth-complex',
        note: 'Fixed by adding validation in all middleware layers'
      };

      await feedbackCollector.record(complexIssue, 'commit-complex');

      const allFeedback = feedbackStore.load();
      feedbackRetriever.loadRecords(allFeedback);

      // Test retrieval with partial file match
      const query = {
        bugDescription: 'Authentication flow issue',
        relatedFiles: ['auth/middleware.ts', 'auth/validation.ts'],
        mode: 'hard-error' as const,
        topK: 3
      };

      const retrievedExamples = feedbackRetriever.getRelevantExamples(query);

      expect(retrievedExamples).toHaveLength(1);
      expect(retrievedExamples[0].reproTag).toBe('auth-complex');
      expect(retrievedExamples[0].relatedFiles.length).toBe(5);
    });

    it('should handle cross-cutting concerns', async () => {
      const crossCuttingIssues = [
        {
          result: 'positive' as const,
          summary: 'Logging issue across multiple modules',
          likelyRootCause: 'Missing logger configuration',
          relatedFiles: ['utils/logger.ts', 'auth/middleware.ts', 'api/routes.ts'],
          mode: 'soft-error' as const,
          confidence: 0.7,
          bugDescription: 'Logs not appearing in multiple modules',
          reproTag: 'logging-issue'
        },
        {
          result: 'positive' as const,
          summary: 'Error handling issue across multiple modules',
          likelyRootCause: 'Missing error handler middleware',
          relatedFiles: ['utils/error-handler.ts', 'auth/middleware.ts', 'api/routes.ts'],
          mode: 'soft-error' as const,
          confidence: 0.8,
          bugDescription: 'Errors not being handled properly',
          reproTag: 'error-handling'
        }
      ];

      // Record cross-cutting issues
      for (const issue of crossCuttingIssues) {
        await feedbackCollector.record(issue, `commit-${issue.reproTag}`);
      }

      const allFeedback = feedbackStore.load();
      feedbackRetriever.loadRecords(allFeedback);

      // Test retrieval for similar cross-cutting issue
      const query = {
        bugDescription: 'Configuration issue across modules',
        relatedFiles: ['utils/config.ts', 'auth/middleware.ts', 'api/routes.ts'],
        mode: 'soft-error' as const,
        topK: 3
      };

      const retrievedExamples = feedbackRetriever.getRelevantExamples(query);

      // Should retrieve examples with similar file patterns
      expect(retrievedExamples.length).toBeGreaterThan(0);
      
      const hasSimilarFiles = retrievedExamples.some(e => 
        e.relatedFiles.some(f => f.includes('utils/')) &&
        e.relatedFiles.some(f => f.includes('auth/')) &&
        e.relatedFiles.some(f => f.includes('api/'))
      );
      
      expect(hasSimilarFiles).toBe(true);
    });
  });

  describe('Performance Under Load', () => {
    it('should maintain performance with large feedback datasets', async () => {
      // Create large dataset
      const largeDataset: Omit<FeedbackRecord, 'id' | 'timestamp'>[] = [];
      for (let i = 0; i < 500; i++) {
        largeDataset.push({
          schemaVersion: 1,
          workspaceId: tempDir,
          result: i % 3 === 0 ? 'positive' : i % 3 === 1 ? 'partial' : 'negative',
          summary: `Summary ${i}`,
          likelyRootCause: `Root cause ${i}`,
          relatedFiles: [`file${i % 20}.ts`],
          mode: i % 2 === 0 ? 'hard-error' : 'soft-error',
          confidence: 0.5 + (i % 5) * 0.1,
          bugDescription: `Bug description ${i}`,
          reproTag: `tag-${i % 10}`
        });
      }

      // Record all feedback
      const startTime = Date.now();
      for (const feedback of largeDataset) {
        await feedbackCollector.record(feedback);
      }
      const recordTime = Date.now() - startTime;

      // Load into retriever
      const allFeedback = feedbackStore.load();
      feedbackRetriever.loadRecords(allFeedback);

      // Test retrieval performance
      const query = {
        bugDescription: 'Test query',
        relatedFiles: ['file1.ts'],
        mode: 'hard-error' as const,
        topK: 5
      };

      const retrievalStartTime = Date.now();
      const examples = feedbackRetriever.getRelevantExamples(query);
      const retrievalTime = Date.now() - retrievalStartTime;

      // Performance assertions
      expect(recordTime).toBeLessThan(5000); // Should record 500 items in < 5s
      expect(retrievalTime).toBeLessThan(50); // Should retrieve in < 50ms
      expect(examples.length).toBeLessThanOrEqual(5);
    });
  });
});
