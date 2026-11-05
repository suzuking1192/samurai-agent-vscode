/**
 * URL Content Fetcher Utility
 * 
 * Fetches and extracts text content from URLs with:
 * - SSRF protection (DNS resolution, IP validation, redirect protection)
 * - Content-type validation
 * - Readability-style content extraction
 * - Streaming size limits (10MB decompressed)
 * - Timeout protection (10 seconds)
 */

import * as http from 'http';
import * as https from 'https';
import * as zlib from 'zlib';
import * as dns from 'dns';
import { URL } from 'url';
import { estimateTokenCountFromString } from '../../common/utils/tokenEstimator';

export interface FetchedDocumentation {
  url: string;
  title: string;
  content: string;
  fetchedAt: Date;
}

export interface FetchOptions {
  maxSizeBytes?: number;
  timeoutMs?: number;
  maxRedirects?: number;
}

const DEFAULT_OPTIONS: Required<FetchOptions> = {
  maxSizeBytes: 10 * 1024 * 1024, // 10MB
  timeoutMs: 10000, // 10 seconds
  maxRedirects: 5
};

/**
 * Check if an IP address is private, localhost, or link-local
 */
function isPrivateOrLocalhostIP(ip: string): boolean {
  // IPv4 localhost
  if (ip === '127.0.0.1' || ip === '0.0.0.0') {
    return true;
  }

  // IPv6 localhost
  if (ip === '::1' || ip === '::' || ip.startsWith('::ffff:127.')) {
    return true;
  }

  // Cloud metadata endpoint
  if (ip === '169.254.169.254') {
    return true;
  }

  // IPv4 private ranges
  const parts = ip.split('.');
  if (parts.length === 4) {
    const [a, b, c, d] = parts.map(Number);
    
    // 10.0.0.0/8
    if (a === 10) return true;
    
    // 172.16.0.0/12
    if (a === 172 && b >= 16 && b <= 31) return true;
    
    // 192.168.0.0/16
    if (a === 192 && b === 168) return true;
    
    // 169.254.0.0/16 (link-local)
    if (a === 169 && b === 254) return true;
  }

  return false;
}

/**
 * Resolve hostname to IP address
 */
function resolveHostname(hostname: string): Promise<string> {
  return new Promise((resolve, reject) => {
    dns.lookup(hostname, { family: 4 }, (err: NodeJS.ErrnoException | null, address: string) => {
      if (err) {
        reject(new Error(`DNS resolution failed: ${err.message}`));
      } else {
        resolve(address);
      }
    });
  });
}

/**
 * Validate URL for SSRF protection
 */
async function validateUrlForSSRF(url: URL): Promise<void> {
  // Protocol validation
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error(`Security: Only http:// and https:// protocols are allowed`);
  }

  // Block .local domains
  if (url.hostname.endsWith('.local')) {
    throw new Error(`Security: .local domains are not allowed`);
  }

  // Block localhost hostname
  const hostnameLower = url.hostname.toLowerCase();
  if (hostnameLower === 'localhost' || hostnameLower.startsWith('localhost.')) {
    throw new Error(`Security: localhost addresses are blocked`);
  }

  // Resolve DNS and check IP
  try {
    const resolvedIP = await resolveHostname(url.hostname);
    if (isPrivateOrLocalhostIP(resolvedIP)) {
      throw new Error(`Security: This URL resolves to a private/localhost IP address (${resolvedIP})`);
    }
  } catch (error: any) {
    if (error.message?.includes('Security:')) {
      throw error;
    }
    throw new Error(`Security: DNS resolution failed or resolved to blocked IP: ${error.message}`);
  }
}

/**
 * Normalize URL for cache key (preserve query params)
 */
export function normalizeUrlForCache(urlString: string): string {
  try {
    const url = new URL(urlString);
    // Lowercase hostname
    url.hostname = url.hostname.toLowerCase();
    // Remove trailing slash from pathname
    url.pathname = url.pathname.replace(/\/$/, '');
    // Remove fragment
    url.hash = '';
    // Preserve query parameters
    return url.toString();
  } catch {
    return urlString.toLowerCase();
  }
}

/**
 * Check if content-type is allowed
 */
function isAllowedContentType(contentType: string | undefined): boolean {
  if (!contentType) return false;
  
  const lower = contentType.toLowerCase();
  return (
    lower.includes('text/html') ||
    lower.includes('application/xhtml+xml') ||
    lower.includes('text/plain')
  );
}

