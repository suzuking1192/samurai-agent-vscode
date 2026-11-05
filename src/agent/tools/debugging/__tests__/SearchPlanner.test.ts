/**
 * Tests for SearchPlanner
 */

import { SearchPlanner } from '../SearchPlanner';
import { Evidence, SearchPlan, RepoMeta } from '../types';

// Mock fs module
jest.mock('fs', () => ({
  readFileSync: jest.fn(),
  existsSync: jest.fn()
}));

// Mock LLMProviderService
const mockLLMProviderService = {
  chat: jest.fn()
};

describe('SearchPlanner', () => {
  let searchPlanner: SearchPlanner;
  let mockFs: any;

  beforeEach(() => {
    searchPlanner = new SearchPlanner(mockLLMProviderService as any);
    mockFs = require('fs');
    jest.clearAllMocks();
    // Default existsSync to true so prompt loading works
    mockFs.existsSync.mockReturnValue(true);
  });

  describe('makeSearchPlan', () => {
    it('should generate search plan with valid evidence', async () => {
      const evidence: Evidence = {
        frames: [
          { file: '/app/src/api/user.ts', line: 15, fn: 'getUser', column: 8 },
          { file: '/app/src/handlers/request.ts', line: 23, fn: 'processRequest', column: 5 }
        ],
        error: 'TypeError: Cannot read property \'name\' of undefined',
        requestId: 'req-123',
        route: '/api/users',
        logSignatures: ['[ERROR] User API failed', '[INFO] Request processed'],
        tsconfigPaths: { '@/*': ['/app/src'] },
        warnings: [],
        confidence: 0.8
      };

      const repoMeta: RepoMeta = {
        fileList: ['src/api/user.ts', 'src/models/User.ts', 'src/utils/validation.ts'],
        paths: ['src/api/user.ts', 'src/models/User.ts', 'src/utils/validation.ts'],
        projectRoot: '/app',
        commitHash: 'abc123'
      };

      const userMessage = 'User API is failing with undefined error';
      const model = 'gpt-4';

      // Mock prompt file content
      mockFs.readFileSync.mockReturnValue(`# Search Plan Generation Prompt

You are a search planner for debugging code analysis.

## Output Format

Return **valid JSON only** with these exact fields:

{
  "candidateFiles": ["file1.ts", "file2.ts"],
  "symbols": ["functionName", "ClassName", "variableName"],
  "queries": ["search term 1", "search term 2"],
  "reasoning": "Brief explanation of your choices"
}

## Evidence Analysis

### Stack Trace Analysis
{{STACK_TRACE}}

### Error Details
{{ERROR_DETAILS}}`);

      // Mock successful LLM response
      mockLLMProviderService.chat.mockResolvedValue({
        type: 'success',
        payload: {
          content: JSON.stringify({
            candidateFiles: ['src/api/user.ts', 'src/models/User.ts'],
            symbols: ['getUser', 'User', 'validateUser'],
            queries: ['undefined', 'property access', 'user validation'],
            reasoning: 'Error occurs in getUser function, likely related to User model validation'
          })
        }
      });

      const result = await searchPlanner.makeSearchPlan(evidence, repoMeta, userMessage, model);

      expect(result).toEqual({
        candidateFiles: ['src/api/user.ts', 'src/models/User.ts'],
        symbols: ['getUser', 'User', 'validateUser'],
        queries: ['undefined', 'property access', 'user validation'],
        reasoning: 'Error occurs in getUser function, likely related to User model validation',
        mode: 'behavior-first'
      });

      expect(mockLLMProviderService.chat).toHaveBeenCalledWith(
        expect.objectContaining({
          model: 'gpt-4',
          maxTokens: 2000,
          messages: expect.arrayContaining([
            expect.objectContaining({ role: 'user' })
          ])
        })
      );
    });

    it('should use cached plan for same input', async () => {
      const evidence: Evidence = {
        frames: [{ file: '/app/src/api/user.ts', line: 15, fn: 'getUser', column: 8 }],
        error: 'TypeError: Cannot read property \'name\' of undefined',
        requestId: 'req-123',
        route: '/api/users',
        logSignatures: [],
        tsconfigPaths: {},
        warnings: [],
        confidence: 0.8
      };

      const repoMeta: RepoMeta = {
        fileList: ['src/api/user.ts'],
        paths: ['src/api/user.ts'],
        projectRoot: '/app',
        commitHash: 'abc123'
      };

      const userMessage = 'User API is failing';
      const model = 'gpt-4';

      mockFs.readFileSync.mockReturnValue('Mock prompt content');

      // Mock successful LLM response
      mockLLMProviderService.chat.mockResolvedValue({
        type: 'success',
        payload: {
          content: JSON.stringify({
            candidateFiles: ['src/api/user.ts'],
            symbols: ['getUser'],
            queries: ['undefined'],
            reasoning: 'Test reasoning'
          })
        }
      });

      // First call
      const result1 = await searchPlanner.makeSearchPlan(evidence, repoMeta, userMessage, model);
      
      // Second call with same input
      const result2 = await searchPlanner.makeSearchPlan(evidence, repoMeta, userMessage, model);

      expect(result1).toEqual(result2);
      expect(mockLLMProviderService.chat).toHaveBeenCalledTimes(1); // Should only call once due to caching
    });

    it('should handle LLM failure with fallback plan', async () => {
      const evidence: Evidence = {
        frames: [{ file: '/app/src/api/user.ts', line: 15, fn: 'getUser', column: 8 }],
        error: 'TypeError: Cannot read property \'name\' of undefined',
        requestId: 'req-123',
        route: '/api/users',
        logSignatures: [],
        tsconfigPaths: {},
        warnings: [],
        confidence: 0.8
      };

      const repoMeta: RepoMeta = {
        fileList: ['src/api/user.ts'],
        paths: ['src/api/user.ts'],
        projectRoot: '/app',
        commitHash: 'abc123'
      };

      const userMessage = 'User API is failing';
      const model = 'gpt-4';

      mockFs.readFileSync.mockReturnValue('Mock prompt content');

      // Mock LLM failure
      mockLLMProviderService.chat.mockRejectedValue(new Error('LLM service unavailable'));

      const result = await searchPlanner.makeSearchPlan(evidence, repoMeta, userMessage, model);

      expect(result.candidateFiles).toContain('/app/src/api/user.ts');
      expect(result.queries).toContain('TypeError: Cannot read property \'name\' of undefined');
      expect(result.queries).toContain('/api/users');
      expect(result.reasoning).toBe('Fallback plan generated due to LLM failure');
    });

    it('should handle malformed JSON response', async () => {
      const evidence: Evidence = {
        frames: [{ file: '/app/src/api/user.ts', line: 15, fn: 'getUser', column: 8 }],
        error: 'TypeError: Cannot read property \'name\' of undefined',
        requestId: 'req-123',
        route: '/api/users',
        logSignatures: [],
        tsconfigPaths: {},
        warnings: [],
        confidence: 0.8
      };

      const repoMeta: RepoMeta = {
        fileList: ['src/api/user.ts'],
        paths: ['src/api/user.ts'],
        projectRoot: '/app',
        commitHash: 'abc123'
      };

      const userMessage = 'User API is failing';
      const model = 'gpt-4';

      mockFs.readFileSync.mockReturnValue('Mock prompt content');

      // Mock malformed JSON response
      mockLLMProviderService.chat.mockResolvedValue({
        type: 'success',
        payload: {
          content: 'This is not valid JSON'
        }
      });

      const result = await searchPlanner.makeSearchPlan(evidence, repoMeta, userMessage, model);

      expect(result.candidateFiles).toContain('/app/src/api/user.ts');
      expect(result.reasoning).toBe('Fallback plan generated due to LLM failure');
    });

    it('should apply limits to LLM response', async () => {
      const evidence: Evidence = {
        frames: [{ file: '/app/src/api/user.ts', line: 15, fn: 'getUser', column: 8 }],
        error: 'TypeError: Cannot read property \'name\' of undefined',
        requestId: 'req-123',
        route: '/api/users',
        logSignatures: [],
        tsconfigPaths: {},
        warnings: [],
        confidence: 0.8
      };

      const repoMeta: RepoMeta = {
        fileList: ['src/api/user.ts'],
        paths: ['src/api/user.ts'],
        projectRoot: '/app',
        commitHash: 'abc123'
      };

      const userMessage = 'User API is failing';
      const model = 'gpt-4';

      mockFs.readFileSync.mockReturnValue('Mock prompt content');

      // Mock response with too many items
      mockLLMProviderService.chat.mockResolvedValue({
        type: 'success',
        payload: {
          content: JSON.stringify({
            candidateFiles: Array(15).fill('file.ts'), // More than 10
            symbols: Array(20).fill('symbol'), // More than 15
            queries: Array(15).fill('query'), // More than 10
            reasoning: 'Test reasoning'
          })
        }
      });

      const result = await searchPlanner.makeSearchPlan(evidence, repoMeta, userMessage, model);

      expect(result.candidateFiles).toHaveLength(10);
      expect(result.symbols).toHaveLength(15);
      expect(result.queries).toHaveLength(10);
    });
  });

  describe('prompt building', () => {
    it('should load system prompt from file', async () => {
      const evidence: Evidence = {
        frames: [],
        error: 'Test error',
        requestId: 'req-123',
        route: '/api/test',
        logSignatures: [],
        tsconfigPaths: {},
        warnings: [],
        confidence: 0.8
      };

      const repoMeta: RepoMeta = {
        fileList: ['src/test.ts'],
        paths: ['src/test.ts'],
        projectRoot: '/app',
        commitHash: 'abc123'
      };

      const userMessage = 'Test message';
      const model = 'gpt-4';

      const mockPromptContent = `# Search Plan Generation Prompt

You are a search planner for debugging code analysis.

## Output Format

Return **valid JSON only** with these exact fields:

### Stack Trace Analysis
{{STACK_TRACE}}

### Error Details
{{ERROR_DETAILS}}`;

      mockFs.readFileSync.mockReturnValue(mockPromptContent);

      mockLLMProviderService.chat.mockResolvedValue({
        type: 'success',
        payload: {
          content: JSON.stringify({
            candidateFiles: ['src/test.ts'],
            symbols: ['test'],
            queries: ['test'],
            reasoning: 'Test'
          })
        }
      });

      await searchPlanner.makeSearchPlan(evidence, repoMeta, userMessage, model);

      expect(mockFs.readFileSync).toHaveBeenCalledWith(
        expect.stringContaining('search_plan.md'),
        expect.any(String)
      );

      const callArgs = mockLLMProviderService.chat.mock.calls[0][0];
      expect(callArgs.messages[0].role).toBe('user');
      expect(callArgs.messages[0].content).toContain('You are a search planner for debugging code analysis');
      expect(callArgs.messages[0].content).toContain('Return **valid JSON only**');
    });

    it('should use fallback prompt when file loading fails', async () => {
      const evidence: Evidence = {
        frames: [],
        error: 'Test error',
        requestId: 'req-123',
        route: '/api/test',
        logSignatures: [],
        tsconfigPaths: {},
        warnings: [],
        confidence: 0.8
      };

      const repoMeta: RepoMeta = {
        fileList: ['src/test.ts'],
        paths: ['src/test.ts'],
        projectRoot: '/app',
        commitHash: 'abc123'
      };

      const userMessage = 'Test message';
      const model = 'gpt-4';

      // Mock file read failure
      mockFs.readFileSync.mockImplementation(() => {
        throw new Error('File not found');
      });

      mockLLMProviderService.chat.mockResolvedValue({
        type: 'success',
        payload: {
          content: JSON.stringify({
            candidateFiles: ['src/test.ts'],
            symbols: ['test'],
            queries: ['test'],
            reasoning: 'Test'
          })
        }
      });

      await searchPlanner.makeSearchPlan(evidence, repoMeta, userMessage, model);

      const callArgs = mockLLMProviderService.chat.mock.calls[0][0];
      expect(callArgs.messages[0].role).toBe('user');
      expect(callArgs.messages[0].content).toContain('You are a search planner for debugging code analysis. Analyze the debugging scenario and return valid JSON with candidateFiles, symbols, queries, reasoning, and mode.');
    });

    it('should build prompt sections correctly', async () => {
      const evidence: Evidence = {
        frames: [
          { file: '/app/src/api/user.ts', line: 15, fn: 'getUser', column: 8 }
        ],
        error: 'TypeError: Cannot read property \'name\' of undefined',
        requestId: 'req-123',
        route: '/api/users',
        logSignatures: ['[ERROR] User API failed'],
        tsconfigPaths: {},
        warnings: [],
        confidence: 0.8
      };

      const repoMeta: RepoMeta = {
        fileList: ['src/api/user.ts', 'src/models/User.ts'],
        paths: ['src/api/user.ts', 'src/models/User.ts'],
        projectRoot: '/app',
        commitHash: 'abc123'
      };

      const userMessage = 'User API is failing';
      const model = 'gpt-4';

      mockFs.readFileSync.mockReturnValue('Mock prompt content');

      mockLLMProviderService.chat.mockResolvedValue({
        type: 'success',
        payload: {
          content: JSON.stringify({
            candidateFiles: ['src/api/user.ts'],
            symbols: ['getUser'],
            queries: ['undefined'],
            reasoning: 'Test'
          })
        }
      });

      await searchPlanner.makeSearchPlan(evidence, repoMeta, userMessage, model);

      const callArgs = mockLLMProviderService.chat.mock.calls[0][0];
      const userMessageContent = callArgs.messages[0].content;

      expect(userMessageContent).toContain('## USER MESSAGE');
      expect(userMessageContent).toContain('User API is failing');
      expect(userMessageContent).toContain('## EVIDENCE ANALYSIS');
      expect(userMessageContent).toContain('### Stack Trace Analysis');
      expect(userMessageContent).toContain('/app/src/api/user.ts:15 (getUser)');
      expect(userMessageContent).toContain('### Error Details');
      expect(userMessageContent).toContain('TypeError: Cannot read property \'name\' of undefined');
      expect(userMessageContent).toContain('### Route Information');
      expect(userMessageContent).toContain('/api/users');
      expect(userMessageContent).toContain('### Log Signatures');
      expect(userMessageContent).toContain('[ERROR] User API failed');
      expect(userMessageContent).toContain('### Available Files');
      expect(userMessageContent).toContain('- src/api/user.ts');
      expect(userMessageContent).toContain('- src/models/User.ts');
    });
  });

  describe('cache management', () => {
    it('should clear cache', () => {
      searchPlanner.clearCache();
      // No direct way to test cache clearing, but method should not throw
      expect(() => searchPlanner.clearCache()).not.toThrow();
    });

    it('should create different cache keys for different inputs', async () => {
      const evidence1: Evidence = {
        frames: [{ file: '/app/src/api/user.ts', line: 15, fn: 'getUser', column: 8 }],
        error: 'Error 1',
        requestId: 'req-123',
        route: '/api/users',
        logSignatures: [],
        tsconfigPaths: {},
        warnings: [],
        confidence: 0.8
      };

      const evidence2: Evidence = {
        frames: [{ file: '/app/src/api/user.ts', line: 20, fn: 'getUser', column: 8 }],
        error: 'Error 2',
        requestId: 'req-456',
        route: '/api/users',
        logSignatures: [],
        tsconfigPaths: {},
        warnings: [],
        confidence: 0.8
      };

      const repoMeta: RepoMeta = {
        fileList: ['src/api/user.ts'],
        paths: ['src/api/user.ts'],
        projectRoot: '/app',
        commitHash: 'abc123'
      };

      const userMessage = 'Test message';
      const model = 'gpt-4';

      mockFs.readFileSync.mockReturnValue('Mock prompt content');

      mockLLMProviderService.chat.mockResolvedValue({
        type: 'success',
        payload: {
          content: JSON.stringify({
            candidateFiles: ['src/api/user.ts'],
            symbols: ['getUser'],
            queries: ['test'],
            reasoning: 'Test'
          })
        }
      });

      // First call with evidence1
      await searchPlanner.makeSearchPlan(evidence1, repoMeta, userMessage, model);
      
      // Second call with evidence2 (different evidence)
      await searchPlanner.makeSearchPlan(evidence2, repoMeta, userMessage, model);

      // Should have been called twice due to different cache keys
      expect(mockLLMProviderService.chat).toHaveBeenCalledTimes(2);
    });
  });

  describe('fallback plan generation', () => {
    it('should create fallback plan with stack trace files', async () => {
      const evidence: Evidence = {
        frames: [
          { file: '/app/src/api/user.ts', line: 15, fn: 'getUser', column: 8 },
          { file: '/app/src/handlers/request.ts', line: 23, fn: 'processRequest', column: 5 }
        ],
        error: 'TypeError: Cannot read property \'name\' of undefined',
        requestId: 'req-123',
        route: '/api/users',
        logSignatures: [],
        tsconfigPaths: {},
        warnings: [],
        confidence: 0.8
      };

      const repoMeta: RepoMeta = {
        fileList: ['src/api/user.ts', 'src/handlers/request.ts'],
        paths: ['src/api/user.ts', 'src/handlers/request.ts'],
        projectRoot: '/app',
        commitHash: 'abc123'
      };

      const userMessage = 'User API is failing';
      const model = 'gpt-4';

      mockFs.readFileSync.mockReturnValue('Mock prompt content');

      // Mock LLM failure to trigger fallback
      mockLLMProviderService.chat.mockRejectedValue(new Error('LLM service unavailable'));

      const result = await searchPlanner.makeSearchPlan(evidence, repoMeta, userMessage, model);

      expect(result.candidateFiles).toContain('/app/src/api/user.ts');
      expect(result.candidateFiles).toContain('/app/src/handlers/request.ts');
      expect(result.queries).toContain('TypeError: Cannot read property \'name\' of undefined');
      expect(result.queries).toContain('/api/users');
      expect(result.queries).toContain('error');
      expect(result.queries).toContain('bug');
      expect(result.queries).toContain('debug');
      expect(result.queries).toContain('exception');
      expect(result.reasoning).toBe('Fallback plan generated due to LLM failure');
    });
  });
});