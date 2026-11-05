/**
 * Tests for NodeProcessTool
 */

import { NodeProcessTool } from '../NodeProcessTool';
import * as vscode from 'vscode';
import * as cp from 'child_process';
import * as net from 'net';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

// Mock RuntimeClient
const mockConnect = jest.fn();
const mockInspect = jest.fn();
const mockDisconnect = jest.fn();
jest.mock('../../runtime/RuntimeClient', () => ({
  RuntimeClient: jest.fn().mockImplementation(() => ({
    connect: mockConnect,
    inspect: mockInspect,
    disconnect: mockDisconnect
  }))
}));

// Mock vscode
let mockWorkspaceFolders: any[] = [];

jest.mock('vscode', () => ({
  workspace: {
    get workspaceFolders() {
      return mockWorkspaceFolders;
    }
  }
}));

// Mock child_process
const mockSpawn = jest.fn();
jest.mock('child_process', () => ({
  spawn: (...args: any[]) => mockSpawn(...args)
}));

// Mock net
const mockCreateServer = jest.fn();
jest.mock('net', () => ({
  createServer: (...args: any[]) => mockCreateServer(...args)
}));

describe('NodeProcessTool', () => {
  let tool: NodeProcessTool;
  let testWorkspaceRoot: string;
  let sandboxPath: string;

  beforeEach(() => {
    // Create a temporary directory for testing
    testWorkspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'nodeprocess-test-'));
    sandboxPath = path.join(testWorkspaceRoot, '.samurai', 'sandbox');
    fs.mkdirSync(sandboxPath, { recursive: true });

    // Setup mock workspace folder
    mockWorkspaceFolders = [{
      uri: {
        fsPath: testWorkspaceRoot
      },
      name: 'test-workspace',
      index: 0
    }];

    tool = new NodeProcessTool();
    
    // Clear all mocks
    jest.clearAllMocks();
    mockConnect.mockReset();
    mockInspect.mockReset();
    mockDisconnect.mockReset();
    
    // Reset static activeProcesses and logBuffers
    (NodeProcessTool as any).activeProcesses.clear();
    (NodeProcessTool as any).logBuffers.clear();
  });

  describe('debug action', () => {
    beforeEach(() => {
      mockCreateServer.mockReturnValue({
        listen: jest.fn((port, callback) => {
          if (callback) callback();
          return {
            close: jest.fn((closeCallback) => {
              if (closeCallback) closeCallback();
            }),
            on: jest.fn()
          };
        }),
        close: jest.fn(),
        on: jest.fn()
      });
    });

    it('should return error when path is missing', async () => {
      const result = await tool.execute({
        action: 'debug',
        breakpoints: [{ file: 'src/app.ts', line: 10 }]
      } as any);

      expect(result.success).toBe(false);
      expect(result.summary).toContain('Path is required');
    });

    it('should return error when breakpoints are missing', async () => {
      const result = await tool.execute({
        action: 'debug',
        path: 'src/app.ts'
      } as any);

      expect(result.success).toBe(false);
      expect(result.summary).toContain('breakpoint');
    });

    it('should run atomic debug and capture variables', async () => {
      mockConnect.mockResolvedValue(true);
      mockInspect.mockResolvedValue({
        states: [
          {
            lineNumber: 10,
            pauseNumber: 1,
            callStackDepth: 1,
            variables: {
              0: {
                variables: {
                  foo: { success: true, value: 42 }
                }
              }
            }
          }
        ],
        totalPauses: 1
      });
      const mockChild = {
        pid: 321,
        on: jest.fn(),
        stdout: { on: jest.fn() },
        stderr: { on: jest.fn() },
        kill: jest.fn()
      } as any;
      mockSpawn.mockReturnValue(mockChild);

      const setTimeoutSpy = jest.spyOn(global, 'setTimeout').mockImplementation(((cb: any) => {
        if (typeof cb === 'function') {
          cb();
        }
        // @ts-ignore
        return 0;
      }) as any);

      try {
        const result = await tool.execute({
          action: 'debug',
          path: 'src/app.ts',
          breakpoints: [{ file: 'src/app.ts', line: 10 }],
          watch_variables: ['foo'],
          timeout: 100
        } as any);

        expect(result.success).toBe(true);
        expect(mockConnect).toHaveBeenCalled();
        expect(mockInspect).toHaveBeenCalledWith(
          expect.objectContaining({
            breakpoints: [{ file: 'src/app.ts', line: 10 }],
            variables: ['foo']
          })
        );
        expect(result.structuredData?.breakpoints_hit[0].variables.foo).toBe(42);
        expect(mockChild.kill).toHaveBeenCalledWith('SIGKILL');
        expect((NodeProcessTool as any).activeProcesses.size).toBe(0);
      } finally {
        setTimeoutSpy.mockRestore();
      }
    });

    it('should report timeout when inspection does not resolve', async () => {
      mockConnect.mockResolvedValue(true);
      mockInspect.mockImplementation(() => new Promise(() => {}));
      const mockChild = {
        pid: 999,
        on: jest.fn(),
        stdout: { on: jest.fn() },
        stderr: { on: jest.fn() },
        kill: jest.fn()
      } as any;
      mockSpawn.mockReturnValue(mockChild);

      const setTimeoutSpy = jest.spyOn(global, 'setTimeout').mockImplementation(((cb: any) => {
        if (typeof cb === 'function') {
          cb();
        }
        // @ts-ignore
        return 0;
      }) as any);

      try {
        const result = await tool.execute({
          action: 'debug',
          path: 'src/slow.ts',
          breakpoints: [{ file: 'src/slow.ts', line: 5 }],
          timeout: 20
        } as any);

        expect(result.success).toBe(false);
        expect(result.summary).toContain('Execution timed out');
        expect(mockChild.kill).toHaveBeenCalledWith('SIGKILL');
        expect((NodeProcessTool as any).activeProcesses.size).toBe(0);
      } finally {
        setTimeoutSpy.mockRestore();
      }
    });
  });

  afterEach(() => {
    // Clean up any active processes first (before directory cleanup)
    // Only clean up processes that have a kill method
    const processesToClean = Array.from((NodeProcessTool as any).activeProcesses.entries());
    processesToClean.forEach(([pid, proc]: [number, any]) => {
      if (proc && typeof proc.kill === 'function') {
        try {
          proc.kill('SIGKILL');
        } catch (e) {
          // Ignore errors during cleanup
        }
      }
    });
    (NodeProcessTool as any).activeProcesses.clear();
    (NodeProcessTool as any).logBuffers.clear();
    
    // Clean up test directory
    if (fs.existsSync(testWorkspaceRoot)) {
      fs.rmSync(testWorkspaceRoot, { recursive: true, force: true });
    }
    
    jest.clearAllMocks();
  });

  describe('workspace validation', () => {
    it('should return error when no workspace folder is open', async () => {
      mockWorkspaceFolders = [];

      const result = await tool.execute({
        action: 'spawn',
        scriptPath: 'test.ts'
      });

      expect(result.success).toBe(false);
      expect(result.summary).toBe('No workspace.');
    });
  });

  describe('kill action', () => {
    it('should return error when pid is missing', async () => {
      const result = await tool.execute({
        action: 'kill'
      });

      expect(result.success).toBe(false);
      expect(result.summary).toBe('PID required for kill.');
    });

    it('should return error when process not found', async () => {
      const result = await tool.execute({
        action: 'kill',
        pid: 99999
      });

      expect(result.success).toBe(false);
      expect(result.summary).toBe('Process 99999 not found (already dead?).');
    });

    it('should kill existing process', async () => {
      // Create a mock process and add it to activeProcesses
      const mockProcess = {
        pid: 12345,
        kill: jest.fn(),
        on: jest.fn(),
        stderr: { on: jest.fn() },
        stdout: { on: jest.fn() }
      } as any;

      (NodeProcessTool as any).activeProcesses.set(12345, mockProcess);
      // Add some logs to verify cleanup
      (NodeProcessTool as any).logBuffers.set(12345, "some logs");

      const result = await tool.execute({
        action: 'kill',
        pid: 12345
      });

      expect(result.success).toBe(true);
      expect(result.summary).toBe('Killed process 12345.');
      expect(mockProcess.kill).toHaveBeenCalledWith('SIGKILL');
      expect((NodeProcessTool as any).activeProcesses.has(12345)).toBe(false);
      // Verify logs are cleaned up
      expect((NodeProcessTool as any).logBuffers.has(12345)).toBe(false);
    });
  });

  describe('list_active action', () => {
    it('should return empty list when no processes are active', async () => {
      const result = await tool.execute({
        action: 'list_active'
      });

      expect(result.success).toBe(true);
      expect(result.summary).toBe('Active processes: None.');
      expect(result.structuredData).toEqual({ pids: [] });
    });

    it('should list active process PIDs', async () => {
      // Add some mock processes
      const mockProcess1 = { pid: 111, kill: jest.fn() } as any;
      const mockProcess2 = { pid: 222, kill: jest.fn() } as any;
      
      (NodeProcessTool as any).activeProcesses.set(111, mockProcess1);
      (NodeProcessTool as any).activeProcesses.set(222, mockProcess2);

      const result = await tool.execute({
        action: 'list_active'
      });

      expect(result.success).toBe(true);
      expect(result.summary).toContain('Active processes:');
      expect(result.structuredData).toEqual({ pids: [111, 222] });
    });
  });

  describe('spawn action', () => {
    beforeEach(() => {
      // Setup default mocks for spawn
      mockCreateServer.mockReturnValue({
        listen: jest.fn((port, callback) => {
          // Simulate port is available
          if (callback) callback();
          return {
            close: jest.fn((closeCallback) => {
              if (closeCallback) closeCallback();
            }),
            on: jest.fn()
          };
        }),
        close: jest.fn(),
        on: jest.fn()
      });
    });

    it('should return error when scriptPath is missing', async () => {
      const result = await tool.execute({
        action: 'spawn'
      });

      expect(result.success).toBe(false);
      expect(result.summary).toBe('Script path required.');
    });

    it('should find free port', async () => {
      const mockServer = {
        listen: jest.fn((port, callback) => {
          if (callback) callback();
          return mockServer;
        }),
        close: jest.fn((callback) => {
          if (callback) callback();
        }),
        on: jest.fn()
      };
      
      mockCreateServer.mockReturnValue(mockServer);

      // Create a test script file
      const scriptPath = path.join(sandboxPath, 'test.ts');
      fs.writeFileSync(scriptPath, 'console.log("test");');

      // Mock spawn to return a process that never emits debugger message (for timeout)
      const mockChild = {
        pid: 12345,
        on: jest.fn(),
        stderr: { on: jest.fn() },
        stdout: { on: jest.fn() }
      } as any;
      
      mockSpawn.mockReturnValue(mockChild);

      // Start spawn (but don't wait for completion)
      const spawnPromise = tool.execute({
        action: 'spawn',
        scriptPath: 'test.ts',
        debugPort: 9229
      });

      // Verify port finding was called
      expect(mockCreateServer).toHaveBeenCalled();
      expect(mockServer.listen).toHaveBeenCalledWith(9229, expect.any(Function));

      // Clean up
      (NodeProcessTool as any).activeProcesses.delete(12345);
    });

    it('should find next port if first port is busy', async () => {
      let callCount = 0;
      const mockServer = {
        listen: jest.fn((port, callback) => {
          callCount++;
          if (callCount === 1) {
            // First port is busy - trigger error
            const errorEvent = mockServer.on.mock.calls.find(call => call[0] === 'error');
            if (errorEvent && errorEvent[1]) {
              errorEvent[1]();
            }
          } else {
            // Second port is available
            if (callback) callback();
          }
          return mockServer;
        }),
        close: jest.fn((callback) => {
          if (callback) callback();
        }),
        on: jest.fn((event, handler) => {
          if (event === 'error' && callCount === 1) {
            // Store error handler for first call
            setTimeout(() => handler(), 0);
          }
        })
      };
      
      mockCreateServer.mockReturnValue(mockServer);

      const scriptPath = path.join(sandboxPath, 'test.ts');
      fs.writeFileSync(scriptPath, 'console.log("test");');

      const mockChild = {
        pid: 12345,
        on: jest.fn(),
        stderr: { on: jest.fn() },
        stdout: { on: jest.fn() }
      } as any;
      
      mockSpawn.mockReturnValue(mockChild);

      // This will recursively call findFreePort
      const spawnPromise = tool.execute({
        action: 'spawn',
        scriptPath: 'test.ts',
        debugPort: 9229
      });

      // Wait a bit for async operations
      await new Promise(resolve => setTimeout(resolve, 10));

      // Verify it tried multiple ports
      expect(mockServer.listen).toHaveBeenCalled();
      
      (NodeProcessTool as any).activeProcesses.delete(12345);
    });

    it('should spawn process and wait for debugger listening message', async () => {
      const mockServer = {
        listen: jest.fn((port, callback) => {
          if (callback) callback();
          return mockServer;
        }),
        close: jest.fn((callback) => {
          if (callback) callback();
        }),
        on: jest.fn()
      };
      
      mockCreateServer.mockReturnValue(mockServer);

      const scriptPath = path.join(sandboxPath, 'test.ts');
      fs.writeFileSync(scriptPath, 'console.log("test");');

      const stderrHandlers: Array<(data: Buffer) => void> = [];
      const stdoutHandlers: Array<(data: Buffer) => void> = [];
      const exitHandlers: Array<(code: number | null) => void> = [];

      const mockChild = {
        pid: 12345,
        on: jest.fn((event, handler) => {
          if (event === 'exit') {
            exitHandlers.push(handler);
          }
        }),
        stderr: {
          on: jest.fn((event, handler) => {
            if (event === 'data') {
              stderrHandlers.push(handler);
            }
          })
        },
        stdout: {
          on: jest.fn((event, handler) => {
            if (event === 'data') {
              stdoutHandlers.push(handler);
            }
          })
        }
      } as any;
      
      mockSpawn.mockReturnValue(mockChild);

      const spawnPromise = tool.execute({
        action: 'spawn',
        scriptPath: 'test.ts',
        debugPort: 9229
      });

      // Simulate debugger listening message on stderr
      setTimeout(() => {
        const debuggerMessage = Buffer.from('Debugger listening on ws://127.0.0.1:9229\n');
        stderrHandlers.forEach(handler => handler(debuggerMessage));
      }, 10);

      const result = await spawnPromise;

      expect(result.success).toBe(true);
      expect(result.summary).toContain('Process spawned (PID: 12345)');
      expect(result.summary).toContain('Debugger listening on port 9229');
      expect(result.structuredData).toEqual({
        pid: 12345,
        port: 9229,
        output: expect.stringContaining('Debugger listening')
      });
      expect(mockSpawn).toHaveBeenCalledWith(
        'npx',
        expect.arrayContaining([
          'ts-node',
          '-r',
          'tsconfig-paths/register',
          scriptPath
        ]),
        expect.objectContaining({
          cwd: testWorkspaceRoot,
          env: expect.objectContaining({
            FORCE_COLOR: 'true',
            NODE_OPTIONS: '--inspect-brk=9229'
          })
        })
      );
    });

    it('should spawn node for js scripts (no npx)', async () => {
      const mockServer = {
        listen: jest.fn((port, callback) => {
          if (callback) callback();
          return mockServer;
        }),
        close: jest.fn((callback) => {
          if (callback) callback();
        }),
        on: jest.fn()
      };
      
      mockCreateServer.mockReturnValue(mockServer);

      const scriptPath = path.join(sandboxPath, 'test.js');
      fs.writeFileSync(scriptPath, 'console.log("js");');

      const stdoutHandlers: Array<(data: Buffer) => void> = [];

      const mockChild = {
        pid: 6789,
        on: jest.fn(),
        stderr: { on: jest.fn() },
        stdout: {
          on: jest.fn((event, handler) => {
            if (event === 'data') {
              stdoutHandlers.push(handler);
            }
          })
        }
      } as any;
      
      mockSpawn.mockReturnValue(mockChild);

      const spawnPromise = tool.execute({
        action: 'spawn',
        scriptPath: 'test.js',
        debugPort: 9333
      });

      setTimeout(() => {
        const debuggerMessage = Buffer.from('Debugger listening on ws://127.0.0.1:9333\n');
        stdoutHandlers.forEach(handler => handler(debuggerMessage));
      }, 10);

      const result = await spawnPromise;

      expect(result.success).toBe(true);
      expect(mockSpawn).toHaveBeenCalledWith(
        'node',
        [scriptPath],
        expect.objectContaining({
          cwd: testWorkspaceRoot,
          env: expect.objectContaining({
            NODE_OPTIONS: '--inspect-brk=9333'
          })
        })
      );
    });

    it('should handle debugger message on stdout', async () => {
      const mockServer = {
        listen: jest.fn((port, callback) => {
          if (callback) callback();
          return mockServer;
        }),
        close: jest.fn((callback) => {
          if (callback) callback();
        }),
        on: jest.fn()
      };
      
      mockCreateServer.mockReturnValue(mockServer);

      const scriptPath = path.join(sandboxPath, 'test.ts');
      fs.writeFileSync(scriptPath, 'console.log("test");');

      const stdoutHandlers: Array<(data: Buffer) => void> = [];

      const mockChild = {
        pid: 12345,
        on: jest.fn(),
        stderr: { on: jest.fn() },
        stdout: {
          on: jest.fn((event, handler) => {
            if (event === 'data') {
              stdoutHandlers.push(handler);
            }
          })
        }
      } as any;
      
      mockSpawn.mockReturnValue(mockChild);

      const spawnPromise = tool.execute({
        action: 'spawn',
        scriptPath: 'test.ts'
      });

      // Simulate debugger listening message on stdout
      setTimeout(() => {
        const debuggerMessage = Buffer.from('Debugger listening on ws://127.0.0.1:9229\n');
        stdoutHandlers.forEach(handler => handler(debuggerMessage));
      }, 10);

      const result = await spawnPromise;

      expect(result.success).toBe(true);
      expect(result.summary).toContain('Debugger listening');
    });

    it('should handle early crash before debugger ready', async () => {
      const mockServer = {
        listen: jest.fn((port, callback) => {
          if (callback) callback();
          return mockServer;
        }),
        close: jest.fn((callback) => {
          if (callback) callback();
        }),
        on: jest.fn()
      };
      
      mockCreateServer.mockReturnValue(mockServer);

      const scriptPath = path.join(sandboxPath, 'test.ts');
      fs.writeFileSync(scriptPath, 'invalid syntax!!!');

      const stderrHandlers: Array<(data: Buffer) => void> = [];
      const exitHandlers: Array<(code: number | null) => void> = [];

      const mockChild = {
        pid: 12345,
        on: jest.fn((event, handler) => {
          if (event === 'exit') {
            exitHandlers.push(handler);
          }
        }),
        stderr: {
          on: jest.fn((event, handler) => {
            if (event === 'data') {
              stderrHandlers.push(handler);
            }
          })
        },
        stdout: { on: jest.fn() }
      } as any;
      
      mockSpawn.mockReturnValue(mockChild);

      const spawnPromise = tool.execute({
        action: 'spawn',
        scriptPath: 'test.ts'
      });

      // Simulate error output
      setTimeout(() => {
        const errorMessage = Buffer.from('SyntaxError: Unexpected token\n');
        stderrHandlers.forEach(handler => handler(errorMessage));
      }, 5);

      // Simulate early exit
      setTimeout(() => {
        exitHandlers.forEach(handler => handler(1));
      }, 10);

      const result = await spawnPromise;

      expect(result.success).toBe(false);
      expect(result.summary).toContain('Process crashed immediately');
      expect(result.summary).toContain('Exit Code: 1');
      expect(result.evidence).toBeDefined();
      expect(result.evidence?.length).toBe(1);
      // Updated format: crash-report.txt with COMMAND, EXIT CODE, and LOGS
      expect(result.evidence?.[0].file).toBe('crash-report.txt');
      expect(result.evidence?.[0].text).toContain('COMMAND:');
      expect(result.evidence?.[0].text).toContain('EXIT CODE: 1');
      expect(result.evidence?.[0].text).toContain('LOGS:');
      expect(result.evidence?.[0].text).toContain('SyntaxError');
      expect(result.evidence?.[0].description).toBe('Crash Output (Stderr/Stdout)');
      // Check structuredData contains exitCode, error, and command
      expect(result.structuredData).toBeDefined();
      expect(result.structuredData?.exitCode).toBe(1);
      expect(result.structuredData?.error).toContain('SyntaxError');
      expect(result.structuredData?.command).toContain('npx');
      // Process should be removed from tracking
      expect((NodeProcessTool as any).activeProcesses.has(12345)).toBe(false);
    }, 10000); // Increase timeout to account for 200ms delay

    it('should return error when spawn fails (no PID)', async () => {
      const mockServer = {
        listen: jest.fn((port, callback) => {
          if (callback) callback();
          return mockServer;
        }),
        close: jest.fn((callback) => {
          if (callback) callback();
        }),
        on: jest.fn()
      };
      
      mockCreateServer.mockReturnValue(mockServer);

      const scriptPath = path.join(sandboxPath, 'test.ts');
      fs.writeFileSync(scriptPath, 'console.log("test");');

      const mockChild = {
        pid: undefined, // No PID - spawn failed
        on: jest.fn(),
        stderr: { on: jest.fn() },
        stdout: { on: jest.fn() }
      } as any;
      
      mockSpawn.mockReturnValue(mockChild);

      const result = await tool.execute({
        action: 'spawn',
        scriptPath: 'test.ts'
      });

      expect(result.success).toBe(false);
      expect(result.summary).toBe('Failed to spawn process.');
    });

    it('should append to existing NODE_OPTIONS when provided', async () => {
      const originalNodeOptions = '--max-old-space-size=4096';
      process.env.NODE_OPTIONS = originalNodeOptions;

      const mockServer = {
        listen: jest.fn((port, callback) => {
          if (callback) callback();
          return mockServer;
        }),
        close: jest.fn((callback) => {
          if (callback) callback();
        }),
        on: jest.fn()
      };
      
      mockCreateServer.mockReturnValue(mockServer);

      const scriptPath = path.join(sandboxPath, 'test.ts');
      fs.writeFileSync(scriptPath, 'console.log("test");');

      const stderrHandlers: Array<(data: Buffer) => void> = [];

      const mockChild = {
        pid: 12345,
        on: jest.fn(),
        stderr: {
          on: jest.fn((event, handler) => {
            if (event === 'data') {
              stderrHandlers.push(handler);
            }
          })
        },
        stdout: { on: jest.fn() }
      } as any;
      
      mockSpawn.mockReturnValue(mockChild);

      const spawnPromise = tool.execute({
        action: 'spawn',
        scriptPath: 'test.ts',
        debugPort: 9230
      });

      setTimeout(() => {
        const debuggerMessage = Buffer.from('Debugger listening on ws://127.0.0.1:9230\n');
        stderrHandlers.forEach(handler => handler(debuggerMessage));
      }, 10);

      await spawnPromise;

      // Verify NODE_OPTIONS contains both original and debug flag
      const spawnCall = mockSpawn.mock.calls[0];
      const nodeOptions = spawnCall[2]?.env?.NODE_OPTIONS;
      expect(nodeOptions).toContain(originalNodeOptions);
      expect(nodeOptions).toContain('--inspect-brk=9230');
      
      // Clean up
      delete process.env.NODE_OPTIONS;
      (NodeProcessTool as any).activeProcesses.delete(12345);
    });

    it('should use default port 9229 when debugPort not provided', async () => {
      const mockServer = {
        listen: jest.fn((port, callback) => {
          expect(port).toBe(9229);
          if (callback) callback();
          return mockServer;
        }),
        close: jest.fn((callback) => {
          if (callback) callback();
        }),
        on: jest.fn()
      };
      
      mockCreateServer.mockReturnValue(mockServer);

      const scriptPath = path.join(sandboxPath, 'test.ts');
      fs.writeFileSync(scriptPath, 'console.log("test");');

      const stderrHandlers: Array<(data: Buffer) => void> = [];

      const mockChild = {
        pid: 12345,
        on: jest.fn(),
        stderr: {
          on: jest.fn((event, handler) => {
            if (event === 'data') {
              stderrHandlers.push(handler);
            }
          })
        },
        stdout: { on: jest.fn() }
      } as any;
      
      mockSpawn.mockReturnValue(mockChild);

      const spawnPromise = tool.execute({
        action: 'spawn',
        scriptPath: 'test.ts'
        // debugPort not provided - should default to 9229
      });

      setTimeout(() => {
        const debuggerMessage = Buffer.from('Debugger listening on ws://127.0.0.1:9229\n');
        stderrHandlers.forEach(handler => handler(debuggerMessage));
      }, 10);

      const result = await spawnPromise;

      expect(result.success).toBe(true);
      const spawnCall = mockSpawn.mock.calls[0];
      expect(spawnCall[0]).toBe('npx');
      expect(spawnCall[1]).not.toContain('--inspect-brk=9229'); // Should not be in args
      expect(spawnCall[2]?.env?.NODE_OPTIONS).toBe('--inspect-brk=9229'); // Should be in env
    });
  });

  describe('get_logs action', () => {
    it('should return error when pid is missing', async () => {
      const result = await tool.execute({
        action: 'get_logs'
      });

      expect(result.success).toBe(false);
      expect(result.summary).toBe('PID required for get_logs.');
    });

    it('should return default message when no logs recorded', async () => {
      const result = await tool.execute({
        action: 'get_logs',
        pid: 99999
      });

      expect(result.success).toBe(true);
      expect(result.summary).toBe('Retrieved logs for PID 99999');
      expect(result.evidence).toBeDefined();
      expect(result.evidence?.length).toBe(1);
      expect(result.evidence?.[0]).toEqual({
        file: 'terminal-output.txt',
        line: 0,
        text: '(No logs recorded)',
        description: 'Standard Output/Error'
      });
    });

    it('should retrieve logs after spawn', async () => {
      const mockServer = {
        listen: jest.fn((port, callback) => {
          if (callback) callback();
          return mockServer;
        }),
        close: jest.fn((callback) => {
          if (callback) callback();
        }),
        on: jest.fn()
      };
      
      mockCreateServer.mockReturnValue(mockServer);

      const scriptPath = path.join(sandboxPath, 'test.ts');
      fs.writeFileSync(scriptPath, 'console.log("test");');

      const stderrHandlers: Array<(data: Buffer) => void> = [];

      const mockChild = {
        pid: 12345,
        on: jest.fn(),
        stderr: {
          on: jest.fn((event, handler) => {
            if (event === 'data') {
              stderrHandlers.push(handler);
            }
          })
        },
        stdout: { on: jest.fn() }
      } as any;
      
      mockSpawn.mockReturnValue(mockChild);

      const spawnPromise = tool.execute({
        action: 'spawn',
        scriptPath: 'test.ts'
      });

      // Simulate some output before debugger message
      setTimeout(() => {
        const outputMessage = Buffer.from('Some output\n');
        stderrHandlers.forEach(handler => handler(outputMessage));
      }, 5);

      // Simulate debugger listening message
      setTimeout(() => {
        const debuggerMessage = Buffer.from('Debugger listening on ws://127.0.0.1:9229\n');
        stderrHandlers.forEach(handler => handler(debuggerMessage));
      }, 10);

      await spawnPromise;

      // Now retrieve logs
      const logsResult = await tool.execute({
        action: 'get_logs',
        pid: 12345
      });

      expect(logsResult.success).toBe(true);
      expect(logsResult.evidence).toBeDefined();
      expect(logsResult.evidence?.[0].text).toContain('Some output');
      expect(logsResult.evidence?.[0].text).toContain('Debugger listening');

      // Clean up
      (NodeProcessTool as any).activeProcesses.delete(12345);
    });

    it('should preserve logs after process exits', async () => {
      const mockServer = {
        listen: jest.fn((port, callback) => {
          if (callback) callback();
          return mockServer;
        }),
        close: jest.fn((callback) => {
          if (callback) callback();
        }),
        on: jest.fn()
      };
      
      mockCreateServer.mockReturnValue(mockServer);

      const scriptPath = path.join(sandboxPath, 'test.ts');
      fs.writeFileSync(scriptPath, 'invalid syntax!!!');

      const stderrHandlers: Array<(data: Buffer) => void> = [];
      const exitHandlers: Array<(code: number | null) => void> = [];

      const mockChild = {
        pid: 12345,
        on: jest.fn((event, handler) => {
          if (event === 'exit') {
            exitHandlers.push(handler);
          }
        }),
        stderr: {
          on: jest.fn((event, handler) => {
            if (event === 'data') {
              stderrHandlers.push(handler);
            }
          })
        },
        stdout: { on: jest.fn() }
      } as any;
      
      mockSpawn.mockReturnValue(mockChild);

      const spawnPromise = tool.execute({
        action: 'spawn',
        scriptPath: 'test.ts'
      });

      // Simulate error output
      setTimeout(() => {
        const errorMessage = Buffer.from('Error: Cannot find module "./utils"\n');
        stderrHandlers.forEach(handler => handler(errorMessage));
      }, 5);

      // Simulate early exit
      setTimeout(() => {
        exitHandlers.forEach(handler => handler(1));
      }, 10);

      const crashResult = await spawnPromise;

      // Process should be removed from activeProcesses but logs should persist
      expect((NodeProcessTool as any).activeProcesses.has(12345)).toBe(false);
      
      // Verify crash result contains logs in structuredData.error
      expect(crashResult.structuredData?.error).toContain('Error: Cannot find module');

      // Retrieve logs after exit (get_logs should still work)
      const logsResult = await tool.execute({
        action: 'get_logs',
        pid: 12345
      });

      expect(logsResult.success).toBe(true);
      expect(logsResult.evidence?.[0].text).toContain('Error: Cannot find module');
    }, 10000); // Increase timeout to account for 200ms delay

    it('should enforce 1MB buffer cap with tail truncation', async () => {
      const mockServer = {
        listen: jest.fn((port, callback) => {
          if (callback) callback();
          return mockServer;
        }),
        close: jest.fn((callback) => {
          if (callback) callback();
        }),
        on: jest.fn()
      };
      
      mockCreateServer.mockReturnValue(mockServer);

      const scriptPath = path.join(sandboxPath, 'test.ts');
      fs.writeFileSync(scriptPath, 'console.log("test");');

      const stderrHandlers: Array<(data: Buffer) => void> = [];

      const mockChild = {
        pid: 12345,
        on: jest.fn(),
        stderr: {
          on: jest.fn((event, handler) => {
            if (event === 'data') {
              stderrHandlers.push(handler);
            }
          })
        },
        stdout: { on: jest.fn() }
      } as any;
      
      mockSpawn.mockReturnValue(mockChild);

      const spawnPromise = tool.execute({
        action: 'spawn',
        scriptPath: 'test.ts'
      });

      // Simulate large output that exceeds 1MB
      const MAX_LOG_SIZE = 1024 * 1024; // 1MB
      const largeMessage = 'x'.repeat(MAX_LOG_SIZE + 1000); // Exceed by 1KB

      setTimeout(() => {
        const largeBuffer = Buffer.from(largeMessage);
        stderrHandlers.forEach(handler => handler(largeBuffer));
      }, 5);

      // Simulate debugger message
      setTimeout(() => {
        const debuggerMessage = Buffer.from('Debugger listening on ws://127.0.0.1:9229\n');
        stderrHandlers.forEach(handler => handler(debuggerMessage));
      }, 10);

      await spawnPromise;

      // Retrieve logs
      const logsResult = await tool.execute({
        action: 'get_logs',
        pid: 12345
      });

      expect(logsResult.success).toBe(true);
      const logText = logsResult.evidence?.[0].text || '';
      
      // Should contain truncation indicator
      expect(logText).toContain('...[TRUNCATED]...');
      
      // Should be approximately MAX_LOG_SIZE (allowing for truncation prefix)
      // The tail should be kept, so total should be around MAX_LOG_SIZE + prefix length
      expect(logText.length).toBeLessThanOrEqual(MAX_LOG_SIZE + 100); // Allow some margin

      // Clean up
      (NodeProcessTool as any).activeProcesses.delete(12345);
    });
  });

  describe('cleanupAll', () => {
    it('should kill all active processes and clear log buffers', () => {
      const mockProcess1 = {
        pid: 111,
        kill: jest.fn()
      } as any;
      const mockProcess2 = {
        pid: 222,
        kill: jest.fn()
      } as any;

      (NodeProcessTool as any).activeProcesses.set(111, mockProcess1);
      (NodeProcessTool as any).activeProcesses.set(222, mockProcess2);
      (NodeProcessTool as any).logBuffers.set(111, 'logs1');
      (NodeProcessTool as any).logBuffers.set(222, 'logs2');

      NodeProcessTool.cleanupAll();

      expect(mockProcess1.kill).toHaveBeenCalledWith('SIGKILL');
      expect(mockProcess2.kill).toHaveBeenCalledWith('SIGKILL');
      expect((NodeProcessTool as any).activeProcesses.size).toBe(0);
      expect((NodeProcessTool as any).logBuffers.size).toBe(0);
    });
  });

  describe('invalid action', () => {
    it('should return error for invalid action', async () => {
      const result = await tool.execute({
        action: 'invalid' as any
      });

      expect(result.success).toBe(false);
      expect(result.summary).toBe('Invalid action');
    });
  });
});

