/**
 * Tests for SamuraiAgentPanelWebviewViewProvider file search functionality
 */

import * as vscode from 'vscode';
import * as path from 'path';
import { SamuraiAgentPanelWebviewViewProvider } from '../SamuraiAgentPanelWebviewViewProvider';

// Mock vscode module
jest.mock('vscode', () => {
  const mockFindFiles = jest.fn();
  const mockTextDocuments: vscode.TextDocument[] = [];
  
  return {
    window: {
      activeTextEditor: null as vscode.TextEditor | null,
    },
    workspace: {
      workspaceFolders: [
        {
          uri: {
            fsPath: '/workspace',
          },
        },
      ],
      findFiles: mockFindFiles,
      textDocuments: mockTextDocuments,
    },
    Uri: {
      file: (fsPath: string) => ({
        fsPath,
        scheme: 'file',
        toString: () => `file://${fsPath}`,
      }),
    },
    WebviewView: class WebviewView {
      webview = {
        postMessage: jest.fn(),
        onDidReceiveMessage: jest.fn(),
      };
    },
    __mockFindFiles: mockFindFiles,
    __mockTextDocuments: mockTextDocuments,
    __mockActiveTextEditor: null as vscode.TextEditor | null,
  };
});

describe('SamuraiAgentPanelWebviewViewProvider - File Search', () => {
  let provider: SamuraiAgentPanelWebviewViewProvider;
  let mockWebview: any;
  let mockFindFiles: jest.Mock;
  let mockTextDocuments: vscode.TextDocument[];

  beforeEach(() => {
    // Reset mocks
    mockFindFiles = (vscode.workspace.findFiles as jest.Mock);
    mockFindFiles.mockClear();
    
    mockTextDocuments = (vscode as any).__mockTextDocuments;
    mockTextDocuments.length = 0;
    
    (vscode.window as any).activeTextEditor = null;
    
    // Create provider with minimal dependencies (searchWorkspaceFiles doesn't need them)
    provider = new SamuraiAgentPanelWebviewViewProvider(
      vscode.Uri.file('/workspace'),
      {
        llmProviderService: {} as any,
        projectDetailService: undefined,
        dataStore: undefined,
        globalDataStore: {} as any,
        treeSitterLoaderService: undefined,
        extractCodeTool: undefined,
        samuraiAgent: undefined,
      } as any
    );
    
    // Create mock webview
    mockWebview = {
      postMessage: jest.fn(),
      onDidReceiveMessage: jest.fn((callback) => {
        // Store the callback so we can call it in tests
        (mockWebview as any).__messageCallback = callback;
        return { dispose: jest.fn() };
      }),
    };
    
    // Initialize provider
    provider.resolveWebviewView({
      webview: mockWebview,
    } as any, {} as any, {} as any);
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  describe('searchWorkspaceFiles - Directory Path Matching', () => {
    it('should find files in directories with query in name', async () => {
      const query = 'planning';
      
      // Mock findFiles to return different results for filename vs directory patterns
      mockFindFiles.mockImplementation((pattern: string) => {
        if (pattern === `**/*${query}*`) {
          // Filename pattern: returns files with "planning" in filename
          return Promise.resolve([
            vscode.Uri.file('/workspace/planning.ts'),
            vscode.Uri.file('/workspace/src/planning.ts'),
          ]);
        } else if (pattern === `**/*${query}*/**`) {
          // Directory pattern: returns files inside directories with "planning" in name
          return Promise.resolve([
            vscode.Uri.file('/workspace/planning/index.ts'),
            vscode.Uri.file('/workspace/planning/service.ts'),
            vscode.Uri.file('/workspace/src/planning/utils.ts'),
          ]);
        }
        return Promise.resolve([]);
      });

      // Mock textDocuments (opened files)
      mockTextDocuments.push(
        {
          uri: vscode.Uri.file('/workspace/planning/index.ts'),
          isUntitled: false,
          scheme: 'file',
        } as any,
        {
          uri: vscode.Uri.file('/workspace/other/file.ts'),
          isUntitled: false,
          scheme: 'file',
        } as any,
      );

      // Simulate message
      const message = {
        command: 'searchWorkspaceFiles',
        requestId: 'test-request-1',
        payload: {
          query,
          pinnedFiles: [],
        },
      };

      // Call the message handler directly
      const messageHandler = (mockWebview as any).__messageCallback;
      if (messageHandler) {
        await messageHandler(message);
      }

      // Wait for async operations
      await new Promise(resolve => setTimeout(resolve, 100));

      // Verify findFiles was called with both patterns
      expect(mockFindFiles).toHaveBeenCalledWith(
        `**/*${query}*`,
        '**/{node_modules,.git,dist,build,.next,coverage,out}/**',
        50
      );
      expect(mockFindFiles).toHaveBeenCalledWith(
        `**/*${query}*/**`,
        '**/{node_modules,.git,dist,build,.next,coverage,out}/**',
        50
      );

      // Verify postMessage was called with merged results
      expect(mockWebview.postMessage).toHaveBeenCalled();
      const postMessageCall = (mockWebview.postMessage as jest.Mock).mock.calls.find(
        (call: any[]) => call[0]?.type === 'success' && call[0]?.requestId === 'test-request-1'
      );
      
      expect(postMessageCall).toBeDefined();
      const payload = postMessageCall[0].payload;
      
      // Should contain files from both patterns
      expect(payload).toContain('/workspace/planning.ts');
      expect(payload).toContain('/workspace/src/planning.ts');
      expect(payload).toContain('/workspace/planning/index.ts');
      expect(payload).toContain('/workspace/planning/service.ts');
      expect(payload).toContain('/workspace/src/planning/utils.ts');
    });

    it('should deduplicate files that match both patterns', async () => {
      const query = 'planning';
      
      // Mock findFiles: file planning/planning.ts matches both patterns
      mockFindFiles.mockImplementation((pattern: string) => {
        if (pattern === `**/*${query}*`) {
          // Filename pattern
          return Promise.resolve([
            vscode.Uri.file('/workspace/planning/planning.ts'), // Matches both
            vscode.Uri.file('/workspace/planning.ts'),
          ]);
        } else if (pattern === `**/*${query}*/**`) {
          // Directory pattern
          return Promise.resolve([
            vscode.Uri.file('/workspace/planning/planning.ts'), // Matches both
            vscode.Uri.file('/workspace/planning/index.ts'),
          ]);
        }
        return Promise.resolve([]);
      });

      const message = {
        command: 'searchWorkspaceFiles',
        requestId: 'test-request-2',
        payload: {
          query,
          pinnedFiles: [],
        },
      };

      const messageHandler = (mockWebview as any).__messageCallback;
      if (messageHandler) {
        await messageHandler(message);
      }

      await new Promise(resolve => setTimeout(resolve, 100));

      // Verify postMessage was called
      const postMessageCall = (mockWebview.postMessage as jest.Mock).mock.calls.find(
        (call: any[]) => call[0]?.type === 'success' && call[0]?.requestId === 'test-request-2'
      );
      
      expect(postMessageCall).toBeDefined();
      const payload = postMessageCall[0].payload;
      
      // planning/planning.ts should appear only once
      const occurrences = payload.filter((p: string) => p === '/workspace/planning/planning.ts');
      expect(occurrences.length).toBe(1);
      
      // All expected files should be present
      expect(payload).toContain('/workspace/planning/planning.ts');
      expect(payload).toContain('/workspace/planning.ts');
      expect(payload).toContain('/workspace/planning/index.ts');
    });

    it('should still find files with query in filename only', async () => {
      const query = 'planning';
      
      // Mock findFiles: only filename matches
      mockFindFiles.mockImplementation((pattern: string) => {
        if (pattern === `**/*${query}*`) {
          return Promise.resolve([
            vscode.Uri.file('/workspace/planning.ts'),
            vscode.Uri.file('/workspace/src/planning-utils.ts'),
          ]);
        } else if (pattern === `**/*${query}*/**`) {
          // No directory matches
          return Promise.resolve([]);
        }
        return Promise.resolve([]);
      });

      const message = {
        command: 'searchWorkspaceFiles',
        requestId: 'test-request-3',
        payload: {
          query,
          pinnedFiles: [],
        },
      };

      const messageHandler = (mockWebview as any).__messageCallback;
      if (messageHandler) {
        await messageHandler(message);
      }

      await new Promise(resolve => setTimeout(resolve, 100));

      // Verify both patterns were tried
      expect(mockFindFiles).toHaveBeenCalledWith(
        `**/*${query}*`,
        expect.any(String),
        50
      );
      expect(mockFindFiles).toHaveBeenCalledWith(
        `**/*${query}*/**`,
        expect.any(String),
        50
      );

      // Verify results contain filename matches
      const postMessageCall = (mockWebview.postMessage as jest.Mock).mock.calls.find(
        (call: any[]) => call[0]?.type === 'success' && call[0]?.requestId === 'test-request-3'
      );
      
      expect(postMessageCall).toBeDefined();
      const payload = postMessageCall[0].payload;
      expect(payload).toContain('/workspace/planning.ts');
      expect(payload).toContain('/workspace/src/planning-utils.ts');
    });
  });

  describe('searchWorkspaceFiles - Ranking Priority', () => {
    it('should prioritize filename matches over directory path matches', async () => {
      const query = 'planning';
      
      // Mock findFiles: PlanningAgent.ts (filename match) vs planning/utils.ts (directory match)
      mockFindFiles.mockImplementation((pattern: string) => {
        if (pattern === `**/*${query}*`) {
          // Filename pattern: PlanningAgent.ts matches
          return Promise.resolve([
            vscode.Uri.file('/workspace/src/agent/core/PlanningAgent.ts'),
          ]);
        } else if (pattern === `**/*${query}*/**`) {
          // Directory pattern: files in planning/ directories
          return Promise.resolve([
            vscode.Uri.file('/workspace/planning/utils.ts'),
            vscode.Uri.file('/workspace/planning/service.ts'),
            vscode.Uri.file('/workspace/planning/index.ts'),
            vscode.Uri.file('/workspace/src/planning/helper.ts'),
            vscode.Uri.file('/workspace/src/planning/config.ts'),
            vscode.Uri.file('/workspace/src/planning/types.ts'),
            vscode.Uri.file('/workspace/src/planning/constants.ts'),
            vscode.Uri.file('/workspace/src/planning/validators.ts'),
            vscode.Uri.file('/workspace/src/planning/parsers.ts'),
            vscode.Uri.file('/workspace/src/planning/transformers.ts'),
            vscode.Uri.file('/workspace/src/planning/converters.ts'),
          ]);
        }
        return Promise.resolve([]);
      });

      const message = {
        command: 'searchWorkspaceFiles',
        requestId: 'test-ranking-1',
        payload: {
          query,
          pinnedFiles: [],
        },
      };

      const messageHandler = (mockWebview as any).__messageCallback;
      if (messageHandler) {
        await messageHandler(message);
      }

      await new Promise(resolve => setTimeout(resolve, 100));

      const postMessageCall = (mockWebview.postMessage as jest.Mock).mock.calls.find(
        (call: any[]) => call[0]?.type === 'success' && call[0]?.requestId === 'test-ranking-1'
      );
      
      expect(postMessageCall).toBeDefined();
      const payload = postMessageCall[0].payload;
      
      // PlanningAgent.ts (filename match) should appear before directory matches
      const planningAgentIndex = payload.indexOf('/workspace/src/agent/core/PlanningAgent.ts');
      const directoryMatchIndices = [
        payload.indexOf('/workspace/planning/utils.ts'),
        payload.indexOf('/workspace/planning/service.ts'),
        payload.indexOf('/workspace/src/planning/helper.ts'),
      ].filter(idx => idx !== -1);
      
      if (directoryMatchIndices.length > 0) {
        expect(planningAgentIndex).toBeGreaterThan(-1);
        expect(planningAgentIndex).toBeLessThan(Math.min(...directoryMatchIndices));
      }
    });

    it('should respect full ranking hierarchy: pinned > open > same folder > filename match > directory match > alphabetical', async () => {
      const query = 'test';
      
      // Create files in different categories
      const pinnedFile = '/workspace/src/test-pinned.ts'; // Pinned
      const openFile = '/workspace/src/test-open.ts'; // Open
      const sameFolderFile = '/workspace/src/test-same-folder.ts'; // Same folder (if active editor is in src/)
      const filenameMatch1 = '/workspace/src/TestAgent.ts'; // Filename match (alphabetically first)
      const filenameMatch2 = '/workspace/src/testUtils.ts'; // Filename match (alphabetically second)
      const directoryMatch1 = '/workspace/test/config.ts'; // Directory match (alphabetically first)
      const directoryMatch2 = '/workspace/test/utils.ts'; // Directory match (alphabetically second)
      
      mockFindFiles.mockImplementation((pattern: string) => {
        if (pattern === `**/*${query}*`) {
          return Promise.resolve([
            vscode.Uri.file(filenameMatch1),
            vscode.Uri.file(filenameMatch2),
          ]);
        } else if (pattern === `**/*${query}*/**`) {
          return Promise.resolve([
            vscode.Uri.file(directoryMatch1),
            vscode.Uri.file(directoryMatch2),
          ]);
        }
        return Promise.resolve([]);
      });

      // Set active editor to a file in src/ folder
      (vscode.window as any).activeTextEditor = {
        document: {
          uri: vscode.Uri.file('/workspace/src/active.ts'),
        },
      };

      // Mock opened files
      mockTextDocuments.push(
        {
          uri: vscode.Uri.file(openFile),
          isUntitled: false,
          scheme: 'file',
        } as any
      );

      const message = {
        command: 'searchWorkspaceFiles',
        requestId: 'test-ranking-2',
        payload: {
          query,
          pinnedFiles: [pinnedFile],
        },
      };

      const messageHandler = (mockWebview as any).__messageCallback;
      if (messageHandler) {
        await messageHandler(message);
      }

      await new Promise(resolve => setTimeout(resolve, 100));

      const postMessageCall = (mockWebview.postMessage as jest.Mock).mock.calls.find(
        (call: any[]) => call[0]?.type === 'success' && call[0]?.requestId === 'test-ranking-2'
      );
      
      expect(postMessageCall).toBeDefined();
      const payload = postMessageCall[0].payload;
      
      // Verify ranking order
      const indices = {
        pinned: payload.indexOf(pinnedFile),
        open: payload.indexOf(openFile),
        sameFolder: payload.indexOf(sameFolderFile),
        filename1: payload.indexOf(filenameMatch1),
        filename2: payload.indexOf(filenameMatch2),
        directory1: payload.indexOf(directoryMatch1),
        directory2: payload.indexOf(directoryMatch2),
      };
      
      // Pinned should be first
      expect(indices.pinned).toBe(0);
      
      // Open should be after pinned
      expect(indices.open).toBeGreaterThan(indices.pinned);
      
      // Same folder should be after open
      expect(indices.sameFolder).toBeGreaterThan(indices.open);
      
      // Filename matches should be after same folder but before directory matches
      expect(indices.filename1).toBeGreaterThan(indices.sameFolder);
      expect(indices.filename2).toBeGreaterThan(indices.sameFolder);
      expect(indices.directory1).toBeGreaterThan(indices.filename1);
      expect(indices.directory1).toBeGreaterThan(indices.filename2);
      expect(indices.directory2).toBeGreaterThan(indices.directory1); // Alphabetical within directory matches
    });

    it('should treat files matching both filename and directory pattern as filename matches', async () => {
      const query = 'planning';
      
      // File that matches both: planning/planning.ts
      mockFindFiles.mockImplementation((pattern: string) => {
        if (pattern === `**/*${query}*`) {
          return Promise.resolve([
            vscode.Uri.file('/workspace/planning/planning.ts'), // Matches both
            vscode.Uri.file('/workspace/PlanningAgent.ts'),
          ]);
        } else if (pattern === `**/*${query}*/**`) {
          return Promise.resolve([
            vscode.Uri.file('/workspace/planning/planning.ts'), // Matches both
            vscode.Uri.file('/workspace/planning/utils.ts'), // Directory only
          ]);
        }
        return Promise.resolve([]);
      });

      const message = {
        command: 'searchWorkspaceFiles',
        requestId: 'test-ranking-3',
        payload: {
          query,
          pinnedFiles: [],
        },
      };

      const messageHandler = (mockWebview as any).__messageCallback;
      if (messageHandler) {
        await messageHandler(message);
      }

      await new Promise(resolve => setTimeout(resolve, 100));

      const postMessageCall = (mockWebview.postMessage as jest.Mock).mock.calls.find(
        (call: any[]) => call[0]?.type === 'success' && call[0]?.requestId === 'test-ranking-3'
      );
      
      expect(postMessageCall).toBeDefined();
      const payload = postMessageCall[0].payload;
      
      // planning/planning.ts should be ranked with filename matches (before directory-only matches)
      const planningPlanningIndex = payload.indexOf('/workspace/planning/planning.ts');
      const planningUtilsIndex = payload.indexOf('/workspace/planning/utils.ts');
      
      expect(planningPlanningIndex).toBeGreaterThan(-1);
      expect(planningUtilsIndex).toBeGreaterThan(-1);
      expect(planningPlanningIndex).toBeLessThan(planningUtilsIndex);
    });
  });
});
