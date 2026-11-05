import { sanitizeErrorForUser, isRetryableFromErrorString } from '../errorSanitizer';

describe('sanitizeErrorForUser', () => {
  describe('network errors', () => {
    it.each([
      'exception TypeError: fetch failed sending request',
      'ECONNREFUSED 127.0.0.1:443',
      'getaddrinfo ENOTFOUND api.openai.com',
      'connect ETIMEDOUT 104.18.7.192:443',
      'read ECONNRESET',
      'Network error occurred',
    ])('should categorize "%s" as network', (raw) => {
      const result = sanitizeErrorForUser(raw);
      expect(result.category).toBe('network');
      expect(result.userMessage).toContain('network issue');
      expect(result.userMessage).not.toContain(raw);
    });
  });

  describe('rate limit errors', () => {
    it.each([
      'Rate limit exceeded for model gpt-4o',
      'Quota exceeded for project',
      'RESOURCE_EXHAUSTED: quota exceeded',
      'Error 429: Too Many Requests',
    ])('should categorize "%s" as rate_limit', (raw) => {
      const result = sanitizeErrorForUser(raw);
      expect(result.category).toBe('rate_limit');
      expect(result.userMessage).toContain('rate-limited');
    });
  });

  describe('server errors', () => {
    it.each([
      'Internal Server Error',
      'Bad Gateway',
      'Service Unavailable',
      'HTTP 502 error',
      'HTTP 503 error',
    ])('should categorize "%s" as server', (raw) => {
      const result = sanitizeErrorForUser(raw);
      expect(result.category).toBe('server');
      expect(result.userMessage).toContain('server issue');
    });
  });

  describe('auth errors', () => {
    it.each([
      'Invalid API key provided',
      'Unauthorized access',
      'Forbidden: insufficient permissions',
      'Error 401: Authentication required',
      'Error 403: Access denied',
    ])('should categorize "%s" as auth', (raw) => {
      const result = sanitizeErrorForUser(raw);
      expect(result.category).toBe('auth');
      expect(result.userMessage).toContain('authentication');
    });
  });

  describe('timeout errors', () => {
    it.each([
      'Request timeout after 60000ms',
      'DEADLINE_EXCEEDED: operation took too long',
    ])('should categorize "%s" as timeout', (raw) => {
      const result = sanitizeErrorForUser(raw);
      expect(result.category).toBe('timeout');
      expect(result.userMessage).toContain('timed out');
    });
  });

  describe('empty response errors', () => {
    it('should categorize empty response', () => {
      const result = sanitizeErrorForUser('LLM returned empty response');
      expect(result.category).toBe('empty_response');
      expect(result.userMessage).toContain('empty response');
    });
  });

  describe('unknown errors', () => {
    it('should categorize unrecognized errors as unknown', () => {
      const result = sanitizeErrorForUser('Something completely unexpected happened');
      expect(result.category).toBe('unknown');
      expect(result.userMessage).toContain('unexpected error');
    });

    it('should handle empty string', () => {
      const result = sanitizeErrorForUser('');
      expect(result.category).toBe('unknown');
    });
  });

  describe('free tier pass-through', () => {
    it('should pass through "Free tier limit reached" messages as-is', () => {
      const raw = 'Free tier limit reached. [Upgrade here](https://example.com)';
      const result = sanitizeErrorForUser(raw);
      expect(result.category).toBe('rate_limit');
      expect(result.userMessage).toBe(raw);
    });
  });

  describe('no raw error leakage', () => {
    it('should never expose raw technical error in user message for categorized errors', () => {
      const technicalErrors = [
        'exception TypeError: fetch failed sending request for https://generativelanguage.googleapis.com/...',
        'ECONNREFUSED 127.0.0.1:443',
        'Error 429: {"error":{"message":"Rate limit exceeded"}}',
      ];
      for (const raw of technicalErrors) {
        const result = sanitizeErrorForUser(raw);
        // User message should not contain the raw error text
        expect(result.userMessage).not.toBe(raw);
      }
    });
  });
});

describe('isRetryableFromErrorString', () => {
  describe('retryable errors', () => {
    it.each([
      'fetch failed',
      'ECONNREFUSED',
      'ETIMEDOUT',
      'timeout exceeded',
      'Internal Server Error',
      'Bad Gateway',
      'rate limit exceeded',
      'empty response from LLM',
    ])('should return true for "%s"', (msg) => {
      expect(isRetryableFromErrorString(msg)).toBe(true);
    });
  });

  describe('non-retryable errors', () => {
    it.each([
      'Invalid API key',
      'unauthorized',
      'Something completely unexpected',
      '',
    ])('should return false for "%s"', (msg) => {
      expect(isRetryableFromErrorString(msg)).toBe(false);
    });
  });
});
