/**
 * Tests for ToolExecutionService
 */

import { ToolExecutionService } from '../ToolExecutionService';
import { ToolRegistry } from '../../tools/ToolRegistry';
import { ITool, ToolResult } from '../../tools/definitions/ITool';

describe('ToolExecutionService', () => {
  let toolExecutionService: ToolExecutionService;
  let mockToolRegistry: jest.Mocked<ToolRegistry>;
  let mockTool1: jest.Mocked<ITool>;
  let mockTool2: jest.Mocked<ITool>;

  beforeEach(() => {
    jest.clearAllMocks();

    // Create mock tools
    mockTool1 = {
      name: 'test-tool-1',
      description: 'Test tool 1',
      inputSchema: {} as any,
      execute: jest.fn()
    } as any;

    mockTool2 = {
      name: 'test-tool-2',
      description: 'Test tool 2',
      inputSchema: {} as any,
      execute: jest.fn()
    } as any;

    mockToolRegistry = {
      getTool: jest.fn()
    } as any;

    toolExecutionService = new ToolExecutionService(mockToolRegistry);
  });

  describe('executeToolCalls', () => {
    it('should return empty array when no tool calls provided', async () => {
      const result = await toolExecutionService.executeToolCalls([]);
      expect(result).toEqual([]);
      expect(mockToolRegistry.getTool).not.toHaveBeenCalled();
    });

    it('should return empty array when toolCalls is null', async () => {
      const result = await toolExecutionService.executeToolCalls(null as any);
      expect(result).toEqual([]);
    });

    it('should execute single tool call successfully', async () => {
      const toolCall = {
        id: 'call-1',
        function: {
          name: 'test-tool-1',
          arguments: JSON.stringify({ param: 'value' })
        }
      };

      const toolResult: ToolResult = {
        success: true,
        summary: 'Tool executed successfully',
        evidence: [
          {
            file: 'test.ts',
            line: 10,
            text: 'const x = 1;',
            description: 'Found issue'
          }
        ]
      };

      (mockToolRegistry.getTool as jest.Mock).mockReturnValue(mockTool1);
      (mockTool1.execute as jest.Mock).mockResolvedValue(toolResult);

      const results = await toolExecutionService.executeToolCalls([toolCall]);

      expect(results).toHaveLength(1);
      expect(results[0].tool_call_id).toBe('call-1');
      expect(results[0].role).toBe('tool');
      expect(results[0].name).toBe('test-tool-1');
      expect(results[0].content).toBe(JSON.stringify(toolResult.evidence));
      expect(mockTool1.execute).toHaveBeenCalledWith({ param: 'value' });
    });

    it('should execute multiple tool calls in parallel', async () => {
      const toolCall1 = {
        id: 'call-1',
        function: {
          name: 'test-tool-1',
          arguments: JSON.stringify({ param1: 'value1' })
        }
      };

      const toolCall2 = {
        id: 'call-2',
        function: {
          name: 'test-tool-2',
          arguments: JSON.stringify({ param2: 'value2' })
        }
      };

      const toolResult1: ToolResult = {
        success: true,
        summary: 'Tool 1 executed'
      };

      const toolResult2: ToolResult = {
        success: true,
        summary: 'Tool 2 executed'
      };

      (mockToolRegistry.getTool as jest.Mock).mockImplementation((name: string) => {
        if (name === 'test-tool-1') return mockTool1;
        if (name === 'test-tool-2') return mockTool2;
        return undefined;
      });

      (mockTool1.execute as jest.Mock).mockResolvedValue(toolResult1);
      (mockTool2.execute as jest.Mock).mockResolvedValue(toolResult2);

      const results = await toolExecutionService.executeToolCalls([toolCall1, toolCall2]);

      expect(results).toHaveLength(2);
      expect(results[0].name).toBe('test-tool-1');
      expect(results[1].name).toBe('test-tool-2');
      expect(mockTool1.execute).toHaveBeenCalled();
      expect(mockTool2.execute).toHaveBeenCalled();
    });

    it('should handle tool not found gracefully', async () => {
      const toolCall = {
        id: 'call-1',
        function: {
          name: 'non-existent-tool',
          arguments: JSON.stringify({})
        }
      };

      (mockToolRegistry.getTool as jest.Mock).mockReturnValue(undefined);

      const results = await toolExecutionService.executeToolCalls([toolCall]);

      expect(results).toHaveLength(1);
      expect(results[0].tool_call_id).toBe('call-1');
      expect(results[0].name).toBe('non-existent-tool');
      const content = JSON.parse(results[0].content);
      expect(content.error).toContain("does not exist");
    });

    it('should handle invalid JSON arguments gracefully', async () => {
      const toolCall = {
        id: 'call-1',
        function: {
          name: 'test-tool-1',
          arguments: 'invalid json{'
        }
      };

      (mockToolRegistry.getTool as jest.Mock).mockReturnValue(mockTool1);

      const results = await toolExecutionService.executeToolCalls([toolCall]);

      expect(results).toHaveLength(1);
      expect(results[0].tool_call_id).toBe('call-1');
      const content = JSON.parse(results[0].content);
      expect(content.error).toContain("Invalid JSON arguments");
      expect(mockTool1.execute).not.toHaveBeenCalled();
    });

    it('should handle tool execution failure gracefully', async () => {
      const toolCall = {
        id: 'call-1',
        function: {
          name: 'test-tool-1',
          arguments: JSON.stringify({ param: 'value' })
        }
      };

      const toolResult: ToolResult = {
        success: false,
        summary: 'Tool execution failed'
      };

      (mockToolRegistry.getTool as jest.Mock).mockReturnValue(mockTool1);
      (mockTool1.execute as jest.Mock).mockResolvedValue(toolResult);

      const results = await toolExecutionService.executeToolCalls([toolCall]);

      expect(results).toHaveLength(1);
      const content = JSON.parse(results[0].content);
      expect(content.error).toBe('Tool execution failed');
    });

    it('should prefer evidence over summary when available', async () => {
      const toolCall = {
        id: 'call-1',
        function: {
          name: 'test-tool-1',
          arguments: JSON.stringify({})
        }
      };

      const toolResult: ToolResult = {
        success: true,
        summary: 'Summary text',
        evidence: [
          {
            file: 'test.ts',
            line: 5,
            text: 'code',
            description: 'Evidence'
          }
        ]
      };

      (mockToolRegistry.getTool as jest.Mock).mockReturnValue(mockTool1);
      (mockTool1.execute as jest.Mock).mockResolvedValue(toolResult);

      const results = await toolExecutionService.executeToolCalls([toolCall]);

      expect(results[0].content).toBe(JSON.stringify(toolResult.evidence));
      expect(results[0].content).not.toBe('Summary text');
    });

    it('should use summary when evidence is not available', async () => {
      const toolCall = {
        id: 'call-1',
        function: {
          name: 'test-tool-1',
          arguments: JSON.stringify({})
        }
      };

      const toolResult: ToolResult = {
        success: true,
        summary: 'Summary text'
      };

      (mockToolRegistry.getTool as jest.Mock).mockReturnValue(mockTool1);
      (mockTool1.execute as jest.Mock).mockResolvedValue(toolResult);

      const results = await toolExecutionService.executeToolCalls([toolCall]);

      expect(results[0].content).toBe('Summary text');
    });

    it('should populate rawResult and primaryFilePath on successful execution', async () => {
      const toolCall = {
        id: 'call-1',
        function: {
          name: 'test-tool-1',
          arguments: JSON.stringify({ filePath: 'src/foo.ts', other: 'x' })
        }
      };

      const toolResult: ToolResult = {
        success: true,
        summary: 'Summary text',
        structuredData: { some: 'data' }
      };

      (mockToolRegistry.getTool as jest.Mock).mockReturnValue(mockTool1);
      (mockTool1.execute as jest.Mock).mockResolvedValue(toolResult);

      const results = await toolExecutionService.executeToolCalls([toolCall]);

      expect(results).toHaveLength(1);
      // rawResult should be the original ToolResult
      expect(results[0].rawResult).toBe(toolResult);
      // primaryFilePath should be inferred from filePath argument
      expect(results[0].primaryFilePath).toBe('src/foo.ts');
    });

    it('should handle tool execution throwing error', async () => {
      const toolCall = {
        id: 'call-1',
        function: {
          name: 'test-tool-1',
          arguments: JSON.stringify({})
        }
      };

      (mockToolRegistry.getTool as jest.Mock).mockReturnValue(mockTool1);
      (mockTool1.execute as jest.Mock).mockRejectedValue(new Error('Tool crashed'));

      const results = await toolExecutionService.executeToolCalls([toolCall]);

      expect(results).toHaveLength(1);
      const content = JSON.parse(results[0].content);
      expect(content.error).toContain('Tool execution internal error');
      expect(content.error).toContain('Tool crashed');
    });
  });
});
