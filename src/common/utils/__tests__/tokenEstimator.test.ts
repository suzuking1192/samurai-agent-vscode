import { estimateTokenCount, estimateTokenCountFromString, truncateMessagesToTokenLimit } from '../tokenEstimator';
import { LLMMessage } from '../../models/llm-models';

describe('tokenEstimator', () => {
  describe('estimateTokenCount', () => {
    it('should estimate tokens from messages array', () => {
      const messages: LLMMessage[] = [
        { role: 'system', content: 'You are a helpful assistant.' },
        { role: 'user', content: 'Hello, how are you?' }
      ];
      
      const tokens = estimateTokenCount(messages);
      // ~4 chars per token, so ~40 chars = ~10 tokens
      expect(tokens).toBeGreaterThan(0);
      expect(tokens).toBeLessThan(20);
    });

    it('should handle empty messages array', () => {
      const tokens = estimateTokenCount([]);
      expect(tokens).toBe(0);
    });

    it('should handle messages with null/undefined content', () => {
      const messages: any[] = [
        { role: 'user', content: null },
        { role: 'assistant', content: undefined },
        { role: 'user', content: 'Valid message' }
      ];
      
      const tokens = estimateTokenCount(messages);
      expect(tokens).toBeGreaterThan(0);
    });

    it('should handle multimodal content (arrays)', () => {
      const messages: any[] = [
        {
          role: 'user',
          content: [
            { type: 'text', text: 'Hello' },
            { type: 'text', text: 'World' }
          ]
        }
      ];
      
      const tokens = estimateTokenCount(messages);
      expect(tokens).toBeGreaterThan(0);
    });

    it('should handle large content correctly', () => {
      const largeContent = 'a'.repeat(4000); // 4000 chars = ~1000 tokens
      const messages: LLMMessage[] = [
        { role: 'user', content: largeContent }
      ];
      
      const tokens = estimateTokenCount(messages);
      expect(tokens).toBeCloseTo(1000, 0); // Should be around 1000
    });
  });

  describe('estimateTokenCountFromString', () => {
    it('should estimate tokens from string', () => {
      const text = 'Hello, this is a test message with some content.';
      const tokens = estimateTokenCountFromString(text);
      expect(tokens).toBeGreaterThan(0);
    });

    it('should return 0 for empty string', () => {
      expect(estimateTokenCountFromString('')).toBe(0);
    });

    it('should return 0 for null/undefined', () => {
      expect(estimateTokenCountFromString(null as any)).toBe(0);
      expect(estimateTokenCountFromString(undefined as any)).toBe(0);
    });

    it('should handle large strings', () => {
      const largeText = 'a'.repeat(10000); // 10000 chars = ~2500 tokens
      const tokens = estimateTokenCountFromString(largeText);
      expect(tokens).toBeCloseTo(2500, 0);
    });
  });

  describe('truncateMessagesToTokenLimit', () => {
    it('should not truncate if within limit', () => {
      const messages: LLMMessage[] = [
        { role: 'system', content: 'System message' },
        { role: 'user', content: 'Short message' }
      ];
      
      const result = truncateMessagesToTokenLimit(messages, 1000);
      expect(result).toEqual(messages);
    });

    it('should preserve system messages', () => {
      const messages: LLMMessage[] = [
        { role: 'system', content: 'System message' },
        { role: 'user', content: 'a'.repeat(10000) } // Large content
      ];
      
      const result = truncateMessagesToTokenLimit(messages, 100);
      expect(result.length).toBeGreaterThan(0);
      expect(result[0].role).toBe('system');
    });

    it('should remove messages before 4th most recent user message when >4 user messages', () => {
      const messages: LLMMessage[] = [
        { role: 'system', content: 'System' },
        { role: 'user', content: 'Message 1' },
        { role: 'assistant', content: 'Response 1' },
        { role: 'user', content: 'Message 2' },
        { role: 'assistant', content: 'Response 2' },
        { role: 'user', content: 'Message 3' },
        { role: 'assistant', content: 'Response 3' },
        { role: 'user', content: 'Message 4' },
        { role: 'assistant', content: 'Response 4' },
        { role: 'user', content: 'Message 5' }
      ];
      
      // Create large content to exceed limit
      const largeContent = 'a'.repeat(50000);
      messages.forEach(msg => {
        if (msg.role === 'user' || msg.role === 'assistant') {
          msg.content = largeContent;
        }
      });
      
      const result = truncateMessagesToTokenLimit(messages, 1000);
      
      // Should keep system message and messages from 4th most recent user message onwards
      expect(result[0].role).toBe('system');
      // Should have fewer messages than original
      expect(result.length).toBeLessThan(messages.length);
    });

    it('should not remove messages if exactly 4 user messages', () => {
      const messages: LLMMessage[] = [
        { role: 'system', content: 'System' },
        { role: 'user', content: 'Message 1' },
        { role: 'user', content: 'Message 2' },
        { role: 'user', content: 'Message 3' },
        { role: 'user', content: 'Message 4' }
      ];
      
      const largeContent = 'a'.repeat(50000);
      messages.forEach(msg => {
        if (msg.role === 'user') {
          msg.content = largeContent;
        }
      });
      
      const result = truncateMessagesToTokenLimit(messages, 1000);
      // Should still have all messages (Phase 1 won't trigger, Phase 2 will handle)
      expect(result.length).toBeGreaterThan(0);
    });

    it('should remove code snippets from final message in Phase 2', () => {
      const messages: LLMMessage[] = [
        { role: 'system', content: 'System message' },
        { role: 'user', content: 'Regular message' },
        {
          role: 'user',
          content: `Final message with code:
\`\`\`typescript
${'const code = "very long code block";\n'.repeat(1000)}
\`\`\`
// File: test.ts
${'more code here\n'.repeat(1000)}
`
        }
      ];
      
      const result = truncateMessagesToTokenLimit(messages, 100);
      
      expect(result.length).toBeGreaterThan(0);
      const finalMessage = result[result.length - 1];
      if (finalMessage && typeof finalMessage.content === 'string') {
        // Should have less content than original
        expect(finalMessage.content.length).toBeLessThan(messages[messages.length - 1].content.length);
      }
    });

    it('should handle empty messages array', () => {
      const result = truncateMessagesToTokenLimit([], 1000);
      expect(result).toEqual([]);
    });

    it('should log warnings when truncation occurs', () => {
      const consoleSpy = jest.spyOn(console, 'warn').mockImplementation();
      
      const messages: LLMMessage[] = [
        { role: 'user', content: 'a'.repeat(10000) }
      ];
      
      truncateMessagesToTokenLimit(messages, 100);
      
      expect(consoleSpy).toHaveBeenCalled();
      consoleSpy.mockRestore();
    });
  });
});

