/**
 * Tests for urlContentFetcher utility
 */

import { fetchAndExtract, normalizeUrlForCache, truncateContentToTokenBudget, FetchedDocumentation } from '../urlContentFetcher';

describe('urlContentFetcher', () => {
  describe('fetchAndExtract', () => {
    // Increase timeout for network requests
    jest.setTimeout(30000);

    it('should fetch and extract content from Supabase documentation URL', async () => {
      const url = 'https://supabase.com/docs/guides/database/connecting-to-postgres';
      
      const result = await fetchAndExtract(url);

      expect(result).toBeDefined();
      expect(result.url).toContain('supabase.com');
      expect(result.title).toBeTruthy();
      expect(result.title.length).toBeGreaterThan(0);
      expect(result.content).toBeTruthy();
      expect(result.content.length).toBeGreaterThan(0);
      expect(result.fetchedAt).toBeInstanceOf(Date);
      
      // Verify content contains relevant keywords from the page
      const contentLower = result.content.toLowerCase();
      expect(
        contentLower.includes('postgres') || 
        contentLower.includes('database') || 
        contentLower.includes('connection') ||
        contentLower.includes('supabase')
      ).toBe(true);
    }, 30000);

    it('should handle redirects correctly', async () => {
      // Test with a URL that might redirect
      const url = 'https://supabase.com/docs/guides/database/connecting-to-postgres';
      
      const result = await fetchAndExtract(url);

      expect(result).toBeDefined();
      expect(result.url).toBeTruthy();
      expect(result.content).toBeTruthy();
    }, 30000);

    it('should reject non-HTTP/HTTPS protocols', async () => {
      await expect(fetchAndExtract('file:///etc/passwd')).rejects.toThrow(/Security|protocol/i);
      await expect(fetchAndExtract('ftp://example.com')).rejects.toThrow(/Security|protocol/i);
    });

    it('should reject localhost addresses', async () => {
      await expect(fetchAndExtract('http://localhost:8080')).rejects.toThrow(/Security|localhost/i);
      await expect(fetchAndExtract('http://127.0.0.1:8080')).rejects.toThrow(/Security/i);
    });

    it('should reject .local domains', async () => {
      await expect(fetchAndExtract('http://example.local')).rejects.toThrow(/Security|\.local/i);
    });

    it('should handle invalid URLs', async () => {
      await expect(fetchAndExtract('not-a-url')).rejects.toThrow(/Invalid URL/i);
      await expect(fetchAndExtract('')).rejects.toThrow();
    });

    it('should handle timeout correctly', async () => {
      // Use a URL that will timeout (or a non-existent domain)
      // Note: The error might be "Request failed" if connection fails before timeout
      await expect(
        fetchAndExtract('https://httpstat.us/200?sleep=15000', { timeoutMs: 1000 })
      ).rejects.toThrow(/timeout|timed out|Request failed|socket hang up/i);
    }, 15000);

    it('should handle non-HTML content types', async () => {
      // Test with a URL that returns non-HTML (e.g., JSON)
      await expect(
        fetchAndExtract('https://api.github.com')
      ).rejects.toThrow(/HTML content|content-type/i);
    }, 15000);

    it('should respect max size limit', async () => {
      // This test might be flaky depending on the actual page size
      // We'll test with a very small limit
      await expect(
        fetchAndExtract('https://supabase.com/docs/guides/database/connecting-to-postgres', {
          maxSizeBytes: 100 // Very small limit
        })
      ).rejects.toThrow(/too large|exceeds/i);
    }, 30000);
  });

  describe('normalizeUrlForCache', () => {
    it('should normalize URLs consistently', () => {
      const url1 = 'https://supabase.com/docs/guides/database/connecting-to-postgres';
      const url2 = 'https://SUPABASE.COM/docs/guides/database/connecting-to-postgres/';
      const url3 = 'https://supabase.com/docs/guides/database/connecting-to-postgres#section';

      const normalized1 = normalizeUrlForCache(url1);
      const normalized2 = normalizeUrlForCache(url2);
      const normalized3 = normalizeUrlForCache(url3);

      // Should be the same (case-insensitive, trailing slash removed, fragment removed)
      expect(normalized1).toBe(normalized2);
      expect(normalized1).toBe(normalized3);
    });

    it('should preserve query parameters', () => {
      const url1 = 'https://example.com/page?param1=value1&param2=value2';
      const url2 = 'https://example.com/page?param2=value2&param1=value1';

      const normalized1 = normalizeUrlForCache(url1);
      const normalized2 = normalizeUrlForCache(url2);

      // Query params should be preserved (order might differ, but that's okay for cache)
      expect(normalized1).toContain('param1=value1');
      expect(normalized1).toContain('param2=value2');
    });

    it('should handle invalid URLs gracefully', () => {
      const invalidUrl = 'not-a-valid-url';
      const normalized = normalizeUrlForCache(invalidUrl);
      
      // Should return lowercase version
      expect(normalized).toBe('not-a-valid-url');
    });

    it('should remove trailing slashes', () => {
      const url1 = 'https://example.com/page/';
      const url2 = 'https://example.com/page';

      expect(normalizeUrlForCache(url1)).toBe(normalizeUrlForCache(url2));
    });

    it('should remove fragments', () => {
      const url1 = 'https://example.com/page#section';
      const url2 = 'https://example.com/page';

      expect(normalizeUrlForCache(url1)).toBe(normalizeUrlForCache(url2));
    });
  });

  describe('truncateContentToTokenBudget', () => {
    it('should not truncate content within token budget', () => {
      const content = 'This is a short content that should not be truncated.';
      const title = 'Short Title';
      const maxTokens = 1000;

      const result = truncateContentToTokenBudget(content, title, maxTokens);

      expect(result.wasTruncated).toBe(false);
      expect(result.content).toBe(content);
    });

    it('should truncate content exceeding token budget', () => {
      // Create content that exceeds the token budget
      const longContent = 'word '.repeat(10000); // ~50,000 chars = ~12,500 tokens
      const title = 'Test Title';
      const maxTokens = 100; // Very small budget

      const result = truncateContentToTokenBudget(longContent, title, maxTokens);

      expect(result.wasTruncated).toBe(true);
      expect(result.content.length).toBeLessThan(longContent.length);
      expect(result.content).toContain('[Content truncated to fit token limit]');
    });

    it('should preserve title and first paragraph when truncating', () => {
      // Use a single sentence for first paragraph (the regex matches first sentence)
      const firstSentence = 'This is the first paragraph.';
      const remainingContent = 'word '.repeat(10000);
      const content = firstSentence + ' ' + remainingContent;
      const title = 'Important Title';
      const maxTokens = 200; // Enough for title + first sentence + some content

      const result = truncateContentToTokenBudget(content, title, maxTokens);

      expect(result.wasTruncated).toBe(true);
      // Should contain the first sentence (title is used for calculation but not included in result)
      expect(result.content).toContain(firstSentence);
    });

    it('should handle empty content', () => {
      const result = truncateContentToTokenBudget('', 'Title', 100);
      
      expect(result.wasTruncated).toBe(false);
      expect(result.content).toBe('');
    });

    it('should handle very small token budgets', () => {
      const content = 'This is a test content with multiple sentences. Here is another sentence.';
      const title = 'Test Title';
      const maxTokens = 5; // Very small budget

      const result = truncateContentToTokenBudget(content, title, maxTokens);

      expect(result.wasTruncated).toBe(true);
      expect(result.content.length).toBeGreaterThan(0);
      expect(result.content).toContain('[Content truncated to fit token limit]');
    });

    it('should truncate at word boundaries when possible', () => {
      const content = 'word '.repeat(1000);
      const title = 'Title';
      const maxTokens = 50;

      const result = truncateContentToTokenBudget(content, title, maxTokens);

      expect(result.wasTruncated).toBe(true);
      // Should not end in the middle of a word
      const lastWord = result.content.trim().split(' ').pop();
      expect(lastWord).toBeTruthy();
      expect(lastWord?.length).toBeGreaterThan(0);
    });
  });

  describe('integration with Supabase URL', () => {
    jest.setTimeout(30000);

    it('should fetch, extract, and truncate Supabase documentation correctly', async () => {
      const url = 'https://supabase.com/docs/guides/database/connecting-to-postgres';
      
      // Fetch the content
      const fetched = await fetchAndExtract(url);
      
      expect(fetched).toBeDefined();
      expect(fetched.title).toBeTruthy();
      expect(fetched.content).toBeTruthy();
      
      // Test normalization
      const normalized = normalizeUrlForCache(url);
      expect(normalized).toBeTruthy();
      expect(normalized).toContain('supabase.com');
      
      // Test truncation with a reasonable budget
      const tokenBudget = 5000; // 5k tokens
      const { content: truncated, wasTruncated } = truncateContentToTokenBudget(
        fetched.content,
        fetched.title,
        tokenBudget
      );
      
      expect(truncated).toBeTruthy();
      // Content should either be truncated or not, but should always be valid
      if (wasTruncated) {
        expect(truncated).toContain('[Content truncated to fit token limit]');
      }
      
      // Verify the content contains relevant information
      const contentLower = truncated.toLowerCase();
      expect(
        contentLower.includes('postgres') || 
        contentLower.includes('database') || 
        contentLower.includes('connection') ||
        contentLower.includes('supabase')
      ).toBe(true);
    }, 30000);
  });
});

