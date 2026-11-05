/**
 * Tests for NoAwaitInLoopRule
 */

import { NoAwaitInLoopRule } from '../NoAwaitInLoopRule';
import { Project, TypeChecker, Node } from 'ts-morph';

describe('NoAwaitInLoopRule', () => {
  let project: Project;
  let checker: TypeChecker;
  let rule: NoAwaitInLoopRule;

  beforeEach(() => {
    project = new Project({
      useInMemoryFileSystem: true,
      skipAddingFilesFromTsConfig: true,
      compilerOptions: { allowJs: true }
    });
    rule = new NoAwaitInLoopRule();
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

  function findAwaitExpressions(sourceFile: any) {
    const awaits: any[] = [];
    sourceFile.forEachDescendant((node: any) => {
      if (Node.isAwaitExpression(node)) {
        awaits.push(node);
      }
    });
    return awaits;
  }

  describe('inspect', () => {
    it('should return null for non-await expressions', () => {
      const sourceFile = createSourceFile('const x = 42;');
      const variableDecl = sourceFile.getVariableDeclaration('x');
      
      expect(variableDecl).toBeDefined();
      const result = rule.inspect(variableDecl!, checker);
      expect(result).toBeNull();
    });

    it('should return null for await outside loops', () => {
      const sourceFile = createSourceFile(`
async function test() {
  const result = await fetch('/api');
  return result;
}
`);
      const awaits = findAwaitExpressions(sourceFile);
      expect(awaits.length).toBeGreaterThan(0);
      
      const result = rule.inspect(awaits[0], checker);
      expect(result).toBeNull(); // Await outside loop is fine
    });

    it('should detect await inside for loop', () => {
      const sourceFile = createSourceFile(`
async function processItems(items: string[]) {
  for (let i = 0; i < items.length; i++) {
    await fetch(items[i]);
  }
}
`);
      const awaits = findAwaitExpressions(sourceFile);
      expect(awaits.length).toBeGreaterThan(0);
      
      const result = rule.inspect(awaits[0], checker);
      
      expect(result).not.toBeNull();
      expect(result?.ruleId).toBe('no-await-in-loop');
      expect(result?.severity).toBe('warning');
      expect(result?.message).toContain('await');
      expect(result?.message).toContain('loop');
    });

    it('should detect await inside for-of loop', () => {
      const sourceFile = createSourceFile(`
async function processItems(items: string[]) {
  for (const item of items) {
    await fetch(item);
  }
}
`);
      const awaits = findAwaitExpressions(sourceFile);
      expect(awaits.length).toBeGreaterThan(0);
      
      const result = rule.inspect(awaits[0], checker);
      
      expect(result).not.toBeNull();
      expect(result?.ruleId).toBe('no-await-in-loop');
    });

    it('should detect await inside while loop', () => {
      const sourceFile = createSourceFile(`
async function process() {
  let i = 0;
  while (i < 10) {
    await fetch(\`/api/\${i}\`);
    i++;
  }
}
`);
      const awaits = findAwaitExpressions(sourceFile);
      expect(awaits.length).toBeGreaterThan(0);
      
      const result = rule.inspect(awaits[0], checker);
      
      expect(result).not.toBeNull();
      expect(result?.ruleId).toBe('no-await-in-loop');
    });

    it('should detect await inside do-while loop', () => {
      const sourceFile = createSourceFile(`
async function process() {
  let i = 0;
  do {
    await fetch(\`/api/\${i}\`);
    i++;
  } while (i < 10);
}
`);
      const awaits = findAwaitExpressions(sourceFile);
      expect(awaits.length).toBeGreaterThan(0);
      
      const result = rule.inspect(awaits[0], checker);
      
      expect(result).not.toBeNull();
      expect(result?.ruleId).toBe('no-await-in-loop');
    });

    it('should not flag await inside function defined in loop', () => {
      const sourceFile = createSourceFile(`
async function test() {
  for (let i = 0; i < 10; i++) {
    async function helper() {
      await fetch('/api');
    }
  }
}
`);
      const awaits = findAwaitExpressions(sourceFile);
      expect(awaits.length).toBeGreaterThan(0);
      
      const result = rule.inspect(awaits[0], checker);
      
      // Await inside a function defined in a loop is fine (function boundary)
      expect(result).toBeNull();
    });

    it('should not flag await inside arrow function defined in loop', () => {
      const sourceFile = createSourceFile(`
async function test() {
  for (let i = 0; i < 10; i++) {
    const helper = async () => {
      await fetch('/api');
    };
  }
}
`);
      const awaits = findAwaitExpressions(sourceFile);
      expect(awaits.length).toBeGreaterThan(0);
      
      const result = rule.inspect(awaits[0], checker);
      
      // Await inside an arrow function defined in a loop is fine
      expect(result).toBeNull();
    });
  });

  describe('rule properties', () => {
    it('should have correct rule ID', () => {
      expect(rule.id).toBe('no-await-in-loop');
    });

    it('should implement AnalysisRule interface', () => {
      expect(rule).toHaveProperty('id');
      expect(rule).toHaveProperty('inspect');
      expect(typeof rule.inspect).toBe('function');
    });
  });
});
