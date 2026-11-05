/**
 * Tests for InitialContextService
 */

import { InitialContextService } from '../InitialContextService';
import { ToolRegistry } from '../../tools/ToolRegistry';
import { LLMProviderService } from '../../llm/llmProviderService';
import { EvidenceParser } from '../../tools/debugging/EvidenceParser';

// Mock dependencies
jest.mock('fs', () => ({
  existsSync: jest.fn()
}));
jest.mock('../../tools/ToolRegistry');
jest.mock('../../llm/llmProviderService');
jest.mock('../../tools/debugging/EvidenceParser');
jest.mock('../../../services/RecentFilesTracker', () => ({
  RecentFilesTracker: {
    getInstance: jest.fn(() => ({
      getRecentlyOpenedFilePaths: jest.fn(() => [])
    }))
  }
}));
jest.mock('../../tools/debugging/promptLoader', () => ({
  loadDebuggingPrompt: jest.fn((fileName: string) => {
    if (fileName === 'epicenter_search.md') {
      return `Task: Generate multiple search strategies to find the epicenter file.

Code Search Tool Schema:
{{CODE_SEARCH_SCHEMA}}

Generate 2-3 diverse search queries (file, symbol, text modes).

User Query: "{{USER_QUERY}}"
Context Snippet: "{{CONTEXT_SNIPPET}}"

Output JSON with queries array:
{
  "queries": [
    { "query": "...", "mode": "file|symbol|text" }
  ]
}`;
    }
    throw new Error(`Prompt file not found: ${fileName}`);
  })
}));
jest.mock('../schemaFormatter', () => ({
  formatSchemaForPrompt: jest.fn(() => {
    return `The \`code-search\` tool accepts the following parameters:

- **query** (string, required): The search term (filename, symbol name, or text pattern).
- **mode** (enum, required): file: Find file paths matching a pattern (e.g. 'User.ts').
symbol: Find function/class definitions (e.g. 'AuthService').
text: Grep for exact string content (e.g. 'error_code_500').
  - Valid values: \`"file"\`, \`"symbol"\`, \`"text"\`
- **pattern** (string, optional): Glob pattern to limit search (e.g., 'src/**/*.ts'). Defaults to inclusive search.`;
  }),
  generateJsonFormatFromSchema: jest.fn(() => {
    return `{
  "query": "string",
  "mode": "file" | "symbol" | "text",
  "pattern": "string (optional)"
}`;
  })
}));

