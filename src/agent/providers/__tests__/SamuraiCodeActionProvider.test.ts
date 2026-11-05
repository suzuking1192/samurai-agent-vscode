/**
 * Tests for SamuraiCodeActionProvider
 */

import * as vscode from 'vscode';
import { SamuraiCodeActionProvider } from '../SamuraiCodeActionProvider';

// Mock vscode module with all required types
jest.mock('vscode', () => {
  const mockVscode = {
    CodeActionKind: {
      Refactor: 'refactor',
      QuickFix: 'quickfix',
      Empty: '',
      Source: 'source',
      SourceOrganizeImports: 'source.organizeImports',
      SourceFixAll: 'source.fixAll',
    },
    CodeActionTriggerKind: {
      Invoke: 1,
      Automatic: 2,
    },
    EndOfLine: {
      LF: 1,
      CRLF: 2,
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
    CodeAction: class CodeAction {
      constructor(public title: string, public kind?: vscode.CodeActionKind) {}
      command?: vscode.Command;
      isPreferred?: boolean;
    },
    Uri: {
      file: (fsPath: string) => ({
        fsPath,
        scheme: 'file',
        toString: () => `file://${fsPath}`,
      }),
    },
  };
  return mockVscode;
});

describe('SamuraiCodeActionProvider', () => {
  let provider: SamuraiCodeActionProvider;
  let mockDocument: vscode.TextDocument;
  let mockContext: vscode.CodeActionContext;

  beforeEach(() => {
    provider = new SamuraiCodeActionProvider();
    
    // Create mock document
    mockDocument = {
      uri: vscode.Uri.file('/test/file.ts'),
      fileName: 'file.ts',
      languageId: 'typescript',
      version: 1,
      isDirty: false,
      isUntitled: false,
      eol: vscode.EndOfLine.LF,
      lineCount: 10,
      getText: jest.fn(() => 'function test() {\n  return "hello";\n}'),
      lineAt: jest.fn(),
      offsetAt: jest.fn(),
      positionAt: jest.fn(),
      validateRange: jest.fn((range) => range),
      validatePosition: jest.fn((pos) => pos),
      getWordRangeAtPosition: jest.fn(),
    } as any;

    mockContext = {
      diagnostics: [],
      only: undefined,
      triggerKind: vscode.CodeActionTriggerKind.Invoke,
    };
  });

  describe('provideCodeActions', () => {
    it('should return empty array when selection is empty', () => {
      const emptyRange = new vscode.Range(
        new vscode.Position(0, 0),
        new vscode.Position(0, 0)
      );

      const result = provider.provideCodeActions(
        mockDocument,
        emptyRange,
        mockContext,
        {} as vscode.CancellationToken
      );

      expect(result).toEqual([]);
    });

    it('should return code action when selection is not empty', () => {
      const selection = new vscode.Range(
        new vscode.Position(0, 0),
        new vscode.Position(2, 10)
      );

      const result = provider.provideCodeActions(
        mockDocument,
        selection,
        mockContext,
        {} as vscode.CancellationToken
      );

      expect(result).toBeDefined();
      expect(Array.isArray(result)).toBe(true);
      expect(result!.length).toBe(1);
    });

    it('should return code action with correct title', () => {
      const selection = new vscode.Range(
        new vscode.Position(0, 0),
        new vscode.Position(2, 10)
      );

      const result = provider.provideCodeActions(
        mockDocument,
        selection,
        mockContext,
        {} as vscode.CancellationToken
      );

      const action = result![0] as vscode.CodeAction;
      expect(action.title).toBe('Add to Samurai Context (+K)');
    });

    it('should return code action with correct command', () => {
      const selection = new vscode.Range(
        new vscode.Position(0, 0),
        new vscode.Position(2, 10)
      );

      const result = provider.provideCodeActions(
        mockDocument,
        selection,
        mockContext,
        {} as vscode.CancellationToken
      );

      const action = result![0] as vscode.CodeAction;
      expect(action.command).toBeDefined();
      expect(action.command!.command).toBe('samurai-agent.addSelection');
      expect(action.command!.title).toBe('Add to Context');
      expect(action.command!.tooltip).toBe('Attach this code to your Samurai chat');
    });

    it('should mark action as preferred', () => {
      const selection = new vscode.Range(
        new vscode.Position(0, 0),
        new vscode.Position(2, 10)
      );

      const result = provider.provideCodeActions(
        mockDocument,
        selection,
        mockContext,
        {} as vscode.CancellationToken
      );

      const action = result![0] as vscode.CodeAction;
      expect(action.isPreferred).toBe(true);
    });

    it('should use Refactor code action kind', () => {
      const selection = new vscode.Range(
        new vscode.Position(0, 0),
        new vscode.Position(2, 10)
      );

      const result = provider.provideCodeActions(
        mockDocument,
        selection,
        mockContext,
        {} as vscode.CancellationToken
      );

      const action = result![0] as vscode.CodeAction;
      expect(action.kind).toBe(vscode.CodeActionKind.Refactor);
    });

    it('should work with Selection object', () => {
      const selection = new vscode.Selection(
        new vscode.Position(0, 0),
        new vscode.Position(2, 10)
      );

      const result = provider.provideCodeActions(
        mockDocument,
        selection,
        mockContext,
        {} as vscode.CancellationToken
      );

      expect(result).toBeDefined();
      expect(Array.isArray(result)).toBe(true);
      expect(result!.length).toBe(1);
    });

    it('should work with different document types', () => {
      const javascriptDoc = {
        ...mockDocument,
        languageId: 'javascript',
        fileName: 'file.js',
      } as vscode.TextDocument;

      const pythonDoc = {
        ...mockDocument,
        languageId: 'python',
        fileName: 'file.py',
      } as vscode.TextDocument;

      const selection = new vscode.Range(
        new vscode.Position(0, 0),
        new vscode.Position(1, 5)
      );

      const jsResult = provider.provideCodeActions(
        javascriptDoc,
        selection,
        mockContext,
        {} as vscode.CancellationToken
      );

      const pyResult = provider.provideCodeActions(
        pythonDoc,
        selection,
        mockContext,
        {} as vscode.CancellationToken
      );

      expect(jsResult!.length).toBe(1);
      expect(pyResult!.length).toBe(1);
    });
  });

  describe('providedCodeActionKinds', () => {
    it('should include Refactor and QuickFix kinds', () => {
      expect(SamuraiCodeActionProvider.providedCodeActionKinds).toContain(
        vscode.CodeActionKind.Refactor
      );
      expect(SamuraiCodeActionProvider.providedCodeActionKinds).toContain(
        vscode.CodeActionKind.QuickFix
      );
    });
  });
});
