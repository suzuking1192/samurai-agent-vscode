/**
 * Tests for UnsafeMutationRule
 */

import { UnsafeMutationRule } from '../UnsafeMutationRule';
import { Project, TypeChecker, Node } from 'ts-morph';

describe('UnsafeMutationRule', () => {
  let project: Project;
  let checker: TypeChecker;
  let rule: UnsafeMutationRule;

  beforeEach(() => {
    project = new Project({
      useInMemoryFileSystem: true,
      skipAddingFilesFromTsConfig: true,
      compilerOptions: { allowJs: true }
    });
    rule = new UnsafeMutationRule();
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

    it('should return null for non-mutating methods', () => {
      const sourceFile = createSourceFile(`
function process(arr: number[]) {
  arr.map(x => x * 2);
}
`);
      const calls = findCallExpressions(sourceFile, 'map');
      expect(calls.length).toBeGreaterThan(0);
      
      const result = rule.inspect(calls[0], checker);
      expect(result).toBeNull(); // map doesn't mutate
    });

    it('should detect mutation on function parameter', () => {
      const sourceFile = createSourceFile(`
function process(arr: number[]) {
  arr.sort();
}
`);
      const calls = findCallExpressions(sourceFile, 'sort');
      expect(calls.length).toBeGreaterThan(0);
      
      const result = rule.inspect(calls[0], checker);
      
      expect(result).not.toBeNull();
      expect(result?.ruleId).toBe('unsafe-mutation');
      expect(result?.severity).toBe('warning');
      expect(result?.message).toContain('function parameter');
      expect(result?.message).toContain('sort');
    });

    it('should detect mutation on imported value', () => {
      const sourceFile = project.createSourceFile('import.ts', 'export const data = [1, 2, 3];');
      const testFile = createSourceFile(`
import { data } from './import';
data.reverse();
`);
      const calls = findCallExpressions(testFile, 'reverse');
      expect(calls.length).toBeGreaterThan(0);
      
      const result = rule.inspect(calls[0], checker);
      
      expect(result).not.toBeNull();
      expect(result?.ruleId).toBe('unsafe-mutation');
      expect(result?.severity).toBe('warning');
      expect(result?.message).toContain('imported value');
    });

    it('should detect splice on parameter', () => {
      const sourceFile = createSourceFile(`
function removeItems(arr: number[]) {
  arr.splice(0, 2);
}
`);
      const calls = findCallExpressions(sourceFile, 'splice');
      expect(calls.length).toBeGreaterThan(0);
      
      const result = rule.inspect(calls[0], checker);
      
      expect(result).not.toBeNull();
      expect(result?.ruleId).toBe('unsafe-mutation');
      expect(result?.message).toContain('splice');
    });

    it('should detect push on parameter', () => {
      const sourceFile = createSourceFile(`
function addItem(arr: number[]) {
  arr.push(42);
}
`);
      const calls = findCallExpressions(sourceFile, 'push');
      expect(calls.length).toBeGreaterThan(0);
      
      const result = rule.inspect(calls[0], checker);
      
      expect(result).not.toBeNull();
      expect(result?.ruleId).toBe('unsafe-mutation');
    });

    it('should not flag mutations on local variables', () => {
      const sourceFile = createSourceFile(`
function process() {
  const arr = [1, 2, 3];
  arr.sort();
}
`);
      const calls = findCallExpressions(sourceFile, 'sort');
      expect(calls.length).toBeGreaterThan(0);
      
      const result = rule.inspect(calls[0], checker);
      
      // Local variables are safe to mutate
      expect(result).toBeNull();
    });

    it('should detect all mutating methods', () => {
      const mutators = ['sort', 'reverse', 'splice', 'push', 'pop', 'shift', 'unshift', 'fill'];
      
      mutators.forEach((method, index) => {
        const sourceFile = project.createSourceFile(`test${index}.ts`, `
function test(arr: number[]) {
  arr.${method}();
}
`, { overwrite: true });
        checker = project.getTypeChecker();
        const calls = findCallExpressions(sourceFile, method);
        if (calls.length > 0) {
          const result = rule.inspect(calls[0], checker);
          expect(result).not.toBeNull();
          expect(result?.ruleId).toBe('unsafe-mutation');
        }
      });
    });
  });

  describe('rule properties', () => {
    it('should have correct rule ID', () => {
      expect(rule.id).toBe('unsafe-mutation');
    });

    it('should implement AnalysisRule interface', () => {
      expect(rule).toHaveProperty('id');
      expect(rule).toHaveProperty('inspect');
      expect(typeof rule.inspect).toBe('function');
    });
  });
});