describe('InitialContextService', () => {
  let initialContextService: InitialContextService;
  let mockToolRegistry: jest.Mocked<ToolRegistry>;
  let mockLLMProvider: jest.Mocked<LLMProviderService>;
  let mockGraphTool: any;
  let mockCodeSearchTool: any;
  let mockFs: any;

  beforeEach(() => {
    jest.clearAllMocks();

    // Get mocked fs module
    mockFs = require('fs');

    // Setup mocks
    mockGraphTool = {
      name: 'graph-context',
      execute: jest.fn()
    };

    mockCodeSearchTool = {
      name: 'code-search',
      execute: jest.fn()
    };

    mockToolRegistry = {
      getTool: jest.fn()
    } as any;

    mockLLMProvider = {
      chat: jest.fn()
    } as any;

    initialContextService = new InitialContextService(mockToolRegistry, mockLLMProvider);

    // Setup default mocks
    mockFs.existsSync.mockReturnValue(false);
    (mockToolRegistry.getTool as jest.Mock).mockImplementation((name: string) => {
      if (name === 'graph-context') return mockGraphTool;
      if (name === 'code-search') return mockCodeSearchTool;
      return undefined;
    });
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  describe('getInitialContext', () => {
    const sessionId = 'test-session-123';
    const workspaceRoot = '/test/workspace';
    const userQuery = 'Why is login failing?';

    describe('pinned files path', () => {
      it('should use pinned file if it exists', async () => {
        const pinnedFiles = ['/test/workspace/src/auth.ts'];
        mockFs.existsSync.mockReturnValue(true);

        mockGraphTool.execute.mockResolvedValue({
          success: true,
          structuredData: {
            mermaid: 'graph TD\nA[Auth]',
            nodes: [{ id: '1', label: 'Auth' }],
            edges: []
          }
        });

        const result = await initialContextService.getInitialContext(
          sessionId,
          userQuery,
          workspaceRoot,
          undefined,
          pinnedFiles
        );

        expect(result.success).toBe(true);
        expect(result.source).toBe('user-pinned');
        expect(result.epicenterFile).toBe(pinnedFiles[0]);
        expect(result.cost).toBe(0); // No LLM call, so cost should be 0
        expect(mockGraphTool.execute).toHaveBeenCalled();
      });

      it('should handle relative pinned file paths', async () => {
        const pinnedFiles = ['src/auth.ts'];
        mockFs.existsSync.mockReturnValue(true);

        mockGraphTool.execute.mockResolvedValue({
          success: true,
          structuredData: {
            mermaid: 'graph TD\nA[Auth]',
            nodes: [],
            edges: []
          }
        });

        const result = await initialContextService.getInitialContext(
          sessionId,
          userQuery,
          workspaceRoot,
          undefined,
          pinnedFiles
        );

        expect(result.success).toBe(true);
        expect(result.source).toBe('user-pinned');
        expect(result.epicenterFile).toContain('auth.ts');
      });

      it('should skip invalid pinned files', async () => {
        const pinnedFiles = ['/nonexistent/file.ts'];
        mockFs.existsSync.mockReturnValue(false);

        // Mock LLM search as fallback
        mockLLMProvider.chat.mockResolvedValue({
          type: 'success',
          payload: {
            content: '{"query": "auth", "mode": "file"}'
          }
        } as any);

        mockCodeSearchTool.execute.mockResolvedValue({
          success: true,
          structuredData: [{ file: '/test/workspace/src/auth.ts', score: 10 }]
        });

        mockGraphTool.execute.mockResolvedValue({
          success: true,
          structuredData: {
            mermaid: 'graph TD\nA[Auth]',
            nodes: [],
            edges: []
          }
        });

        const result = await initialContextService.getInitialContext(
          sessionId,
          userQuery,
          workspaceRoot,
          undefined,
          pinnedFiles
        );

        expect(result.source).toBe('search');
      });
    });

    describe('stack trace path', () => {
      it('should extract epicenter from stack trace in logs', async () => {
        const logs = `
          Error: Cannot read property 'name' of undefined
              at getUser (/app/src/api/user.ts:15:8)
              at processRequest (/app/src/handlers/request.ts:23:5)
        `;

        // Mock EvidenceParser
        const mockEvidence = {
          frames: [
            { file: '/app/src/api/user.ts', line: 15, fn: 'getUser', column: 8 },
            { file: '/app/src/handlers/request.ts', line: 23, fn: 'processRequest', column: 5 }
          ]
        };

        jest.spyOn(EvidenceParser.prototype, 'parseEvidence').mockReturnValue(mockEvidence as any);
        mockFs.existsSync.mockReturnValue(true);

        mockGraphTool.execute.mockResolvedValue({
          success: true,
          structuredData: {
            mermaid: 'graph TD\nA[User]',
            nodes: [],
            edges: []
          }
        });

        const result = await initialContextService.getInitialContext(
          sessionId,
          userQuery,
          workspaceRoot,
          logs
        );

        expect(result.success).toBe(true);
        expect(result.source).toBe('logs');
        expect(result.epicenterFile).toBe('/app/src/api/user.ts');
        expect(result.cost).toBe(0); // No LLM call, so cost should be 0
      });

      it('should filter out node_modules from stack traces', async () => {
        const logs = `
          Error: Something went wrong
              at handler (/app/src/api/user.ts:15:8)
              at Object.<anonymous> (/node_modules/express/index.js:10:1)
        `;

        const mockEvidence = {
          frames: [
            { file: '/app/src/api/user.ts', line: 15, fn: 'handler', column: 8 },
            { file: '/node_modules/express/index.js', line: 10, fn: '<anonymous>', column: 1 }
          ]
        };

        jest.spyOn(EvidenceParser.prototype, 'parseEvidence').mockReturnValue(mockEvidence as any);
        mockFs.existsSync.mockReturnValue(true);

        mockGraphTool.execute.mockResolvedValue({
          success: true,
          structuredData: {
            mermaid: 'graph TD\nA[User]',
            nodes: [],
            edges: []
          }
        });

        const result = await initialContextService.getInitialContext(
          sessionId,
          userQuery,
          workspaceRoot,
          logs
        );

        expect(result.success).toBe(true);
        expect(result.source).toBe('logs');
        expect(result.epicenterFile).toBe('/app/src/api/user.ts');
        expect(result.cost).toBe(0); // No LLM call, so cost should be 0
      });
    });

    describe('LLM search path', () => {
      it('should use LLM to find epicenter when no pinned files or logs (backward compatibility - single query)', async () => {
        const mockCost = 0.002;
        mockLLMProvider.chat.mockResolvedValue({
          type: 'success',
          payload: {
            content: '{"query": "auth", "mode": "file"}',
            cost: mockCost
          }
        } as any);

        mockCodeSearchTool.execute.mockResolvedValue({
          success: true,
          structuredData: [{ file: '/test/workspace/src/auth.ts', score: 10 }]
        });

        mockGraphTool.execute.mockResolvedValue({
          success: true,
          structuredData: {
            mermaid: 'graph TD\nA[Auth]',
            nodes: [],
            edges: []
          }
        });

        const result = await initialContextService.getInitialContext(
          sessionId,
          userQuery,
          workspaceRoot
        );

        expect(result.success).toBe(true);
        expect(result.source).toBe('search');
        expect(result.cost).toBe(mockCost); // Should track LLM cost
        expect(mockLLMProvider.chat).toHaveBeenCalled();
        expect(mockCodeSearchTool.execute).toHaveBeenCalled();
      });

      it('should handle multi-strategy search with multiple queries', async () => {
        const mockCost = 0.003;
        mockLLMProvider.chat.mockResolvedValue({
          type: 'success',
          payload: {
            content: JSON.stringify({
              queries: [
                { query: 'PlanningAgent', mode: 'file' },
                { query: 'PlanningAgent', mode: 'symbol' },
                { query: 'maximum number of iterations', mode: 'text' }
              ]
            }),
            cost: mockCost
          }
        } as any);

        // Mock different results for each search strategy
        mockCodeSearchTool.execute
          .mockResolvedValueOnce({
            // First search (file) - no results
            success: true,
            structuredData: []
          })
          .mockResolvedValueOnce({
            // Second search (symbol) - finds the class
            success: true,
            structuredData: [
              { file: '/test/workspace/src/agent/core/PlanningAgent.ts', score: 15, line: 1 }
            ]
          })
          .mockResolvedValueOnce({
            // Third search (text) - finds the string
            success: true,
            structuredData: [
              { file: '/test/workspace/src/agent/core/PlanningAgent.ts', score: 25, line: 42 }
            ]
          });

        mockGraphTool.execute.mockResolvedValue({
          success: true,
          structuredData: {
            mermaid: 'graph TD\nA[PlanningAgent]',
            nodes: [],
            edges: []
          }
        });

        const result = await initialContextService.getInitialContext(
          sessionId,
          'Planning agent is hitting maximum number of iterations',
          workspaceRoot
        );

        expect(result.success).toBe(true);
        expect(result.source).toBe('search');
        expect(result.epicenterFile).toBe('/test/workspace/src/agent/core/PlanningAgent.ts');
        expect(result.cost).toBe(mockCost); // Should track LLM cost
        expect(mockCodeSearchTool.execute).toHaveBeenCalledTimes(3);
      });

      it('should execute multiple searches in parallel', async () => {
        const executeCallOrder: number[] = [];
        let resolveFunctions: Array<() => void> = [];

        mockLLMProvider.chat.mockResolvedValue({
          type: 'success',
          payload: {
            content: JSON.stringify({
              queries: [
                { query: 'AuthService', mode: 'symbol' },
                { query: 'auth', mode: 'file' }
              ]
            })
          }
        } as any);

        // Create promises that resolve in sequence to verify parallel execution
        mockCodeSearchTool.execute.mockImplementation(() => {
          const callIndex = executeCallOrder.length;
          executeCallOrder.push(callIndex);
          return new Promise((resolve) => {
            resolveFunctions.push(() => {
              resolve({
                success: true,
                structuredData: [
                  { file: `/test/workspace/src/auth${callIndex}.ts`, score: 10 + callIndex }
                ]
              });
            });
          });
        });

        mockGraphTool.execute.mockResolvedValue({
          success: true,
          structuredData: { mermaid: '', nodes: [], edges: [] }
        });

        // Start the call
        const resultPromise = initialContextService.getInitialContext(
          sessionId,
          'AuthService error',
          workspaceRoot
        );

        // Wait a bit to ensure all searches are initiated
        await new Promise(resolve => setTimeout(resolve, 10));

        // All searches should have been initiated (parallel execution)
        expect(mockCodeSearchTool.execute).toHaveBeenCalledTimes(2);
        expect(executeCallOrder.length).toBe(2);

        // Resolve all promises
        resolveFunctions.forEach(resolve => resolve());
        await resultPromise;

        expect(mockCodeSearchTool.execute).toHaveBeenCalledTimes(2);
      });

      it('should apply score boosting based on search mode', async () => {
        mockLLMProvider.chat.mockResolvedValue({
          type: 'success',
          payload: {
            content: JSON.stringify({
              queries: [
                { query: 'PlanningAgent', mode: 'file' },
                { query: 'PlanningAgent', mode: 'symbol' },
                { query: 'iterations', mode: 'text' }
              ]
            })
          }
        } as any);

        mockCodeSearchTool.execute
          .mockResolvedValueOnce({
            // File search - score 10
            success: true,
            structuredData: [
              { file: '/test/workspace/src/PlanningAgent.ts', score: 10, line: 1 }
            ]
          })
          .mockResolvedValueOnce({
            // Symbol search - score 10 (should get +5 boost = 15)
            success: true,
            structuredData: [
              { file: '/test/workspace/src/PlanningAgent.ts', score: 10, line: 1 }
            ]
          })
          .mockResolvedValueOnce({
            // Text search - score 25 (should get +2 boost = 27)
            success: true,
            structuredData: [
              { file: '/test/workspace/src/PlanningAgent.ts', score: 25, line: 42 }
            ]
          });

        mockGraphTool.execute.mockResolvedValue({
          success: true,
          structuredData: { mermaid: '', nodes: [], edges: [] }
        });

        const result = await initialContextService.getInitialContext(
          sessionId,
          'Planning agent iterations',
          workspaceRoot
        );

        expect(result.success).toBe(true);
        // Text search with boost should win (27 > 15 > 10)
        expect(result.epicenterFile).toBe('/test/workspace/src/PlanningAgent.ts');
      });

      it('should deduplicate files and keep highest score', async () => {
        mockLLMProvider.chat.mockResolvedValue({
          type: 'success',
          payload: {
            content: JSON.stringify({
              queries: [
                { query: 'AuthService', mode: 'file' },
                { query: 'AuthService', mode: 'symbol' }
              ]
            })
          }
        } as any);

        mockCodeSearchTool.execute
          .mockResolvedValueOnce({
            // File search finds the same file with lower score
            success: true,
            structuredData: [
              { file: '/test/workspace/src/auth.ts', score: 5, line: 1 }
            ]
          })
          .mockResolvedValueOnce({
            // Symbol search finds the same file with higher score (gets boost)
            success: true,
            structuredData: [
              { file: '/test/workspace/src/auth.ts', score: 10, line: 1 }
            ]
          });

        mockGraphTool.execute.mockResolvedValue({
          success: true,
          structuredData: { mermaid: '', nodes: [], edges: [] }
        });

        const result = await initialContextService.getInitialContext(
          sessionId,
          'AuthService error',
          workspaceRoot
        );

        expect(result.success).toBe(true);
        expect(result.epicenterFile).toBe('/test/workspace/src/auth.ts');
        // Should only be called once for graph generation (deduplication worked)
        expect(mockGraphTool.execute).toHaveBeenCalledTimes(1);
      });

      it('should handle partial search failures gracefully', async () => {
        mockLLMProvider.chat.mockResolvedValue({
          type: 'success',
          payload: {
            content: JSON.stringify({
              queries: [
                { query: 'PlanningAgent', mode: 'file' },
                { query: 'PlanningAgent', mode: 'symbol' },
                { query: 'iterations', mode: 'text' }
              ]
            })
          }
        } as any);

        mockCodeSearchTool.execute
          .mockResolvedValueOnce({
            // First search fails
            success: false,
            summary: 'Search failed'
          })
          .mockResolvedValueOnce({
            // Second search succeeds
            success: true,
            structuredData: [
              { file: '/test/workspace/src/PlanningAgent.ts', score: 15, line: 1 }
            ]
          })
          .mockResolvedValueOnce({
            // Third search also fails
            success: false,
            summary: 'Search failed'
          });

        mockGraphTool.execute.mockResolvedValue({
          success: true,
          structuredData: { mermaid: '', nodes: [], edges: [] }
        });

        const result = await initialContextService.getInitialContext(
          sessionId,
          'Planning agent',
          workspaceRoot
        );

        expect(result.success).toBe(true);
        expect(result.source).toBe('search');
        // Should still find the file from the successful search
        expect(result.epicenterFile).toBe('/test/workspace/src/PlanningAgent.ts');
      });

      it('should limit queries to maximum of 3', async () => {
        mockLLMProvider.chat.mockResolvedValue({
          type: 'success',
          payload: {
            content: JSON.stringify({
              queries: [
                { query: 'query1', mode: 'file' },
                { query: 'query2', mode: 'symbol' },
                { query: 'query3', mode: 'text' },
                { query: 'query4', mode: 'file' } // Should be ignored
              ]
            })
          }
        } as any);

        mockCodeSearchTool.execute.mockResolvedValue({
          success: true,
          structuredData: []
        });

        await initialContextService.getInitialContext(
          sessionId,
          'test query',
          workspaceRoot
        );

        // Should only execute 3 searches, not 4
        expect(mockCodeSearchTool.execute).toHaveBeenCalledTimes(3);
      });

      it('should filter out invalid queries from LLM response', async () => {
        mockLLMProvider.chat.mockResolvedValue({
          type: 'success',
          payload: {
            content: JSON.stringify({
              queries: [
                { query: 'valid', mode: 'file' },
                { query: 'invalid', mode: 'invalid-mode' }, // Invalid mode
                { query: 123, mode: 'symbol' }, // Invalid query type
                { mode: 'file' }, // Missing query
                { query: 'valid2', mode: 'symbol' }
              ]
            })
          }
        } as any);

        mockCodeSearchTool.execute.mockResolvedValue({
          success: true,
          structuredData: []
        });

        await initialContextService.getInitialContext(
          sessionId,
          'test query',
          workspaceRoot
        );

        // Should only execute 2 valid queries
        expect(mockCodeSearchTool.execute).toHaveBeenCalledTimes(2);
        expect(mockCodeSearchTool.execute).toHaveBeenCalledWith({ query: 'valid', mode: 'file' });
        expect(mockCodeSearchTool.execute).toHaveBeenCalledWith({ query: 'valid2', mode: 'symbol' });
      });

      it('should return null when all searches return no results', async () => {
        const mockCost = 0.001;
        mockLLMProvider.chat.mockResolvedValue({
          type: 'success',
          payload: {
            content: JSON.stringify({
              queries: [
                { query: 'nonexistent', mode: 'file' },
                { query: 'nonexistent', mode: 'symbol' }
              ]
            }),
            cost: mockCost
          }
        } as any);

        mockCodeSearchTool.execute.mockResolvedValue({
          success: true,
          structuredData: [] // No results
        });

        const result = await initialContextService.getInitialContext(
          sessionId,
          'nonexistent query',
          workspaceRoot
        );

        expect(result.success).toBe(false);
        expect(result.source).toBe('none');
        expect(result.cost).toBe(mockCost); // Should still track cost even if no results
      });

      it('should use user selected model for LLM search', async () => {
        const model = 'gpt-4o';
        mockLLMProvider.chat.mockResolvedValue({
          type: 'success',
          payload: {
            content: '{"query": "login", "mode": "file"}'
          }
        } as any);

        mockCodeSearchTool.execute.mockResolvedValue({
          success: true,
          structuredData: [{ file: '/test/workspace/src/login.ts', score: 10 }]
        });

        mockGraphTool.execute.mockResolvedValue({
          success: true,
          structuredData: {
            mermaid: 'graph TD\nA[Login]',
            nodes: [],
            edges: []
          }
        });

        await initialContextService.getInitialContext(
          sessionId,
          userQuery,
          workspaceRoot,
          undefined,
          undefined,
          model
        );

        expect(mockLLMProvider.chat).toHaveBeenCalledWith(
          expect.objectContaining({
            model: model,
            provider: 'auto'
          })
        );
      });

      it('should handle LLM search failure gracefully', async () => {
        mockLLMProvider.chat.mockResolvedValue({
          type: 'error',
          error: 'LLM request failed'
        } as any);

        const result = await initialContextService.getInitialContext(
          sessionId,
          userQuery,
          workspaceRoot
        );

        expect(result.success).toBe(false);
        expect(result.source).toBe('none');
        expect(result.error).toContain("couldn't pinpoint");
        expect(result.cost).toBe(0); // No successful LLM call, so cost should be 0
      });
    });

    describe('graph generation', () => {
      it('should generate graph from epicenter file', async () => {
        const pinnedFiles = ['/test/workspace/src/auth.ts'];
        mockFs.existsSync.mockReturnValue(true);

        const mockGraphData = {
          mermaid: 'graph TD\nA[Auth] --> B[Login]',
          nodes: [
            { id: '1', label: 'Auth' },
            { id: '2', label: 'Login' }
          ],
          edges: [
            { from: '1', to: '2' }
          ]
        };

        mockGraphTool.execute.mockResolvedValue({
          success: true,
          structuredData: mockGraphData
        });

        const result = await initialContextService.getInitialContext(
          sessionId,
          userQuery,
          workspaceRoot,
          undefined,
          pinnedFiles
        );

        expect(result.success).toBe(true);
        expect(result.graphData).toEqual(mockGraphData);
        expect(mockGraphTool.execute).toHaveBeenCalledWith(
          expect.objectContaining({
            filePath: expect.stringContaining('auth.ts'),
            depth: 1, // Lightweight depth for fast path
            visualizationMode: 'hard-error'
          })
        );
      });

      it('should handle graph generation failure gracefully', async () => {
        const pinnedFiles = ['/test/workspace/src/auth.ts'];
        mockFs.existsSync.mockReturnValue(true);

        mockGraphTool.execute.mockRejectedValue(new Error('Graph generation failed'));

        const result = await initialContextService.getInitialContext(
          sessionId,
          userQuery,
          workspaceRoot,
          undefined,
          pinnedFiles
        );

        expect(result.success).toBe(true); // Still success because we found the file
        expect(result.epicenterFile).toBe(pinnedFiles[0]);
        expect(result.error).toContain('graph generation failed');
      });

      it('should return error if GraphContextTool not found', async () => {
        const pinnedFiles = ['/test/workspace/src/auth.ts'];
        mockFs.existsSync.mockReturnValue(true);
        (mockToolRegistry.getTool as jest.Mock).mockReturnValue(undefined);

        const result = await initialContextService.getInitialContext(
          sessionId,
          userQuery,
          workspaceRoot,
          undefined,
          pinnedFiles
        );

        expect(result.success).toBe(true);
        expect(result.error).toContain('graph generation failed');
        expect(result.cost).toBe(0); // No LLM call, so cost should be 0
      });
    });

    describe('cost tracking', () => {
      it('should track cost when LLM search is used', async () => {
        const mockCost = 0.005;
        mockLLMProvider.chat.mockResolvedValue({
          type: 'success',
          payload: {
            content: JSON.stringify({
              queries: [{ query: 'test', mode: 'file' }]
            }),
            cost: mockCost
          }
        } as any);

        mockCodeSearchTool.execute.mockResolvedValue({
          success: true,
          structuredData: [{ file: '/test/workspace/src/test.ts', score: 10 }]
        });

        mockGraphTool.execute.mockResolvedValue({
          success: true,
          structuredData: {
            mermaid: 'graph TD\nA[Test]',
            nodes: [],
            edges: []
          }
        });

        const result = await initialContextService.getInitialContext(
          sessionId,
          userQuery,
          workspaceRoot
        );

        expect(result.success).toBe(true);
        expect(result.cost).toBe(mockCost);
      });

      it('should return cost 0 when no LLM call is made (pinned files path)', async () => {
        const pinnedFiles = ['/test/workspace/src/auth.ts'];
        mockFs.existsSync.mockReturnValue(true);

        mockGraphTool.execute.mockResolvedValue({
          success: true,
          structuredData: {
            mermaid: 'graph TD\nA[Auth]',
            nodes: [],
            edges: []
          }
        });

        const result = await initialContextService.getInitialContext(
          sessionId,
          userQuery,
          workspaceRoot,
          undefined,
          pinnedFiles
        );

        expect(result.success).toBe(true);
        expect(result.cost).toBe(0);
        expect(mockLLMProvider.chat).not.toHaveBeenCalled();
      });

      it('should return cost 0 when no LLM call is made (stack trace path)', async () => {
        const logs = 'Error at /app/src/api/user.ts:15:8';
        const mockEvidence = {
          frames: [
            { file: '/app/src/api/user.ts', line: 15, fn: 'getUser', column: 8 }
          ]
        };

        jest.spyOn(EvidenceParser.prototype, 'parseEvidence').mockReturnValue(mockEvidence as any);
        mockFs.existsSync.mockReturnValue(true);

        mockGraphTool.execute.mockResolvedValue({
          success: true,
          structuredData: {
            mermaid: 'graph TD\nA[User]',
            nodes: [],
            edges: []
          }
        });

        const result = await initialContextService.getInitialContext(
          sessionId,
          userQuery,
          workspaceRoot,
          logs
        );

        expect(result.success).toBe(true);
        expect(result.cost).toBe(0);
        expect(mockLLMProvider.chat).not.toHaveBeenCalled();
      });

      it('should handle cost undefined in LLM response gracefully', async () => {
        mockLLMProvider.chat.mockResolvedValue({
          type: 'success',
          payload: {
            content: JSON.stringify({
              queries: [{ query: 'test', mode: 'file' }]
            })
            // cost is undefined
          }
        } as any);

        mockCodeSearchTool.execute.mockResolvedValue({
          success: true,
          structuredData: [{ file: '/test/workspace/src/test.ts', score: 10 }]
        });

        mockGraphTool.execute.mockResolvedValue({
          success: true,
          structuredData: {
            mermaid: 'graph TD\nA[Test]',
            nodes: [],
            edges: []
          }
        });

        const result = await initialContextService.getInitialContext(
          sessionId,
          userQuery,
          workspaceRoot
        );

        expect(result.success).toBe(true);
        expect(result.cost).toBe(0); // Should default to 0 when cost is undefined
      });
    });

    describe('error handling', () => {
      it('should return failure when no epicenter found', async () => {
        mockLLMProvider.chat.mockResolvedValue({
          type: 'error',
          error: 'LLM failed'
        } as any);

        const result = await initialContextService.getInitialContext(
          sessionId,
          userQuery,
          workspaceRoot
        );

        expect(result.success).toBe(false);
        expect(result.source).toBe('none');
        expect(result.error).toContain("couldn't pinpoint");
        expect(result.cost).toBe(0); // No successful LLM call, so cost should be 0
      });

      it('should handle invalid JSON from LLM', async () => {
        mockLLMProvider.chat.mockResolvedValue({
          type: 'success',
          payload: {
            content: 'Invalid JSON response'
          }
        } as any);

        const result = await initialContextService.getInitialContext(
          sessionId,
          userQuery,
          workspaceRoot
        );

        expect(result.success).toBe(false);
      });
    });
  });
});

