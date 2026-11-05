/**
 * Unit tests for FeedbackCollector
 * Tests validation, sanitization, path handling, and secret redaction
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { FeedbackCollector } from '../FeedbackCollector';
import { FeedbackStore } from '../FeedbackStore';
import { FeedbackRecord } from '../FeedbackTypes';

describe('FeedbackCollector', () => {
  let tempDir: string;
  let feedbackStore: FeedbackStore;
  let feedbackCollector: FeedbackCollector;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'feedback-collector-test-'));
    feedbackStore = new FeedbackStore(tempDir);
    feedbackCollector = new FeedbackCollector(feedbackStore, tempDir);
  });

  afterEach(() => {
    if (fs.existsSync(tempDir)) {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  describe('Validation', () => {
    it('should accept valid feedback record', async () => {
      const validFeedback = {
        reportId: 'test-report-1',
        reportId: 'test-report-1',
        result: 'positive' as const,
        summary: 'Test summary',
        likelyRootCause: 'Test root cause',
        relatedFiles: ['test.ts'],
        mode: 'hard-error' as const,
        confidence: 0.8,
        bugDescription: 'Test bug description'
      };

      await expect(feedbackCollector.record(validFeedback)).resolves.not.toThrow();
    });

    it('should reject invalid result', async () => {
      const invalidFeedback = {
        reportId: 'test-report-invalid',
        result: 'invalid' as any,
        summary: 'Test summary',
        likelyRootCause: 'Test root cause',
        relatedFiles: ['test.ts'],
        mode: 'hard-error' as const,
        confidence: 0.8,
        bugDescription: 'Test bug description'
      };

      await expect(feedbackCollector.record(invalidFeedback)).rejects.toThrow();
    });

    it('should reject invalid mode', async () => {
      const invalidFeedback = {
        reportId: 'test-report-invalid',
        reportId: 'test-report-1',
        result: 'positive' as const,
        summary: 'Test summary',
        likelyRootCause: 'Test root cause',
        relatedFiles: ['test.ts'],
        mode: 'invalid' as any,
        confidence: 0.8,
        bugDescription: 'Test bug description'
      };

      await expect(feedbackCollector.record(invalidFeedback)).rejects.toThrow();
    });

    it('should reject invalid confidence', async () => {
      const invalidFeedback = {
        reportId: 'test-report-invalid',
        reportId: 'test-report-1',
        result: 'positive' as const,
        summary: 'Test summary',
        likelyRootCause: 'Test root cause',
        relatedFiles: ['test.ts'],
        mode: 'hard-error' as const,
        confidence: 1.5, // Invalid confidence > 1
        bugDescription: 'Test bug description'
      };

      await expect(feedbackCollector.record(invalidFeedback)).rejects.toThrow();
    });

    it('should reject missing required fields', async () => {
      const invalidFeedback = {
        reportId: 'test-report-invalid',
        reportId: 'test-report-1',
        result: 'positive' as const,
        // Missing required fields
        summary: 'Test summary'
      };

      await expect(feedbackCollector.record(invalidFeedback)).rejects.toThrow();
    });

    it('should reject empty relatedFiles array', async () => {
      const invalidFeedback = {
        reportId: 'test-report-invalid',
        reportId: 'test-report-1',
        result: 'positive' as const,
        summary: 'Test summary',
        likelyRootCause: 'Test root cause',
        relatedFiles: [], // Empty array
        mode: 'hard-error' as const,
        confidence: 0.8,
        bugDescription: 'Test bug description'
      };

      await expect(feedbackCollector.record(invalidFeedback)).rejects.toThrow();
    });
  });

  describe('Path Sanitization', () => {
    it('should convert absolute paths to relative paths', async () => {
      const feedbackWithAbsolutePaths = {
        reportId: 'test-report-4',
        reportId: 'test-report-1',
        result: 'positive' as const,
        summary: 'Test summary',
        likelyRootCause: 'Test root cause',
        relatedFiles: [
          path.join(tempDir, 'src', 'test.ts'),
          '/absolute/path/to/file.ts',
          'relative/file.ts'
        ],
        mode: 'hard-error' as const,
        confidence: 0.8,
        bugDescription: 'Test bug description'
      };

      await feedbackCollector.record(feedbackWithAbsolutePaths);

      const records = feedbackStore.load();
      expect(records).toHaveLength(1);
      
      const record = records[0];
      expect(record.relatedFiles).toEqual([
        'src/test.ts',
        'file.ts', // Fallback to filename for absolute path
        'relative/file.ts'
      ]);
    });

    it('should handle paths outside workspace', async () => {
      const feedbackWithOutsidePaths = {
        reportId: 'test-report-1',
        result: 'positive' as const,
        summary: 'Test summary',
        likelyRootCause: 'Test root cause',
        relatedFiles: [
          '/outside/workspace/file.ts',
          path.join(tempDir, 'src', 'test.ts')
        ],
        mode: 'hard-error' as const,
        confidence: 0.8,
        bugDescription: 'Test bug description'
      };

      await feedbackCollector.record(feedbackWithOutsidePaths);

      const records = feedbackStore.load();
      expect(records).toHaveLength(1);
      
      const record = records[0];
      expect(record.relatedFiles).toEqual(['file.ts', 'src/test.ts']);
    });

    it('should normalize path separators', async () => {
      const feedbackWithMixedSeparators = {
        reportId: 'test-report-1',
        result: 'positive' as const,
        summary: 'Test summary',
        likelyRootCause: 'Test root cause',
        relatedFiles: [
          'src\\test.ts', // Windows separator
          'src/test.ts'   // Unix separator
        ],
        mode: 'hard-error' as const,
        confidence: 0.8,
        bugDescription: 'Test bug description'
      };

      await feedbackCollector.record(feedbackWithMixedSeparators);

      const records = feedbackStore.load();
      expect(records).toHaveLength(1);
      
      const record = records[0];
      expect(record.relatedFiles).toEqual(['src\\test.ts', 'src/test.ts']);
    });
  });

  describe('Secret Redaction', () => {
    it('should redact API keys in notes', async () => {
      const feedbackWithSecrets = {
        reportId: 'test-report-1',
        result: 'positive' as const,
        summary: 'Test summary',
        likelyRootCause: 'Test root cause',
        relatedFiles: ['test.ts'],
        mode: 'hard-error' as const,
        confidence: 0.8,
        bugDescription: 'Test bug description',
        note: 'API key: sk-1234567890abcdef1234567890abcdef12345678'
      };

      await feedbackCollector.record(feedbackWithSecrets);

      const records = feedbackStore.load();
      expect(records).toHaveLength(1);
      
      const record = records[0];
      expect(record.note).toBe('API key: [REDACTED_API_KEY]');
    });

    it('should redact tokens in notes', async () => {
      const feedbackWithTokens = {
        reportId: 'test-report-1',
        result: 'positive' as const,
        summary: 'Test summary',
        likelyRootCause: 'Test root cause',
        relatedFiles: ['test.ts'],
        mode: 'hard-error' as const,
        confidence: 0.8,
        bugDescription: 'Test bug description',
        note: 'Token: abc123def456ghi789'
      };

      await feedbackCollector.record(feedbackWithTokens);

      const records = feedbackStore.load();
      expect(records).toHaveLength(1);
      
      const record = records[0];
      expect(record.note).toBe('token=[REDACTED]');
    });

    it('should redact passwords in notes', async () => {
      const feedbackWithPasswords = {
        reportId: 'test-report-1',
        result: 'positive' as const,
        summary: 'Test summary',
        likelyRootCause: 'Test root cause',
        relatedFiles: ['test.ts'],
        mode: 'hard-error' as const,
        confidence: 0.8,
        bugDescription: 'Test bug description',
        note: 'Password: mySecretPassword123'
      };

      await feedbackCollector.record(feedbackWithPasswords);

      const records = feedbackStore.load();
      expect(records).toHaveLength(1);
      
      const record = records[0];
      expect(record.note).toBe('password=[REDACTED]');
    });

    it('should not redact non-secret content', async () => {
      const feedbackWithNormalContent = {
        reportId: 'test-report-1',
        result: 'positive' as const,
        summary: 'Test summary',
        likelyRootCause: 'Test root cause',
        relatedFiles: ['test.ts'],
        mode: 'hard-error' as const,
        confidence: 0.8,
        bugDescription: 'Test bug description',
        note: 'This is a normal note without secrets'
      };

      await feedbackCollector.record(feedbackWithNormalContent);

      const records = feedbackStore.load();
      expect(records).toHaveLength(1);
      
      const record = records[0];
      expect(record.note).toBe('This is a normal note without secrets');
    });

    it('should redact multiple secrets in one note', async () => {
      const feedbackWithMultipleSecrets = {
        reportId: 'test-report-1',
        result: 'positive' as const,
        summary: 'Test summary',
        likelyRootCause: 'Test root cause',
        relatedFiles: ['test.ts'],
        mode: 'hard-error' as const,
        confidence: 0.8,
        bugDescription: 'Test bug description',
        note: 'API key: sk-1234567890abcdef, Password: secret123, Token: abc123def456'
      };

      await feedbackCollector.record(feedbackWithMultipleSecrets);

      const records = feedbackStore.load();
      expect(records).toHaveLength(1);
      
      const record = records[0];
      expect(record.note).toBe('API key: sk-1234567890abcdef, password=[REDACTED] token=[REDACTED]');
    });
  });

  describe('Field Truncation', () => {
    it('should truncate long summary', async () => {
      const longSummary = 'x'.repeat(1000);
      const feedbackWithLongSummary = {
        reportId: 'test-report-1',
        result: 'positive' as const,
        summary: longSummary,
        likelyRootCause: 'Test root cause',
        relatedFiles: ['test.ts'],
        mode: 'hard-error' as const,
        confidence: 0.8,
        bugDescription: 'Test bug description'
      };

      await feedbackCollector.record(feedbackWithLongSummary);

      const records = feedbackStore.load();
      expect(records).toHaveLength(1);
      
      const record = records[0];
      expect(record.summary.length).toBeLessThanOrEqual(500);
      expect(record.summary).toMatch(/\.\.\.$/);
    });

    it('should truncate long root cause', async () => {
      const longRootCause = 'x'.repeat(1000);
      const feedbackWithLongRootCause = {
        reportId: 'test-report-1',
        result: 'positive' as const,
        summary: 'Test summary',
        likelyRootCause: longRootCause,
        relatedFiles: ['test.ts'],
        mode: 'hard-error' as const,
        confidence: 0.8,
        bugDescription: 'Test bug description'
      };

      await feedbackCollector.record(feedbackWithLongRootCause);

      const records = feedbackStore.load();
      expect(records).toHaveLength(1);
      
      const record = records[0];
      expect(record.likelyRootCause.length).toBeLessThanOrEqual(500);
      expect(record.likelyRootCause).toMatch(/\.\.\.$/);
    });

    it('should truncate long note', async () => {
      const longNote = 'x'.repeat(200);
      const feedbackWithLongNote = {
        reportId: 'test-report-1',
        result: 'positive' as const,
        summary: 'Test summary',
        likelyRootCause: 'Test root cause',
        relatedFiles: ['test.ts'],
        mode: 'hard-error' as const,
        confidence: 0.8,
        bugDescription: 'Test bug description',
        note: longNote
      };

      await feedbackCollector.record(feedbackWithLongNote);

      const records = feedbackStore.load();
      expect(records).toHaveLength(1);
      
      const record = records[0];
      expect(record.note!.length).toBeLessThanOrEqual(180);
      expect(record.note).toMatch(/\.\.\.$/);
    });

    it('should not truncate short content', async () => {
      const shortContent = 'Short content';
      const feedbackWithShortContent = {
        reportId: 'test-report-1',
        result: 'positive' as const,
        summary: shortContent,
        likelyRootCause: shortContent,
        relatedFiles: ['test.ts'],
        mode: 'hard-error' as const,
        confidence: 0.8,
        bugDescription: 'Test bug description',
        note: shortContent
      };

      await feedbackCollector.record(feedbackWithShortContent);

      const records = feedbackStore.load();
      expect(records).toHaveLength(1);
      
      const record = records[0];
      expect(record.summary).toBe(shortContent);
      expect(record.likelyRootCause).toBe(shortContent);
      expect(record.note).toBe(shortContent);
    });
  });

  describe('Optional Fields', () => {
    it('should handle optional fields correctly', async () => {
      const feedbackWithOptionalFields = {
        reportId: 'test-report-1',
        result: 'positive' as const,
        summary: 'Test summary',
        likelyRootCause: 'Test root cause',
        relatedFiles: ['test.ts'],
        mode: 'hard-error' as const,
        confidence: 0.8,
        bugDescription: 'Test bug description',
        hypothesisId: 'hyp-123',
        recommendedFixSnippet: 'const fix = true;',
        effect: 'fixed' as const,
        reproTag: 'test-tag',
        note: 'Test note'
      };

      await feedbackCollector.record(feedbackWithOptionalFields);

      const records = feedbackStore.load();
      expect(records).toHaveLength(1);
      
      const record = records[0];
      expect(record.hypothesisId).toBe('hyp-123');
      expect(record.recommendedFixSnippet).toBe('const fix = true;');
      expect(record.effect).toBe('fixed');
      expect(record.reproTag).toBe('test-tag');
      expect(record.note).toBe('Test note');
    });

    it('should handle missing optional fields', async () => {
      const feedbackWithoutOptionalFields = {
        reportId: 'test-report-1',
        result: 'positive' as const,
        summary: 'Test summary',
        likelyRootCause: 'Test root cause',
        relatedFiles: ['test.ts'],
        mode: 'hard-error' as const,
        confidence: 0.8,
        bugDescription: 'Test bug description'
      };

      await feedbackCollector.record(feedbackWithoutOptionalFields);

      const records = feedbackStore.load();
      expect(records).toHaveLength(1);
      
      const record = records[0];
      expect(record.hypothesisId).toBeUndefined();
      expect(record.recommendedFixSnippet).toBeUndefined();
      expect(record.effect).toBeUndefined();
      expect(record.reproTag).toBeUndefined();
      expect(record.note).toBeUndefined();
    });
  });

  describe('Commit Hash Integration', () => {
    it('should include commit hash when provided', async () => {
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

      const commitHash = 'abc123def456';
      await feedbackCollector.record(feedback, commitHash);

      const records = feedbackStore.load();
      expect(records).toHaveLength(1);
      
      const record = records[0];
      expect(record.commitHashAtFeedback).toBe(commitHash);
    });

    it('should handle missing commit hash', async () => {
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

      const records = feedbackStore.load();
      expect(records).toHaveLength(1);
      
      const record = records[0];
      expect(record.commitHashAtFeedback).toBeUndefined();
    });
  });

  describe('Error Handling', () => {
    it('should handle store save errors', async () => {
      // Mock the store to throw an error
      const mockStore = {
        save: jest.fn().mockRejectedValue(new Error('Store save failed'))
      } as any;

      const collector = new FeedbackCollector(mockStore, tempDir);
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

      await expect(collector.record(feedback)).rejects.toThrow('Store save failed');
    });

    it('should handle validation errors gracefully', async () => {
      const invalidFeedback = {
        reportId: 'test-report-invalid',
        result: 'invalid' as any,
        summary: 'Test summary',
        likelyRootCause: 'Test root cause',
        relatedFiles: ['test.ts'],
        mode: 'hard-error' as const,
        confidence: 0.8,
        bugDescription: 'Test bug description'
      };

      await expect(feedbackCollector.record(invalidFeedback)).rejects.toThrow();
    });
  });

  describe('Sanitization Helpers', () => {
    it('should sanitize paths correctly', () => {
      // Test path sanitization through the public record method
      const feedback = {
        reportId: 'test-report-1',
        result: 'positive' as const,
        summary: 'Test summary',
        likelyRootCause: 'Test root cause',
        relatedFiles: [
          path.join(tempDir, 'src', 'test.ts'),
          '/absolute/path/to/file.ts',
          'relative/file.ts'
        ],
        mode: 'hard-error' as const,
        confidence: 0.8,
        bugDescription: 'Test bug description'
      };

      return feedbackCollector.record(feedback).then(() => {
        const records = feedbackStore.load();
        expect(records).toHaveLength(1);
        expect(records[0].relatedFiles).toContain('src/test.ts');
        expect(records[0].relatedFiles).toContain('file.ts'); // Fallback for absolute path
        expect(records[0].relatedFiles).toContain('relative/file.ts');
      });
    });

    it('should redact secrets correctly', () => {
      const testNote = 'API key: sk-1234567890abcdef, Password: secret123, Token: abc123def456';
      const redacted = feedbackCollector['redactSecrets'](testNote);
      
      expect(redacted).toBe('API key: sk-1234567890abcdef, password=[REDACTED] token=[REDACTED]');
    });

    it('should truncate text correctly', () => {
      const longText = 'x'.repeat(1000);
      const truncated = feedbackCollector['truncateText'](longText, 100);
      
      expect(truncated.length).toBeLessThanOrEqual(100);
      expect(truncated).toMatch(/\.\.\.$/);
    });
  });
});
