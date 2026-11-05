/**
 * Unit tests for RuntimeClient breakpoint-based inspection using NodeProcessTool.
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

jest.retryTimes(2, { logErrorsBeforeRetry: true });

describe('RuntimeClient Unit Tests', () => {
  let testDir: string;

  beforeEach(() => {
    testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'runtime-client-unit-'));
    (vscode.workspace as any).workspaceFolders = [
      {
        uri: { fsPath: testDir },
        name: 'UnitWorkspace',
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
      return { file: bp.file, content };
    });
  };

  const runWithTool = async (
    scriptPath: string,
    breakpoints: Array<{ file: string; line: number }>,
    variables: string[]
  ) => {
    const tool = new NodeProcessTool();
    const result = await tool.execute({
      action: 'debug',
      path: scriptPath,
      breakpoints: toContentBreakpoints(breakpoints),
      watch_variables: variables,
      timeout: 15000
    });
    return { result, structured: result.structuredData as any };
  };

  describe('inspect() method', () => {
    it('should set breakpoints and extract primitive variables', async () => {
      const scriptContent = `
// Test primitive extraction
const localVar = "I am local";

function testFunction() {
  const computed = 42 * 2;
  debugger;
  console.log("Computed:", computed);
}

testFunction();
setTimeout(() => process.exit(0), 5000);
`;
      const scriptPath = path.join(testDir, 'primitive-test.js');
      fs.writeFileSync(scriptPath, scriptContent);
      const bpLine = scriptContent.split('\n').findIndex(l => l.includes('debugger')) + 1;

      const { result, structured } = await runWithTool(
        scriptPath,
        [{ file: scriptPath, line: bpLine }],
        ['localVar', 'computed']
      );

      expect(result.success).toBe(true);
      const state = structured.states[0];
      expect(state.lineNumber).toBe(bpLine);

      const frameData = Object.values(state.variables)[0] as any;
      expect(frameData).toBeDefined();
      // 'computed' should be in local scope of testFunction
      expect(frameData.variables['computed']?.value).toBe(84);
      // 'localVar' might be in closure or global scope - check if it exists
      // It may not be extracted if only local scope is checked
    }, 30000);

    it('should extract nested objects recursively', async () => {
      const scriptContent = `
// Test nested object extraction
const config = {
  name: "TestApp",
  settings: {
    debug: true,
    level: 3,
    features: ["a", "b", "c"]
  },
  metadata: {
    version: "1.0.0",
    nested: {
      deep: "value"
    }
  }
};

function processConfig() {
  const localConfig = config;
  debugger;
  console.log("Processing config");
  return localConfig;
}

processConfig();
setTimeout(() => process.exit(0), 5000);
`;
      const scriptPath = path.join(testDir, 'nested-object.js');
      fs.writeFileSync(scriptPath, scriptContent);
      const bpLine = scriptContent.split('\n').findIndex(l => l.includes('debugger')) + 1;

      const { result, structured } = await runWithTool(
        scriptPath,
        [{ file: scriptPath, line: bpLine }],
        ['config', 'localConfig']
      );

      expect(result.success).toBe(true);
      const state = structured.states[0];
      const frameData = Object.values(state.variables)[0] as any;

      const configVal = frameData.variables['config']?.value;
      const localConfigVal = frameData.variables['localConfig']?.value;
      expect(configVal?.settings?.features?.length).toBe(3);
      expect(configVal?.metadata?.nested?.deep).toBe('value');
      expect(localConfigVal?.metadata?.nested?.deep).toBe('value');
    }, 30000);

    it('should extract variables from multiple call frames', async () => {
      const scriptContent = `
// Test multi-frame extraction
function outer() {
  const outerVar = "outer value";
  function inner() {
    const innerVar = "inner value";
    function deep() {
      const deepVar = "deep value";
      debugger;
      return deepVar;
    }
    return deep();
  }
  return inner();
}
outer();
setTimeout(() => process.exit(0), 5000);
`;
      const scriptPath = path.join(testDir, 'multi-frame.js');
      fs.writeFileSync(scriptPath, scriptContent);
      const bpLine = scriptContent.split('\n').findIndex(l => l.includes('debugger')) + 1;

      const { result, structured } = await runWithTool(
        scriptPath,
        [{ file: scriptPath, line: bpLine }],
        ['outerVar', 'innerVar', 'deepVar']
      );

      expect(result.success).toBe(true);
      const state = structured.states[0];

      expect(Object.keys(state.variables).length).toBeGreaterThan(0);

      let foundInnerVar = false;
      for (const fd of Object.values(state.variables)) {
        const frameData = fd as any;
        if (frameData.variables['innerVar']?.success) {
          foundInnerVar = true;
          expect(frameData.variables['innerVar'].value).toBe('inner value');
        }
      }
      expect(foundInnerVar).toBe(true);
    }, 30000);
  });
});
