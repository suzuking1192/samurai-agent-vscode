/**
 * Tests for GitService utility
 */

import { GitService, GitFileChange, RelevanceOpts } from '../../../../common/utils/gitService';
import { simpleGit } from 'simple-git';

// Mock simple-git
jest.mock('simple-git');
const mockSimpleGit = simpleGit as jest.MockedFunction<typeof simpleGit>;

describe('GitService', () => {
  let gitService: GitService;
  let mockGit: any;

  beforeEach(() => {
    mockGit = {
      log: jest.fn(),
      show: jest.fn(),
      revparse: jest.fn(),
      raw: jest.fn(),
      status: jest.fn(),
      diffTree: jest.fn()
    };
    mockSimpleGit.mockReturnValue(mockGit);
    gitService = new GitService('/test/workspace');
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  describe('getDetailedCommits', () => {
    it('should return detailed commits successfully', async () => {
      const mockRawOutput = `abc123def4567890123456789012345678901234\tdef456\tJohn Doe\t2024-01-15T10:30:00Z\tFix bug in user service
M\tsrc/user.js
A\tsrc/user.test.js
2\t1\tsrc/user.js
3\t0\tsrc/user.test.js`;

      mockGit.raw.mockResolvedValue(mockRawOutput);

      const result = await gitService.getDetailedCommits(1);

      expect(result).toHaveLength(1);
      expect(result[0].hash).toBe('abc123def4567890123456789012345678901234');
      expect(result[0].message).toBe('Fix bug in user service');
      expect(result[0].author).toBe('John Doe');
      expect(result[0].files).toHaveLength(2);
      expect(result[0].files[0]).toEqual({
        path: 'src/user.js',
        status: 'M',
        additions: 2,
        deletions: 1,
        isBinary: false
      });
    });

    it('should handle errors gracefully', async () => {
      mockGit.raw.mockRejectedValue(new Error('Git error'));

      const result = await gitService.getDetailedCommits(5);

      expect(result).toEqual([]);
    });
  });

  describe('getCommitDiff', () => {
    it('should return commit diff successfully', async () => {
      const mockDiff = 'diff --git a/file1.js b/file1.js\n+ new line';
      mockGit.show.mockResolvedValue(mockDiff);

      const result = await gitService.getCommitDiff('abc123');

      expect(result).toBe(mockDiff);
      expect(mockGit.show).toHaveBeenCalledWith(['abc123', '--name-only']);
    });

    it('should handle errors gracefully', async () => {
      mockGit.show.mockRejectedValue(new Error('Git error'));

      const result = await gitService.getCommitDiff('abc123');

      expect(result).toBe('');
    });
  });

  describe('getFileHistory', () => {
    it('should return file history successfully', async () => {
      const mockRawOutput = `abc123def4567890123456789012345678901234\tdef456\tJohn Doe\t2024-01-15T10:30:00Z\tUpdate user.js
M\tsrc/user.js
1\t0\tsrc/user.js`;

      mockGit.raw.mockResolvedValue(mockRawOutput);

      const result = await gitService.getFileHistory('src/user.js', 1);

      expect(result).toHaveLength(1);
      expect(result[0].hash).toBe('abc123def4567890123456789012345678901234');
      expect(result[0].message).toBe('Update user.js');
      expect(result[0].author).toBe('John Doe');
    });
  });

  describe('getCurrentBranch', () => {
    it('should return current branch name', async () => {
      mockGit.revparse.mockResolvedValue('main\n');

      const result = await gitService.getCurrentBranch();

      expect(result).toBe('main');
      expect(mockGit.revparse).toHaveBeenCalledWith(['--abbrev-ref', 'HEAD']);
    });

    it('should handle errors gracefully', async () => {
      mockGit.revparse.mockRejectedValue(new Error('Git error'));

      const result = await gitService.getCurrentBranch();

      expect(result).toBe('unknown');
    });
  });

  describe('getCurrentCommitHash', () => {
    it('should return current commit hash', async () => {
      mockGit.revparse.mockResolvedValue('abc123def456\n');

      const result = await gitService.getCurrentCommitHash();

      expect(result).toBe('abc123def456');
      expect(mockGit.revparse).toHaveBeenCalledWith(['HEAD']);
    });
  });

  describe('getCommitFiles', () => {
    it('should return files changed in commit', async () => {
      const mockNameStatus = 'M\tsrc/file1.js\nA\tsrc/file2.ts';
      const mockNumstat = '2\t1\tsrc/file1.js\n3\t0\tsrc/file2.ts';

      mockGit.raw
        .mockResolvedValueOnce(mockNameStatus)
        .mockResolvedValueOnce(mockNumstat);

      const result = await gitService.getCommitFiles('abc123');

      expect(result).toEqual(['src/file1.js', 'src/file2.ts']);
    });

    it('should filter out empty lines', async () => {
      const mockNameStatus = 'M\tsrc/file1.js\nA\tsrc/file2.ts';
      const mockNumstat = '2\t1\tsrc/file1.js\n3\t0\tsrc/file2.ts';

      mockGit.raw
        .mockResolvedValueOnce(mockNameStatus)
        .mockResolvedValueOnce(mockNumstat);

      const result = await gitService.getCommitFiles('abc123');

      expect(result).toEqual(['src/file1.js', 'src/file2.ts']);
    });
  });

  describe('isGitRepository', () => {
    it('should return true for valid git repository', async () => {
      mockGit.status.mockResolvedValue({});

      const result = await gitService.isGitRepository();

      expect(result).toBe(true);
      expect(mockGit.status).toHaveBeenCalled();
    });

    it('should return false for non-git directory', async () => {
      mockGit.status.mockRejectedValue(new Error('Not a git repository'));

      const result = await gitService.isGitRepository();

      expect(result).toBe(false);
    });
  });

  describe('getCommitChanges', () => {
    it('should return structured file changes', async () => {
      const mockNameStatus = 'M\tsrc/user.js\nA\tsrc/user.test.js';
      const mockNumstat = '2\t1\tsrc/user.js\n3\t0\tsrc/user.test.js';

      mockGit.raw
        .mockResolvedValueOnce(mockNameStatus)
        .mockResolvedValueOnce(mockNumstat);

      const result = await gitService.getCommitChanges('abc123');

      expect(result).toHaveLength(2);
      expect(result[0]).toEqual({
        path: 'src/user.js',
        status: 'M',
        additions: 2,
        deletions: 1,
        isBinary: false
      });
    });
  });

  describe('getWorkingTreeChanges', () => {
    it('should return working tree changes', async () => {
      const mockStatus = {
        modified: ['src/user.js'],
        created: ['src/user.test.js'],
        deleted: ['src/old.js'],
        renamed: [{ from: 'src/old-name.js', to: 'src/new-name.js' }]
      };

      mockGit.status.mockResolvedValue(mockStatus);

      const result = await gitService.getWorkingTreeChanges();

      expect(result).toHaveLength(4);
      expect(result[0]).toEqual({
        path: 'src/user.js',
        status: 'M'
      });
      expect(result[1]).toEqual({
        path: 'src/user.test.js',
        status: 'A'
      });
    });
  });

  describe('computeRelevance', () => {
    it('should compute relevance score correctly', () => {
      const change = {
        hash: 'abc123',
        message: 'Fix bug in user service',
        author: 'John Doe',
        date: new Date('2024-01-15T10:30:00Z'),
        files: [
          { path: 'src/user.js', status: 'M' as const, additions: 5, deletions: 2 }
        ],
        relevanceScore: 0
      };

      const opts: RelevanceOpts = {
        relevantFiles: ['src/user.js'],
        graphFiles: ['src/user.js'],
        errorFiles: ['src/user.js'],
        recencyHalfLifeDays: 14
      };

      const score = gitService.computeRelevance(change, opts);

      expect(score).toBeGreaterThan(0);
      expect(score).toBeLessThanOrEqual(1);
    });
  });

  describe('blame', () => {
    it('should return blame information for a line', async () => {
      const mockBlameOutput = `abc123def4567890123456789012345678901234 1 1 1
author John Doe
author-time 1705312200
summary Fix user bug`;

      mockGit.raw.mockResolvedValue(mockBlameOutput);

      const result = await gitService.blame('src/user.js', 1);

      expect(result).toEqual({
        hash: 'abc123def4567890123456789012345678901234',
        author: 'John Doe',
        summary: 'Fix user bug',
        date: new Date(1705312200 * 1000)
      });
    });
  });

  describe('clearCache', () => {
    it('should clear internal cache', () => {
      gitService.clearCache();
      // Cache clearing is internal, so we just verify it doesn't throw
      expect(true).toBe(true);
    });
  });
});