/**
 * Extract title from HTML
 */
function extractTitle(html: string): string {
  // Try <title> tag
  const titleMatch = html.match(/<title[^>]*>([^<]+)<\/title>/i);
  if (titleMatch && titleMatch[1]) {
    return titleMatch[1].trim();
  }

  // Try <h1> tag
  const h1Match = html.match(/<h1[^>]*>([^<]+)<\/h1>/i);
  if (h1Match && h1Match[1]) {
    return h1Match[1].trim();
  }

  return 'Untitled';
}

/**
 * Simple readability-style extraction (MVP heuristic)
 * Extracts main content from HTML by looking for semantic tags
 */
function extractMainContent(html: string): string {
  // Remove script and style tags
  let content = html.replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '');
  content = content.replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '');

  // Try to find main content in semantic tags
  const semanticSelectors = [
    /<article[^>]*>([\s\S]*?)<\/article>/i,
    /<main[^>]*>([\s\S]*?)<\/main>/i,
    /<div[^>]*class="[^"]*content[^"]*"[^>]*>([\s\S]*?)<\/div>/i,
    /<div[^>]*id="[^"]*content[^"]*"[^>]*>([\s\S]*?)<\/div>/i
  ];

  for (const selector of semanticSelectors) {
    const match = content.match(selector);
    if (match && match[1]) {
      content = match[1];
      break;
    }
  }

  // Remove common navigation/footer/sidebar patterns
  const removePatterns = [
    /<nav[^>]*>[\s\S]*?<\/nav>/gi,
    /<footer[^>]*>[\s\S]*?<\/footer>/gi,
    /<aside[^>]*>[\s\S]*?<\/aside>/gi,
    /<header[^>]*>[\s\S]*?<\/header>/gi,
    /<div[^>]*class="[^"]*(?:nav|footer|sidebar|header|menu)[^"]*"[^>]*>[\s\S]*?<\/div>/gi
  ];

  for (const pattern of removePatterns) {
    content = content.replace(pattern, '');
  }

  // Strip all HTML tags
  content = content.replace(/<[^>]+>/g, ' ');

  // Decode HTML entities
  content = content
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&[#\w]+;/g, ' ');

  // Collapse whitespace
  content = content.replace(/\s+/g, ' ').trim();

  return content;
}

/**
 * Fetch URL with SSRF protection and redirect handling
 */
async function fetchWithRedirects(
  url: URL,
  options: Required<FetchOptions>,
  redirectCount: number = 0
): Promise<{ body: Buffer; contentType: string; finalUrl: URL }> {
  if (redirectCount > options.maxRedirects) {
    throw new Error(`Too many redirects (max ${options.maxRedirects} allowed)`);
  }

  // Validate URL for SSRF
  await validateUrlForSSRF(url);

  return new Promise((resolve, reject) => {
    const protocol = url.protocol === 'https:' ? https : http;
    let chunks: Buffer[] = [];
    let totalSize = 0;
    let contentType = '';

    const requestOptions = {
      hostname: url.hostname,
      port: url.port || (url.protocol === 'https:' ? 443 : 80),
      path: url.pathname + url.search,
      method: 'GET',
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; SamuraiAgent/1.0)',
        'Accept': 'text/html,application/xhtml+xml,text/plain',
        'Accept-Encoding': 'gzip, deflate'
      },
      timeout: options.timeoutMs
    };

    const req = protocol.request(requestOptions, (res) => {
      contentType = res.headers['content-type'] || '';

      // Handle redirects
      if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400) {
        const location = res.headers.location;
        if (location) {
          res.destroy();
          try {
            const redirectUrl = new URL(location, url.toString());
            // Re-validate after redirect
            fetchWithRedirects(redirectUrl, options, redirectCount + 1)
              .then(resolve)
              .catch(reject);
            return;
          } catch (error: any) {
            reject(new Error(`Invalid redirect URL: ${error.message}`));
            return;
          }
        }
      }

      // Check content-type
      if (!isAllowedContentType(contentType)) {
        res.destroy();
        reject(new Error(`URL does not return HTML content (content-type: ${contentType || 'unknown'})`));
        return;
      }

      // Handle compression
      let stream: NodeJS.ReadableStream = res;
      const encoding = res.headers['content-encoding'];
      if (encoding === 'gzip') {
        stream = res.pipe(zlib.createGunzip());
      } else if (encoding === 'deflate') {
        stream = res.pipe(zlib.createInflate());
      }

      // Stream with size limit
      stream.on('data', (chunk: Buffer) => {
        totalSize += chunk.length;
        if (totalSize > options.maxSizeBytes) {
          (stream as any).destroy();
          reject(new Error(`Response too large (exceeds ${options.maxSizeBytes} bytes)`));
          return;
        }
        chunks.push(chunk);
      });

      stream.on('end', () => {
        const body = Buffer.concat(chunks);
        resolve({ body, contentType, finalUrl: url });
      });

      stream.on('error', (error: Error) => {
        reject(new Error(`Stream error: ${error.message}`));
      });
    });

    req.on('error', (error: Error) => {
      reject(new Error(`Request failed: ${error.message}`));
    });

    req.on('timeout', () => {
      req.destroy();
      reject(new Error(`Request timed out after ${options.timeoutMs}ms`));
    });

    req.end();
  });
}

