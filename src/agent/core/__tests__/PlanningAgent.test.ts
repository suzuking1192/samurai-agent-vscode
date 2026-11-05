/**
 * Tests for PlanningAgent
 */

import * as fs from 'fs';
import * as path from 'path';
import { PlanningAgent, AgentContext } from '../PlanningAgent';
import { ToolRegistry } from '../../tools/ToolRegistry';
import { LLMProviderService } from '../../llm/llmProviderService';
import { Session } from '../../../common/models/chat-models';
import { LLMResponse } from '../../../common/models/llm-models';
import { ResponseType } from '../../../common/models/response-models';
import { StreamReporter } from '../../utils/StreamReporter';
import { DebugSessionLogger } from '../../utils/DebugSessionLogger';

// Mock dependencies
jest.mock('../../tools/debugging/promptLoader', () => ({
  loadDebuggingPrompt: jest.fn((fileName: string) => {
    if (fileName === 'planning_agent_system.md') {
      return `You are Samurai, an expert TypeScript/JavaScript Debugging Agent.

## CORE OBJECTIVE

**User Request:** "{{USER_QUERY}}"

Your ONLY goal is to satisfy this specific request.

## CURRENT CONTEXT

{{INVESTIGATION_BOARD}}

## AVAILABLE TOOLS

{{TOOLS_MANUAL}}

## STRATEGIC RULES (Common Pitfalls)

{{STRATEGIC_RULES}}

## RESPONSE FORMAT (JSON ONLY)

{
  "thought": "...",
  "state_update": {
    "new_facts": [],
    "hypothesis_updates": [],
    "new_hypotheses": []
  },
  "call_tools": [
    { "name": "...", "arguments": {...} }
  ]
}

OR

{
  "thought": "...",
  "state_update": {...},
  "final_response": "..."
}`;
    }
    throw new Error(`Prompt file not found: ${fileName}`);
  })
}));

jest.mock('../../utils/DebugSessionLogger', () => ({
  DebugSessionLogger: jest.fn()
}));

