/**
 * Tests for SearchUtils
 */

import { SearchUtils, SearchMatch } from '../SearchUtils';
import * as vscode from 'vscode';
import * as path from 'path';

// Mock vscode
const mockOpenTextDocument = jest.fn();
const mockGetText = jest.fn();
const mockLineCount = jest.fn();

jest.mock('vscode', () => ({
  workspace: {
    openTextDocument: jest.fn()
  },
  Range: class Range {
    constructor(
      public startLine: number,
      public startCharacter: number,
      public endLine: number,
      public endCharacter: number
    ) {}
  },
  Uri: {
    file: jest.fn((fsPath: string) => ({
      fsPath,
      toString: () => `file://${fsPath}`
    }))
  }
}));

describe('SearchUtils', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockLineCount.mockReturnValue(100);
    mockGetText.mockReturnValue('line1\nline2\nline3\nline4\nline5');
  });

  describe('rankResults', () => {
    it('should return top 10 results sorted by score', () => {
      const matches = [
        { uri: vscode.Uri.file('/test/file1.ts'), file: 'src/file1.ts', line: 0 },
        { uri: vscode.Uri.file('/test/file2.ts'), file: 'src/file2.ts', line: 0 },
        { uri: vscode.Uri.file('/test/file3.ts'), file: 'src/file3.ts', line: 0 },
        { uri: vscode.Uri.file('/test/file4.ts'), file: 'src/file4.ts', line: 0 },
        { uri: vscode.Uri.file('/test/file5.ts'), file: 'src/file5.ts', line: 0 },
        { uri: vscode.Uri.file('/test/file6.ts'), file: 'src/file6.ts', line: 0 },
        { uri: vscode.Uri.file('/test/file7.ts'), file: 'src/file7.ts', line: 0 },
        { uri: vscode.Uri.file('/test/file8.ts'), file: 'src/file8.ts', line: 0 },
        { uri: vscode.Uri.file('/test/file9.ts'), file: 'src/file9.ts', line: 0 },
        { uri: vscode.Uri.file('/test/file10.ts'), file: 'src/file10.ts', line: 0 },
        { uri: vscode.Uri.file('/test/file11.ts'), file: 'src/file11.ts', line: 0 },
        { uri: vscode.Uri.file('/test/file12.ts'), file: 'src/file12.ts', line: 0 }
      ];

      const ranked = SearchUtils.rankResults(matches, 'file');

      expect(ranked.length).toBe(10);
      expect(ranked.every(r => r.score !== undefined)).toBe(true);
    });

    it('should prioritize exact filename matches', () => {
      const matches = [
        { uri: vscode.Uri.file('/test/User.ts'), file: 'src/User.ts', line: 0 },
        { uri: vscode.Uri.file('/test/UserService.ts'), file: 'src/UserService.ts', line: 0 },
        { uri: vscode.Uri.file('/test/BaseUser.ts'), file: 'src/BaseUser.ts', line: 0 }
      ];

      const ranked = SearchUtils.rankResults(matches, 'User.ts');

      expect(ranked[0].file).toBe('src/User.ts');
      expect(ranked[0].score).toBeGreaterThan(ranked[1].score);
    });

    it('should prioritize files in src/ directory', () => {
      const matches = [
        { uri: vscode.Uri.file('/test/file.ts'), file: 'src/file.ts', line: 0 },
        { uri: vscode.Uri.file('/test/file.ts'), file: 'tests/file.ts', line: 0 },
        { uri: vscode.Uri.file('/test/file.ts'), file: 'lib/file.ts', line: 0 }
      ];

      const ranked = SearchUtils.rankResults(matches, 'file');

      expect(ranked[0].file).toBe('src/file.ts');
      expect(ranked[0].score).toBeGreaterThan(ranked[1].score);
    });

    it('should heavily penalize node_modules', () => {
      const matches = [
        { uri: vscode.Uri.file('/test/file.ts'), file: 'src/file.ts', line: 0 },
        { uri: vscode.Uri.file('/test/file.ts'), file: 'node_modules/package/file.ts', line: 0 }
      ];

      const ranked = SearchUtils.rankResults(matches, 'file');

      expect(ranked[0].file).toBe('src/file.ts');
      expect(ranked[0].score).toBeGreaterThan(ranked[1].score);
      expect(ranked[1].score).toBeLessThan(0);
    });

    it('should penalize test files', () => {
      const matches = [
        { uri: vscode.Uri.file('/test/file.ts'), file: 'src/file.ts', line: 0 },
        { uri: vscode.Uri.file('/test/file.ts'), file: 'src/file.test.ts', line: 0 },
        { uri: vscode.Uri.file('/test/file.ts'), file: 'src/file.spec.ts', line: 0 }
      ];

      const ranked = SearchUtils.rankResults(matches, 'file');

      expect(ranked[0].file).toBe('src/file.ts');
      expect(ranked[0].score).toBeGreaterThan(ranked[1].score);
      // Both test files should have the same penalty, so they may have equal scores
      expect(ranked[1].score).toBeGreaterThanOrEqual(ranked[2].score);
      expect(ranked[1].score).toBeLessThan(ranked[0].score);
    });

    it('should penalize json and lock files', () => {
      const matches = [
        { uri: vscode.Uri.file('/test/file.ts'), file: 'src/file.ts', line: 0 },
        { uri: vscode.Uri.file('/test/file.json'), file: 'src/file.json', line: 0 },
        { uri: vscode.Uri.file('/test/file.lock'), file: 'src/file.lock', line: 0 }
      ];

      const ranked = SearchUtils.rankResults(matches, 'file');

      expect(ranked[0].file).toBe('src/file.ts');
      expect(ranked[0].score).toBeGreaterThan(ranked[1].score);
      // Both json and lock files should have the same penalty, so they may have equal scores
      expect(ranked[1].score).toBeGreaterThanOrEqual(ranked[2].score);
      expect(ranked[1].score).toBeLessThan(ranked[0].score);
    });

    it('should heavily penalize .vscode-test paths', () => {
      const matches = [
        { uri: vscode.Uri.file('/test/file.ts'), file: 'src/file.ts', line: 0 },
        { uri: vscode.Uri.file('/test/file.ts'), file: '.vscode-test/ext/file.ts', line: 0 }
      ];

      const ranked = SearchUtils.rankResults(matches, 'file');

      expect(ranked[0].file).toBe('src/file.ts');
      expect(ranked[1].score).toBeLessThan(0);
    });

    it('should rank project root file above .vscode-test duplicates', () => {
      const matches = [
        ...Array.from({ length: 12 }, (_, i) => ({
          uri: vscode.Uri.file(`/test/.vscode-test/ext${i}/icon.png`),
          file: `.vscode-test/ext${i}/icon.png`,
          line: 0
        })),
        { uri: vscode.Uri.file('/test/icon.png'), file: 'icon.png', line: 0 }
      ];

      const ranked = SearchUtils.rankResults(matches, 'icon.png');

      // The project root icon.png should be in top 10
      const topFiles = ranked.map(r => r.file);
      expect(topFiles).toContain('icon.png');
    });

    it('should handle empty matches array', () => {
      const ranked = SearchUtils.rankResults([], 'query');
      expect(ranked).toEqual([]);
    });

    it('should combine scoring factors correctly', () => {
      // Exact match + src/ = highest score
      const exactInSrc = { uri: vscode.Uri.file('/test/User.ts'), file: 'src/User.ts', line: 0 };
      // Partial match + src/ = medium score
      const partialInSrc = { uri: vscode.Uri.file('/test/UserService.ts'), file: 'src/UserService.ts', line: 0 };
      // Exact match but in node_modules = low score
      const exactInNodeModules = { uri: vscode.Uri.file('/test/User.ts'), file: 'node_modules/User.ts', line: 0 };

      const matches = [exactInNodeModules, partialInSrc, exactInSrc];
      const ranked = SearchUtils.rankResults(matches, 'User.ts');

      expect(ranked[0].file).toBe('src/User.ts');
      expect(ranked[1].file).toBe('src/UserService.ts');
      expect(ranked[2].file).toBe('node_modules/User.ts');
    });
  });

  describe('extractTeaser', () => {
    it('should extract 5-line teaser centered on match line', async () => {
      const mockDocument = {
        lineCount: 100,
        getText: mockGetText
      };
      mockOpenTextDocument.mockResolvedValue(mockDocument);
      (vscode.workspace.openTextDocument as jest.Mock) = mockOpenTextDocument;

      const uri = vscode.Uri.file('/test/file.ts');
      const teaser = await SearchUtils.extractTeaser(uri, 10);

      expect(mockOpenTextDocument).toHaveBeenCalledWith(uri);
      expect(teaser).toContain('(Lines 9-13)');
      expect(teaser).toContain('line1');
    });

    it('should handle match at beginning of file', async () => {
      const mockDocument = {
        lineCount: 100,
        getText: jest.fn().mockReturnValue('line1\nline2\nline3')
      };
      mockOpenTextDocument.mockResolvedValue(mockDocument);
      (vscode.workspace.openTextDocument as jest.Mock) = mockOpenTextDocument;

      const uri = vscode.Uri.file('/test/file.ts');
      const teaser = await SearchUtils.extractTeaser(uri, 0);

      expect(teaser).toContain('(Lines 1-3)');
    });

    it('should handle match at end of file', async () => {
      const mockDocument = {
        lineCount: 5,
        getText: jest.fn().mockReturnValue('line1\nline2\nline3')
      };
      mockOpenTextDocument.mockResolvedValue(mockDocument);
      (vscode.workspace.openTextDocument as jest.Mock) = mockOpenTextDocument;

      const uri = vscode.Uri.file('/test/file.ts');
      const teaser = await SearchUtils.extractTeaser(uri, 4);

      expect(teaser).toContain('(Lines 3-5)');
    });

    it('should handle single line file', async () => {
      const mockDocument = {
        lineCount: 1,
        getText: jest.fn().mockReturnValue('single line')
      };
      mockOpenTextDocument.mockResolvedValue(mockDocument);
      (vscode.workspace.openTextDocument as jest.Mock) = mockOpenTextDocument;

      const uri = vscode.Uri.file('/test/file.ts');
      const teaser = await SearchUtils.extractTeaser(uri, 0);

      expect(teaser).toContain('(Lines 1-1)');
      expect(teaser).toContain('single line');
    });

    it('should return error message when document cannot be opened', async () => {
      mockOpenTextDocument.mockRejectedValue(new Error('File not found'));
      (vscode.workspace.openTextDocument as jest.Mock) = mockOpenTextDocument;

      const uri = vscode.Uri.file('/test/nonexistent.ts');
      const teaser = await SearchUtils.extractTeaser(uri, 0);

      expect(teaser).toBe('(Unable to load preview)');
    });

    it('should handle very small files correctly', async () => {
      const mockDocument = {
        lineCount: 2,
        getText: jest.fn().mockReturnValue('line1\nline2')
      };
      mockOpenTextDocument.mockResolvedValue(mockDocument);
      (vscode.workspace.openTextDocument as jest.Mock) = mockOpenTextDocument;

      const uri = vscode.Uri.file('/test/file.ts');
      const teaser = await SearchUtils.extractTeaser(uri, 1);

      expect(teaser).toContain('(Lines 1-2)');
    });
  });
});















