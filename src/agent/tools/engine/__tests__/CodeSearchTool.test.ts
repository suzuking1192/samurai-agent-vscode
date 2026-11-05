/**
 * Tests for CodeSearchTool
 */

import { CodeSearchTool } from '../CodeSearchTool';
import * as vscode from 'vscode';
import { SearchUtils } from '../../utils/SearchUtils';

// Mock SearchUtils
jest.mock('../../utils/SearchUtils', () => ({
  SearchUtils: {
    rankResults: jest.fn(),
    extractTeaser: jest.fn()
  }
}));

// Mock vscode
const mockFindFiles = jest.fn();
const mockAsRelativePath = jest.fn();
const mockExecuteCommand = jest.fn();
const mockOpenTextDocument = jest.fn();
const mockGetText = jest.fn();

jest.mock('vscode', () => ({
  workspace: {
    workspaceFolders: [
      {
        uri: {
          fsPath: '/test/workspace'
        }
      }
    ],
    findFiles: jest.fn(),
    asRelativePath: jest.fn(),
    openTextDocument: jest.fn()
  },
  commands: {
    executeCommand: jest.fn()
  },
  Uri: {
    file: jest.fn((fsPath: string) => ({
      fsPath,
      toString: () => `file://${fsPath}`
    }))
  },
  Range: class Range {
    constructor(
      public startLine: number,
      public startCharacter: number,
      public endLine: number,
      public endCharacter: number
    ) {}
    get start() {
      return { line: this.startLine, character: this.startCharacter };
    }
    get end() {
      return { line: this.endLine, character: this.endCharacter };
    }
  },
  SymbolKind: {
    File: 0,
    Module: 1,
    Namespace: 2,
    Package: 3,
    Class: 4,
    Method: 5,
    Property: 6,
    Field: 7,
    Constructor: 8,
    Enum: 9,
    Interface: 10,
    Function: 11,
    Variable: 12,
    Constant: 13,
    String: 14,
    Number: 15,
    Boolean: 16,
    Array: 17,
    Object: 18,
    Key: 19,
    Null: 20,
    EnumMember: 21,
    Struct: 22,
    Event: 23,
    Operator: 24,
    TypeParameter: 25
  }
}));

