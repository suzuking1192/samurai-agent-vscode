/**
 * Tests for SamuraiAgentPanelWebviewViewProvider fast path empty message handling
 * Verifies that empty messages with fastPath: true are not saved or sent to frontend
 */

import { SamuraiAgentPanelWebviewViewProvider } from '../src/webview/SamuraiAgentPanelWebviewViewProvider';
import { DebugSessionController } from '../src/agent/controllers/DebugSessionController';
import { DataStore } from '../src/persistence/dataStore';
import { GlobalDataStore } from '../src/persistence/globalDataStore';
import { LLMProviderService } from '../src/agent/llm/llmProviderService';
import { ChatMessage, Session, MessageType } from '../src/common/models/chat-models';

// Mock VS Code
jest.mock('vscode', () => ({
  workspace: {
    workspaceFolders: [
      {
        uri: { fsPath: '/test/workspace' },
        name: 'test-workspace',
        index: 0,
      },
    ],
  },
  Uri: {
    joinPath: (...parts: string[]) => parts.join('/'),
    file: (path: string) => ({ fsPath: path }),
  },
}));

describe('SamuraiAgentPanelWebviewViewProvider - Fast Path Empty Message Handling', () => {
  let provider: SamuraiAgentPanelWebviewViewProvider;
  let mockWebview: any;
  let mockDataStore: jest.Mocked<DataStore>;
  let mockGlobalDataStore: jest.Mocked<GlobalDataStore>;
  let mockLLMProvider: jest.Mocked<LLMProviderService>;
  let mockDebugSessionController: jest.Mocked<DebugSessionController>;

  beforeEach(() => {
    jest.clearAllMocks();

    // Setup mock webview
    mockWebview = {
      postMessage: jest.fn(),
    };

    // Setup mock DataStore
    mockDataStore = {
      handleWebviewMessage: jest.fn(),
    } as any;

    // Setup mock GlobalDataStore
    mockGlobalDataStore = {
      loadGlobalSettings: jest.fn().mockReturnValue({
        type: 'success',
        payload: {
          openaiApiKey: '',
          geminiApiKey: '',
          claudeApiKey: '',
        },
      }),
    } as any;

    // Setup mock LLMProviderService
    mockLLMProvider = {} as any;

    // Setup mock DebugSessionController
    mockDebugSessionController = {
      startSession: jest.fn(),
      webviewProvider: null,
    } as any;

    // Create provider
    const mockExtensionUri = { fsPath: '/mock/extension/path' };
    provider = new SamuraiAgentPanelWebviewViewProvider(mockExtensionUri as any, {
      llmProviderService: mockLLMProvider,
      globalDataStore: mockGlobalDataStore,
      dataStore: mockDataStore,
      debugSessionController: mockDebugSessionController,
    });
  });

  describe('samurai-agent.execute command with DebugSessionController', () => {
    const mockSession: Session = {
      id: 'test-session-123',
      title: 'Test Session',
      status: 'active' as any,
      messageCount: 0,
      totalTokens: 0,
      totalCost: 0,
      lastMessageAt: new Date(),
      tags: [],
      metadata: {
        projectId: 'test-project',
        mode: 'debugging',
      },
      codeContextIds: [],
      previous_session_intent: 'pure_discussion' as any,
      pinnedFilePaths: [],
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    const mockUserMessage: ChatMessage = {
      id: 'msg-1',
      sessionId: 'test-session-123',
      projectId: 'test-project',
      type: MessageType.USER,
      content: 'Why is login failing?',
      role: 'user',
      metadata: {},
      isEdited: false,
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    const mockMessage = {
      command: 'samurai-agent.execute',
      requestId: 'test-request-123',
      payload: {
        userMessage: mockUserMessage,
        session: mockSession,
        pinnedFilePaths: [],
      },
    };

    it('should NOT save or send empty message when fastPath is true and message is empty', async () => {
      // Mock DebugSessionController to return empty message with fastPath: true
      (mockDebugSessionController.startSession as jest.Mock).mockResolvedValue({
        success: true,
        message: '', // Empty message
        metadata: {
          fastPath: true,
          userIntent: 'debugging',
          epicenter: '/test/workspace/src/auth.ts',
          source: 'user-pinned',
        },
      });

      // Call handleWebviewMessage
      await (provider as any).handleWebviewMessage(mockWebview, mockMessage);

      // Wait for async operations
      await new Promise(resolve => setTimeout(resolve, 50));

      // Verify that saveChatMessage was NOT called
      const saveChatMessageCalls = (mockDataStore.handleWebviewMessage as jest.Mock).mock.calls.filter(
        (call: any[]) => call[0]?.command === 'saveChatMessage'
      );
      expect(saveChatMessageCalls.length).toBe(0);

      // Verify that success postMessage was NOT called
      const successCalls = (mockWebview.postMessage as jest.Mock).mock.calls.filter(
        (call: any[]) => call[0]?.type === 'success'
      );
      expect(successCalls.length).toBe(0);
    });

    it('should save and send message when fastPath is true but message is not empty', async () => {
      // Mock DebugSessionController to return non-empty message with fastPath: true
      (mockDebugSessionController.startSession as jest.Mock).mockResolvedValue({
        success: true,
        message: 'Analysis started', // Non-empty message
        metadata: {
          fastPath: true,
          userIntent: 'debugging',
          epicenter: '/test/workspace/src/auth.ts',
          source: 'user-pinned',
        },
      });

      // Call handleWebviewMessage
      await (provider as any).handleWebviewMessage(mockWebview, mockMessage);

      // Wait for async operations
      await new Promise(resolve => setTimeout(resolve, 50));

      // Verify that saveChatMessage WAS called
      const saveChatMessageCalls = (mockDataStore.handleWebviewMessage as jest.Mock).mock.calls.filter(
        (call: any[]) => call[0]?.command === 'saveChatMessage'
      );
      expect(saveChatMessageCalls.length).toBe(1);
      expect(saveChatMessageCalls[0][0].payload.content).toBe('Analysis started');

      // Verify that success postMessage WAS called
      const successCalls = (mockWebview.postMessage as jest.Mock).mock.calls.filter(
        (call: any[]) => call[0]?.type === 'success'
      );
      expect(successCalls.length).toBe(1);
      expect(successCalls[0][0].payload.content).toBe('Analysis started');
      expect(successCalls[0][0].payload.metadata.samuraiAgentResponse).toBe(true);
    });

    it('should save and send message when fastPath is false even if message is empty', async () => {
      // Mock DebugSessionController to return empty message without fastPath
      (mockDebugSessionController.startSession as jest.Mock).mockResolvedValue({
        success: true,
        message: '', // Empty message
        metadata: {
          fastPath: false, // Not fast path
          userIntent: 'debugging',
        },
      });

      // Call handleWebviewMessage
      await (provider as any).handleWebviewMessage(mockWebview, mockMessage);

      // Wait for async operations
      await new Promise(resolve => setTimeout(resolve, 50));

      // Verify that saveChatMessage WAS called (because fastPath is false)
      const saveChatMessageCalls = (mockDataStore.handleWebviewMessage as jest.Mock).mock.calls.filter(
        (call: any[]) => call[0]?.command === 'saveChatMessage'
      );
      expect(saveChatMessageCalls.length).toBe(1);

      // Verify that success postMessage WAS called
      const successCalls = (mockWebview.postMessage as jest.Mock).mock.calls.filter(
        (call: any[]) => call[0]?.type === 'success'
      );
      expect(successCalls.length).toBe(1);
    });

    it('should save and send message when fastPath is undefined even if message is empty', async () => {
      // Mock DebugSessionController to return empty message without fastPath metadata
      (mockDebugSessionController.startSession as jest.Mock).mockResolvedValue({
        success: true,
        message: '', // Empty message
        metadata: {
          userIntent: 'debugging',
          // fastPath is undefined
        },
      });

      // Call handleWebviewMessage
      await (provider as any).handleWebviewMessage(mockWebview, mockMessage);

      // Wait for async operations
      await new Promise(resolve => setTimeout(resolve, 50));

      // Verify that saveChatMessage WAS called (because fastPath is undefined)
      const saveChatMessageCalls = (mockDataStore.handleWebviewMessage as jest.Mock).mock.calls.filter(
        (call: any[]) => call[0]?.command === 'saveChatMessage'
      );
      expect(saveChatMessageCalls.length).toBe(1);

      // Verify that success postMessage WAS called
      const successCalls = (mockWebview.postMessage as jest.Mock).mock.calls.filter(
        (call: any[]) => call[0]?.type === 'success'
      );
      expect(successCalls.length).toBe(1);
    });

    it('should NOT save or send when fastPath is true and message is only whitespace', async () => {
      // Mock DebugSessionController to return whitespace-only message with fastPath: true
      (mockDebugSessionController.startSession as jest.Mock).mockResolvedValue({
        success: true,
        message: '   \n\t  ', // Whitespace only
        metadata: {
          fastPath: true,
          userIntent: 'debugging',
        },
      });

      // Call handleWebviewMessage
      await (provider as any).handleWebviewMessage(mockWebview, mockMessage);

      // Wait for async operations
      await new Promise(resolve => setTimeout(resolve, 50));

      // Verify that saveChatMessage was NOT called
      const saveChatMessageCalls = (mockDataStore.handleWebviewMessage as jest.Mock).mock.calls.filter(
        (call: any[]) => call[0]?.command === 'saveChatMessage'
      );
      expect(saveChatMessageCalls.length).toBe(0);

      // Verify that success postMessage was NOT called
      const successCalls = (mockWebview.postMessage as jest.Mock).mock.calls.filter(
        (call: any[]) => call[0]?.type === 'success'
      );
      expect(successCalls.length).toBe(0);
    });
  });
});
