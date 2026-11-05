/**
 * Tests for NoSyncIoRule
 */

import { NoSyncIoRule } from '../NoSyncIoRule';
import { Project, TypeChecker, Node } from 'ts-morph';

describe('NoSyncIoRule', () => {
  let project: Project;
  let checker: TypeChecker;
  let rule: NoSyncIoRule;

  beforeEach(() => {
    project = new Project({
      useInMemoryFileSystem: true,
      skipAddingFilesFromTsConfig: true,
      compilerOptions: { allowJs: true }
    });
    rule = new NoSyncIoRule();
  });

  afterEach(() => {
    project = undefined as any;
    checker = undefined as any;
  });

  function createSourceFile(code: string) {
    const sourceFile = project.createSourceFile('test.ts', code);
    checker = project.getTypeChecker();
    return sourceFile;
  }

  function findCallExpressions(sourceFile: any, text?: string) {
    const calls: any[] = [];
    sourceFile.forEachDescendant((node: any) => {
      if (Node.isCallExpression(node)) {
        const expr = node.getExpression();
        const exprText = expr.getText();
        if (!text || exprText.includes(text)) {
          calls.push(node);
        }
      }
    });
    return calls;
  }

  describe('inspect', () => {
    it('should return null for non-call expressions', () => {
      const sourceFile = createSourceFile('const x = 42;');
      const variableDecl = sourceFile.getVariableDeclaration('x');
      
      expect(variableDecl).toBeDefined();
      const result = rule.inspect(variableDecl!, checker);
      expect(result).toBeNull();
    });

    it('should return null for non-Sync calls', () => {
      const sourceFile = createSourceFile(`
import * as fs from 'fs';
fs.readFile('file.txt', () => {});
`);
      const calls = findCallExpressions(sourceFile, 'readFile');
      expect(calls.length).toBeGreaterThan(0);
      
      const result = rule.inspect(calls[0], checker);
      expect(result).toBeNull(); // Not a Sync call
    });

    it('should return null for non-Node built-in Sync calls', () => {
      const sourceFile = createSourceFile(`
function customSync() {}
customSync();
`);
      const calls = findCallExpressions(sourceFile);
      expect(calls.length).toBeGreaterThan(0);
      
      const result = rule.inspect(calls[0], checker);
      expect(result).toBeNull(); // Not a Node built-in
    });

    it('should detect fs.readFileSync in request handler', () => {
      const sourceFile = createSourceFile(`
import * as fs from 'fs';
function handler(req: any, res: any) {
  const data = fs.readFileSync('file.txt', 'utf8');
  res.send(data);
}
`);
      const calls = findCallExpressions(sourceFile, 'readFileSync');
      expect(calls.length).toBeGreaterThan(0);
      
      const result = rule.inspect(calls[0], checker);
      
      expect(result).not.toBeNull();
      expect(result?.ruleId).toBe('node-sync-io');
      expect(result?.severity).toBe('critical');
      expect(result?.message).toContain('request handler');
      expect(result?.message).toContain('readFileSync');
    });

    it('should detect fs.writeFileSync in request handler', () => {
      const sourceFile = createSourceFile(`
import * as fs from 'fs';
function handler(req: any, res: any) {
  fs.writeFileSync('file.txt', 'data');
}
`);
      const calls = findCallExpressions(sourceFile, 'writeFileSync');
      expect(calls.length).toBeGreaterThan(0);
      
      const result = rule.inspect(calls[0], checker);
      
      expect(result).not.toBeNull();
      expect(result?.ruleId).toBe('node-sync-io');
    });

    it('should detect crypto.pbkdf2Sync in request handler', () => {
      const sourceFile = createSourceFile(`
import * as crypto from 'crypto';
function handler(req: any, res: any) {
  const hash = crypto.pbkdf2Sync('password', 'salt', 1000, 64, 'sha512');
}
`);
      const calls = findCallExpressions(sourceFile, 'pbkdf2Sync');
      expect(calls.length).toBeGreaterThan(0);
      
      const result = rule.inspect(calls[0], checker);
      
      expect(result).not.toBeNull();
      expect(result?.ruleId).toBe('node-sync-io');
    });

    it('should detect sync I/O in loop', () => {
      const sourceFile = createSourceFile(`
import * as fs from 'fs';
for (let i = 0; i < 10; i++) {
  fs.readFileSync(\`file\${i}.txt\`, 'utf8');
}
`);
      const calls = findCallExpressions(sourceFile, 'readFileSync');
      expect(calls.length).toBeGreaterThan(0);
      
      const result = rule.inspect(calls[0], checker);
      
      expect(result).not.toBeNull();
      expect(result?.ruleId).toBe('node-sync-io');
      expect(result?.message).toContain('loop');
    });

    it('should detect sync I/O in while loop', () => {
      const sourceFile = createSourceFile(`
import * as fs from 'fs';
let i = 0;
while (i < 10) {
  fs.readFileSync(\`file\${i}.txt\`, 'utf8');
  i++;
}
`);
      const calls = findCallExpressions(sourceFile, 'readFileSync');
      expect(calls.length).toBeGreaterThan(0);
      
      const result = rule.inspect(calls[0], checker);
      
      expect(result).not.toBeNull();
      expect(result?.ruleId).toBe('node-sync-io');
    });

    it('should not flag sync I/O outside hot paths', () => {
      const sourceFile = createSourceFile(`
import * as fs from 'fs';
function init() {
  const config = fs.readFileSync('config.json', 'utf8');
  return JSON.parse(config);
}
`);
      const calls = findCallExpressions(sourceFile, 'readFileSync');
      expect(calls.length).toBeGreaterThan(0);
      
      const result = rule.inspect(calls[0], checker);
      
      // Init functions are not hot paths
      expect(result).toBeNull();
    });

    it('should detect child_process.execSync in request handler', () => {
      const sourceFile = createSourceFile(`
import { execSync } from 'child_process';
function handler(req: any, res: any) {
  const output = execSync('ls -la');
}
`);
      const calls = findCallExpressions(sourceFile, 'execSync');
      expect(calls.length).toBeGreaterThan(0);
      
      const result = rule.inspect(calls[0], checker);
      
      expect(result).not.toBeNull();
      expect(result?.ruleId).toBe('node-sync-io');
    });
  });

  describe('rule properties', () => {
    it('should have correct rule ID', () => {
      expect(rule.id).toBe('node-sync-io');
    });

    it('should implement AnalysisRule interface', () => {
      expect(rule).toHaveProperty('id');
      expect(rule).toHaveProperty('inspect');
      expect(typeof rule.inspect).toBe('function');
    });
  });
});















