/**
 * Tests for Search & File Ledger
 */

import {
  normalizeQuery,
  isPatternSuperset,
  isSearchDuplicate,
  isFileAlreadyOpened,
  addSearchRecord,
  addStaticAnalysisRecord,
  renderLedgerSummary,
  LedgerState
} from '../searchFileLedger';

describe('searchFileLedger', () => {
  describe('normalizeQuery', () => {
    it('should normalize query variants to same norm', () => {
      expect(normalizeQuery('passwordEmailSent')).toBe('passwordemailsent');
      expect(normalizeQuery('PasswordEmailSent')).toBe('passwordemailsent');
      expect(normalizeQuery(' passwordEmailSent ')).toBe('passwordemailsent');
      expect(normalizeQuery('"passwordEmailSent"')).toBe('passwordemailsent');
      expect(normalizeQuery("'passwordEmailSent'")).toBe('passwordemailsent');
    });

    it('should handle API path normalization', () => {
      expect(normalizeQuery('/api/company-admin/users')).toBe('api/company-admin/users');
      expect(normalizeQuery('app/api/company-admin/users')).toBe('api/company-admin/users');
      expect(normalizeQuery('company-admin/users')).toBe('company-admin/users');
    });

    it('should collapse repeated slashes', () => {
      expect(normalizeQuery('app//api///users')).toBe('app/api/users');
    });

    it('should remove surrounding quotes', () => {
      expect(normalizeQuery('"test"')).toBe('test');
      expect(normalizeQuery("'test'")).toBe('test');
      expect(normalizeQuery('"test query"')).toBe('test query');
    });

    it('should handle empty and null inputs', () => {
      expect(normalizeQuery('')).toBe('');
      expect(normalizeQuery(null as any)).toBe('');
      expect(normalizeQuery(undefined as any)).toBe('');
    });
  });

  describe('isPatternSuperset', () => {
    it('should detect **/*.ts as superset of specific paths', () => {
      expect(isPatternSuperset('**/*.ts', 'app/api/company-admin/**')).toBe(true);
      expect(isPatternSuperset('**/*.ts', 'src/utils/helper.ts')).toBe(true);
    });

    it('should detect app/api/** as superset of app/api/company-admin/**', () => {
      expect(isPatternSuperset('app/api/**', 'app/api/company-admin/**')).toBe(true);
    });

    it('should NOT detect app/api/company-admin/** as superset of **/*.ts', () => {
      expect(isPatternSuperset('app/api/company-admin/**', '**/*.ts')).toBe(false);
    });

    it('should handle undefined patterns', () => {
      expect(isPatternSuperset(undefined, 'app/api/**')).toBe(false);
      expect(isPatternSuperset('app/api/**', undefined)).toBe(false);
      expect(isPatternSuperset(undefined, undefined)).toBe(false);
    });
  });

  describe('isSearchDuplicate', () => {
    let state: LedgerState;

    beforeEach(() => {
      state = {
        searches: [],
        openedFiles: []
      };
    });

    it('should detect exact duplicate (same queryNorm, mode, pattern)', () => {
      state.searches.push({
        queryRaw: 'passwordEmailSent',
        queryNorm: 'passwordemailsent',
        mode: 'symbol',
        pattern: 'src/**/*.ts',
        timestamp: Date.now(),
        resultCount: 5,
        topFiles: ['src/auth.ts', 'src/user.ts']
      });

      const result = isSearchDuplicate(state, 'passwordemailsent', 'symbol', 'src/**/*.ts');
      expect(result.isDuplicate).toBe(true);
      expect(result.previousRecord).toBeDefined();
    });

    it('should detect widening duplicate (pattern superset)', () => {
      state.searches.push({
        queryRaw: 'passwordEmailSent',
        queryNorm: 'passwordemailsent',
        mode: 'symbol',
        pattern: 'app/api/company-admin/**',
        timestamp: Date.now()
      });

      // New search with broader pattern
      const result = isSearchDuplicate(state, 'passwordemailsent', 'symbol', '**/*.ts');
      expect(result.isDuplicate).toBe(true);
    });

    it('should detect variant duplicate (same queryNorm regardless of casing/quotes)', () => {
      state.searches.push({
        queryRaw: 'PasswordEmailSent',
        queryNorm: 'passwordemailsent',
        mode: 'symbol',
        timestamp: Date.now()
      });

      const result = isSearchDuplicate(state, 'passwordemailsent', 'symbol');
      expect(result.isDuplicate).toBe(true);
    });

    it('should NOT detect duplicate for different queryNorm', () => {
      state.searches.push({
        queryRaw: 'passwordEmailSent',
        queryNorm: 'passwordemailsent',
        mode: 'symbol',
        timestamp: Date.now()
      });

      const result = isSearchDuplicate(state, 'differentquery', 'symbol');
      expect(result.isDuplicate).toBe(false);
    });

    it('should NOT detect duplicate for different mode', () => {
      state.searches.push({
        queryRaw: 'passwordEmailSent',
        queryNorm: 'passwordemailsent',
        mode: 'symbol',
        timestamp: Date.now()
      });

      const result = isSearchDuplicate(state, 'passwordemailsent', 'text');
      expect(result.isDuplicate).toBe(false);
    });
  });

  describe('isFileAlreadyOpened', () => {
    let state: LedgerState;

    beforeEach(() => {
      state = {
        searches: [],
        openedFiles: []
      };
    });

    it('should detect exact duplicate (same filePath, mode, target)', () => {
      state.openedFiles.push({
        filePath: 'src/auth.ts',
        mode: 'source',
        target: 'login',
        timestamp: Date.now()
      });

      const result = isFileAlreadyOpened(state, 'src/auth.ts', 'source', 'login');
      expect(result.isDuplicate).toBe(true);
      expect(result.previousRecord).toBeDefined();
    });

    it('should detect mode-only match (same filePath, same mode, no target)', () => {
      state.openedFiles.push({
        filePath: 'src/auth.ts',
        mode: 'source',
        timestamp: Date.now()
      });

      const result = isFileAlreadyOpened(state, 'src/auth.ts', 'source');
      expect(result.isDuplicate).toBe(true);
    });

    it('should allow new analysis when target is specified', () => {
      state.openedFiles.push({
        filePath: 'src/auth.ts',
        mode: 'source',
        timestamp: Date.now()
      });

      // New request with target should be allowed (different analysis)
      const result = isFileAlreadyOpened(state, 'src/auth.ts', 'source', 'login');
      expect(result.isDuplicate).toBe(false);
    });

    it('should NOT detect duplicate for different filePath', () => {
      state.openedFiles.push({
        filePath: 'src/auth.ts',
        mode: 'source',
        timestamp: Date.now()
      });

      const result = isFileAlreadyOpened(state, 'src/user.ts', 'source');
      expect(result.isDuplicate).toBe(false);
    });

    it('should NOT detect duplicate for different mode', () => {
      state.openedFiles.push({
        filePath: 'src/auth.ts',
        mode: 'source',
        timestamp: Date.now()
      });

      const result = isFileAlreadyOpened(state, 'src/auth.ts', 'flow');
      expect(result.isDuplicate).toBe(false);
    });
  });

  describe('addSearchRecord', () => {
    it('should add search record immutably', () => {
      const state: LedgerState = {
        searches: [],
        openedFiles: []
      };

      const newState = addSearchRecord(state, {
        queryRaw: 'test',
        queryNorm: 'test',
        mode: 'symbol',
        resultCount: 3,
        topFiles: ['file1.ts', 'file2.ts']
      });

      expect(newState.searches.length).toBe(1);
      expect(newState.searches[0].queryNorm).toBe('test');
      expect(newState.searches[0].timestamp).toBeDefined();
      // Original state should not be modified
      expect(state.searches.length).toBe(0);
    });
  });

  describe('addStaticAnalysisRecord', () => {
    it('should add static analysis record immutably', () => {
      const state: LedgerState = {
        searches: [],
        openedFiles: []
      };

      const newState = addStaticAnalysisRecord(state, {
        filePath: 'src/auth.ts',
        mode: 'source',
        target: 'login',
        summary: 'Login function found'
      });

      expect(newState.openedFiles.length).toBe(1);
      expect(newState.openedFiles[0].filePath).toBe('src/auth.ts');
      expect(newState.openedFiles[0].timestamp).toBeDefined();
      // Original state should not be modified
      expect(state.openedFiles.length).toBe(0);
    });
  });

  describe('renderLedgerSummary', () => {
    it('should render empty ledger summary', () => {
      const state: LedgerState = {
        searches: [],
        openedFiles: []
      };

      const summary = renderLedgerSummary(state);
      expect(summary).toContain('Reminder');
      expect(summary.length).toBeLessThan(1200);
    });

    it('should render recent searches', () => {
      const state: LedgerState = {
        searches: [
          {
            queryRaw: 'test',
            queryNorm: 'test',
            mode: 'symbol',
            pattern: 'src/**/*.ts',
            timestamp: Date.now(),
            resultCount: 5,
            topFiles: ['file1.ts', 'file2.ts', 'file3.ts']
          }
        ],
        openedFiles: []
      };

      const summary = renderLedgerSummary(state);
      expect(summary).toContain('Recent Searches');
      expect(summary).toContain('q=test');
      expect(summary).toContain('mode=symbol');
      expect(summary).toContain('hits=5');
      expect(summary.length).toBeLessThan(1200);
    });

    it('should render opened files', () => {
      const state: LedgerState = {
        searches: [],
        openedFiles: [
          {
            filePath: 'src/auth.ts',
            mode: 'source',
            target: 'login',
            timestamp: Date.now()
          }
        ]
      };

      const summary = renderLedgerSummary(state);
      expect(summary).toContain('Opened Files');
      expect(summary).toContain('src/auth.ts');
      expect(summary).toContain('source');
      expect(summary.length).toBeLessThan(1200);
    });

    it('should include Best Candidate Files section', () => {
      const state: LedgerState = {
        searches: [
          {
            queryRaw: 'test',
            queryNorm: 'test',
            mode: 'symbol',
            timestamp: Date.now(),
            resultCount: 3,
            topFiles: ['file1.ts', 'file2.ts', 'file3.ts']
          }
        ],
        openedFiles: []
      };

      const summary = renderLedgerSummary(state);
      expect(summary).toContain('Best Candidate Files');
      expect(summary).toContain('file1.ts');
      expect(summary.length).toBeLessThan(1200);
    });

    it('should include Next Action Suggestion', () => {
      const state: LedgerState = {
        searches: [
          {
            queryRaw: 'test',
            queryNorm: 'test',
            mode: 'symbol',
            timestamp: Date.now(),
            resultCount: 3,
            topFiles: ['file1.ts']
          }
        ],
        openedFiles: []
      };

      const summary = renderLedgerSummary(state);
      expect(summary).toContain('Next Action Suggestion');
      expect(summary).toContain('Run static-analysis on file1.ts');
      expect(summary.length).toBeLessThan(1200);
    });

    it('should respect 1200 char limit by dropping older entries', () => {
      const state: LedgerState = {
        searches: Array.from({ length: 20 }, (_, i) => ({
          queryRaw: `test${i}`,
          queryNorm: `test${i}`,
          mode: 'symbol' as const,
          timestamp: Date.now() + i,
          resultCount: 10,
          topFiles: [`file${i}1.ts`, `file${i}2.ts`, `file${i}3.ts`]
        })),
        openedFiles: Array.from({ length: 20 }, (_, i) => ({
          filePath: `src/file${i}.ts`,
          mode: 'source',
          timestamp: Date.now() + i
        }))
      };

      const summary = renderLedgerSummary(state);
      expect(summary.length).toBeLessThanOrEqual(1200);
    });

    it('should not include raw code content', () => {
      const state: LedgerState = {
        searches: [
          {
            queryRaw: 'test',
            queryNorm: 'test',
            mode: 'symbol',
            timestamp: Date.now(),
            resultCount: 1,
            topFiles: ['file1.ts']
          }
        ],
        openedFiles: [
          {
            filePath: 'src/auth.ts',
            mode: 'source',
            timestamp: Date.now(),
            summary: 'Login function found' // Non-code summary
          }
        ]
      };

      const summary = renderLedgerSummary(state);
      // Should not contain code-like patterns
      expect(summary).not.toMatch(/\{[^}]*\}/); // No code blocks
      expect(summary).not.toMatch(/function\s+\w+/); // No function declarations
      expect(summary.length).toBeLessThan(1200);
    });

    it('should show most recent entries last', () => {
      const now = Date.now();
      const state: LedgerState = {
        searches: [
          {
            queryRaw: 'old',
            queryNorm: 'old',
            mode: 'symbol' as const,
            timestamp: now - 1000,
            resultCount: 1
          },
          {
            queryRaw: 'new',
            queryNorm: 'new',
            mode: 'symbol' as const,
            timestamp: now,
            resultCount: 1
          }
        ],
        openedFiles: []
      };

      const summary = renderLedgerSummary(state);
      const oldIndex = summary.indexOf('q=old');
      const newIndex = summary.indexOf('q=new');
      // New should appear after old (most recent last)
      expect(newIndex).toBeGreaterThan(oldIndex);
    });
  });
});

