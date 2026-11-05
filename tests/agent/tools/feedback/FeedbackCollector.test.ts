/**
 * Unit tests for FeedbackCollector
 * Tests validation, sanitization, path handling, and secret redaction
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { FeedbackCollector } from '../../../src/agent/tools/feedback/FeedbackCollector';
import { FeedbackStore } from '../../../src/agent/tools/feedback/FeedbackStore';
import { FeedbackRecord } from '../../../src/agent/tools/feedback/FeedbackTypes';

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
        result: 'positive' as const,
        // Missing required fields
        summary: 'Test summary'
      };

      await expect(feedbackCollector.record(invalidFeedback)).rejects.toThrow();
    });

    it('should reject empty relatedFiles array', async () => {
      const invalidFeedback = {
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
        'relative/file.ts'
      ]);
    });

    it('should handle paths outside workspace', async () => {
      const feedbackWithOutsidePaths = {
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
      expect(record.relatedFiles).toEqual(['src/test.ts']);
    });

    it('should normalize path separators', async () => {
      const feedbackWithMixedSeparators = {
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
      expect(record.relatedFiles).toEqual(['src/test.ts', 'src/test.ts']);
    });
  });

  describe('Secret Redaction', () => {
    it('should redact API keys in notes', async () => {
      const feedbackWithSecrets = {
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
      expect(record.note).toBe('API key: [REDACTED]');
    });

    it('should redact tokens in notes', async () => {
      const feedbackWithTokens = {
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
      expect(record.note).toBe('Token: [REDACTED]');
    });

    it('should redact passwords in notes', async () => {
      const feedbackWithPasswords = {
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
      expect(record.note).toBe('Password: [REDACTED]');
    });

    it('should not redact non-secret content', async () => {
      const feedbackWithNormalContent = {
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
      expect(record.note).toBe('API key: [REDACTED], Password: [REDACTED], Token: [REDACTED]');
    });
  });

  describe('Field Truncation', () => {
    it('should truncate long summary', async () => {
      const longSummary = 'x'.repeat(1000);
      const feedbackWithLongSummary = {
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
      expect(record.summary).toEndWith('...');
    });

    it('should truncate long root cause', async () => {
      const longRootCause = 'x'.repeat(1000);
      const feedbackWithLongRootCause = {
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
      expect(record.likelyRootCause).toEndWith('...');
    });

    it('should truncate long note', async () => {
      const longNote = 'x'.repeat(200);
      const feedbackWithLongNote = {
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
      expect(record.note).toEndWith('...');
    });

    it('should not truncate short content', async () => {
      const shortContent = 'Short content';
      const feedbackWithShortContent = {
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
      const testPaths = [
        path.join(tempDir, 'src', 'test.ts'),
        '/absolute/path/to/file.ts',
        'relative/file.ts',
        'src\\test.ts' // Windows separator
      ];

      const sanitized = feedbackCollector['sanitizePaths'](testPaths);
      
      expect(sanitized).toEqual([
        'src/test.ts',
        'relative/file.ts'
      ]);
    });

    it('should redact secrets correctly', () => {
      const testNote = 'API key: sk-1234567890abcdef, Password: secret123, Token: abc123def456';
      const redacted = feedbackCollector['redactSecrets'](testNote);
      
      expect(redacted).toBe('API key: [REDACTED], Password: [REDACTED], Token: [REDACTED]');
    });

    it('should truncate text correctly', () => {
      const longText = 'x'.repeat(1000);
      const truncated = feedbackCollector['truncateText'](longText, 100);
      
      expect(truncated.length).toBeLessThanOrEqual(100);
      expect(truncated).toEndWith('...');
    });
  });
});
