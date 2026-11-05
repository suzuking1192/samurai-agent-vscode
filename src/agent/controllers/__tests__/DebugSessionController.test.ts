/**
 * Tests for DebugSessionController
 */

import { DebugSessionController } from '../DebugSessionController';
import { InitialContextService } from '../../services/InitialContextService';
import { ToolRegistry } from '../../tools/ToolRegistry';
import { LLMProviderService } from '../../llm/llmProviderService';
import { ChatMessage, Session } from '../../../common/models/chat-models';
import { DebugSessionLogger } from '../../utils/DebugSessionLogger';
import { DataStore } from '../../../persistence/dataStore';
import { LLMCostStorage } from '../../../storage/llmCostStorage';

// Mock dependencies
jest.mock('../../services/InitialContextService');
jest.mock('../../tools/ToolRegistry');
jest.mock('../../llm/llmProviderService');
jest.mock('../../../persistence/dataStore');
jest.mock('../../../storage/llmCostStorage');
jest.mock('../../../persistence/globalDataStore');

// Store the mock execute function so we can modify it per test
let mockPlanningAgentExecute: jest.Mock;

jest.mock('../../core/PlanningAgent', () => ({
  PlanningAgent: jest.fn().mockImplementation(() => {
    if (!mockPlanningAgentExecute) {
      mockPlanningAgentExecute = jest.fn().mockResolvedValue({
        message: 'Analysis complete',
        finalEpicenter: '/test/workspace/src/auth.ts',
        visualizationData: { visualization: 'graph TD\nA[Test]' },
        metadata: {
          stepsTaken: 2,
          filesAnalyzed: ['src/auth.ts', 'src/user.ts'],
          cost: 0.003
        }
      });
    }
    return {
      execute: mockPlanningAgentExecute
    };
  })
}));

jest.mock('../../utils/StreamReporter', () => ({
  StreamReporter: jest.fn().mockImplementation((webviewProvider: any, sessionId: string) => {
    return {
      report: jest.fn((category: string, message: string) => {
        if (webviewProvider) {
          webviewProvider.postMessage({
            type: 'debugStatusUpdate',
            payload: {
              sessionId,
              stepId: `step-${Date.now()}-${Math.random()}`,
              category,
              message,
              timestamp: Date.now()
            }
          });
        }
      })
    };
  })
}));

jest.mock('../../utils/DebugSessionLogger', () => ({
  DebugSessionLogger: jest.fn().mockImplementation(() => ({
    logUserRequest: jest.fn(),
    logEpicenter: jest.fn(),
    logGraph: jest.fn(),
    logStep: jest.fn(),
    generateSummary: jest.fn(),
    logEpicenterRefinement: jest.fn()
  }))
}));

// Mock vscode module
jest.mock('vscode', () => ({
  Uri: {
    file: jest.fn((path: string) => ({
      fsPath: path,
      toString: () => `file://${path}`
    }))
  }
}));

// Mock webview provider - we'll create a simple mock interface
const mockWebviewProvider = {
  postMessage: jest.fn()
};

