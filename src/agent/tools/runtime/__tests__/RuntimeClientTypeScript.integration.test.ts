/**
 * Integration tests for RuntimeClient with TypeScript files using NodeProcessTool.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { NodeProcessTool } from '../../engine/NodeProcessTool';
import * as vscode from 'vscode';

jest.mock('vscode', () => {
  let workspaceFolders: any[] = [];
  return {
    workspace: {
      get workspaceFolders() {
        return workspaceFolders;
      },
      set workspaceFolders(folders: any[]) {
        workspaceFolders = folders;
      }
    }
  };
});

describe('RuntimeClient TypeScript Integration', () => {
  const fixturesRoot = path.join(__dirname, 'fixtures', 'ts');
  // Use the actual project root so ts-node can be resolved
  const projectRoot = path.resolve(__dirname, '../../../../..');
  let testDir: string;

  beforeEach(() => {
    // Create a temporary directory in the sandbox for this test
    testDir = fs.mkdtempSync(path.join(projectRoot, '.samurai', 'sandbox', 'ts-test-'));
    (vscode.workspace as any).workspaceFolders = [
      {
        uri: { fsPath: projectRoot },
        name: 'TsWorkspace',
        index: 0
      }
    ];
  });

  afterEach(async () => {
    NodeProcessTool.cleanupAll();
    // Clean up test directory
    if (testDir && fs.existsSync(testDir)) {
      fs.rmSync(testDir, { recursive: true, force: true });
    }
    // Give OS time to release ports and clean up resources between tests
    await new Promise(resolve => setTimeout(resolve, 200));
  });

  // Helper to copy TypeScript files to sandbox
  const copyToSandbox = (sourcePath: string, relativePath?: string): string => {
    const fileName = relativePath || path.basename(sourcePath);
    const destPath = path.join(testDir, fileName);
    fs.copyFileSync(sourcePath, destPath);
    return destPath;
  };

  // Helper to copy TypeScript directory to sandbox
  const copyDirToSandbox = (sourceDir: string, dirName?: string): string => {
    const name = dirName || path.basename(sourceDir);
    const destDir = path.join(testDir, name);
    fs.cpSync(sourceDir, destDir, { recursive: true });
    return destDir;
  };

  const toContentBreakpoints = (breakpoints: Array<{ file: string; line: number }>) => {
    const cache = new Map<string, string[]>();
    const getLines = (file: string) => {
      if (!cache.has(file)) {
        cache.set(file, fs.readFileSync(file, 'utf-8').split('\n'));
      }
      return cache.get(file)!;
    };
    return breakpoints.map(bp => {
      const lines = getLines(bp.file);
      const content = lines[bp.line - 1] ?? '';
      return { file: bp.file, content };
    });
  };

  const runWithTool = async (
    scriptPath: string,
    breakpoints: Array<{ file: string; line: number }>,
    variables: string[],
    retries: number = 2
  ) => {
    for (let attempt = 0; attempt <= retries; attempt++) {
      const tool = new NodeProcessTool();
      const result = await tool.execute({
        action: 'debug',
        path: scriptPath,
        breakpoints: toContentBreakpoints(breakpoints),
        watch_variables: variables,
        timeout: 20000, // Increased timeout
      });
      const structured = result.structuredData as any;
      
      // If we got pauses, return immediately
      if ((structured?.totalPauses ?? 0) > 0) {
        return { result, structured };
      }
      
      // If this was the last attempt, return anyway
      if (attempt === retries) {
        return { result, structured };
      }
      
      // Wait before retry
      console.log(`[runWithTool] Retry ${attempt + 1}/${retries} - no pauses detected, waiting...`);
      await new Promise(resolve => setTimeout(resolve, 500));
    }
    throw new Error('Unreachable');
  };

  it('pauses inside imported TypeScript file and reads config value', async () => {
    // Copy the imports directory to sandbox
    const sourceImportsDir = path.join(fixturesRoot, 'imports');
    const sandboxImportsDir = copyDirToSandbox(sourceImportsDir, 'imports');
    const entryTs = path.join(sandboxImportsDir, 'entry.ts');
    const configTs = path.join(sandboxImportsDir, 'config.ts');
    
    // Use line 8 which has 'return config' - simpler and still references config
    const configLines = fs.readFileSync(configTs, 'utf-8').split('\n');
    let configLine = configLines.findIndex(l => l.includes('return config')) + 1;
    if (configLine === 0) {
      // Fallback to line with config assignment that references TIMEOUT
      configLine = configLines.findIndex(l => l.includes('const config') && l.includes('TIMEOUT')) + 1;
    }

    const { result, structured } = await runWithTool(
      entryTs,
      [{ file: configTs, line: configLine }],
      ['TIMEOUT', 'config']
    );

    if (!result.success) {
      const errorMsg = `Result failed: ${result.summary}\nEvidence: ${JSON.stringify(result.evidence, null, 2)}\nStructured: ${JSON.stringify(structured, null, 2)}`;
      // Always throw with the error details so we can see what's wrong
      throw new Error(`Test failed: ${errorMsg}`);
    }
    // Verify we actually hit breakpoints - don't silently pass with 0 pauses
    if ((structured.totalPauses ?? 0) === 0) {
      console.error('[imports test] Diagnostic - structured:', JSON.stringify(structured, null, 2));
      throw new Error(`[imports test] Zero pauses! totalPauses=${structured.totalPauses}, states=${structured.states?.length}`);
    }
    expect(structured.totalPauses).toBeGreaterThan(0);

    // Search through all states and frames for TIMEOUT value
    let timeoutVal: number | undefined;
    for (const state of structured.states) {
      for (const frame of Object.values(state.variables) as any[]) {
        if (frame?.variables?.['TIMEOUT']?.value !== undefined) {
          timeoutVal = frame.variables['TIMEOUT'].value;
          break;
        }
      }
      if (timeoutVal !== undefined) break;
    }
    
    expect(timeoutVal).toBe(5000);
  }, 30000);

  it('captures closure and local variables in TypeScript', async () => {
    const sourcePath = path.join(fixturesRoot, 'closures.ts');
    const scriptPath = copyToSandbox(sourcePath);
    const lines = fs.readFileSync(scriptPath, 'utf-8').split('\n');
    // Use line 10 which references marker (console.log with marker)
    const bpLine = lines.findIndex(l => l.includes('console.log') && l.includes('marker')) + 1;

    const { result, structured } = await runWithTool(
      scriptPath,
      [{ file: scriptPath, line: bpLine }],
      ['secretKey', 'status', 'marker']
    );

    expect(result.success).toBe(true);
    // Verify we actually hit breakpoints - don't silently pass with 0 pauses
    if ((structured.totalPauses ?? 0) === 0) {
      throw new Error(`[closures test] Zero pauses! totalPauses=${structured.totalPauses}, states=${structured.states?.length}`);
    }
    expect(structured.totalPauses).toBeGreaterThan(0);
    const frame = Object.values(structured.states[0].variables)[0] as any;
    expect(frame.variables['secretKey']?.value).toBe('API_KEY_12345');
    expect(frame.variables['status']?.value).toBe('connecting');
  }, 30000);

  it('handles circular TypeScript interfaces without crashing', async () => {
    const sourcePath = path.join(fixturesRoot, 'circular.ts');
    const scriptPath = copyToSandbox(sourcePath);
    const lines = fs.readFileSync(scriptPath, 'utf-8').split('\n');
    // Use line 11 which references nodeA (nodeB.next = nodeA)
    const bpLine = lines.findIndex(l => l.includes('nodeB.next = nodeA')) + 1;

    const { result, structured } = await runWithTool(
      scriptPath,
      [{ file: scriptPath, line: bpLine }],
      ['nodeA']
    );

    expect(result.success).toBe(true);
    // Verify we actually hit breakpoints
    if ((structured.totalPauses ?? 0) === 0) {
      throw new Error(`[circular test] Zero pauses! totalPauses=${structured.totalPauses}, states=${structured.states?.length}`);
    }
    expect(structured.totalPauses).toBeGreaterThan(0);
    const state = structured.states[0];
    const frame = Object.values(state.variables)[0] as any;
    const nodeAResult = frame.variables['nodeA'];
    expect(nodeAResult).toBeDefined();
  }, 30000);

  it('inspects resolved async data in TypeScript', async () => {
    const sourcePath = path.join(fixturesRoot, 'async-await.ts');
    const scriptPath = copyToSandbox(sourcePath);
    const lines = fs.readFileSync(scriptPath, 'utf-8').split('\n');
    // Use line 14 which references both marker and checkpoint (console.log with both)
    const bpLine = lines.findIndex(l => l.includes('console.log') && l.includes('marker') && l.includes('checkpoint')) + 1;

    const { result, structured } = await runWithTool(
      scriptPath,
      [{ file: scriptPath, line: bpLine }],
      ['marker', 'checkpoint', 'data']
    );

    expect(result.success).toBe(true);
    // Verify we actually hit breakpoints - async debugging should still pause
    if ((structured.totalPauses ?? 0) === 0) {
      throw new Error(`[async test] Zero pauses! totalPauses=${structured.totalPauses}, states=${structured.states?.length}`);
    }
    expect(structured.totalPauses).toBeGreaterThan(0);
  }, 30000);
});
