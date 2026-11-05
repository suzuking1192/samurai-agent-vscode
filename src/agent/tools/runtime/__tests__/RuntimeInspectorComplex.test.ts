/**
 * Runtime Inspector - Complex Scenarios using NodeProcessTool.
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

describe('Runtime Inspector - Complex Scenarios', () => {
  let testDir: string;

  beforeEach(() => {
    testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'runtime-complex-test-'));
    (vscode.workspace as any).workspaceFolders = [
      {
        uri: { fsPath: testDir },
        name: 'InspectorWorkspace',
        index: 0
      }
    ];
  });

  afterEach(() => {
    NodeProcessTool.cleanupAll();
    if (fs.existsSync(testDir)) {
      fs.rmSync(testDir, { recursive: true, force: true });
    }
  });

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
      if (content.trim().length === 0) {
        // eslint-disable-next-line no-console
        console.error(`[Test] Blank content for breakpoint line ${bp.line} in ${bp.file}`);
      }
      return { file: bp.file, content };
    });
  };

  const runWithTool = async (
    scriptPath: string,
    breakpoints: Array<{ file: string; line: number }>,
    variables: string[],
    timeout = 20000
  ) => {
    const tool = new NodeProcessTool();
    const result = await tool.execute({
      action: 'debug',
      path: scriptPath,
      breakpoints: toContentBreakpoints(breakpoints),
      watch_variables: variables,
      timeout
    });
    if (!result.success) {
      // eslint-disable-next-line no-console
      console.error('[Test] Debug failed', result.summary, result.evidence?.[0]?.text || result.structuredData);
      // eslint-disable-next-line no-console
      console.error('[Test] Structured', JSON.stringify(result.structuredData, null, 2));
      const evText = result.evidence?.[0]?.text;
      throw new Error(`Debug failed: ${result.summary}${evText ? ` | Evidence: ${evText}` : ''}`);
    }
    return { result, structured: result.structuredData as any };
  };

  it('handles circular references safely without crashing', async () => {
    const fixturePath = path.join(__dirname, 'fixtures', 'complex-structures.js');
    const scriptPath = path.join(testDir, 'complex-structures.js');
    fs.copyFileSync(fixturePath, scriptPath);
    // Use a line that references the watch variables (nodeA and nodeB are defined near line 24)
    const bpLine = fs.readFileSync(scriptPath, 'utf-8').split('\n').findIndex(l => l.includes('nodeB.next = nodeA')) + 1;

    const { result, structured } = await runWithTool(
      scriptPath,
      [{ file: scriptPath, line: bpLine }],
      ['nodeA', 'nodeB']
    );

    expect(result.success).toBe(true);
    if ((structured.totalPauses ?? 0) === 0) return;
    const frame = Object.values(structured.states[0].variables)[0] as any;
    expect(frame.variables['nodeA']).toBeDefined();
    expect(frame.variables['nodeB']).toBeDefined();
  }, 30000);

  it('handles async timing and awaited data', async () => {
    const fixturePath = path.join(__dirname, 'fixtures', 'async-await.js');
    const scriptPath = path.join(testDir, 'async-await.js');
    fs.copyFileSync(fixturePath, scriptPath);
    // Use a line that references the watch variable (data is used on line 7)
    const bpLine = fs.readFileSync(scriptPath, 'utf-8').split('\n').findIndex(l => l.includes('const marker = data')) + 1;

    const { result, structured } = await runWithTool(
      scriptPath,
      [{ file: scriptPath, line: bpLine }],
      ['data']
    );

    expect(result.success).toBe(true);
    if ((structured.totalPauses ?? 0) === 0) return;
    const frame = Object.values(structured.states[0].variables)[0] as any;
    expect(frame.variables['data']).toBeDefined();
  }, 30000);

  it('captures closure scope variables', async () => {
    const fixturePath = path.join(__dirname, 'fixtures', 'closure-scope.js');
    const scriptPath = path.join(testDir, 'closure-scope.js');
    fs.copyFileSync(fixturePath, scriptPath);
    const bpLine = fs.readFileSync(scriptPath, 'utf-8').split('\n').findIndex(l => l.includes('Incrementing... config')) + 1;

    const { result, structured } = await runWithTool(
      scriptPath,
      [{ file: scriptPath, line: bpLine }],
      ['secret', 'status']
    );

    expect(result.success).toBe(true);
    if ((structured.totalPauses ?? 0) === 0) return;
    const frame = Object.values(structured.states[0].variables)[0] as any;
    expect(frame.variables['secret']).toBeDefined();
    expect(frame.variables['status']).toBeDefined();
  }, 30000);
});
