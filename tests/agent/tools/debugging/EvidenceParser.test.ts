/**
 * Tests for EvidenceParser
 */

import { EvidenceParser } from '../../../src/agent/tools/debugging/EvidenceParser';

describe('EvidenceParser', () => {
  let evidenceParser: EvidenceParser;

  beforeEach(() => {
    evidenceParser = new EvidenceParser('/test/workspace');
  });

  describe('parseStackTrace', () => {
    it('should parse Node.js stack trace format', () => {
      const logs = `
        Error: Cannot read property 'name' of undefined
            at getUser (/app/src/api/user.ts:15:8)
            at processRequest (/app/src/handlers/request.ts:23:5)
            at Object.handler (/app/src/index.ts:10:1)
      `;

      const evidence = evidenceParser.parseEvidence({
        userMessage: 'User API is failing',
        logs,
        workspace: '/test/workspace'
      });

      expect(evidence.frames).toHaveLength(3);
      expect(evidence.frames[0]).toEqual({
        file: '/app/src/api/user.ts',
        line: 15,
        fn: 'getUser',
        column: 8
      });
      expect(evidence.frames[1]).toEqual({
        file: '/app/src/handlers/request.ts',
        line: 23,
        fn: 'processRequest',
        column: 5
      });
    });

    it('should parse Jest stack trace format', () => {
      const logs = `
        TypeError: Cannot read property 'name' of undefined
            at Object.getUser (src/api/user.test.ts:25:10)
            at Object.<anonymous> (src/api/user.test.ts:30:5)
      `;

      const evidence = evidenceParser.parseEvidence({
        userMessage: 'Test is failing',
        logs,
        workspace: '/test/workspace'
      });

      expect(evidence.frames).toHaveLength(2);
      expect(evidence.frames[0]).toEqual({
        file: 'src/api/user.test.ts',
        line: 25,
        fn: 'getUser',
        column: 10
      });
    });

    it('should parse Next.js API route stack trace', () => {
      const logs = `
        Error: API route error
            at handler (pages/api/users.ts:12:15)
            at processRequest (pages/api/users.ts:8:3)
      `;

      const evidence = evidenceParser.parseEvidence({
        userMessage: 'API route error',
        logs,
        workspace: '/test/workspace'
      });

      expect(evidence.frames).toHaveLength(2);
      expect(evidence.frames[0].file).toBe('pages/api/users.ts');
      expect(evidence.frames[0].line).toBe(12);
    });
  });

  describe('extractLogMetadata', () => {
    it('should extract error messages', () => {
      const logs = `
        TypeError: Cannot read property 'name' of undefined
        ReferenceError: user is not defined
        SyntaxError: Unexpected token
      `;

      const evidence = evidenceParser.parseEvidence({
        userMessage: 'Multiple errors',
        logs,
        workspace: '/test/workspace'
      });

      expect(evidence.error).toBe("Cannot read property 'name' of undefined");
    });

    it('should extract request ID', () => {
      const logs = `
        requestId: abc123-def456-ghi789
        Error: Something went wrong
      `;

      const evidence = evidenceParser.parseEvidence({
        userMessage: 'Request error',
        logs,
        workspace: '/test/workspace'
      });

      expect(evidence.requestId).toBe('abc123-def456-ghi789');
    });

    it('should extract route information', () => {
      const logs = `
        POST /api/users
        Error: Validation failed
        GET /api/users/123
      `;

      const evidence = evidenceParser.parseEvidence({
        userMessage: 'API error',
        logs,
        workspace: '/test/workspace'
      });

      expect(evidence.route).toBe('/api/users');
    });
  });

  describe('normalizeLogSignatures', () => {
    it('should normalize and deduplicate log messages', () => {
      const logs = `
        2024-01-15T10:30:00Z [INFO] User login successful
        2024-01-15T10:30:01Z [ERROR] Database connection failed
        2024-01-15T10:30:02Z [INFO] User login successful
        at getUser (src/api/user.ts:15:8)
        Error: Database connection failed
      `;

      const evidence = evidenceParser.parseEvidence({
        userMessage: 'Log analysis',
        logs,
        workspace: '/test/workspace'
      });

      expect(evidence.logSignatures).toContain('[INFO] User login successful');
      expect(evidence.logSignatures).toContain('[ERROR] Database connection failed');
      expect(evidence.logSignatures).toHaveLength(2);
    });
  });

  describe('resolveTsconfigPaths', () => {
    it('should resolve tsconfig paths when file exists', () => {
      // Mock fs.existsSync and fs.readFileSync
      const originalExistsSync = require('fs').existsSync;
      const originalReadFileSync = require('fs').readFileSync;
      
      require('fs').existsSync = jest.fn((path) => {
        if (path.includes('tsconfig.json')) return true;
        return originalExistsSync(path);
      });
      
      require('fs').readFileSync = jest.fn((path) => {
        if (path.includes('tsconfig.json')) {
          return JSON.stringify({
            compilerOptions: {
              baseUrl: '.',
              paths: {
                '@/*': ['./src/*'],
                '@/api/*': ['./src/api/*']
              }
            }
          });
        }
        return originalReadFileSync(path);
      });

      const evidence = evidenceParser.parseEvidence({
        userMessage: 'Test',
        logs: '',
        workspace: '/test/workspace'
      });

      expect(evidence.tsconfigPaths).toEqual({
        '@/*': '/test/workspace/src/*',
        '@/api/*': '/test/workspace/src/api/*'
      });

      // Restore original functions
      require('fs').existsSync = originalExistsSync;
      require('fs').readFileSync = originalReadFileSync;
    });
  });
});
