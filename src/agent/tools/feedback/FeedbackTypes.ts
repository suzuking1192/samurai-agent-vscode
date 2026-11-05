/**
 * Type definitions for the Human Feedback Learning System
 * 
 * Defines interfaces for feedback records, outcomes, and retrieval parameters
 */

export type FeedbackOutcome = 'positive' | 'partial' | 'negative';
export type FeedbackMode = 'hard-error' | 'soft-error' | 'behavior-first';

/**
 * Core feedback record interface
 * Captures user feedback on debugging analyses with hypothesis-specific tracking
 */
export interface FeedbackRecord {
  schemaVersion: 1;
  id: string;
  workspaceId: string;
  timestamp: number;
  result: FeedbackOutcome;
  summary: string;
  likelyRootCause: string;
  relatedFiles: string[];
  mode: FeedbackMode;
  confidence: number;
  bugDescription: string;
  
  // Hypothesis-specific tracking
  hypothesisId?: string;
  recommendedFixSnippet?: string;
  effect?: 'fixed' | 'mitigated' | 'unrelated';
  reproTag?: string; // User label for similar issues
  commitHashAtFeedback?: string; // Git commit at feedback time
  
  // Optional user note
  note?: string; // Max 180 chars, sanitized
}

/**
 * Input parameters for feedback retrieval
 */
export interface FeedbackRetrievalInput {
  bugDescription: string;
  relatedFiles: string[];
  mode: FeedbackMode;
  topK?: number;
}

/**
 * Scored feedback record for retrieval results
 */
export interface ScoredFeedbackRecord extends FeedbackRecord {
  score: number;
  daysSince: number;
}

/**
 * Feedback collection payload from frontend
 */
export interface FeedbackPayload {
  reportId: string;
  result: FeedbackOutcome;
  summary: string;
  likelyRootCause: string;
  relatedFiles: string[];
  mode: FeedbackMode;
  confidence: number;
  bugDescription: string;
  hypothesisId?: string;
  recommendedFixSnippet?: string;
  effect?: 'fixed' | 'mitigated' | 'unrelated';
  reproTag?: string;
  note?: string;
}

/**
 * Feedback store configuration
 */
export interface FeedbackStoreConfig {
  maxEntries: number;
  maxFileSizeBytes: number;
  maxRecordSizeBytes: number;
  lockTimeoutMs: number;
}

/**
 * Default configuration for feedback store
 */
export const DEFAULT_FEEDBACK_CONFIG: FeedbackStoreConfig = {
  maxEntries: 500,
  maxFileSizeBytes: 2 * 1024 * 1024, // 2 MB
  maxRecordSizeBytes: 10 * 1024, // 10 KB
  lockTimeoutMs: 5000, // 5 seconds
};

/**
 * Field weights for similarity scoring
 */
export interface FeedbackFieldWeights {
  relatedFiles: number;
  bugDescription: number;
  likelyRootCause: number;
  mode: number;
  reproTag: number;
}

/**
 * Default field weights for BM25-style scoring
 */
export const DEFAULT_FIELD_WEIGHTS: FeedbackFieldWeights = {
  relatedFiles: 0.6,
  bugDescription: 0.25,
  likelyRootCause: 0.1,
  mode: 0.05,
  reproTag: 0.15, // Bonus weight
};

/**
 * Outcome weights for scoring
 */
export const OUTCOME_WEIGHTS: Record<FeedbackOutcome, number> = {
  positive: 1.0,
  partial: 0.5,
  negative: 0.2,
};

/**
 * Secret patterns for redaction
 */
export const SECRET_PATTERNS = {
  apiKey: /[A-Za-z0-9_-]{20,}/g,
  token: /token[=:]\s*[A-Za-z0-9_-]+/gi,
  password: /password[=:]\s*\S+/gi,
} as const;