describe('CodeSearchTool', () => {
  let codeSearchTool: CodeSearchTool;

  beforeEach(() => {
    codeSearchTool = new CodeSearchTool();
    jest.clearAllMocks();

    // Setup default mocks
    (vscode.workspace.findFiles as jest.Mock) = mockFindFiles;
    (vscode.workspace.asRelativePath as jest.Mock) = mockAsRelativePath;
    (vscode.commands.executeCommand as jest.Mock) = mockExecuteCommand;
    (vscode.workspace.openTextDocument as jest.Mock) = mockOpenTextDocument;

    mockAsRelativePath.mockImplementation((uri: vscode.Uri) => {
      return uri.fsPath.replace('/test/workspace/', '');
    });

    // Default SearchUtils mocks
    (SearchUtils.rankResults as jest.Mock).mockImplementation((matches) => matches);
    (SearchUtils.extractTeaser as jest.Mock).mockResolvedValue('(Lines 1-5)...\ncode snippet\n...');
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  describe('execute', () => {
    it('should return error when no workspace folder is open', async () => {
      const originalMock = (vscode.workspace as any).workspaceFolders;
      (vscode.workspace as any).workspaceFolders = undefined;

      const result = await codeSearchTool.execute({
        query: 'test',
        mode: 'file'
      });

      expect(result.success).toBe(false);
      expect(result.summary).toBe('No workspace is currently open in VS Code.');

      // Restore original mock
      (vscode.workspace as any).workspaceFolders = originalMock;
    });

    describe('file mode', () => {
      it('should find files matching query', async () => {
        const mockUris = [
          vscode.Uri.file('/test/workspace/src/User.ts'),
          vscode.Uri.file('/test/workspace/src/UserService.ts')
        ];
        mockFindFiles.mockResolvedValue(mockUris);
        (SearchUtils.rankResults as jest.Mock).mockReturnValue([
          { uri: mockUris[0], file: 'src/User.ts', line: 0, score: 20 }
        ]);

        const result = await codeSearchTool.execute({
          query: 'User',
          mode: 'file'
        });

        expect(result.success).toBe(true);
        expect(mockFindFiles).toHaveBeenCalledWith('**/*User*', '{**/node_modules/**,**/.vscode-test/**,**/dist/**,**/build/**,**/.git/**,**/coverage/**}', 50);
        expect(result.summary).toContain('Found 2 raw matches');
      });

      it('should use custom pattern when provided', async () => {
        mockFindFiles.mockResolvedValue([]);

        await codeSearchTool.execute({
          query: 'User',
          mode: 'file',
          pattern: 'src/**/*.ts'
        });

        expect(mockFindFiles).toHaveBeenCalledWith('src/**/*.ts', '{**/node_modules/**,**/.vscode-test/**,**/dist/**,**/build/**,**/.git/**,**/coverage/**}', 50);
      });

      it('should normalize simple filename patterns (exact example from LLM output)', async () => {
        // This test matches the exact scenario from the user's example:
        // { "query": "graph-context", "mode": "file", "pattern": "Tool.ts" }
        const mockUris = [
          vscode.Uri.file('/test/workspace/src/agent/tools/engine/GraphContextTool.ts')
        ];
        mockFindFiles.mockResolvedValue(mockUris);
        (SearchUtils.rankResults as jest.Mock).mockReturnValue([
          { uri: mockUris[0], file: 'src/agent/tools/engine/GraphContextTool.ts', line: 0, score: 20 }
        ]);

        const result = await codeSearchTool.execute({
          query: 'graph-context',
          mode: 'file',
          pattern: 'Tool.ts'
        });

        // Verify that the pattern was normalized from "Tool.ts" to "**/Tool.ts"
        expect(mockFindFiles).toHaveBeenCalledWith('**/Tool.ts', '{**/node_modules/**,**/.vscode-test/**,**/dist/**,**/build/**,**/.git/**,**/coverage/**}', 50);
        expect(result.success).toBe(true);
        expect(result.summary).toContain('Found');
      });

      it('should provide helpful error message when normalized pattern finds no results', async () => {
        mockFindFiles.mockResolvedValue([]);
        (SearchUtils.rankResults as jest.Mock).mockReturnValue([]);

        const result = await codeSearchTool.execute({
          query: 'graph-context',
          mode: 'file',
          pattern: 'Tool.ts'
        });

        expect(result.success).toBe(true);
        expect(result.summary).toContain("No matches found for 'graph-context'");
        expect(result.summary).toContain('Pattern "Tool.ts" was normalized to "**/Tool.ts"');
        expect(result.structuredData).toEqual([]);
      });

      it('should NOT normalize patterns that already contain path separators', async () => {
        mockFindFiles.mockResolvedValue([]);

        await codeSearchTool.execute({
          query: 'test',
          mode: 'file',
          pattern: 'src/Tool.ts'
        });

        // Pattern with path separator should remain unchanged
        expect(mockFindFiles).toHaveBeenCalledWith('src/Tool.ts', '{**/node_modules/**,**/.vscode-test/**,**/dist/**,**/build/**,**/.git/**,**/coverage/**}', 50);
      });

      it('should NOT normalize patterns that already contain wildcards', async () => {
        mockFindFiles.mockResolvedValue([]);

        await codeSearchTool.execute({
          query: 'test',
          mode: 'file',
          pattern: '**/*Tool.ts'
        });

        // Pattern with wildcards should remain unchanged
        expect(mockFindFiles).toHaveBeenCalledWith('**/*Tool.ts', '{**/node_modules/**,**/.vscode-test/**,**/dist/**,**/build/**,**/.git/**,**/coverage/**}', 50);
      });

      it('should return no matches when no files found', async () => {
        mockFindFiles.mockResolvedValue([]);
        (SearchUtils.rankResults as jest.Mock).mockReturnValue([]);

        const result = await codeSearchTool.execute({
          query: 'Nonexistent',
          mode: 'file'
        });

        expect(result.success).toBe(true);
        expect(result.summary).toContain("No matches found for 'Nonexistent'");
        expect(result.structuredData).toEqual([]);
      });
    });

    describe('symbol mode', () => {
      it('should find symbols matching query', async () => {
        const mockSymbols: vscode.SymbolInformation[] = [
          {
            name: 'AuthService',
            kind: vscode.SymbolKind.Class,
            location: {
              uri: vscode.Uri.file('/test/workspace/src/AuthService.ts'),
              range: new vscode.Range(5, 0, 5, 10) as any
            }
          },
          {
            name: 'AuthHelper',
            kind: vscode.SymbolKind.Function,
            location: {
              uri: vscode.Uri.file('/test/workspace/src/AuthHelper.ts'),
              range: new vscode.Range(10, 0, 10, 15) as any
            }
          }
        ];

        mockExecuteCommand.mockResolvedValue(mockSymbols);
        (SearchUtils.rankResults as jest.Mock).mockReturnValue([
          { uri: mockSymbols[0].location.uri, file: 'src/AuthService.ts', line: 5, score: 20 }
        ]);

        const result = await codeSearchTool.execute({
          query: 'AuthService',
          mode: 'symbol'
        });

        expect(result.success).toBe(true);
        expect(mockExecuteCommand).toHaveBeenCalledWith('vscode.executeWorkspaceSymbolProvider', 'AuthService');
        expect(result.summary).toContain('Found 2 raw matches');
      });

      it('should handle undefined symbol results', async () => {
        mockExecuteCommand.mockResolvedValue(undefined);
        (SearchUtils.rankResults as jest.Mock).mockReturnValue([]);

        const result = await codeSearchTool.execute({
          query: 'Nonexistent',
          mode: 'symbol'
        });

        expect(result.success).toBe(true);
        expect(result.summary).toContain("No matches found");
      });

      it('should handle non-array symbol results', async () => {
        mockExecuteCommand.mockResolvedValue(null);
        (SearchUtils.rankResults as jest.Mock).mockReturnValue([]);

        const result = await codeSearchTool.execute({
          query: 'Test',
          mode: 'symbol'
        });

        expect(result.success).toBe(true);
        expect(result.summary).toContain("No matches found");
      });
    });

    describe('text mode', () => {
      it('should find text in files', async () => {
        const mockUris = [
          vscode.Uri.file('/test/workspace/src/file1.ts'),
          vscode.Uri.file('/test/workspace/src/file2.ts')
        ];
        mockFindFiles.mockResolvedValue(mockUris);

        const mockDocument1 = {
          getText: jest.fn().mockReturnValue('const error_code_500 = "server error";\nconst x = 1;'),
          lineCount: 2
        };
        const mockDocument2 = {
          getText: jest.fn().mockReturnValue('const y = 2;\nconst error_code_500 = "client error";'),
          lineCount: 2
        };

        mockOpenTextDocument
          .mockResolvedValueOnce(mockDocument1)
          .mockResolvedValueOnce(mockDocument2);

        (SearchUtils.rankResults as jest.Mock).mockReturnValue([
          { uri: mockUris[0], file: 'src/file1.ts', line: 0, score: 15 }
        ]);

        const result = await codeSearchTool.execute({
          query: 'error_code_500',
          mode: 'text'
        });

        expect(result.success).toBe(true);
        expect(mockFindFiles).toHaveBeenCalledWith(
          '**/*.{ts,tsx,js,jsx,py,java,go,rs,cpp,c,cs}',
          '{**/node_modules/**,**/.vscode-test/**,**/dist/**,**/build/**,**/.git/**,**/coverage/**}',
          100
        );
        expect(result.summary).toContain('Found');
      });

      it('should use custom pattern when provided', async () => {
        mockFindFiles.mockResolvedValue([]);

        await codeSearchTool.execute({
          query: 'test',
          mode: 'text',
          pattern: 'src/**/*.ts'
        });

        expect(mockFindFiles).toHaveBeenCalledWith('src/**/*.ts', '{**/node_modules/**,**/.vscode-test/**,**/dist/**,**/build/**,**/.git/**,**/coverage/**}', 100);
      });

      it('should normalize simple filename patterns in text mode', async () => {
        const mockUris = [vscode.Uri.file('/test/workspace/src/Tool.ts')];
        mockFindFiles.mockResolvedValue(mockUris);

        const mockDocument = {
          getText: jest.fn().mockReturnValue('const test = 1;'),
          lineCount: 1
        };
        mockOpenTextDocument.mockResolvedValue(mockDocument);
        (SearchUtils.rankResults as jest.Mock).mockReturnValue([
          { uri: mockUris[0], file: 'src/Tool.ts', line: 0, score: 15 }
        ]);

        await codeSearchTool.execute({
          query: 'test',
          mode: 'text',
          pattern: 'Tool.ts'
        });

        // Verify that the pattern was normalized from "Tool.ts" to "**/Tool.ts"
        expect(mockFindFiles).toHaveBeenCalledWith('**/Tool.ts', '{**/node_modules/**,**/.vscode-test/**,**/dist/**,**/build/**,**/.git/**,**/coverage/**}', 100);
      });

      it('should skip files that cannot be opened', async () => {
        const mockUris = [
          vscode.Uri.file('/test/workspace/src/file1.ts'),
          vscode.Uri.file('/test/workspace/src/file2.ts')
        ];
        mockFindFiles.mockResolvedValue(mockUris);

        const mockDocument = {
          getText: jest.fn().mockReturnValue('const test = 1;'),
          lineCount: 1
        };

        mockOpenTextDocument
          .mockResolvedValueOnce(mockDocument)
          .mockRejectedValueOnce(new Error('Cannot open file'));

        (SearchUtils.rankResults as jest.Mock).mockReturnValue([
          { uri: mockUris[0], file: 'src/file1.ts', line: 0, score: 15 }
        ]);

        const result = await codeSearchTool.execute({
          query: 'test',
          mode: 'text'
        });

        expect(result.success).toBe(true);
        // Should only find one match (the file that could be opened)
      });

      it('should handle case-insensitive search', async () => {
        const mockUris = [vscode.Uri.file('/test/workspace/src/file.ts')];
        mockFindFiles.mockResolvedValue(mockUris);

        const mockDocument = {
          getText: jest.fn().mockReturnValue('const TEST_VALUE = 123;'),
          lineCount: 1
        };
        mockOpenTextDocument.mockResolvedValue(mockDocument);

        (SearchUtils.rankResults as jest.Mock).mockReturnValue([
          { uri: mockUris[0], file: 'src/file.ts', line: 0, score: 15 }
        ]);

        const result = await codeSearchTool.execute({
          query: 'test_value',
          mode: 'text'
        });

        expect(result.success).toBe(true);
        expect(result.summary).toContain('Found');
      });
    });

    describe('ranking and teaser generation', () => {
      it('should rank results using SearchUtils', async () => {
        const mockUris = [vscode.Uri.file('/test/workspace/src/User.ts')];
        mockFindFiles.mockResolvedValue(mockUris);

        const rankedMatches = [
          { uri: mockUris[0], file: 'src/User.ts', line: 0, score: 25 }
        ];
        (SearchUtils.rankResults as jest.Mock).mockReturnValue(rankedMatches);

        await codeSearchTool.execute({
          query: 'User',
          mode: 'file'
        });

        expect(SearchUtils.rankResults).toHaveBeenCalled();
      });

      it('should generate teasers for ranked results', async () => {
        const mockUris = [vscode.Uri.file('/test/workspace/src/User.ts')];
        mockFindFiles.mockResolvedValue(mockUris);

        const rankedMatches = [
          { uri: mockUris[0], file: 'src/User.ts', line: 0, score: 25 }
        ];
        (SearchUtils.rankResults as jest.Mock).mockReturnValue(rankedMatches);
        (SearchUtils.extractTeaser as jest.Mock).mockResolvedValue('(Lines 1-5)...\ncode\n...');

        const result = await codeSearchTool.execute({
          query: 'User',
          mode: 'file'
        });

        expect(SearchUtils.extractTeaser).toHaveBeenCalledWith(mockUris[0], 0);
        expect(result.evidence).toHaveLength(1);
        expect(result.evidence![0].text).toBe('(Lines 1-5)...\ncode\n...');
      });

      it('should include score in evidence description', async () => {
        const mockUris = [vscode.Uri.file('/test/workspace/src/User.ts')];
        mockFindFiles.mockResolvedValue(mockUris);

        const rankedMatches = [
          { uri: mockUris[0], file: 'src/User.ts', line: 0, score: 25 }
        ];
        (SearchUtils.rankResults as jest.Mock).mockReturnValue(rankedMatches);

        const result = await codeSearchTool.execute({
          query: 'User',
          mode: 'file'
        });

        expect(result.evidence![0].description).toContain('Score: 25');
        expect(result.evidence![0].description).toContain('User');
      });

      it('should convert line numbers from 0-based to 1-based in evidence', async () => {
        const mockUris = [vscode.Uri.file('/test/workspace/src/User.ts')];
        mockFindFiles.mockResolvedValue(mockUris);

        const rankedMatches = [
          { uri: mockUris[0], file: 'src/User.ts', line: 5, score: 25 }
        ];
        (SearchUtils.rankResults as jest.Mock).mockReturnValue(rankedMatches);

        const result = await codeSearchTool.execute({
          query: 'User',
          mode: 'file'
        });

        expect(result.evidence![0].line).toBe(6); // 5 (0-based) + 1 = 6 (1-based)
      });

      it('should include structured data with scores', async () => {
        const mockUris = [vscode.Uri.file('/test/workspace/src/User.ts')];
        mockFindFiles.mockResolvedValue(mockUris);

        const rankedMatches = [
          { uri: mockUris[0], file: 'src/User.ts', line: 0, score: 25 }
        ];
        (SearchUtils.rankResults as jest.Mock).mockReturnValue(rankedMatches);

        const result = await codeSearchTool.execute({
          query: 'User',
          mode: 'file'
        });

        expect(result.structuredData).toEqual([
          { file: 'src/User.ts', score: 25, line: 1 }
        ]);
      });
    });

    describe('caching', () => {
      it('should return cached results for repeated identical searches', async () => {
        const mockUris = [vscode.Uri.file('/test/workspace/src/User.ts')];
        mockFindFiles.mockResolvedValue(mockUris);
        (SearchUtils.rankResults as jest.Mock).mockReturnValue([
          { uri: mockUris[0], file: 'src/User.ts', line: 0, score: 20 }
        ]);

        await codeSearchTool.execute({ query: 'User', mode: 'file' });
        await codeSearchTool.execute({ query: 'User', mode: 'file' });

        // findFiles should only be called once due to caching
        expect(mockFindFiles).toHaveBeenCalledTimes(1);
      });

      it('should expire cache after TTL', async () => {
        const mockUris = [vscode.Uri.file('/test/workspace/src/User.ts')];
        mockFindFiles.mockResolvedValue(mockUris);
        (SearchUtils.rankResults as jest.Mock).mockReturnValue([
          { uri: mockUris[0], file: 'src/User.ts', line: 0, score: 20 }
        ]);

        const originalNow = Date.now;
        let now = 1000000;
        Date.now = () => now;

        await codeSearchTool.execute({ query: 'User', mode: 'file' });
        now += 31_000; // Advance past 30s TTL
        await codeSearchTool.execute({ query: 'User', mode: 'file' });

        expect(mockFindFiles).toHaveBeenCalledTimes(2);
        Date.now = originalNow;
      });

      it('should cache different patterns separately', async () => {
        mockFindFiles.mockResolvedValue([]);
        (SearchUtils.rankResults as jest.Mock).mockReturnValue([]);

        await codeSearchTool.execute({ query: 'User', mode: 'file' });
        await codeSearchTool.execute({ query: 'Auth', mode: 'file' });

        expect(mockFindFiles).toHaveBeenCalledTimes(2);
      });
    });

    describe('error handling', () => {
      it('should handle errors gracefully', async () => {
        mockFindFiles.mockRejectedValue(new Error('Search failed'));

        const result = await codeSearchTool.execute({
          query: 'test',
          mode: 'file'
        });

        expect(result.success).toBe(false);
        expect(result.summary).toContain('Search failed');
      });

      it('should handle errors in text search', async () => {
        mockFindFiles.mockRejectedValue(new Error('File search failed'));

        const result = await codeSearchTool.execute({
          query: 'test',
          mode: 'text'
        });

        expect(result.success).toBe(false);
        expect(result.summary).toContain('Search failed');
      });
    });
  });
});



