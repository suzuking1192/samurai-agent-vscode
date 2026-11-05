/**
 * Tests for DebugSessionLogger
 */

import { DebugSessionLogger } from '../DebugSessionLogger';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

// Mock fs module
jest.mock('fs', () => ({
  existsSync: jest.fn(),
  rmSync: jest.fn(),
  mkdirSync: jest.fn(),
  writeFileSync: jest.fn(),
}));

describe('DebugSessionLogger', () => {
  let mockFs: jest.Mocked<typeof fs>;
  let workspaceRoot: string;
  let sessionId: string;

  beforeEach(() => {
    jest.clearAllMocks();
    mockFs = fs as jest.Mocked<typeof fs>;
    
    // Create a temporary directory for testing
    workspaceRoot = path.join(os.tmpdir(), `test-workspace-${Date.now()}`);
    sessionId = 'test-session-123';
    
    // Setup default mocks
    (mockFs.existsSync as jest.Mock).mockReturnValue(false);
    (mockFs.mkdirSync as jest.Mock).mockImplementation(() => {});
    (mockFs.writeFileSync as jest.Mock).mockImplementation(() => {});
  });

  afterEach(() => {
    // Cleanup if directory was created
    try {
      if (fs.existsSync(workspaceRoot)) {
        fs.rmSync(workspaceRoot, { recursive: true, force: true });
      }
    } catch (e) {
      // Ignore cleanup errors
    }
  });

  describe('constructor', () => {
    it('should create output directory and initialize session info', () => {
      const logger = new DebugSessionLogger(sessionId, workspaceRoot);

      const expectedDir = path.join(workspaceRoot, 'debug-output', 'active-session');
      
      // Should check if directory exists
      expect(mockFs.existsSync).toHaveBeenCalledWith(expectedDir);
      
      // Should create directory
      expect(mockFs.mkdirSync).toHaveBeenCalledWith(expectedDir, { recursive: true });
      
      // Should write session info file
      expect(mockFs.writeFileSync).toHaveBeenCalledWith(
        path.join(expectedDir, '00-session-info.json'),
        expect.stringContaining(sessionId),
        'utf8'
      );
    });

    it('should wipe existing directory before creating new one', () => {
      (mockFs.existsSync as jest.Mock).mockReturnValue(true);
      
      const logger = new DebugSessionLogger(sessionId, workspaceRoot);

      const expectedDir = path.join(workspaceRoot, 'debug-output', 'active-session');
      
      // Should delete existing directory
      expect(mockFs.rmSync).toHaveBeenCalledWith(expectedDir, { recursive: true, force: true });
      
      // Should create new directory
      expect(mockFs.mkdirSync).toHaveBeenCalledWith(expectedDir, { recursive: true });
    });

    it('should handle directory initialization errors gracefully', () => {
      const consoleErrorSpy = jest.spyOn(console, 'error').mockImplementation();
      (mockFs.mkdirSync as jest.Mock).mockImplementation(() => {
        throw new Error('Permission denied');
      });

      // Should not throw
      expect(() => {
        new DebugSessionLogger(sessionId, workspaceRoot);
      }).not.toThrow();

      expect(consoleErrorSpy).toHaveBeenCalledWith(
        expect.stringContaining('[DebugSessionLogger]'),
        expect.any(Error)
      );

      consoleErrorSpy.mockRestore();
    });
  });

  describe('logUserRequest', () => {
    it('should save user request to file', () => {
      const logger = new DebugSessionLogger(sessionId, workspaceRoot);
      const query = 'Find the bug in auth.ts';
      const logs = 'Error: Cannot read property';

      logger.logUserRequest(query, logs);

      const expectedPath = path.join(workspaceRoot, 'debug-output', 'active-session', '01-user-request.txt');
      expect(mockFs.writeFileSync).toHaveBeenCalledWith(
        expectedPath,
        expect.stringContaining(query),
        'utf8'
      );
      expect(mockFs.writeFileSync).toHaveBeenCalledWith(
        expectedPath,
        expect.stringContaining(logs),
        'utf8'
      );
    });

    it('should handle missing logs', () => {
      const logger = new DebugSessionLogger(sessionId, workspaceRoot);
      const query = 'Find the bug';

      logger.logUserRequest(query);

      const expectedPath = path.join(workspaceRoot, 'debug-output', 'active-session', '01-user-request.txt');
      expect(mockFs.writeFileSync).toHaveBeenCalledWith(
        expectedPath,
        expect.stringContaining('Logs:\nNone'),
        'utf8'
      );
    });

    it('should handle write errors gracefully', () => {
      const consoleErrorSpy = jest.spyOn(console, 'error').mockImplementation();
      (mockFs.writeFileSync as jest.Mock).mockImplementation(() => {
        throw new Error('Disk full');
      });

      const logger = new DebugSessionLogger(sessionId, workspaceRoot);

      // Should not throw
      expect(() => {
        logger.logUserRequest('test query');
      }).not.toThrow();

      expect(consoleErrorSpy).toHaveBeenCalledWith(
        expect.stringContaining('[DebugSessionLogger]'),
        expect.any(Error)
      );

      consoleErrorSpy.mockRestore();
    });
  });

  describe('logEpicenter', () => {
    it('should save epicenter as JSON', () => {
      const logger = new DebugSessionLogger(sessionId, workspaceRoot);
      const epicenter = { file: '/path/to/file.ts', source: 'logs' };

      logger.logEpicenter(epicenter);

      const expectedPath = path.join(workspaceRoot, 'debug-output', 'active-session', '02-epicenter.json');
      expect(mockFs.writeFileSync).toHaveBeenCalledWith(
        expectedPath,
        JSON.stringify(epicenter, null, 2),
        'utf8'
      );
    });
  });

  describe('logGraph', () => {
    it('should save graph data as JSON', () => {
      const logger = new DebugSessionLogger(sessionId, workspaceRoot);
      const graphData = {
        mermaid: 'graph TD\nA[Test]',
        nodes: [{ id: 'A', label: 'Test' }],
        edges: []
      };

      logger.logGraph(graphData);

      const expectedPath = path.join(workspaceRoot, 'debug-output', 'active-session', '02-initial-graph.json');
      expect(mockFs.writeFileSync).toHaveBeenCalledWith(
        expectedPath,
        JSON.stringify(graphData, null, 2),
        'utf8'
      );
    });
  });

  describe('logStep', () => {
    it('should save step data with padded step numbers', () => {
      const logger = new DebugSessionLogger(sessionId, workspaceRoot);
      const stepData = { messages: [{ role: 'system', content: 'test' }] };

      logger.logStep(0, 'prompt', stepData);
      logger.logStep(1, 'response', { content: 'response' });
      logger.logStep(10, 'tools', { calls: [] });

      const expectedDir = path.join(workspaceRoot, 'debug-output', 'active-session');
      
      expect(mockFs.writeFileSync).toHaveBeenCalledWith(
        path.join(expectedDir, '03-step-00-prompt.json'),
        JSON.stringify(stepData, null, 2),
        'utf8'
      );
      
      expect(mockFs.writeFileSync).toHaveBeenCalledWith(
        path.join(expectedDir, '03-step-01-response.json'),
        JSON.stringify({ content: 'response' }, null, 2),
        'utf8'
      );
      
      expect(mockFs.writeFileSync).toHaveBeenCalledWith(
        path.join(expectedDir, '03-step-10-tools.json'),
        JSON.stringify({ calls: [] }, null, 2),
        'utf8'
      );
    });

    it('should handle all step types', () => {
      const logger = new DebugSessionLogger(sessionId, workspaceRoot);
      const testData = { test: 'data' };

      logger.logStep(5, 'prompt', testData);
      logger.logStep(5, 'response', testData);
      logger.logStep(5, 'tools', testData);
      logger.logStep(5, 'state', testData);

      const expectedDir = path.join(workspaceRoot, 'debug-output', 'active-session');
      const calls = (mockFs.writeFileSync as jest.Mock).mock.calls;
      
      const filenames = calls.map((call: any[]) => path.basename(call[0]));
      expect(filenames).toContain('03-step-05-prompt.json');
      expect(filenames).toContain('03-step-05-response.json');
      expect(filenames).toContain('03-step-05-tools.json');
      expect(filenames).toContain('03-step-05-state.json');
    });

    it('should handle string content', () => {
      const logger = new DebugSessionLogger(sessionId, workspaceRoot);
      const stringContent = 'This is a string';

      logger.logStep(2, 'prompt', stringContent);

      const expectedPath = path.join(workspaceRoot, 'debug-output', 'active-session', '03-step-02-prompt.json');
      expect(mockFs.writeFileSync).toHaveBeenCalledWith(
        expectedPath,
        stringContent,
        'utf8'
      );
    });
  });

  describe('generateSummary', () => {
    it('should generate summary with all checkpoint paths', () => {
      const logger = new DebugSessionLogger(sessionId, workspaceRoot);
      
      // Log some checkpoints first
      logger.logUserRequest('test query');
      logger.logEpicenter({ file: 'test.ts' });
      logger.logStep(0, 'prompt', { test: 'data' });

      // Generate summary
      logger.generateSummary({
        steps: 5,
        cost: 0.0123,
        filesAnalyzed: ['file1.ts', 'file2.ts']
      });

      const expectedPath = path.join(workspaceRoot, 'debug-output', 'active-session', '00-summary.txt');
      const summaryCall = (mockFs.writeFileSync as jest.Mock).mock.calls.find(
        (call: any[]) => call[0] === expectedPath
      );

      expect(summaryCall).toBeDefined();
      const summaryContent = summaryCall[1];
      
      expect(summaryContent).toContain('Session Summary');
      expect(summaryContent).toContain('Total Steps: 5');
      expect(summaryContent).toContain('Total Cost: $0.0123');
      expect(summaryContent).toContain('Files Analyzed: 2');
      expect(summaryContent).toContain('Files Generated:');
      expect(summaryContent).toContain('Checkpoints:');
      expect(summaryContent).toContain('01-user-request.txt');
      expect(summaryContent).toContain('02-epicenter.json');
      expect(summaryContent).toContain('03-step-00-prompt.json');
    });

    it('should handle missing optional metrics', () => {
      const logger = new DebugSessionLogger(sessionId, workspaceRoot);

      logger.generateSummary({
        steps: 3,
        cost: 0.005
      });

      const expectedPath = path.join(workspaceRoot, 'debug-output', 'active-session', '00-summary.txt');
      const summaryCall = (mockFs.writeFileSync as jest.Mock).mock.calls.find(
        (call: any[]) => call[0] === expectedPath
      );

      expect(summaryCall).toBeDefined();
      const summaryContent = summaryCall[1];
      
      expect(summaryContent).toContain('Total Steps: 3');
      expect(summaryContent).toContain('Total Cost: $0.0050');
      expect(summaryContent).toContain('Files Analyzed: 0');
    });
  });

  describe('logParseFailure', () => {
    it('should save parse failure with exact raw output', () => {
      const logger = new DebugSessionLogger(sessionId, workspaceRoot);
      const source = 'PlanningAgent.execute';
      const error = new Error('Unexpected token } in JSON at position 42');
      const rawContent = '{"thought": "test", "state_update": {}}';

      logger.logParseFailure(source, error, rawContent);

      const expectedPath = path.join(workspaceRoot, 'debug-output', 'active-session', 'json-parse-failure-latest.txt');
      expect(mockFs.writeFileSync).toHaveBeenCalledWith(
        expectedPath,
        expect.stringContaining('Timestamp:'),
        'utf8'
      );

      const writeCall = (mockFs.writeFileSync as jest.Mock).mock.calls.find(
        (call: any[]) => call[0] === expectedPath
      );
      expect(writeCall).toBeDefined();
      const content = writeCall[1];
      
      expect(content).toContain(`Source: ${source}`);
      expect(content).toContain(`Error: ${error.message}`);
      expect(content).toContain('Raw Output Length:');
      expect(content).toContain('=== RAW OUTPUT START ===');
      expect(content).toContain(rawContent);
      expect(content).toContain('=== RAW OUTPUT END ===');
    });

    it('should handle non-Error objects', () => {
      const logger = new DebugSessionLogger(sessionId, workspaceRoot);
      const source = 'ImageGenerationService';
      const error = 'Parse failed';
      const rawContent = 'invalid json {';

      logger.logParseFailure(source, error, rawContent);

      const expectedPath = path.join(workspaceRoot, 'debug-output', 'active-session', 'json-parse-failure-latest.txt');
      const writeCall = (mockFs.writeFileSync as jest.Mock).mock.calls.find(
        (call: any[]) => call[0] === expectedPath
      );
      const content = writeCall[1];
      
      expect(content).toContain(`Error: ${error}`);
    });

    it('should always overwrite previous failure (single latest file)', () => {
      const logger = new DebugSessionLogger(sessionId, workspaceRoot);
      const expectedPath = path.join(workspaceRoot, 'debug-output', 'active-session', 'json-parse-failure-latest.txt');

      // First failure
      logger.logParseFailure('Source1', new Error('Error 1'), 'content1');
      
      // Second failure - should overwrite
      logger.logParseFailure('Source2', new Error('Error 2'), 'content2');

      // Should be called twice with same path
      const calls = (mockFs.writeFileSync as jest.Mock).mock.calls.filter(
        (call: any[]) => call[0] === expectedPath
      );
      expect(calls.length).toBe(2);
      
      // Last call should have second failure content
      const lastContent = calls[1][1];
      expect(lastContent).toContain('Source2');
      expect(lastContent).toContain('Error 2');
      expect(lastContent).toContain('content2');
    });

    it('should handle empty raw content', () => {
      const logger = new DebugSessionLogger(sessionId, workspaceRoot);
      const error = new Error('Empty response');

      logger.logParseFailure('TestSource', error, '');

      const expectedPath = path.join(workspaceRoot, 'debug-output', 'active-session', 'json-parse-failure-latest.txt');
      const writeCall = (mockFs.writeFileSync as jest.Mock).mock.calls.find(
        (call: any[]) => call[0] === expectedPath
      );
      const content = writeCall[1];
      
      expect(content).toContain('Raw Output Length: 0');
    });

    it('should handle write errors gracefully', () => {
      const consoleErrorSpy = jest.spyOn(console, 'error').mockImplementation();
      (mockFs.writeFileSync as jest.Mock).mockImplementation(() => {
        throw new Error('Disk full');
      });

      const logger = new DebugSessionLogger(sessionId, workspaceRoot);

      // Should not throw
      expect(() => {
        logger.logParseFailure('TestSource', new Error('Parse error'), 'content');
      }).not.toThrow();

      expect(consoleErrorSpy).toHaveBeenCalledWith(
        expect.stringContaining('[DebugLogger] Failed to log parse failure:'),
        expect.any(Error)
      );

      consoleErrorSpy.mockRestore();
    });
  });

  describe('logEpicenterRefinement', () => {
    it('should save epicenter refinement with prompt, response, and outcome', () => {
      const logger = new DebugSessionLogger(sessionId, workspaceRoot);
      const prompt = 'Identify the most relevant symbol';
      const response = 'src/auth.ts::login';
      const outcome = 'Success: Refined epicenter to src/auth.ts::login';
      const model = 'gpt-4o-mini';

      logger.logEpicenterRefinement(prompt, response, outcome, model);

      const expectedPath = path.join(workspaceRoot, 'debug-output', 'active-session', 'epicenter-refinement-latest.txt');
      expect(mockFs.writeFileSync).toHaveBeenCalledWith(
        expectedPath,
        expect.stringContaining('Timestamp:'),
        'utf8'
      );

      const writeCall = (mockFs.writeFileSync as jest.Mock).mock.calls.find(
        (call: any[]) => call[0] === expectedPath
      );
      expect(writeCall).toBeDefined();
      const content = writeCall[1];
      
      expect(content).toContain(`Model: ${model}`);
      expect(content).toContain(`Outcome: ${outcome}`);
      expect(content).toContain('=== PROMPT START ===');
      expect(content).toContain(prompt);
      expect(content).toContain('=== PROMPT END ===');
      expect(content).toContain('=== RESPONSE START ===');
      expect(content).toContain(response);
      expect(content).toContain('=== RESPONSE END ===');
    });

    it('should save epicenter refinement with file symbols when provided', () => {
      const logger = new DebugSessionLogger(sessionId, workspaceRoot);
      const prompt = 'Identify the most relevant symbol';
      const response = 'src/auth.ts::login';
      const outcome = 'Success';
      const model = 'gpt-4o-mini';
      const fileSymbols = [
        {
          file: 'src/auth.ts',
          symbols: [
            { name: 'login', type: 'function', exported: true },
            { name: 'logout', type: 'function', exported: false }
          ]
        }
      ];

      logger.logEpicenterRefinement(prompt, response, outcome, model, fileSymbols);

      const expectedPath = path.join(workspaceRoot, 'debug-output', 'active-session', 'epicenter-refinement-latest.txt');
      const writeCall = (mockFs.writeFileSync as jest.Mock).mock.calls.find(
        (call: any[]) => call[0] === expectedPath
      );
      const content = writeCall[1];
      
      expect(content).toContain('=== EXTRACTED SYMBOLS ===');
      expect(content).toContain('File: src/auth.ts');
      expect(content).toContain('exported function: login');
      expect(content).toContain('function: logout');
    });

    it('should handle missing model parameter', () => {
      const logger = new DebugSessionLogger(sessionId, workspaceRoot);
      const prompt = 'Test prompt';
      const response = 'Test response';
      const outcome = 'Test outcome';

      logger.logEpicenterRefinement(prompt, response, outcome);

      const expectedPath = path.join(workspaceRoot, 'debug-output', 'active-session', 'epicenter-refinement-latest.txt');
      const writeCall = (mockFs.writeFileSync as jest.Mock).mock.calls.find(
        (call: any[]) => call[0] === expectedPath
      );
      const content = writeCall[1];
      
      expect(content).toContain('Model: not specified');
    });

    it('should handle write errors gracefully', () => {
      const logger = new DebugSessionLogger(sessionId, workspaceRoot);
      (mockFs.writeFileSync as jest.Mock).mockImplementationOnce(() => {
        throw new Error('Write failed');
      });

      const consoleErrorSpy = jest.spyOn(console, 'error').mockImplementation();

      logger.logEpicenterRefinement('prompt', 'response', 'outcome');

      expect(consoleErrorSpy).toHaveBeenCalledWith(
        expect.stringContaining('[DebugLogger] Failed to log epicenter refinement'),
        expect.any(Error)
      );

      consoleErrorSpy.mockRestore();
    });
  });

  describe('error handling', () => {
    it('should handle all save operations gracefully on errors', () => {
      const consoleErrorSpy = jest.spyOn(console, 'error').mockImplementation();
      (mockFs.writeFileSync as jest.Mock).mockImplementation(() => {
        throw new Error('Write failed');
      });

      const logger = new DebugSessionLogger(sessionId, workspaceRoot);

      // All operations should not throw
      expect(() => logger.logUserRequest('test')).not.toThrow();
      expect(() => logger.logEpicenter({})).not.toThrow();
      expect(() => logger.logGraph({})).not.toThrow();
      expect(() => logger.logStep(0, 'prompt', {})).not.toThrow();
      expect(() => logger.generateSummary({ steps: 1, cost: 0 })).not.toThrow();
      expect(() => logger.logParseFailure('Test', new Error('Test'), 'content')).not.toThrow();
      expect(() => logger.logEpicenterRefinement('prompt', 'response', 'outcome')).not.toThrow();

      // Errors should be logged
      expect(consoleErrorSpy).toHaveBeenCalledTimes(8); // 1 for session info + 7 for operations

      consoleErrorSpy.mockRestore();
    });
  });

  describe('file naming and organization', () => {
    it('should use correct file naming convention', () => {
      const logger = new DebugSessionLogger(sessionId, workspaceRoot);
      const expectedDir = path.join(workspaceRoot, 'debug-output', 'active-session');

      logger.logUserRequest('query');
      logger.logEpicenter({});
      logger.logGraph({});
      logger.logStep(0, 'prompt', {});
      logger.logStep(0, 'response', {});
      logger.logStep(0, 'tools', {});
      logger.logStep(0, 'state', {});
      logger.generateSummary({ steps: 1, cost: 0 });

      const calls = (mockFs.writeFileSync as jest.Mock).mock.calls;
      const filenames = calls.map((call: any[]) => path.basename(call[0]));

      expect(filenames).toContain('00-session-info.json');
      expect(filenames).toContain('00-summary.txt');
      expect(filenames).toContain('01-user-request.txt');
      expect(filenames).toContain('02-epicenter.json');
      expect(filenames).toContain('02-initial-graph.json');
      expect(filenames).toContain('03-step-00-prompt.json');
      expect(filenames).toContain('03-step-00-response.json');
      expect(filenames).toContain('03-step-00-tools.json');
      expect(filenames).toContain('03-step-00-state.json');
    });

    it('should pad step numbers correctly for filesystem sorting', () => {
      const logger = new DebugSessionLogger(sessionId, workspaceRoot);

      // Log steps 0, 1, 10 to test padding
      logger.logStep(0, 'prompt', {});
      logger.logStep(1, 'prompt', {});
      logger.logStep(10, 'prompt', {});

      const calls = (mockFs.writeFileSync as jest.Mock).mock.calls;
      const stepFiles = calls
        .map((call: any[]) => path.basename(call[0]))
        .filter((name: string) => name.startsWith('03-step-'));

      expect(stepFiles).toContain('03-step-00-prompt.json');
      expect(stepFiles).toContain('03-step-01-prompt.json');
      expect(stepFiles).toContain('03-step-10-prompt.json');
    });
  });
});
