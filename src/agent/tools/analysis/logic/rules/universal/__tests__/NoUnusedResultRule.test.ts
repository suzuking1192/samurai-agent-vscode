/**
 * Tests for NoUnusedResultRule
 */

import { NoUnusedResultRule } from '../NoUnusedResultRule';
import { Project, TypeChecker, Node } from 'ts-morph';

describe('NoUnusedResultRule', () => {
  let project: Project;
  let checker: TypeChecker;
  let rule: NoUnusedResultRule;

  beforeEach(() => {
    project = new Project({
      useInMemoryFileSystem: true,
      skipAddingFilesFromTsConfig: true,
      compilerOptions: { allowJs: true }
    });
    rule = new NoUnusedResultRule();
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

  function findCallExpressions(sourceFile: any, methodName?: string) {
    const calls: any[] = [];
    sourceFile.forEachDescendant((node: any) => {
      if (Node.isCallExpression(node)) {
        const expr = node.getExpression();
        if (Node.isPropertyAccessExpression(expr)) {
          if (!methodName || expr.getName() === methodName) {
            calls.push(node);
          }
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

    it('should return null for methods not in pureMethods set', () => {
      const sourceFile = createSourceFile(`
const arr = [1, 2, 3];
arr.push(4);
`);
      const calls = findCallExpressions(sourceFile, 'push');
      expect(calls.length).toBeGreaterThan(0);
      
      const result = rule.inspect(calls[0], checker);
      expect(result).toBeNull(); // push is not in pureMethods
    });

    it('should detect unused map result', () => {
      const sourceFile = createSourceFile(`
const arr = [1, 2, 3];
arr.map(x => x * 2);
`);
      const calls = findCallExpressions(sourceFile, 'map');
      expect(calls.length).toBeGreaterThan(0);
      
      const result = rule.inspect(calls[0], checker);
      
      expect(result).not.toBeNull();
      expect(result?.ruleId).toBe('no-unused-result');
      expect(result?.severity).toBe('warning');
      expect(result?.message).toContain('map');
      expect(result?.message).toContain('unused');
    });

    it('should detect unused filter result', () => {
      const sourceFile = createSourceFile(`
const arr = [1, 2, 3, 4];
arr.filter(x => x > 2);
`);
      const calls = findCallExpressions(sourceFile, 'filter');
      expect(calls.length).toBeGreaterThan(0);
      
      const result = rule.inspect(calls[0], checker);
      
      expect(result).not.toBeNull();
      expect(result?.ruleId).toBe('no-unused-result');
      expect(result?.message).toContain('filter');
    });

    it('should detect unused slice result', () => {
      const sourceFile = createSourceFile(`
const str = 'hello world';
str.slice(0, 5);
`);
      const calls = findCallExpressions(sourceFile, 'slice');
      expect(calls.length).toBeGreaterThan(0);
      
      const result = rule.inspect(calls[0], checker);
      
      expect(result).not.toBeNull();
      expect(result?.ruleId).toBe('no-unused-result');
    });

    it('should not flag map result that is assigned', () => {
      const sourceFile = createSourceFile(`
const arr = [1, 2, 3];
const doubled = arr.map(x => x * 2);
`);
      const calls = findCallExpressions(sourceFile, 'map');
      expect(calls.length).toBeGreaterThan(0);
      
      const result = rule.inspect(calls[0], checker);
      
      // Result is assigned, so this is fine
      expect(result).toBeNull();
    });

    it('should not flag map result that is returned', () => {
      const sourceFile = createSourceFile(`
function double(arr: number[]) {
  return arr.map(x => x * 2);
}
`);
      const calls = findCallExpressions(sourceFile, 'map');
      expect(calls.length).toBeGreaterThan(0);
      
      const result = rule.inspect(calls[0], checker);
      
      // Result is returned, so this is fine
      expect(result).toBeNull();
    });

    it('should not flag map result that is used in expression', () => {
      const sourceFile = createSourceFile(`
const arr = [1, 2, 3];
console.log(arr.map(x => x * 2));
`);
      const calls = findCallExpressions(sourceFile, 'map');
      expect(calls.length).toBeGreaterThan(0);
      
      const result = rule.inspect(calls[0], checker);
      
      // Result is used in console.log, so this is fine
      expect(result).toBeNull();
    });

    it('should detect unused toUpperCase result', () => {
      const sourceFile = createSourceFile(`
const str = 'hello';
str.toUpperCase();
`);
      const calls = findCallExpressions(sourceFile, 'toUpperCase');
      expect(calls.length).toBeGreaterThan(0);
      
      const result = rule.inspect(calls[0], checker);
      
      expect(result).not.toBeNull();
      expect(result?.ruleId).toBe('no-unused-result');
    });

    it('should detect unused concat result', () => {
      const sourceFile = createSourceFile(`
const arr1 = [1, 2];
const arr2 = [3, 4];
arr1.concat(arr2);
`);
      const calls = findCallExpressions(sourceFile, 'concat');
      expect(calls.length).toBeGreaterThan(0);
      
      const result = rule.inspect(calls[0], checker);
      
      expect(result).not.toBeNull();
      expect(result?.ruleId).toBe('no-unused-result');
    });
  });

  describe('rule properties', () => {
    it('should have correct rule ID', () => {
      expect(rule.id).toBe('no-unused-result');
    });

    it('should implement AnalysisRule interface', () => {
      expect(rule).toHaveProperty('id');
      expect(rule).toHaveProperty('inspect');
      expect(typeof rule.inspect).toBe('function');
    });
  });
});
