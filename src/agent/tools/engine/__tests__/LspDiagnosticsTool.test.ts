/**
 * Tests for LspDiagnosticsTool
 */

import { LspDiagnosticsTool } from '../LspDiagnosticsTool';
import * as vscode from 'vscode';
import * as path from 'path';

// Mock vscode
const mockGetDiagnostics = jest.fn();
const mockAsRelativePath = jest.fn();

jest.mock('vscode', () => ({
  workspace: {
    workspaceFolders: [
      {
        uri: {
          fsPath: '/test/workspace'
        }
      }
    ],
    asRelativePath: jest.fn()
  },
  languages: {
    getDiagnostics: jest.fn()
  },
  Uri: {
    file: jest.fn()
  },
  Range: class Range {
    constructor(public startLine: number, public startCharacter: number, public endLine: number, public endCharacter: number) {}
    get start() {
      return { line: this.startLine, character: this.startCharacter };
    }
    get end() {
      return { line: this.endLine, character: this.endCharacter };
    }
  },
  DiagnosticSeverity: {
    Error: 0,
    Warning: 1,
    Information: 2,
    Hint: 3
  }
}));

describe('LspDiagnosticsTool', () => {
  let lspDiagnosticsTool: LspDiagnosticsTool;
  let mockDiagnostics: vscode.Diagnostic[];

  beforeEach(() => {
    lspDiagnosticsTool = new LspDiagnosticsTool();
    mockDiagnostics = [];
    
    // Setup default mocks
    (vscode.languages.getDiagnostics as jest.Mock) = mockGetDiagnostics;
    (vscode.workspace.asRelativePath as jest.Mock) = mockAsRelativePath;
    mockAsRelativePath.mockImplementation((uri: vscode.Uri) => {
      return uri.fsPath.replace('/test/workspace/', '');
    });
    
    (vscode.Uri.file as jest.Mock).mockImplementation((fsPath: string) => {
      return {
        fsPath,
        toString: () => `file://${fsPath}`
      } as any;
    });
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  describe('execute', () => {
    it('should return error when no workspace folder is open', async () => {
      const originalMock = (vscode.workspace as any).workspaceFolders;
      (vscode.workspace as any).workspaceFolders = undefined;

      const result = await lspDiagnosticsTool.execute({
        filePath: 'src/test.ts'
      });

      expect(result.success).toBe(false);
      expect(result.summary).toBe('No workspace is currently open in VS Code.');
      
      // Restore original mock
      (vscode.workspace as any).workspaceFolders = originalMock;
    });

    it('should return success with no issues when file has no diagnostics', async () => {
      mockGetDiagnostics.mockReturnValue([]);

      const result = await lspDiagnosticsTool.execute({
        filePath: 'src/test.ts'
      });

      expect(result.success).toBe(true);
      expect(result.summary).toContain('No active issues found');
      expect(result.structuredData).toEqual({ count: 0 });
      expect(result.evidence).toBeUndefined();
    });

    it('should return success with no issues when filtered severity has no matches', async () => {
      mockGetDiagnostics.mockReturnValue([
        {
          range: new vscode.Range(0, 0, 0, 10) as any,
          message: 'This is an info message',
          severity: vscode.DiagnosticSeverity.Information,
          source: 'ts'
        }
      ]);

      const result = await lspDiagnosticsTool.execute({
        filePath: 'src/test.ts',
        severity: 'Error'
      });

      expect(result.success).toBe(true);
      expect(result.summary).toContain('No Error issues found');
      expect(result.structuredData).toEqual({ count: 0 });
    });

    it('should return errors and warnings when found', async () => {
      const errorDiagnostic: vscode.Diagnostic = {
        range: new vscode.Range(0, 0, 0, 10) as any,
        message: 'Type error: Cannot find name "x"',
        severity: vscode.DiagnosticSeverity.Error,
        source: 'ts'
      };

      const warningDiagnostic: vscode.Diagnostic = {
        range: new vscode.Range(1, 0, 1, 5) as any,
        message: 'Unused variable',
        severity: vscode.DiagnosticSeverity.Warning,
        source: 'eslint'
      };

      mockGetDiagnostics.mockReturnValue([errorDiagnostic, warningDiagnostic]);

      const result = await lspDiagnosticsTool.execute({
        filePath: 'src/test.ts'
      });

      expect(result.success).toBe(true);
      expect(result.summary).toContain('Found 2 issues (1 Errors)');
      expect(result.summary).toContain('Type error: Cannot find name "x"');
      expect(result.evidence).toHaveLength(2);
      expect(result.evidence![0]).toEqual({
        file: 'src/test.ts',
        line: 1,
        text: 'Type error: Cannot find name "x"',
        severity: 'Error',
        source: 'ts'
      });
      expect(result.evidence![1]).toEqual({
        file: 'src/test.ts',
        line: 2,
        text: 'Unused variable',
        severity: 'Warning',
        source: 'eslint'
      });
      expect(result.structuredData).toEqual({
        totalErrors: 1,
        totalWarnings: 1,
        blockers: true
      });
    });

    it('should filter by Error severity only', async () => {
      const errorDiagnostic: vscode.Diagnostic = {
        range: new vscode.Range(0, 0, 0, 10) as any,
        message: 'Type error',
        severity: vscode.DiagnosticSeverity.Error,
        source: 'ts'
      };

      const warningDiagnostic: vscode.Diagnostic = {
        range: new vscode.Range(1, 0, 1, 5) as any,
        message: 'Unused variable',
        severity: vscode.DiagnosticSeverity.Warning,
        source: 'eslint'
      };

      mockGetDiagnostics.mockReturnValue([errorDiagnostic, warningDiagnostic]);

      const result = await lspDiagnosticsTool.execute({
        filePath: 'src/test.ts',
        severity: 'Error'
      });

      expect(result.success).toBe(true);
      expect(result.evidence).toHaveLength(1);
      expect(result.evidence![0].severity).toBe('Error');
      expect(result.structuredData).toEqual({
        totalErrors: 1,
        totalWarnings: 0,
        blockers: true
      });
    });

    it('should filter by Warning severity only', async () => {
      const errorDiagnostic: vscode.Diagnostic = {
        range: new vscode.Range(0, 0, 0, 10) as any,
        message: 'Type error',
        severity: vscode.DiagnosticSeverity.Error,
        source: 'ts'
      };

      const warningDiagnostic: vscode.Diagnostic = {
        range: new vscode.Range(1, 0, 1, 5) as any,
        message: 'Unused variable',
        severity: vscode.DiagnosticSeverity.Warning,
        source: 'eslint'
      };

      mockGetDiagnostics.mockReturnValue([errorDiagnostic, warningDiagnostic]);

      const result = await lspDiagnosticsTool.execute({
        filePath: 'src/test.ts',
        severity: 'Warning'
      });

      expect(result.success).toBe(true);
      expect(result.evidence).toHaveLength(1);
      expect(result.evidence![0].severity).toBe('Warning');
      expect(result.structuredData).toEqual({
        totalErrors: 0,
        totalWarnings: 1,
        blockers: false
      });
    });

    it('should handle absolute file paths', async () => {
      mockGetDiagnostics.mockReturnValue([]);

      const result = await lspDiagnosticsTool.execute({
        filePath: '/test/workspace/src/test.ts'
      });

      expect(result.success).toBe(true);
      expect(vscode.Uri.file).toHaveBeenCalledWith('/test/workspace/src/test.ts');
    });

    it('should extract related information for multi-file errors', async () => {
      const relatedLocation1: vscode.Location = {
        uri: vscode.Uri.file('/test/workspace/src/file1.ts'),
        range: new vscode.Range(5, 0, 5, 10) as any
      };

      const relatedLocation2: vscode.Location = {
        uri: vscode.Uri.file('/test/workspace/src/file2.ts'),
        range: new vscode.Range(10, 0, 10, 15) as any
      };

      const diagnosticWithRelated: vscode.Diagnostic = {
        range: new vscode.Range(0, 0, 0, 10) as any,
        message: 'Duplicate identifier "x"',
        severity: vscode.DiagnosticSeverity.Error,
        source: 'ts',
        relatedInformation: [
          {
            location: relatedLocation1,
            message: 'was also declared here'
          },
          {
            location: relatedLocation2,
            message: 'and here'
          }
        ]
      };

      mockGetDiagnostics.mockReturnValue([diagnosticWithRelated]);
      mockAsRelativePath
        .mockReturnValueOnce('src/file1.ts')
        .mockReturnValueOnce('src/file2.ts');

      const result = await lspDiagnosticsTool.execute({
        filePath: 'src/test.ts'
      });

      expect(result.success).toBe(true);
      expect(result.evidence).toHaveLength(1);
      expect(result.evidence![0].relatedInfo).toBeDefined();
      expect(result.evidence![0].relatedInfo).toContain('src/file1.ts:6 (was also declared here)');
      expect(result.evidence![0].relatedInfo).toContain('src/file2.ts:11 (and here)');
    });

    it('should handle diagnostics without source', async () => {
      const diagnostic: vscode.Diagnostic = {
        range: new vscode.Range(0, 0, 0, 10) as any,
        message: 'Some error',
        severity: vscode.DiagnosticSeverity.Error
      };

      mockGetDiagnostics.mockReturnValue([diagnostic]);

      const result = await lspDiagnosticsTool.execute({
        filePath: 'src/test.ts'
      });

      expect(result.success).toBe(true);
      expect(result.evidence![0].source).toBe('LSP');
    });

    it('should convert line numbers from 0-based to 1-based', async () => {
      const diagnostic: vscode.Diagnostic = {
        range: new vscode.Range(0, 0, 0, 10) as any, // Line 0 (0-based)
        message: 'Error on first line',
        severity: vscode.DiagnosticSeverity.Error,
        source: 'ts'
      };

      mockGetDiagnostics.mockReturnValue([diagnostic]);

      const result = await lspDiagnosticsTool.execute({
        filePath: 'src/test.ts'
      });

      expect(result.success).toBe(true);
      expect(result.evidence![0].line).toBe(1); // Should be 1-based
    });

    it('should show top error in summary when errors exist', async () => {
      const error1: vscode.Diagnostic = {
        range: new vscode.Range(0, 0, 0, 10) as any,
        message: 'First error',
        severity: vscode.DiagnosticSeverity.Error,
        source: 'ts'
      };

      const error2: vscode.Diagnostic = {
        range: new vscode.Range(1, 0, 1, 10) as any,
        message: 'Second error',
        severity: vscode.DiagnosticSeverity.Error,
        source: 'ts'
      };

      mockGetDiagnostics.mockReturnValue([error1, error2]);

      const result = await lspDiagnosticsTool.execute({
        filePath: 'src/test.ts'
      });

      expect(result.success).toBe(true);
      expect(result.summary).toContain('First error'); // Should show first error
      expect(result.summary).toContain('Line 1');
    });

    it('should show first issue in summary when no errors exist', async () => {
      const warning: vscode.Diagnostic = {
        range: new vscode.Range(0, 0, 0, 10) as any,
        message: 'Only warning',
        severity: vscode.DiagnosticSeverity.Warning,
        source: 'eslint'
      };

      mockGetDiagnostics.mockReturnValue([warning]);

      const result = await lspDiagnosticsTool.execute({
        filePath: 'src/test.ts'
      });

      expect(result.success).toBe(true);
      expect(result.summary).toContain('Only warning');
      expect(result.summary).toContain('Found 1 issues (0 Errors)');
    });

    it('should set blockers flag to false when only warnings exist', async () => {
      const warning: vscode.Diagnostic = {
        range: new vscode.Range(0, 0, 0, 10) as any,
        message: 'Warning only',
        severity: vscode.DiagnosticSeverity.Warning,
        source: 'eslint'
      };

      mockGetDiagnostics.mockReturnValue([warning]);

      const result = await lspDiagnosticsTool.execute({
        filePath: 'src/test.ts'
      });

      expect(result.success).toBe(true);
      expect(result.structuredData?.blockers).toBe(false);
    });

    it('should set blockers flag to true when errors exist', async () => {
      const error: vscode.Diagnostic = {
        range: new vscode.Range(0, 0, 0, 10) as any,
        message: 'Error found',
        severity: vscode.DiagnosticSeverity.Error,
        source: 'ts'
      };

      mockGetDiagnostics.mockReturnValue([error]);

      const result = await lspDiagnosticsTool.execute({
        filePath: 'src/test.ts'
      });

      expect(result.success).toBe(true);
      expect(result.structuredData?.blockers).toBe(true);
    });
  });

  describe('mapSeverity', () => {
    it('should map all severity levels correctly', () => {
      // Access private method through type assertion for testing
      const tool = lspDiagnosticsTool as any;
      
      expect(tool.mapSeverity(vscode.DiagnosticSeverity.Error)).toBe('Error');
      expect(tool.mapSeverity(vscode.DiagnosticSeverity.Warning)).toBe('Warning');
      expect(tool.mapSeverity(vscode.DiagnosticSeverity.Information)).toBe('Info');
      expect(tool.mapSeverity(vscode.DiagnosticSeverity.Hint)).toBe('Hint');
      expect(tool.mapSeverity(999)).toBe('Unknown');
    });
  });
});















