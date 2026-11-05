/**
 * Tests for RuntimeAnalysisAgent
 */

import { RuntimeAnalysisAgent } from '../RuntimeAnalysisAgent';
import { ToolRegistry } from '../../tools/ToolRegistry';
import { LLMProviderService } from '../../llm/llmProviderService';
import { StreamReporter } from '../../utils/StreamReporter';
import { DebugSessionLogger } from '../../utils/DebugSessionLogger';
import { LLMResponse } from '../../../common/models/llm-models';
import { ResponseType } from '../../../common/models/response-models';
import { z } from 'zod';

// Mock dependencies
jest.mock('../../tools/debugging/promptLoader', () => ({
  loadDebuggingPrompt: jest.fn((fileName: string) => {
    if (fileName === 'runtime_analysis.md') {
      return `You are a QA Engineer specializing in backend Node.js/TypeScript code testing.`;
    }
    throw new Error(`Prompt file not found: ${fileName}`);
  })
}));

jest.mock('../../utils/DebugSessionLogger', () => ({
  DebugSessionLogger: jest.fn()
}));

describe('RuntimeAnalysisAgent', () => {
  let agent: RuntimeAnalysisAgent;
  let mockToolRegistry: jest.Mocked<ToolRegistry>;
  let mockLLMProvider: jest.Mocked<LLMProviderService>;
  let mockReporter: jest.Mocked<StreamReporter>;
  let mockLogger: jest.Mocked<DebugSessionLogger>;
  const workspaceRoot = '/test/workspace';

  beforeEach(() => {
    jest.clearAllMocks();

    // Setup logger mock
    mockLogger = {
      logRuntimeStep: jest.fn(),
      logParseFailure: jest.fn(),
      generateSummary: jest.fn()
    } as any;

    // Setup tool registry mock with proper Zod schemas
    mockToolRegistry = {
      getRuntimeTools: jest.fn(() => [
        {
          name: 'static-analysis',
          description: 'Analyzes code structure',
          inputSchema: z.object({
            filePath: z.string(),
            mode: z.string()
          })
        },
        {
          name: 'sandbox-fs',
          description: 'File system operations',
          inputSchema: z.object({
            path: z.string(),
            content: z.string()
          })
        },
        {
          name: 'node-process',
          description: 'Runs Node.js processes',
          inputSchema: z.object({
            script: z.string()
          })
        },
        {
          name: 'runtime-inspector',
          description: 'Inspects runtime values',
          inputSchema: z.object({
            port: z.number(),
            expression: z.string()
          })
        }
      ]),
      getTool: jest.fn((name: string) => {
        if (name === 'static-analysis') {
          return {
            execute: jest.fn().mockResolvedValue({
              success: true,
              evidence: [{
                text: 'const test = 42;'
              }]
            })
          };
        }
        return null;
      })
    } as any;

    mockLLMProvider = {
      chat: jest.fn()
    } as any;

    mockReporter = {
      report: jest.fn(),
      sendLogUpdate: jest.fn()
    } as any;

    agent = new RuntimeAnalysisAgent(
      mockToolRegistry,
      mockLLMProvider,
      workspaceRoot
    );

    agent.setReporter(mockReporter);
    agent.setLogger(mockLogger);
  });

  describe('analyze', () => {
    const targetFile = 'src/test.ts';
    const targetLine = 42;
    const expression = 'testVar';

    it('should report initial phase when analysis starts', async () => {
      const mockLLMResponse: LLMResponse = {
        id: 'response-1',
        requestId: 'runtime-analysis-step-0',
        provider: 'openai',
        model: 'gpt-4o',
        content: JSON.stringify({
          thought: 'I will analyze the code.',
          final_result: {
            value: 42,
            type: 'number',
            logs: [],
            rootCauseFound: false
          }
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

      await agent.analyze(targetFile, targetLine, expression);

      // Verify initial phase was reported
      expect(mockReporter.report).toHaveBeenCalledWith(
        'phase',
        `Starting runtime analysis of "${expression}" at ${targetFile}:${targetLine}`
      );
    });

    it('should report thought from LLM response', async () => {
      const thought = 'I need to read the source code first.';
      const mockLLMResponse: LLMResponse = {
        id: 'response-1',
        requestId: 'runtime-analysis-step-0',
        provider: 'openai',
        model: 'gpt-4o',
        content: JSON.stringify({
          thought: thought,
          final_result: {
            value: 42,
            type: 'number',
            logs: [],
            rootCauseFound: false
          }
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

      await agent.analyze(targetFile, targetLine, expression);

      // Verify thought was reported
      expect(mockReporter.report).toHaveBeenCalledWith('thought', thought);
    });

    it('should report tool calls before execution', async () => {
      const mockLLMResponse1: LLMResponse = {
        id: 'response-1',
        requestId: 'runtime-analysis-step-0',
        provider: 'openai',
        model: 'gpt-4o',
        content: JSON.stringify({
          thought: 'I will use static-analysis to read the file.',
          call_tools: [
            {
              name: 'static-analysis',
              arguments: {
                filePath: targetFile,
                mode: 'source'
              }
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

      const mockLLMResponse2: LLMResponse = {
        id: 'response-2',
        requestId: 'runtime-analysis-step-1',
        provider: 'openai',
        model: 'gpt-4o',
        content: JSON.stringify({
          thought: 'Now I have the code.',
          final_result: {
            value: 42,
            type: 'number',
            logs: [],
            rootCauseFound: false
          }
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

      // Mock ToolExecutionService
      const mockToolExecutor = {
        executeToolCalls: jest.fn().mockResolvedValue([
          {
            tool_call_id: 'call-1',
            role: 'tool',
            name: 'static-analysis',
            content: JSON.stringify([{ file: targetFile, text: 'const test = 42;' }]),
            rawResult: {
              success: true,
              evidence: [{ file: targetFile, text: 'const test = 42;' }]
            }
          }
        ])
      };

      // Replace the toolExecutor with our mock
      (agent as any).toolExecutor = mockToolExecutor;

      await agent.analyze(targetFile, targetLine, expression);

      // Verify tool call was reported
      expect(mockReporter.report).toHaveBeenCalledWith(
        'tool',
        `Running static-analysis (${targetFile})...`
      );
    });

    it('should reject node-process breakpoints that use line numbers', async () => {
      const mockLLMResponse: LLMResponse = {
        id: 'response-line-breakpoints',
        requestId: 'runtime-analysis-step-0',
        provider: 'openai',
        model: 'gpt-4o',
        content: JSON.stringify({
          thought: 'Attempting to set a breakpoint',
          call_tools: [
            {
              name: 'node-process',
              arguments: {
                action: 'debug',
                path: 'sandbox/repro.ts',
                breakpoints: [
                  {
                    file: '/test/file.ts',
                    line: 42
                  }
                ],
                watch_variables: ['result']
              }
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

      (mockLLMProvider.chat as jest.Mock).mockResolvedValue({
        type: ResponseType.SUCCESS,
        payload: mockLLMResponse,
        timestamp: new Date()
      });

      await expect(
        agent.analyze(targetFile, targetLine, expression)
      ).rejects.toThrow(
        'node-process breakpoints must use content snippets (code snippets), not line numbers'
      );
    });

    it('should pass reporter and logger into executeToolCalls', async () => {
      const responseWithTool: LLMResponse = {
        id: 'response-1',
        requestId: 'runtime-analysis-step-0',
        provider: 'openai',
        model: 'gpt-4o',
        content: JSON.stringify({
          call_tools: [
            {
              name: 'node-process',
              arguments: {
                action: 'spawn',
                scriptPath: 'script.ts'
              }
            }
          ]
        }),
        usage: {
          promptTokens: 10,
          completionTokens: 5,
          totalTokens: 15
        },
        cost: 0,
        processingTime: 10,
        metadata: {},
        createdAt: new Date(),
        updatedAt: new Date()
      };

      const responseFinal: LLMResponse = {
        id: 'response-2',
        requestId: 'runtime-analysis-step-1',
        provider: 'openai',
        model: 'gpt-4o',
        content: JSON.stringify({
          final_result: {
            value: 1,
            type: 'number',
            logs: [],
            rootCauseFound: false
          }
        }),
        usage: {
          promptTokens: 10,
          completionTokens: 5,
          totalTokens: 15
        },
        cost: 0,
        processingTime: 10,
        metadata: {},
        createdAt: new Date(),
        updatedAt: new Date()
      };

      (mockLLMProvider.chat as jest.Mock)
        .mockResolvedValueOnce({
          type: ResponseType.SUCCESS,
          payload: responseWithTool,
          timestamp: new Date()
        })
        .mockResolvedValueOnce({
          type: ResponseType.SUCCESS,
          payload: responseFinal,
          timestamp: new Date()
        });

      const mockToolExecutor = {
        executeToolCalls: jest.fn().mockResolvedValue([
          {
            tool_call_id: 'call-1',
            role: 'tool',
            name: 'node-process',
            content: JSON.stringify([{ text: 'log' }]),
            rawResult: { success: true }
          }
        ])
      };
      (agent as any).toolExecutor = mockToolExecutor;

      await agent.analyze(targetFile, targetLine, expression);

      expect(mockToolExecutor.executeToolCalls).toHaveBeenCalledWith(
        expect.any(Array),
        mockReporter,
        mockLogger
      );
    });

    it('should not re-emit buffered tool logs to reporter after completion', async () => {
      const responseWithTool: LLMResponse = {
        id: 'response-1',
        requestId: 'runtime-analysis-step-0',
        provider: 'openai',
        model: 'gpt-4o',
        content: JSON.stringify({
          call_tools: [
            {
              name: 'node-process',
              arguments: {
                action: 'spawn',
                scriptPath: 'script.ts'
              }
            }
          ]
        }),
        usage: {
          promptTokens: 10,
          completionTokens: 5,
          totalTokens: 15
        },
        cost: 0,
        processingTime: 10,
        metadata: {},
        createdAt: new Date(),
        updatedAt: new Date()
      };

      const responseFinal: LLMResponse = {
        id: 'response-2',
        requestId: 'runtime-analysis-step-1',
        provider: 'openai',
        model: 'gpt-4o',
        content: JSON.stringify({
          final_result: {
            value: 1,
            type: 'number',
            logs: ['Starting...', 'More logs'],
            rootCauseFound: false
          }
        }),
        usage: {
          promptTokens: 10,
          completionTokens: 5,
          totalTokens: 15
        },
        cost: 0,
        processingTime: 10,
        metadata: {},
        createdAt: new Date(),
        updatedAt: new Date()
      };

      (mockLLMProvider.chat as jest.Mock)
        .mockResolvedValueOnce({
          type: ResponseType.SUCCESS,
          payload: responseWithTool,
          timestamp: new Date()
        })
        .mockResolvedValueOnce({
          type: ResponseType.SUCCESS,
          payload: responseFinal,
          timestamp: new Date()
        });

      const mockToolExecutor = {
        executeToolCalls: jest.fn().mockResolvedValue([
          {
            tool_call_id: 'call-1',
            role: 'tool',
            name: 'node-process',
            content: JSON.stringify([{ text: 'Buffered logs' }]),
            rawResult: { success: true }
          }
        ])
      };
      (agent as any).toolExecutor = mockToolExecutor;

      await agent.analyze(targetFile, targetLine, expression);

      expect(mockReporter.sendLogUpdate).not.toHaveBeenCalled();
    });

    it('should report final result when value is captured', async () => {
      const capturedValue = 42;
      const capturedType = 'number';
      const mockLLMResponse: LLMResponse = {
        id: 'response-1',
        requestId: 'runtime-analysis-step-0',
        provider: 'openai',
        model: 'gpt-4o',
        content: JSON.stringify({
          thought: 'I captured the value.',
          final_result: {
            value: capturedValue,
            type: capturedType,
            logs: ['Log message'],
            rootCauseFound: false
          }
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

      await agent.analyze(targetFile, targetLine, expression);

      // Verify final result was reported
      expect(mockReporter.report).toHaveBeenCalledWith(
        'phase',
        expect.stringContaining('Captured runtime value:')
      );
      expect(mockReporter.report).toHaveBeenCalledWith(
        'phase',
        expect.stringContaining(`(type: ${capturedType})`)
      );
    });

    it('should report hypothesis refinement', async () => {
      const newHypothesis = 'The issue might be in a different file.';
      const mockLLMResponse1: LLMResponse = {
        id: 'response-1',
        requestId: 'runtime-analysis-step-0',
        provider: 'openai',
        model: 'gpt-4o',
        content: JSON.stringify({
          thought: 'I need to refine my approach.',
          insights: ['First insight'],
          next_hypothesis: newHypothesis
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

      const mockLLMResponse2: LLMResponse = {
        id: 'response-2',
        requestId: 'runtime-analysis-step-1',
        provider: 'openai',
        model: 'gpt-4o',
        content: JSON.stringify({
          thought: 'Now I have the refined approach.',
          final_result: {
            value: 42,
            type: 'number',
            logs: [],
            rootCauseFound: false
          }
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

      await agent.analyze(targetFile, targetLine, expression);

      // Verify hypothesis refinement was reported
      expect(mockReporter.report).toHaveBeenCalledWith(
        'phase',
        `Refining hypothesis: ${newHypothesis}`
      );
    });

    it('should report error when LLM call fails', async () => {
      (mockLLMProvider.chat as jest.Mock).mockResolvedValue({
        type: ResponseType.ERROR,
        error: 'LLM service unavailable',
        timestamp: new Date()
      });

      await expect(agent.analyze(targetFile, targetLine, expression)).rejects.toThrow(
        'LLM call failed: LLM service unavailable'
      );

      // Verify error was reported
      expect(mockReporter.report).toHaveBeenCalledWith(
        'phase',
        'LLM call failed: LLM service unavailable'
      );
    });

    it('should report error when parsed error field exists', async () => {
      const errorMessage = 'Failed to reproduce the code path.';
      const mockLLMResponse: LLMResponse = {
        id: 'response-1',
        requestId: 'runtime-analysis-step-0',
        provider: 'openai',
        model: 'gpt-4o',
        content: JSON.stringify({
          thought: 'I encountered an error.',
          error: errorMessage
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

      await expect(agent.analyze(targetFile, targetLine, expression)).rejects.toThrow(
        `Runtime analysis failed: ${errorMessage}`
      );

      // Verify error was reported
      expect(mockReporter.report).toHaveBeenCalledWith(
        'phase',
        `Runtime analysis error: ${errorMessage}`
      );
    });

    it('should report JSON parse error and retry', async () => {
      const invalidJsonResponse: LLMResponse = {
        id: 'response-1',
        requestId: 'runtime-analysis-step-0',
        provider: 'openai',
        model: 'gpt-4o',
        content: 'This is not valid JSON {',
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

      const validJsonResponse: LLMResponse = {
        id: 'response-2',
        requestId: 'runtime-analysis-step-1',
        provider: 'openai',
        model: 'gpt-4o',
        content: JSON.stringify({
          thought: 'Retrying with valid JSON.',
          final_result: {
            value: 42,
            type: 'number',
            logs: [],
            rootCauseFound: false
          }
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

      (mockLLMProvider.chat as jest.Mock)
        .mockResolvedValueOnce({
          type: ResponseType.SUCCESS,
          payload: invalidJsonResponse,
          timestamp: new Date()
        })
        .mockResolvedValueOnce({
          type: ResponseType.SUCCESS,
          payload: validJsonResponse,
          timestamp: new Date()
        });

      await agent.analyze(targetFile, targetLine, expression);

      // Verify parse error was reported
      expect(mockReporter.report).toHaveBeenCalledWith(
        'phase',
        'JSON parse error, retrying...'
      );

      // Verify raw output was logged for debugging
      expect(mockLogger.logParseFailure).toHaveBeenCalledWith(
        'RuntimeAnalysisAgent.analyze',
        expect.any(Error),
        invalidJsonResponse.content
      );
    });

    it('should handle LLM response with plain text instead of JSON (tool results format)', async () => {
      // This simulates the exact error case: LLM returns plain text/markdown instead of JSON
      const plainTextResponse: LLMResponse = {
        id: 'response-1',
        requestId: 'runtime-analysis-step-0',
        provider: 'openai',
        model: 'gpt-4o',
        content: `Tool Results:

### sandbox-fs

Wrote 399 bytes to tsconfig.json.`,
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

      const validJsonResponse: LLMResponse = {
        id: 'response-2',
        requestId: 'runtime-analysis-step-1',
        provider: 'openai',
        model: 'gpt-4o',
        content: JSON.stringify({
          thought: 'I understand now. I must return JSON only. Retrying with valid JSON.',
          final_result: {
            value: 42,
            type: 'number',
            logs: [],
            rootCauseFound: false
          }
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

      (mockLLMProvider.chat as jest.Mock)
        .mockResolvedValueOnce({
          type: ResponseType.SUCCESS,
          payload: plainTextResponse,
          timestamp: new Date()
        })
        .mockResolvedValueOnce({
          type: ResponseType.SUCCESS,
          payload: validJsonResponse,
          timestamp: new Date()
        });

      await agent.analyze(targetFile, targetLine, expression);

      // Verify parse error was reported
      expect(mockReporter.report).toHaveBeenCalledWith(
        'phase',
        'JSON parse error, retrying...'
      );

      // Verify raw output was logged for debugging
      expect(mockLogger.logParseFailure).toHaveBeenCalledWith(
        'RuntimeAnalysisAgent.analyze',
        expect.any(Error),
        plainTextResponse.content
      );

      // Verify that the retry message specifically mentions no JSON was found
      const chatCalls = (mockLLMProvider.chat as jest.Mock).mock.calls;
      expect(chatCalls.length).toBeGreaterThan(1);
      
      // Check that the retry message contains the specific error about no JSON
      const retryMessage = chatCalls[1][0].messages[chatCalls[1][0].messages.length - 1].content;
      expect(retryMessage).toContain('No JSON object found');
      expect(retryMessage).toContain('raw text/markdown');
    });

    it('should parse JSON wrapped in markdown fences without retrying', async () => {
      const missingFileError =
        'Could not find the target file `tokenizer.test.ts` in the workspace. It only appears in the sandbox, which suggests it was not an original user file or the path provided was incorrect. Cannot perform runtime analysis without the target source file.';

      const fencedJsonObject = {
        thought:
          "It's consistently finding `tokenizer.test.ts` only within the `.samurai/sandbox/` directory. This means the file either doesn't exist in the workspace, is named differently, or was excluded by search.",
        error: missingFileError
      };

      const fencedJson = ['```json', JSON.stringify(fencedJsonObject, null, 2), '```'].join('\n');

      const mockLLMResponse: LLMResponse = {
        id: 'response-1',
        requestId: 'runtime-analysis-step-0',
        provider: 'openai',
        model: 'gpt-4o',
        content: fencedJson,
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

      await expect(
        agent.analyze(targetFile, targetLine, expression)
      ).rejects.toThrow(`Runtime analysis failed: ${missingFileError}`);

      expect(mockReporter.report).toHaveBeenCalledWith(
        'phase',
        `Runtime analysis error: ${missingFileError}`
      );
      expect(mockReporter.report).not.toHaveBeenCalledWith(
        'phase',
        'JSON parse error, retrying...'
      );
      expect(mockLogger.logParseFailure).not.toHaveBeenCalled();
    });

    it('should parse large JSON response wrapped in markdown code blocks (error log scenario)', async () => {
      // This test case matches the exact error scenario from the logs:
      // Large JSON response (3184 chars) wrapped in ```json ... ``` that should be parsed correctly
      const largeJsonObject = {
        thought: "The `node-process` execution was successful. I have captured the runtime values of `cleanedSegments` at line 105 (resolved to line 114 in the debug report due to source mapping or code transformation) for two different rows in the sample data. The `cleanTranscript` function correctly processed the input text, removing timestamps and returning an array containing the cleaned text segment.",
        insights: [
          "The `cleanTranscript` function correctly identified and removed timestamps `(HH:MM:SS)` from the input transcript text.",
          "For each input `text` from `row[textColumn]`, `cleanTranscript` returns an array containing a single string element, which is the cleaned transcript.",
          "The breakpoint was successfully hit twice, corresponding to the two rows in the `sampleData` provided to `getFrequency`."
        ],
        final_result: {
          value: [
            "営業担当 こんにちは。今日は商品についてご説明します。 お客様 ありがとうございます。新機能に興味があります。",
            "営業担当 新機能は非常に便利です。 お客様 そうですか。デモを見せていただけますか。"
          ],
          type: "Array<string>",
          logs: [
            "[STDERR] Debugger listening on ws://127.0.0.1:9229/1ed06555-b2c4-48b2-a90f-c09eb2b46f5a",
            "For help, see: https://nodejs.org/en/docs/inspector",
            "[STDERR] Debugger attached.",
            "[STDERR] Missing baseUrl in compilerOptions. tsconfig-paths will be skipped",
            "[STDOUT] tokens [\n  '営業', '担当',     'こんにちは',\n  '。',   '今日',     'は',\n  '商品', 'について', 'ご',\n  '説明', 'し',       'ます',\n  '。',   'お客様',   'ありがとう',\n  'ご',   'ざ',       'い',\n  'ます', '。',       '新',\n  '機能', 'に',       '興味',\n  'が',   'あり',     'ます',\n  '。'\n]",
            "[STDOUT] tokens [\n  '営業', '担当',   '新',\n  '機能', 'は',     '非常',\n  'に',   '便利',   'です',\n  '。',   'お客様', 'そう',\n  'です', 'か',     '。',\n  'デモ', 'を',     '見',\n  'せ',   'てい',   'た',\n  'だけ', 'ます',   'か',\n  '。'\n]",
            "[STDOUT] Result: [\n  {\n    \"group\": \"Meeting A\",\n    \"words\": [\n      {\n        \"word\": \"営業\",\n        \"count\": 2\n      },\n      {\n        \"word\": \"担当\",\n        \"count\": 2\n      },\n      {\n        \"word\": \"お客様\",\n        \"count\": 2\n      },\n      {\n        \"word\": \"機能\",\n        \"count\": 2\n      },\n      {\n        \"word\": \"こんにちは\",\n        \"count\": 1\n      },\n      {\n        \"word\": \"今日\",\n        \"count\": 1\n      },\n      {\n        \"word\": \"商品\",\n        \"count\": 1\n      },\n      {\n        \"word\": \"について\",\n        \"count\": 1\n      },\n      {\n        \"word\": \"説明\",\n        \"count\": 1\n      },\n      {\n        \"word\": \"ありがとう\",\n        \"count\": 1\n      }\n    ]\n  },\n  {\n    \"group\": \"Meeting B\",\n    \"words\": [\n      {\n        \"word\": \"担当\",\n        \"count\": 1\n      },\n      {\n        \"word\": \"意見\",\n        \"count\": 1\n      },\n      {\n        \"word\": \"ありがとう\",\n        \"count\": 1\n      },\n      {\n        \"word\": \"次回\",\n        \"count\": 1\n      },\n      {\n        \"word\": \"会議\",\n        \"count\": 1\n      },\n      {\n        \"word\": \"検討\",\n        \"count\": 1\n      }\n    ]\n  }\n]",
            "[STDERR] Waiting for the debugger to disconnect..."
          ],
          rootCauseFound: true
        }
      };

      // Format exactly as the error log shows: wrapped in ```json ... ```
      const fencedJson = `\`\`\`json\n${JSON.stringify(largeJsonObject, null, 2)}\n\`\`\``;

      const mockLLMResponse: LLMResponse = {
        id: 'response-1',
        requestId: 'runtime-analysis-step-0',
        provider: 'openai',
        model: 'gpt-4o',
        content: fencedJson,
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

      const result = await agent.analyze(targetFile, targetLine, expression);

      // Verify that the JSON was parsed correctly without retrying
      expect(result.value).toEqual(largeJsonObject.final_result.value);
      expect(result.type).toBe(largeJsonObject.final_result.type);
      expect(result.logs).toEqual(largeJsonObject.final_result.logs);
      expect(result.rootCauseFound).toBe(true);
      expect(result.insights).toEqual(largeJsonObject.insights);

      // Verify no parse error was reported
      expect(mockReporter.report).not.toHaveBeenCalledWith(
        'phase',
        'JSON parse error, retrying...'
      );
      expect(mockLogger.logParseFailure).not.toHaveBeenCalled();
    });

    it('should report timeout when max steps reached', async () => {
      // Create responses that never return final_result
      const mockLLMResponse: LLMResponse = {
        id: 'response-1',
        requestId: 'runtime-analysis-step-0',
        provider: 'openai',
        model: 'gpt-4o',
        content: JSON.stringify({
          thought: 'I will continue analyzing.',
          call_tools: [
            {
              name: 'static-analysis',
              arguments: {
                filePath: targetFile,
                mode: 'source'
              }
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

      (mockLLMProvider.chat as jest.Mock).mockResolvedValue({
        type: ResponseType.SUCCESS,
        payload: mockLLMResponse,
        timestamp: new Date()
      });

      // Mock ToolExecutionService to return results
      const mockToolExecutor = {
        executeToolCalls: jest.fn().mockResolvedValue([
          {
            tool_call_id: 'call-1',
            role: 'tool',
            name: 'static-analysis',
            content: JSON.stringify([{ file: targetFile, text: 'const test = 42;' }]),
            rawResult: {
              success: true,
              evidence: [{ file: targetFile, text: 'const test = 42;' }]
            }
          }
        ])
      };

      (agent as any).toolExecutor = mockToolExecutor;

      await expect(agent.analyze(targetFile, targetLine, expression)).rejects.toThrow(
        'Failed to capture runtime value after'
      );

      // Verify timeout was reported
      expect(mockReporter.report).toHaveBeenCalledWith(
        'phase',
        expect.stringContaining('Failed to capture runtime value after')
      );
    });

    it('should report unexpected end when no tool calls and no final result', async () => {
      const mockLLMResponse: LLMResponse = {
        id: 'response-1',
        requestId: 'runtime-analysis-step-0',
        provider: 'openai',
        model: 'gpt-4o',
        content: JSON.stringify({
          thought: 'I am stuck.'
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

      await expect(agent.analyze(targetFile, targetLine, expression)).rejects.toThrow();

      // Verify unexpected end was reported
      expect(mockReporter.report).toHaveBeenCalledWith(
        'phase',
        'Analysis ended unexpectedly - no tool calls and no final result'
      );
    });

    it('should handle missing reporter gracefully', async () => {
      agent.setReporter(undefined);

      const mockLLMResponse: LLMResponse = {
        id: 'response-1',
        requestId: 'runtime-analysis-step-0',
        provider: 'openai',
        model: 'gpt-4o',
        content: JSON.stringify({
          thought: 'I will analyze the code.',
          final_result: {
            value: 42,
            type: 'number',
            logs: [],
            rootCauseFound: false
          }
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

      // Should not throw when reporter is undefined
      await expect(agent.analyze(targetFile, targetLine, expression)).resolves.toBeDefined();
    });

    it('should return correct result structure', async () => {
      const capturedValue = { result: 42 };
      const capturedType = 'object';
      const capturedLogs = ['Log 1', 'Log 2'];
      const insights = ['Insight 1', 'Insight 2'];
      const hypothesis = 'The variable is correctly set.';
      const rootCauseFound = true;

      const mockLLMResponse: LLMResponse = {
        id: 'response-1',
        requestId: 'runtime-analysis-step-0',
        provider: 'openai',
        model: 'gpt-4o',
        content: JSON.stringify({
          thought: hypothesis,
          insights: insights,
          final_result: {
            value: capturedValue,
            type: capturedType,
            logs: capturedLogs,
            rootCauseFound: rootCauseFound
          }
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

      const result = await agent.analyze(targetFile, targetLine, expression);

      expect(result).toEqual({
        value: capturedValue,
        type: capturedType,
        logs: capturedLogs,
        insights: insights,
        hypothesis: hypothesis,
        rootCauseFound: rootCauseFound,
        totalCost: 0
      });
    });

    it('should detect and enhance crashed node-process results', async () => {
      const mockLLMResponse1: LLMResponse = {
        id: 'response-1',
        requestId: 'runtime-analysis-step-0',
        provider: 'openai',
        model: 'gpt-4o',
        content: JSON.stringify({
          thought: 'I will spawn a process to test.',
          call_tools: [
            {
              name: 'node-process',
              arguments: {
                action: 'spawn',
                scriptPath: 'test.ts'
              }
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

      const mockLLMResponse2: LLMResponse = {
        id: 'response-2',
        requestId: 'runtime-analysis-step-1',
        provider: 'openai',
        model: 'gpt-4o',
        content: JSON.stringify({
          thought: 'The process crashed, but I have the logs.',
          final_result: {
            value: null,
            type: 'null',
            logs: [],
            rootCauseFound: false
          }
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

      // Mock ToolExecutionService to return a crashed node-process result
      const crashedProcessResult = {
        tool_call_id: 'call-1',
        role: 'tool',
        name: 'node-process',
        content: JSON.stringify([{
          file: 'crash-report.txt',
          line: 0,
          text: 'COMMAND: npx ts-node...\n\nEXIT CODE: 1\n\nLOGS:\nError: Cannot find module "ts-node"',
          description: 'Crash Output (Stderr/Stdout)'
        }]),
        rawResult: {
          success: false,
          summary: 'Process crashed immediately (Exit Code: 1).',
          evidence: [{
            file: 'crash-report.txt',
            line: 0,
            text: 'COMMAND: npx ts-node...\n\nEXIT CODE: 1\n\nLOGS:\nError: Cannot find module "ts-node"',
            description: 'Crash Output (Stderr/Stdout)'
          }],
          structuredData: {
            pid: 12345,
            exitCode: 1,
            error: 'Error: Cannot find module "ts-node"\ncommand not found: ts-node',
            command: 'npx ts-node -r tsconfig-paths/register --inspect-brk=9229 /test/workspace/.samurai/sandbox/test.ts'
          }
        }
      };

      const mockToolExecutor = {
        executeToolCalls: jest.fn().mockResolvedValue([crashedProcessResult])
      };

      (agent as any).toolExecutor = mockToolExecutor;

      await agent.analyze(targetFile, targetLine, expression);

      // Verify crash was detected and reported
      expect(mockReporter.report).toHaveBeenCalledWith(
        'phase',
        expect.stringContaining('MISSING_DEPENDENCY')
      );

      // Verify executeToolCalls was called
      expect(mockToolExecutor.executeToolCalls).toHaveBeenCalled();
      
      // Verify the tool result was enhanced (check the result that was returned)
      const toolCallsResult = await mockToolExecutor.executeToolCalls.mock.results[0].value;
      expect(toolCallsResult).toBeDefined();
      expect(toolCallsResult.length).toBe(1);
      // The content should be enhanced with diagnostic information
      const resultContent = toolCallsResult[0].content;
      // Check that it contains diagnostic info (either in JSON format or as enhanced text)
      const contentStr = typeof resultContent === 'string' ? resultContent : JSON.stringify(resultContent);
      expect(contentStr).toContain('DIAGNOSTIC');
      expect(contentStr).toContain('MISSING_DEPENDENCY');
    });

    it('should detect different types of process crashes', async () => {
      const mockLLMResponse1: LLMResponse = {
        id: 'response-1',
        requestId: 'runtime-analysis-step-0',
        provider: 'openai',
        model: 'gpt-4o',
        content: JSON.stringify({
          thought: 'I will spawn a process.',
          call_tools: [
            {
              name: 'node-process',
              arguments: {
                action: 'spawn',
                scriptPath: 'test.ts'
              }
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

      const mockLLMResponse2: LLMResponse = {
        id: 'response-2',
        requestId: 'runtime-analysis-step-1',
        provider: 'openai',
        model: 'gpt-4o',
        content: JSON.stringify({
          thought: 'Process crashed with syntax error.',
          final_result: {
            value: null,
            type: 'null',
            logs: [],
            rootCauseFound: false
          }
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

      // Test SYNTAX_ERROR detection
      const syntaxErrorResult = {
        tool_call_id: 'call-1',
        role: 'tool',
        name: 'node-process',
        content: JSON.stringify([{
          file: 'crash-report.txt',
          text: 'COMMAND: npx...\n\nEXIT CODE: 1\n\nLOGS:\nSyntaxError: Unexpected token'
        }]),
        rawResult: {
          success: false,
          summary: 'Process crashed immediately (Exit Code: 1).',
          evidence: [{
            file: 'crash-report.txt',
            text: 'COMMAND: npx...\n\nEXIT CODE: 1\n\nLOGS:\nSyntaxError: Unexpected token'
          }],
          structuredData: {
            pid: 12345,
            exitCode: 1,
            error: 'SyntaxError: Unexpected token at line 5',
            command: 'npx ts-node...'
          }
        }
      };

      const mockToolExecutor = {
        executeToolCalls: jest.fn().mockResolvedValue([syntaxErrorResult])
      };

      (agent as any).toolExecutor = mockToolExecutor;

      await agent.analyze(targetFile, targetLine, expression);

      // Verify syntax error was detected
      expect(mockReporter.report).toHaveBeenCalledWith(
        'phase',
        expect.stringContaining('SYNTAX_ERROR')
      );
    });

  });
});