describe('PlanningAgent', () => {
  let planningAgent: PlanningAgent;
  let mockToolRegistry: jest.Mocked<ToolRegistry>;
  let mockLLMProvider: jest.Mocked<LLMProviderService>;
  let mockWebviewProvider: any;
  let mockLogger: jest.Mocked<DebugSessionLogger>;

  beforeEach(() => {
    jest.clearAllMocks();
    
    // Setup logger mock
    mockLogger = {
      logUserRequest: jest.fn(),
      logEpicenter: jest.fn(),
      logGraph: jest.fn(),
      logStep: jest.fn(),
      generateSummary: jest.fn(),
      logParseFailure: jest.fn()
    } as any;

    mockToolRegistry = {
      getToolDefinitions: jest.fn(() => [
        {
          name: 'static-analysis',
          description: 'Analyzes code structure',
          parameters: {
            type: 'object',
            properties: {
              filePath: { type: 'string', description: 'Path to file' },
              mode: { 
                type: 'string',
                enum: ['metrics', 'source', 'flow'],
                description: 'Analysis mode'
              }
            },
            required: ['filePath', 'mode']
          }
        },
        {
          name: 'code-search',
          description: 'Searches for files or symbols',
          parameters: {
            type: 'object',
            properties: {
              query: { type: 'string', description: 'Search term' },
              mode: {
                type: 'string',
                enum: ['file', 'symbol', 'text'],
                description: 'Search mode'
              },
              pattern: { type: 'string', description: 'Optional glob pattern' }
            },
            required: ['query', 'mode']
          }
        }
      ]),
      getPlanningTools: jest.fn(() => []),
      getTool: jest.fn(() => ({ setModel: jest.fn() }))
    } as any;

    mockLLMProvider = {
      chat: jest.fn()
    } as any;

    mockWebviewProvider = {
      postMessage: jest.fn()
    };

    planningAgent = new PlanningAgent(
      mockToolRegistry,
      mockLLMProvider,
      mockWebviewProvider
    );
  });

  describe('execute', () => {
    const mockSession: Session = {
      id: 'test-session',
      title: 'Test',
      status: 'active' as any,
      messageCount: 0,
      totalTokens: 0,
      totalCost: 0,
      lastMessageAt: new Date(),
      tags: [],
      metadata: {
        projectId: 'test-project',
        model: 'gpt-4o'
      },
      codeContextIds: [],
      previous_session_intent: 'pure_discussion' as any,
      pinnedFilePaths: [],
      createdAt: new Date(),
      updatedAt: new Date()
    };

    const mockContext: AgentContext = {
      initialEpicenter: '/test/src/auth.ts',
      initialGraph: {
        mermaid: 'graph TD\nA[Auth] --> B[Login]'
      }
    };

    it('should initialize state correctly', async () => {
      const mockLLMResponse: LLMResponse = {
        id: 'response-1',
        requestId: 'step-0',
        provider: 'openai',
        model: 'gpt-4o',
        content: JSON.stringify({
          thought: 'I will analyze the code.',
          final_response: 'I will analyze the code.'
        }),
        usage: {
          promptTokens: 100,
          completionTokens: 50,
          totalTokens: 150
        },
        cost: 0,
        processingTime: 100,
        metadata: {},
        createdAt: new Date(),
        updatedAt: new Date()
      };

      (mockLLMProvider.chat as jest.Mock).mockResolvedValue({
        type: ResponseType.SUCCESS,
        payload: mockLLMResponse,
        timestamp: new Date()
      });

      const result = await planningAgent.execute(
        'Why is login failing?',
        mockSession,
        undefined,
        mockContext,
        undefined,
        mockLogger
      );

      expect(result.message).toBe('I will analyze the code.');
      expect(result.visualizationData?.visualization).toBe(mockContext.initialGraph.mermaid);
      expect(result.finalEpicenter).toBe(mockContext.initialEpicenter);
      
      // Verify logger was called
      expect(mockLogger.logStep).toHaveBeenCalledWith(0, 'response', mockLLMResponse);
      expect(mockLogger.logStep).toHaveBeenCalledWith(0, 'state', expect.any(Object));
      expect(mockLogger.generateSummary).toHaveBeenCalledWith({
        steps: 1,
        cost: 0,
        filesAnalyzed: expect.any(Array)
      });
    });

    it('should detect completion signal and break early', async () => {
      const mockLLMResponse: LLMResponse = {
        id: 'response-1',
        requestId: 'step-0',
        provider: 'openai',
        model: 'gpt-4o',
        content: JSON.stringify({
          thought: 'I found the root cause',
          final_response: 'I found the root cause: missing await statement.'
        }),
        usage: {
          promptTokens: 100,
          completionTokens: 50,
          totalTokens: 150
        },
        cost: 0,
        processingTime: 100,
        metadata: {},
        createdAt: new Date(),
        updatedAt: new Date()
      };

      (mockLLMProvider.chat as jest.Mock).mockResolvedValue({
        type: ResponseType.SUCCESS,
        payload: mockLLMResponse,
        timestamp: new Date()
      });

      const result = await planningAgent.execute(
        'Why is login failing?',
        mockSession,
        undefined,
        mockContext
      );

      expect(result.message).toContain('root cause');
      expect(mockLLMProvider.chat).toHaveBeenCalledTimes(1);
    });

    it('should handle LLM call failure gracefully', async () => {
      (mockLLMProvider.chat as jest.Mock).mockResolvedValue({
        type: ResponseType.ERROR,
        error: 'API key invalid',
        timestamp: new Date()
      });

      const result = await planningAgent.execute(
        'Why is login failing?',
        mockSession,
        undefined,
        mockContext
      );

      expect(result.message).toContain('Analysis failed');
      expect(result.message).toContain('API key invalid');
    });

    it('should extract tool calls from JSON response format', async () => {
      const mockLLMResponse: LLMResponse = {
        id: 'response-1',
        requestId: 'step-0',
        provider: 'openai',
        model: 'gpt-4o',
        content: JSON.stringify({
          thought: 'I need to analyze the code.',
          call_tools: [
            {
              name: 'static-analysis',
              arguments: { filePath: 'auth.ts', mode: 'flow' }
            }
          ]
        }),
        usage: {
          promptTokens: 100,
          completionTokens: 50,
          totalTokens: 150
        },
        cost: 0,
        processingTime: 100,
        metadata: {},
        createdAt: new Date(),
        updatedAt: new Date()
      };

      (mockLLMProvider.chat as jest.Mock).mockResolvedValueOnce({
        type: ResponseType.SUCCESS,
        payload: mockLLMResponse,
        timestamp: new Date()
      });

      // Mock tool execution
      const mockTool = {
        name: 'static-analysis',
        execute: jest.fn().mockResolvedValue({
          success: true,
          summary: 'Analysis complete'
        })
      };

      (mockToolRegistry.getTool as jest.Mock) = jest.fn().mockReturnValue(mockTool);

      // Second call - completion
      (mockLLMProvider.chat as jest.Mock).mockResolvedValueOnce({
        type: ResponseType.SUCCESS,
        payload: {
          id: 'response-2',
          requestId: 'step-1',
          provider: 'openai',
          model: 'gpt-4o',
          content: JSON.stringify({
            thought: 'Done',
            final_response: 'Analysis complete'
          }),
          usage: { promptTokens: 100, completionTokens: 50, totalTokens: 150 },
          cost: 0.001,
          processingTime: 100,
          metadata: {},
          createdAt: new Date(),
          updatedAt: new Date()
        },
        timestamp: new Date()
      });

      const result = await planningAgent.execute(
        'Why is login failing?',
        mockSession,
        undefined,
        mockContext
      );

      // Should continue execution after tool call
      expect(mockLLMProvider.chat).toHaveBeenCalled();
      expect(mockTool.execute).toHaveBeenCalledWith({ filePath: 'auth.ts', mode: 'flow' });
    });

    it('should stop when no tool calls are returned', async () => {
      const mockLLMResponse: LLMResponse = {
        id: 'response-1',
        requestId: 'step-0',
        provider: 'openai',
        model: 'gpt-4o',
        content: JSON.stringify({
          thought: 'Analysis complete. The issue is fixed.'
        }),
        usage: {
          promptTokens: 100,
          completionTokens: 50,
          totalTokens: 150
        },
        cost: 0,
        processingTime: 100,
        metadata: {},
        createdAt: new Date(),
        updatedAt: new Date()
      };

      (mockLLMProvider.chat as jest.Mock).mockResolvedValue({
        type: ResponseType.SUCCESS,
        payload: mockLLMResponse,
        timestamp: new Date()
      });

      const result = await planningAgent.execute(
        'Why is login failing?',
        mockSession,
        undefined,
        mockContext
      );

      expect(result.message).toContain('Analysis complete');
      expect(mockLLMProvider.chat).toHaveBeenCalledTimes(1);
    });

    it('should respect MAX_STEPS limit and return graceful degradation report', async () => {
      // Mock tool
      const mockTool = {
        name: 'static-analysis',
        execute: jest.fn().mockResolvedValue({
          success: true,
          summary: 'Analysis complete',
          evidence: []
        })
      };

      (mockToolRegistry.getTool as jest.Mock) = jest.fn().mockReturnValue(mockTool);

      // Return tool calls for all MAX_STEPS (15)
      // After MAX_STEPS, the loop should exit with graceful degradation message
      let stepCount = 0;
      (mockLLMProvider.chat as jest.Mock).mockImplementation((request: any) => {
        stepCount++;
        
        // Main loop calls - always return tool calls to force continuation
        // Use new JSON format with state_update and call_tools
        // First step: create hypothesis and fact
        // Subsequent steps: continue with tools but don't add new state (to keep it simple)
        const isFirstStep = stepCount === 1;
        return Promise.resolve({
          type: ResponseType.SUCCESS,
          payload: {
            id: `response-${stepCount}`,
            requestId: `step-${stepCount - 1}`,
            provider: 'openai',
            model: 'gpt-4o',
            content: JSON.stringify({
              thought: `Analyzing step ${stepCount}...`,
              state_update: {
                new_facts: isFirstStep ? ['Initial fact discovered: saveUser returns Promise'] : [],
                hypothesis_updates: isFirstStep ? [] : [],
                new_hypotheses: isFirstStep ? [
                  { description: 'Potential race condition in saveUser function', confidence: 0.7 }
                ] : []
              },
              call_tools: [
                {
                  name: 'static-analysis',
                  arguments: { filePath: '/test/src/auth.ts', mode: 'flow' }
                }
              ]
            }),
            usage: { promptTokens: 100, completionTokens: 50, totalTokens: 150 },
            cost: 0.001,
            processingTime: 100,
            metadata: {},
            createdAt: new Date(),
            updatedAt: new Date()
          },
          timestamp: new Date()
        });
      });

      const result = await planningAgent.execute(
        'Why is login failing?',
        mockSession,
        undefined,
        mockContext,
        undefined,
        mockLogger
      );

      // After MAX_STEPS, should return graceful degradation message
      expect(result.message).toContain('Analysis Paused (Step Limit Reached)');
      expect(result.message).toContain('maximum iteration limit');
      expect(result.message).toContain('intermediate results');
      
      // Should include required sections (last action, facts, recommended next step)
      expect(result.message).toContain('Last Action');
      expect(result.message).toContain('Confirmed Facts');
      expect(result.message).toContain('Recommended Next Step');
      
      // Active Hypothesis section is optional (only appears if there's an active hypothesis)
      // In this test, we create a hypothesis but don't set it as active, so the section may not appear
      
      // Should have isTimeout flag in metadata
      expect(result.metadata?.isTimeout).toBe(true);
      expect(result.metadata?.stepsTaken).toBe(25);
      
      expect(mockLLMProvider.chat).toHaveBeenCalled();
    });

    it('should use session model or fallback to gpt-4o', async () => {
      const sessionWithModel: Session = {
        ...mockSession,
        metadata: {
          ...mockSession.metadata,
          model: 'gpt-4-turbo'
        }
      };

      const mockLLMResponse: LLMResponse = {
        id: 'response-1',
        requestId: 'step-0',
        provider: 'openai',
        model: 'gpt-4-turbo',
        content: 'Done',
        usage: {
          promptTokens: 100,
          completionTokens: 50,
          totalTokens: 150
        },
        cost: 0,
        processingTime: 100,
        metadata: {
          rawResponse: {
            choices: [{
              message: {
                content: 'Done',
                tool_calls: []
              }
            }]
          }
        },
        createdAt: new Date(),
        updatedAt: new Date()
      };

      (mockLLMProvider.chat as jest.Mock).mockResolvedValue({
        type: ResponseType.SUCCESS,
        payload: mockLLMResponse,
        timestamp: new Date()
      });

      await planningAgent.execute(
        'Why is login failing?',
        sessionWithModel,
        undefined,
        mockContext
      );

      expect(mockLLMProvider.chat).toHaveBeenCalledWith(
        expect.objectContaining({
          model: 'gpt-4-turbo'
        })
      );
    });

    it('should fallback to gpt-4o when session model is not set', async () => {
      const sessionWithoutModel: Session = {
        ...mockSession,
        metadata: {
          projectId: 'test-project'
        }
      };

      const mockLLMResponse: LLMResponse = {
        id: 'response-1',
        requestId: 'step-0',
        provider: 'openai',
        model: 'gpt-4o',
        content: 'Done',
        usage: {
          promptTokens: 100,
          completionTokens: 50,
          totalTokens: 150
        },
        cost: 0,
        processingTime: 100,
        metadata: {
          rawResponse: {
            choices: [{
              message: {
                content: 'Done',
                tool_calls: []
              }
            }]
          }
        },
        createdAt: new Date(),
        updatedAt: new Date()
      };

      (mockLLMProvider.chat as jest.Mock).mockResolvedValue({
        type: ResponseType.SUCCESS,
        payload: mockLLMResponse,
        timestamp: new Date()
      });

      await planningAgent.execute(
        'Why is login failing?',
        sessionWithoutModel,
        undefined,
        mockContext
      );

      expect(mockLLMProvider.chat).toHaveBeenCalledWith(
        expect.objectContaining({
          model: 'gpt-4o'
        })
      );
    });

    describe('metadata tracking', () => {
      it('should track cost from LLM calls', async () => {
        const mockLLMResponse: LLMResponse = {
          id: 'response-1',
          requestId: 'step-0',
          provider: 'openai',
          model: 'gpt-4o',
          content: 'Analysis complete. The issue is fixed.',
          usage: {
            promptTokens: 100,
            completionTokens: 50,
            totalTokens: 150
          },
          cost: 0.0025,
          processingTime: 100,
          metadata: {
            rawResponse: {
              choices: [{
                message: {
                  content: 'Analysis complete. The issue is fixed.',
                  tool_calls: undefined
                }
              }]
            }
          },
          createdAt: new Date(),
          updatedAt: new Date()
        };

        (mockLLMProvider.chat as jest.Mock).mockResolvedValue({
          type: ResponseType.SUCCESS,
          payload: mockLLMResponse,
          timestamp: new Date()
        });

        const result = await planningAgent.execute(
          'Why is login failing?',
          mockSession,
          undefined,
          mockContext
        );

        expect(result.metadata).toBeDefined();
        expect(result.metadata?.cost).toBe(0.0025);
        expect(result.metadata?.stepsTaken).toBe(1);
      });

      it('should track files analyzed from epicenter', async () => {
        const mockLLMResponse: LLMResponse = {
          id: 'response-1',
          requestId: 'step-0',
          provider: 'openai',
          model: 'gpt-4o',
          content: 'Done',
          usage: {
            promptTokens: 100,
            completionTokens: 50,
            totalTokens: 150
          },
          cost: 0.001,
          processingTime: 100,
          metadata: {
            rawResponse: {
              choices: [{
                message: {
                  content: 'Done',
                  tool_calls: []
                }
              }]
            }
          },
          createdAt: new Date(),
          updatedAt: new Date()
        };

        (mockLLMProvider.chat as jest.Mock).mockResolvedValue({
          type: ResponseType.SUCCESS,
          payload: mockLLMResponse,
          timestamp: new Date()
        });

        const result = await planningAgent.execute(
          'Why is login failing?',
          mockSession,
          undefined,
          mockContext
        );

        expect(result.metadata?.filesAnalyzed).toContain('/test/src/auth.ts');
      });

      it('should track files from tool call arguments', async () => {
        const mockLLMResponse: LLMResponse = {
          id: 'response-1',
          requestId: 'step-0',
          provider: 'openai',
          model: 'gpt-4o',
          content: JSON.stringify({
            thought: 'I need to analyze the code.',
            call_tools: [
              { name: 'static-analysis', arguments: { filePath: 'src/user.ts' } },
              { name: 'graph-context', arguments: { filePath: 'src/payment.ts' } }
            ]
          }),
          usage: {
            promptTokens: 100,
            completionTokens: 50,
            totalTokens: 150
          },
          cost: 0.001,
          processingTime: 100,
          metadata: {},
          createdAt: new Date(),
          updatedAt: new Date()
        };

        (mockLLMProvider.chat as jest.Mock).mockResolvedValueOnce({
          type: ResponseType.SUCCESS,
          payload: mockLLMResponse,
          timestamp: new Date()
        });

        // Mock tool execution - need both tools
        const mockStaticAnalysisTool = {
          name: 'static-analysis',
          execute: jest.fn().mockResolvedValue({
            success: true,
            summary: 'Analysis complete'
          })
        };

        const mockGraphContextTool = {
          name: 'graph-context',
          execute: jest.fn().mockResolvedValue({
            success: true,
            summary: 'Graph built'
          })
        };

        (mockToolRegistry.getTool as jest.Mock) = jest.fn((toolName: string) => {
          if (toolName === 'static-analysis') return mockStaticAnalysisTool;
          if (toolName === 'graph-context') return mockGraphContextTool;
          return null;
        });

        // Second LLM call (completion)
        (mockLLMProvider.chat as jest.Mock).mockResolvedValueOnce({
          type: ResponseType.SUCCESS,
          payload: {
            id: 'response-2',
            requestId: 'step-1',
            provider: 'openai',
            model: 'gpt-4o',
            content: JSON.stringify({
              thought: 'Done',
              final_response: 'Analysis complete'
            }),
            usage: { promptTokens: 100, completionTokens: 50, totalTokens: 150 },
            cost: 0.001,
            processingTime: 100,
            metadata: {},
            createdAt: new Date(),
            updatedAt: new Date()
          },
          timestamp: new Date()
        });

        const result = await planningAgent.execute(
          'Why is login failing?',
          mockSession,
          undefined,
          mockContext
        );

        expect(result.metadata?.filesAnalyzed).toContain('/test/src/auth.ts'); // epicenter
        expect(result.metadata?.filesAnalyzed).toContain('src/user.ts');
        expect(result.metadata?.filesAnalyzed).toContain('src/payment.ts');
      });

      it('should track files from tool result evidence', async () => {
        const mockLLMResponse: LLMResponse = {
          id: 'response-1',
          requestId: 'step-0',
          provider: 'openai',
          model: 'gpt-4o',
          content: JSON.stringify({
            thought: 'Analyzing...',
            call_tools: [
              { name: 'static-analysis', arguments: { filePath: 'src/auth.ts' } }
            ]
          }),
          usage: {
            promptTokens: 100,
            completionTokens: 50,
            totalTokens: 150
          },
          cost: 0.001,
          processingTime: 100,
          metadata: {},
          createdAt: new Date(),
          updatedAt: new Date()
        };

        (mockLLMProvider.chat as jest.Mock).mockResolvedValueOnce({
          type: ResponseType.SUCCESS,
          payload: mockLLMResponse,
          timestamp: new Date()
        });

        // Mock tool execution that returns evidence with file paths
        const mockTool = {
          name: 'static-analysis',
          execute: jest.fn().mockResolvedValue({
            success: true,
            summary: 'Analysis complete',
            evidence: [
              { file: 'src/helper.ts', line: 10, text: 'code' },
              { file: 'src/utils.ts', line: 20, text: 'more code' }
            ]
          })
        };

        (mockToolRegistry.getTool as jest.Mock) = jest.fn().mockReturnValue(mockTool);

        // Second LLM call (completion)
        (mockLLMProvider.chat as jest.Mock).mockResolvedValueOnce({
          type: ResponseType.SUCCESS,
          payload: {
            id: 'response-2',
            requestId: 'step-1',
            provider: 'openai',
            model: 'gpt-4o',
            content: JSON.stringify({
              thought: 'Done',
              final_response: 'Analysis complete'
            }),
            usage: { promptTokens: 100, completionTokens: 50, totalTokens: 150 },
            cost: 0.001,
            processingTime: 100,
            metadata: {},
            createdAt: new Date(),
            updatedAt: new Date()
          },
          timestamp: new Date()
        });

        const result = await planningAgent.execute(
          'Why is login failing?',
          mockSession,
          undefined,
          mockContext
        );

        expect(result.metadata?.filesAnalyzed).toContain('src/helper.ts');
        expect(result.metadata?.filesAnalyzed).toContain('src/utils.ts');
      });

      it('should accumulate costs from multiple LLM calls including state updates', async () => {
        const mockLLMResponse: LLMResponse = {
          id: 'response-1',
          requestId: 'step-0',
          provider: 'openai',
          model: 'gpt-4o',
          content: JSON.stringify({
            thought: 'Analyzing...',
            call_tools: [
              { name: 'static-analysis', arguments: { filePath: 'src/auth.ts' } }
            ]
          }),
          usage: {
            promptTokens: 100,
            completionTokens: 50,
            totalTokens: 150
          },
          cost: 0.002,
          processingTime: 100,
          metadata: {},
          createdAt: new Date(),
          updatedAt: new Date()
        };

        (mockLLMProvider.chat as jest.Mock).mockResolvedValueOnce({
          type: ResponseType.SUCCESS,
          payload: mockLLMResponse,
          timestamp: new Date()
        });

        const mockTool = {
          name: 'static-analysis',
          execute: jest.fn().mockResolvedValue({
            success: true,
            summary: 'Analysis complete'
          })
        };

        (mockToolRegistry.getTool as jest.Mock) = jest.fn().mockReturnValue(mockTool);

        // Second LLM call (completion)
        (mockLLMProvider.chat as jest.Mock).mockResolvedValueOnce({
          type: ResponseType.SUCCESS,
          payload: {
            id: 'response-2',
            requestId: 'step-1',
            provider: 'openai',
            model: 'gpt-4o',
            content: JSON.stringify({
              thought: 'Done',
              final_response: 'Analysis complete'
            }),
            usage: { promptTokens: 100, completionTokens: 50, totalTokens: 150 },
            cost: 0.001,
            processingTime: 100,
            metadata: {},
            createdAt: new Date(),
            updatedAt: new Date()
          },
          timestamp: new Date()
        });

        const result = await planningAgent.execute(
          'Why is login failing?',
          mockSession,
          undefined,
          mockContext
        );

        // Total cost: 0.002 (first call) + 0.001 (second call) = 0.003
        expect(result.metadata?.cost).toBeCloseTo(0.003, 5);
        expect(result.metadata?.stepsTaken).toBe(2);
      });

      it('should include metadata in all return paths', async () => {
        // Test error return path
        (mockLLMProvider.chat as jest.Mock).mockResolvedValue({
          type: ResponseType.ERROR,
          error: 'API error',
          timestamp: new Date()
        });

        const errorResult = await planningAgent.execute(
          'Why is login failing?',
          mockSession,
          undefined,
          mockContext
        );

        expect(errorResult.metadata).toBeDefined();
        expect(errorResult.metadata?.stepsTaken).toBe(0);
        expect(errorResult.metadata?.cost).toBe(0);
        expect(errorResult.metadata?.filesAnalyzed).toContain('/test/src/auth.ts');

        // Test completion signal return path
        const completionResponse: LLMResponse = {
          id: 'response-1',
          requestId: 'step-0',
          provider: 'openai',
          model: 'gpt-4o',
          content: 'I found the root cause: missing await.',
          usage: {
            promptTokens: 100,
            completionTokens: 50,
            totalTokens: 150
          },
          cost: 0.002,
          processingTime: 100,
          metadata: {
            rawResponse: {
              choices: [{
                message: {
                  content: 'I found the root cause: missing await.',
                  tool_calls: []
                }
              }]
            }
          },
          createdAt: new Date(),
          updatedAt: new Date()
        };

        (mockLLMProvider.chat as jest.Mock).mockResolvedValue({
          type: ResponseType.SUCCESS,
          payload: completionResponse,
          timestamp: new Date()
        });

        const completionResult = await planningAgent.execute(
          'Why is login failing?',
          mockSession,
          undefined,
          mockContext
        );

        expect(completionResult.metadata).toBeDefined();
        expect(completionResult.metadata?.stepsTaken).toBe(1);
        expect(completionResult.metadata?.cost).toBe(0.002);
      });

      it('should reset tracking variables between executions', async () => {
        const mockLLMResponse: LLMResponse = {
          id: 'response-1',
          requestId: 'step-0',
          provider: 'openai',
          model: 'gpt-4o',
          content: 'Done',
          usage: {
            promptTokens: 100,
            completionTokens: 50,
            totalTokens: 150
          },
          cost: 0.001,
          processingTime: 100,
          metadata: {
            rawResponse: {
              choices: [{
                message: {
                  content: 'Done',
                  tool_calls: []
                }
              }]
            }
          },
          createdAt: new Date(),
          updatedAt: new Date()
        };

        (mockLLMProvider.chat as jest.Mock).mockResolvedValue({
          type: ResponseType.SUCCESS,
          payload: mockLLMResponse,
          timestamp: new Date()
        });

        // First execution
        const result1 = await planningAgent.execute(
          'First query',
          mockSession,
          undefined,
          mockContext
        );

        expect(result1.metadata?.cost).toBe(0.001);

        // Second execution - should start fresh
        const result2 = await planningAgent.execute(
          'Second query',
          mockSession,
          undefined,
          mockContext
        );

        expect(result2.metadata?.cost).toBe(0.001); // Not accumulated from first
        expect(result2.metadata?.stepsTaken).toBe(1);
      });
    });

    describe('StreamReporter integration', () => {
      let mockReporter: jest.Mocked<StreamReporter>;

      beforeEach(() => {
        mockReporter = {
          report: jest.fn()
        } as any;
      });

      it('should emit thought events before LLM calls', async () => {
        const mockLLMResponse: LLMResponse = {
          id: 'response-1',
          requestId: 'step-0',
          provider: 'openai',
          model: 'gpt-4o',
          content: 'I will analyze the code.',
          usage: {
            promptTokens: 100,
            completionTokens: 50,
            totalTokens: 150
          },
          cost: 0,
          processingTime: 100,
          metadata: {
            rawResponse: {
              choices: [{
                message: {
                  content: 'I will analyze the code.',
                  tool_calls: []
                }
              }]
            }
          },
          createdAt: new Date(),
          updatedAt: new Date()
        };

        (mockLLMProvider.chat as jest.Mock).mockResolvedValue({
          type: ResponseType.SUCCESS,
          payload: mockLLMResponse,
          timestamp: new Date()
        });

        await planningAgent.execute(
          'Why is login failing?',
          mockSession,
          undefined,
          mockContext,
          mockReporter
        );

        // Should emit thought before LLM call
        expect(mockReporter.report).toHaveBeenCalled();
        const thoughtCall = (mockReporter.report as jest.Mock).mock.calls.find(
          (call: any[]) => call[0] === 'thought'
        );
        expect(thoughtCall).toBeDefined();
      });

      it('should emit tool call events when tools are called', async () => {
        // First call - tool invocation
        (mockLLMProvider.chat as jest.Mock).mockResolvedValueOnce({
          type: ResponseType.SUCCESS,
          payload: {
            id: 'response-1',
            requestId: 'step-0',
            provider: 'openai',
            model: 'gpt-4o',
            content: JSON.stringify({
              thought: 'I need to analyze the code.',
              call_tools: [
                { name: 'static-analysis', arguments: { filePath: '/test/src/auth.ts' } }
              ]
            }),
            usage: { promptTokens: 100, completionTokens: 50, totalTokens: 150 },
            cost: 0,
            processingTime: 100,
            metadata: {},
            createdAt: new Date(),
            updatedAt: new Date()
          },
          timestamp: new Date()
        });

        // Mock tool execution
        const mockTool = {
          name: 'static-analysis',
          execute: jest.fn().mockResolvedValue({
            success: true,
            summary: 'Analysis complete'
          })
        };

        (mockToolRegistry.getTool as jest.Mock) = jest.fn().mockReturnValue(mockTool);

        // Second call - completion
        (mockLLMProvider.chat as jest.Mock).mockResolvedValueOnce({
          type: ResponseType.SUCCESS,
          payload: {
            id: 'response-2',
            requestId: 'step-1',
            provider: 'openai',
            model: 'gpt-4o',
            content: JSON.stringify({
              thought: 'Done',
              final_response: 'Analysis complete'
            }),
            usage: { promptTokens: 100, completionTokens: 50, totalTokens: 150 },
            cost: 0,
            processingTime: 100,
            metadata: {},
            createdAt: new Date(),
            updatedAt: new Date()
          },
          timestamp: new Date()
        });

        await planningAgent.execute(
          'Why is login failing?',
          mockSession,
          undefined,
          mockContext,
          mockReporter
        );

        // Should emit tool call event
        const toolCall = (mockReporter.report as jest.Mock).mock.calls.find(
          (call: any[]) => call[0] === 'tool'
        );
        expect(toolCall).toBeDefined();
        expect(toolCall[1]).toContain('static-analysis');

        // Should include filename in message
        expect(toolCall[1]).toContain('auth.ts');
      });

      it('should work without StreamReporter (backward compatibility)', async () => {
        const mockLLMResponse: LLMResponse = {
          id: 'response-1',
          requestId: 'step-0',
          provider: 'openai',
          model: 'gpt-4o',
          content: 'I will analyze the code.',
          usage: {
            promptTokens: 100,
            completionTokens: 50,
            totalTokens: 150
          },
          cost: 0,
          processingTime: 100,
          metadata: {
            rawResponse: {
              choices: [{
                message: {
                  content: 'I will analyze the code.',
                  tool_calls: []
                }
              }]
            }
          },
          createdAt: new Date(),
          updatedAt: new Date()
        };

        (mockLLMProvider.chat as jest.Mock).mockResolvedValue({
          type: ResponseType.SUCCESS,
          payload: mockLLMResponse,
          timestamp: new Date()
        });

        // Should work without reporter (undefined)
        const result = await planningAgent.execute(
          'Why is login failing?',
          mockSession,
          undefined,
          mockContext,
          undefined
        );

        expect(result.message).toBe('I will analyze the code.');
      });

      it('should extract filename from tool call arguments for status message', async () => {
        // First call - tool invocation
        (mockLLMProvider.chat as jest.Mock).mockResolvedValueOnce({
          type: ResponseType.SUCCESS,
          payload: {
            id: 'response-1',
            requestId: 'step-0',
            provider: 'openai',
            model: 'gpt-4o',
            content: JSON.stringify({
              thought: 'I need to analyze the code.',
              call_tools: [
                { name: 'static-analysis', arguments: { filePath: '/very/long/path/src/user.ts' } }
              ]
            }),
            usage: { promptTokens: 100, completionTokens: 50, totalTokens: 150 },
            cost: 0,
            processingTime: 100,
            metadata: {},
            createdAt: new Date(),
            updatedAt: new Date()
          },
          timestamp: new Date()
        });

        const mockTool = {
          name: 'static-analysis',
          execute: jest.fn().mockResolvedValue({
            success: true,
            summary: 'Analysis complete'
          })
        };

        (mockToolRegistry.getTool as jest.Mock) = jest.fn().mockReturnValue(mockTool);

        // Second call - completion
        (mockLLMProvider.chat as jest.Mock).mockResolvedValueOnce({
          type: ResponseType.SUCCESS,
          payload: {
            id: 'response-2',
            requestId: 'step-1',
            provider: 'openai',
            model: 'gpt-4o',
            content: JSON.stringify({
              thought: 'Done',
              final_response: 'Analysis complete'
            }),
            usage: { promptTokens: 100, completionTokens: 50, totalTokens: 150 },
            cost: 0,
            processingTime: 100,
            metadata: {},
            createdAt: new Date(),
            updatedAt: new Date()
          },
          timestamp: new Date()
        });

        await planningAgent.execute(
          'Why is login failing?',
          mockSession,
          undefined,
          mockContext,
          mockReporter
        );

        const toolCall = (mockReporter.report as jest.Mock).mock.calls.find(
          (call: any[]) => call[0] === 'tool'
        );

        // Should extract just the filename, not the full path
        expect(toolCall[1]).toContain('user.ts');
        expect(toolCall[1]).not.toContain('/very/long/path');
      });
    });

    describe('graph-context integration', () => {
      it('should not send debugGraphUpdate when visualization is disabled', async () => {
        const mockLLMResponse: LLMResponse = {
          id: 'response-1',
          requestId: 'step-0',
          provider: 'openai',
          model: 'gpt-4o',
          content: 'I need to build a graph.',
          usage: {
            promptTokens: 100,
            completionTokens: 50,
            totalTokens: 150
          },
          cost: 0,
          processingTime: 100,
          metadata: {
            rawResponse: {
              choices: [{
                message: {
                  content: 'I need to build a graph.',
                  tool_calls: [
                    {
                      id: 'call-1',
                      type: 'function',
                      function: {
                        name: 'graph-context',
                        arguments: JSON.stringify({ filePath: '/test/src/Database.ts' })
                      }
                    }
                  ]
                }
              }]
            }
          },
          createdAt: new Date(),
          updatedAt: new Date()
        };

        // First main-loop LLM call returns a graph-context tool call
        (mockLLMProvider.chat as jest.Mock).mockResolvedValueOnce({
          type: ResponseType.SUCCESS,
          payload: mockLLMResponse,
          timestamp: new Date()
        });

        // Mock tools: we only care about graph-context here
        const mockGraphContextTool = {
          name: 'graph-context',
          execute: jest.fn().mockResolvedValue({
            success: true,
            summary: 'Graph built',
            structuredData: {
              mermaid: 'graph TD\nDB[Database] --> U[User]',
              nodes: [
                {
                  id: 'node-1',
                  file: '/test/src/Database.ts',
                  badges: ['spine']
                }
              ],
              edges: [],
              isValid: true
            }
          })
        };

        (mockToolRegistry.getTool as jest.Mock) = jest.fn((toolName: string) => {
          if (toolName === 'graph-context') return mockGraphContextTool as any;
          return null;
        });

        // State update call for the single tool result
        (mockLLMProvider.chat as jest.Mock).mockResolvedValueOnce({
          type: ResponseType.SUCCESS,
          payload: {
            id: 'state-update-0',
            requestId: 'state-update-0',
            provider: 'openai',
            model: 'gpt-4o',
            content: JSON.stringify({
              facts: [],
              hypotheses: [],
              active_hypothesis_id: null,
              thought_step: {
                step: 0,
                timestamp: Date.now(),
                reasoning: 'test',
                action: 'graph-context',
                observation: 'graph built',
                outcome: 'test'
              },
              next_step: 'finish'
            }),
            usage: { promptTokens: 50, completionTokens: 50, totalTokens: 100 },
            cost: 0,
            processingTime: 50,
            metadata: {},
            createdAt: new Date(),
            updatedAt: new Date()
          },
          timestamp: new Date()
        });

        // Second main-loop LLM call: no tools, completion
        const mockLLMResponse2: LLMResponse = {
          id: 'response-2',
          requestId: 'step-1',
          provider: 'openai',
          model: 'gpt-4o',
          content: 'Done',
          usage: {
            promptTokens: 100,
            completionTokens: 50,
            totalTokens: 150
          },
          cost: 0,
          processingTime: 100,
          metadata: {
            rawResponse: {
              choices: [{
                message: {
                  content: 'Done',
                  tool_calls: []
                }
              }]
            }
          },
          createdAt: new Date(),
          updatedAt: new Date()
        };

        (mockLLMProvider.chat as jest.Mock).mockResolvedValueOnce({
          type: ResponseType.SUCCESS,
          payload: mockLLMResponse2,
          timestamp: new Date()
        });

        await planningAgent.execute(
          'Why is login failing?',
          mockSession,
          undefined,
          mockContext
        );

        // Live graph updates are disabled: no debugGraphUpdate should be sent
        expect(mockWebviewProvider.postMessage).not.toHaveBeenCalledWith(
          expect.objectContaining({ type: 'debugGraphUpdate' })
        );
      });
    });

    describe('ReAct Pattern - JSON Response Format', () => {
      it('should parse JSON response with call_tools structure', async () => {
        const mockLLMResponse: LLMResponse = {
          id: 'response-1',
          requestId: 'step-0',
          provider: 'openai',
          model: 'gpt-4o',
          content: JSON.stringify({
            thought: 'I need to analyze the code structure',
            call_tools: [
              {
                name: 'static-analysis',
                arguments: {
                  filePath: 'src/auth.ts',
                  mode: 'flow'
                }
              }
            ]
          }),
          usage: {
            promptTokens: 100,
            completionTokens: 50,
            totalTokens: 150
          },
          cost: 0.001,
          processingTime: 100,
          metadata: {},
          createdAt: new Date(),
          updatedAt: new Date()
        };

        (mockLLMProvider.chat as jest.Mock).mockResolvedValueOnce({
          type: ResponseType.SUCCESS,
          payload: mockLLMResponse,
          timestamp: new Date()
        });

        const mockTool = {
          name: 'static-analysis',
          execute: jest.fn().mockResolvedValue({
            success: true,
            summary: 'Analysis complete'
          })
        };

        (mockToolRegistry.getTool as jest.Mock) = jest.fn().mockReturnValue(mockTool);

        // Second call - completion
        (mockLLMProvider.chat as jest.Mock).mockResolvedValueOnce({
          type: ResponseType.SUCCESS,
          payload: {
            id: 'response-2',
            requestId: 'step-1',
            provider: 'openai',
            model: 'gpt-4o',
            content: JSON.stringify({
              thought: 'Analysis complete',
              final_response: 'The bug is fixed'
            }),
            usage: { promptTokens: 100, completionTokens: 50, totalTokens: 150 },
            cost: 0.001,
            processingTime: 100,
            metadata: {},
            createdAt: new Date(),
            updatedAt: new Date()
          },
          timestamp: new Date()
        });

        const result = await planningAgent.execute(
          'Why is login failing?',
          mockSession,
          undefined,
          mockContext
        );

        expect(result.message).toBe('The bug is fixed');
        expect(mockTool.execute).toHaveBeenCalledWith({
          filePath: 'src/auth.ts',
          mode: 'flow'
        });
      });

      it('should handle final_response in JSON', async () => {
        const mockLLMResponse: LLMResponse = {
          id: 'response-1',
          requestId: 'step-0',
          provider: 'openai',
          model: 'gpt-4o',
          content: JSON.stringify({
            thought: 'I found the root cause',
            final_response: 'The bug is on line 45. Missing await statement.'
          }),
          usage: {
            promptTokens: 100,
            completionTokens: 50,
            totalTokens: 150
          },
          cost: 0.001,
          processingTime: 100,
          metadata: {},
          createdAt: new Date(),
          updatedAt: new Date()
        };

        (mockLLMProvider.chat as jest.Mock).mockResolvedValue({
          type: ResponseType.SUCCESS,
          payload: mockLLMResponse,
          timestamp: new Date()
        });

        const result = await planningAgent.execute(
          'Why is login failing?',
          mockSession,
          undefined,
          mockContext
        );

        expect(result.message).toBe('The bug is on line 45. Missing await statement.');
        expect(mockLLMProvider.chat).toHaveBeenCalledTimes(1);
      });

      it('should handle JSON wrapped in markdown code blocks', async () => {
        const mockLLMResponse: LLMResponse = {
          id: 'response-1',
          requestId: 'step-0',
          provider: 'openai',
          model: 'gpt-4o',
          content: '```json\n' + JSON.stringify({
            thought: 'Analyzing...',
            call_tools: [
              { name: 'code-search', arguments: { query: 'User', mode: 'file' } }
            ]
          }) + '\n```',
          usage: {
            promptTokens: 100,
            completionTokens: 50,
            totalTokens: 150
          },
          cost: 0.001,
          processingTime: 100,
          metadata: {},
          createdAt: new Date(),
          updatedAt: new Date()
        };

        (mockLLMProvider.chat as jest.Mock).mockResolvedValueOnce({
          type: ResponseType.SUCCESS,
          payload: mockLLMResponse,
          timestamp: new Date()
        });

        const mockTool = {
          name: 'code-search',
          execute: jest.fn().mockResolvedValue({
            success: true,
            summary: 'Search complete'
          })
        };

        (mockToolRegistry.getTool as jest.Mock) = jest.fn().mockReturnValue(mockTool);

        // Second call - completion
        (mockLLMProvider.chat as jest.Mock).mockResolvedValueOnce({
          type: ResponseType.SUCCESS,
          payload: {
            id: 'response-2',
            requestId: 'step-1',
            provider: 'openai',
            model: 'gpt-4o',
            content: JSON.stringify({
              thought: 'Done',
              final_response: 'Found the issue'
            }),
            usage: { promptTokens: 100, completionTokens: 50, totalTokens: 150 },
            cost: 0.001,
            processingTime: 100,
            metadata: {},
            createdAt: new Date(),
            updatedAt: new Date()
          },
          timestamp: new Date()
        });

        await planningAgent.execute(
          'Why is login failing?',
          mockSession,
          undefined,
          mockContext
        );

        expect(mockTool.execute).toHaveBeenCalledWith({
          query: 'User',
          mode: 'file'
        });
      });

      it('should retry on invalid JSON with self-correction (malformed JSON starts with {)', async () => {
        // First call - invalid JSON that starts with { (attempted JSON, should retry)
        const invalidResponse: LLMResponse = {
          id: 'response-1',
          requestId: 'step-0',
          provider: 'openai',
          model: 'gpt-4o',
          content: '{ "thought": "test", "missing": closing brace',
          usage: {
            promptTokens: 100,
            completionTokens: 50,
            totalTokens: 150
          },
          cost: 0.001,
          processingTime: 100,
          metadata: {},
          createdAt: new Date(),
          updatedAt: new Date()
        };

        // Second call - valid JSON after correction
        const validResponse: LLMResponse = {
          id: 'response-2',
          requestId: 'step-0',
          provider: 'openai',
          model: 'gpt-4o',
          content: JSON.stringify({
            thought: 'I found the issue',
            state_update: {},
            final_response: 'The bug is fixed'
          }),
          usage: {
            promptTokens: 100,
            completionTokens: 50,
            totalTokens: 150
          },
          cost: 0.001,
          processingTime: 100,
          metadata: {},
          createdAt: new Date(),
          updatedAt: new Date()
        };

        (mockLLMProvider.chat as jest.Mock)
          .mockResolvedValueOnce({
            type: ResponseType.SUCCESS,
            payload: invalidResponse,
            timestamp: new Date()
          })
          .mockResolvedValueOnce({
            type: ResponseType.SUCCESS,
            payload: validResponse,
            timestamp: new Date()
          });

        const result = await planningAgent.execute(
          'Why is login failing?',
          mockSession,
          undefined,
          mockContext
        );

        expect(result.message).toBe('The bug is fixed');
        // Should have been called twice (initial + retry)
        expect(mockLLMProvider.chat).toHaveBeenCalledTimes(2);
        
        // Verify correction message was added
        const calls = (mockLLMProvider.chat as jest.Mock).mock.calls;
        const retryCall = calls[1];
        expect(retryCall[0].messages[retryCall[0].messages.length - 1].content).toContain('SYSTEM ERROR');
        expect(retryCall[0].messages[retryCall[0].messages.length - 1].content).toContain('invalid JSON');
      });

      it('should extract final_response from JSON when explanation text precedes JSON', async () => {
        // This test case reproduces the exact issue from the log where explanation text
        // appears before the JSON object, and final_response must be extracted correctly
        const explanationText = `The \`planning_agent_system.md\` prompt has been successfully loaded and analyzed.

**Analysis of \`planning_agent_system.md\`:**

The prompt provides extensive instructions on:
*   The agent's \`CORE OBJECTIVE\`
*   \`CURRENT CONTEXT\` (Investigation Board)
*   \`AVAILABLE TOOLS\`
*   \`DECISION PROTOCOL\` (The "Samurai Loop" - including when to use \`runtime-debug\`)
*   \`STRATEGIC RULES\`
*   \`RESPONSE FORMAT (JSON ONLY)\` with \`Option A: Running Experiments (Tool Calls)\` and \`Option B: Final Resolution\`.

Crucially, in \`Option B: Final Resolution\`, the prompt provides a template for \`final_response\`:
\`\`\`json
{
  "thought": "I have proven the bug and have the fix. Through my analysis of [details], I identified that [root cause explanation]. The evidence shows [specific findings]. This confirms my hypothesis that [conclusion].",

  "state_update": {
    "new_facts": [],
    "hypothesis_updates": [],
    "new_hypotheses": [] 
  },

  "final_response": "## Root Cause\\\\nFound a **Floating Promise**...\\\\n\\\\n## The Fix\\\\n..."
}
\`\`\`

This template provides general guidance for the structure of the \`final_response\` (Root Cause, The Fix) but **does not explicitly instruct the LLM to synthesize or include the detailed outputs of specific tools like \`runtime-debug\` in the final report.** It relies on the LLM to infer what "evidence shows [specific findings]" means, but it doesn't enforce the inclusion of raw or summarized tool observations in the final output. The LLM is given the tool results in the conversation history, but the instructions for the *final output format* do not make it a requirement to explicitly reference or embed those details.

**Conclusion:**

Both initial hypotheses were contributing factors, but the primary root cause lies in the prompt's instructions for the \`final_response\`.

1.  **"the planning agent's LLM prompt is not instructed explicitly" (Verified):** The prompt \`planning_agent_system.md\` does not explicitly instruct the LLM to include the *details* of runtime analysis results in its \`final_response\`. While it instructs on the overall structure (Root Cause, The Fix), it leaves the inclusion of specific tool outputs to the LLM's discretion, which it currently chooses not to do directly.
2.  **"the runtime analysis agent's result is not fitted to the planning agent properly" (Refuted as primary cause):** The \`PlanningAgent.ts\` code explicitly adds the \`runtime-debug\` tool's output to the LLM's \`messages\` array, formatted clearly as \`### Tool: \${r.name}\\\\n\\\\nOutput:\\\\n\${r.content}\\\\n\`. The results are *fitted* to the planning agent (i.e., passed to the LLM) correctly. The issue is what the LLM *does* with that information in its final output.

**Root Cause:**
The \`PlanningAgent\`'s LLM prompt (\`planning_agent_system.md\`) lacks explicit instructions within its \`Final Resolution\` section to guide the LLM on how to incorporate and present detailed tool outputs (such as \`runtime-debug\` observations) as part of its \`final_response\`. As a result, the LLM, although privy to the runtime analysis details, does not consistently or comprehensively include them in its final user-facing report.

**The Fix:**
Enhance the \`RESPONSE FORMAT (JSON ONLY)\` section under \`Option B: Final Resolution\` in \`planning_agent_system.md\`. Add explicit guidance, perhaps with an example, instructing the LLM to:
*   **Summarize Key Findings:** Synthesize the most relevant observations from executed tools, particularly \`runtime-debug\` if it was used.
*   **Provide Concrete Evidence:** Directly reference or quote specific outputs (e.g., variable values, stack traces, file contents) from the tool results as evidence for the identified root cause and fix.
*   **Structure the Evidence:** Suggest including a dedicated "Evidence from Runtime Analysis" or "Tool Output Highlights" section within the \`final_response\` markdown.

For example, update the \`final_response\` template in the prompt to include a section like this:

\`\`\`markdown
"final_response": "## Root Cause\\\\nFound a **Floating Promise**...\\\\n\\\\n## Evidence\\\\n### Runtime Analysis Output\\\\nI ran \`runtime-debug\` on \`src/service.ts:123\` and observed the \`userSession\` variable was \`undefined\`, even though it was expected to contain an object.\\\\n\\\\n\`\`\`json\\\\n// Snippet from runtime-debug output\\\\n{\\\\n  \\\\\\\"file\\\\\\\": \\\\\\\"src/service.ts\\\\\\\",\\\\n  \\\\\\\"line\\\\\\\": 123,\\\\n  \\\\\\\"expression\\\\\\\": \\\\\\\"userSession\\\\\\\",\\\\n  \\\\\\\"value\\\\\\\": \\\\\\\"undefined\\\\\\\"\\\\n}\\\\n\`\`\`\\\\n\\\\n### Static Analysis Observations\\\\nFurther \`static-analysis\` showed that \`getUserSession()\` was called without error handling...\\\\n\\\\n## The Fix\\\\n..."
\`\`\`

This more explicit instruction will guide the LLM to include the desired details in its final output.`;

        const jsonObject = {
          thought: "The `planning_agent_system.md` prompt has been successfully loaded and analyzed.",
          state_update: {
            new_facts: [],
            hypothesis_updates: [
              {
                id: "h1",
                status: "verified",
                confidence: 1
              }
            ],
            new_hypotheses: []
          },
          final_response: "## Root Cause\nThe `PlanningAgent`'s final results do not show the details from the `RuntimeAnalysisAgent` because the LLM prompt (`planning_agent_system.md`) does not explicitly instruct the LLM to synthesize and include these details in its `final_response`. While the `PlanningAgent.ts` successfully passes the `runtime-debug` output to the LLM within the conversation history, the `Final Resolution` template in the prompt provides only a general structure (Root Cause, The Fix) without specific guidance or examples for integrating tool-generated evidence.\n\n## The Fix\nTo ensure the `PlanningAgent`'s final results include `runtime-debug` details, you need to enhance the `RESPONSE FORMAT (JSON ONLY)` section under `Option B: Final Resolution` in the `planning_agent_system.md` file. Add explicit instructions and an example template to guide the LLM on how to incorporate and present these details. This should encourage the LLM to:\n\n1.  **Summarize Key Findings:** Clearly state the most relevant observations from `runtime-debug` or other tools.\n2.  **Provide Concrete Evidence:** Directly reference or quote specific outputs (e.g., variable values, relevant code snippets, stack traces) from the tool results.\n3.  **Structure the Evidence:** Suggest adding a dedicated section like \"Evidence from Runtime Analysis\" within the markdown content of the `final_response`."
        };

        const responseContent = explanationText + '\n\n' + JSON.stringify(jsonObject, null, 2);

        const mockLLMResponse: LLMResponse = {
          id: 'step-4',
          requestId: 'step-4',
          provider: 'google',
          model: 'gemini-2.5-flash-beta',
          content: responseContent,
          usage: {
            promptTokens: 30102,
            completionTokens: 3247,
            totalTokens: 33349
          },
          cost: 0.003232,
          processingTime: 15410,
          metadata: {
            proxyProcessed: true,
            proxyProcessingTime: 15410,
            totalProcessingTime: 15729
          },
          createdAt: new Date(),
          updatedAt: new Date()
        };

        (mockLLMProvider.chat as jest.Mock).mockResolvedValue({
          type: ResponseType.SUCCESS,
          payload: mockLLMResponse,
          timestamp: new Date()
        });

        const result = await planningAgent.execute(
          'Why is login failing?',
          mockSession,
          undefined,
          mockContext
        );

        // The final_response should be extracted correctly despite explanation text before JSON
        // Verify the message matches the expected final_response
        // Note: We compare the actual string values, accounting for newline handling
        expect(result.message).toBe(jsonObject.final_response);
        // Also verify that it's not empty and contains expected content
        expect(result.message).toContain('## Root Cause');
        expect(result.message).toContain('## The Fix');
        expect(result.message).toContain('PlanningAgent');
        expect(result.message.length).toBeGreaterThan(100);
        expect(mockLLMProvider.chat).toHaveBeenCalledTimes(1);
      });

      it('should treat raw markdown/text as final response (does not start with {)', async () => {
        // LLM returns raw markdown instead of JSON
        const markdownResponse: LLMResponse = {
          id: 'response-1',
          requestId: 'step-0',
          provider: 'openai',
          model: 'gpt-4o',
          content: `## Root Cause

Found a **Floating Promise** in the authentication flow.

## The Fix

Add \`await\` before the async call.`,
          usage: {
            promptTokens: 100,
            completionTokens: 50,
            totalTokens: 150
          },
          cost: 0.001,
          processingTime: 100,
          metadata: {},
          createdAt: new Date(),
          updatedAt: new Date()
        };

        (mockLLMProvider.chat as jest.Mock).mockResolvedValueOnce({
          type: ResponseType.SUCCESS,
          payload: markdownResponse,
          timestamp: new Date()
        });

        const result = await planningAgent.execute(
          'Why is login failing?',
          mockSession,
          undefined,
          mockContext,
          undefined,
          mockLogger
        );

        // Should treat markdown as final response
        expect(result.message).toContain('Root Cause');
        expect(result.message).toContain('Floating Promise');
        // Should NOT retry (only called once)
        expect(mockLLMProvider.chat).toHaveBeenCalledTimes(1);
        // Should log appropriately
        expect(mockLogger.logStep).toHaveBeenCalled();
        expect(mockLogger.generateSummary).toHaveBeenCalled();
      });

      it('should treat plain text as final response (does not start with {)', async () => {
        // LLM returns plain text instead of JSON
        const textResponse: LLMResponse = {
          id: 'response-1',
          requestId: 'step-0',
          provider: 'openai',
          model: 'gpt-4o',
          content: 'I have analyzed the code and found the issue. The problem is a missing await statement.',
          usage: {
            promptTokens: 100,
            completionTokens: 50,
            totalTokens: 150
          },
          cost: 0.001,
          processingTime: 100,
          metadata: {},
          createdAt: new Date(),
          updatedAt: new Date()
        };

        (mockLLMProvider.chat as jest.Mock).mockResolvedValueOnce({
          type: ResponseType.SUCCESS,
          payload: textResponse,
          timestamp: new Date()
        });

        const result = await planningAgent.execute(
          'Why is login failing?',
          mockSession,
          undefined,
          mockContext,
          undefined,
          mockLogger
        );

        // Should treat text as final response
        expect(result.message).toContain('missing await statement');
        // Should NOT retry (only called once)
        expect(mockLLMProvider.chat).toHaveBeenCalledTimes(1);
      });

      it('should treat complete markdown analysis as final response even with code snippets containing braces', async () => {
        // This test case covers the scenario where LLM returns a complete markdown analysis
        // that contains code snippets with braces (which might trigger JSON pattern detection)
        // but should still be treated as a valid final response
        const markdownWithCodeSnippets: LLMResponse = {
          id: 'response-1',
          requestId: 'step-0',
          provider: 'openai',
          model: 'gpt-4o',
          content: `## Root Cause

The \`PlanningAgent\` *does* capture the results from the \`runtime-debug\` tool and *does* pass them into the LLM's \`messages\` array for subsequent processing. This happens in the main execution loop where \`toolResults\` are formatted and appended as a \`user\` role message:

\`\`\`typescript
// H. Add Results to history (format as user message for ReAct pattern)
messages.push({
  role: 'user',
  content: \`Step \${step} Results:\\n\\n\${toolResults.map(r => \`### Tool: \${r.name}\\n\\nOutput:\\n\${r.content}\\n\`).join('\\n')}\`
});
\`\`\`
This means the LLM **receives** the detailed \`Output\` from \`runtime-debug\` (which is typically a JSON string containing captured variable states).

However, the problem is that the LLM's **system prompt and instructions** do not explicitly guide it on *how to process and then include* these runtime analysis results in its final \`thought\` or \`final_response\`.

Upon reviewing \`PlanningAgent.ts\` and the \`getDynamicSystemPrompt\` method (which includes the fallback content for \`planning_agent_system.md\`):
1.  The \`initialUserMessage\` provided to the LLM sets the initial task but doesn't mention handling \`runtime-debug\` output specifically.
2.  The \`RESPONSE FORMAT (JSON ONLY)\` section in the system prompt outlines the structure for \`thought\`, \`state_update\`, \`call_tools\`, and \`final_response\`. While the \`thought\` field is meant for reasoning, the examples provided (\`"I have analyzed the previous tool output. It shows [X]. Therefore I need to check [Y]."\`) are generic. There's no specific directive like "If \`runtime-debug\` was used, you MUST summarize its findings (e.g., 'Variable \`X\` at line \`Y\` was \`Z\`') within your \`thought\` or \`final_response\`."

Without such explicit instructions, the LLM might process the raw \`runtime-debug\` output internally but fail to synthesize or surface the critical details in a user-friendly manner in its output. It's an issue of **explicit instruction for reporting**, not a failure in passing the data to the LLM.

## The Fix

To ensure the Planning Agent's response explicitly includes runtime analysis results when they exist, the \`planning_agent_system.md\` prompt (or its fallback in \`getDynamicSystemPrompt\`) needs to be enhanced with explicit instructions for the LLM.

**Suggested changes to \`planning_agent_system.md\`:**

1.  **Add a specific directive to the \`thought\` field for \`runtime-debug\` results.** This should be part of the \`RESPONSE FORMAT (JSON ONLY)\` section.

    *   **Under "Option A: Running Experiments (Tool Calls)", modify the \`thought\` description:**
        \`\`\`markdown
        ### Option A: Running Experiments (Tool Calls)

        Use this when you need more information.

        **IMPORTANT: The \`thought\` field is your reasoning space. Put ALL your analysis, explanations, code references, hypotheses, and detailed reasoning INSIDE the \`thought\` field. Do NOT put explanations before the JSON object.**

        **Special Instruction for Runtime Analysis:** If you have just executed \`runtime-debug\`, you **MUST** explicitly interpret and summarize its results in your \`thought\`. State the captured variable names, their exact values, and any observations or conclusions derived from them. For example: "The \`runtime-debug\` tool showed that \`user.id\` at line 42 was \`undefined\`, indicating the user object was not properly loaded."
        \`\`\`

    *   **Under "Option B: Final Resolution", modify the \`thought\` description for final reports:**
        \`\`\`markdown
        ### Option B: Final Resolution

        Use this ONLY when you have proven the root cause and can explain the fix.

        **IMPORTANT:** 
        - The \`thought\` field should contain your complete reasoning about how you arrived at the root cause.
        - The \`final_response\` field should contain your markdown-formatted report as a string value within the JSON object. The \`final_response\` field should be in the same language as the user request, while technical terms or code should remain in English.

        **Special Instruction for Runtime Analysis:** If \`runtime-debug\` was instrumental in identifying the root cause, your \`thought\` and \`final_response\` **MUST** clearly reference its findings, detailing the specific variable states and their significance to the bug.
        \`\`\`

By adding these explicit instructions, the LLM will be guided to actively parse, interpret, and report the \`runtime-debug\` results as a critical part of its reasoning and final output, making these details visible to the user.`,
          usage: {
            promptTokens: 100,
            completionTokens: 4520,
            totalTokens: 4620
          },
          cost: 0.001,
          processingTime: 100,
          metadata: {},
          createdAt: new Date(),
          updatedAt: new Date()
        };

        (mockLLMProvider.chat as jest.Mock).mockResolvedValueOnce({
          type: ResponseType.SUCCESS,
          payload: markdownWithCodeSnippets,
          timestamp: new Date()
        });

        const result = await planningAgent.execute(
          'Why is login failing?',
          mockSession,
          undefined,
          mockContext,
          undefined,
          mockLogger
        );

        // Should treat complete markdown analysis as final response
        expect(result.message).toContain('## Root Cause');
        expect(result.message).toContain('## The Fix');
        expect(result.message).toContain('PlanningAgent');
        expect(result.message).toContain('runtime-debug');
        expect(result.message.length).toBeGreaterThan(1000);
        // Should NOT retry (only called once) - this is the key improvement
        expect(mockLLMProvider.chat).toHaveBeenCalledTimes(1);
        // Should log appropriately
        expect(mockLogger.logStep).toHaveBeenCalled();
        expect(mockLogger.generateSummary).toHaveBeenCalled();
      });

      it('should NOT treat JSON response as final markdown analysis', async () => {
        // This test ensures that JSON responses (even malformed) are never treated as final markdown
        const jsonResponse: LLMResponse = {
          id: 'response-1',
          requestId: 'step-0',
          provider: 'openai',
          model: 'gpt-4o',
          content: `{
  "thought": "I need to analyze the code",
  "state_update": {
    "new_facts": [],
    "hypothesis_updates": [],
    "new_hypotheses": []
  },
  "call_tools": [
    {
      "name": "static-analysis",
      "arguments": {
        "filePath": "src/auth.ts",
        "mode": "flow"
      }
    }
  ]
}`,
          usage: {
            promptTokens: 100,
            completionTokens: 50,
            totalTokens: 150
          },
          cost: 0.001,
          processingTime: 100,
          metadata: {},
          createdAt: new Date(),
          updatedAt: new Date()
        };

        (mockLLMProvider.chat as jest.Mock).mockResolvedValueOnce({
          type: ResponseType.SUCCESS,
          payload: jsonResponse,
          timestamp: new Date()
        });

        // Mock tool execution - tool should return ToolResult structure
        const mockTool = {
          name: 'static-analysis',
          execute: jest.fn().mockResolvedValue({
            success: true,
            summary: 'Analysis complete',
            evidence: [{ file: 'src/auth.ts', line: 10, text: 'Found issue', description: 'Issue found' }]
          })
        };
        (mockToolRegistry.getTool as jest.Mock).mockReturnValue(mockTool);

        // Second LLM call after tool execution - final response
        const finalResponse: LLMResponse = {
          id: 'response-2',
          requestId: 'step-1',
          provider: 'openai',
          model: 'gpt-4o',
          content: JSON.stringify({
            thought: 'Analysis complete',
            state_update: { new_facts: [], hypothesis_updates: [], new_hypotheses: [] },
            final_response: 'The bug is fixed'
          }),
          usage: {
            promptTokens: 100,
            completionTokens: 50,
            totalTokens: 150
          },
          cost: 0.001,
          processingTime: 100,
          metadata: {},
          createdAt: new Date(),
          updatedAt: new Date()
        };

        (mockLLMProvider.chat as jest.Mock).mockResolvedValueOnce({
          type: ResponseType.SUCCESS,
          payload: finalResponse,
          timestamp: new Date()
        });

        const result = await planningAgent.execute(
          'Why is login failing?',
          mockSession,
          undefined,
          mockContext,
          undefined,
          mockLogger
        );

        // Should NOT treat JSON as final response - should execute tools and then get final response
        expect(result.message).toBe('The bug is fixed');
        // Should have executed the tool
        expect(mockTool.execute).toHaveBeenCalledWith({
          filePath: 'src/auth.ts',
          mode: 'flow'
        });
        // Should have called LLM twice (once for tool call, once for final response)
        expect(mockLLMProvider.chat).toHaveBeenCalledTimes(2);
      });

      it('should NOT treat malformed JSON with PlanningAgent patterns as final markdown', async () => {
        // Even if JSON is malformed, if it has PlanningAgent patterns, it should retry, not treat as final
        const malformedJsonResponse: LLMResponse = {
          id: 'response-1',
          requestId: 'step-0',
          provider: 'openai',
          model: 'gpt-4o',
          content: `{
  "thought": "I need to analyze",
  "state_update": {
    "new_facts": []
  },
  "call_tools": [
    {
      "name": "static-analysis",
      "arguments": {
        "filePath": "src/auth.ts"
        // Missing comma - malformed JSON
      }
    }
  ]
}`,
          usage: {
            promptTokens: 100,
            completionTokens: 50,
            totalTokens: 150
          },
          cost: 0.001,
          processingTime: 100,
          metadata: {},
          createdAt: new Date(),
          updatedAt: new Date()
        };

        // First call returns malformed JSON
        (mockLLMProvider.chat as jest.Mock).mockResolvedValueOnce({
          type: ResponseType.SUCCESS,
          payload: malformedJsonResponse,
          timestamp: new Date()
        });

        // Second call (retry) returns valid JSON
        const validJsonResponse: LLMResponse = {
          id: 'response-2',
          requestId: 'step-1',
          provider: 'openai',
          model: 'gpt-4o',
          content: JSON.stringify({
            thought: 'Fixed the JSON',
            state_update: { new_facts: [], hypothesis_updates: [], new_hypotheses: [] },
            final_response: 'The issue is resolved'
          }),
          usage: {
            promptTokens: 100,
            completionTokens: 50,
            totalTokens: 150
          },
          cost: 0.001,
          processingTime: 100,
          metadata: {},
          createdAt: new Date(),
          updatedAt: new Date()
        };

        (mockLLMProvider.chat as jest.Mock).mockResolvedValueOnce({
          type: ResponseType.SUCCESS,
          payload: validJsonResponse,
          timestamp: new Date()
        });

        const result = await planningAgent.execute(
          'Why is login failing?',
          mockSession,
          undefined,
          mockContext,
          undefined,
          mockLogger
        );

        // Should retry (called twice) and NOT treat malformed JSON as final response
        expect(mockLLMProvider.chat).toHaveBeenCalledTimes(2);
        expect(result.message).toBe('The issue is resolved');
      });

      it('should extract and emit thought field', async () => {
        const mockReporter = {
          report: jest.fn()
        } as any;

        const mockLLMResponse: LLMResponse = {
          id: 'response-1',
          requestId: 'step-0',
          provider: 'openai',
          model: 'gpt-4o',
          content: JSON.stringify({
            thought: 'I need to check the authentication logic',
            call_tool: {
              name: 'static-analysis',
              arguments: { filePath: 'src/auth.ts', mode: 'flow' }
            }
          }),
          usage: {
            promptTokens: 100,
            completionTokens: 50,
            totalTokens: 150
          },
          cost: 0.001,
          processingTime: 100,
          metadata: {},
          createdAt: new Date(),
          updatedAt: new Date()
        };

        (mockLLMProvider.chat as jest.Mock).mockResolvedValueOnce({
          type: ResponseType.SUCCESS,
          payload: mockLLMResponse,
          timestamp: new Date()
        });

        const mockTool = {
          name: 'static-analysis',
          execute: jest.fn().mockResolvedValue({
            success: true,
            summary: 'Done'
          })
        };

        (mockToolRegistry.getTool as jest.Mock) = jest.fn().mockReturnValue(mockTool);

        // Mock state update
        (mockLLMProvider.chat as jest.Mock).mockResolvedValueOnce({
          type: ResponseType.SUCCESS,
          payload: {
            id: 'state-update-0',
            requestId: 'state-update-0',
            provider: 'openai',
            model: 'gpt-4o',
            content: JSON.stringify({
              facts: [],
              hypotheses: [],
              active_hypothesis_id: null,
              thought_step: {
                step: 0,
                timestamp: Date.now(),
                reasoning: 'test',
                action: 'static-analysis',
                observation: 'test',
                outcome: 'test'
              },
              next_step: 'continue'
            }),
            usage: { promptTokens: 50, completionTokens: 50, totalTokens: 100 },
            cost: 0.0005,
            processingTime: 50,
            metadata: {},
            createdAt: new Date(),
            updatedAt: new Date()
          },
          timestamp: new Date()
        });

        // Second call - completion
        (mockLLMProvider.chat as jest.Mock).mockResolvedValueOnce({
          type: ResponseType.SUCCESS,
          payload: {
            id: 'response-2',
            requestId: 'step-1',
            provider: 'openai',
            model: 'gpt-4o',
            content: JSON.stringify({
              thought: 'Done',
              final_response: 'Issue found'
            }),
            usage: { promptTokens: 100, completionTokens: 50, totalTokens: 150 },
            cost: 0.001,
            processingTime: 100,
            metadata: {},
            createdAt: new Date(),
            updatedAt: new Date()
          },
          timestamp: new Date()
        });

        await planningAgent.execute(
          'Why is login failing?',
          mockSession,
          undefined,
          mockContext,
          mockReporter
        );

        // Verify thought was emitted
        const thoughtCall = (mockReporter.report as jest.Mock).mock.calls.find(
          (call: any[]) => call[0] === 'thought' && call[1] === 'I need to check the authentication logic'
        );
        expect(thoughtCall).toBeDefined();
      });

      it('should not include metadata.tools in LLM call', async () => {
        const mockLLMResponse: LLMResponse = {
          id: 'response-1',
          requestId: 'step-0',
          provider: 'openai',
          model: 'gpt-4o',
          content: JSON.stringify({
            thought: 'Done',
            final_response: 'Issue resolved'
          }),
          usage: {
            promptTokens: 100,
            completionTokens: 50,
            totalTokens: 150
          },
          cost: 0.001,
          processingTime: 100,
          metadata: {},
          createdAt: new Date(),
          updatedAt: new Date()
        };

        (mockLLMProvider.chat as jest.Mock).mockResolvedValue({
          type: ResponseType.SUCCESS,
          payload: mockLLMResponse,
          timestamp: new Date()
        });

        await planningAgent.execute(
          'Why is login failing?',
          mockSession,
          undefined,
          mockContext
        );

        const callArgs = (mockLLMProvider.chat as jest.Mock).mock.calls[0][0];
        // Should not have tools in metadata
        expect(callArgs.metadata?.tools).toBeUndefined();
        // Should have response_format instead
        expect(callArgs.metadata?.response_format).toEqual({ type: 'json_object' });
      });
    });

    describe('formatToolsForPrompt', () => {
      it('should format tools with TypeScript signatures', () => {
        // Access private method via type assertion
        const agent = planningAgent as any;
        const formatted = agent.formatToolsForPrompt();

        expect(formatted).toContain('static-analysis');
        expect(formatted).toContain('code-search');
        expect(formatted).toContain('filePath: string');
        expect(formatted).toContain('mode:');
        expect(formatted).toContain("'metrics' | 'source' | 'flow'");
        expect(formatted).toContain('pattern?: string');
      });

      it('should handle optional parameters correctly', () => {
        const agent = planningAgent as any;
        const formatted = agent.formatToolsForPrompt();

        // pattern should be optional (with ?)
        expect(formatted).toContain('pattern?: string');
        // filePath and mode should be required (no ?)
        expect(formatted).toMatch(/filePath:\s*string/);
        expect(formatted).toMatch(/mode:\s*'[^']+'/);
      });

      it('should include tool descriptions', () => {
        const agent = planningAgent as any;
        const formatted = agent.formatToolsForPrompt();

        expect(formatted).toContain('Analyzes code structure');
        expect(formatted).toContain('Searches for files or symbols');
      });
    });

    describe('getTypeScriptType', () => {
      it('should convert enum to union type', () => {
        const agent = planningAgent as any;
        const schema = {
          type: 'string',
          enum: ['file', 'symbol', 'text']
        };
        const result = agent.getTypeScriptType(schema);
        expect(result).toBe("'file' | 'symbol' | 'text'");
      });

      it('should handle optional string type', () => {
        const agent = planningAgent as any;
        const schema = { type: 'string' };
        const result = agent.getTypeScriptType(schema);
        expect(result).toBe('string');
      });

      it('should handle number type', () => {
        const agent = planningAgent as any;
        const schema = { type: 'number' };
        const result = agent.getTypeScriptType(schema);
        expect(result).toBe('number');
      });

      it('should handle array type', () => {
        const agent = planningAgent as any;
        const schema = {
          type: 'array',
          items: { type: 'string' }
        };
        const result = agent.getTypeScriptType(schema);
        expect(result).toBe('string[]');
      });

      it('should handle tuple type', () => {
        const agent = planningAgent as any;
        const schema = {
          type: 'array',
          prefixItems: [
            { type: 'number' },
            { type: 'number' }
          ]
        };
        const result = agent.getTypeScriptType(schema);
        expect(result).toBe('[number, number]');
      });
    });

    describe('Merged Reasoning Loop (New Schema)', () => {
      it('should apply state updates immediately from LLM response', async () => {
        const mockLLMResponse: LLMResponse = {
          id: 'response-1',
          requestId: 'step-0',
          provider: 'openai',
          model: 'gpt-4o',
          content: JSON.stringify({
            thought: 'I found a floating promise issue.',
            state_update: {
              new_facts: ['saveUser returns Promise<void>', 'Line 45 is unawaited'],
              hypothesis_updates: [
                { id: 'h1', status: 'verified', confidence: 1.0 }
              ],
              new_hypotheses: []
            },
            final_response: '## Root Cause\nFound a **Floating Promise** on line 45.'
          }),
          usage: {
            promptTokens: 100,
            completionTokens: 50,
            totalTokens: 150
          },
          cost: 0.001,
          processingTime: 100,
          metadata: {},
          createdAt: new Date(),
          updatedAt: new Date()
        };

        (mockLLMProvider.chat as jest.Mock).mockResolvedValue({
          type: ResponseType.SUCCESS,
          payload: mockLLMResponse,
          timestamp: new Date()
        });

        const result = await planningAgent.execute(
          'Why is login failing?',
          mockSession,
          undefined,
          mockContext
        );

        // Verify final response
        expect(result.message).toContain('Floating Promise');
        
        // Verify only one LLM call was made (no separate state update call)
        expect(mockLLMProvider.chat).toHaveBeenCalledTimes(1);
      });

      it('should handle call_tools array format', async () => {
        const mockTool = {
          name: 'static-analysis',
          execute: jest.fn().mockResolvedValue({
            success: true,
            summary: 'Analysis complete',
            evidence: []
          })
        };

        (mockToolRegistry.getTool as jest.Mock) = jest.fn().mockReturnValue(mockTool);

        const mockLLMResponse: LLMResponse = {
          id: 'response-1',
          requestId: 'step-0',
          provider: 'openai',
          model: 'gpt-4o',
          content: JSON.stringify({
            thought: 'I need to analyze the code structure.',
            state_update: {
              new_facts: [],
              hypothesis_updates: [],
              new_hypotheses: [
                { description: 'Race condition in saveUser', confidence: 0.7 }
              ]
            },
            call_tools: [
              {
                name: 'static-analysis',
                arguments: { filePath: '/test/src/auth.ts', mode: 'flow' }
              }
            ]
          }),
          usage: {
            promptTokens: 100,
            completionTokens: 50,
            totalTokens: 150
          },
          cost: 0.001,
          processingTime: 100,
          metadata: {},
          createdAt: new Date(),
          updatedAt: new Date()
        };

        // First call - tool execution
        (mockLLMProvider.chat as jest.Mock).mockResolvedValueOnce({
          type: ResponseType.SUCCESS,
          payload: mockLLMResponse,
          timestamp: new Date()
        });

        // Second call - completion
        (mockLLMProvider.chat as jest.Mock).mockResolvedValueOnce({
          type: ResponseType.SUCCESS,
          payload: {
            id: 'response-2',
            requestId: 'step-1',
            provider: 'openai',
            model: 'gpt-4o',
            content: JSON.stringify({
              thought: 'Analysis complete.',
              state_update: {
                new_facts: [],
                hypothesis_updates: [],
                new_hypotheses: []
              },
              final_response: 'Issue resolved'
            }),
            usage: { promptTokens: 100, completionTokens: 50, totalTokens: 150 },
            cost: 0.001,
            processingTime: 100,
            metadata: {},
            createdAt: new Date(),
            updatedAt: new Date()
          },
          timestamp: new Date()
        });

        await planningAgent.execute(
          'Why is login failing?',
          mockSession,
          undefined,
          mockContext
        );

        // Verify tool was called
        expect(mockTool.execute).toHaveBeenCalledWith({
          filePath: '/test/src/auth.ts',
          mode: 'flow'
        });
        
        // Verify only 2 LLM calls (no separate state update call)
        expect(mockLLMProvider.chat).toHaveBeenCalledTimes(2);
      });

      it('should handle multiple parallel tool calls', async () => {
        const mockTool1 = {
          name: 'static-analysis',
          execute: jest.fn().mockResolvedValue({
            success: true,
            summary: 'Analysis 1 complete',
            evidence: []
          })
        };

        const mockTool2 = {
          name: 'code-search',
          execute: jest.fn().mockResolvedValue({
            success: true,
            summary: 'Search complete',
            evidence: []
          })
        };

        // Setup getTool mock properly
        mockToolRegistry.getTool = jest.fn((name: string) => {
          if (name === 'static-analysis') return mockTool1;
          if (name === 'code-search') return mockTool2;
          return undefined;
        }) as any;

        const mockLLMResponse: LLMResponse = {
          id: 'response-1',
          requestId: 'step-0',
          provider: 'openai',
          model: 'gpt-4o',
          content: JSON.stringify({
            thought: 'I need to run multiple analyses in parallel.',
            state_update: {
              new_facts: ['Starting parallel analysis'],
              hypothesis_updates: [],
              new_hypotheses: []
            },
            call_tools: [
              {
                name: 'static-analysis',
                arguments: { filePath: '/test/src/auth.ts', mode: 'flow' }
              },
              {
                name: 'code-search',
                arguments: { query: 'saveUser', mode: 'symbol' }
              }
            ]
          }),
          usage: {
            promptTokens: 100,
            completionTokens: 50,
            totalTokens: 150
          },
          cost: 0.001,
          processingTime: 100,
          metadata: {},
          createdAt: new Date(),
          updatedAt: new Date()
        };

        // First call - tool execution
        (mockLLMProvider.chat as jest.Mock).mockResolvedValueOnce({
          type: ResponseType.SUCCESS,
          payload: mockLLMResponse,
          timestamp: new Date()
        });

        // Second call - completion
        (mockLLMProvider.chat as jest.Mock).mockResolvedValueOnce({
          type: ResponseType.SUCCESS,
          payload: {
            id: 'response-2',
            requestId: 'step-1',
            provider: 'openai',
            model: 'gpt-4o',
            content: JSON.stringify({
              thought: 'Done',
              state_update: { new_facts: [], hypothesis_updates: [], new_hypotheses: [] },
              final_response: 'Complete'
            }),
            usage: { promptTokens: 100, completionTokens: 50, totalTokens: 150 },
            cost: 0.001,
            processingTime: 100,
            metadata: {},
            createdAt: new Date(),
            updatedAt: new Date()
          },
          timestamp: new Date()
        });

        await planningAgent.execute(
          'Why is login failing?',
          mockSession,
          undefined,
          mockContext
        );

        // Verify both tools were called
        expect(mockTool1.execute).toHaveBeenCalled();
        expect(mockTool2.execute).toHaveBeenCalled();
        
        // Verify only 2 LLM calls (no separate state update calls)
        expect(mockLLMProvider.chat).toHaveBeenCalledTimes(2);
      });

      it('should inject USER_QUERY placeholder in system prompt', async () => {
        const mockLLMResponse: LLMResponse = {
          id: 'response-1',
          requestId: 'step-0',
          provider: 'openai',
          model: 'gpt-4o',
          content: JSON.stringify({
            thought: 'Analyzing...',
            state_update: {
              new_facts: [],
              hypothesis_updates: [],
              new_hypotheses: []
            },
            final_response: 'Done'
          }),
          usage: {
            promptTokens: 100,
            completionTokens: 50,
            totalTokens: 150
          },
          cost: 0.001,
          processingTime: 100,
          metadata: {},
          createdAt: new Date(),
          updatedAt: new Date()
        };

        (mockLLMProvider.chat as jest.Mock).mockResolvedValue({
          type: ResponseType.SUCCESS,
          payload: mockLLMResponse,
          timestamp: new Date()
        });

        await planningAgent.execute(
          'Why is login failing?',
          mockSession,
          undefined,
          mockContext
        );

        // Verify the system prompt contains the user query (placeholder should be replaced)
        const callArgs = (mockLLMProvider.chat as jest.Mock).mock.calls[0][0];
        const systemMessage = callArgs.messages.find((m: any) => m.role === 'system');
        expect(systemMessage.content).toContain('Why is login failing?');
        expect(systemMessage.content).not.toContain('{{USER_QUERY}}'); // Placeholder should be replaced
      });

      it('should inject STRATEGIC_RULES placeholder with dynamic rules', async () => {
        const mockLLMResponse: LLMResponse = {
          id: 'response-1',
          requestId: 'step-0',
          provider: 'openai',
          model: 'gpt-4o',
          content: JSON.stringify({
            thought: 'Analyzing...',
            state_update: {
              new_facts: [],
              hypothesis_updates: [],
              new_hypotheses: []
            },
            final_response: 'Done'
          }),
          usage: {
            promptTokens: 100,
            completionTokens: 50,
            totalTokens: 150
          },
          cost: 0.001,
          processingTime: 100,
          metadata: {},
          createdAt: new Date(),
          updatedAt: new Date()
        };

        (mockLLMProvider.chat as jest.Mock).mockResolvedValue({
          type: ResponseType.SUCCESS,
          payload: mockLLMResponse,
          timestamp: new Date()
        });

        // Spy on console.log to verify rule selection logging
        const consoleSpy = jest.spyOn(console, 'log').mockImplementation();

        await planningAgent.execute(
          'Why is login failing?',
          mockSession,
          undefined,
          mockContext
        );

        // Verify the system prompt contains strategic rules (placeholder should be replaced)
        const callArgs = (mockLLMProvider.chat as jest.Mock).mock.calls[0][0];
        const systemMessage = callArgs.messages.find((m: any) => m.role === 'system');
        expect(systemMessage.content).not.toContain('{{STRATEGIC_RULES}}'); // Placeholder should be replaced
        expect(systemMessage.content).toContain('STRATEGIC RULES'); // Section header should exist
        expect(systemMessage.content).toContain('Negative Inference'); // Base rule should always be included
        
        // Verify rule selection was logged (RuleSelector logs with new format)
        expect(consoleSpy).toHaveBeenCalledWith(
          expect.stringContaining('[RuleSelector] Selected:')
        );

        consoleSpy.mockRestore();
      });

      it('should update hypotheses from state_update', async () => {
        const mockLLMResponse: LLMResponse = {
          id: 'response-1',
          requestId: 'step-0',
          provider: 'openai',
          model: 'gpt-4o',
          content: JSON.stringify({
            thought: 'I suspect a race condition.',
            state_update: {
              new_facts: ['User data is saved asynchronously'],
              hypothesis_updates: [],
              new_hypotheses: [
                { description: 'Race condition in saveUser function', confidence: 0.8 }
              ]
            },
            final_response: 'Found race condition'
          }),
          usage: {
            promptTokens: 100,
            completionTokens: 50,
            totalTokens: 150
          },
          cost: 0.001,
          processingTime: 100,
          metadata: {},
          createdAt: new Date(),
          updatedAt: new Date()
        };

        (mockLLMProvider.chat as jest.Mock).mockResolvedValue({
          type: ResponseType.SUCCESS,
          payload: mockLLMResponse,
          timestamp: new Date()
        });

        const result = await planningAgent.execute(
          'Why is login failing?',
          mockSession,
          undefined,
          mockContext
        );

        expect(result.message).toContain('race condition');
        // Verify only one LLM call (no separate state update)
        expect(mockLLMProvider.chat).toHaveBeenCalledTimes(1);
      });

      it('should handle state_update with hypothesis updates', async () => {
        const mockLLMResponse: LLMResponse = {
          id: 'response-1',
          requestId: 'step-0',
          provider: 'openai',
          model: 'gpt-4o',
          content: JSON.stringify({
            thought: 'Verifying hypothesis.',
            state_update: {
              new_facts: ['saveUser returns Promise<void>'],
              hypothesis_updates: [
                { id: 'h1', status: 'verified', confidence: 1.0 }
              ],
              new_hypotheses: []
            },
            final_response: 'Hypothesis verified'
          }),
          usage: {
            promptTokens: 100,
            completionTokens: 50,
            totalTokens: 150
          },
          cost: 0.001,
          processingTime: 100,
          metadata: {},
          createdAt: new Date(),
          updatedAt: new Date()
        };

        (mockLLMProvider.chat as jest.Mock).mockResolvedValue({
          type: ResponseType.SUCCESS,
          payload: mockLLMResponse,
          timestamp: new Date()
        });

        const result = await planningAgent.execute(
          'Why is login failing?',
          mockSession,
          undefined,
          mockContext
        );

        expect(result.message).toContain('Hypothesis verified');
        // Verify only one LLM call (no separate state update)
        expect(mockLLMProvider.chat).toHaveBeenCalledTimes(1);
      });

      it('should format tool results clearly in message history', async () => {
        const mockTool = {
          name: 'static-analysis',
          execute: jest.fn().mockResolvedValue({
            success: true,
            summary: 'Analysis complete',
            evidence: [
              { file: '/test/src/auth.ts', line: 45, text: 'await saveUser()', description: 'Found issue' }
            ]
          })
        };

        (mockToolRegistry.getTool as jest.Mock) = jest.fn().mockReturnValue(mockTool);

        const mockLLMResponse1: LLMResponse = {
          id: 'response-1',
          requestId: 'step-0',
          provider: 'openai',
          model: 'gpt-4o',
          content: JSON.stringify({
            thought: 'Running analysis.',
            state_update: { new_facts: [], hypothesis_updates: [], new_hypotheses: [] },
            call_tools: [
              { name: 'static-analysis', arguments: { filePath: '/test/src/auth.ts', mode: 'flow' } }
            ]
          }),
          usage: { promptTokens: 100, completionTokens: 50, totalTokens: 150 },
          cost: 0.001,
          processingTime: 100,
          metadata: {},
          createdAt: new Date(),
          updatedAt: new Date()
        };

        const mockLLMResponse2: LLMResponse = {
          id: 'response-2',
          requestId: 'step-1',
          provider: 'openai',
          model: 'gpt-4o',
          content: JSON.stringify({
            thought: 'Done',
            state_update: { new_facts: [], hypothesis_updates: [], new_hypotheses: [] },
            final_response: 'Complete'
          }),
          usage: { promptTokens: 100, completionTokens: 50, totalTokens: 150 },
          cost: 0.001,
          processingTime: 100,
          metadata: {},
          createdAt: new Date(),
          updatedAt: new Date()
        };

        (mockLLMProvider.chat as jest.Mock)
          .mockResolvedValueOnce({
            type: ResponseType.SUCCESS,
            payload: mockLLMResponse1,
            timestamp: new Date()
          })
          .mockResolvedValueOnce({
            type: ResponseType.SUCCESS,
            payload: mockLLMResponse2,
            timestamp: new Date()
          });

        await planningAgent.execute(
          'Why is login failing?',
          mockSession,
          undefined,
          mockContext
        );

        // Verify the second LLM call received properly formatted tool results
        const secondCallArgs = (mockLLMProvider.chat as jest.Mock).mock.calls[1][0];
        // Find the user message that contains tool results (not the initial user message)
        const userMessages = secondCallArgs.messages.filter((m: any) => m.role === 'user');
        // The last user message should be the tool results
        const toolResultsMessage = userMessages[userMessages.length - 1];
        expect(toolResultsMessage.content).toContain('Step 0 Results');
        expect(toolResultsMessage.content).toContain('### Tool: static-analysis');
        expect(toolResultsMessage.content).toContain('Output:');
      });
    });

    describe('extractJsonFromText', () => {
      it('should extract clean JSON object', () => {
        const agent = planningAgent as any;
        const json = { thought: 'test', call_tools: [] };
        const text = JSON.stringify(json);
        const result = agent.extractJsonFromText(text);
        expect(JSON.parse(result!)).toEqual(json);
      });

      it('should extract JSON from text with prefix', () => {
        const agent = planningAgent as any;
        const json = { thought: 'analyzing', state_update: {} };
        const text = `Okay, here is the plan:\n${JSON.stringify(json)}`;
        const result = agent.extractJsonFromText(text);
        expect(JSON.parse(result!)).toEqual(json);
      });

      it('should extract JSON from text with suffix', () => {
        const agent = planningAgent as any;
        const json = { thought: 'done', final_response: 'complete' };
        const text = `${JSON.stringify(json)}\nAnd here is why I did it...`;
        const result = agent.extractJsonFromText(text);
        expect(JSON.parse(result!)).toEqual(json);
      });

      it('should extract JSON from text with prefix and suffix', () => {
        const agent = planningAgent as any;
        const json = { thought: 'checking', call_tools: [] };
        const text = `Here is the response:\n${JSON.stringify(json)}\nThis explains everything.`;
        const result = agent.extractJsonFromText(text);
        expect(JSON.parse(result!)).toEqual(json);
      });

      it('should extract JSON wrapped in markdown code blocks', () => {
        const agent = planningAgent as any;
        const json = { thought: 'wrapped', state_update: {} };
        const text = `\`\`\`json\n${JSON.stringify(json)}\n\`\`\``;
        const result = agent.extractJsonFromText(text);
        expect(JSON.parse(result!)).toEqual(json);
      });

      it('should ignore code blocks with braces after JSON', () => {
        const agent = planningAgent as any;
        const json = { thought: 'test', code_snippet: 'function x() { return 1; }' };
        const text = `${JSON.stringify(json)}\n\nAnd here is the code:\nfunction y() { return 2; }`;
        const result = agent.extractJsonFromText(text);
        expect(JSON.parse(result!)).toEqual(json);
      });

      it('should handle nested objects correctly', () => {
        const agent = planningAgent as any;
        const json = {
          thought: 'nested',
          state_update: {
            new_facts: ['fact1'],
            hypothesis_updates: [{ id: 'h1', status: 'verified' }]
          }
        };
        const text = `${JSON.stringify(json)}\nExtra text after.`;
        const result = agent.extractJsonFromText(text);
        expect(JSON.parse(result!)).toEqual(json);
      });

      it('should handle JSON with escaped quotes inside strings', () => {
        const agent = planningAgent as any;
        const json = { thought: 'He said "hello" to me', final_response: 'Done' };
        const text = `${JSON.stringify(json)}`;
        const result = agent.extractJsonFromText(text);
        expect(JSON.parse(result!)).toEqual(json);
      });

      it('should handle JSON with escaped backslashes', () => {
        const agent = planningAgent as any;
        const json = { thought: 'Path: C:\\Users\\Test', state_update: {} };
        const text = `${JSON.stringify(json)}`;
        const result = agent.extractJsonFromText(text);
        expect(JSON.parse(result!)).toEqual(json);
      });

      it('should handle JSON with code snippets containing braces in string values', () => {
        const agent = planningAgent as any;
        const json = {
          thought: 'Check this code',
          code_snippet: 'function x() { return { value: 1 }; }'
        };
        const text = `${JSON.stringify(json)}\n\nHere is more code: function y() { }`;
        const result = agent.extractJsonFromText(text);
        expect(JSON.parse(result!)).toEqual(json);
      });

      it('should extract last JSON object when multiple exist (prioritizes final response)', () => {
        const agent = planningAgent as any;
        const json1 = { thought: 'first', state_update: {} };
        const json2 = { thought: 'second', final_response: 'done' };
        const text = `${JSON.stringify(json1)}\n\n${JSON.stringify(json2)}`;
        const result = agent.extractJsonFromText(text);
        // Should extract the last JSON object (json2) since it's closer to the end
        // This is the correct behavior when explanation text appears before the actual response JSON
        expect(JSON.parse(result!)).toEqual(json2);
      });

      it('should return null when no JSON object found', () => {
        const agent = planningAgent as any;
        const text = 'This is just plain text with no JSON.';
        const result = agent.extractJsonFromText(text);
        expect(result).toBeNull();
      });

      it('should return null when only opening brace exists', () => {
        const agent = planningAgent as any;
        const text = 'Here is some text: { "incomplete": ';
        const result = agent.extractJsonFromText(text);
        expect(result).toBeNull();
      });

      it('should handle complex real-world LLM response with markdown', () => {
        const agent = planningAgent as any;
        const json = {
          thought: 'I need to analyze the authentication flow',
          state_update: {
            new_facts: ['User data is saved asynchronously'],
            hypothesis_updates: [],
            new_hypotheses: []
          },
          call_tools: [
            {
              name: 'static-analysis',
              arguments: { filePath: 'src/auth.ts', mode: 'flow' }
            }
          ]
        };
        const text = `Okay, here is the plan:

\`\`\`json
${JSON.stringify(json, null, 2)}
\`\`\`

This should help us debug the issue. Here is some example code:

\`\`\`typescript
function test() {
  return { value: 1 };
}
\`\`\`

Let me know if you need more details.`;
        const result = agent.extractJsonFromText(text);
        expect(JSON.parse(result!)).toEqual(json);
      });

      it('should handle JSON with deeply nested objects', () => {
        const agent = planningAgent as any;
        const json = {
          thought: 'deep nesting',
          state_update: {
            new_facts: ['fact1'],
            hypothesis_updates: [
              {
                id: 'h1',
                status: 'verified',
                metadata: {
                  evidence: {
                    file: 'test.ts',
                    line: 42
                  }
                }
              }
            ]
          }
        };
        const text = `${JSON.stringify(json)}`;
        const result = agent.extractJsonFromText(text);
        expect(JSON.parse(result!)).toEqual(json);
      });

      it('should handle JSON with arrays containing objects', () => {
        const agent = planningAgent as any;
        const json = {
          thought: 'array test',
          call_tools: [
            { name: 'tool1', arguments: { arg1: 'value1' } },
            { name: 'tool2', arguments: { arg2: 'value2' } }
          ]
        };
        const text = `${JSON.stringify(json)}`;
        const result = agent.extractJsonFromText(text);
        expect(JSON.parse(result!)).toEqual(json);
      });

      it('should extract JSON even when explanation text with code blocks appears before it', () => {
        const agent = planningAgent as any;
        const json = {
          thought: 'I need to confirm if the symbol variable is undefined.',
          state_update: {
            new_facts: [],
            hypothesis_updates: [{ id: 'h1', status: 'untested', confidence: 0.9 }],
            new_hypotheses: []
          },
          call_tools: [
            {
              name: 'static-analysis',
              arguments: {
                filePath: '/path/to/file.ts',
                mode: 'flow',
                target: 'runBackgroundAgent'
              }
            }
          ]
        };
        const text = `The user is encountering overly simplistic Mermaid graphs. My previous analysis highlighted the method.

The critical part of the code is where graph-context is called:

\`\`\`typescript
const [file, symbol] = preciseEpicenter.includes('::') 
  ? preciseEpicenter.split('::') 
  : [preciseEpicenter, undefined];

const graphTool = this.toolRegistry.getTool('graph-context');
if (graphTool) {
  const graphResult = await graphTool.execute({
    filePath: file,
    focusSymbol: symbol,
    depth: 4, 
    visualizationMode: 'hard-error'
  });
}
\`\`\`

The focusSymbol parameter is crucial. If it's undefined, the tool likely defaults to a file-level graph.

${JSON.stringify(json, null, 2)}`;
        const result = agent.extractJsonFromText(text);
        expect(result).not.toBeNull();
        const parsed = JSON.parse(result!);
        expect(parsed.thought).toBe(json.thought);
        expect(parsed.call_tools).toEqual(json.call_tools);
      });

      it('should handle the exact raw output format with long explanation before JSON', () => {
        const agent = planningAgent as any;
        const rawOutput = `The user is encountering overly simplistic Mermaid graphs, often with just one node, and suspects an issue with the epicenter or graph generation parameters. My previous \`static-analysis\` of \`DebugSessionController.ts\` highlighted the \`runBackgroundAgent\` method, specifically the section responsible for generating the final, refined graph.

The critical part of the code is where \`graph-context\` is called:

\`\`\`typescript

            const [file, symbol] = preciseEpicenter.includes('::') 

              ? preciseEpicenter.split('::') 

              : [preciseEpicenter, undefined];

            // Reuse the Tool Logic directly!

            const graphTool = this.toolRegistry.getTool('graph-context');

            if (graphTool) {

              const graphResult = await graphTool.execute({

                filePath: file,

                focusSymbol: symbol, // <--- This is the key input for detailed graphs

                depth: 4, 

                visualizationMode: 'hard-error'

              });

\`\`\`

The \`focusSymbol\` parameter is crucial for generating a detailed graph around a specific function or class. If \`focusSymbol\` is \`undefined\`, the \`graph-context\` tool likely defaults to a file-level graph, which often appears as a single node (the file itself) or a very shallow graph.

The \`preciseEpicenter\` variable is derived from the \`refineEpicenterSymbol\` method. This method's purpose is to take an initial file path (\`finalEpicenter\`) and refine it into a \`filePath::symbolName\` format using an LLM.

Upon reviewing the \`refineEpicenterSymbol\` method, I noticed several fallback points where it returns just the \`finalEpicenter\` (a file path) instead of a \`filePath::symbolName\` string:

1.  If \`filesAnalyzed\` is empty.

2.  If the \`analysisTool\` (static-analysis) is not found.

3.  If no symbols are extracted from the analyzed files (\`fileSymbols.length === 0\`).

4.  If the LLM call fails or returns an invalid payload.

5.  If the LLM's response does not match the expected \`file::symbol\` format or validation fails.

6.  A general \`catch\` block for any errors during the refinement process.

Any of these fallbacks would result in \`preciseEpicenter\` being a file path, causing the \`symbol\` variable to be \`undefined\` when passed to \`graphTool.execute\`. This directly leads to the "single node" or "too simple" graph issue.

**Hypothesis:** The \`refineEpicenterSymbol\` function is frequently failing to successfully extract and validate a precise symbol (e.g., function or class name) from the LLM response, or the LLM is consistently opting to return only the file path. This leads to the \`graph-context\` tool being invoked with \`focusSymbol: undefined\`, resulting in a basic file-level graph.

To confirm this, I need to trace the data flow to see if \`symbol\` is indeed \`undefined\` when \`graphTool.execute\` is called.

\`\`\`json

{

  "thought": "I need to confirm if the 'symbol' variable passed to \`graph-context\` is frequently \`undefined\`. I will use \`static-analysis\` with \`mode: 'flow'\` on the \`runBackgroundAgent\` method, specifically targeting the assignment of \`file\` and \`symbol\` and their usage in the \`graphTool.execute\` call.",

  "state_update": {

    "new_facts": [],

    "hypothesis_updates": [

      {

        "id": "h1",

        "status": "untested",

        "confidence": 0.9

      }

    ],

    "new_hypotheses": []

  },

  "call_tools": [

    {

      "name": "static-analysis",

      "arguments": {

        "filePath": "/Users/yutosuzuki/code/samurai-agent-vscode/samurai-agent/src/agent/controllers/DebugSessionController.ts",

        "mode": "flow",

        "target": "runBackgroundAgent",

        "flowConfig": {

          "traceExpressions": [

            "preciseEpicenter",

            "file",

            "symbol",

            "graphTool.execute"

          ]

        }

      }

    }

  ]

}

\`\`\``;

        const result = agent.extractJsonFromText(rawOutput);
        expect(result).not.toBeNull();
        expect(result).toBeTruthy();
        
        const parsed = JSON.parse(result!);
        
        // Verify it's valid PlanningAgent JSON structure
        expect(parsed).toHaveProperty('thought');
        expect(parsed).toHaveProperty('state_update');
        expect(parsed).toHaveProperty('call_tools');
        
        // Verify the content
        expect(parsed.thought).toContain("I need to confirm if the 'symbol' variable");
        expect(parsed.state_update).toBeDefined();
        expect(parsed.state_update.hypothesis_updates).toBeDefined();
        expect(Array.isArray(parsed.state_update.hypothesis_updates)).toBe(true);
        expect(parsed.state_update.hypothesis_updates[0].id).toBe('h1');
        expect(parsed.call_tools).toBeDefined();
        expect(Array.isArray(parsed.call_tools)).toBe(true);
        expect(parsed.call_tools[0].name).toBe('static-analysis');
        expect(parsed.call_tools[0].arguments.filePath).toContain('DebugSessionController.ts');
      });

      it('should handle the exact raw output format WITHOUT markdown code blocks', () => {
        const agent = planningAgent as any;
        const rawOutput = `The user is encountering overly simplistic Mermaid graphs, often with just one node, and suspects an issue with the epicenter or graph generation parameters. My previous \`static-analysis\` of \`DebugSessionController.ts\` highlighted the \`runBackgroundAgent\` method, specifically the section responsible for generating the final, refined graph.

The critical part of the code is where \`graph-context\` is called:

\`\`\`typescript
            const [file, symbol] = preciseEpicenter.includes('::') 
              ? preciseEpicenter.split('::') 
              : [preciseEpicenter, undefined];
            const graphTool = this.toolRegistry.getTool('graph-context');
            if (graphTool) {
              const graphResult = await graphTool.execute({
                filePath: file,
                focusSymbol: symbol,
                depth: 4, 
                visualizationMode: 'hard-error'
              });
            }
\`\`\`

The \`focusSymbol\` parameter is crucial for generating a detailed graph around a specific function or class. If \`focusSymbol\` is \`undefined\`, the \`graph-context\` tool likely defaults to a file-level graph, which often appears as a single node (the file itself) or a very shallow graph.

**Hypothesis:** The \`refineEpicenterSymbol\` function is frequently failing to successfully extract and validate a precise symbol. This leads to the \`graph-context\` tool being invoked with \`focusSymbol: undefined\`, resulting in a basic file-level graph.

To confirm this, I need to trace the data flow to see if \`symbol\` is indeed \`undefined\` when \`graphTool.execute\` is called.

{
  "thought": "I need to confirm if the 'symbol' variable passed to \`graph-context\` is frequently \`undefined\`. I will use \`static-analysis\` with \`mode: 'flow'\` on the \`runBackgroundAgent\` method, specifically targeting the assignment of \`file\` and \`symbol\` and their usage in the \`graphTool.execute\` call.",
  "state_update": {
    "new_facts": [],
    "hypothesis_updates": [
      {
        "id": "h1",
        "status": "untested",
        "confidence": 0.9
      }
    ],
    "new_hypotheses": []
  },
  "call_tools": [
    {
      "name": "static-analysis",
      "arguments": {
        "filePath": "/Users/yutosuzuki/code/samurai-agent-vscode/samurai-agent/src/agent/controllers/DebugSessionController.ts",
        "mode": "flow",
        "target": "runBackgroundAgent",
        "flowConfig": {
          "traceExpressions": [
            "preciseEpicenter",
            "file",
            "symbol",
            "graphTool.execute"
          ]
        }
      }
    }
  ]
}`;

        const result = agent.extractJsonFromText(rawOutput);
        expect(result).not.toBeNull();
        expect(result).toBeTruthy();
        
        const parsed = JSON.parse(result!);
        
        // Verify it's valid PlanningAgent JSON structure
        expect(parsed).toHaveProperty('thought');
        expect(parsed).toHaveProperty('state_update');
        expect(parsed).toHaveProperty('call_tools');
        
        // Verify the content matches
        expect(parsed.thought).toContain("I need to confirm if the 'symbol' variable");
        expect(parsed.state_update.hypothesis_updates[0].id).toBe('h1');
        expect(parsed.call_tools[0].name).toBe('static-analysis');
        expect(parsed.call_tools[0].arguments.filePath).toContain('DebugSessionController.ts');
      });

      it('should parse production raw output with fenced JSON and detailed markdown content', () => {
        const agent = planningAgent as any;

        const thoughtText = "I have completed the static analysis of `/Users/yutosuzuki/code/ninjasales/lib/tokenizer.ts`. The problem description indicates that the word frequency count is returning very few words (around five) with a count of one, even for long transcriptions. This strongly suggests an issue in how words are being tokenized or how their frequencies are being accumulated.\n\nHere's a breakdown of the relevant functions:\n\n1.  **`cleanTranscript(text: string): string[]`**: This function is responsible for parsing and cleaning transcript text, removing speaker names and timestamps. It uses a regex `speakerHeaderPattern` to identify segments. If no speaker headers are found, or if cleaning results in empty segments, it robustly falls back to returning the original text as a single segment. This part seems unlikely to be the root cause of 'few words, count one' for long transcriptions, as it correctly preserves the text content or breaks it by speaker.\n\n2.  **`tokenize(text: string): string[]`**: This function uses `new Intl.Segmenter('ja-JP', { granularity: 'word' })` to tokenize Japanese text. It filters for `isWordLike` segments and then removes words present in the `STOP_WORDS` set. While `Intl.Segmenter` is good for segmenting, it *does not* perform any normalization of the word forms themselves. For example, in Japanese, the same word might appear in Katakana (e.g., 'リンゴ') or Hiragana (e.g., 'りんご'), or different conjugations/inflections might be present. Without normalization, these would be treated as distinct words by the counting mechanism.\n\n3.  **`createTokenChunks(tokens: string[], chunkSize?: number): string[]`**: This function creates n-grams. The default `chunkSize` is `undefined` (or 1), meaning it counts individual tokens. If `chunkSize` were mistakenly set to a very large number, it could explain 'few words', but 'count one' for many unique large chunks would be odd for long text. The user's problem description does not suggest `chunkSize` is being misused, and it typically defaults to individual tokens, so this is less likely.\n\n4.  **`getFrequency(...)`**: This is the main function that orchestrates the grouping, cleaning, tokenization, and counting. It accumulates `wordCounts` in a `Record<string, number>`. The critical observation here is that the keys for `wordCounts` are taken directly from the `token` strings returned by `tokenize`. If `tokenize` produces variations of the same semantic word, they will be stored as different keys in `wordCounts`, each with a count of 1 (if they appear only once in that specific form). This perfectly matches the user's symptom.\n\n**Root Cause Identification (from Static Analysis):**\n\nThe most probable root cause for the observed behavior ('very few words, like five words, and the count is one, even though I feed very long transcriptions') is the **lack of text normalization** within the tokenization and counting process.\n\nThe `tokenize` function, while effectively splitting text into word-like segments using `Intl.Segmenter`, does not perform any subsequent normalization. This means that different textual representations of the same semantic word (e.g., 'リンゴ' (Katakana) vs. 'りんご' (Hiragana) for 'apple', or different conjugations/inflections of a verb) will be treated as distinct words. Consequently, instead of aggregating their counts, the `wordCounts` map will store each variation as a unique entry, leading to individual counts of '1' for each distinct variation, even if the underlying concept appears multiple times in the transcription. After filtering by `topK` (default 50), if most words are unique variations or stop words, only a few distinct variations might remain, each with a count of 1.\n\nThis behavior is especially critical for Japanese text analysis where such variations are common.\n\n**Hypothesis Confirmation:** The static analysis strongly supports the hypothesis that the issue lies in the lack of normalization, causing distinct counting for semantically identical words.\n\nAlthough the original request mentioned runtime analysis, the 'Your Task' explicitly asked for static analysis to explain the root cause. This static analysis identifies a clear logical flaw that perfectly explains the reported symptoms.";

        const finalResponseText = "## Root Cause: Lack of Text Normalization in Japanese Tokenization\n\nThe primary reason for the frequency count returning very few words, with counts of one, despite processing long transcriptions, stems from the **absence of text normalization** within the `tokenize` function and the subsequent word counting process.\n\n### Detailed Explanation:\n\n1.  **`tokenize` Function Behavior:** The `/Users/yutosuzuki/code/ninjasales/lib/tokenizer.ts` file uses `Intl.Segmenter('ja-JP', { granularity: 'word' })` to break down Japanese text into individual word segments. While `Intl.Segmenter` is effective for segmentation, it **does not inherently normalize** different textual forms of the same word.\n\n    *   **Example for Japanese:** The word 'apple' can be written as 'リンゴ' (Katakana) or 'りんご' (Hiragana). Without normalization, `Intl.Segmenter` will treat 'リンゴ' and 'りんご' as two distinct words.\n    *   Similarly, various conjugations or inflections of a verb might also be treated as separate words if no stemming or lemmatization is applied (though for basic frequency, consistent character form is usually the first step).\n\n2.  **`getFrequency` Accumulation:** The `getFrequency` function iterates through these tokens and directly uses them as keys in the `wordCounts` object (`wordCounts[token] = (wordCounts[token] || 0) + 1;`). Because 'リンゴ' and 'りんご' are considered different strings, they become separate keys in `wordCounts`. If each distinct form appears only once in the entire transcription, their individual counts will always be '1'.\n\n3.  **Observed Symptom Explanation:** This behavior directly explains the user's observation:\n    *   **\\\"Very few words\\\"**: If a long transcription frequently uses the same concepts but in varying textual forms (e.g., switching between Katakana and Hiragana), the total number of *unique string forms* (after stop word filtering) will be relatively low.\n\n    *   **\\\"Count is one\\\"**: Each of these unique string forms will typically have a count of '1' because instances of the semantically identical word, but in a different form, are counted separately under their own unique keys.\n\n### The Fix:\n\nTo correctly aggregate word frequencies, a **text normalization step** needs to be introduced *before* words are added to the `wordCounts` map. For Japanese, a common and effective normalization is to convert Katakana to Hiragana.\n\n**Suggested Change:**\n\nModify the `tokenize` function to include a normalization step. Here's how you could modify the `tokenize` function:\n\nBy adding `toHiragana(word)` (assuming `wanakana` library is installed), 'リンゴ' would be converted to 'りんご' before being counted, ensuring they are treated as the same word and their frequencies are correctly aggregated. This should resolve the issue of words having a count of one and the overall low number of unique words.";

        const productionJson = {
          thought: thoughtText,
          state_update: {
            new_facts: [
              'The `tokenize` function uses `Intl.Segmenter` but does not perform text normalization (e.g., Katakana to Hiragana conversion or handling inflections).',
              'The `wordCounts` map stores words as distinct keys based on their literal string form, without normalization.'
            ],
            hypothesis_updates: [
              {
                id: 'h1',
                status: 'verified',
                confidence: 0.95
              }
            ],
            new_hypotheses: []
          },
          final_response: finalResponseText
        };

        const rawOutput = `\`\`\`json\n\n${JSON.stringify(productionJson, null, 2).replace(/\\n/g, '\n')}\n\`\`\``;
        const result = agent.extractJsonFromText(rawOutput);

        expect(result).not.toBeNull();
        const parsed = JSON.parse(result!);
        expect(parsed.thought).toContain('completed the static analysis');
        expect(parsed.state_update.hypothesis_updates[0].confidence).toBeCloseTo(0.95);
        expect(parsed.state_update.new_facts.length).toBe(2);
        expect(parsed.final_response).toContain('Root Cause: Lack of Text Normalization');
      });

      it('should parse runtime-debug request raw output with multiline setup_script', () => {
        const agent = planningAgent as any;

        const rawOutput = `\`\`\`json

{

  "thought": "I have reviewed the source code of \`tokenizer.ts\`. The \`getFrequency\` function is indeed the core of the word frequency count. Based on the user's description ('very few words, like five words, and the count is one, even though I feed very long transcriptions'), I need to perform a runtime analysis to pinpoint where the words are being lost or miscounted. This behavior suggests that either the input text isn't being processed correctly, or tokens are being filtered out aggressively, or the counting mechanism itself is flawed (though the \`(wordCounts[chunk] || 0) + 1\` pattern is standard).\\n\\nTo conduct a thorough runtime analysis, I will set up a test scenario with a sample long transcription. I will then use \`runtime-debug\` to observe the values of key variables at different stages of the \`getFrequency\` function's execution:\\n\\n1.  **\`getFrequency\` input**: Verify the initial \`data\`, \`textColumn\`, \`groupColumns\`, \`topK\`, and \`chunkSize\` to ensure the test setup is correct.\\n2.  **\`cleanTranscript\` output**: Check \`cleanedSegments\` to see if the transcript cleaning step is working as expected and if segments are being extracted properly.\\n3.  **\`tokenize\` output**: Inspect \`tokens\` to understand what words are being identified after segmentation and stop word removal.\\n4.  **\`wordCounts\` accumulation**: Observe the \`wordCounts\` map to see if words are correctly being added and their counts incremented.\\n5.  **Final \`words\` array**: Examine the sorted and sliced \`words\` array before it's returned, to confirm the final output.\\n\\nI will create a dummy dataset that simulates a long transcription with multiple speakers and different words to fully test the logic. This will help confirm if the issue is with \`cleanTranscript\`, \`tokenize\`, or the counting aggregation.",

  "state_update": {

    "new_facts": [],

    "hypothesis_updates": [],

    "new_hypotheses": [

      {

        "id": "h1",

        "description": "The issue lies either in \`cleanTranscript\` incorrectly processing the input transcription, \`tokenize\` being too aggressive with filtering (\`isWordLike\` or \`STOP_WORDS\`), or the input data itself is not as 'long' as perceived after cleaning and tokenization. The 'count is one' symptom particularly suggests very few unique tokens are making it to the counting stage.",

        "confidence": 0.7

      }

    ]

  },

  "call_tools": [

    {

      "name": "runtime-debug",

      "arguments": {

        "description": "Debug \`getFrequency\` function with a long sample transcription to analyze \`cleanTranscript\` output, \`tokenize\` output, and \`wordCounts\` accumulation.",

        "targets": [

          {

            "file": "/Users/yutosuzuki/code/ninjasales/lib/tokenizer.ts",

            "line": 105,

            "expression": "cleanedSegments"

          },

          {

            "file": "/Users/yutosuzuki/code/ninjasales/lib/tokenizer.ts",

            "line": 109,

            "expression": "tokens"

          },

          {

            "file": "/Users/yutosuzuki/code/ninjasales/lib/tokenizer.ts",

            "line": 115,

            "expression": "wordCounts"

          },

          {

            "file": "/Users/yutosuzuki/code/ninjasales/lib/tokenizer.ts",

            "line": 124,

            "expression": "words"

          }

        ],

        "setup_script": "
import { getFrequency } from './tokenizer';

const sampleData = [
  {
    id: 1,
    speaker: 'John',
    transcript: 'John (00:00:01): こんにちは、私はジョンです。今日は良い天気ですね。今日も頑張りましょう。John (00:00:05): ありがとう、私もそう思います。このプロジェクトは素晴らしいです。成功させましょう。',
    department: 'Sales'
  },
  {
    id: 2,
    speaker: 'Jane',
    transcript: 'Jane (00:00:10): こんにちは、ジェーンです。このプロジェクトはとても重要です。成功に向けて協力します。良い結果を出しましょう。Jane (00:00:15): はい、私も同意見です。頑張ります。',
    department: 'Marketing'
  }
];

const textColumn = 'transcript';
const groupColumns = 'department';
const topK = 50;
const chunkSize = 1; // Test with individual words first

console.log('Running getFrequency with sample data...');
const result = getFrequency(sampleData, textColumn, groupColumns, topK, chunkSize);
console.log('getFrequency result:', JSON.stringify(result, null, 2));
"

      }

    }

  ]

}

`;

        const result = agent.extractJsonFromText(rawOutput);
        expect(result).not.toBeNull();

        const parsed = JSON.parse(result!);
        expect(parsed.call_tools?.[0]?.name).toBe('runtime-debug');
        expect(parsed.state_update?.new_hypotheses?.[0]?.id).toBe('h1');
        expect(parsed.thought).toContain('getFrequency');
      });

      it('should parse raw output from 2025-12-10 with large sandbox write content', () => {
        const agent = planningAgent as any;
        const fixturePath = path.join(
          __dirname,
          'fixtures',
          'planning-agent',
          'raw-output-2025-12-10.txt'
        );
        const rawOutput = fs.readFileSync(fixturePath, 'utf-8');

        const result = agent.extractJsonFromText(rawOutput);
        expect(result).not.toBeNull();

        const parsed = JSON.parse(result!);
        expect(parsed.thought).toContain('getFrequency.ts');
        expect(parsed.call_tools?.[0]?.name).toBe('sandbox-fs');
        expect(parsed.call_tools?.[0]?.arguments?.filename).toBe('run_tests.ts');
      });

      it('should repair doubled quotes in production raw output from 2025-12-09', () => {
        const agent = planningAgent as any;
        const fixturePath = path.join(
          __dirname,
          'fixtures',
          'planning-agent',
          'raw-output-2025-12-09.txt'
        );
        const rawOutput = fs.readFileSync(fixturePath, 'utf-8');

        const result = agent.extractJsonFromText(rawOutput);
        expect(result).not.toBeNull();

        const parsed = JSON.parse(result!);
        expect(parsed.thought).toContain('runtime analysis');
        expect(parsed.state_update?.new_facts?.[0]).toContain('getFrequency');
        expect(parsed.call_tools?.[0]?.name).toBe('sandbox-fs');
      });

      it('should repair labeled array entries inside runtime-debug args (2025-12-11)', () => {
        const agent = planningAgent as any;

        const rawOutput = `\`\`\`json
{
  "thought": "I have thoroughly analyzed the source code of the \`getFrequency\` function and its dependencies (\`shouldCount\`, \`cleanTranscript\`, \`tokenize\`, \`createTokenChunks\`). I've identified several edge cases for input data, text content, and the filtering logic within \`shouldCount\`.\\n\\nTo conduct a robust runtime analysis as requested, I will use \`runtime-debug\` with a comprehensive set of test data. This data will cover:\\n\\n1.  **Basic Counting:** Verify that common words are counted correctly, and stop words, single characters, two-character hiragana, and punctuation are filtered out by \`shouldCount\`.\\n2.  **N-gram Counting:** Test with \`chunkSize > 1\` to ensure overlapping n-grams are created and counted correctly.\\n3.  **Empty/Invalid Inputs:** Ensure the function gracefully handles empty \`data\` arrays, missing \`textColumn\` values, and empty \`groupColumns\`.\\n4.  **\`cleanTranscript\` verification:** Include text with timestamps and speaker information to confirm they are removed as expected.\\n5.  **Mixed Casing/Repetitions:** Verify that repeated words are counted accurately.\\n\\nI will target key lines where \`wordCounts\` are updated and where the final \`results\` are pushed to observe the intermediate and final states of the frequency map.\\n\\n**Hypothesis:** The \`getFrequency\` function, with its helper functions, appears to have a well-structured filtering and counting mechanism. However, runtime verification is essential to confirm its behavior across all specified edge cases, especially given the complexities of Japanese text processing and \`Intl.Segmenter\`'s behavior.",
  "state_update": {
    "new_facts": [
      "The \`getFrequency\` function uses \`shouldCount\`, \`cleanTranscript\`, \`tokenize\` (with \`Intl.Segmenter\`), and \`createTokenChunks\`.",
      "\`shouldCount\` filters tokens based on length (1 char, 2-char hiragana), a predefined \`STOP_WORDS\` set, and common punctuation.",
      "\`cleanTranscript\` removes \`(HH:MM:SS): \` timestamps.",
      "\`createTokenChunks\` generates overlapping n-grams.",
      "Word counting uses a \`Record<string, number>\` for frequency accumulation."
    ],
    "hypothesis_updates": [],
    "new_hypotheses": [
      {
        "id": "h1",
        "description": "\`getFrequency\` correctly counts words and n-grams in various edge cases, including filtering stop words, punctuation, and handling timestamps, despite the complexity of Japanese text processing.",
        "confidence": 0.7
      }
    ]
  },
  "call_tools": [
    {
      "name": "runtime-debug",
      "arguments": {
        "description": "Verify getFrequency function's word and n-gram counting in various edge cases, including empty inputs, filtered words, and timestamps.",
        "targets": [
          { "file": "/Users/yutosuzuki/code/ninjasales/lib/tokenizer.ts", "line": 92, "expression": "token" },
          { "file": "/Users/yutosuzuki/code/ninjasales/lib/tokenizer.ts", "line": 92, "expression": "wordCounts" },
          { "file": "/Users/yutosuzuki/code/ninjasales/lib/tokenizer.ts", "line": 98, "expression": "chunk" },
          { "file": "/Users/yutosuzuki/code/ninjasales/lib/tokenizer.ts", "line": 98, "expression": "wordCounts" },
          { "file": "/Users/yutosuzuki/code/ninjasales/lib/tokenizer.ts", "line": 108, "expression": "words" },
          { "file": "/Users/yutosuzuki/code/ninjasales/lib/tokenizer.ts", "line": 108, "expression": "results" }
        ],
        "setup": {
          "mode": "function",
          "function_name": "getFrequency",
          "args": [
            [
              { "id": "1", "text_content": "Speaker A (00:00:10): これはテストです。これはテストです。日本語の単語。", "category": "Sales" },
              { "id": "2", "text_content": "Speaker B (00:00:20): まあまあ、そうですか。私はリンゴが好きです。", "category": "Support" },
              { "id": "3", "text_content": "Speaker C (00:00:30): あ い う え お かき くけこ。漢字テスト。", "category": "Sales" },
              { "id": "4", "text_content": "Speaker D (00:00:40): 。、！？です。空白 のみ。", "category": "Support" },
              { "id": "5", "text_content": null, "category": "Sales" },
              { "id": "6", "text_content": "全く新しい言葉です。新しい言葉。", "category": "Marketing" }
            ],
            "text_content": "text_content",
            "groupColumns": "category",
            "topK": 100,
            "chunkSize": 2
          ]
        }
      }
    }
  ]
}
\`\`\``;

        const result = agent.extractJsonFromText(rawOutput);
        expect(result).not.toBeNull();

        const parsed = JSON.parse(result!);
        const args = parsed.call_tools?.[0]?.arguments?.setup?.args;

        expect(Array.isArray(args)).toBe(true);
        expect(args?.length).toBe(5);
        expect(args?.[1]).toBe('text_content');
        expect(args?.[2]).toBe('category');
        expect(args?.[3]).toBe(100);
        expect(args?.[4]).toBe(2);
      });

      it('should repair runtime-debug targets with undefined columns and preserve details (2025-12-12)', () => {
        const agent = planningAgent as any;
        const fixturePath = path.join(
          __dirname,
          'fixtures',
          'planning-agent',
          'raw-output-2025-12-12.txt'
        );
        const rawOutput = fs.readFileSync(fixturePath, 'utf-8');

        const result = agent.extractJsonFromText(rawOutput);
        expect(result).not.toBeNull();

        const parsed = JSON.parse(result!);
        expect(parsed.call_tools?.[0]?.name).toBe('runtime-debug');
        expect(parsed.call_tools?.[0]?.arguments?.targets).toHaveLength(4);
        expect(parsed.call_tools?.[0]?.arguments?.targets?.[0]).toEqual({
          file: '/Users/yutosuzuki/code/ninjasales/lib/tokenizer.ts',
          line: 48,
          expression: 'cleaned'
        });
        expect(parsed.call_tools?.[0]?.arguments?.description).toContain('Fallback targets');
        expect(parsed.call_tools?.[0]?.arguments?.description).toContain('/Users/yutosuzuki/code/ninjasales/lib/tokenizer.ts');
      });

      it('should parse raw output with fenced JSON starting with newline after json marker (error from 2025-12-10)', () => {
        const agent = planningAgent as any;
        
        // This reproduces the exact error scenario where the LLM output starts with ```json\n{
        // and the parser was encountering "j" from "json" when trying to parse
        const rawOutput = `\`\`\`json
{
  "thought": "I have retrieved the source code for the \`getFrequency\` function. Now, I need to perform a runtime analysis focusing on edge cases, as requested by the user.\\n\\nAfter reviewing the code, I've identified several key areas and potential edge cases for runtime verification:\\n\\n1.  **Input Data (\`data\` array):**\\n    *   Empty \`data\` array.\\n    *   Rows with \`null\`, \`undefined\`, or empty values for \`textColumn\` or \`groupColumns\`.\\n2.  **\`groupColumns\` parameter:**\\n    *   \`groupColumns\` is an empty string (\`''\`).\\n    *   \`groupColumns\` is an array containing only empty or \`null\`/\`undefined\` strings (e.g., \`['', null]\`).\\n    *   \`groupColumns\` refers to non-existent columns.\\n3.  **\`textColumn\` parameter:**\\n    *   \`textColumn\` refers to a non-existent column.\\n    *   Values in \`textColumn\` lead to no tokens after \`cleanTranscript\` and \`tokenize\` (e.g., just punctuation, very short words filtered out by \`shouldCount\`).\\n4.  **\`topK\` parameter:**\\n    *   \`topK = 0\` (should return no words).\\n    *   \`topK = 1\` (should return only the highest frequency word).\\n    *   \`topK\` is greater than the total number of unique words found.\\n5.  **\`chunkSize\` parameter:**\\n    *   \`chunkSize\` is \`undefined\`, \`0\`, or \`1\` (should only count individual tokens, no n-grams).\\n    *   \`chunkSize\` is \`2\` or \`3\` (to verify n-gram creation and counting).\\n    *   \`chunkSize\` is larger than the number of tokens in a segment (should not cause errors, \`createTokenChunks\` should handle this gracefully).\\n\\nTo address the user's request for runtime analysis on these edge cases, I will use the \`runtime-debug\` tool. I will provide a detailed \`description\` outlining various test scenarios, and specify \`targets\` to capture the state of key variables at critical points in the \`getFrequency\` function. This will allow me to observe how the function handles these edge cases and confirm if counting works properly.\\n\\n**Selected lines for \`runtime-debug\` targets:**\\n*   Line 118: \`grouped\` (to observe how data is grouped, especially with \`Uncategorized\` and empty group columns).\\n*   Line 138: \`wordCounts\` (after individual tokens are counted, inside the inner loop, to verify base token counting).\\n*   Line 144: \`wordCounts\` (after n-grams are counted, if \`chunkSize\` is active, to verify n-gram counting).\\n*   Line 155: \`words\` (the final sorted and sliced word frequencies for a group, to check \`topK\` and sorting).\\n*   Line 157: \`results\` (the final output of the \`getFrequency\` function, to verify overall correctness across all groups).\\n\\nBy examining these variables across different scenarios, I can confirm the function's behavior in edge cases and ensure correct counting.",
  "state_update": {
    "new_facts": [
      "The \`getFrequency\` function normalizes \`groupColumns\` and handles \`null\`/\`undefined\`/empty values for text and group columns using \`|| ''\` and \`|| 'Uncategorized'\`.",
      "The function uses \`cleanTranscript\` and \`tokenize\` (external dependencies) before counting tokens.",
      "N-gram counting is conditional on \`chunkSize\` being \`> 1\`.",
      "The function sorts and slices results based on \`topK\`."
    ],
    "hypothesis_updates": [
      {
        "id": "h_runtime_analysis_needed",
        "status": "active",
        "confidence": 0.9
      }
    ],
    "new_hypotheses": []
  },
  "call_tools": [
    {
      "name": "runtime-debug",
      "arguments": {
        "description": "Conduct runtime analysis on the \`getFrequency\` function to verify correct counting and behavior in various edge cases. \\n\\n**Test Scenarios:**\\n1.  **Basic functionality:** Verify correct token and bi-gram counting with valid \`data\`, \`textColumn\`, \`groupColumns='category'\`, \`topK=2\`, \`chunkSize=2\`.\\n2.  **Empty \`data\` array:** Call \`getFrequency\` with \`data=[]\`. Expect \`results\` to be \`[]\`.\\n3.  **Empty/Invalid \`groupColumns\`:** Call \`getFrequency\` with \`groupColumns=''\` or \`groupColumns=['', null, '   ']\`. Expect \`results\` to be \`[]\`.\\n4.  **Missing \`textColumn\` values:** Use data where \`row[textColumn]\` is \`null\`, \`undefined\`, or \`''\`. Verify \`wordCounts\` are empty for such segments.\\n5.  **Missing \`groupColumns\` values:** Use data where \`row[groupColumn]\` is \`null\` or \`''\`. Verify \`groupKey\` becomes 'Uncategorized'.\\n6.  **\`topK = 0\`:** Call \`getFrequency\` with \`topK=0\`. Expect \`words\` array for each group to be empty.\\n7.  **\`topK = 1\`:** Call \`getFrequency\` with \`topK=1\`. Expect \`words\` array for each group to contain only one word.\\n8.  **\`chunkSize = 0\` or \`1\` (no n-grams):** Call \`getFrequency\` with \`chunkSize=0\` and \`chunkSize=1\`. Verify that only individual tokens are counted (line 138 \`wordCounts\` should populate, line 144 \`wordCounts\` should not change for chunks).\\n9.  **\`textColumn\` leading to no valid tokens:** Use text like '...', '!!!', or very short stopwords to ensure \`cleanTranscript\`, \`tokenize\`, and \`shouldCount\` correctly result in empty token lists and zero counts.\\n\\nMock \`cleanTranscript\` to return \`['cleaned segment']\` and \`tokenize\` to return \`['token1', 'token2', 'token1']\` for basic testing, and \`[]\` for edge cases where text should yield no tokens. Mock \`shouldCount\` to always return true for 'token1', 'token2', 'token1 token2' for simplicity in counting verification.",
        "targets": [
          {
            "filePath": "/Users/yutosuzuki/code/ninjasales/lib/tokenizer.ts",
            "line": 118,
            "expression": "grouped"
          },
          {
            "filePath": "/Users/yutosuzuki/code/ninjasales/lib/tokenizer.ts",
            "line": 138,
            "expression": "wordCounts"
          },
          {
            "filePath": "/Users/yutosuzuki/code/ninjasales/lib/tokenizer.ts",
            "line": 144,
            "expression": "wordCounts"
          },
          {
            "filePath": "/Users/yutosuzuki/code/ninjasales/lib/tokenizer.ts",
            "line": 155,
            "expression": "words"
          },
          {
            "filePath": "/Users/yutosuzuki/code/ninjasales/lib/tokenizer.ts",
            "line": 157,
            "expression": "results"
          }
        ]
      }
    }
  ]
}
\`\`\``;

        const result = agent.extractJsonFromText(rawOutput);
        expect(result).not.toBeNull();
        
        const parsed = JSON.parse(result!);
        expect(parsed.thought).toContain('retrieved the source code');
        expect(parsed.state_update.new_facts).toHaveLength(4);
        expect(parsed.call_tools).toHaveLength(1);
        expect(parsed.call_tools[0].name).toBe('runtime-debug');
        expect(parsed.call_tools[0].arguments.targets).toHaveLength(5);
      });
    });

    describe('looksLikeCompleteFinalAnalysis', () => {
      const pad = (s: string) => s + ' '.repeat(Math.max(0, 210 - s.length));

      it('should return false for content starting with { (attempted JSON)', () => {
        const agent = planningAgent as any;
        expect(agent.looksLikeCompleteFinalAnalysis(pad('{ "thought": "test" }'))).toBe(false);
        expect(agent.looksLikeCompleteFinalAnalysis(pad('  { "invalid": json'))).toBe(false);
        expect(agent.looksLikeCompleteFinalAnalysis(pad('{\n  "key": "value"\n}'))).toBe(false);
      });

      it('should return false for short content (< 200 chars)', () => {
        const agent = planningAgent as any;
        expect(agent.looksLikeCompleteFinalAnalysis('# Root Cause\n\nShort.')).toBe(false);
        expect(agent.looksLikeCompleteFinalAnalysis('I found the issue.')).toBe(false);
      });

      it('should return true for long markdown analysis with headers', () => {
        const agent = planningAgent as any;
        const markdown = '## Root Cause\n\nThe issue is that the function fails to handle the edge case where the input array is empty. This causes an undefined reference error when the code attempts to access the first element. The fix should add an early return check at the start of the function to handle empty arrays gracefully.';
        expect(agent.looksLikeCompleteFinalAnalysis(markdown)).toBe(true);
      });

      it('should return true for long plain text analysis with keywords', () => {
        const agent = planningAgent as any;
        const text = 'I have analyzed the code and found the root cause of the problem. The bug is in the authentication module where the token validation skips the expiration check under certain conditions. This causes expired tokens to be accepted, leading to security issues. The solution is to always validate the token expiration timestamp.';
        expect(agent.looksLikeCompleteFinalAnalysis(text)).toBe(true);
      });

      it('should return false for content containing PlanningAgent JSON patterns', () => {
        const agent = planningAgent as any;
        const withJsonPatterns = pad('Here is my analysis with "thought": "some reasoning" about the root cause of the problem in the code.');
        expect(agent.looksLikeCompleteFinalAnalysis(withJsonPatterns)).toBe(false);
      });

      it('should return false for empty or null content', () => {
        const agent = planningAgent as any;
        expect(agent.looksLikeCompleteFinalAnalysis('')).toBe(false);
        expect(agent.looksLikeCompleteFinalAnalysis(null as any)).toBe(false);
      });
    });

    describe('containsJsonAttemptPattern', () => {
      it('should detect JSON starting with {', () => {
        const agent = planningAgent as any;
        expect(agent.containsJsonAttemptPattern('{ "thought": "test" }')).toBe(true);
        expect(agent.containsJsonAttemptPattern('  { "invalid": json')).toBe(true);
        expect(agent.containsJsonAttemptPattern('{\n  "key": "value"\n}')).toBe(true);
      });

      it('should detect JSON code blocks', () => {
        const agent = planningAgent as any;
        expect(agent.containsJsonAttemptPattern('```json\n{ "test": true }\n```')).toBe(true);
        expect(agent.containsJsonAttemptPattern('```\n{ "test": true }\n```')).toBe(true);
      });

      it('should detect PlanningAgent-specific JSON patterns', () => {
        const agent = planningAgent as any;
        // Single pattern - should not match (needs at least 2)
        expect(agent.containsJsonAttemptPattern('Here is my thought: "thought": "test"')).toBe(false);
        
        // Multiple patterns - should match
        expect(agent.containsJsonAttemptPattern('Here is the JSON with "thought": "test" and "call_tools": []')).toBe(true);
        expect(agent.containsJsonAttemptPattern('"state_update": {} and "new_facts": []')).toBe(true);
        expect(agent.containsJsonAttemptPattern('"hypothesis_updates": [] and "final_response": "done"')).toBe(true);
      });

      it('should detect generic JSON object patterns', () => {
        const agent = planningAgent as any;
        expect(agent.containsJsonAttemptPattern('Some text before { "key": "value" }')).toBe(true);
        expect(agent.containsJsonAttemptPattern('Here is JSON: { "test": 123 }')).toBe(true);
      });

      it('should not match plain text without JSON patterns', () => {
        const agent = planningAgent as any;
        expect(agent.containsJsonAttemptPattern('This is just plain text')).toBe(false);
        expect(agent.containsJsonAttemptPattern('## Root Cause\n\nThe issue is...')).toBe(false);
        expect(agent.containsJsonAttemptPattern('I found the issue.')).toBe(false);
      });

      it('should be case-insensitive for PlanningAgent patterns', () => {
        const agent = planningAgent as any;
        expect(agent.containsJsonAttemptPattern('"THOUGHT": "test" and "CALL_TOOLS": []')).toBe(true);
        expect(agent.containsJsonAttemptPattern('"Thought": "test" and "Call_Tools": []')).toBe(true);
      });
    });

    describe('JSON parsing error handling - malformed JSON retry logic', () => {
      it('should retry when JSON extraction succeeds but parsing fails (malformed JSON)', async () => {
        // First call - malformed JSON (extra bracket)
        const malformedResponse: LLMResponse = {
          id: 'response-1',
          requestId: 'step-0',
          provider: 'openai',
          model: 'gpt-4o',
          content: `{
            "thought": "My analysis",
            "state_update": {
              "new_facts": [],
              "new_hypotheses": [] ]
            },
            "call_tools": []
          }`,
          usage: {
            promptTokens: 100,
            completionTokens: 50,
            totalTokens: 150
          },
          cost: 0.001,
          processingTime: 100,
          metadata: {},
          createdAt: new Date(),
          updatedAt: new Date()
        };

        // Second call - valid JSON after correction
        const validResponse: LLMResponse = {
          id: 'response-2',
          requestId: 'step-0',
          provider: 'openai',
          model: 'gpt-4o',
          content: JSON.stringify({
            thought: 'Fixed JSON',
            state_update: {
              new_facts: [],
              hypothesis_updates: [],
              new_hypotheses: []
            },
            final_response: 'Analysis complete'
          }),
          usage: {
            promptTokens: 100,
            completionTokens: 50,
            totalTokens: 150
          },
          cost: 0.001,
          processingTime: 100,
          metadata: {},
          createdAt: new Date(),
          updatedAt: new Date()
        };

        (mockLLMProvider.chat as jest.Mock)
          .mockResolvedValueOnce({
            type: ResponseType.SUCCESS,
            payload: malformedResponse,
            timestamp: new Date()
          })
          .mockResolvedValueOnce({
            type: ResponseType.SUCCESS,
            payload: validResponse,
            timestamp: new Date()
          });

        const result = await planningAgent.execute(
          'Why is login failing?',
          mockSession,
          undefined,
          mockContext
        );

        expect(result.message).toBe('Analysis complete');
        // Should have been called twice (initial + retry)
        expect(mockLLMProvider.chat).toHaveBeenCalledTimes(2);
        
        // Verify correction message was added
        const calls = (mockLLMProvider.chat as jest.Mock).mock.calls;
        const retryCall = calls[1];
        expect(retryCall[0].messages[retryCall[0].messages.length - 1].content).toContain('SYSTEM ERROR');
        expect(retryCall[0].messages[retryCall[0].messages.length - 1].content).toContain('invalid JSON');
      });

      it('should retry when malformed JSON has text prefix (key scenario from bug report)', async () => {
        // This is the exact scenario from the bug report:
        // Text before JSON, JSON is malformed, should retry (not send to user)
        const malformedWithPrefix: LLMResponse = {
          id: 'response-1',
          requestId: 'step-0',
          provider: 'openai',
          model: 'gpt-4o',
          content: `Here's my analysis:
\`\`\`json
{
  "thought": "My broad searches",
  "state_update": {
    "new_facts": [],
    "new_hypotheses": [] ]
  },
  "call_tools": []
}
\`\`\``,
          usage: {
            promptTokens: 100,
            completionTokens: 50,
            totalTokens: 150
          },
          cost: 0.001,
          processingTime: 100,
          metadata: {},
          createdAt: new Date(),
          updatedAt: new Date()
        };

        // Valid response after retry
        const validResponse: LLMResponse = {
          id: 'response-2',
          requestId: 'step-0',
          provider: 'openai',
          model: 'gpt-4o',
          content: JSON.stringify({
            thought: 'Corrected JSON',
            state_update: {
              new_facts: [],
              hypothesis_updates: [],
              new_hypotheses: []
            },
            final_response: 'Fixed the JSON issue'
          }),
          usage: {
            promptTokens: 100,
            completionTokens: 50,
            totalTokens: 150
          },
          cost: 0.001,
          processingTime: 100,
          metadata: {},
          createdAt: new Date(),
          updatedAt: new Date()
        };

        (mockLLMProvider.chat as jest.Mock)
          .mockResolvedValueOnce({
            type: ResponseType.SUCCESS,
            payload: malformedWithPrefix,
            timestamp: new Date()
          })
          .mockResolvedValueOnce({
            type: ResponseType.SUCCESS,
            payload: validResponse,
            timestamp: new Date()
          });

        const result = await planningAgent.execute(
          'Why is login failing?',
          mockSession,
          undefined,
          mockContext
        );

        // Should NOT send malformed JSON to user, should retry and get corrected version
        expect(result.message).toBe('Fixed the JSON issue');
        // Should have been called twice (initial + retry)
        expect(mockLLMProvider.chat).toHaveBeenCalledTimes(2);
      });

      it('should retry when JSON patterns detected but extraction fails', async () => {
        // JSON patterns exist but extraction fails (incomplete JSON)
        const incompleteJson: LLMResponse = {
          id: 'response-1',
          requestId: 'step-0',
          provider: 'openai',
          model: 'gpt-4o',
          content: `Here is the response with "thought": "test" and "call_tools": [] but incomplete JSON: {
            "thought": "test"
            // Missing closing brace
          `,
          usage: {
            promptTokens: 100,
            completionTokens: 50,
            totalTokens: 150
          },
          cost: 0.001,
          processingTime: 100,
          metadata: {},
          createdAt: new Date(),
          updatedAt: new Date()
        };

        const validResponse: LLMResponse = {
          id: 'response-2',
          requestId: 'step-0',
          provider: 'openai',
          model: 'gpt-4o',
          content: JSON.stringify({
            thought: 'Complete JSON',
            state_update: {
              new_facts: [],
              hypothesis_updates: [],
              new_hypotheses: []
            },
            final_response: 'All done'
          }),
          usage: {
            promptTokens: 100,
            completionTokens: 50,
            totalTokens: 150
          },
          cost: 0.001,
          processingTime: 100,
          metadata: {},
          createdAt: new Date(),
          updatedAt: new Date()
        };

        (mockLLMProvider.chat as jest.Mock)
          .mockResolvedValueOnce({
            type: ResponseType.SUCCESS,
            payload: incompleteJson,
            timestamp: new Date()
          })
          .mockResolvedValueOnce({
            type: ResponseType.SUCCESS,
            payload: validResponse,
            timestamp: new Date()
          });

        const result = await planningAgent.execute(
          'Why is login failing?',
          mockSession,
          undefined,
          mockContext
        );

        // Should retry because JSON patterns were detected
        expect(result.message).toBe('All done');
        expect(mockLLMProvider.chat).toHaveBeenCalledTimes(2);
      });

      it('should treat as final response when no JSON patterns detected (truly plain text)', async () => {
        // Plain text with no JSON patterns - should treat as final response
        const plainTextResponse: LLMResponse = {
          id: 'response-1',
          requestId: 'step-0',
          provider: 'openai',
          model: 'gpt-4o',
          content: `## Root Cause

Found a **Floating Promise** in the authentication flow.

## The Fix

Add \`await\` before the async call.`,
          usage: {
            promptTokens: 100,
            completionTokens: 50,
            totalTokens: 150
          },
          cost: 0.001,
          processingTime: 100,
          metadata: {},
          createdAt: new Date(),
          updatedAt: new Date()
        };

        (mockLLMProvider.chat as jest.Mock).mockResolvedValueOnce({
          type: ResponseType.SUCCESS,
          payload: plainTextResponse,
          timestamp: new Date()
        });

        const result = await planningAgent.execute(
          'Why is login failing?',
          mockSession,
          undefined,
          mockContext,
          undefined,
          mockLogger
        );

        // Should treat plain text as final response (no retry)
        expect(result.message).toContain('Root Cause');
        expect(result.message).toContain('Floating Promise');
        expect(mockLLMProvider.chat).toHaveBeenCalledTimes(1);
        expect(mockLogger.logStep).toHaveBeenCalled();
        expect(mockLogger.generateSummary).toHaveBeenCalled();
      });

      it('should handle JSON with final_response containing markdown code blocks and unescaped characters', () => {
        const agent = planningAgent as any;
        // Simulate the exact error case: JSON with unescaped backticks in string values
        // The backticks in the string values are NOT escaped, which breaks JSON parsing
        // We need to construct a string with actual unescaped backticks by using String.fromCharCode
        // or by building it character by character
        const backtick = String.fromCharCode(96); // `
        const jsonWithUnescapedBackticks = `{
  "thought": "Analysis of RuntimeAnalysisAgent.ts",
  "state_update": {
    "new_facts": ["Fact about ${backtick}currentSourceCode${backtick} variable"],
    "hypothesis_updates": [],
    "new_hypotheses": []
  },
  "final_response": "## Root Cause\\n\\nThe ${backtick}RuntimeAnalysisAgent${backtick}'s ${backtick}analyze${backtick} method. Here is code: ${backtick}${backtick}${backtick}typescript\\nif (fileChanged) {\\n  // code\\n}\\n${backtick}${backtick}${backtick}\\n\\nThis is the fix."
}`;
        
        // Wrap in markdown code fence (as LLM often does)
        const rawOutput = `\`\`\`json\n${jsonWithUnescapedBackticks}\n\`\`\``;
        
        const result = agent.extractJsonFromText(rawOutput);
        expect(result).not.toBeNull();
        expect(result).toBeTruthy();
        
        // Should be able to parse the JSON despite unescaped backticks
        // The repair function should escape them automatically
        const parsed = JSON.parse(result!);
        
        // Verify it's valid PlanningAgent JSON structure
        expect(parsed).toHaveProperty('thought');
        expect(parsed).toHaveProperty('state_update');
        expect(parsed).toHaveProperty('final_response');
        
        // Verify the content - backticks should be preserved (but escaped in the JSON)
        expect(parsed.thought).toContain('RuntimeAnalysisAgent');
        expect(parsed.state_update.new_facts[0]).toContain('currentSourceCode');
        expect(parsed.final_response).toContain('Root Cause');
        expect(parsed.final_response).toContain('RuntimeAnalysisAgent');
      });
    });
  });

  describe('ESM Import Resolution (Regression Tests)', () => {
    it('should instantiate PlanningAgent without import errors', () => {
      expect(() => {
        new PlanningAgent(mockToolRegistry, mockLLMProvider);
      }).not.toThrow();
    });

    it('should handle dynamic imports with .js extension correctly', async () => {
      const agent = new PlanningAgent(mockToolRegistry, mockLLMProvider);
      
      // Execute should not throw import errors
      mockLLMProvider.chat = jest.fn().mockResolvedValue({
        type: ResponseType.SUCCESS,
        payload: {
          id: 'test-response',
          content: JSON.stringify({
            thought: 'Test',
            state_update: {},
            final_response: 'Done'
          }),
          usage: { promptTokens: 100, completionTokens: 50, totalTokens: 150 },
          cost: 0.001,
          createdAt: new Date(),
          updatedAt: new Date()
        }
      });

      const mockSession: Session = {
        id: 'test-session',
        title: 'Test',
        status: 'active' as any,
        messageCount: 0,
        totalTokens: 0,
        totalCost: 0,
        lastMessageAt: new Date(),
        tags: [],
        metadata: { model: 'gpt-4o', projectId: 'test-project' },
        codeContextIds: [],
        previous_session_intent: 'pure_discussion' as any,
        pinnedFilePaths: [],
        createdAt: new Date(),
        updatedAt: new Date()
      };

      const mockContext: AgentContext = {
        initialEpicenter: '/test/src/auth.ts'
      };

      await expect(
        agent.execute('Test query', mockSession, undefined, mockContext)
      ).resolves.toBeDefined();
    });
  });

  describe('Empty Response Handling', () => {
    it('should return error message when LLM returns empty content', async () => {
      const mockSession: Session = {
        id: 'test-session',
        title: 'Test',
        status: 'active' as any,
        messageCount: 0,
        totalTokens: 0,
        totalCost: 0,
        lastMessageAt: new Date(),
        tags: [],
        metadata: { model: 'gpt-4o' },
        codeContextIds: [],
        previous_session_intent: 'pure_discussion' as any,
        pinnedFilePaths: [],
        createdAt: new Date(),
        updatedAt: new Date()
      };

      const mockContext: AgentContext = {
        initialEpicenter: '/test/src/auth.ts'
      };

      // Mock LLM to return empty content
      (mockLLMProvider.chat as jest.Mock) = jest.fn().mockResolvedValue({
        type: ResponseType.SUCCESS,
        payload: {
          id: 'response-id',
          requestId: 'request-id',
          provider: 'openai',
          model: 'gpt-4o',
          content: '', // Empty content
          usage: { promptTokens: 1, completionTokens: 0, totalTokens: 1 },
          cost: 0,
          processingTime: 0,
          metadata: {},
          createdAt: new Date(),
          updatedAt: new Date()
        } as LLMResponse
      });

      const agent = new PlanningAgent(mockToolRegistry, mockLLMProvider, mockWebviewProvider);
      const result = await agent.execute('Test query', mockSession, undefined, mockContext);

      // Verify error message is returned
      expect(result.message).toContain('failed');
      expect(result.message).toContain('empty response');
      expect(result.metadata?.stepsTaken).toBe(0);
    });

    it('should return error message when LLM returns whitespace-only content', async () => {
      const mockSession: Session = {
        id: 'test-session',
        title: 'Test',
        status: 'active' as any,
        messageCount: 0,
        totalTokens: 0,
        totalCost: 0,
        lastMessageAt: new Date(),
        tags: [],
        metadata: { model: 'gpt-4o' },
        codeContextIds: [],
        previous_session_intent: 'pure_discussion' as any,
        pinnedFilePaths: [],
        createdAt: new Date(),
        updatedAt: new Date()
      };

      const mockContext: AgentContext = {
        initialEpicenter: '/test/src/auth.ts'
      };

      // Mock LLM to return whitespace-only content
      (mockLLMProvider.chat as jest.Mock) = jest.fn().mockResolvedValue({
        type: ResponseType.SUCCESS,
        payload: {
          id: 'response-id',
          requestId: 'request-id',
          provider: 'openai',
          model: 'gpt-4o',
          content: '   \n\t  ', // Whitespace only
          usage: { promptTokens: 1, completionTokens: 0, totalTokens: 1 },
          cost: 0,
          processingTime: 0,
          metadata: {},
          createdAt: new Date(),
          updatedAt: new Date()
        } as LLMResponse
      });

      const agent = new PlanningAgent(mockToolRegistry, mockLLMProvider, mockWebviewProvider);
      const result = await agent.execute('Test query', mockSession, undefined, mockContext);

      // Verify error message is returned (whitespace should be treated as empty)
      expect(result.message).toContain('failed');
      expect(result.message).toContain('empty response');
    });
  });
});
