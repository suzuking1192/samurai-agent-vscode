/**
 * Tests for SandboxFileSystemTool
 */

import { SandboxFileSystemTool } from '../SandboxFileSystemTool';
import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

// Mock vscode - use a mutable array that can be modified in tests
let mockWorkspaceFolders: any[] = [];

jest.mock('vscode', () => ({
  workspace: {
    get workspaceFolders() {
      return mockWorkspaceFolders;
    }
  }
}));

describe('SandboxFileSystemTool', () => {
  let sandboxTool: SandboxFileSystemTool;
  let testWorkspaceRoot: string;
  let sandboxPath: string;

  beforeEach(() => {
    // Create a temporary directory for testing
    testWorkspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'sandbox-test-'));
    sandboxPath = path.join(testWorkspaceRoot, '.samurai', 'sandbox');

    // Setup mock workspace folder
    mockWorkspaceFolders = [{
      uri: {
        fsPath: testWorkspaceRoot
      },
      name: 'test-workspace',
      index: 0
    }];

    sandboxTool = new SandboxFileSystemTool();
  });

  afterEach(() => {
    // Clean up test directory
    if (fs.existsSync(testWorkspaceRoot)) {
      fs.rmSync(testWorkspaceRoot, { recursive: true, force: true });
    }
    jest.clearAllMocks();
  });

  describe('execute', () => {
    describe('workspace validation', () => {
      it('should return error when no workspace folder is open', async () => {
        mockWorkspaceFolders = [];

        const result = await sandboxTool.execute({
          action: 'list'
        });

        expect(result.success).toBe(false);
        expect(result.summary).toBe('No workspace open.');
      });
    });

    describe('list action', () => {
      it('should list files in empty sandbox', async () => {
        const result = await sandboxTool.execute({
          action: 'list'
        });

        expect(result.success).toBe(true);
        expect(result.summary).toBe('Sandbox contains 0 files.');
        expect(result.structuredData).toEqual([]);
      });

      it('should list files in sandbox with files', async () => {
        // Create sandbox directory and files
        fs.mkdirSync(sandboxPath, { recursive: true });
        fs.writeFileSync(path.join(sandboxPath, 'file1.ts'), 'content1');
        fs.writeFileSync(path.join(sandboxPath, 'file2.js'), 'content2');

        const result = await sandboxTool.execute({
          action: 'list'
        });

        expect(result.success).toBe(true);
        expect(result.summary).toBe('Sandbox contains 2 files.');
        expect(result.structuredData).toEqual(expect.arrayContaining(['file1.ts', 'file2.js']));
      });
    });

    describe('cleanup action', () => {
      it('should clear sandbox directory', async () => {
        // Create sandbox with files
        fs.mkdirSync(sandboxPath, { recursive: true });
        fs.writeFileSync(path.join(sandboxPath, 'file1.ts'), 'content1');
        fs.writeFileSync(path.join(sandboxPath, 'file2.js'), 'content2');

        const result = await sandboxTool.execute({
          action: 'cleanup'
        });

        expect(result.success).toBe(true);
        expect(result.summary).toBe('Sandbox cleared.');
        
        // Verify directory still exists but is empty
        expect(fs.existsSync(sandboxPath)).toBe(true);
        const files = fs.readdirSync(sandboxPath);
        expect(files.length).toBe(0);
      });

      it('should create sandbox directory if it does not exist during cleanup', async () => {
        const result = await sandboxTool.execute({
          action: 'cleanup'
        });

        expect(result.success).toBe(true);
        expect(result.summary).toBe('Sandbox cleared.');
        expect(fs.existsSync(sandboxPath)).toBe(true);
      });
    });

    describe('write action', () => {
      it('should return error when filename is missing', async () => {
        const result = await sandboxTool.execute({
          action: 'write',
          content: 'test content'
        });

        expect(result.success).toBe(false);
        expect(result.summary).toBe('Filename required for this action.');
      });

      it('should return error when content is missing', async () => {
        const result = await sandboxTool.execute({
          action: 'write',
          filename: 'test.ts'
        });

        expect(result.success).toBe(false);
        expect(result.summary).toBe('Content required for write.');
      });

      it('should write file to sandbox', async () => {
        const content = 'const x = 1;';
        const result = await sandboxTool.execute({
          action: 'write',
          filename: 'test.ts',
          content
        });

        expect(result.success).toBe(true);
        expect(result.summary).toBe(`Wrote ${content.length} bytes to test.ts.`);
        expect(result.structuredData).toEqual({ path: path.join(sandboxPath, 'test.ts') });

        // Verify file was created
        const filePath = path.join(sandboxPath, 'test.ts');
        expect(fs.existsSync(filePath)).toBe(true);
        expect(fs.readFileSync(filePath, 'utf8')).toBe(content);
      });

      it('should overwrite existing file', async () => {
        fs.mkdirSync(sandboxPath, { recursive: true });
        fs.writeFileSync(path.join(sandboxPath, 'test.ts'), 'old content');

        const newContent = 'new content';
        const result = await sandboxTool.execute({
          action: 'write',
          filename: 'test.ts',
          content: newContent
        });

        expect(result.success).toBe(true);
        expect(fs.readFileSync(path.join(sandboxPath, 'test.ts'), 'utf8')).toBe(newContent);
      });

      it('should create nested directories', async () => {
        const content = 'test';
        const result = await sandboxTool.execute({
          action: 'write',
          filename: 'nested/path/test.ts',
          content
        });

        expect(result.success).toBe(true);
        const filePath = path.join(sandboxPath, 'nested', 'path', 'test.ts');
        expect(fs.existsSync(filePath)).toBe(true);
      });
    });

    describe('delete action', () => {
      it('should return error when filename is missing', async () => {
        const result = await sandboxTool.execute({
          action: 'delete'
        });

        expect(result.success).toBe(false);
        expect(result.summary).toBe('Filename required for this action.');
      });

      it('should delete existing file', async () => {
        fs.mkdirSync(sandboxPath, { recursive: true });
        const filePath = path.join(sandboxPath, 'test.ts');
        fs.writeFileSync(filePath, 'content');

        const result = await sandboxTool.execute({
          action: 'delete',
          filename: 'test.ts'
        });

        expect(result.success).toBe(true);
        expect(result.summary).toBe('Deleted test.ts');
        expect(fs.existsSync(filePath)).toBe(false);
      });

      it('should return success when file does not exist (idempotent)', async () => {
        const result = await sandboxTool.execute({
          action: 'delete',
          filename: 'nonexistent.ts'
        });

        expect(result.success).toBe(true);
        expect(result.summary).toBe('File did not exist (no action taken).');
      });
    });

    describe('security: path traversal protection', () => {
      it('should prevent path traversal with ../', async () => {
        const result = await sandboxTool.execute({
          action: 'write',
          filename: '../../src/index.ts',
          content: 'malicious'
        });

        expect(result.success).toBe(false);
        expect(result.summary).toBe('Security Error: Cannot access files outside the sandbox.');
        
        // Verify file was not created outside sandbox
        const maliciousPath = path.join(testWorkspaceRoot, 'src', 'index.ts');
        expect(fs.existsSync(maliciousPath)).toBe(false);
      });

      it('should prevent path traversal with multiple ../', async () => {
        const result = await sandboxTool.execute({
          action: 'delete',
          filename: '../../../etc/passwd'
        });

        expect(result.success).toBe(false);
        expect(result.summary).toBe('Security Error: Cannot access files outside the sandbox.');
      });

      it('should prevent path traversal with absolute path', async () => {
        const absolutePath = path.join(testWorkspaceRoot, 'src', 'index.ts');
        const result = await sandboxTool.execute({
          action: 'write',
          filename: absolutePath,
          content: 'malicious'
        });

        expect(result.success).toBe(false);
        expect(result.summary).toBe('Security Error: Cannot access files outside the sandbox.');
      });

      it('should allow valid nested paths within sandbox', async () => {
        const content = 'valid content';
        const result = await sandboxTool.execute({
          action: 'write',
          filename: 'nested/deep/path/file.ts',
          content
        });

        expect(result.success).toBe(true);
        const filePath = path.join(sandboxPath, 'nested', 'deep', 'path', 'file.ts');
        expect(fs.existsSync(filePath)).toBe(true);
        expect(fs.readFileSync(filePath, 'utf8')).toBe(content);
      });
    });

    describe('error handling', () => {
      it('should handle filesystem errors gracefully', async () => {
        // Create a file that will cause an error when trying to write to a directory
        fs.mkdirSync(sandboxPath, { recursive: true });
        const dirPath = path.join(sandboxPath, 'directory');
        fs.mkdirSync(dirPath);

        // Try to write to a path that is a directory (should cause error)
        const result = await sandboxTool.execute({
          action: 'write',
          filename: 'directory',
          content: 'content'
        });

        // Should return error (not throw)
        expect(result.success).toBe(false);
        expect(result.summary).toContain('Sandbox Error:');
      });
    });

    describe('unknown action', () => {
      it('should return error for unknown action', async () => {
        const result = await sandboxTool.execute({
          action: 'unknown' as any
        });

        expect(result.success).toBe(false);
        expect(result.summary).toBe('Unknown action.');
      });
    });
  });
});



