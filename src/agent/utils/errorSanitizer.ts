/**
 * Error sanitizer utilities for LLM errors.
 *
 * Maps raw technical error strings to user-friendly messages and determines
 * whether an error is retryable based on pattern matching.
 */

export type ErrorCategory =
  | 'network'
  | 'rate_limit'
  | 'server'
  | 'auth'
  | 'timeout'
  | 'empty_response'
  | 'unknown';

export interface SanitizedError {
  category: ErrorCategory;
  userMessage: string;
}

const ERROR_PATTERNS: Array<{
  patterns: RegExp[];
  category: ErrorCategory;
  userMessage: string;
}> = [
  {
    patterns: [
      /fetch failed/i,
      /ECONNREFUSED/,
      /ENOTFOUND/,
      /ETIMEDOUT/,
      /ECONNRESET/,
      /network error/i,
    ],
    category: 'network',
    userMessage:
      'Unable to reach the AI service due to a network issue. Please check your internet connection and try again.',
  },
  {
    patterns: [
      /rate limit/i,
      /quota exceeded/i,
      /resource_exhausted/i,
      /\b429\b/,
    ],
    category: 'rate_limit',
    userMessage:
      'The AI service is temporarily rate-limited. Please wait a moment and try again.',
  },
  {
    patterns: [
      /internal server error/i,
      /bad gateway/i,
      /service unavailable/i,
      /\b50[0-9]\b/,
    ],
    category: 'server',
    userMessage:
      'The AI service encountered a temporary server issue. Please try again in a moment.',
  },
  {
    patterns: [/api key/i, /unauthorized/i, /forbidden/i, /\b401\b/, /\b403\b/],
    category: 'auth',
    userMessage:
      'There was an authentication issue with the AI service. Please verify your API key in settings.',
  },
  {
    patterns: [/empty response/i],
    category: 'empty_response',
    userMessage:
      'The AI service returned an empty response. Please try again.',
  },
  {
    patterns: [/timeout/i, /deadline_exceeded/i],
    category: 'timeout',
    userMessage:
      'The request to the AI service timed out. Please try again.',
  },
];

const RETRYABLE_CATEGORIES: Set<ErrorCategory> = new Set([
  'network',
  'rate_limit',
  'server',
  'timeout',
  'empty_response',
]);

/**
 * Maps a raw error string to a user-friendly message with category.
 */
export function sanitizeErrorForUser(rawError: string): SanitizedError {
  if (!rawError) {
    return {
      category: 'unknown',
      userMessage:
        'An unexpected error occurred while communicating with the AI service. Please try again.',
    };
  }

  for (const entry of ERROR_PATTERNS) {
    for (const pattern of entry.patterns) {
      if (pattern.test(rawError)) {
        return { category: entry.category, userMessage: entry.userMessage };
      }
    }
  }

  return {
    category: 'unknown',
    userMessage:
      'An unexpected error occurred while communicating with the AI service. Please try again.',
  };
}

/**
 * Determines if an error is retryable based on pattern matching of the error
 * string. This is a fallback for when `LLMError.retryable` is unavailable
 * (i.e., when `response.payload` is undefined).
 *
 * Retries: network, timeout, server, rate_limit, empty_response.
 * Does NOT retry: auth, unknown.
 */
export function isRetryableFromErrorString(errorMsg: string): boolean {
  const { category } = sanitizeErrorForUser(errorMsg);
  return RETRYABLE_CATEGORIES.has(category);
}
