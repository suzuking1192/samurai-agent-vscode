/**
 * Tests for SwallowedErrorRule
 */

import { SwallowedErrorRule } from '../SwallowedErrorRule';
import { Project, TypeChecker, Node } from 'ts-morph';

describe('SwallowedErrorRule', () => {
  let project: Project;
  let checker: TypeChecker;
  let rule: SwallowedErrorRule;

  beforeEach(() => {
    project = new Project({
      useInMemoryFileSystem: true,
      skipAddingFilesFromTsConfig: true,
      compilerOptions: { allowJs: true }
    });
    rule = new SwallowedErrorRule();
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

  function findCatchClauses(sourceFile: any) {
    const catches: any[] = [];
    sourceFile.forEachDescendant((node: any) => {
      if (Node.isCatchClause(node)) {
        catches.push(node);
      }
    });
    return catches;
  }

  describe('inspect', () => {
    it('should return null for non-catch-clause nodes', () => {
      const sourceFile = createSourceFile('const x = 42;');
      const variableDecl = sourceFile.getVariableDeclaration('x');
      
      expect(variableDecl).toBeDefined();
      const result = rule.inspect(variableDecl!, checker);
      expect(result).toBeNull();
    });

    it('should detect empty catch block', () => {
      const sourceFile = createSourceFile(`
try {
  riskyOperation();
} catch (e) {
}
`);
      const catches = findCatchClauses(sourceFile);
      expect(catches.length).toBeGreaterThan(0);
      
      const result = rule.inspect(catches[0], checker);
      
      expect(result).not.toBeNull();
      expect(result?.ruleId).toBe('swallowed-error');
      expect(result?.severity).toBe('critical');
      expect(result?.message).toContain('Empty catch block');
      expect(result?.message).toContain('Silent Failure');
    });

    it('should detect catch block with unused error variable', () => {
      const sourceFile = createSourceFile(`
try {
  riskyOperation();
} catch (e) {
  console.log('Something went wrong');
}
`);
      const catches = findCatchClauses(sourceFile);
      expect(catches.length).toBeGreaterThan(0);
      
      const result = rule.inspect(catches[0], checker);
      
      expect(result).not.toBeNull();
      expect(result?.ruleId).toBe('swallowed-error');
      expect(result?.severity).toBe('warning');
      expect(result?.message).toContain('never used');
    });

    it('should not flag catch block that uses error variable', () => {
      const sourceFile = createSourceFile(`
try {
  riskyOperation();
} catch (e) {
  console.error('Error:', e.message);
}
`);
      const catches = findCatchClauses(sourceFile);
      expect(catches.length).toBeGreaterThan(0);
      
      const result = rule.inspect(catches[0], checker);
      
      // Error variable is used, so this is fine
      expect(result).toBeNull();
    });

    it('should not flag catch block that logs error', () => {
      const sourceFile = createSourceFile(`
try {
  riskyOperation();
} catch (e) {
  console.error(e);
  throw e;
}
`);
      const catches = findCatchClauses(sourceFile);
      expect(catches.length).toBeGreaterThan(0);
      
      const result = rule.inspect(catches[0], checker);
      
      // Error is logged and rethrown, so this is fine
      expect(result).toBeNull();
    });

    it('should detect catch block with only comments', () => {
      const sourceFile = createSourceFile(`
try {
  riskyOperation();
} catch (e) {
  // TODO: handle this later
}
`);
      const catches = findCatchClauses(sourceFile);
      expect(catches.length).toBeGreaterThan(0);
      
      const result = rule.inspect(catches[0], checker);
      
      // Comments don't count as using the error
      expect(result).not.toBeNull();
      expect(result?.severity).toBe('warning');
    });

    it('should handle catch without error variable', () => {
      const sourceFile = createSourceFile(`
try {
  riskyOperation();
} catch {
  console.log('Error occurred');
}
`);
      const catches = findCatchClauses(sourceFile);
      expect(catches.length).toBeGreaterThan(0);
      
      const result = rule.inspect(catches[0], checker);
      
      // No error variable to check, but block is not empty
      expect(result).toBeNull();
    });
  });

  describe('rule properties', () => {
    it('should have correct rule ID', () => {
      expect(rule.id).toBe('swallowed-error');
    });

    it('should implement AnalysisRule interface', () => {
      expect(rule).toHaveProperty('id');
      expect(rule).toHaveProperty('inspect');
      expect(typeof rule.inspect).toBe('function');
    });
  });
});
