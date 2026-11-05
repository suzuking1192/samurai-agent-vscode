/**
 * Unit tests for FeedbackStore
 * Tests atomic writes, lock file mechanism, rotation, and corruption tolerance
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { FeedbackStore } from '../../../src/agent/tools/feedback/FeedbackStore';
import { FeedbackRecord } from '../../../src/agent/tools/feedback/FeedbackTypes';

describe('FeedbackStore', () => {
  let tempDir: string;
  let feedbackStore: FeedbackStore;

  beforeEach(() => {
    // Create temporary directory for each test
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'feedback-test-'));
    feedbackStore = new FeedbackStore(tempDir);
  });

  afterEach(() => {
    // Clean up temporary directory
    if (fs.existsSync(tempDir)) {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  describe('Atomic Writes', () => {
    it('should write atomically using temp file and rename', async () => {
      const record: Omit<FeedbackRecord, 'id' | 'timestamp'> = {
        schemaVersion: 1,
        workspaceId: tempDir,
        result: 'positive',
        summary: 'Test summary',
        likelyRootCause: 'Test root cause',
        relatedFiles: ['test.ts'],
        mode: 'hard-error',
        confidence: 0.8,
        bugDescription: 'Test bug'
      };

      await feedbackStore.save(record);

      // Verify main file exists and temp file doesn't
      expect(fs.existsSync(path.join(tempDir, '.vscode', 'samurai-agent', 'feedback.json'))).toBe(true);
      expect(fs.existsSync(path.join(tempDir, '.vscode', 'samurai-agent', 'feedback.json.tmp'))).toBe(false);
    });

    it('should handle write failures gracefully', async () => {
      // Create a read-only directory to simulate write failure
      const readOnlyDir = path.join(tempDir, 'readonly');
      fs.mkdirSync(readOnlyDir, { recursive: true });
      fs.chmodSync(readOnlyDir, 0o444); // Read-only

      const readOnlyStore = new FeedbackStore(readOnlyDir);
      const record: Omit<FeedbackRecord, 'id' | 'timestamp'> = {
        schemaVersion: 1,
        workspaceId: readOnlyDir,
        result: 'positive',
        summary: 'Test',
        likelyRootCause: 'Test',
        relatedFiles: [],
        mode: 'hard-error',
        confidence: 0.5,
        bugDescription: 'Test'
      };

      await expect(readOnlyStore.save(record)).rejects.toThrow();
    });

    it('should clean up temp files on error', async () => {
      const record: Omit<FeedbackRecord, 'id' | 'timestamp'> = {
        schemaVersion: 1,
        workspaceId: tempDir,
        result: 'positive',
        summary: 'Test',
        likelyRootCause: 'Test',
        relatedFiles: [],
        mode: 'hard-error',
        confidence: 0.5,
        bugDescription: 'Test'
      };

      // Mock fs.renameSync to throw an error
      const originalRenameSync = fs.renameSync;
      fs.renameSync = jest.fn().mockImplementation(() => {
        throw new Error('Simulated rename failure');
      });

      try {
        await expect(feedbackStore.save(record)).rejects.toThrow('Simulated rename failure');
        
        // Verify temp file was cleaned up
        expect(fs.existsSync(path.join(tempDir, '.vscode', 'samurai-agent', 'feedback.json.tmp'))).toBe(false);
      } finally {
        fs.renameSync = originalRenameSync;
      }
    });
  });

  describe('Lock File Mechanism', () => {
    it('should prevent concurrent writes', async () => {
      const record: Omit<FeedbackRecord, 'id' | 'timestamp'> = {
        schemaVersion: 1,
        workspaceId: tempDir,
        result: 'positive',
        summary: 'Test',
        likelyRootCause: 'Test',
        relatedFiles: [],
        mode: 'hard-error',
        confidence: 0.5,
        bugDescription: 'Test'
      };

      // Start two concurrent saves
      const save1 = feedbackStore.save(record);
      const save2 = feedbackStore.save(record);

      // Both should complete (one will wait for the other)
      await expect(Promise.all([save1, save2])).resolves.toBeDefined();
    });

    it('should timeout if lock is held too long', async () => {
      const record: Omit<FeedbackRecord, 'id' | 'timestamp'> = {
        schemaVersion: 1,
        workspaceId: tempDir,
        result: 'positive',
        summary: 'Test',
        likelyRootCause: 'Test',
        relatedFiles: [],
        mode: 'hard-error',
        confidence: 0.5,
        bugDescription: 'Test'
      };

      // Create a store with very short timeout
      const shortTimeoutStore = new FeedbackStore(tempDir, { lockTimeoutMs: 100 });

      // Create a lock file manually
      const lockFile = path.join(tempDir, '.vscode', 'samurai-agent', 'feedback.json.lock');
      fs.mkdirSync(path.dirname(lockFile), { recursive: true });
      fs.writeFileSync(lockFile, 'locked');

      await expect(shortTimeoutStore.save(record)).rejects.toThrow('Failed to acquire lock within 100ms');
    });
  });

  describe('Rotation', () => {
    it('should keep only the most recent N records', async () => {
      // Save 10 records
      for (let i = 0; i < 10; i++) {
        const record: Omit<FeedbackRecord, 'id' | 'timestamp'> = {
          schemaVersion: 1,
          workspaceId: tempDir,
          result: 'positive',
          summary: `Test ${i}`,
          likelyRootCause: 'Test',
          relatedFiles: [],
          mode: 'hard-error',
          confidence: 0.5,
          bugDescription: 'Test'
        };
        await feedbackStore.save(record);
      }

      // Create a store with max 5 entries
      const limitedStore = new FeedbackStore(tempDir, { maxEntries: 5 });
      await limitedStore.rotate();

      const records = limitedStore.load();
      expect(records.length).toBeLessThanOrEqual(5);
    });

    it('should sort records by timestamp descending', async () => {
      // Save records with different timestamps
      const baseTime = Date.now();
      for (let i = 0; i < 3; i++) {
        const record: Omit<FeedbackRecord, 'id' | 'timestamp'> = {
          schemaVersion: 1,
          workspaceId: tempDir,
          result: 'positive',
          summary: `Test ${i}`,
          likelyRootCause: 'Test',
          relatedFiles: [],
          mode: 'hard-error',
          confidence: 0.5,
          bugDescription: 'Test'
        };
        await feedbackStore.save(record);
        // Small delay to ensure different timestamps
        await new Promise(resolve => setTimeout(resolve, 10));
      }

      const records = feedbackStore.load();
      expect(records.length).toBe(3);
      
      // Check that records are sorted by timestamp descending
      for (let i = 0; i < records.length - 1; i++) {
        expect(records[i].timestamp).toBeGreaterThanOrEqual(records[i + 1].timestamp);
      }
    });
  });

  describe('Corruption Tolerance', () => {
    it('should tolerate partial corruption and keep valid records', async () => {
      // Create a corrupted JSON file
      const feedbackFile = path.join(tempDir, '.vscode', 'samurai-agent', 'feedback.json');
      fs.mkdirSync(path.dirname(feedbackFile), { recursive: true });
      
      const corruptedData = `[
        {"schemaVersion": 1, "id": "1", "workspaceId": "${tempDir}", "timestamp": ${Date.now()}, "result": "positive", "summary": "Valid", "likelyRootCause": "Valid", "relatedFiles": [], "mode": "hard-error", "confidence": 0.5, "bugDescription": "Valid"},
        {"invalid": "data"},
        {"schemaVersion": 1, "id": "3", "workspaceId": "${tempDir}", "timestamp": ${Date.now()}, "result": "negative", "summary": "Also Valid", "likelyRootCause": "Also Valid", "relatedFiles": [], "mode": "soft-error", "confidence": 0.3, "bugDescription": "Also Valid"}
      ]`;
      
      fs.writeFileSync(feedbackFile, corruptedData);

      const records = feedbackStore.load();
      expect(records.length).toBe(2); // Should keep only valid records
      expect(records[0].summary).toBe('Valid');
      expect(records[1].summary).toBe('Also Valid');
    });

    it('should handle completely invalid JSON', () => {
      const feedbackFile = path.join(tempDir, '.vscode', 'samurai-agent', 'feedback.json');
      fs.mkdirSync(path.dirname(feedbackFile), { recursive: true });
      fs.writeFileSync(feedbackFile, 'invalid json data');

      const records = feedbackStore.load();
      expect(records).toEqual([]);
    });

    it('should handle missing file', () => {
      const records = feedbackStore.load();
      expect(records).toEqual([]);
    });
  });

  describe('Schema Validation', () => {
    it('should reject records with invalid schema version', async () => {
      const invalidRecord = {
        schemaVersion: 2, // Invalid version
        workspaceId: tempDir,
        result: 'positive',
        summary: 'Test',
        likelyRootCause: 'Test',
        relatedFiles: [],
        mode: 'hard-error',
        confidence: 0.5,
        bugDescription: 'Test'
      } as any;

      await expect(feedbackStore.save(invalidRecord)).rejects.toThrow();
    });

    it('should reject records with missing required fields', async () => {
      const invalidRecord = {
        schemaVersion: 1,
        // Missing required fields
        result: 'positive'
      } as any;

      await expect(feedbackStore.save(invalidRecord)).rejects.toThrow();
    });

    it('should reject records that are too large', async () => {
      const largeRecord: Omit<FeedbackRecord, 'id' | 'timestamp'> = {
        schemaVersion: 1,
        workspaceId: tempDir,
        result: 'positive',
        summary: 'x'.repeat(20000), // Very large summary
        likelyRootCause: 'Test',
        relatedFiles: [],
        mode: 'hard-error',
        confidence: 0.5,
        bugDescription: 'Test'
      };

      await expect(feedbackStore.save(largeRecord)).rejects.toThrow();
    });
  });

  describe('File Size Limits', () => {
    it('should enforce maximum file size', async () => {
      const smallStore = new FeedbackStore(tempDir, { maxFileSizeBytes: 1000 });

      // Create a record that would exceed the limit
      const largeRecord: Omit<FeedbackRecord, 'id' | 'timestamp'> = {
        schemaVersion: 1,
        workspaceId: tempDir,
        result: 'positive',
        summary: 'x'.repeat(500),
        likelyRootCause: 'x'.repeat(500),
        relatedFiles: [],
        mode: 'hard-error',
        confidence: 0.5,
        bugDescription: 'x'.repeat(500)
      };

      await expect(smallStore.save(largeRecord)).rejects.toThrow('exceed max size');
    });
  });

  describe('Statistics', () => {
    it('should provide accurate statistics', async () => {
      const record: Omit<FeedbackRecord, 'id' | 'timestamp'> = {
        schemaVersion: 1,
        workspaceId: tempDir,
        result: 'positive',
        summary: 'Test',
        likelyRootCause: 'Test',
        relatedFiles: [],
        mode: 'hard-error',
        confidence: 0.5,
        bugDescription: 'Test'
      };

      await feedbackStore.save(record);

      const stats = feedbackStore.getStats();
      expect(stats.totalRecords).toBe(1);
      expect(stats.fileSize).toBeGreaterThan(0);
      expect(stats.newestRecord).toBeDefined();
      expect(stats.oldestRecord).toBeDefined();
    });
  });
});
