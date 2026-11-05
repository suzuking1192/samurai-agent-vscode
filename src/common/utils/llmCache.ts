/**
 * LLM Cache Utility
 * 
 * Provides caching for LLM responses to reduce latency and costs
 * during iterative root cause analysis
 */

import { createHash } from 'crypto';
import { LLMCacheEntry } from '../../agent/tools/debugging/rootCauseTypes';

export class LLMCache {
  private cache = new Map<string, LLMCacheEntry>();
  private readonly defaultTTL = 60 * 60 * 1000; // 1 hour

  /**
   * Create a deterministic hash for prompt + context
   */
  hashPrompt(prompt: string, context: any): string {
    const contextStr = JSON.stringify(context, Object.keys(context).sort());
    const combined = `${prompt}|||${contextStr}`;
    return createHash('sha256').update(combined).digest('hex');
  }

  /**
   * Get cached response if available and not expired
   */
  getCachedResponse(hash: string): any | null {
    const entry = this.cache.get(hash);
    
    if (!entry) {
      return null;
    }

    const now = Date.now();
    if (now - entry.timestamp > entry.ttl) {
      this.cache.delete(hash);
      return null;
    }

    return entry.response;
  }

  /**
   * Store response in cache with TTL
   */
  setCachedResponse(hash: string, response: any, ttl: number = this.defaultTTL): void {
    const entry: LLMCacheEntry = {
      response,
      timestamp: Date.now(),
      ttl
    };
    
    this.cache.set(hash, entry);
  }

  /**
   * Clear all cached responses
   */
  clearCache(): void {
    this.cache.clear();
  }

  /**
   * Clear expired entries
   */
  clearExpired(): void {
    const now = Date.now();
    for (const [hash, entry] of this.cache.entries()) {
      if (now - entry.timestamp > entry.ttl) {
        this.cache.delete(hash);
      }
    }
  }

  /**
   * Get cache statistics
   */
  getStats(): { size: number; entries: number } {
    return {
      size: this.cache.size,
      entries: this.cache.size
    };
  }

  /**
   * Check if cache has entry for hash
   */
  has(hash: string): boolean {
    const entry = this.cache.get(hash);
    if (!entry) return false;
    
    const now = Date.now();
    if (now - entry.timestamp > entry.ttl) {
      this.cache.delete(hash);
      return false;
    }
    
    return true;
  }
}

// Global cache instance
export const llmCache = new LLMCache();




















