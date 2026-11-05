/**
 * Tests for EvidenceParser
 */

import { EvidenceParser } from '../EvidenceParser';

// Mock fs module
jest.mock('fs', () => ({
  existsSync: jest.fn(),
  readFileSync: jest.fn(),
  readdirSync: jest.fn(),
  statSync: jest.fn()
}));

describe('EvidenceParser', () => {
  let evidenceParser: EvidenceParser;
  let mockFs: any;

  beforeEach(() => {
    evidenceParser = new EvidenceParser('/test/workspace');
    mockFs = require('fs');
    jest.clearAllMocks();
  });

  describe('parseEvidence', () => {
    it('should parse complete evidence from logs', () => {
      const logs = `
Error: Cannot read property 'name' of undefined
    at getUser (/app/src/api/user.ts:15:8)
    at processRequest (/app/src/handlers/request.ts:23:5)
    at Object.handler (/app/src/index.ts:10:1)

POST /api/users
requestId: abc123-def456-ghi789
      `;

      const evidence = evidenceParser.parseEvidence({
        userMessage: 'User API is failing',
        logs,
        workspace: '/test/workspace'
      });

      expect(evidence.frames).toHaveLength(3);
      expect(evidence.error).toBe('Error: Cannot read property \'name\' of undefined');
      expect(evidence.requestId).toBe('abc123-def456-ghi789');
      expect(evidence.route).toBe('/api/users');
      expect(evidence.logSignatures).toBeDefined();
      expect(evidence.warnings).toBeDefined();
      expect(evidence.confidence).toBeGreaterThan(0);
    });

    it('should handle JSON logs from Pino/Winston', () => {
      const jsonLogs = `
{"level":"error","time":"2024-01-15T10:30:00Z","msg":"User API failed","err":{"message":"Cannot read property 'name' of undefined","stack":"Error: Cannot read property 'name' of undefined\\n    at getUser (/app/src/api/user.ts:15:8)"},"req":{"id":"abc123-def456-ghi789","method":"POST","url":"/api/users"}}
{"level":"info","time":"2024-01-15T10:30:01Z","msg":"Request completed"}
      `;

      const evidence = evidenceParser.parseEvidence({
        userMessage: 'JSON log test',
        logs: jsonLogs,
        workspace: '/test/workspace'
      });

      expect(evidence.error).toBe('Cannot read property \'name\' of undefined');
      expect(evidence.requestId).toBe('abc123-def456-ghi789');
      expect(evidence.route).toBe('/api/users');
      expect(evidence.frames).toHaveLength(1);
      expect(evidence.frames[0].file).toBe('/app/src/api/user.ts');
      expect(evidence.frames[0].line).toBe(15);
    });

    it('should handle mixed JSON and text logs', () => {
      const mixedLogs = `
{"level":"error","msg":"Database error","err":{"stack":"Error: Connection failed\\n    at connect (db.js:10:5)"}}
Regular log line with error
Error: Something went wrong
      `;

      const evidence = evidenceParser.parseEvidence({
        userMessage: 'Mixed log test',
        logs: mixedLogs,
        workspace: '/test/workspace'
      });

      expect(evidence.error).toBe('Database error');
      expect(evidence.frames).toHaveLength(1);
      expect(evidence.frames[0].file).toBe('db.js');
      expect(evidence.frames[0].line).toBe(10);
    });

    it('should set hasLogs and evidenceSource correctly when no logs provided', () => {
      const evidence = evidenceParser.parseEvidence({
        userMessage: 'No logs provided',
        logs: '',
        workspace: '/test/workspace'
      });

      expect(evidence.hasLogs).toBe(false);
      expect(evidence.evidenceSource).toBe('user_description');
    });

    it('should set hasLogs and evidenceSource correctly when logs provided with errors', () => {
      const logs = 'Error: Something went wrong\n    at test.js:1:1';
      
      const evidence = evidenceParser.parseEvidence({
        userMessage: 'Test with errors',
        logs,
        workspace: '/test/workspace'
      });

      expect(evidence.hasLogs).toBe(true);
      expect(evidence.evidenceSource).toBe('logs');
      expect(evidence.hasHardError).toBe(true);
    });

    it('should set hasLogs and evidenceSource correctly when logs provided without errors', () => {
      const logs = 'INFO: Application started\nDEBUG: Loading configuration\nINFO: Server listening on port 3000';
      
      const evidence = evidenceParser.parseEvidence({
        userMessage: 'Test with info logs',
        logs,
        workspace: '/test/workspace'
      });

      expect(evidence.hasLogs).toBe(true);
      expect(evidence.evidenceSource).toBe('logs');
      expect(evidence.hasHardError).toBe(false);
    });

    it('should set hasLogs and evidenceSource correctly when logs provided with soft signals', () => {
      const logs = 'WARN: API request failed with status 500\nINFO: Database connection timeout';
      
      const evidence = evidenceParser.parseEvidence({
        userMessage: 'Test with soft signals',
        logs,
        workspace: '/test/workspace'
      });

      expect(evidence.hasLogs).toBe(true);
      expect(evidence.evidenceSource).toBe('logs');
      expect(evidence.hasHardError).toBe(false);
      expect(evidence.softSignals).toBeDefined();
      expect(evidence.softSignals!.length).toBeGreaterThan(0);
    });
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
        userMessage: 'Node.js test',
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
        userMessage: 'Jest test',
        logs,
        workspace: '/test/workspace'
      });

      expect(evidence.frames).toHaveLength(2);
      expect(evidence.frames[0]).toEqual({
        file: 'src/api/user.test.ts',
        line: 25,
        fn: 'Object.getUser',
        column: 10
      });
    });

    it('should parse ESM file:// URLs', () => {
      const logs = `
Error: Module not found
    at Module.Job.run (file:///app/src/worker.js:10:5)
    at Module.runMain (file:///app/src/index.js:15:3)
      `;

      const evidence = evidenceParser.parseEvidence({
        userMessage: 'ESM test',
        logs,
        workspace: '/test/workspace'
      });

      expect(evidence.frames).toHaveLength(2);
      expect(evidence.frames[0].file).toBe('/app/src/worker.js');
      expect(evidence.frames[0].line).toBe(10);
    });

    it('should parse Windows paths', () => {
      const logs = `
Error: Path error
    at processFile (C:\\Users\\test\\src\\file.js:20:10)
    at main (C:\\Users\\test\\src\\index.js:5:1)
      `;

      const evidence = evidenceParser.parseEvidence({
        userMessage: 'Windows test',
        logs,
        workspace: '/test/workspace'
      });

      expect(evidence.frames).toHaveLength(2);
      expect(evidence.frames[0].file).toBe('C:/Users/test/src/file.js');
      expect(evidence.frames[0].line).toBe(20);
    });

    it('should filter out internal Node.js frames', () => {
      const logs = `
Error: Test error
    at getUser (/app/src/api/user.ts:15:8)
    at process._tickCallback (internal/process/next_tick.js:68:7)
    at processRequest (/app/src/handlers/request.ts:23:5)
    at <anonymous> (/app/src/index.ts:10:1)
      `;

      const evidence = evidenceParser.parseEvidence({
        userMessage: 'Filter test',
        logs,
        workspace: '/test/workspace'
      });

      // Should include app frames, but may include some anonymous frames
      expect(evidence.frames.length).toBeGreaterThanOrEqual(2);
      expect(evidence.frames[0].file).toBe('/app/src/api/user.ts');
      expect(evidence.frames[1].file).toBe('/app/src/handlers/request.ts');
    });

    it('should deduplicate frames by file:line', () => {
      const logs = `
Error: Duplicate test
    at getUser (/app/src/api/user.ts:15:8)
    at processRequest (/app/src/handlers/request.ts:23:5)
    at getUser (/app/src/api/user.ts:15:8)
    at processRequest (/app/src/handlers/request.ts:23:5)
      `;

      const evidence = evidenceParser.parseEvidence({
        userMessage: 'Dedupe test',
        logs,
        workspace: '/test/workspace'
      });

      expect(evidence.frames).toHaveLength(2);
    });
  });

  describe('extractLogMetadata', () => {
    it('should extract error messages from various formats', () => {
      const testCases = [
        {
          logs: 'TypeError: Cannot read property \'name\' of undefined',
          expected: 'TypeError: Cannot read property \'name\' of undefined'
        },
        {
          logs: 'ReferenceError: user is not defined',
          expected: 'ReferenceError: user is not defined'
        },
        {
          logs: 'Module parse failed: Unexpected token',
          expected: 'Module parse failed: Unexpected token'
        }
      ];

      testCases.forEach(({ logs, expected }) => {
        const evidence = evidenceParser.parseEvidence({
          userMessage: 'Error test',
          logs,
          workspace: '/test/workspace'
        });
        expect(evidence.error).toBe(expected);
      });
    });

    it('should extract request IDs from various formats', () => {
      const testCases = [
        'requestId: abc123-def456-ghi789',
        'reqId: xyz789-uvw456-rst123',
        'correlationId: corr-123-456',
        'traceId: trace-abc-def',
        'x-request-id: req-123-456',
        'uuid: 550e8400-e29b-41d4-a716-446655440000'
      ];

      testCases.forEach(logs => {
        const evidence = evidenceParser.parseEvidence({
          userMessage: 'ID test',
          logs,
          workspace: '/test/workspace'
        });
        expect(evidence.requestId).toBeTruthy();
        expect(evidence.requestId).toMatch(/[a-zA-Z0-9_.:-]{6,}/);
      });
    });

    it('should extract routes from HTTP requests', () => {
      const testCases = [
        'POST /api/users',
        'GET /api/users/123',
        'PUT /api/users/123/profile',
        'DELETE /api/users/123',
        'route: /api/auth/login'
      ];

      testCases.forEach(logs => {
        const evidence = evidenceParser.parseEvidence({
          userMessage: 'Route test',
          logs,
          workspace: '/test/workspace'
        });
        expect(evidence.route).toBeTruthy();
        expect(evidence.route).toMatch(/^\/api\//);
      });
    });

    it('should extract from JSON logs', () => {
      const jsonLogs = `
{"level":"error","msg":"API failed","err":{"message":"Database error"},"req":{"id":"req-123","method":"POST","url":"/api/users"}}
      `;

      const evidence = evidenceParser.parseEvidence({
        userMessage: 'JSON metadata test',
        logs: jsonLogs,
        workspace: '/test/workspace'
      });

      expect(evidence.error).toBe('Database error');
      expect(evidence.requestId).toBe('req-123');
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
        userMessage: 'Signature test',
        logs,
        workspace: '/test/workspace'
      });

      expect(evidence.logSignatures).toBeDefined();
      expect(evidence.logSignatures!.length).toBeGreaterThan(0);
      
      // Should contain normalized patterns
      const signatures = evidence.logSignatures!.join(' ');
      expect(signatures).toContain('[INFO]');
      expect(signatures).toContain('[ERROR]');
    });

    it('should preserve important structure while normalizing', () => {
      const logs = `
HTTP 404 Not Found
HTTP 500 Internal Server Error
User ID 12345 processed
Transaction ID 67890 completed
      `;

      const evidence = evidenceParser.parseEvidence({
        userMessage: 'Structure test',
        logs,
        workspace: '/test/workspace'
      });

      const signatures = evidence.logSignatures!.join(' ');
      // Should keep 3-digit codes (HTTP status)
      expect(signatures).toContain('404');
      expect(signatures).toContain('500');
      // Should normalize longer numbers
      expect(signatures).toContain('[LONGNUM]');
    });
  });

  describe('resolveTsconfigPaths', () => {
    it('should resolve tsconfig paths when file exists', () => {
      mockFs.existsSync.mockReturnValue(true);
      mockFs.readFileSync.mockReturnValue(JSON.stringify({
        compilerOptions: {
          baseUrl: '.',
          paths: {
            '@/*': ['./src/*'],
            '@/api/*': ['./src/api/*']
          }
        }
      }));

      const evidence = evidenceParser.parseEvidence({
        userMessage: 'Test',
        logs: '',
        workspace: '/test/workspace'
      });

      expect(evidence.tsconfigPaths).toEqual({
        '@/*': ['/test/workspace/src'],
        '@/api/*': ['/test/workspace/src/api']
      });
    });

    it('should handle jsconfig.json fallback', () => {
      mockFs.existsSync.mockImplementation((path: string) => {
        return path.includes('jsconfig.json');
      });
      mockFs.readFileSync.mockReturnValue(JSON.stringify({
        compilerOptions: {
          baseUrl: '.',
          paths: {
            '@/*': ['./src/*']
          }
        }
      }));

      const evidence = evidenceParser.parseEvidence({
        userMessage: 'Test',
        logs: '',
        workspace: '/test/workspace'
      });

      expect(evidence.tsconfigPaths).toEqual({
        '@/*': ['/test/workspace/src']
      });
    });

    it('should handle extends in tsconfig', () => {
      mockFs.existsSync.mockReturnValue(true);
      mockFs.readFileSync.mockImplementation((path: string) => {
        if (path.includes('tsconfig.base.json')) {
          return JSON.stringify({
            compilerOptions: {
              baseUrl: '.',
              paths: {
                '@/*': ['./src/*']
              }
            }
          });
        }
        return JSON.stringify({
          extends: './tsconfig.base.json',
          compilerOptions: {
            baseUrl: '.',
            paths: {
              '@/*': ['./src/*'],
              '@/api/*': ['./src/api/*']
            }
          }
        });
      });

      const evidence = evidenceParser.parseEvidence({
        userMessage: 'Test',
        logs: '',
        workspace: '/test/workspace'
      });

      expect(evidence.tsconfigPaths).toEqual({
        '@/*': ['/test/workspace/src'],
        '@/api/*': ['/test/workspace/src/api']
      });
    });

    it('should return empty object when no config found', () => {
      mockFs.existsSync.mockReturnValue(false);

      const evidence = evidenceParser.parseEvidence({
        userMessage: 'Test',
        logs: '',
        workspace: '/test/workspace'
      });

      expect(evidence.tsconfigPaths).toEqual({});
    });
  });

  describe('warnings and confidence', () => {
    it('should generate warnings for missing evidence', () => {
      const evidence = evidenceParser.parseEvidence({
        userMessage: 'Test',
        logs: 'Just some random text',
        workspace: '/test/workspace'
      });

      expect(evidence.warnings).toBeDefined();
      expect(evidence.warnings!.length).toBeGreaterThan(0);
      expect(evidence.warnings).toContain('No stack frames resolved');
      expect(evidence.warnings).toContain('No error message extracted');
    });

    it('should calculate confidence based on evidence quality', () => {
      const goodEvidence = evidenceParser.parseEvidence({
        userMessage: 'Good test',
        logs: `
Error: Test error
    at test (/app/src/test.ts:10:5)
POST /api/test
requestId: test-123
        `,
        workspace: '/test/workspace'
      });

      const poorEvidence = evidenceParser.parseEvidence({
        userMessage: 'Poor test',
        logs: 'Just some text',
        workspace: '/test/workspace'
      });

      expect(goodEvidence.confidence).toBeGreaterThan(poorEvidence.confidence);
      expect(goodEvidence.confidence).toBeGreaterThan(0.5);
      expect(poorEvidence.confidence).toBeLessThan(0.5);
    });

    it('should have higher confidence with more evidence', () => {
      const evidence1 = evidenceParser.parseEvidence({
        userMessage: 'Test 1',
        logs: 'Error: Test',
        workspace: '/test/workspace'
      });

      const evidence2 = evidenceParser.parseEvidence({
        userMessage: 'Test 2',
        logs: `
Error: Test error
    at test (/app/src/test.ts:10:5)
POST /api/test
requestId: test-123
        `,
        workspace: '/test/workspace'
      });

      expect(evidence2.confidence).toBeGreaterThan(evidence1.confidence);
    });
  });

  describe('edge cases', () => {
    it('should handle empty logs', () => {
      const evidence = evidenceParser.parseEvidence({
        userMessage: 'Empty test',
        logs: '',
        workspace: '/test/workspace'
      });

      expect(evidence.frames).toHaveLength(0);
      expect(evidence.error).toBeUndefined();
      expect(evidence.warnings).toContain('No stack frames resolved');
    });

    it('should handle malformed JSON logs', () => {
      const logs = `
{"level":"error","msg":"Test"
{"level":"info","msg":"Another test"}
      `;

      const evidence = evidenceParser.parseEvidence({
        userMessage: 'Malformed JSON test',
        logs,
        workspace: '/test/workspace'
      });

      // Should fall back to regex parsing
      expect(evidence).toBeDefined();
    });

    it('should handle very long log files', () => {
      const longLogs = Array(1000).fill('Some log message').join('\n');
      
      const evidence = evidenceParser.parseEvidence({
        userMessage: 'Long log test',
        logs: longLogs,
        workspace: '/test/workspace'
      });

      expect(evidence).toBeDefined();
      expect(evidence.logSignatures).toBeDefined();
    });
  });
});