describe('DebugSessionController', () => {
  let debugController: DebugSessionController;
  let mockInitialContextService: jest.Mocked<InitialContextService>;
  let mockToolRegistry: jest.Mocked<ToolRegistry>;
  let mockLLMProvider: jest.Mocked<LLMProviderService>;
  let mockWebviewProvider: any;
  let mockLogger: jest.Mocked<DebugSessionLogger>;
  let mockDataStore: jest.Mocked<DataStore>;
  let mockLLMCostStorage: jest.Mocked<LLMCostStorage>;
  let mockSandboxTool: any;

  beforeEach(() => {
    jest.clearAllMocks();

    // Setup GlobalDataStore mock
    const { GlobalDataStore } = require('../../../persistence/globalDataStore');
    (GlobalDataStore as jest.Mock).mockImplementation(() => ({
      loadGlobalSettings: jest.fn().mockReturnValue({
        type: 'success',
        payload: { enableDebugLogging: true }
      })
    }));

    // Reset mock PlanningAgent execute function
    mockPlanningAgentExecute = jest.fn().mockResolvedValue({
      message: 'Analysis complete',
      finalEpicenter: '/test/workspace/src/auth.ts',
      visualizationData: { visualization: 'graph TD\nA[Test]' },
      metadata: {
        stepsTaken: 2,
        filesAnalyzed: ['src/auth.ts', 'src/user.ts'],
        cost: 0.003
      }
    });
    
    // Setup logger mock
    mockLogger = {
      logUserRequest: jest.fn(),
      logEpicenter: jest.fn(),
      logGraph: jest.fn(),
      logStep: jest.fn(),
      generateSummary: jest.fn(),
      logParseFailure: jest.fn(),
      logEpicenterRefinement: jest.fn()
    } as any;
    
    (DebugSessionLogger as jest.Mock).mockImplementation(() => mockLogger);

    mockInitialContextService = {
      getInitialContext: jest.fn()
    } as any;

    // Mock sandbox tool - reset for each test
    mockSandboxTool = {
      execute: jest.fn().mockResolvedValue({ success: true, summary: 'Sandbox cleared.' })
    };

    mockToolRegistry = {
      getToolDefinitions: jest.fn(),
      getTool: jest.fn().mockImplementation((name: string) => {
        if (name === 'sandbox-fs') {
          return mockSandboxTool;
        }
        return undefined;
      })
    } as any;

    mockLLMProvider = {
      chat: jest.fn(),
      addCostObserver: jest.fn().mockReturnValue(() => {}) // Return unsubscribe function
    } as any;

    mockWebviewProvider = {
      postMessage: jest.fn()
    };

    // Setup DataStore mock
    mockDataStore = {
      loadChatMessagesForSession: jest.fn().mockReturnValue([]),
      loadSession: jest.fn().mockReturnValue(undefined),
      updateSession: jest.fn(),
      handleWebviewMessage: jest.fn().mockReturnValue({ type: 'success' })
    } as any;

    // Setup LLMCostStorage mock
    mockLLMCostStorage = {
      saveRecord: jest.fn().mockResolvedValue(undefined)
    } as any;

    debugController = new DebugSessionController(
      mockInitialContextService,
      mockToolRegistry,
      mockLLMProvider,
      mockWebviewProvider,
      mockDataStore,
      undefined, // imageService
      undefined, // workspaceRoot
      mockLLMCostStorage
    );
  });

  describe('isSessionBusy', () => {
    it('should return false when no execution for that session', () => {
      expect(debugController.isSessionBusy('session-1')).toBe(false);
      expect(debugController.isSessionBusy('')).toBe(false);
    });

    it('should return true when a run is in progress for that session', async () => {
      const sessionId = 'busy-session';
      let resolveBackground: () => void;
      const backgroundPromise = new Promise<void>(r => {
        resolveBackground = r;
      });
      mockPlanningAgentExecute.mockReturnValue(backgroundPromise);

      const mockContext = {
        success: true,
        sessionId,
        epicenterFile: '/test/workspace/src/auth.ts',
        source: 'user-pinned' as const,
        graphData: { mermaid: 'graph TD\nA[Auth]', nodes: [], edges: [] }
      };
      (mockInitialContextService.getInitialContext as jest.Mock).mockResolvedValue(mockContext);

      const userMessage: ChatMessage = {
        id: 'msg-1',
        sessionId,
        projectId: 'test-project',
        type: 'user' as any,
        content: 'Why is login failing?',
        role: 'user',
        metadata: {},
        isEdited: false,
        createdAt: new Date(),
        updatedAt: new Date()
      };
      const session: Session = {
        id: sessionId,
        title: 'Test',
        status: 'active' as any,
        messageCount: 0,
        totalTokens: 0,
        totalCost: 0,
        lastMessageAt: new Date(),
        tags: [],
        metadata: { projectId: 'test-project', mode: 'debugging' },
        codeContextIds: [],
        previous_session_intent: 'pure_discussion' as any,
        pinnedFilePaths: [],
        createdAt: new Date(),
        updatedAt: new Date()
      };

      const startPromise = debugController.startSession(userMessage, session, '/test/workspace');
      await startPromise;

      expect(debugController.isSessionBusy(sessionId)).toBe(true);

      resolveBackground!();
      await backgroundPromise;
    });

    it('should return false for a different sessionId while one session is busy', async () => {
      const busySessionId = 'busy-session';
      const otherSessionId = 'other-session';
      const backgroundPromise = new Promise<void>(() => {});
      mockPlanningAgentExecute.mockReturnValue(backgroundPromise);

      const mockContext = {
        success: true,
        sessionId: busySessionId,
        epicenterFile: '/test/workspace/src/auth.ts',
        source: 'user-pinned' as const,
        graphData: { mermaid: 'graph TD\nA[Auth]', nodes: [], edges: [] }
      };
      (mockInitialContextService.getInitialContext as jest.Mock).mockResolvedValue(mockContext);

      const userMessage: ChatMessage = {
        id: 'msg-1',
        sessionId: busySessionId,
        projectId: 'test-project',
        type: 'user' as any,
        content: 'Why is login failing?',
        role: 'user',
        metadata: {},
        isEdited: false,
        createdAt: new Date(),
        updatedAt: new Date()
      };
      const session: Session = {
        id: busySessionId,
        title: 'Test',
        status: 'active' as any,
        messageCount: 0,
        totalTokens: 0,
        totalCost: 0,
        lastMessageAt: new Date(),
        tags: [],
        metadata: { projectId: 'test-project', mode: 'debugging' },
        codeContextIds: [],
        previous_session_intent: 'pure_discussion' as any,
        pinnedFilePaths: [],
        createdAt: new Date(),
        updatedAt: new Date()
      };

      await debugController.startSession(userMessage, session, '/test/workspace');

      expect(debugController.isSessionBusy(busySessionId)).toBe(true);
      expect(debugController.isSessionBusy(otherSessionId)).toBe(false);
    });
  });

  describe('startSession', () => {
    const workspaceRoot = '/test/workspace';
    const sessionId = 'test-session-123';
    
    const mockSession: Session = {
      id: sessionId,
      title: 'Test Session',
      status: 'active' as any,
      messageCount: 0,
      totalTokens: 0,
      totalCost: 0,
      lastMessageAt: new Date(),
      tags: [],
      metadata: {
        projectId: 'test-project',
        mode: 'debugging'
      },
      codeContextIds: [],
      previous_session_intent: 'pure_discussion' as any,
      pinnedFilePaths: [],
      createdAt: new Date(),
      updatedAt: new Date()
    };

    const mockUserMessage: ChatMessage = {
      id: 'msg-1',
      sessionId,
      projectId: 'test-project',
      type: 'user' as any,
      content: 'Why is login failing?',
      role: 'user',
      metadata: {},
      isEdited: false,
      createdAt: new Date(),
      updatedAt: new Date()
    };

    describe('sandbox cleanup', () => {
      // cleanSandbox is a public method but not called from startSession
      // (it's invoked externally by the extension host)

      it('should continue session even if sandbox cleanup fails', async () => {
        const mockContext = {
          success: true,
          sessionId,
          epicenterFile: '/test/workspace/src/auth.ts',
          source: 'user-pinned' as const,
          graphData: {
            mermaid: 'graph TD\nA[Auth]',
            nodes: [],
            edges: []
          },
          cost: 0
        };

        // Make sandbox cleanup fail
        (mockSandboxTool.execute as jest.Mock).mockRejectedValueOnce(new Error('Cleanup failed'));

        (mockInitialContextService.getInitialContext as jest.Mock).mockResolvedValue(mockContext);

        const result = await debugController.startSession(
          mockUserMessage,
          mockSession,
          workspaceRoot
        );

        // Session should still succeed despite sandbox cleanup failure
        expect(result.success).toBe(true);
        expect(result.metadata.fastPath).toBe(true);
      });

      it('should handle missing sandbox tool gracefully', async () => {
        const mockContext = {
          success: true,
          sessionId,
          epicenterFile: '/test/workspace/src/auth.ts',
          source: 'user-pinned' as const,
          graphData: {
            mermaid: 'graph TD\nA[Auth]',
            nodes: [],
            edges: []
          },
          cost: 0
        };

        // Make getTool return undefined for sandbox-fs
        (mockToolRegistry.getTool as jest.Mock).mockImplementation((name: string) => {
          if (name === 'sandbox-fs') {
            return undefined;
          }
          return undefined;
        });

        (mockInitialContextService.getInitialContext as jest.Mock).mockResolvedValue(mockContext);

        const result = await debugController.startSession(
          mockUserMessage,
          mockSession,
          workspaceRoot
        );

        // Session should still succeed even if sandbox tool is not available
        expect(result.success).toBe(true);
        expect(result.metadata.fastPath).toBe(true);
      });
    });

    describe('successful fast path', () => {
      it('should return immediate response with graph data', async () => {
        const mockContext = {
          success: true,
          sessionId,
          epicenterFile: '/test/workspace/src/auth.ts',
          source: 'user-pinned' as const,
          graphData: {
            mermaid: 'graph TD\nA[Auth] --> B[Login]',
            nodes: [{ id: '1', label: 'Auth' }],
            edges: []
          },
          cost: 0 // No LLM call for pinned files
        };

        (mockInitialContextService.getInitialContext as jest.Mock).mockResolvedValue(mockContext);

        const result = await debugController.startSession(
          mockUserMessage,
          mockSession,
          workspaceRoot
        );

        expect(result.success).toBe(true);
        expect(result.message).toBe('');
        expect(result.metadata.fastPath).toBe(true);
        expect(result.metadata.epicenter).toBe(mockContext.epicenterFile);
        expect(result.metadata.source).toBe('user-pinned');
        // visualization is disabled (null) in current implementation
        expect(result.metadata.visualization).toBeNull();
      });

      it('should emit phase status updates during session initialization', async () => {
        const mockContext = {
          success: true,
          sessionId,
          epicenterFile: '/test/workspace/src/auth.ts',
          source: 'user-pinned' as const,
          graphData: {
            mermaid: 'graph TD\nA[Auth]',
            nodes: [],
            edges: []
          }
        };

        (mockInitialContextService.getInitialContext as jest.Mock).mockResolvedValue(mockContext);

        await debugController.startSession(
          mockUserMessage,
          mockSession,
          workspaceRoot
        );

        const postMessageCalls = (mockWebviewProvider.postMessage as jest.Mock).mock.calls;
        
        // Should emit initial phase events
        const statusUpdates = postMessageCalls.filter(
          (call: any[]) => call[0]?.type === 'debugStatusUpdate'
        );

        expect(statusUpdates.length).toBeGreaterThanOrEqual(2);
        
        // Verify initial phase messages
        const messages = statusUpdates.map((call: any[]) => call[0].payload.message);
        expect(messages).toContain('Initializing debugging session...');
        expect(messages).toContain('Scanning logs and workspace to find epicenter...');
        expect(messages.some((msg: string) => msg.includes('Epicenter identified'))).toBe(true);
        expect(messages).toContain('Dependency graph mapped.');
        
        // Verify all are phase category
        statusUpdates.forEach((call: any[]) => {
          expect(call[0].payload.category).toBe('phase');
          expect(call[0].payload.sessionId).toBe(sessionId);
        });
      });

      it('should emit epicenter filename in status update', async () => {
        const mockContext = {
          success: true,
          sessionId,
          epicenterFile: '/test/workspace/src/auth.ts',
          source: 'user-pinned' as const,
          graphData: {
            mermaid: 'graph TD\nA[Auth]',
            nodes: [],
            edges: []
          }
        };

        (mockInitialContextService.getInitialContext as jest.Mock).mockResolvedValue(mockContext);

        await debugController.startSession(
          mockUserMessage,
          mockSession,
          workspaceRoot
        );

        const postMessageCalls = (mockWebviewProvider.postMessage as jest.Mock).mock.calls;
        const statusUpdates = postMessageCalls.filter(
          (call: any[]) => call[0]?.type === 'debugStatusUpdate'
        );

        // Find the epicenter identified message
        const epicenterMessage = statusUpdates.find(
          (call: any[]) => call[0].payload.message.includes('Epicenter identified')
        );

        expect(epicenterMessage).toBeDefined();
        expect(epicenterMessage[0].payload.message).toContain('auth.ts');
      });

      it('should pass pinned files to InitialContextService', async () => {
        const sessionWithPinned = {
          ...mockSession,
          pinnedFilePaths: ['/test/workspace/src/auth.ts', '/test/workspace/src/user.ts']
        };

        const mockContext = {
          success: true,
          sessionId,
          epicenterFile: '/test/workspace/src/auth.ts',
          source: 'user-pinned' as const,
          graphData: {
            mermaid: 'graph TD\nA[Auth]',
            nodes: [],
            edges: []
          }
        };

        (mockInitialContextService.getInitialContext as jest.Mock).mockResolvedValue(mockContext);

        await debugController.startSession(
          mockUserMessage,
          sessionWithPinned,
          workspaceRoot
        );

        expect(mockInitialContextService.getInitialContext).toHaveBeenCalledWith(
          sessionId,
          mockUserMessage.content,
          workspaceRoot,
          undefined,
          sessionWithPinned.pinnedFilePaths,
          undefined
        );
      });

      it('should pass logs from user message metadata', async () => {
        const userMessageWithLogs = {
          ...mockUserMessage,
          metadata: {
            log: 'Error: Cannot read property\n    at getUser (/app/src/api/user.ts:15:8)'
          }
        };

        const mockContext = {
          success: true,
          sessionId,
          epicenterFile: '/app/src/api/user.ts',
          source: 'logs' as const,
          graphData: {
            mermaid: 'graph TD\nA[User]',
            nodes: [],
            edges: []
          }
        };

        (mockInitialContextService.getInitialContext as jest.Mock).mockResolvedValue(mockContext);

        await debugController.startSession(
          userMessageWithLogs,
          mockSession,
          workspaceRoot
        );

        expect(mockInitialContextService.getInitialContext).toHaveBeenCalledWith(
          sessionId,
          userMessageWithLogs.content,
          workspaceRoot,
          userMessageWithLogs.metadata.log,
          undefined,
          undefined
        );
        
        // Verify logger was called with logs
        expect(mockLogger.logUserRequest).toHaveBeenCalledWith(
          userMessageWithLogs.content,
          userMessageWithLogs.metadata.log
        );
      });

      it('should pass model from session metadata', async () => {
        const sessionWithModel = {
          ...mockSession,
          metadata: {
            ...mockSession.metadata,
            model: 'gpt-4o'
          }
        };

        const mockContext = {
          success: true,
          sessionId,
          epicenterFile: '/test/workspace/src/auth.ts',
          source: 'search' as const,
          graphData: {
            mermaid: 'graph TD\nA[Auth]',
            nodes: [],
            edges: []
          }
        };

        (mockInitialContextService.getInitialContext as jest.Mock).mockResolvedValue(mockContext);

        await debugController.startSession(
          mockUserMessage,
          sessionWithModel,
          workspaceRoot
        );

        expect(mockInitialContextService.getInitialContext).toHaveBeenCalledWith(
          sessionId,
          mockUserMessage.content,
          workspaceRoot,
          undefined,
          undefined,
          'gpt-4o'
        );
      });

      it('should trigger background agent asynchronously', async () => {
        const mockContext = {
          success: true,
          sessionId,
          epicenterFile: '/test/workspace/src/auth.ts',
          source: 'user-pinned' as const,
          graphData: {
            mermaid: 'graph TD\nA[Auth]',
            nodes: [],
            edges: []
          }
        };

        (mockInitialContextService.getInitialContext as jest.Mock).mockResolvedValue(mockContext);

        // Mock console.log to verify background agent is called
        const consoleSpy = jest.spyOn(console, 'log').mockImplementation();

        const result = await debugController.startSession(
          mockUserMessage,
          mockSession,
          workspaceRoot
        );

        // Should return immediately
        expect(result.success).toBe(true);

        // Wait a bit for background agent to start
        await new Promise(resolve => setTimeout(resolve, 50));

        // Verify background agent was called (logs to console)
        expect(consoleSpy).toHaveBeenCalledWith(
          expect.stringContaining('[BackgroundAgent]'),
          expect.any(Object)
        );

        consoleSpy.mockRestore();
      });

      it('should send atomic debugSessionFinished event after background agent completes', async () => {
        const initialContextCost = 0.002;
        const planningAgentCost = 0.003;
        const expectedTotalCost = initialContextCost + planningAgentCost;

        const mockContext = {
          success: true,
          sessionId,
          epicenterFile: '/test/workspace/src/auth.ts',
          source: 'search' as const, // Using 'search' to indicate LLM was used
          graphData: {
            mermaid: 'graph TD\nA[Auth] --> B[Login]',
            nodes: [{ id: '1', label: 'Auth' }],
            edges: []
          },
          cost: initialContextCost
        };

        (mockInitialContextService.getInitialContext as jest.Mock).mockResolvedValue(mockContext);
        
        // Update mock to return the expected cost
        mockPlanningAgentExecute.mockResolvedValue({
          message: 'Analysis complete',
          finalEpicenter: '/test/workspace/src/auth.ts',
          visualizationData: { visualization: 'graph TD\nA[Test]' },
          metadata: {
            stepsTaken: 2,
            filesAnalyzed: ['src/auth.ts', 'src/user.ts'],
            cost: planningAgentCost
          }
        });

        await debugController.startSession(
          mockUserMessage,
          mockSession,
          workspaceRoot
        );

        // Wait for background agent to complete
        await new Promise(resolve => setTimeout(resolve, 100));

        // Verify atomic completion event was sent
        const postMessageCalls = (mockWebviewProvider.postMessage as jest.Mock).mock.calls;
        const debugSessionFinishedCall = postMessageCalls.find((call: any[]) => 
          call[0]?.type === 'debugSessionFinished'
        );

        expect(debugSessionFinishedCall).toBeDefined();
        expect(debugSessionFinishedCall[0]).toMatchObject({
          type: 'debugSessionFinished',
          payload: {
            sessionId,
            content: 'Analysis complete',
            visualization: null,
            epilogue: {
              steps: 2,
              files: ['src/auth.ts', 'src/user.ts'],
              cost: expectedTotalCost // Should be sum of initial context + planning agent
            },
            alreadyPersisted: true
          }
        });
        expect(debugSessionFinishedCall[0].timestamp).toBeInstanceOf(Date);

        // Backend should have saved the agent response to DataStore (so it persists even if webview is closed)
        const saveChatMessageCalls = (mockDataStore.handleWebviewMessage as jest.Mock).mock.calls.filter(
          (call: any[]) => call[0]?.command === 'saveChatMessage'
        );
        expect(saveChatMessageCalls.length).toBe(1);
        const savePayload = saveChatMessageCalls[0][0].payload;
        expect(savePayload.sessionId).toBe(sessionId);
        expect(savePayload.projectId).toBe('test-project');
        expect(savePayload.role).toBe('assistant');
        expect(savePayload.content).toContain('Analysis complete');
        expect(savePayload.content).toContain('Analysis complete: 2 step');
        expect(savePayload.content).toContain('Cost: $');
        expect(savePayload.metadata?.debugSessionFinished).toBe(true);
        expect(savePayload.id).toBeDefined();
      });

      it('should save agent response to DataStore when PlanningAgent returns empty message', async () => {
        const mockContext = {
          success: true,
          sessionId,
          epicenterFile: '/test/workspace/src/auth.ts',
          source: 'user-pinned' as const,
          graphData: {
            mermaid: 'graph TD\nA[Auth]',
            nodes: [],
            edges: []
          },
          cost: 0.002
        };

        (mockInitialContextService.getInitialContext as jest.Mock).mockResolvedValue(mockContext);
        mockPlanningAgentExecute.mockResolvedValue({
          message: '',
          finalEpicenter: undefined,
          visualizationData: undefined,
          metadata: {
            stepsTaken: 0,
            filesAnalyzed: [],
            cost: 0
          }
        });

        await debugController.startSession(
          mockUserMessage,
          mockSession,
          workspaceRoot
        );

        await new Promise(resolve => setTimeout(resolve, 100));

        const postMessageCalls = (mockWebviewProvider.postMessage as jest.Mock).mock.calls;
        const debugSessionFinishedCall = postMessageCalls.find((call: any[]) =>
          call[0]?.type === 'debugSessionFinished'
        );
        expect(debugSessionFinishedCall).toBeDefined();
        expect(debugSessionFinishedCall[0].payload.content).toContain('I apologize');
        expect(debugSessionFinishedCall[0].payload.alreadyPersisted).toBe(true);

        const saveChatMessageCalls = (mockDataStore.handleWebviewMessage as jest.Mock).mock.calls.filter(
          (call: any[]) => call[0]?.command === 'saveChatMessage'
        );
        expect(saveChatMessageCalls.length).toBe(1);
        const savePayload = saveChatMessageCalls[0][0].payload;
        expect(savePayload.role).toBe('assistant');
        expect(savePayload.content).toContain('I apologize');
        expect(savePayload.sessionId).toBe(sessionId);
        expect(savePayload.projectId).toBe('test-project');
      });

      it('should still send debugSessionFinished when DataStore is undefined (no save attempted)', async () => {
        const controllerWithoutDataStore = new DebugSessionController(
          mockInitialContextService,
          mockToolRegistry,
          mockLLMProvider,
          mockWebviewProvider,
          undefined, // dataStore
          undefined, // imageService
          undefined, // workspaceRoot
          undefined // llmCostStorage
        );

        const mockContext = {
          success: true,
          sessionId,
          epicenterFile: '/test/workspace/src/auth.ts',
          source: 'user-pinned' as const,
          graphData: {
            mermaid: 'graph TD\nA[Auth]',
            nodes: [],
            edges: []
          }
        };

        (mockInitialContextService.getInitialContext as jest.Mock).mockResolvedValue(mockContext);

        await controllerWithoutDataStore.startSession(
          mockUserMessage,
          mockSession,
          workspaceRoot
        );

        await new Promise(resolve => setTimeout(resolve, 100));

        const postMessageCalls = (mockWebviewProvider.postMessage as jest.Mock).mock.calls;
        const debugSessionFinishedCall = postMessageCalls.find((call: any[]) =>
          call[0]?.type === 'debugSessionFinished'
        );
        expect(debugSessionFinishedCall).toBeDefined();
        expect(debugSessionFinishedCall[0].payload.sessionId).toBe(sessionId);
        expect(debugSessionFinishedCall[0].payload.alreadyPersisted).toBe(false);
        expect(mockDataStore.handleWebviewMessage).not.toHaveBeenCalled();
      });

      describe('error path', () => {
        // Use fresh session objects so state is not shared with prior tests
        const freshSession = (): Session => ({
          ...mockSession,
          id: `fresh-${Math.random().toString(36).slice(2)}`
        });

        it('when PlanningAgent.execute throws, agentError is posted to webview', async () => {
          const sessionForTest = freshSession();
          const mockContext = {
            success: true,
            sessionId: sessionForTest.id,
            epicenterFile: '/test/workspace/src/auth.ts',
            source: 'user-pinned' as const,
            graphData: { mermaid: 'graph TD\nA[Auth]', nodes: [], edges: [] },
            cost: 0
          };
          (mockInitialContextService.getInitialContext as jest.Mock).mockResolvedValue(mockContext);
          mockPlanningAgentExecute.mockRejectedValueOnce(new Error('Agent failed'));

          await debugController.startSession(mockUserMessage, sessionForTest, workspaceRoot);
          await new Promise(resolve => setTimeout(resolve, 100));

          expect(mockWebviewProvider.postMessage).toHaveBeenCalledWith(
            expect.objectContaining({
              type: 'agentError',
              payload: expect.objectContaining({
                sessionId: sessionForTest.id,
                // Raw "Agent failed" is sanitized to a user-friendly message
                error: expect.stringContaining('unexpected error')
              })
            })
          );
        });

        it('when PlanningAgent returns success:false with network error, user sees friendly message', async () => {
          const sessionForTest = freshSession();
          const mockContext = {
            success: true,
            sessionId: sessionForTest.id,
            epicenterFile: '/test/workspace/src/auth.ts',
            source: 'user-pinned' as const,
            graphData: { mermaid: 'graph TD\nA[Auth]', nodes: [], edges: [] },
            cost: 0
          };
          (mockInitialContextService.getInitialContext as jest.Mock).mockResolvedValue(mockContext);
          mockPlanningAgentExecute.mockResolvedValue({
            success: false,
            message: 'Analysis failed: exception TypeError: fetch failed sending request',
            metadata: { stepsTaken: 3, filesAnalyzed: ['src/auth.ts'], cost: 0.001 }
          });

          await debugController.startSession(mockUserMessage, sessionForTest, workspaceRoot);
          await new Promise(resolve => setTimeout(resolve, 100));

          const postMessageCalls = (mockWebviewProvider.postMessage as jest.Mock).mock.calls;
          const finishedCall = postMessageCalls.find((call: any[]) =>
            call[0]?.type === 'debugSessionFinished'
          );
          expect(finishedCall).toBeDefined();
          // Should contain friendly message, not raw error
          expect(finishedCall[0].payload.content).toContain('network issue');
          expect(finishedCall[0].payload.content).not.toContain('TypeError');
        });

        it('when PlanningAgent throws network error, agentError has friendly message', async () => {
          const sessionForTest = freshSession();
          const mockContext = {
            success: true,
            sessionId: sessionForTest.id,
            epicenterFile: '/test/workspace/src/auth.ts',
            source: 'user-pinned' as const,
            graphData: { mermaid: 'graph TD\nA[Auth]', nodes: [], edges: [] },
            cost: 0
          };
          (mockInitialContextService.getInitialContext as jest.Mock).mockResolvedValue(mockContext);
          mockPlanningAgentExecute.mockRejectedValueOnce(new Error('LLM call failed: exception TypeError: fetch failed'));

          await debugController.startSession(mockUserMessage, sessionForTest, workspaceRoot);
          await new Promise(resolve => setTimeout(resolve, 100));

          const postMessageCalls = (mockWebviewProvider.postMessage as jest.Mock).mock.calls;
          const agentErrorCall = postMessageCalls.find((call: any[]) =>
            call[0]?.type === 'agentError'
          );
          expect(agentErrorCall).toBeDefined();
          expect(agentErrorCall[0].payload.error).toContain('network issue');
          expect(agentErrorCall[0].payload.error).not.toContain('TypeError');
        });
      });

      // Final graph generation is disabled (commented out in source)

      it('should not generate final graph when finalEpicenter is missing', async () => {
        const mockContext = {
          success: true,
          sessionId,
          epicenterFile: '/test/workspace/src/auth.ts',
          source: 'user-pinned' as const,
          graphData: {
            mermaid: 'graph TD\nA[Auth]',
            nodes: [],
            edges: []
          }
        };

        (mockInitialContextService.getInitialContext as jest.Mock).mockResolvedValue(mockContext);
        
        // Mock PlanningAgent to return without finalEpicenter
        mockPlanningAgentExecute.mockResolvedValue({
          message: 'Analysis complete',
          // No finalEpicenter
          visualizationData: { visualization: 'graph TD\nA[Test]' },
          metadata: {
            stepsTaken: 2,
            filesAnalyzed: ['src/auth.ts'],
            cost: 0.003
          }
        });

        await debugController.startSession(
          mockUserMessage,
          mockSession,
          workspaceRoot
        );

        // Wait for background agent
        await new Promise(resolve => setTimeout(resolve, 150));

        // Verify graph-context tool was NOT called
        expect(mockToolRegistry.getTool).not.toHaveBeenCalledWith('graph-context');
      });

      // Graph generation and visualization fallback tests removed - features are disabled

      it('should not send separate debugVisualization and success messages', async () => {
        const mockContext = {
          success: true,
          sessionId,
          epicenterFile: '/test/workspace/src/auth.ts',
          source: 'user-pinned' as const,
          graphData: {
            mermaid: 'graph TD\nA[Auth]',
            nodes: [],
            edges: []
          }
        };

        (mockInitialContextService.getInitialContext as jest.Mock).mockResolvedValue(mockContext);

        await debugController.startSession(
          mockUserMessage,
          mockSession,
          workspaceRoot
        );

        await new Promise(resolve => setTimeout(resolve, 100));

        const postMessageCalls = (mockWebviewProvider.postMessage as jest.Mock).mock.calls;

        // Should not have the old separate messages
        const debugVisualizationCall = postMessageCalls.find((call: any[]) => 
          call[0]?.type === 'debugVisualization'
        );
        const successCall = postMessageCalls.find((call: any[]) => 
          call[0]?.type === 'success' && call[0]?.payload?.metadata?.planningAgentResponse
        );

        expect(debugVisualizationCall).toBeUndefined();
        expect(successCall).toBeUndefined();

        // Should have the atomic event instead
        const debugSessionFinishedCall = postMessageCalls.find((call: any[]) => 
          call[0]?.type === 'debugSessionFinished'
        );
        expect(debugSessionFinishedCall).toBeDefined();
      });
    });

    describe('fast path failure', () => {
      it('should return error when no epicenter found', async () => {
        const mockContext = {
          success: false,
          sessionId,
          source: 'none' as const,
          error: "I analyzed the request but couldn't pinpoint a starting file.",
          cost: 0 // No successful epicenter found
        };

        (mockInitialContextService.getInitialContext as jest.Mock).mockResolvedValue(mockContext);

        const result = await debugController.startSession(
          mockUserMessage,
          mockSession,
          workspaceRoot
        );

        expect(result.success).toBe(false);
        expect(result.message).toContain("couldn't pinpoint");
        expect(result.metadata.status).toBe('needs_info');
        // Status updates may be sent before context fails, so we just check that no debugGraphUpdate was sent
        const graphUpdateCalls = (mockWebviewProvider.postMessage as jest.Mock).mock.calls.filter(
          (call: any[]) => call[0]?.type === 'debugGraphUpdate'
        );
        expect(graphUpdateCalls.length).toBe(0);
      });
    });

    describe('error handling', () => {
      it('should handle InitialContextService errors gracefully', async () => {
        (mockInitialContextService.getInitialContext as jest.Mock).mockRejectedValue(
          new Error('Service error')
        );

        const result = await debugController.startSession(
          mockUserMessage,
          mockSession,
          workspaceRoot
        );

        expect(result.success).toBe(false);
        expect(result.message).toContain('System Error');
        expect(result.metadata.fastPath).toBe(true);
      });

      it('should handle webview provider errors gracefully', async () => {
        const mockContext = {
          success: true,
          sessionId,
          epicenterFile: '/test/workspace/src/auth.ts',
          source: 'user-pinned' as const,
          graphData: {
            mermaid: 'graph TD\nA[Auth]',
            nodes: [],
            edges: []
          }
        };

        (mockInitialContextService.getInitialContext as jest.Mock).mockResolvedValue(mockContext);
        
        // Mock postMessage to throw error on first call, but wrap in try-catch in controller
        // StreamReporter calls postMessage, so we need to handle errors from those calls too
        let callCount = 0;
        (mockWebviewProvider.postMessage as jest.Mock).mockImplementation(() => {
          callCount++;
          // Only throw on graph update (after status updates)
          if (callCount > 10) { // Status updates come first
            throw new Error('Webview error');
          }
        });

        // The controller should handle the error and still return success
        // because the error happens after we have the context
        const result = await debugController.startSession(
          mockUserMessage,
          mockSession,
          workspaceRoot
        );

        // Should still return success even if webview fails (error is caught)
        expect(result.success).toBe(true);
        expect(result.metadata.epicenter).toBe(mockContext.epicenterFile);
      });

      it('should handle background agent errors', async () => {
        const mockContext = {
          success: true,
          sessionId,
          epicenterFile: '/test/workspace/src/auth.ts',
          source: 'user-pinned' as const,
          graphData: {
            mermaid: 'graph TD\nA[Auth]',
            nodes: [],
            edges: []
          }
        };

        (mockInitialContextService.getInitialContext as jest.Mock).mockResolvedValue(mockContext);

        // Mock console.error to verify error handling
        const consoleErrorSpy = jest.spyOn(console, 'error').mockImplementation();

        // Set webview provider to null to trigger error in background agent
        debugController.setWebviewProvider(null);

        const result = await debugController.startSession(
          mockUserMessage,
          mockSession,
          workspaceRoot
        );

        // Should still return success
        expect(result.success).toBe(true);

        // Wait for background agent error
        await new Promise(resolve => setTimeout(resolve, 10));

        consoleErrorSpy.mockRestore();
      });
    });

    describe('cost aggregation', () => {
      it('should aggregate initial context cost with planning agent cost', async () => {
        const initialContextCost = 0.005;
        const planningAgentCost = 0.010;
        const expectedTotalCost = initialContextCost + planningAgentCost;

        const mockContext = {
          success: true,
          sessionId,
          epicenterFile: '/test/workspace/src/auth.ts',
          source: 'search' as const,
          graphData: {
            mermaid: 'graph TD\nA[Auth]',
            nodes: [],
            edges: []
          },
          cost: initialContextCost
        };

        (mockInitialContextService.getInitialContext as jest.Mock).mockResolvedValue(mockContext);
        
        mockPlanningAgentExecute.mockResolvedValue({
          message: 'Analysis complete',
          finalEpicenter: '/test/workspace/src/auth.ts',
          visualizationData: { visualization: 'graph TD\nA[Test]' },
          metadata: {
            stepsTaken: 3,
            filesAnalyzed: ['src/auth.ts'],
            cost: planningAgentCost
          }
        });

        await debugController.startSession(
          mockUserMessage,
          mockSession,
          workspaceRoot
        );

        await new Promise(resolve => setTimeout(resolve, 100));

        const postMessageCalls = (mockWebviewProvider.postMessage as jest.Mock).mock.calls;
        const debugSessionFinishedCall = postMessageCalls.find((call: any[]) => 
          call[0]?.type === 'debugSessionFinished'
        );

        expect(debugSessionFinishedCall).toBeDefined();
        expect(debugSessionFinishedCall[0].payload.epilogue.cost).toBe(expectedTotalCost);
      });

      it('should handle zero initial context cost correctly', async () => {
        const initialContextCost = 0; // No LLM call (pinned files path)
        const planningAgentCost = 0.015;
        const expectedTotalCost = initialContextCost + planningAgentCost;

        const mockContext = {
          success: true,
          sessionId,
          epicenterFile: '/test/workspace/src/auth.ts',
          source: 'user-pinned' as const,
          graphData: {
            mermaid: 'graph TD\nA[Auth]',
            nodes: [],
            edges: []
          },
          cost: initialContextCost
        };

        (mockInitialContextService.getInitialContext as jest.Mock).mockResolvedValue(mockContext);
        
        mockPlanningAgentExecute.mockResolvedValue({
          message: 'Analysis complete',
          finalEpicenter: '/test/workspace/src/auth.ts',
          visualizationData: { visualization: 'graph TD\nA[Test]' },
          metadata: {
            stepsTaken: 2,
            filesAnalyzed: ['src/auth.ts'],
            cost: planningAgentCost
          }
        });

        await debugController.startSession(
          mockUserMessage,
          mockSession,
          workspaceRoot
        );

        await new Promise(resolve => setTimeout(resolve, 100));

        const postMessageCalls = (mockWebviewProvider.postMessage as jest.Mock).mock.calls;
        const debugSessionFinishedCall = postMessageCalls.find((call: any[]) => 
          call[0]?.type === 'debugSessionFinished'
        );

        expect(debugSessionFinishedCall).toBeDefined();
        expect(debugSessionFinishedCall[0].payload.epilogue.cost).toBe(expectedTotalCost);
      });

      it('should handle undefined costs gracefully', async () => {
        const mockContext = {
          success: true,
          sessionId,
          epicenterFile: '/test/workspace/src/auth.ts',
          source: 'user-pinned' as const,
          graphData: {
            mermaid: 'graph TD\nA[Auth]',
            nodes: [],
            edges: []
          }
          // cost is undefined
        };

        (mockInitialContextService.getInitialContext as jest.Mock).mockResolvedValue(mockContext);
        
        mockPlanningAgentExecute.mockResolvedValue({
          message: 'Analysis complete',
          finalEpicenter: '/test/workspace/src/auth.ts',
          visualizationData: { visualization: 'graph TD\nA[Test]' },
          metadata: {
            stepsTaken: 2,
            filesAnalyzed: ['src/auth.ts']
            // cost is undefined
          }
        });

        await debugController.startSession(
          mockUserMessage,
          mockSession,
          workspaceRoot
        );

        await new Promise(resolve => setTimeout(resolve, 100));

        const postMessageCalls = (mockWebviewProvider.postMessage as jest.Mock).mock.calls;
        const debugSessionFinishedCall = postMessageCalls.find((call: any[]) => 
          call[0]?.type === 'debugSessionFinished'
        );

        expect(debugSessionFinishedCall).toBeDefined();
        // Should default to 0 when costs are undefined
        expect(debugSessionFinishedCall[0].payload.epilogue.cost).toBe(0);
      });

      it('should show per-turn cost, not cumulative cost across multiple turns', async () => {
        // Turn 1: Initial context ($0.10) + PlanningAgent ($0.20) = $0.30
        const turn1InitialCost = 0.10;
        const turn1PlanningCost = 0.20;
        const expectedTurn1Cost = turn1InitialCost + turn1PlanningCost;

        const mockContext1 = {
          success: true,
          sessionId,
          epicenterFile: '/test/workspace/src/auth.ts',
          source: 'user-pinned' as const,
          graphData: {
            mermaid: 'graph TD\nA[Auth]',
            nodes: [],
            edges: []
          },
          cost: turn1InitialCost
        };

        (mockInitialContextService.getInitialContext as jest.Mock).mockResolvedValue(mockContext1);
        
        mockPlanningAgentExecute.mockResolvedValue({
          message: 'Analysis complete - Turn 1',
          finalEpicenter: '/test/workspace/src/auth.ts',
          visualizationData: { visualization: 'graph TD\nA[Test]' },
          metadata: {
            stepsTaken: 2,
            filesAnalyzed: ['src/auth.ts'],
            cost: turn1PlanningCost
          }
        });

        await debugController.startSession(
          mockUserMessage,
          mockSession,
          workspaceRoot
        );

        await new Promise(resolve => setTimeout(resolve, 100));

        let postMessageCalls = (mockWebviewProvider.postMessage as jest.Mock).mock.calls;
        let debugSessionFinishedCall = postMessageCalls.find((call: any[]) => 
          call[0]?.type === 'debugSessionFinished'
        );

        expect(debugSessionFinishedCall).toBeDefined();
        expect(debugSessionFinishedCall[0].payload.epilogue.cost).toBe(expectedTurn1Cost);

        // Turn 2: Initial context ($0.15) + PlanningAgent ($0.25) = $0.40 (NOT $0.70)
        const turn2InitialCost = 0.15;
        const turn2PlanningCost = 0.25;
        const expectedTurn2Cost = turn2InitialCost + turn2PlanningCost;

        const mockContext2 = {
          success: true,
          sessionId,
          epicenterFile: '/test/workspace/src/auth.ts',
          source: 'user-pinned' as const,
          graphData: {
            mermaid: 'graph TD\nA[Auth]',
            nodes: [],
            edges: []
          },
          cost: turn2InitialCost
        };

        (mockInitialContextService.getInitialContext as jest.Mock).mockResolvedValue(mockContext2);
        
        mockPlanningAgentExecute.mockResolvedValue({
          message: 'Analysis complete - Turn 2',
          finalEpicenter: '/test/workspace/src/auth.ts',
          visualizationData: { visualization: 'graph TD\nA[Test]' },
          metadata: {
            stepsTaken: 3,
            filesAnalyzed: ['src/auth.ts', 'src/user.ts'],
            cost: turn2PlanningCost
          }
        });

        // Clear previous calls
        (mockWebviewProvider.postMessage as jest.Mock).mockClear();

        await debugController.startSession(
          mockUserMessage,
          mockSession,
          workspaceRoot
        );

        await new Promise(resolve => setTimeout(resolve, 100));

        postMessageCalls = (mockWebviewProvider.postMessage as jest.Mock).mock.calls;
        debugSessionFinishedCall = postMessageCalls.find((call: any[]) => 
          call[0]?.type === 'debugSessionFinished'
        );

        expect(debugSessionFinishedCall).toBeDefined();
        // Should show only Turn 2's cost, not cumulative
        expect(debugSessionFinishedCall[0].payload.epilogue.cost).toBe(expectedTurn2Cost);
        // Verify it's NOT the cumulative total
        expect(debugSessionFinishedCall[0].payload.epilogue.cost).not.toBe(expectedTurn1Cost + expectedTurn2Cost);
      });

      it('should strip cost footer from chat history before sending to LLM', async () => {
        const mockContext = {
          success: true,
          sessionId,
          epicenterFile: '/test/workspace/src/auth.ts',
          source: 'user-pinned' as const,
          graphData: {
            mermaid: 'graph TD\nA[Auth]',
            nodes: [],
            edges: []
          },
          cost: 0.10
        };

        (mockInitialContextService.getInitialContext as jest.Mock).mockResolvedValue(mockContext);
        
        mockPlanningAgentExecute.mockResolvedValue({
          message: 'Analysis complete',
          finalEpicenter: '/test/workspace/src/auth.ts',
          visualizationData: { visualization: 'graph TD\nA[Test]' },
          metadata: {
            stepsTaken: 2,
            filesAnalyzed: ['src/auth.ts'],
            cost: 0.20
          }
        });

        // Mock chat history with cost footer in previous assistant message
        const mockChatHistory = [
          {
            id: 'msg1',
            sessionId,
            role: 'user',
            content: 'First question',
            type: 'user',
            createdAt: new Date(),
            updatedAt: new Date()
          },
          {
            id: 'msg2',
            sessionId,
            role: 'assistant',
            content: 'Previous analysis.\n\n*Analysis complete: 5 steps, 3 files analyzed. Cost: $0.3000*',
            type: 'assistant',
            createdAt: new Date(),
            updatedAt: new Date()
          }
        ];

        (mockDataStore.loadChatMessagesForSession as jest.Mock).mockReturnValue(mockChatHistory);

        await debugController.startSession(
          mockUserMessage,
          mockSession,
          workspaceRoot
        );

        await new Promise(resolve => setTimeout(resolve, 100));

        // Verify PlanningAgent was called with chat history that has cost footer stripped
        expect(mockPlanningAgentExecute).toHaveBeenCalled();
        const planningAgentCall = mockPlanningAgentExecute.mock.calls[0];
        const chatHistoryArg = planningAgentCall[6]; // 7th argument is chatHistory

        expect(chatHistoryArg).toBeDefined();
        expect(Array.isArray(chatHistoryArg)).toBe(true);
        
        // Find the assistant message in chat history
        const assistantMessage = chatHistoryArg.find((msg: any) => msg.role === 'assistant');
        expect(assistantMessage).toBeDefined();
        
        // Verify cost footer was stripped
        expect(assistantMessage.content).not.toContain('Analysis complete');
        expect(assistantMessage.content).not.toContain('Cost:');
        expect(assistantMessage.content).toBe('Previous analysis.');
      });
    });

    describe('webview provider integration', () => {
      it('should not send message if webview provider is null', async () => {
        debugController.setWebviewProvider(null);

        const mockContext = {
          success: true,
          sessionId,
          epicenterFile: '/test/workspace/src/auth.ts',
          source: 'user-pinned' as const,
          graphData: {
            mermaid: 'graph TD\nA[Auth]',
            nodes: [],
            edges: []
          }
        };

        (mockInitialContextService.getInitialContext as jest.Mock).mockResolvedValue(mockContext);

        const result = await debugController.startSession(
          mockUserMessage,
          mockSession,
          workspaceRoot
        );

        expect(result.success).toBe(true);
        // postMessage should not be called if provider is null
        // (the controller checks for provider before calling)
      });

      it('should handle webview provider being set after initialization', async () => {
        const controllerWithoutProvider = new DebugSessionController(
          mockInitialContextService,
          mockToolRegistry,
          mockLLMProvider,
          null,
          mockDataStore,
          undefined, // imageService
          undefined, // workspaceRoot
          undefined // llmCostStorage
        );

        const mockContext = {
          success: true,
          sessionId,
          epicenterFile: '/test/workspace/src/auth.ts',
          source: 'user-pinned' as const,
          graphData: {
            mermaid: 'graph TD\nA[Auth]',
            nodes: [],
            edges: []
          }
        };

        (mockInitialContextService.getInitialContext as jest.Mock).mockResolvedValue(mockContext);

        // Set provider after initialization
        controllerWithoutProvider.setWebviewProvider(mockWebviewProvider);

        const result = await controllerWithoutProvider.startSession(
          mockUserMessage,
          mockSession,
          workspaceRoot
        );

        expect(result.success).toBe(true);
        expect(mockWebviewProvider.postMessage).toHaveBeenCalled();
      });
    });

    describe('chat history integration', () => {
      it('should load and pass chat history to PlanningAgent', async () => {
        const mockChatHistory: ChatMessage[] = [
          {
            id: 'msg-1',
            sessionId,
            projectId: 'test-project',
            type: 'user' as any,
            content: 'First question',
            role: 'user',
            metadata: {},
            isEdited: false,
            createdAt: new Date(),
            updatedAt: new Date()
          },
          {
            id: 'msg-2',
            sessionId,
            projectId: 'test-project',
            type: 'assistant' as any,
            content: 'First answer',
            role: 'assistant',
            metadata: {},
            isEdited: false,
            createdAt: new Date(),
            updatedAt: new Date()
          },
          {
            id: 'msg-3',
            sessionId,
            projectId: 'test-project',
            type: 'user' as any,
            content: 'Follow-up question',
            role: 'user',
            metadata: {},
            isEdited: false,
            createdAt: new Date(),
            updatedAt: new Date()
          }
        ];

        (mockDataStore.loadChatMessagesForSession as jest.Mock).mockReturnValue(mockChatHistory);

        const mockContext = {
          success: true,
          sessionId,
          epicenterFile: '/test/workspace/src/auth.ts',
          source: 'user-pinned' as const,
          graphData: {
            mermaid: 'graph TD\nA[Auth]',
            nodes: [],
            edges: []
          }
        };

        (mockInitialContextService.getInitialContext as jest.Mock).mockResolvedValue(mockContext);

        await debugController.startSession(
          mockUserMessage,
          mockSession,
          workspaceRoot
        );

        // Wait for background agent to start
        await new Promise(resolve => setTimeout(resolve, 100));

        // Verify chat history was loaded
        expect(mockDataStore.loadChatMessagesForSession).toHaveBeenCalledWith(sessionId);

        // Verify PlanningAgent.execute was called with chat history
        expect(mockPlanningAgentExecute).toHaveBeenCalled();
        const executeCall = mockPlanningAgentExecute.mock.calls[0];
        const chatHistoryArg = executeCall[6]; // 7th parameter (index 6)
        
        expect(chatHistoryArg).toBeDefined();
        expect(Array.isArray(chatHistoryArg)).toBe(true);
        // Should be limited to last 20 messages (in this case, all 3)
        expect(chatHistoryArg.length).toBe(3);
        expect(chatHistoryArg[0]).toEqual({ role: 'user', content: 'First question' });
        expect(chatHistoryArg[1]).toEqual({ role: 'assistant', content: 'First answer' });
        expect(chatHistoryArg[2]).toEqual({ role: 'user', content: 'Follow-up question' });
      });

      it('should limit chat history to last 20 messages', async () => {
        // Create 25 messages
        const manyMessages: ChatMessage[] = Array.from({ length: 25 }, (_, i) => ({
          id: `msg-${i}`,
          sessionId,
          projectId: 'test-project',
          type: 'user' as any,
          content: `Message ${i}`,
          role: 'user',
          metadata: {},
          isEdited: false,
          createdAt: new Date(),
          updatedAt: new Date()
        }));

        (mockDataStore.loadChatMessagesForSession as jest.Mock).mockReturnValue(manyMessages);

        const mockContext = {
          success: true,
          sessionId,
          epicenterFile: '/test/workspace/src/auth.ts',
          source: 'user-pinned' as const,
          graphData: {
            mermaid: 'graph TD\nA[Auth]',
            nodes: [],
            edges: []
          }
        };

        (mockInitialContextService.getInitialContext as jest.Mock).mockResolvedValue(mockContext);

        await debugController.startSession(
          mockUserMessage,
          mockSession,
          workspaceRoot
        );

        await new Promise(resolve => setTimeout(resolve, 100));

        // Verify PlanningAgent.execute was called with limited history
        expect(mockPlanningAgentExecute).toHaveBeenCalled();
        const executeCall = mockPlanningAgentExecute.mock.calls[0];
        const chatHistoryArg = executeCall[6];
        
        expect(chatHistoryArg.length).toBe(20); // Should be limited to 20
        // Should be the last 20 messages (indices 5-24)
        expect(chatHistoryArg[0].content).toBe('Message 5');
        expect(chatHistoryArg[19].content).toBe('Message 24');
      });

      it('should handle DataStore errors gracefully', async () => {
        (mockDataStore.loadChatMessagesForSession as jest.Mock).mockImplementation(() => {
          throw new Error('DataStore error');
        });

        const mockContext = {
          success: true,
          sessionId,
          epicenterFile: '/test/workspace/src/auth.ts',
          source: 'user-pinned' as const,
          graphData: {
            mermaid: 'graph TD\nA[Auth]',
            nodes: [],
            edges: []
          }
        };

        (mockInitialContextService.getInitialContext as jest.Mock).mockResolvedValue(mockContext);

        // Mock console.warn to verify error handling
        const consoleWarnSpy = jest.spyOn(console, 'warn').mockImplementation();

        await debugController.startSession(
          mockUserMessage,
          mockSession,
          workspaceRoot
        );

        await new Promise(resolve => setTimeout(resolve, 100));

        // Should continue without history
        expect(mockPlanningAgentExecute).toHaveBeenCalled();
        const executeCall = mockPlanningAgentExecute.mock.calls[0];
        const chatHistoryArg = executeCall[6];
        
        expect(chatHistoryArg).toEqual([]); // Should be empty array on error
        expect(consoleWarnSpy).toHaveBeenCalledWith(
          expect.stringContaining('[BackgroundAgent] Failed to load chat history'),
          expect.any(Error)
        );

        consoleWarnSpy.mockRestore();
      });

      it('should work without DataStore (backward compatibility)', async () => {
        const controllerWithoutDataStore = new DebugSessionController(
          mockInitialContextService,
          mockToolRegistry,
          mockLLMProvider,
          mockWebviewProvider,
          undefined, // dataStore
          undefined, // imageService
          undefined, // workspaceRoot
          undefined // llmCostStorage
        );

        const mockContext = {
          success: true,
          sessionId,
          epicenterFile: '/test/workspace/src/auth.ts',
          source: 'user-pinned' as const,
          graphData: {
            mermaid: 'graph TD\nA[Auth]',
            nodes: [],
            edges: []
          }
        };

        (mockInitialContextService.getInitialContext as jest.Mock).mockResolvedValue(mockContext);

        await controllerWithoutDataStore.startSession(
          mockUserMessage,
          mockSession,
          workspaceRoot
        );

        await new Promise(resolve => setTimeout(resolve, 100));

        // Should work without DataStore
        expect(mockPlanningAgentExecute).toHaveBeenCalled();
        const executeCall = mockPlanningAgentExecute.mock.calls[0];
        const chatHistoryArg = executeCall[6];
        
        expect(chatHistoryArg).toEqual([]); // Should be empty array when no DataStore
      });
    });
  });

  describe('handleGenerateConceptImage', () => {
    let mockImageService: any;
    const workspaceRoot = '/test/workspace';
    const sessionId = 'test-session-123';

    beforeEach(() => {
      jest.clearAllMocks();

      // Create mock image service
      mockImageService = {
        generateAndSave: jest.fn()
      };

      // Reset mocks
      mockLLMCostStorage.saveRecord.mockResolvedValue(undefined);
      mockDataStore.loadSession.mockReturnValue({
        id: sessionId,
        metadata: { model: 'gemini-3-pro-beta' },
        totalCost: 0
      } as any);
      mockDataStore.updateSession.mockImplementation((id: string, updates: any) => ({
        id,
        ...updates
      } as any));

      // Recreate controller with image service
      debugController = new DebugSessionController(
        mockInitialContextService,
        mockToolRegistry,
        mockLLMProvider,
        mockWebviewProvider,
        mockDataStore,
        mockImageService,
        workspaceRoot,
        mockLLMCostStorage
      );

      // Mock webview for URI conversion
      (mockWebviewProvider as any)._webviewView = {
        webview: {
          asWebviewUri: jest.fn((uri: any) => {
            if (!uri || !uri.fsPath) {
              throw new Error('Invalid URI');
            }
            return {
              toString: () => `vscode-webview://test/${uri.fsPath}`
            };
          })
        }
      };
    });

    it('should generate concept image successfully', async () => {
      const rootCause = 'The authentication service is failing because the database connection is not established.';
      
      // Store root cause in session map
      (debugController as any).sessionRootCauseMap.set(sessionId, rootCause);

      // Mock prompt loading
      jest.spyOn(debugController as any, 'loadImagePrompt').mockReturnValue(
        'You are an expert Technical Illustrator.\n\nRoot Cause Analysis:\n\n"{{ROOT_CAUSE}}"\n\n**Task:** Write a detailed prompt for an Image Generation AI.'
      );

      // Mock LLM response for visual description
      mockLLMProvider.chat.mockResolvedValue({
        type: 'success' as any,
        payload: {
          content: 'A minimalist diagram showing a backend server (red) connected to a database (green) with a broken connection icon.'
        }
      });

      // Mock image generation
      mockImageService.generateAndSave.mockResolvedValue('debug-output/active-session/concept-test-session-123.png');

      await debugController.handleGenerateConceptImage(sessionId);

      // Verify LLM was called to generate visual description
      expect(mockLLMProvider.chat).toHaveBeenCalledWith(
        expect.objectContaining({
          messages: expect.arrayContaining([
            expect.objectContaining({
              role: 'user',
              content: expect.stringContaining(rootCause)
            })
          ]),
          maxTokens: 10000
        })
      );

      // Verify image service was called with userSelectedModelId
      expect(mockImageService.generateAndSave).toHaveBeenCalledWith(
        sessionId,
        'A minimalist diagram showing a backend server (red) connected to a database (green) with a broken connection icon.',
        'gemini-3-pro-beta'
      );

      // Verify cost was saved to LLMCostStorage (always saved for tracking)
      expect(mockLLMCostStorage.saveRecord).toHaveBeenCalledWith(
        expect.objectContaining({
          cost: 0.13,
          model: 'gemini-3-pro-image-preview',
          sessionId
        })
      );

      // Verify session cost was updated and the UI notified
      expect(mockDataStore.updateSession).toHaveBeenCalledWith(
        sessionId,
        expect.objectContaining({ totalCost: 0.13 })
      );
      expect(mockWebviewProvider.postMessage).toHaveBeenCalledWith(
        expect.objectContaining({ type: 'costUpdate' })
      );

      // Verify webview message was sent with correct sessionId
      expect(mockWebviewProvider.postMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'conceptImageReady',
          payload: {
            sessionId, // Verify sessionId matches the one passed to the function
            imageUrl: expect.stringContaining('vscode-webview://test')
          }
        })
      );

    });

    it('should correctly propagate sessionId in conceptImageReady response', async () => {
      const testSessionId = 'different-session-id-456';
      const rootCause = 'Test root cause for session ID propagation';
      
      (debugController as any).sessionRootCauseMap.set(testSessionId, rootCause);

      jest.spyOn(debugController as any, 'loadImagePrompt').mockReturnValue('Template: {{ROOT_CAUSE}}');
      mockLLMProvider.chat.mockResolvedValue({
        type: 'success' as any,
        payload: { content: 'Visual description' }
      });
      mockImageService.generateAndSave.mockResolvedValue('debug-output/active-session/concept-different-session-id-456.png');
      
      // Update mock to return session with different ID
      mockDataStore.loadSession.mockReturnValue({
        id: testSessionId,
        metadata: { model: 'gemini-3-pro-beta' },
        totalCost: 0
      } as any);

      await debugController.handleGenerateConceptImage(testSessionId);

      // Verify the response contains the correct sessionId that was passed in
      const postMessageCalls = mockWebviewProvider.postMessage.mock.calls;
      const conceptImageReadyCall = postMessageCalls.find((call: any[]) => 
        call[0]?.type === 'conceptImageReady'
      );

      expect(conceptImageReadyCall).toBeDefined();
      expect(conceptImageReadyCall[0].payload.sessionId).toBe(testSessionId);
      expect(conceptImageReadyCall[0].payload.sessionId).not.toBe(sessionId); // Should not be the default test sessionId
    });

    it('should add cost to session totalCost', async () => {
      mockDataStore.loadSession.mockReturnValue({
        id: sessionId,
        metadata: { model: 'gemini-3-pro-preview' },
        totalCost: 0.50
      } as any);

      const rootCause = 'The authentication service is failing.';
      (debugController as any).sessionRootCauseMap.set(sessionId, rootCause);

      jest.spyOn(debugController as any, 'loadImagePrompt').mockReturnValue(
        'Template: {{ROOT_CAUSE}}'
      );

      mockLLMProvider.chat.mockResolvedValue({
        type: 'success' as any,
        payload: {
          content: 'Visual description for non-beta model'
        }
      });

      mockImageService.generateAndSave.mockResolvedValue('debug-output/active-session/concept-test-session-123.png');

      await debugController.handleGenerateConceptImage(sessionId);

      // Verify cost was saved to LLMCostStorage
      expect(mockLLMCostStorage.saveRecord).toHaveBeenCalledWith(
        expect.objectContaining({
          cost: 0.13,
          model: 'gemini-3-pro-image-preview',
          sessionId
        })
      );

      // Verify session was updated
      expect(mockDataStore.updateSession).toHaveBeenCalledWith(
        sessionId,
        expect.objectContaining({
          totalCost: 0.63 // 0.50 + 0.13
        })
      );

      // Verify cost update message was sent
      expect(mockWebviewProvider.postMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'costUpdate',
          payload: {
            sessionId,
            addedCost: 0.13
          }
        })
      );
    });

    it('should use root cause from session map if available', async () => {
      const storedRootCause = 'Stored root cause from session';
      (debugController as any).sessionRootCauseMap.set(sessionId, storedRootCause);

      jest.spyOn(debugController as any, 'loadImagePrompt').mockReturnValue('Template: {{ROOT_CAUSE}}');
      mockLLMProvider.chat.mockResolvedValue({
        type: 'success' as any,
        payload: { content: 'Visual description' }
      });
      mockImageService.generateAndSave.mockResolvedValue('debug-output/active-session/concept-test-session-123.png');

      await debugController.handleGenerateConceptImage(sessionId);

      expect(mockLLMProvider.chat).toHaveBeenCalledWith(
        expect.objectContaining({
          messages: expect.arrayContaining([
            expect.objectContaining({
              content: expect.stringContaining(storedRootCause)
            })
          ])
        })
      );
      
      // Verify image service was called with userSelectedModelId
      expect(mockImageService.generateAndSave).toHaveBeenCalledWith(
        sessionId,
        'Visual description',
        'gemini-3-pro-beta'
      );
    });

    it('should use passed root cause text if provided', async () => {
      const passedRootCause = 'Passed root cause text';
      
      jest.spyOn(debugController as any, 'loadImagePrompt').mockReturnValue('Template: {{ROOT_CAUSE}}');
      mockLLMProvider.chat.mockResolvedValue({
        type: 'success' as any,
        payload: { content: 'Visual description' }
      });
      mockImageService.generateAndSave.mockResolvedValue('debug-output/active-session/concept-test-session-123.png');

      await debugController.handleGenerateConceptImage(sessionId, 'test-msg-id', passedRootCause);

      expect(mockLLMProvider.chat).toHaveBeenCalledWith(
        expect.objectContaining({
          messages: expect.arrayContaining([
            expect.objectContaining({
              content: expect.stringContaining(passedRootCause)
            })
          ])
        })
      );
      
      // Verify image service was called with userSelectedModelId
      expect(mockImageService.generateAndSave).toHaveBeenCalledWith(
        sessionId,
        'Visual description',
        'gemini-3-pro-beta'
      );
    });

    it('should reject whitespace-only root cause text and use fallback', async () => {
      const storedRootCause = 'Stored root cause from session map';
      (debugController as any).sessionRootCauseMap.set(sessionId, storedRootCause);
      
      // Pass whitespace-only text
      const whitespaceRootCause = '   \n\t  ';
      
      jest.spyOn(debugController as any, 'loadImagePrompt').mockReturnValue('Template: {{ROOT_CAUSE}}');
      mockLLMProvider.chat.mockResolvedValue({
        type: 'success' as any,
        payload: { content: 'Visual description' }
      });
      mockImageService.generateAndSave.mockResolvedValue('debug-output/active-session/concept-test-session-123.png');

      await debugController.handleGenerateConceptImage(sessionId, 'test-msg-id', whitespaceRootCause);

      // Should use stored root cause, not the whitespace text
      expect(mockLLMProvider.chat).toHaveBeenCalledWith(
        expect.objectContaining({
          messages: expect.arrayContaining([
            expect.objectContaining({
              content: expect.stringContaining(storedRootCause)
            })
          ])
        })
      );
      
      // Should not contain the whitespace text
      const chatCall = mockLLMProvider.chat.mock.calls[0][0];
      const messageContent = chatCall.messages[0].content;
      expect(messageContent).not.toContain(whitespaceRootCause);
      expect(messageContent).toContain(storedRootCause);
    });

    it('should fallback to DataStore if root cause not in map', async () => {
      const dataStoreRootCause = 'Root cause from DataStore';
      const assistantMessage = {
        id: 'msg-1',
        role: 'assistant',
        content: dataStoreRootCause
      };

      mockDataStore.loadChatMessagesForSession.mockReturnValue([
        { id: 'msg-0', role: 'user', content: 'User message' },
        assistantMessage
      ] as any);

      jest.spyOn(debugController as any, 'loadImagePrompt').mockReturnValue('Template: {{ROOT_CAUSE}}');
      mockLLMProvider.chat.mockResolvedValue({
        type: 'success' as any,
        payload: { content: 'Visual description' }
      });
      mockImageService.generateAndSave.mockResolvedValue('debug-output/active-session/concept-test-session-123.png');

      await debugController.handleGenerateConceptImage(sessionId);

      expect(mockDataStore.loadChatMessagesForSession).toHaveBeenCalledWith(sessionId);
      expect(mockLLMProvider.chat).toHaveBeenCalledWith(
        expect.objectContaining({
          messages: expect.arrayContaining([
            expect.objectContaining({
              content: expect.stringContaining(dataStoreRootCause)
            })
          ])
        })
      );
    });

    it('should use fallback message if no root cause found', async () => {
      jest.spyOn(debugController as any, 'loadImagePrompt').mockReturnValue('Template: {{ROOT_CAUSE}}');
      mockLLMProvider.chat.mockResolvedValue({
        type: 'success' as any,
        payload: { content: 'Visual description' }
      });
      mockImageService.generateAndSave.mockResolvedValue('debug-output/active-session/concept-test-session-123.png');

      await debugController.handleGenerateConceptImage(sessionId);

      expect(mockLLMProvider.chat).toHaveBeenCalledWith(
        expect.objectContaining({
          messages: expect.arrayContaining([
            expect.objectContaining({
              content: expect.stringContaining('Unknown error - root cause analysis not available')
            })
          ])
        })
      );
    });

    it('should handle LLM failure gracefully', async () => {
      (debugController as any).sessionRootCauseMap.set(sessionId, 'Test root cause');
      jest.spyOn(debugController as any, 'loadImagePrompt').mockReturnValue('Template: {{ROOT_CAUSE}}');
      
      mockLLMProvider.chat.mockResolvedValue({
        type: 'error' as any,
        error: 'LLM request failed'
      });

      await debugController.handleGenerateConceptImage(sessionId);

      expect(mockWebviewProvider.postMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'agentError',
          payload: expect.objectContaining({
            sessionId,
            error: expect.stringContaining('Failed to generate image')
          })
        })
      );
      expect(mockImageService.generateAndSave).not.toHaveBeenCalled();
    });

    it('should handle image generation failure gracefully', async () => {
      (debugController as any).sessionRootCauseMap.set(sessionId, 'Test root cause');
      jest.spyOn(debugController as any, 'loadImagePrompt').mockReturnValue('Template: {{ROOT_CAUSE}}');
      
      mockLLMProvider.chat.mockResolvedValue({
        type: 'success' as any,
        payload: { content: 'Visual description' }
      });
      mockImageService.generateAndSave.mockResolvedValue(null);

      await debugController.handleGenerateConceptImage(sessionId);

      expect(mockWebviewProvider.postMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'agentError',
          payload: expect.objectContaining({
            sessionId,
            error: expect.stringContaining('Failed to generate or save image')
          })
        })
      );
    });

    it('should handle missing image service gracefully', async () => {
      const controllerWithoutImageService = new DebugSessionController(
        mockInitialContextService,
        mockToolRegistry,
        mockLLMProvider,
        mockWebviewProvider,
        mockDataStore,
        undefined, // imageService
        undefined, // workspaceRoot
        undefined // llmCostStorage
      );

      // Store root cause so LLM call can proceed
      (controllerWithoutImageService as any).sessionRootCauseMap.set(sessionId, 'Test root cause');
      jest.spyOn(controllerWithoutImageService as any, 'loadImagePrompt').mockReturnValue('Template: {{ROOT_CAUSE}}');
      
      // Mock LLM response (it will be called before the imageService check)
      mockLLMProvider.chat.mockResolvedValue({
        type: 'success' as any,
        payload: { content: 'Visual description' }
      });

      await controllerWithoutImageService.handleGenerateConceptImage(sessionId);

      expect(mockWebviewProvider.postMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'agentError',
          payload: expect.objectContaining({
            sessionId,
            error: expect.stringContaining('Image generation service not available')
          })
        })
      );
    });

    it('should handle missing webview gracefully', async () => {
      (debugController as any).sessionRootCauseMap.set(sessionId, 'Test root cause');
      jest.spyOn(debugController as any, 'loadImagePrompt').mockReturnValue('Template: {{ROOT_CAUSE}}');
      
      mockLLMProvider.chat.mockResolvedValue({
        type: 'success' as any,
        payload: { content: 'Visual description' }
      });
      mockImageService.generateAndSave.mockResolvedValue('debug-output/active-session/concept-test-session-123.png');

      // Remove webview
      (mockWebviewProvider as any)._webviewView = undefined;

      await debugController.handleGenerateConceptImage(sessionId);

      expect(mockWebviewProvider.postMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'agentError',
          payload: expect.objectContaining({
            sessionId,
            error: expect.stringContaining('Webview not available')
          })
        })
      );
    });

    it('should track image generation cost without any beta flag', async () => {
      const nonBetaSession = {
        id: sessionId,
        metadata: { model: 'gemini-3-pro-preview' }, // Non-beta model
        totalCost: 0
      };
      mockDataStore.loadSession.mockReturnValue(nonBetaSession as any);

      (debugController as any).sessionRootCauseMap.set(sessionId, 'Test root cause');
      jest.spyOn(debugController as any, 'loadImagePrompt').mockReturnValue('Template: {{ROOT_CAUSE}}');
      
      mockLLMProvider.chat.mockResolvedValue({
        type: 'success' as any,
        payload: { content: 'Visual description' }
      });
      mockImageService.generateAndSave.mockResolvedValue('debug-output/active-session/concept-test-session-123.png');

      await debugController.handleGenerateConceptImage(sessionId);

      expect(mockLLMCostStorage.saveRecord).toHaveBeenCalledWith(
        expect.objectContaining({ cost: 0.13 })
      );
      expect(mockLLMCostStorage.saveRecord.mock.calls[0][0]).not.toHaveProperty('isBetaUserActive');
    });

    it('should proceed without cost tracking if user model is not available', async () => {
      mockDataStore.loadSession.mockReturnValue(undefined); // No session found
      
      (debugController as any).sessionRootCauseMap.set(sessionId, 'Test root cause');
      jest.spyOn(debugController as any, 'loadImagePrompt').mockReturnValue('Template: {{ROOT_CAUSE}}');
      
      mockLLMProvider.chat.mockResolvedValue({
        type: 'success' as any,
        payload: { content: 'Visual description' }
      });
      mockImageService.generateAndSave.mockResolvedValue('debug-output/active-session/concept-test-session-123.png');

      await debugController.handleGenerateConceptImage(sessionId);

      // Verify image generation still proceeded
      expect(mockImageService.generateAndSave).toHaveBeenCalled();
      
      // Verify cost was NOT saved (no user model to determine beta status)
      expect(mockLLMCostStorage.saveRecord).not.toHaveBeenCalled();
    });

    it('should include sessionId in image description generation metadata', async () => {
      (debugController as any).sessionRootCauseMap.set(sessionId, 'Test root cause');
      jest.spyOn(debugController as any, 'loadImagePrompt').mockReturnValue('Template: {{ROOT_CAUSE}}');
      
      mockLLMProvider.chat.mockResolvedValue({
        type: 'success' as any,
        payload: { content: 'Visual description' }
      });
      mockImageService.generateAndSave.mockResolvedValue('debug-output/active-session/concept-test-session-123.png');

      await debugController.handleGenerateConceptImage(sessionId);

      // Verify sessionId is included in metadata for cost observer tracking
      expect(mockLLMProvider.chat).toHaveBeenCalledWith(
        expect.objectContaining({
          metadata: expect.objectContaining({
            sessionId: sessionId
          })
        })
      );
    });
  });

  describe('extractSymbolsFromFile', () => {
    it('should extract exported functions', () => {
      const fileContent = `
export function login() {
  return true;
}

export const logout = () => {
  return false;
}

export async function authenticate() {
  return true;
}
`;
      const symbols = (debugController as any).extractSymbolsFromFile(fileContent, 'test.ts');
      
      expect(symbols.length).toBeGreaterThanOrEqual(3);
      expect(symbols.find(s => s.name === 'login' && s.type === 'function')).toBeDefined();
      expect(symbols.find(s => s.name === 'logout' && s.type === 'function')).toBeDefined();
      expect(symbols.find(s => s.name === 'authenticate' && s.type === 'function')).toBeDefined();
    });

    it('should extract classes', () => {
      const fileContent = `
export class AuthService {
  // ...
}

class UserService {
  // ...
}
`;
      const symbols = (debugController as any).extractSymbolsFromFile(fileContent, 'test.ts');
      
      const authService = symbols.find(s => s.name === 'AuthService' && s.type === 'class');
      expect(authService).toBeDefined();
      expect(authService?.exported).toBe(true);
      
      const userService = symbols.find(s => s.name === 'UserService' && s.type === 'class');
      expect(userService).toBeDefined();
      expect(userService?.exported).toBe(false);
    });

    it('should extract methods with various modifiers', () => {
      const fileContent = `
class AuthService {
  public login() {}
  private logout() {}
  async execute() {}
  static async process() {}
  protected validate() {}
}
`;
      const symbols = (debugController as any).extractSymbolsFromFile(fileContent, 'test.ts');
      
      expect(symbols.find(s => s.name === 'login' && s.type === 'method')).toBeDefined();
      expect(symbols.find(s => s.name === 'logout' && s.type === 'method')).toBeDefined();
      expect(symbols.find(s => s.name === 'execute' && s.type === 'method')).toBeDefined();
      expect(symbols.find(s => s.name === 'process' && s.type === 'method')).toBeDefined();
      expect(symbols.find(s => s.name === 'validate' && s.type === 'method')).toBeDefined();
    });

    it('should extract arrow function methods', () => {
      const fileContent = `
class AuthService {
  execute = async () => {
    return true;
  }
  
  process = () => {
    return false;
  }
  
  handle: () => void = () => {};
}
`;
      const symbols = (debugController as any).extractSymbolsFromFile(fileContent, 'test.ts');
      
      expect(symbols.find(s => s.name === 'execute' && s.type === 'method')).toBeDefined();
      expect(symbols.find(s => s.name === 'process' && s.type === 'method')).toBeDefined();
      expect(symbols.find(s => s.name === 'handle' && s.type === 'method')).toBeDefined();
    });

    it('should handle empty file', () => {
      const symbols = (debugController as any).extractSymbolsFromFile('', 'test.ts');
      expect(symbols).toEqual([]);
    });

    it('should not duplicate symbols', () => {
      const fileContent = `
export function login() {}
export function login() {}
`;
      const symbols = (debugController as any).extractSymbolsFromFile(fileContent, 'test.ts');
      const loginSymbols = symbols.filter(s => s.name === 'login' && s.type === 'function');
      expect(loginSymbols.length).toBe(1);
    });

    it('should extract default exports', () => {
      const fileContent = `
export default function defaultFunction() {}
export default class DefaultClass {}
export default const defaultConst = () => {};
`;
      const symbols = (debugController as any).extractSymbolsFromFile(fileContent, 'test.ts');
      
      expect(symbols.find(s => s.name === 'defaultFunction' && s.type === 'function' && s.exported)).toBeDefined();
      expect(symbols.find(s => s.name === 'DefaultClass' && s.type === 'class' && s.exported)).toBeDefined();
      expect(symbols.find(s => s.name === 'defaultConst' && s.type === 'function' && s.exported)).toBeDefined();
    });

    it('should extract named exports', () => {
      const fileContent = `
export { namedFunction, namedClass };
function namedFunction() {}
class namedClass {}
`;
      const symbols = (debugController as any).extractSymbolsFromFile(fileContent, 'test.ts');
      
      expect(symbols.find(s => s.name === 'namedFunction' && s.type === 'function' && s.exported)).toBeDefined();
      // namedClass is found by the class regex but the named export regex only captures the first identifier
      expect(symbols.find(s => s.name === 'namedClass' && s.type === 'class')).toBeDefined();
    });

    it('should extract getter and setter methods', () => {
      const fileContent = `
class MyClass {
  get property() { return this._prop; }
  set property(value) { this._prop = value; }
  get computed() { return 42; }
}
`;
      const symbols = (debugController as any).extractSymbolsFromFile(fileContent, 'test.ts');
      
      expect(symbols.find(s => s.name === 'property' && s.type === 'method')).toBeDefined();
      expect(symbols.find(s => s.name === 'computed' && s.type === 'method')).toBeDefined();
    });

    it('should extract non-exported functions', () => {
      const fileContent = `
function internalFunction() {}
const internalConst = () => {};
let internalLet = () => {};
var internalVar = () => {};
`;
      const symbols = (debugController as any).extractSymbolsFromFile(fileContent, 'test.ts');
      
      expect(symbols.find(s => s.name === 'internalFunction' && s.type === 'function' && !s.exported)).toBeDefined();
      expect(symbols.find(s => s.name === 'internalConst' && s.type === 'function' && !s.exported)).toBeDefined();
      expect(symbols.find(s => s.name === 'internalLet' && s.type === 'function' && !s.exported)).toBeDefined();
      expect(symbols.find(s => s.name === 'internalVar' && s.type === 'function' && !s.exported)).toBeDefined();
    });
  });

  describe('refineEpicenterSymbol', () => {
    const mockFinalMessage = 'The bug is in the login function. It fails to validate credentials properly.';

    beforeEach(() => {
      jest.clearAllMocks();
    });

    it('should return original epicenter if already symbol-level', async () => {
      const result = await (debugController as any).refineEpicenterSymbol(
        'src/auth.ts::login',
        [],
        mockFinalMessage,
        'gpt-4o-mini',
        mockLogger
      );
      
      expect(result).toBe('src/auth.ts::login');
    });

    it('should return original epicenter if no files analyzed', async () => {
      const result = await (debugController as any).refineEpicenterSymbol(
        'src/auth.ts',
        [],
        mockFinalMessage,
        'gpt-4o-mini',
        mockLogger
      );
      
      expect(result).toBe('src/auth.ts');
    });

    it('should return original epicenter if static-analysis tool not available', async () => {
      (mockToolRegistry.getTool as jest.Mock).mockReturnValue(null);
      
      const result = await (debugController as any).refineEpicenterSymbol(
        'src/auth.ts',
        ['src/auth.ts'],
        mockFinalMessage,
        'gpt-4o-mini',
        mockLogger
      );
      
      expect(result).toBe('src/auth.ts');
    });

    it('should refine epicenter using LLM when symbols are found', async () => {
      const mockAnalysisTool = {
        execute: jest.fn().mockResolvedValue({
          success: true,
          evidence: [{
            text: `
export class AuthService {
  async login() {}
  logout() {}
}
export function authenticate() {}
`
          }]
        })
      };
      (mockToolRegistry.getTool as jest.Mock).mockImplementation((name: string) => {
        if (name === 'static-analysis') {
          return mockAnalysisTool;
        }
        return null;
      });

      // Mock LLM response
      mockLLMProvider.chat.mockResolvedValue({
        type: 'success' as any,
        payload: {
          content: 'src/auth.ts::login'
        }
      });

      const result = await (debugController as any).refineEpicenterSymbol(
        'src/auth.ts',
        ['src/auth.ts'],
        mockFinalMessage,
        'gpt-4o-mini',
        mockLogger
      );

      expect(mockAnalysisTool.execute).toHaveBeenCalledWith({
        filePath: 'src/auth.ts',
        mode: 'source'
      });
      expect(mockLLMProvider.chat).toHaveBeenCalledWith(
        expect.objectContaining({
          model: 'gpt-4o-mini'
        })
      );
      expect(mockLogger.logEpicenterRefinement).toHaveBeenCalled();
      expect(result).toBe('src/auth.ts::login');
    });

    it('should handle multiple files and pick best symbol', async () => {
      const mockAnalysisTool = {
        execute: jest.fn()
          .mockResolvedValueOnce({
            success: true,
            evidence: [{
              text: 'export function login() {}'
            }]
          })
          .mockResolvedValueOnce({
            success: true,
            evidence: [{
              text: 'export class AuthService { validate() {} }'
            }]
          })
      };
      (mockToolRegistry.getTool as jest.Mock).mockImplementation((name: string) => {
        if (name === 'static-analysis') {
          return mockAnalysisTool;
        }
        return null;
      });

      mockLLMProvider.chat.mockResolvedValue({
        type: 'success' as any,
        payload: {
          content: 'src/auth.ts::login'
        }
      });

      const result = await (debugController as any).refineEpicenterSymbol(
        'src/auth.ts',
        ['src/auth.ts', 'src/services.ts'],
        mockFinalMessage,
        'gpt-4o-mini',
        mockLogger
      );

      expect(mockAnalysisTool.execute).toHaveBeenCalledTimes(2);
      expect(result).toBe('src/auth.ts::login');
    });

    it('should limit to 10 files', async () => {
      const mockAnalysisTool = {
        execute: jest.fn().mockResolvedValue({
          success: true,
          evidence: [{ text: 'export function test() {}' }]
        })
      };
      (mockToolRegistry.getTool as jest.Mock).mockImplementation((name: string) => {
        if (name === 'static-analysis') {
          return mockAnalysisTool;
        }
        return null;
      });

      const manyFiles = Array.from({ length: 15 }, (_, i) => `src/file${i}.ts`);
      
      mockLLMProvider.chat.mockResolvedValue({
        type: 'success' as any,
        payload: {
          content: 'src/file0.ts::test'
        }
      });

      await (debugController as any).refineEpicenterSymbol(
        'src/file0.ts',
        manyFiles,
        mockFinalMessage,
        'gpt-4o-mini',
        mockLogger
      );

      // Should only analyze first 10 files
      expect(mockAnalysisTool.execute).toHaveBeenCalledTimes(10);
    });

    it('should fallback to file path if LLM returns FILE', async () => {
      const mockAnalysisTool = {
        execute: jest.fn().mockResolvedValue({
          success: true,
          evidence: [{ text: 'export function test() {}' }]
        })
      };
      (mockToolRegistry.getTool as jest.Mock).mockImplementation((name: string) => {
        if (name === 'static-analysis') {
          return mockAnalysisTool;
        }
        return null;
      });

      mockLLMProvider.chat.mockResolvedValue({
        type: 'success' as any,
        payload: {
          content: 'FILE'
        }
      });

      const result = await (debugController as any).refineEpicenterSymbol(
        'src/auth.ts',
        ['src/auth.ts'],
        mockFinalMessage,
        'gpt-4o-mini',
        mockLogger
      );

      expect(result).toBe('src/auth.ts');
      expect(mockLogger.logEpicenterRefinement).toHaveBeenCalled();
    });

    it('should fallback to file path if LLM fails', async () => {
      const mockAnalysisTool = {
        execute: jest.fn().mockResolvedValue({
          success: true,
          evidence: [{ text: 'export function test() {}' }]
        })
      };
      (mockToolRegistry.getTool as jest.Mock).mockImplementation((name: string) => {
        if (name === 'static-analysis') {
          return mockAnalysisTool;
        }
        return null;
      });

      mockLLMProvider.chat.mockResolvedValue({
        type: 'error' as any,
        error: 'LLM failed'
      });

      const result = await (debugController as any).refineEpicenterSymbol(
        'src/auth.ts',
        ['src/auth.ts'],
        mockFinalMessage,
        'gpt-4o-mini',
        mockLogger
      );

      expect(result).toBe('src/auth.ts');
      expect(mockLogger.logEpicenterRefinement).toHaveBeenCalled();
    });

    it('should handle file analysis errors gracefully', async () => {
      const mockAnalysisTool = {
        execute: jest.fn()
          .mockRejectedValueOnce(new Error('File not found'))
          .mockResolvedValueOnce({
            success: true,
            evidence: [{ text: 'export function test() {}' }]
          })
      };
      (mockToolRegistry.getTool as jest.Mock).mockImplementation((name: string) => {
        if (name === 'static-analysis') {
          return mockAnalysisTool;
        }
        return null;
      });

      mockLLMProvider.chat.mockResolvedValue({
        type: 'success' as any,
        payload: {
          content: 'src/file2.ts::test'
        }
      });

      const consoleWarnSpy = jest.spyOn(console, 'warn').mockImplementation();

      const result = await (debugController as any).refineEpicenterSymbol(
        'src/file1.ts',
        ['src/file1.ts', 'src/file2.ts'],
        mockFinalMessage,
        'gpt-4o-mini',
        mockLogger
      );

      // Should continue with other files
      expect(mockAnalysisTool.execute).toHaveBeenCalledTimes(2);
      expect(result).toBe('src/file2.ts::test');
      
      consoleWarnSpy.mockRestore();
    });

    it('should use user-selected model when provided', async () => {
      const mockAnalysisTool = {
        execute: jest.fn().mockResolvedValue({
          success: true,
          evidence: [{ text: 'export function test() {}' }]
        })
      };
      (mockToolRegistry.getTool as jest.Mock).mockImplementation((name: string) => {
        if (name === 'static-analysis') {
          return mockAnalysisTool;
        }
        return null;
      });

      mockLLMProvider.chat.mockResolvedValue({
        type: 'success' as any,
        payload: {
          content: 'src/auth.ts::test'
        }
      });

      await (debugController as any).refineEpicenterSymbol(
        'src/auth.ts',
        ['src/auth.ts'],
        mockFinalMessage,
        'gpt-4-turbo', // User-selected model
        mockLogger
      );

      expect(mockLLMProvider.chat).toHaveBeenCalledWith(
        expect.objectContaining({
          model: 'gpt-4-turbo'
        })
      );
    });
  });

  // Final graph generation with refinement tests removed - feature is disabled (commented out in source)

  describe('Empty Message Handling', () => {
    it('should send error message to webview when PlanningAgent returns empty message', async () => {
      const mockSession: Session = {
        id: 'test-session',
        title: 'Test',
        status: 'active' as any,
        messageCount: 0,
        totalTokens: 0,
        totalCost: 0,
        lastMessageAt: new Date(),
        tags: [],
        metadata: { projectId: 'test-project', model: 'gpt-4o', mode: 'debugging' },
        codeContextIds: [],
        previous_session_intent: 'pure_discussion' as any,
        pinnedFilePaths: [],
        createdAt: new Date(),
        updatedAt: new Date()
      };

      const mockUserMessage: ChatMessage = {
        id: 'msg-1',
        sessionId: 'test-session',
        projectId: 'test-project',
        type: 'user' as any,
        role: 'user',
        content: 'Test query',
        metadata: {},
        isEdited: false,
        createdAt: new Date(),
        updatedAt: new Date()
      };

      const workspaceRoot = '/test/workspace';

      // Mock InitialContextService to return success
      (mockInitialContextService.getInitialContext as jest.Mock).mockResolvedValue({
        success: true,
        epicenterFile: '/test/workspace/src/auth.ts',
        source: 'log',
        graphData: {
          mermaid: 'graph TD\nA[Test]',
          nodes: []
        },
        cost: 0
      });

      // Mock PlanningAgent to return empty message
      mockPlanningAgentExecute = jest.fn().mockResolvedValue({
        message: '', // Empty message
        finalEpicenter: '/test/workspace/src/auth.ts',
        visualizationData: { visualization: 'graph TD\nA[Test]' },
        metadata: {
          stepsTaken: 1,
          filesAnalyzed: [],
          cost: 0
        }
      });

      const postMessageSpy = jest.fn();
      mockWebviewProvider.postMessage = postMessageSpy;

      debugController.setWebviewProvider(mockWebviewProvider);

      await debugController.startSession(mockUserMessage, mockSession, workspaceRoot);

      // Wait for background agent to complete
      await new Promise(resolve => setTimeout(resolve, 200));

      // Verify error message was sent to webview
      expect(postMessageSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'debugSessionFinished',
          payload: expect.objectContaining({
            content: expect.stringContaining('I apologize')
          })
        })
      );
    });

    it('should send error message when PlanningAgent returns whitespace-only message', async () => {
      const mockSession: Session = {
        id: 'test-session',
        title: 'Test',
        status: 'active' as any,
        messageCount: 0,
        totalTokens: 0,
        totalCost: 0,
        lastMessageAt: new Date(),
        tags: [],
        metadata: { projectId: 'test-project', model: 'gpt-4o', mode: 'debugging' },
        codeContextIds: [],
        previous_session_intent: 'pure_discussion' as any,
        pinnedFilePaths: [],
        createdAt: new Date(),
        updatedAt: new Date()
      };

      const mockUserMessage: ChatMessage = {
        id: 'msg-1',
        sessionId: 'test-session',
        projectId: 'test-project',
        type: 'user' as any,
        role: 'user',
        content: 'Test query',
        metadata: {},
        isEdited: false,
        createdAt: new Date(),
        updatedAt: new Date()
      };

      const workspaceRoot = '/test/workspace';

      // Mock InitialContextService to return success
      (mockInitialContextService.getInitialContext as jest.Mock).mockResolvedValue({
        success: true,
        epicenterFile: '/test/workspace/src/auth.ts',
        source: 'log',
        graphData: {
          mermaid: 'graph TD\nA[Test]',
          nodes: []
        },
        cost: 0
      });

      // Mock PlanningAgent to return whitespace-only message
      mockPlanningAgentExecute = jest.fn().mockResolvedValue({
        message: '   \n\t  ', // Whitespace only
        finalEpicenter: '/test/workspace/src/auth.ts',
        visualizationData: { visualization: 'graph TD\nA[Test]' },
        metadata: {
          stepsTaken: 1,
          filesAnalyzed: [],
          cost: 0
        }
      });

      const postMessageSpy = jest.fn();
      mockWebviewProvider.postMessage = postMessageSpy;

      debugController.setWebviewProvider(mockWebviewProvider);

      await debugController.startSession(mockUserMessage, mockSession, workspaceRoot);

      // Wait for background agent to complete
      await new Promise(resolve => setTimeout(resolve, 200));

      // Verify error message was sent to webview (whitespace should be treated as empty)
      expect(postMessageSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'debugSessionFinished',
          payload: expect.objectContaining({
            content: expect.stringContaining('I apologize')
          })
        })
      );
    });
  });

  describe('session startup errors', () => {
    const workspaceRoot = '/test/workspace';

    const mockSession: Session = {
      id: 'test-session-startup',
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
      pinnedFilePaths: ['/test/workspace/src/auth.ts'],
      createdAt: new Date(),
      updatedAt: new Date()
    };

    const mockUserMessage: ChatMessage = {
      id: 'msg-1',
      sessionId: 'test-session-startup',
      projectId: 'test-project',
      type: 'user' as any,
      role: 'user',
      content: 'Test query',
      metadata: { log: 'Error: something failed' },
      isEdited: false,
      createdAt: new Date(),
      updatedAt: new Date()
    };

    it('should return a system error result when InitialContextService throws', async () => {
      (mockInitialContextService.getInitialContext as jest.Mock).mockRejectedValue(
        new Error('LLM API key not configured')
      );

      const result = await debugController.startSession(mockUserMessage, mockSession, workspaceRoot);

      expect(result.success).toBe(false);
      expect(result.message).toContain('System Error');
    });
  });
});
