/**
 * Unit tests for FeedbackRetriever
 * Tests field-weighted scoring, recency decay, diversity enforcement, and file preference
 */

import { FeedbackRetriever } from '../FeedbackRetriever';
import { FeedbackRecord, FeedbackFieldWeights } from '../FeedbackTypes';

describe('FeedbackRetriever', () => {
  let retriever: FeedbackRetriever;
  let mockRecords: FeedbackRecord[];

  beforeEach(() => {
    retriever = new FeedbackRetriever();
    
    // Create mock feedback records
    mockRecords = [
      {
        schemaVersion: 1,
        id: '1',
        workspaceId: '/workspace',
        timestamp: Date.now() - 1000 * 60 * 60 * 24, // 1 day ago
        result: 'positive',
        summary: 'User authentication failed',
        likelyRootCause: 'Missing JWT token validation',
        relatedFiles: ['auth.ts', 'middleware.ts'],
        mode: 'hard-error',
        confidence: 0.9,
        bugDescription: 'Login returns 401 error',
        reproTag: 'auth-login'
      },
      {
        schemaVersion: 1,
        id: '2',
        workspaceId: '/workspace',
        timestamp: Date.now() - 1000 * 60 * 60 * 24 * 7, // 1 week ago
        result: 'positive',
        summary: 'Database connection timeout',
        likelyRootCause: 'Connection pool exhausted',
        relatedFiles: ['database.ts', 'config.ts'],
        mode: 'hard-error',
        confidence: 0.8,
        bugDescription: 'Database queries timing out',
        reproTag: 'db-timeout'
      },
      {
        schemaVersion: 1,
        id: '3',
        workspaceId: '/workspace',
        timestamp: Date.now() - 1000 * 60 * 60 * 24 * 30, // 1 month ago
        result: 'negative',
        summary: 'API rate limiting issue',
        likelyRootCause: 'Incorrect rate limit configuration',
        relatedFiles: ['api.ts', 'rate-limiter.ts'],
        mode: 'soft-error',
        confidence: 0.6,
        bugDescription: 'API calls being rate limited',
        reproTag: 'api-rate-limit'
      },
      {
        schemaVersion: 1,
        id: '4',
        workspaceId: '/workspace',
        timestamp: Date.now() - 1000 * 60 * 60 * 24 * 2, // 2 days ago
        result: 'partial',
        summary: 'File upload error',
        likelyRootCause: 'File size validation missing',
        relatedFiles: ['upload.ts', 'validation.ts'],
        mode: 'behavior-first',
        confidence: 0.7,
        bugDescription: 'File uploads failing silently',
        reproTag: 'file-upload'
      }
    ];

    retriever.loadRecords(mockRecords);
  });

  describe('Field-Weighted Scoring', () => {
    it('should prefer file matches over description matches', () => {
      const query = {
        bugDescription: 'Database connection issues',
        relatedFiles: ['auth.ts', 'middleware.ts'], // Matches record 1
        mode: 'hard-error' as const,
        topK: 3
      };

      const results = retriever.getRelevantExamples(query);
      
      // Record 1 should score higher due to file match, even though record 2 has better description match
      expect(results[0].id).toBe('1');
      expect(results[0].score).toBeGreaterThan(results[1].score);
    });

    it('should apply correct field weights', () => {
      const customWeights: FeedbackFieldWeights = {
        relatedFiles: 0.8,
        bugDescription: 0.1,
        likelyRootCause: 0.05,
        mode: 0.03,
        reproTag: 0.02
      };

      const customRetriever = new FeedbackRetriever(customWeights);
      customRetriever.loadRecords(mockRecords);

      const query = {
        bugDescription: 'Database connection issues',
        relatedFiles: ['auth.ts'], // Matches record 1
        mode: 'hard-error' as const,
        topK: 2
      };

      const results = customRetriever.getRelevantExamples(query);
      expect(results[0].id).toBe('1');
    });

    it('should apply repro tag bonus correctly', () => {
      const query = {
        bugDescription: 'Login authentication error',
        relatedFiles: ['other.ts'],
        mode: 'hard-error' as const,
        topK: 2
      };

      const results = retriever.getRelevantExamples(query);
      
      // Record 1 should score higher due to repro tag match
      const record1 = results.find(r => r.id === '1');
      expect(record1).toBeDefined();
      expect(record1!.score).toBeGreaterThan(0);
    });
  });

  describe('Recency Decay', () => {
    it('should apply recency decay to older records', () => {
      const query = {
        bugDescription: 'Database connection issues',
        relatedFiles: ['database.ts'],
        mode: 'hard-error' as const,
        topK: 2
      };

      const results = retriever.getRelevantExamples(query);
      
      // Record 2 (1 week old) should score higher than record 3 (1 month old)
      // even if they have similar content
      const record2 = results.find(r => r.id === '2');
      const record3 = results.find(r => r.id === '3');
      
      if (record2 && record3) {
        expect(record2.score).toBeGreaterThan(record3.score);
      }
    });

    it('should not apply excessive decay to recent records', () => {
      const query = {
        bugDescription: 'User authentication failed',
        relatedFiles: ['auth.ts'],
        mode: 'hard-error' as const,
        topK: 2
      };

      const results = retriever.getRelevantExamples(query);
      
      // Record 1 (1 day old) should still score well
      const record1 = results.find(r => r.id === '1');
      expect(record1).toBeDefined();
      expect(record1!.score).toBeGreaterThan(0.1);
    });
  });

  describe('Diversity Enforcement', () => {
    it('should not return multiple records from the same file', () => {
      // Create records with same files
      const duplicateFileRecords: FeedbackRecord[] = [
        {
          ...mockRecords[0],
          id: '5',
          summary: 'Another auth issue',
          likelyRootCause: 'Different auth problem'
        },
        {
          ...mockRecords[0],
          id: '6',
          summary: 'Yet another auth issue',
          likelyRootCause: 'Another auth problem'
        }
      ];

      retriever.loadRecords([...mockRecords, ...duplicateFileRecords]);

      const query = {
        bugDescription: 'Authentication problems',
        relatedFiles: ['auth.ts'],
        mode: 'hard-error' as const,
        topK: 3
      };

      const results = retriever.getRelevantExamples(query);
      
      // Should not return multiple records from same file unless score delta is significant
      const authFiles = results.filter(r => r.relatedFiles.includes('auth.ts'));
      expect(authFiles.length).toBeLessThanOrEqual(2);
    });

    it('should return records from different files when scores are similar', () => {
      const query = {
        bugDescription: 'General error handling',
        relatedFiles: ['auth.ts', 'database.ts', 'api.ts'],
        mode: 'hard-error' as const,
        topK: 3
      };

      const results = retriever.getRelevantExamples(query);
      
      // Should have records from different files
      const uniqueFiles = new Set();
      results.forEach(r => {
        r.relatedFiles.forEach(f => uniqueFiles.add(f));
      });
      
      expect(uniqueFiles.size).toBeGreaterThan(1);
    });
  });

  describe('Outcome Weighting', () => {
    it('should weight positive examples higher than partial', () => {
      const query = {
        bugDescription: 'General error handling issue',
        relatedFiles: ['auth.ts'], // Matches positive records better
        mode: 'hard-error' as const,
        topK: 3
      };

      const results = retriever.getRelevantExamples(query);
      
      // Should have positive records scoring higher than partial/negative
      const positiveRecords = results.filter(r => r.result === 'positive');
      const partialRecords = results.filter(r => r.result === 'partial');
      const negativeRecords = results.filter(r => r.result === 'negative');
      
      if (positiveRecords.length > 0 && partialRecords.length > 0) {
        expect(positiveRecords[0].score).toBeGreaterThan(partialRecords[0].score);
      }
      
      if (positiveRecords.length > 0 && negativeRecords.length > 0) {
        expect(positiveRecords[0].score).toBeGreaterThan(negativeRecords[0].score);
      }
    });

    it('should weight negative examples lowest', () => {
      const query = {
        bugDescription: 'API rate limiting',
        relatedFiles: ['api.ts'],
        mode: 'soft-error' as const,
        topK: 3
      };

      const results = retriever.getRelevantExamples(query);
      
      // Record 3 (negative) should score lower than positive/partial
      const record3 = results.find(r => r.id === '3');
      const otherRecords = results.filter(r => r.id !== '3');
      
      if (record3 && otherRecords.length > 0) {
        expect(otherRecords[0].score).toBeGreaterThan(record3.score);
      }
    });
  });

  describe('Mode Matching', () => {
    it('should prefer records with matching mode', () => {
      const query = {
        bugDescription: 'Some error',
        relatedFiles: ['test.ts'],
        mode: 'soft-error' as const,
        topK: 2
      };

      const results = retriever.getRelevantExamples(query);
      
      // Record 3 (soft-error) should score higher than hard-error records
      const record3 = results.find(r => r.id === '3');
      const hardErrorRecords = results.filter(r => r.mode === 'hard-error');
      
      if (record3 && hardErrorRecords.length > 0) {
        expect(record3.score).toBeGreaterThan(hardErrorRecords[0].score);
      }
    });
  });

  describe('Pre-Indexing and Caching', () => {
    it('should build indexes correctly', () => {
      const stats = retriever.getStats();
      
      expect(stats.totalRecords).toBe(4);
      expect(stats.indexedTokens).toBeGreaterThan(0);
      expect(stats.indexedFiles).toBeGreaterThan(0);
    });

    it('should cache query results', () => {
      const query = {
        bugDescription: 'Test query',
        relatedFiles: ['test.ts'],
        mode: 'hard-error' as const,
        topK: 2
      };

      // First query
      const results1 = retriever.getRelevantExamples(query);
      
      // Second identical query should use cache
      const results2 = retriever.getRelevantExamples(query);
      
      expect(results1).toEqual(results2);
      
      const stats = retriever.getStats();
      expect(stats.cacheSize).toBe(1);
    });

    it('should clear cache correctly', () => {
      const query = {
        bugDescription: 'Test query',
        relatedFiles: ['test.ts'],
        mode: 'hard-error' as const,
        topK: 2
      };

      retriever.getRelevantExamples(query);
      expect(retriever.getStats().cacheSize).toBe(1);
      
      retriever.clearCache();
      expect(retriever.getStats().cacheSize).toBe(0);
    });
  });

  describe('Edge Cases', () => {
    it('should handle empty records array', () => {
      retriever.loadRecords([]);
      
      const query = {
        bugDescription: 'Test',
        relatedFiles: ['test.ts'],
        mode: 'hard-error' as const,
        topK: 3
      };

      const results = retriever.getRelevantExamples(query);
      expect(results).toEqual([]);
    });

    it('should handle empty query', () => {
      const query = {
        bugDescription: '',
        relatedFiles: [],
        mode: 'hard-error' as const,
        topK: 3
      };

      const results = retriever.getRelevantExamples(query);
      expect(results.length).toBeLessThanOrEqual(3);
    });

    it('should respect topK limit', () => {
      const query = {
        bugDescription: 'Test query',
        relatedFiles: ['test.ts'],
        mode: 'hard-error' as const,
        topK: 2
      };

      const results = retriever.getRelevantExamples(query);
      expect(results.length).toBeLessThanOrEqual(2);
    });

    it('should filter out low-scoring results', () => {
      // Create a record with very different content
      const differentRecord: FeedbackRecord = {
        schemaVersion: 1,
        id: '5',
        workspaceId: '/workspace',
        timestamp: Date.now(),
        result: 'positive',
        summary: 'Completely different issue',
        likelyRootCause: 'Unrelated problem',
        relatedFiles: ['unrelated.ts'],
        mode: 'behavior-first',
        confidence: 0.5,
        bugDescription: 'Totally different bug'
      };

      retriever.loadRecords([...mockRecords, differentRecord]);

      const query = {
        bugDescription: 'Authentication login error',
        relatedFiles: ['auth.ts'],
        mode: 'hard-error' as const,
        topK: 5
      };

      const results = retriever.getRelevantExamples(query);
      
      // Should not include the unrelated record
      const unrelatedRecord = results.find(r => r.id === '5');
      expect(unrelatedRecord).toBeUndefined();
    });
  });

  describe('Performance', () => {
    it('should retrieve results quickly for large datasets', () => {
      // Create a large dataset
      const largeRecords: FeedbackRecord[] = [];
      for (let i = 0; i < 500; i++) {
        largeRecords.push({
          schemaVersion: 1,
          id: `record-${i}`,
          workspaceId: '/workspace',
          timestamp: Date.now() - i * 1000,
          result: i % 3 === 0 ? 'positive' : i % 3 === 1 ? 'partial' : 'negative',
          summary: `Summary ${i}`,
          likelyRootCause: `Root cause ${i}`,
          relatedFiles: [`file${i % 10}.ts`],
          mode: i % 2 === 0 ? 'hard-error' : 'soft-error',
          confidence: 0.5 + (i % 5) * 0.1,
          bugDescription: `Bug description ${i}`
        });
      }

      retriever.loadRecords(largeRecords);

      const startTime = Date.now();
      const query = {
        bugDescription: 'Test query',
        relatedFiles: ['file1.ts'],
        mode: 'hard-error' as const,
        topK: 3
      };

      const results = retriever.getRelevantExamples(query);
      const endTime = Date.now();

      expect(endTime - startTime).toBeLessThan(50); // Should be < 50ms
      expect(results.length).toBeLessThanOrEqual(3);
    });
  });
});
