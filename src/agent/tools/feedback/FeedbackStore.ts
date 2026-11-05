/**
 * Atomic JSON-based storage for feedback records
 * 
 * Provides safe, concurrent-write-resistant storage with lock file mechanism
 * and automatic rotation of old feedback records.
 */

import * as fs from 'fs';
import * as path from 'path';
import { randomUUID } from 'crypto';
import { 
  FeedbackRecord, 
  FeedbackStoreConfig, 
  DEFAULT_FEEDBACK_CONFIG 
} from './FeedbackTypes';

export class FeedbackStore {
  private readonly config: FeedbackStoreConfig;
  private readonly feedbackFilePath: string;
  private readonly lockFilePath: string;
  private readonly tempFilePath: string;

  constructor(
    private readonly workspaceRoot: string,
    config: Partial<FeedbackStoreConfig> = {}
  ) {
    this.config = { ...DEFAULT_FEEDBACK_CONFIG, ...config };
    this.feedbackFilePath = path.join(workspaceRoot, '.vscode', 'samurai-agent', 'feedback.json');
    this.lockFilePath = path.join(workspaceRoot, '.vscode', 'samurai-agent', 'feedback.json.lock');
    this.tempFilePath = path.join(workspaceRoot, '.vscode', 'samurai-agent', 'feedback.json.tmp');
    
    this.ensureDataDirectory();
  }

  /**
   * Ensures the data directory exists
   */
  private ensureDataDirectory(): void {
    const dataDir = path.dirname(this.feedbackFilePath);
    if (!fs.existsSync(dataDir)) {
      fs.mkdirSync(dataDir, { recursive: true });
    }
  }

  /**
   * Acquires a lock file with timeout
   */
  private async acquireLock(): Promise<void> {
    const startTime = Date.now();
    
    while (Date.now() - startTime < this.config.lockTimeoutMs) {
      try {
        // Try to create lock file exclusively
        const fd = fs.openSync(this.lockFilePath, 'wx');
        fs.closeSync(fd);
        return;
      } catch (error) {
        // Lock file exists, wait a bit
        await new Promise(resolve => setTimeout(resolve, 100));
      }
    }
    
    throw new Error(`Failed to acquire lock within ${this.config.lockTimeoutMs}ms`);
  }

  /**
   * Releases the lock file
   */
  private releaseLock(): void {
    try {
      if (fs.existsSync(this.lockFilePath)) {
        fs.unlinkSync(this.lockFilePath);
      }
    } catch (error) {
      console.warn('Failed to release lock file:', error);
    }
  }

  /**
   * Validates a feedback record
   */
  private validateRecord(record: any): record is FeedbackRecord {
    if (!record || typeof record !== 'object') {
      return false;
    }

    // Check required fields
    const requiredFields = [
      'schemaVersion', 'id', 'workspaceId', 'timestamp', 'result',
      'summary', 'likelyRootCause', 'relatedFiles', 'mode', 'confidence', 'bugDescription'
    ];

    for (const field of requiredFields) {
      if (!(field in record)) {
        return false;
      }
    }

    // Validate schema version
    if (record.schemaVersion !== 1) {
      return false;
    }

    // Validate types
    if (typeof record.id !== 'string' || 
        typeof record.workspaceId !== 'string' ||
        typeof record.timestamp !== 'number' ||
        typeof record.summary !== 'string' ||
        typeof record.likelyRootCause !== 'string' ||
        !Array.isArray(record.relatedFiles) ||
        typeof record.mode !== 'string' ||
        typeof record.confidence !== 'number' ||
        typeof record.bugDescription !== 'string') {
      return false;
    }

    // Validate result enum
    if (!['positive', 'partial', 'negative'].includes(record.result)) {
      return false;
    }

    // Validate mode enum
    if (!['hard-error', 'soft-error', 'behavior-first'].includes(record.mode)) {
      return false;
    }

    // Check record size
    const recordSize = JSON.stringify(record).length;
    if (recordSize > this.config.maxRecordSizeBytes) {
      return false;
    }

    return true;
  }

  /**
   * Loads feedback records from file with corruption tolerance
   */
  private loadRecords(): FeedbackRecord[] {
    if (!fs.existsSync(this.feedbackFilePath)) {
      return [];
    }

    try {
      const data = fs.readFileSync(this.feedbackFilePath, 'utf8');
      const records = JSON.parse(data);
      
      if (!Array.isArray(records)) {
        console.warn('Feedback file does not contain array, returning empty');
        return [];
      }

      // Filter valid records, tolerate partial corruption
      const validRecords = records.filter(record => this.validateRecord(record));
      
      if (validRecords.length !== records.length) {
        console.warn(`Filtered out ${records.length - validRecords.length} invalid feedback records`);
      }

      return validRecords;
    } catch (error) {
      console.error('Failed to load feedback records:', error);
      return [];
    }
  }

