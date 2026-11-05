/**
 * Integration tests for Human Feedback Learning System
 * Tests end-to-end feedback collection, retrieval, and LLM integration
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { FeedbackStore } from '../FeedbackStore';
import { FeedbackCollector } from '../FeedbackCollector';
import { FeedbackRetriever } from '../FeedbackRetriever';
import { FeedbackRecord } from '../FeedbackTypes';

describe('Feedback Learning Integration', () => {
  let tempDir: string;
  let feedbackStore: FeedbackStore;
  let feedbackCollector: FeedbackCollector;
  let feedbackRetriever: FeedbackRetriever;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'feedback-integration-test-'));
    feedbackStore = new FeedbackStore(tempDir);
    feedbackCollector = new FeedbackCollector(feedbackStore, tempDir);
    feedbackRetriever = new FeedbackRetriever();
  });

  afterEach(() => {
    if (fs.existsSync(tempDir)) {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  describe('End-to-End Feedback Flow', () => {
    it('should collect feedback and retrieve it for similar issues', async () => {
      // Step 1: Collect positive feedback on analysis A
      const analysisA = {
        reportId: 'test-report-1',
        result: 'positive' as const,
        summary: 'User authentication failed with 401 error',
        likelyRootCause: 'Missing JWT token validation in middleware',
        relatedFiles: ['auth/middleware.ts', 'auth/validation.ts'],
        mode: 'hard-error' as const,
        confidence: 0.9,
        bugDescription: 'Login returns 401 error even with valid credentials',
        hypothesisId: 'hyp-1',
        recommendedFixSnippet: 'if (!token) return res.status(401).json({error: "Unauthorized"});',
        effect: 'fixed' as const,
        reproTag: 'auth-401',
        note: 'Fixed by adding proper token validation'
      };

      await feedbackCollector.record(analysisA, 'commit-abc123');

      // Step 2: Load feedback into retriever
      const allFeedback = feedbackStore.load();
      feedbackRetriever.loadRecords(allFeedback);

      // Step 3: Simulate similar analysis B
      const similarQuery = {
        bugDescription: 'Authentication failing with 401 status',
        relatedFiles: ['auth/middleware.ts', 'auth/validation.ts'],
        mode: 'hard-error' as const,
        topK: 3
      };

      const retrievedExamples = feedbackRetriever.getRelevantExamples(similarQuery);

      // Step 4: Verify feedback from A is retrieved for B
      expect(retrievedExamples).toHaveLength(1);
      expect(retrievedExamples[0].id).toBe(analysisA.id || '1');
      expect(retrievedExamples[0].result).toBe('positive');
      expect(retrievedExamples[0].reproTag).toBe('auth-401');
    });

    it('should inject feedback examples into LLM prompt format', async () => {
      // Collect multiple feedback records
      const feedbackRecords = [
        {
          reportId: 'test-report-1',
        result: 'positive' as const,
          summary: 'Database connection timeout',
          likelyRootCause: 'Connection pool exhausted',
          relatedFiles: ['database/connection.ts'],
          mode: 'hard-error' as const,
          confidence: 0.8,
          bugDescription: 'Database queries timing out',
          reproTag: 'db-timeout'
        },
        {
          reportId: 'test-report-1',
        result: 'positive' as const,
          summary: 'API rate limiting issue',
          likelyRootCause: 'Rate limit configuration incorrect',
          relatedFiles: ['api/rate-limiter.ts'],
          mode: 'soft-error' as const,
          confidence: 0.7,
          bugDescription: 'API calls being rate limited',
          reproTag: 'api-rate-limit'
        },
        {
          reportId: 'test-report-2',
        result: 'negative' as const,
          summary: 'File upload error',
          likelyRootCause: 'Incorrect file size validation',
          relatedFiles: ['upload/handler.ts'],
          mode: 'behavior-first' as const,
          confidence: 0.6,
          bugDescription: 'File uploads failing',
          reproTag: 'file-upload'
        }
      ];

      // Record all feedback
      for (const feedback of feedbackRecords) {
        await feedbackCollector.record(feedback);
      }

      // Load into retriever
      const allFeedback = feedbackStore.load();
      feedbackRetriever.loadRecords(allFeedback);

      // Retrieve examples for similar query
      const query = {
        bugDescription: 'Database connection issues',
        relatedFiles: ['database/connection.ts'],
        mode: 'hard-error' as const,
        topK: 3
      };

      const examples = feedbackRetriever.getRelevantExamples(query);

      // Verify structured format for LLM prompt
      expect(examples).toHaveLength(2); // Should get 2 positive examples
      expect(examples[0].result).toBe('positive');
      expect(examples[1].result).toBe('positive');
      
      // Verify examples are properly formatted for LLM
      const formattedExamples = examples.map(example => 
        `[Prior Case — POSITIVE]\nContext: "${example.bugDescription}"\nFiles: ${example.relatedFiles.join(', ')}\nHypothesis → Fix: ${example.likelyRootCause}\nOutcome: Fixed`
      );

      expect(formattedExamples[0]).toContain('Database connection timeout');
      expect(formattedExamples[0]).toContain('database/connection.ts');
    });

    it('should handle partial feedback correctly', async () => {
      const partialFeedback = {
        reportId: 'test-report-3',
        result: 'partial' as const,
        summary: 'File upload partially working',
        likelyRootCause: 'File size validation too strict',
        relatedFiles: ['upload/validation.ts'],
        mode: 'behavior-first' as const,
        confidence: 0.6,
        bugDescription: 'File uploads work for small files but fail for large ones',
        note: 'Reduced file size limit from 10MB to 5MB, but still having issues'
      };

      await feedbackCollector.record(partialFeedback);

      const allFeedback = feedbackStore.load();
      feedbackRetriever.loadRecords(allFeedback);

      const query = {
        bugDescription: 'File upload issues with large files',
        relatedFiles: ['upload/validation.ts'],
        mode: 'behavior-first' as const,
        topK: 3
      };

      const examples = feedbackRetriever.getRelevantExamples(query);

      expect(examples).toHaveLength(1);
      expect(examples[0].result).toBe('partial');
      expect(examples[0].note).toBe('Reduced file size limit from 10MB to 5MB, but still having issues');
    });
  });

  describe('Performance and Scalability', () => {
    it('should handle large datasets efficiently', async () => {
      // Create 100 feedback records
      const largeDataset: Omit<FeedbackRecord, 'id' | 'timestamp'>[] = [];
      for (let i = 0; i < 100; i++) {
        largeDataset.push({
          reportId: `report-${i}`,
          schemaVersion: 1,
          workspaceId: tempDir,
          schemaVersion: 1,
          workspaceId: tempDir,
          result: i % 3 === 0 ? 'positive' : i % 3 === 1 ? 'partial' : 'negative',
          summary: `Summary ${i}`,
          likelyRootCause: `Root cause ${i}`,
          relatedFiles: [`file${i % 10}.ts`],
          mode: i % 2 === 0 ? 'hard-error' : 'soft-error',
          confidence: 0.5 + (i % 5) * 0.1,
          bugDescription: `Bug description ${i}`,
          reproTag: `tag-${i % 5}`
        });
      }

      // Record all feedback
      for (const feedback of largeDataset) {
        await feedbackCollector.record(feedback);
      }

      // Load into retriever
      const allFeedback = feedbackStore.load();
      feedbackRetriever.loadRecords(allFeedback);

      // Test retrieval performance
      const startTime = Date.now();
      const query = {
        bugDescription: 'Test query',
        relatedFiles: ['file1.ts'],
        mode: 'hard-error' as const,
        topK: 5
      };

      const examples = feedbackRetriever.getRelevantExamples(query);
      const endTime = Date.now();

      expect(endTime - startTime).toBeLessThan(50); // Should be < 50ms
      expect(examples.length).toBeLessThanOrEqual(5);
    });

    it('should maintain performance with repeated queries', async () => {
      // Create dataset
      const feedback = {
        reportId: 'test-report-5',
        reportId: 'test-report-1',
        result: 'positive' as const,
        summary: 'Test summary',
        likelyRootCause: 'Test root cause',
        relatedFiles: ['test.ts'],
        mode: 'hard-error' as const,
        confidence: 0.8,
        bugDescription: 'Test bug description'
      };

      await feedbackCollector.record(feedback);
      const allFeedback = feedbackStore.load();
      feedbackRetriever.loadRecords(allFeedback);

      const query = {
        bugDescription: 'Test query',
        relatedFiles: ['test.ts'],
        mode: 'hard-error' as const,
        topK: 3
      };

      // Run same query multiple times
      const times: number[] = [];
      for (let i = 0; i < 10; i++) {
        const startTime = Date.now();
        feedbackRetriever.getRelevantExamples(query);
        const endTime = Date.now();
        times.push(endTime - startTime);
      }

      // Later queries should be faster due to caching
      const avgTime = times.reduce((a, b) => a + b, 0) / times.length;
      expect(avgTime).toBeLessThan(20); // Should be very fast with caching
    });
  });

  describe('Data Integrity', () => {
    it('should maintain data integrity across multiple operations', async () => {
      const feedbackRecords = [
        {
          reportId: 'test-report-1',
        result: 'positive' as const,
          summary: 'First feedback',
          likelyRootCause: 'First root cause',
          relatedFiles: ['file1.ts'],
          mode: 'hard-error' as const,
          confidence: 0.8,
          bugDescription: 'First bug'
        },
        {
          reportId: 'test-report-2',
        result: 'negative' as const,
          summary: 'Second feedback',
          likelyRootCause: 'Second root cause',
          relatedFiles: ['file2.ts'],
          mode: 'soft-error' as const,
          confidence: 0.6,
          bugDescription: 'Second bug'
        }
      ];

      // Record all feedback
      for (const feedback of feedbackRecords) {
        await feedbackCollector.record(feedback);
      }

      // Verify all records are stored
      const storedRecords = feedbackStore.load();
      expect(storedRecords).toHaveLength(2);

      // Verify records are complete and valid
      for (const record of storedRecords) {
        expect(record.schemaVersion).toBe(1);
        expect(record.id).toBeDefined();
        expect(record.timestamp).toBeDefined();
        expect(record.workspaceId).toBe(tempDir);
        expect(['positive', 'partial', 'negative']).toContain(record.result);
        expect(['hard-error', 'soft-error', 'behavior-first']).toContain(record.mode);
        expect(record.confidence).toBeGreaterThanOrEqual(0);
        expect(record.confidence).toBeLessThanOrEqual(1);
      }
    });

    it('should handle concurrent operations safely', async () => {
      const feedbackRecords = Array.from({ length: 10 }, (_, i) => ({
        reportId: 'test-report-1',
        result: 'positive' as const,
        summary: `Feedback ${i}`,
        likelyRootCause: `Root cause ${i}`,
        relatedFiles: [`file${i}.ts`],
        mode: 'hard-error' as const,
        confidence: 0.8,
        bugDescription: `Bug ${i}`
      }));

      // Record all feedback concurrently
      const promises = feedbackRecords.map(feedback => 
        feedbackCollector.record(feedback)
      );

      await Promise.all(promises);

      // Verify all records were stored
      const storedRecords = feedbackStore.load();
      expect(storedRecords).toHaveLength(10);
    });
  });

  describe('Privacy and Security', () => {
    it('should sanitize sensitive information', async () => {
      const feedbackWithSecrets = {
        reportId: 'test-report-1',
        result: 'positive' as const,
        summary: 'Test summary',
        likelyRootCause: 'Test root cause',
        relatedFiles: [
          path.join(tempDir, 'src', 'test.ts'),
          '/absolute/path/to/secret.ts'
        ],
        mode: 'hard-error' as const,
        confidence: 0.8,
        bugDescription: 'Test bug description',
        note: 'API key: sk-1234567890abcdef, Password: secret123'
      };

      await feedbackCollector.record(feedbackWithSecrets);

      const storedRecords = feedbackStore.load();
      expect(storedRecords).toHaveLength(1);

      const record = storedRecords[0];
      expect(record.relatedFiles).toEqual(['src/test.ts']); // Absolute path removed
      expect(record.note).toBe('API key: [REDACTED], Password: [REDACTED]');
    });

    it('should handle empty feedback gracefully', async () => {
      const emptyFeedback = {
        reportId: 'test-report-1',
        result: 'positive' as const,
        summary: '',
        likelyRootCause: '',
        relatedFiles: [],
        mode: 'hard-error' as const,
        confidence: 0.8,
        bugDescription: ''
      };

      await expect(feedbackCollector.record(emptyFeedback)).rejects.toThrow();
    });
  });

  describe('Feedback Learning Effectiveness', () => {
    it('should improve retrieval accuracy over time', async () => {
      // Simulate learning from multiple similar issues
      const similarIssues = [
        {
          reportId: 'test-report-1',
        result: 'positive' as const,
          summary: 'Auth middleware 401 error',
          likelyRootCause: 'Missing token validation',
          relatedFiles: ['auth/middleware.ts'],
          mode: 'hard-error' as const,
          confidence: 0.9,
          bugDescription: 'Login returns 401',
          reproTag: 'auth-401'
        },
        {
          reportId: 'test-report-1',
        result: 'positive' as const,
          summary: 'Auth middleware 401 error',
          likelyRootCause: 'Token validation logic error',
          relatedFiles: ['auth/middleware.ts'],
          mode: 'hard-error' as const,
          confidence: 0.8,
          bugDescription: 'Authentication failing',
          reproTag: 'auth-401'
        },
        {
          reportId: 'test-report-2',
        result: 'negative' as const,
          summary: 'Auth middleware 401 error',
          likelyRootCause: 'Database connection issue',
          relatedFiles: ['auth/middleware.ts'],
          mode: 'hard-error' as const,
          confidence: 0.6,
          bugDescription: 'Login returns 401',
          reproTag: 'auth-401'
        }
      ];

      // Record all feedback
      for (const feedback of similarIssues) {
        await feedbackCollector.record(feedback);
      }

      // Load into retriever
      const allFeedback = feedbackStore.load();
      feedbackRetriever.loadRecords(allFeedback);

      // Query for similar issue
      const query = {
        bugDescription: 'Authentication 401 error',
        relatedFiles: ['auth/middleware.ts'],
        mode: 'hard-error' as const,
        topK: 3
      };

      const examples = feedbackRetriever.getRelevantExamples(query);

      // Should prioritize positive examples
      const positiveExamples = examples.filter(e => e.result === 'positive');
      const negativeExamples = examples.filter(e => e.result === 'negative');

      expect(positiveExamples.length).toBeGreaterThan(negativeExamples.length);
      expect(positiveExamples[0].score).toBeGreaterThan(negativeExamples[0].score);
    });

    it('should learn from repro tags', async () => {
      const taggedFeedback = {
        reportId: 'test-report-1',
        result: 'positive' as const,
        summary: 'Database timeout issue',
        likelyRootCause: 'Connection pool size too small',
        relatedFiles: ['database/connection.ts'],
        mode: 'hard-error' as const,
        confidence: 0.9,
        bugDescription: 'Database queries timing out',
        reproTag: 'db-timeout'
      };

      await feedbackCollector.record(taggedFeedback);
      const allFeedback = feedbackStore.load();
      feedbackRetriever.loadRecords(allFeedback);

      // Query with same repro tag
      const query = {
        bugDescription: 'Different database issue',
        relatedFiles: ['other/file.ts'],
        mode: 'hard-error' as const,
        topK: 3
      };

      const examples = feedbackRetriever.getRelevantExamples(query);

      // Should still find the tagged example due to repro tag bonus
      expect(examples.length).toBeGreaterThan(0);
    });
  });
});
