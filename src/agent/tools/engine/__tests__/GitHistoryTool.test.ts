/**
 * Tests for GitHistoryTool
 */

import { GitHistoryTool } from '../GitHistoryTool';
import { simpleGit, SimpleGit } from 'simple-git';
import * as vscode from 'vscode';

// Mock simple-git
jest.mock('simple-git');
const mockSimpleGit = simpleGit as jest.MockedFunction<typeof simpleGit>;

// Mock vscode
jest.mock('vscode', () => ({
  workspace: {
    workspaceFolders: [
      {
        uri: {
          fsPath: '/test/workspace'
        }
      }
    ]
  }
}));

describe('GitHistoryTool', () => {
  let gitHistoryTool: GitHistoryTool;
  let mockGit: jest.Mocked<SimpleGit>;

  beforeEach(() => {
    mockGit = {
      checkIsRepo: jest.fn(),
      diff: jest.fn(),
      log: jest.fn(),
      raw: jest.fn()
    } as any;

    mockSimpleGit.mockReturnValue(mockGit as any);
    gitHistoryTool = new GitHistoryTool();
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  describe('execute', () => {
    it('should return error when no workspace folder is open', async () => {
      // Mock no workspace folder by temporarily overriding the mock
      const originalMock = (vscode.workspace as any).workspaceFolders;
      (vscode.workspace as any).workspaceFolders = undefined;

      const result = await gitHistoryTool.execute({
        filePath: 'src/test.ts',
        mode: 'diff'
      });

      expect(result.success).toBe(false);
      expect(result.summary).toBe('No workspace folder open');
      
      // Restore original mock
      (vscode.workspace as any).workspaceFolders = originalMock;
    });

    it('should return error when not a git repository', async () => {
      mockGit.checkIsRepo.mockResolvedValue(false);

      const result = await gitHistoryTool.execute({
        filePath: 'src/test.ts',
        mode: 'diff'
      });

      expect(result.success).toBe(false);
      expect(result.summary).toBe('Not a git repository');
      expect(mockGit.checkIsRepo).toHaveBeenCalled();
    });

    it('should return error for unknown mode', async () => {
      mockGit.checkIsRepo.mockResolvedValue(true);

      const result = await gitHistoryTool.execute({
        filePath: 'src/test.ts',
        mode: 'unknown' as any
      });

      expect(result.success).toBe(false);
      expect(result.summary).toContain('Unknown mode');
    });
  });

  describe('diff mode', () => {
    beforeEach(() => {
      mockGit.checkIsRepo.mockResolvedValue(true);
    });

    it('should return diff with default HEAD~1', async () => {
      const mockDiff = `diff --git a/src/test.ts b/src/test.ts
index abc123..def456 100644
--- a/src/test.ts
+++ b/src/test.ts
@@ -1,3 +1,4 @@
 const x = 1;
+const y = 2;
 const z = 3;
`;

      mockGit.diff.mockResolvedValue(mockDiff);

      const result = await gitHistoryTool.execute({
        filePath: 'src/test.ts',
        mode: 'diff'
      });

      expect(result.success).toBe(true);
      expect(result.summary).toContain("Found changes in 'src/test.ts' since HEAD~1");
      expect(result.structuredData).toEqual({
        mode: 'diff',
        base: 'HEAD~1',
        filePath: 'src/test.ts'
      });
      expect(result.evidence).toHaveLength(1);
      expect(result.evidence![0].text).toBe(mockDiff);
      expect(result.evidence![0].file).toBe('src/test.ts');
      expect(mockGit.diff).toHaveBeenCalledWith(['HEAD~1', '--', 'src/test.ts']);
    });

    it('should return diff with custom since parameter', async () => {
      const mockDiff = 'diff output';
      mockGit.diff.mockResolvedValue(mockDiff);

      const result = await gitHistoryTool.execute({
        filePath: 'src/test.ts',
        mode: 'diff',
        since: 'HEAD~5'
      });

      expect(result.success).toBe(true);
      expect(mockGit.diff).toHaveBeenCalledWith(['HEAD~5', '--', 'src/test.ts']);
      expect(result.structuredData).toEqual({
        mode: 'diff',
        base: 'HEAD~5',
        filePath: 'src/test.ts'
      });
    });

    it('should handle empty diff', async () => {
      mockGit.diff.mockResolvedValue('');

      const result = await gitHistoryTool.execute({
        filePath: 'src/test.ts',
        mode: 'diff'
      });

      expect(result.success).toBe(true);
      expect(result.summary).toContain('No changes found');
      expect(result.evidence).toHaveLength(0);
    });

    it('should handle absolute file paths', async () => {
      const mockDiff = 'diff output';
      mockGit.diff.mockResolvedValue(mockDiff);

      const result = await gitHistoryTool.execute({
        filePath: '/test/workspace/src/test.ts',
        mode: 'diff'
      });

      expect(result.success).toBe(true);
      // Should normalize to relative path
      expect(mockGit.diff).toHaveBeenCalledWith(['HEAD~1', '--', 'src/test.ts']);
    });

    it('should handle git diff errors', async () => {
      mockGit.diff.mockRejectedValue(new Error('File not found'));

      const result = await gitHistoryTool.execute({
        filePath: 'src/nonexistent.ts',
        mode: 'diff'
      });

      expect(result.success).toBe(false);
      expect(result.summary).toContain('Failed to get diff');
    });
  });

  describe('log mode', () => {
    beforeEach(() => {
      mockGit.checkIsRepo.mockResolvedValue(true);
    });

    it('should return commit log', async () => {
      const mockLog = {
        all: [
          {
            hash: 'abc123def4567890123456789012345678901234',
            date: '2024-01-15T10:30:00Z',
            author_name: 'John Doe',
            message: 'Fix bug in user service'
          },
          {
            hash: 'def456abc1237890123456789012345678901234',
            date: '2024-01-14T09:20:00Z',
            author_name: 'Jane Smith',
            message: 'Add new feature'
          }
        ]
      };

      mockGit.log.mockResolvedValue(mockLog as any);

      const result = await gitHistoryTool.execute({
        filePath: 'src/test.ts',
        mode: 'log'
      });

      expect(result.success).toBe(true);
      expect(result.summary).toContain('Found 2 recent commit(s)');
      expect(result.structuredData).toEqual({
        mode: 'log',
        filePath: 'src/test.ts',
        commits: [
          {
            hash: 'abc123def4567890123456789012345678901234',
            date: '2024-01-15T10:30:00Z',
            author_name: 'John Doe',
            message: 'Fix bug in user service'
          },
          {
            hash: 'def456abc1237890123456789012345678901234',
            date: '2024-01-14T09:20:00Z',
            author_name: 'Jane Smith',
            message: 'Add new feature'
          }
        ]
      });
      expect(result.evidence).toHaveLength(2);
      expect(result.evidence![0].text).toContain('abc123d');
      expect(result.evidence![0].text).toContain('John Doe');
      expect(mockGit.log).toHaveBeenCalledWith({
        file: 'src/test.ts',
        maxCount: 5
      });
    });

    it('should handle empty log', async () => {
      mockGit.log.mockResolvedValue({ all: [] } as any);

      const result = await gitHistoryTool.execute({
        filePath: 'src/test.ts',
        mode: 'log'
      });

      expect(result.success).toBe(true);
      expect(result.summary).toContain('No commit history found');
      expect(result.structuredData).toEqual({
        mode: 'log',
        filePath: 'src/test.ts',
        commits: []
      });
    });

    it('should handle git log errors', async () => {
      mockGit.log.mockRejectedValue(new Error('Git error'));

      const result = await gitHistoryTool.execute({
        filePath: 'src/test.ts',
        mode: 'log'
      });

      expect(result.success).toBe(false);
      expect(result.summary).toContain('Failed to get log');
    });
  });

  describe('blame mode', () => {
    beforeEach(() => {
      mockGit.checkIsRepo.mockResolvedValue(true);
    });

    it('should return error when lineRange is missing', async () => {
      const result = await gitHistoryTool.execute({
        filePath: 'src/test.ts',
        mode: 'blame'
      });

      expect(result.success).toBe(false);
      expect(result.summary).toBe('lineRange is required for blame mode');
    });

    it('should return error for invalid lineRange', async () => {
      const result1 = await gitHistoryTool.execute({
        filePath: 'src/test.ts',
        mode: 'blame',
        lineRange: [0, 10] // start < 1
      });

      expect(result1.success).toBe(false);
      expect(result1.summary).toContain('Invalid lineRange');

      const result2 = await gitHistoryTool.execute({
        filePath: 'src/test.ts',
        mode: 'blame',
        lineRange: [10, 5] // start > end
      });

      expect(result2.success).toBe(false);
      expect(result2.summary).toContain('Invalid lineRange');
    });

    it('should return blame information', async () => {
      const mockBlame = `abc1234 (John Doe 2024-01-15 10) const x = 1;
def5678 (Jane Smith 2024-01-14 20) const y = 2;
abc1234 (John Doe 2024-01-15 10) const z = 3;
`;

      mockGit.raw.mockResolvedValue(mockBlame);

      const result = await gitHistoryTool.execute({
        filePath: 'src/test.ts',
        mode: 'blame',
        lineRange: [1, 3]
      });

      expect(result.success).toBe(true);
      expect(result.summary).toContain('Blame information for lines 1-3');
      expect(result.structuredData).toEqual({
        mode: 'blame',
        filePath: 'src/test.ts',
        lineRange: [1, 3],
        lines: expect.arrayContaining([
          expect.objectContaining({
            line: expect.any(Number),
            commit: expect.any(String),
            author: expect.any(String),
            date: expect.any(String),
            content: expect.any(String)
          })
        ])
      });
      expect(mockGit.raw).toHaveBeenCalledWith(['blame', '-L1,3', '--', 'src/test.ts']);
    });

    it('should handle empty blame output', async () => {
      mockGit.raw.mockResolvedValue('');

      const result = await gitHistoryTool.execute({
        filePath: 'src/test.ts',
        mode: 'blame',
        lineRange: [1, 5]
      });

      expect(result.success).toBe(true);
      expect(result.summary).toContain('No blame information found');
      expect(result.structuredData).toEqual({
        mode: 'blame',
        filePath: 'src/test.ts',
        lineRange: [1, 5],
        lines: []
      });
    });

    it('should handle blame parsing for non-standard format', async () => {
      // Test fallback for lines that don't match expected format
      const mockBlame = `unexpected format line 1
another unexpected line
`;

      mockGit.raw.mockResolvedValue(mockBlame);

      const result = await gitHistoryTool.execute({
        filePath: 'src/test.ts',
        mode: 'blame',
        lineRange: [1, 2]
      });

      expect(result.success).toBe(true);
      expect(result.structuredData?.lines).toHaveLength(2);
      expect(result.structuredData?.lines[0]).toEqual({
        line: 1,
        commit: 'unknown',
        author: 'unknown',
        date: 'unknown',
        content: 'unexpected format line 1'
      });
    });

    it('should handle git blame errors', async () => {
      mockGit.raw.mockRejectedValue(new Error('Blame error'));

      const result = await gitHistoryTool.execute({
        filePath: 'src/test.ts',
        mode: 'blame',
        lineRange: [1, 10]
      });

      expect(result.success).toBe(false);
      expect(result.summary).toContain('Failed to get blame');
    });
  });

  describe('error handling', () => {
    it('should handle general git errors gracefully', async () => {
      mockGit.checkIsRepo.mockRejectedValue(new Error('Git initialization failed'));

      const result = await gitHistoryTool.execute({
        filePath: 'src/test.ts',
        mode: 'diff'
      });

      expect(result.success).toBe(false);
      expect(result.summary).toContain('Git operation failed');
    });
  });
});

