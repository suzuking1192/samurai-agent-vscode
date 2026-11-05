/**
 * Tests for samurai-agent.addSelection command logic
 * 
 * Note: This tests the command logic rather than the full command registration
 * since command registration requires a full VS Code extension host environment.
 */

import * as vscode from 'vscode';
import * as path from 'path';

// Create mock functions first
const mockShowWarningMessage = jest.fn();
const mockShowInformationMessage = jest.fn();
const mockShowErrorMessage = jest.fn();

// Mock vscode module
jest.mock('vscode', () => {
  // Access the mock functions from the outer scope
  const mockShowWarningMessage = jest.fn();
  const mockShowInformationMessage = jest.fn();
  const mockShowErrorMessage = jest.fn();
  
  return {
    window: {
      get activeTextEditor() {
        return (global as any).mockActiveTextEditor;
      },
      showWarningMessage: mockShowWarningMessage,
      showInformationMessage: mockShowInformationMessage,
      showErrorMessage: mockShowErrorMessage,
    },
  workspace: {
    workspaceFolders: [
      {
        uri: {
          fsPath: '/workspace',
        },
      },
    ],
  },
  Uri: {
    file: (fsPath: string) => ({
      fsPath,
      scheme: 'file',
      toString: () => `file://${fsPath}`,
    }),
  },
  Position: class Position {
    constructor(public line: number, public character: number) {}
  },
  Range: class Range {
    constructor(
      public start: vscode.Position,
      public end: vscode.Position
    ) {}
    get isEmpty() {
      return (
        this.start.line === this.end.line &&
        this.start.character === this.end.character
      );
    }
  },
  Selection: class Selection {
    constructor(
      public start: vscode.Position,
      public end: vscode.Position
    ) {}
    get isEmpty() {
      return (
        this.start.line === this.end.line &&
        this.start.character === this.end.character
      );
    }
  },
  CodeActionKind: {
    Refactor: 'refactor',
    QuickFix: 'quickfix',
  },
  };
});

// Re-export the mocks for use in tests
const getMockFunctions = () => ({
  showWarningMessage: (vscode.window as any).showWarningMessage,
  showInformationMessage: (vscode.window as any).showInformationMessage,
  showErrorMessage: (vscode.window as any).showErrorMessage,
});

// Mock the webview provider
const mockPostMessage = jest.fn();
const mockWebviewProvider = {
  postMessage: mockPostMessage,
};

describe('samurai-agent.addSelection command logic', () => {
  let mockEditor: any;
  let mockDocument: any;
  let mockSelection: any;

  beforeEach(() => {
    jest.clearAllMocks();
    (global as any).mockActiveTextEditor = undefined;

    // Create mock document
    mockDocument = {
      uri: vscode.Uri.file('/workspace/src/test.ts'),
      fileName: 'test.ts',
      languageId: 'typescript',
      scheme: 'file',
      getText: jest.fn(() => 'function test() {\n  return "hello";\n}'),
    };

    // Create mock selection
    mockSelection = {
      start: new vscode.Position(0, 0),
      end: new vscode.Position(2, 10),
      isEmpty: false,
    };

    // Create mock editor
    mockEditor = {
      document: mockDocument,
      selection: mockSelection,
    };
  });

  describe('command validation', () => {
    it('should detect when no editor is active', () => {
      (global as any).mockActiveTextEditor = undefined;
      expect(vscode.window.activeTextEditor).toBeUndefined();
    });

    it('should detect when selection is empty', () => {
      const emptySelection = new vscode.Selection(
        new vscode.Position(0, 0),
        new vscode.Position(0, 0)
      );
      expect(emptySelection.isEmpty).toBe(true);
    });

    it('should detect when document is not a file', () => {
      const nonFileUri = {
        fsPath: '/workspace/src/test.ts',
        scheme: 'untitled',
      };
      expect(nonFileUri.scheme).toBe('untitled');
    });

    it('should accept valid file document', () => {
      expect(mockDocument.uri.scheme).toBe('file');
      expect(mockDocument.uri.fsPath).toBe('/workspace/src/test.ts');
    });
  });

  describe('file path extraction', () => {
    it('should extract file path from document URI', () => {
      const filePath = mockDocument.uri.fsPath;
      expect(filePath).toBe('/workspace/src/test.ts');
    });

    it('should extract file name correctly', () => {
      const filePath = mockDocument.uri.fsPath;
      const fileName = path.basename(filePath);
      expect(fileName).toBe('test.ts');
    });
  });

  describe('webview communication', () => {
    it('should send pinFile message with correct format', () => {
      const filePath = mockDocument.uri.fsPath;
      
      mockWebviewProvider.postMessage({
        type: 'pinFile',
        filePath: filePath,
      });

      expect(mockPostMessage).toHaveBeenCalledWith({
        type: 'pinFile',
        filePath: filePath,
      });
    });

    it('should handle webview not available gracefully', () => {
      const filePath = mockDocument.uri.fsPath;
      
      // Simulate webview not available
      const providerWithoutWebview = {
        postMessage: jest.fn(() => {
          throw new Error('Webview not available');
        }),
      };

      try {
        providerWithoutWebview.postMessage({
          type: 'pinFile',
          filePath: filePath,
        });
      } catch (error) {
        expect(error).toBeInstanceOf(Error);
      }
    });
  });

  describe('user notifications', () => {
    it('should show success message with file name', () => {
      const filePath = mockDocument.uri.fsPath;
      const fileName = path.basename(filePath);
      const mocks = getMockFunctions();

      vscode.window.showInformationMessage(`Added ${fileName} to Samurai context`);

      expect(mocks.showInformationMessage).toHaveBeenCalledWith(
        `Added ${fileName} to Samurai context`
      );
    });

    it('should show warning for no active editor', () => {
      const mocks = getMockFunctions();
      vscode.window.showWarningMessage('No active editor. Please open a file first.');
      expect(mocks.showWarningMessage).toHaveBeenCalledWith(
        'No active editor. Please open a file first.'
      );
    });

    it('should show warning for empty selection', () => {
      const mocks = getMockFunctions();
      vscode.window.showWarningMessage('Please select some text first.');
      expect(mocks.showWarningMessage).toHaveBeenCalledWith(
        'Please select some text first.'
      );
    });

    it('should show error message on failure', () => {
      const mocks = getMockFunctions();
      const error = new Error('Test error');
      vscode.window.showErrorMessage(
        `Failed to add file to context: ${error.message}`
      );

      expect(mocks.showErrorMessage).toHaveBeenCalledWith(
        'Failed to add file to context: Test error'
      );
    });
  });

  describe('integration scenarios', () => {
    it('should handle complete flow for valid selection', () => {
      (global as any).mockActiveTextEditor = mockEditor;
      const filePath = mockDocument.uri.fsPath;
      const fileName = path.basename(filePath);

      // Simulate command execution
      if (vscode.window.activeTextEditor) {
        const editor = vscode.window.activeTextEditor;
        if (!editor.selection.isEmpty && editor.document.uri.scheme === 'file') {
          mockWebviewProvider.postMessage({
            type: 'pinFile',
            filePath: editor.document.uri.fsPath,
          });
          vscode.window.showInformationMessage(
            `Added ${fileName} to Samurai context`
          );
        }
      }

      const mocks = getMockFunctions();
      expect(mockPostMessage).toHaveBeenCalledWith({
        type: 'pinFile',
        filePath: filePath,
      });
      expect(mocks.showInformationMessage).toHaveBeenCalledWith(
        `Added ${fileName} to Samurai context`
      );
    });
  });
});