/**
 * Fetch and extract text content from a URL
 */
export async function fetchAndExtract(
  urlString: string,
  options: FetchOptions = {}
): Promise<FetchedDocumentation> {
  const opts = { ...DEFAULT_OPTIONS, ...options };

  // Parse and validate URL
  let url: URL;
  try {
    url = new URL(urlString);
  } catch (error: any) {
    throw new Error(`Invalid URL format: ${error.message}`);
  }

  // Fetch with redirects and SSRF protection
  const { body, contentType, finalUrl } = await fetchWithRedirects(url, opts);

  // Convert to string
  const html = body.toString('utf-8');

  // Extract title
  const title = extractTitle(html);

  // Extract main content
  const content = extractMainContent(html);

  if (!content || content.trim().length === 0) {
    throw new Error('No content could be extracted from the page');
  }

  return {
    url: finalUrl.toString(),
    title,
    content,
    fetchedAt: new Date()
  };
}

/**
 * Truncate content to fit token budget
 */
export function truncateContentToTokenBudget(
  content: string,
  title: string,
  maxTokens: number
): { content: string; wasTruncated: boolean } {
  const fullText = `${title}\n\n${content}`;
  const fullTokens = estimateTokenCountFromString(fullText);

  if (fullTokens <= maxTokens) {
    return { content, wasTruncated: false };
  }

  // Preserve title and first paragraph
  const titleTokens = estimateTokenCountFromString(title);
  const reservedTokens = titleTokens + 100; // Reserve for title + first paragraph
  const availableTokens = Math.max(0, maxTokens - reservedTokens - 50); // Reserve 50 for truncation notice

  // Find first paragraph
  const firstParagraphMatch = content.match(/^([^.!?]+[.!?])/);
  const firstParagraph = firstParagraphMatch ? firstParagraphMatch[1] : '';
  const firstParagraphTokens = estimateTokenCountFromString(firstParagraph);

  let remainingTokens = availableTokens - firstParagraphTokens;
  if (remainingTokens < 0) {
    // Even first paragraph is too large, truncate it
    const truncatedFirst = truncateByTokens(firstParagraph, availableTokens);
    return {
      content: truncatedFirst + '\n\n[Content truncated to fit token limit]',
      wasTruncated: true
    };
  }

  // Get remaining content after first paragraph
  const remainingContent = content.substring(firstParagraph.length).trim();
  const truncatedRemaining = truncateByTokens(remainingContent, remainingTokens);

  return {
    content: firstParagraph + (truncatedRemaining ? '\n\n' + truncatedRemaining : '') + '\n\n[Content truncated to fit token limit]',
    wasTruncated: true
  };
}

/**
 * Truncate string to fit within token budget
 */
function truncateByTokens(text: string, maxTokens: number): string {
  const estimatedChars = maxTokens * 4; // ~4 chars per token
  if (text.length <= estimatedChars) {
    return text;
  }

  // Truncate at word boundary
  const truncated = text.substring(0, estimatedChars);
  const lastSpace = truncated.lastIndexOf(' ');
  if (lastSpace > estimatedChars * 0.8) {
    return truncated.substring(0, lastSpace);
  }
  return truncated;
}