  /**
   * Saves feedback records to file atomically
   */
  private saveRecords(records: FeedbackRecord[]): void {
    try {
      // Sort by timestamp descending (most recent first)
      const sortedRecords = records.sort((a, b) => b.timestamp - a.timestamp);
      
      // Write to temp file
      const data = JSON.stringify(sortedRecords, null, 2);
      fs.writeFileSync(this.tempFilePath, data, 'utf8');
      
      // Check file size
      const stats = fs.statSync(this.tempFilePath);
      if (stats.size > this.config.maxFileSizeBytes) {
        throw new Error(`Feedback file would exceed max size: ${stats.size} > ${this.config.maxFileSizeBytes}`);
      }
      
      // Atomic rename
      fs.renameSync(this.tempFilePath, this.feedbackFilePath);
    } catch (error) {
      // Cleanup temp file on error
      try {
        if (fs.existsSync(this.tempFilePath)) {
          fs.unlinkSync(this.tempFilePath);
        }
      } catch (cleanupError) {
        console.warn('Failed to cleanup temp file:', cleanupError);
      }
      throw error;
    }
  }

  /**
   * Rotates feedback records to keep only the most recent N entries
   */
  private rotateRecords(records: FeedbackRecord[]): FeedbackRecord[] {
    if (records.length <= this.config.maxEntries) {
      return records;
    }

    // Keep most recent entries
    const sortedRecords = records.sort((a, b) => b.timestamp - a.timestamp);
    return sortedRecords.slice(0, this.config.maxEntries);
  }

  /**
   * Saves a feedback record
   */
  async save(record: Omit<FeedbackRecord, 'id' | 'timestamp'>): Promise<void> {
    await this.acquireLock();
    
    try {
      // Load existing records
      const existingRecords = this.loadRecords();
      
      // Create new record with ID and timestamp
      const newRecord: FeedbackRecord = {
        ...record,
        id: randomUUID(),
        timestamp: Date.now(),
      };
      
      // Validate the new record
      if (!this.validateRecord(newRecord)) {
        throw new Error('Invalid feedback record');
      }
      
      // Add new record and rotate
      const updatedRecords = this.rotateRecords([...existingRecords, newRecord]);
      
      // Save atomically
      this.saveRecords(updatedRecords);
      
    } finally {
      this.releaseLock();
    }
  }

  /**
   * Loads all feedback records
   */
  load(): FeedbackRecord[] {
    return this.loadRecords();
  }

  /**
   * Loads feedback records for a specific workspace
   */
  loadForWorkspace(workspaceId: string): FeedbackRecord[] {
    const allRecords = this.loadRecords();
    return allRecords.filter(record => record.workspaceId === workspaceId);
  }

  /**
   * Rotates feedback records (removes old entries)
   */
  async rotate(): Promise<void> {
    await this.acquireLock();
    
    try {
      const records = this.loadRecords();
      const rotatedRecords = this.rotateRecords(records);
      
      if (rotatedRecords.length !== records.length) {
        this.saveRecords(rotatedRecords);
        console.log(`Rotated feedback records: ${records.length} -> ${rotatedRecords.length}`);
      }
    } finally {
      this.releaseLock();
    }
  }

  /**
   * Clears all feedback records
   */
  async clear(): Promise<void> {
    await this.acquireLock();
    
    try {
      if (fs.existsSync(this.feedbackFilePath)) {
        fs.unlinkSync(this.feedbackFilePath);
      }
    } finally {
      this.releaseLock();
    }
  }

  /**
   * Gets storage statistics
   */
  getStats(): {
    totalRecords: number;
    fileSize: number;
    oldestRecord?: number;
    newestRecord?: number;
  } {
    const records = this.loadRecords();
    const fileSize = fs.existsSync(this.feedbackFilePath) 
      ? fs.statSync(this.feedbackFilePath).size 
      : 0;
    
    const timestamps = records.map(r => r.timestamp);
    
    return {
      totalRecords: records.length,
      fileSize,
      oldestRecord: timestamps.length > 0 ? Math.min(...timestamps) : undefined,
      newestRecord: timestamps.length > 0 ? Math.max(...timestamps) : undefined,
    };
  }
}
