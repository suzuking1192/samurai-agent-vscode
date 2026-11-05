/**
 * Feedback collection, validation, and sanitization logic
 * 
 * Handles user feedback collection with privacy protection and data validation
 */

import * as path from 'path';
import { FeedbackStore } from './FeedbackStore';
import { 
  FeedbackRecord, 
  FeedbackPayload, 
  FeedbackOutcome,
  SECRET_PATTERNS 
} from './FeedbackTypes';

export class FeedbackCollector {
  constructor(
    private readonly feedbackStore: FeedbackStore,
    private readonly workspaceRoot: string
  ) {}

  /**
   * Sanitizes a file path to be workspace-relative
   */
  private sanitizeFilePath(filePath: string): string {
    if (!filePath) {
      return '';
    }

    // Convert to absolute path if relative
    const absolutePath = path.isAbsolute(filePath) 
      ? filePath 
      : path.resolve(this.workspaceRoot, filePath);

    // Make relative to workspace root
    const relativePath = path.relative(this.workspaceRoot, absolutePath);
    
    // Ensure it's not outside workspace (security check)
    if (relativePath.startsWith('..') || path.isAbsolute(relativePath)) {
      return path.basename(filePath); // Fallback to just filename
    }

    return relativePath;
  }

  /**
   * Sanitizes an array of file paths
   */
  private sanitizeFilePaths(filePaths: string[]): string[] {
    return filePaths
      .map(fp => this.sanitizeFilePath(fp))
      .filter(fp => fp.length > 0);
  }

  /**
   * Redacts secrets from text using regex patterns
   */
  private redactSecrets(text: string): string {
    if (!text || typeof text !== 'string') {
      return '';
    }

    let redacted = text;

    // Redact API keys
    redacted = redacted.replace(SECRET_PATTERNS.apiKey, '[REDACTED_API_KEY]');
    
    // Redact tokens
    redacted = redacted.replace(SECRET_PATTERNS.token, 'token=[REDACTED]');
    
    // Redact passwords
    redacted = redacted.replace(SECRET_PATTERNS.password, 'password=[REDACTED]');

    return redacted;
  }

  /**
   * Truncates text to specified length
   */
  private truncateText(text: string, maxLength: number): string {
    if (!text || typeof text !== 'string') {
      return '';
    }

    if (text.length <= maxLength) {
      return text;
    }

    return text.substring(0, maxLength - 3) + '...';
  }

  /**
   * Validates and sanitizes a feedback payload
   */
  private validateAndSanitizePayload(payload: FeedbackPayload): Omit<FeedbackRecord, 'id' | 'timestamp'> {
    // Validate required fields
    if (!payload.reportId || !payload.result || !payload.summary || !payload.likelyRootCause) {
      throw new Error('Missing required feedback fields');
    }

    // Validate result enum
    if (!['positive', 'partial', 'negative'].includes(payload.result)) {
      throw new Error('Invalid feedback result');
    }

    // Validate mode enum
    if (!['hard-error', 'soft-error', 'behavior-first'].includes(payload.mode)) {
      throw new Error('Invalid feedback mode');
    }

    // Validate confidence range
    if (typeof payload.confidence !== 'number' || payload.confidence < 0 || payload.confidence > 1) {
      throw new Error('Invalid confidence value');
    }

    // Validate relatedFiles array
    if (!Array.isArray(payload.relatedFiles) || payload.relatedFiles.length === 0) {
      throw new Error('Related files array cannot be empty');
    }

    // Sanitize file paths
    const sanitizedFiles = this.sanitizeFilePaths(payload.relatedFiles || []);

    // Sanitize and truncate text fields
    const sanitizedSummary = this.redactSecrets(
      this.truncateText(payload.summary, 500)
    );
    
    const sanitizedRootCause = this.redactSecrets(
      this.truncateText(payload.likelyRootCause, 500)
    );
    
    const sanitizedBugDescription = this.redactSecrets(
      this.truncateText(payload.bugDescription || '', 500)
    );

    const sanitizedNote = payload.note 
      ? this.redactSecrets(this.truncateText(payload.note, 180))
      : undefined;

    const sanitizedFixSnippet = payload.recommendedFixSnippet
      ? this.redactSecrets(this.truncateText(payload.recommendedFixSnippet, 200))
      : undefined;

    // Validate effect enum if provided
    if (payload.effect && !['fixed', 'mitigated', 'unrelated'].includes(payload.effect)) {
      throw new Error('Invalid effect value');
    }

    return {
      schemaVersion: 1,
      workspaceId: this.workspaceRoot, // Use workspace root as ID
      result: payload.result as FeedbackOutcome,
      summary: sanitizedSummary,
      likelyRootCause: sanitizedRootCause,
      relatedFiles: sanitizedFiles,
      mode: payload.mode,
      confidence: payload.confidence,
      bugDescription: sanitizedBugDescription,
      hypothesisId: payload.hypothesisId,
      recommendedFixSnippet: sanitizedFixSnippet,
      effect: payload.effect,
      reproTag: payload.reproTag ? this.truncateText(payload.reproTag, 50) : undefined,
      note: sanitizedNote,
    };
  }

  /**
   * Records user feedback
   */
  async record(payload: FeedbackPayload, commitHash?: string): Promise<void> {
    try {
      // Validate and sanitize the payload
      const sanitizedRecord = this.validateAndSanitizePayload(payload);
      
      // Add commit hash if provided
      if (commitHash) {
        (sanitizedRecord as any).commitHashAtFeedback = commitHash;
      }

      // Save to store
      await this.feedbackStore.save(sanitizedRecord);
      
      console.log('[FeedbackCollector] Successfully recorded feedback:', {
        result: payload.result,
        mode: payload.mode,
        filesCount: sanitizedRecord.relatedFiles.length,
        hasNote: !!sanitizedRecord.note,
        hasReproTag: !!sanitizedRecord.reproTag,
      });

    } catch (error) {
      console.error('[FeedbackCollector] Failed to record feedback:', error);
      throw error;
    }
  }

  /**
   * Gets feedback statistics for the workspace
   */
  getStats(): {
    totalRecords: number;
    positiveRatio: number;
    partialRatio: number;
    negativeRatio: number;
    fileSize: number;
  } {
    const records = this.feedbackStore.loadForWorkspace(this.workspaceRoot);
    const stats = this.feedbackStore.getStats();
    
    const positiveCount = records.filter(r => r.result === 'positive').length;
    const partialCount = records.filter(r => r.result === 'partial').length;
    const negativeCount = records.filter(r => r.result === 'negative').length;
    const totalCount = records.length;

    return {
      totalRecords: totalCount,
      positiveRatio: totalCount > 0 ? positiveCount / totalCount : 0,
      partialRatio: totalCount > 0 ? partialCount / totalCount : 0,
      negativeRatio: totalCount > 0 ? negativeCount / totalCount : 0,
      fileSize: stats.fileSize,
    };
  }

  /**
   * Clears all feedback for the workspace
   */
  async clear(): Promise<void> {
    await this.feedbackStore.clear();
  }

  /**
   * Rotates old feedback records
   */
  async rotate(): Promise<void> {
    await this.feedbackStore.rotate();
  }
}
