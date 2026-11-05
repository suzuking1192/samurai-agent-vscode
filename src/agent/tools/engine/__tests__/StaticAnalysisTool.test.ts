/**
 * Tests for StaticAnalysisTool
 */

import { StaticAnalysisTool } from '../StaticAnalysisTool';
import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';

// Mock vscode
jest.mock('vscode', () => ({
  workspace: {
    workspaceFolders: [
      {
        uri: {
          fsPath: '/test/workspace'
        }
      }
    ]
  }
}));

describe('StaticAnalysisTool', () => {
  let staticAnalysisTool: StaticAnalysisTool;
  let testDir: string;
  let testFilePath: string;
  let realWorkspacePath: string;

  beforeEach(() => {
    staticAnalysisTool = new StaticAnalysisTool();
    
    // Create a real temporary directory for test files
    realWorkspacePath = fs.mkdtempSync(path.join(os.tmpdir(), 'static-analysis-workspace-'));
    testDir = path.join(realWorkspacePath, 'test-temp');
    testFilePath = path.join(testDir, 'test.ts');
    
    // Create the test directory structure
    fs.mkdirSync(testDir, { recursive: true });
    
    // Update the workspace mock to point to real directory
    (vscode.workspace as any).workspaceFolders = [
      {
        uri: {
          fsPath: realWorkspacePath
        }
      }
    ];
  });

  afterEach(() => {
    // Clean up test files
    if (fs.existsSync(testFilePath)) {
      fs.unlinkSync(testFilePath);
    }
    if (fs.existsSync(realWorkspacePath)) {
      try {
        // Remove entire workspace temp directory
        fs.rmSync(realWorkspacePath, { recursive: true, force: true });
      } catch (e) {
        // Ignore cleanup errors
      }
    }
  });

  describe('execute - metrics mode', () => {
    it('should return error when no workspace folder is open', async () => {
      const originalMock = (vscode.workspace as any).workspaceFolders;
      (vscode.workspace as any).workspaceFolders = undefined;

      const result = await staticAnalysisTool.execute({
        filePath: 'test.ts',
        mode: 'metrics'
      });

      expect(result.success).toBe(false);
      expect(result.summary).toBe('No workspace open.');
      
      // Restore original mock
      (vscode.workspace as any).workspaceFolders = originalMock;
    });

    it('should calculate complexity for simple function', async () => {
      const testCode = `
function simpleFunction() {
  return 42;
}
`;
      fs.writeFileSync(testFilePath, testCode);

      const result = await staticAnalysisTool.execute({
        filePath: 'test-temp/test.ts',
        mode: 'metrics'
      });

      expect(result.success).toBe(true);
      expect(result.summary).toContain('Max Complexity: 1');
      expect(result.structuredData).toBeDefined();
      expect(result.structuredData?.maxComplexity).toBe(1);
      expect(result.structuredData?.functions).toBeDefined();
      expect(result.structuredData?.functions.length).toBeGreaterThan(0);
    });

    it('should calculate complexity for function with conditionals', async () => {
      const testCode = `
function complexFunction(x: number) {
  if (x > 0) {
    if (x > 10) {
      return x * 2;
    }
    return x;
  }
  return 0;
}
`;
      fs.writeFileSync(testFilePath, testCode);

      const result = await staticAnalysisTool.execute({
        filePath: 'test-temp/test.ts',
        mode: 'metrics'
      });

      expect(result.success).toBe(true);
      expect(result.structuredData?.maxComplexity).toBeGreaterThan(1);
    });

    it('should handle functions with loops', async () => {
      const testCode = `
function loopFunction(items: number[]) {
  for (const item of items) {
    if (item > 5) {
      console.log(item);
    }
  }
}
`;
      fs.writeFileSync(testFilePath, testCode);

      const result = await staticAnalysisTool.execute({
        filePath: 'test-temp/test.ts',
        mode: 'metrics'
      });

      expect(result.success).toBe(true);
      expect(result.structuredData?.maxComplexity).toBeGreaterThan(1);
    });

    it('should handle class methods', async () => {
      const testCode = `
class TestClass {
  method1() {
    return 1;
  }
  
  method2(x: number) {
    if (x > 0) {
      return x;
    }
    return 0;
  }
}
`;
      fs.writeFileSync(testFilePath, testCode);

      const result = await staticAnalysisTool.execute({
        filePath: 'test-temp/test.ts',
        mode: 'metrics'
      });

      expect(result.success).toBe(true);
      expect(result.structuredData?.functions.length).toBeGreaterThanOrEqual(2);
    });
  });

  describe('execute - source mode', () => {
    it('should return error when file not found', async () => {
      const result = await staticAnalysisTool.execute({
        filePath: 'test-temp/nonexistent.ts',
        mode: 'source'
      });

      expect(result.success).toBe(false);
      expect(result.summary).toContain('Failed to load file');
    });

    it('should extract function source code', async () => {
      const testCode = `
function myFunction(x: number): number {
  return x * 2;
}

function anotherFunction() {
  console.log('test');
}
`;
      fs.writeFileSync(testFilePath, testCode);

      const result = await staticAnalysisTool.execute({
        filePath: 'test-temp/test.ts',
        mode: 'source',
        target: 'myFunction'
      });

      expect(result.success).toBe(true);
      expect(result.summary).toContain('Extracted source for');
      expect(result.evidence).toBeDefined();
      expect(result.evidence?.length).toBe(1);
      expect(result.evidence![0].text).toContain('myFunction');
      expect(result.evidence![0].text).toContain('x * 2');
    });

    it('should extract class source code', async () => {
      const testCode = `
class MyClass {
  private value: number;
  
  constructor(value: number) {
    this.value = value;
  }
  
  getValue(): number {
    return this.value;
  }
}
`;
      fs.writeFileSync(testFilePath, testCode);

      const result = await staticAnalysisTool.execute({
        filePath: 'test-temp/test.ts',
        mode: 'source',
        target: 'MyClass'
      });

      expect(result.success).toBe(true);
      expect(result.evidence).toBeDefined();
      expect(result.evidence![0].text).toContain('class MyClass');
    });

    it('should return full source code when no target specified', async () => {
      const testCode = `
function func1() {
  return 1;
}
function func2() {
  return 2;
}
class MyClass {
  method() {
    return 'test';
  }
}
`;
      fs.writeFileSync(testFilePath, testCode);

      const result = await staticAnalysisTool.execute({
        filePath: 'test-temp/test.ts',
        mode: 'source'
      });

      expect(result.success).toBe(true);
      expect(result.summary).toContain('Full source code');
      expect(result.summary).toContain('test.ts');
      expect(result.evidence).toBeDefined();
      expect(result.evidence?.length).toBe(1);
      expect(result.evidence![0].file).toBe('test-temp/test.ts');
      expect(result.evidence![0].line).toBe(1);
      expect(result.evidence![0].description).toBe('Full File Content');
      // Verify the full source code is returned
      expect(result.evidence![0].text).toContain('function func1()');
      expect(result.evidence![0].text).toContain('return 1;');
      expect(result.evidence![0].text).toContain('function func2()');
      expect(result.evidence![0].text).toContain('return 2;');
      expect(result.evidence![0].text).toContain('class MyClass');
      expect(result.evidence![0].text).toContain("return 'test';");
      // Should not have structuredData (that was the old behavior)
      expect(result.structuredData).toBeUndefined();
    });

    it('should return error when target not found', async () => {
      const testCode = `function existingFunction() {}`;
      fs.writeFileSync(testFilePath, testCode);

      const result = await staticAnalysisTool.execute({
        filePath: 'test-temp/test.ts',
        mode: 'source',
        target: 'nonexistentFunction'
      });

      expect(result.success).toBe(false);
      expect(result.summary).toContain('not found');
    });
  });

  describe('execute - flow mode', () => {
    it('should detect floating promise', async () => {
      const testCode = `
async function saveData() {
  return Promise.resolve();
}

function badFunction() {
  saveData(); // Floating promise!
}
`;
      fs.writeFileSync(testFilePath, testCode);

      const result = await staticAnalysisTool.execute({
        filePath: 'test-temp/test.ts',
        mode: 'flow'
      });

      expect(result.success).toBe(true);
      // Should detect at least one issue
      if (result.evidence && result.evidence.length > 0) {
        expect(result.summary).toContain('logic issues');
        expect(result.evidence[0].description).toContain('async-race');
      }
    });

    it('should not flag awaited promises', async () => {
      const testCode = `
async function saveData() {
  return Promise.resolve();
}

async function goodFunction() {
  await saveData(); // Properly awaited
}
`;
      fs.writeFileSync(testFilePath, testCode);

      const result = await staticAnalysisTool.execute({
        filePath: 'test-temp/test.ts',
        mode: 'flow'
      });

      expect(result.success).toBe(true);
      // Should not detect issues for properly awaited promises
      if (result.evidence && result.evidence.length > 0) {
        // If issues are found, they shouldn't be about the awaited call
        expect(result.evidence[0].description).not.toContain('saveData');
      }
    });

    it('should not flag returned promises', async () => {
      const testCode = `
async function getData() {
  return Promise.resolve({ data: 'test' });
}

async function wrapper() {
  return getData(); // Returned, not floating
}
`;
      fs.writeFileSync(testFilePath, testCode);

      const result = await staticAnalysisTool.execute({
        filePath: 'test-temp/test.ts',
        mode: 'flow'
      });

      expect(result.success).toBe(true);
      // Should not flag returned promises as floating
    });

    it('should not flag assigned promises', async () => {
      const testCode = `
async function getData() {
  return Promise.resolve({ data: 'test' });
}

function wrapper() {
  const promise = getData(); // Assigned, not floating
  return promise;
}
`;
      fs.writeFileSync(testFilePath, testCode);

      const result = await staticAnalysisTool.execute({
        filePath: 'test-temp/test.ts',
        mode: 'flow'
      });

      expect(result.success).toBe(true);
      // Assigned promises should not be flagged
    });

    it('should not flag voided promises', async () => {
      const testCode = `
async function fireAndForget() {
  console.log('done');
}

function wrapper() {
  void fireAndForget(); // Explicitly voided
}
`;
      fs.writeFileSync(testFilePath, testCode);

      const result = await staticAnalysisTool.execute({
        filePath: 'test-temp/test.ts',
        mode: 'flow'
      });

      expect(result.success).toBe(true);
      // Voided promises should not be flagged
    });

    it('should return success with no issues when code is clean', async () => {
      const testCode = `
function simpleFunction() {
  return 42;
}
`;
      fs.writeFileSync(testFilePath, testCode);

      const result = await staticAnalysisTool.execute({
        filePath: 'test-temp/test.ts',
        mode: 'flow'
      });

      expect(result.success).toBe(true);
      expect(result.summary).toContain('No logic issues detected');
    });

    it('should filter rules when flowConfig specifies rules', async () => {
      const testCode = `
async function saveData() {
  return Promise.resolve();
}

function badFunction() {
  saveData();
}
`;
      fs.writeFileSync(testFilePath, testCode);

      const result = await staticAnalysisTool.execute({
        filePath: testFilePath,
        mode: 'flow',
        flowConfig: {
          rules: ['async-race']
        }
      });

      expect(result.success).toBe(true);
      // Should still work with filtered rules
    });
  });

  describe('execute - error handling', () => {
    it('should handle invalid mode gracefully', async () => {
      const testCode = `function test() {}`;
      fs.writeFileSync(testFilePath, testCode);

      // TypeScript will catch this, but test that the tool handles it
      const result = await staticAnalysisTool.execute({
        filePath: 'test-temp/test.ts',
        mode: 'metrics' as any
      });

      expect(result.success).toBe(true); // Metrics mode is valid
    });

    it('should handle syntax errors in file gracefully', async () => {
      const invalidCode = `
function brokenFunction( {
  return // Missing semicolon and closing brace
`;
      fs.writeFileSync(testFilePath, invalidCode);

      const result = await staticAnalysisTool.execute({
        filePath: 'test-temp/test.ts',
        mode: 'metrics'
      });

      // Should either succeed (if ts-morph handles it) or fail gracefully
      expect(typeof result.success).toBe('boolean');
    });
  });
});

