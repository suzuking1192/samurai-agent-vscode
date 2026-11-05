/**
 * Tests for NoAsyncForEachRule
 */

import { NoAsyncForEachRule } from '../NoAsyncForEachRule';
import { Project, TypeChecker, Node } from 'ts-morph';

describe('NoAsyncForEachRule', () => {
  let project: Project;
  let checker: TypeChecker;
  let rule: NoAsyncForEachRule;

  beforeEach(() => {
    project = new Project({
      useInMemoryFileSystem: true,
      skipAddingFilesFromTsConfig: true,
      compilerOptions: { allowJs: true }
    });
    rule = new NoAsyncForEachRule();
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

  function findForEachCalls(sourceFile: any) {
    const calls: any[] = [];
    sourceFile.forEachDescendant((node: any) => {
      if (Node.isCallExpression(node)) {
        const expr = node.getExpression();
        if (Node.isPropertyAccessExpression(expr) && expr.getName() === 'forEach') {
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

    it('should return null for non-forEach calls', () => {
      const sourceFile = createSourceFile(`
const arr = [1, 2, 3];
arr.map(x => x * 2);
`);
      const calls = findForEachCalls(sourceFile);
      
      // Should find no forEach calls
      const mapCalls: any[] = [];
      sourceFile.forEachDescendant((node: any) => {
        if (Node.isCallExpression(node)) {
          const expr = node.getExpression();
          if (Node.isPropertyAccessExpression(expr) && expr.getName() === 'map') {
            mapCalls.push(node);
          }
        }
      });
      
      if (mapCalls.length > 0) {
        const result = rule.inspect(mapCalls[0], checker);
        expect(result).toBeNull(); // Not forEach
      }
    });

    it('should detect async callback in forEach', () => {
      const sourceFile = createSourceFile(`
const items = ['a', 'b', 'c'];
items.forEach(async (item) => {
  await fetch(\`/api/\${item}\`);
});
`);
      const forEachCalls = findForEachCalls(sourceFile);
      expect(forEachCalls.length).toBeGreaterThan(0);
      
      const result = rule.inspect(forEachCalls[0], checker);
      
      expect(result).not.toBeNull();
      expect(result?.ruleId).toBe('no-async-foreach');
      expect(result?.severity).toBe('critical');
      expect(result?.message).toContain('forEach');
      expect(result?.message).toContain('async');
    });

    it('should detect async function expression in forEach', () => {
      const sourceFile = createSourceFile(`
const items = [1, 2, 3];
items.forEach(async function(item) {
  await save(item);
});
`);
      const forEachCalls = findForEachCalls(sourceFile);
      expect(forEachCalls.length).toBeGreaterThan(0);
      
      const result = rule.inspect(forEachCalls[0], checker);
      
      expect(result).not.toBeNull();
      expect(result?.ruleId).toBe('no-async-foreach');
    });

    it('should not flag sync callback in forEach', () => {
      const sourceFile = createSourceFile(`
const items = [1, 2, 3];
items.forEach((item) => {
  console.log(item);
});
`);
      const forEachCalls = findForEachCalls(sourceFile);
      expect(forEachCalls.length).toBeGreaterThan(0);
      
      const result = rule.inspect(forEachCalls[0], checker);
      
      // Sync forEach is fine
      expect(result).toBeNull();
    });

    it('should not flag sync function expression in forEach', () => {
      const sourceFile = createSourceFile(`
const items = [1, 2, 3];
items.forEach(function(item) {
  process(item);
});
`);
      const forEachCalls = findForEachCalls(sourceFile);
      expect(forEachCalls.length).toBeGreaterThan(0);
      
      const result = rule.inspect(forEachCalls[0], checker);
      
      // Sync forEach is fine
      expect(result).toBeNull();
    });

    it('should handle forEach with no arguments', () => {
      const sourceFile = createSourceFile(`
const arr: any[] = [];
arr.forEach();
`);
      const forEachCalls = findForEachCalls(sourceFile);
      
      if (forEachCalls.length > 0) {
        const result = rule.inspect(forEachCalls[0], checker);
        // No callback argument, so should return null
        expect(result).toBeNull();
      }
    });
  });

  describe('rule properties', () => {
    it('should have correct rule ID', () => {
      expect(rule.id).toBe('no-async-foreach');
    });

    it('should implement AnalysisRule interface', () => {
      expect(rule).toHaveProperty('id');
      expect(rule).toHaveProperty('inspect');
      expect(typeof rule.inspect).toBe('function');
    });
  });
});
