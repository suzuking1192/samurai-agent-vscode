/**
 * Tests for AsyncRaceRule
 */

import { AsyncRaceRule } from '../AsyncRaceRule';
import { Project, TypeChecker, Node, SyntaxKind } from 'ts-morph';

describe('AsyncRaceRule', () => {
  let project: Project;
  let checker: TypeChecker;
  let rule: AsyncRaceRule;

  beforeEach(() => {
    project = new Project({
      useInMemoryFileSystem: true,
      skipAddingFilesFromTsConfig: true,
      compilerOptions: { allowJs: true }
    });
    rule = new AsyncRaceRule();
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

  function findCallExpressions(sourceFile: any, name?: string) {
    const calls: any[] = [];
    sourceFile.forEachDescendant((node: any) => {
      if (Node.isCallExpression(node)) {
        const expr = node.getExpression();
        if (!name) {
          calls.push(node);
        } else if (Node.isIdentifier(expr) && expr.getText() === name) {
          calls.push(node);
        } else if (Node.isPropertyAccessExpression(expr) && expr.getName() === name) {
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

    it('should return null for non-Promise returning calls', () => {
      const sourceFile = createSourceFile(`
function getNumber(): number {
  return 42;
}
getNumber();
`);
      const callExpressions = findCallExpressions(sourceFile);
      expect(callExpressions.length).toBeGreaterThan(0);
      
      const result = rule.inspect(callExpressions[0], checker);
      expect(result).toBeNull(); // Not a Promise
    });

    it('should detect floating promise', () => {
      const sourceFile = createSourceFile(`
async function saveData() {
  return Promise.resolve();
}
saveData();
`);
      const callExpressions = findCallExpressions(sourceFile, 'saveData');
      
      expect(callExpressions.length).toBeGreaterThan(0);
      const result = rule.inspect(callExpressions[0], checker);
      
      expect(result).not.toBeNull();
      expect(result?.ruleId).toBe('async-race');
      expect(result?.severity).toBe('critical');
      expect(result?.message).toContain('Floating Promise');
    });

    it('should not flag awaited promises', () => {
      const sourceFile = createSourceFile(`
async function saveData() {
  return Promise.resolve();
}
async function wrapper() {
  await saveData();
}
`);
      const callExpressions = findCallExpressions(sourceFile, 'saveData');
      
      expect(callExpressions.length).toBeGreaterThan(0);
      const result = rule.inspect(callExpressions[0], checker);
      
      expect(result).toBeNull(); // Should not flag awaited promises
    });

    it('should not flag returned promises', () => {
      const sourceFile = createSourceFile(`
async function getData() {
  return Promise.resolve();
}
function wrapper() {
  return getData();
}
`);
      const callExpressions = findCallExpressions(sourceFile, 'getData');
      
      expect(callExpressions.length).toBeGreaterThan(0);
      const result = rule.inspect(callExpressions[0], checker);
      
      expect(result).toBeNull(); // Should not flag returned promises
    });

    it('should not flag assigned promises', () => {
      const sourceFile = createSourceFile(`
async function getData() {
  return Promise.resolve();
}
function wrapper() {
  const promise = getData();
}
`);
      const callExpressions = findCallExpressions(sourceFile, 'getData');
      
      expect(callExpressions.length).toBeGreaterThan(0);
      const result = rule.inspect(callExpressions[0], checker);
      
      expect(result).toBeNull(); // Should not flag assigned promises
    });

    it('should not flag voided promises', () => {
      const sourceFile = createSourceFile(`
async function fireAndForget() {
  console.log('done');
}
function wrapper() {
  void fireAndForget();
}
`);
      const callExpressions = findCallExpressions(sourceFile, 'fireAndForget');
      
      expect(callExpressions.length).toBeGreaterThan(0);
      const result = rule.inspect(callExpressions[0], checker);
      
      expect(result).toBeNull(); // Should not flag voided promises
    });

    it('should not flag chained promises', () => {
      const sourceFile = createSourceFile(`
async function getData() {
  return Promise.resolve();
}
function wrapper() {
  getData().then(result => console.log(result));
}
`);
      const callExpressions = findCallExpressions(sourceFile, 'getData');
      
      expect(callExpressions.length).toBeGreaterThan(0);
      // The getData() call that's chained should not be flagged
      const result = rule.inspect(callExpressions[0], checker);
      
      expect(result).toBeNull(); // Should not flag chained promises
    });
  });

  describe('rule properties', () => {
    it('should have correct rule ID', () => {
      expect(rule.id).toBe('async-race');
    });

    it('should implement AnalysisRule interface', () => {
      expect(rule).toHaveProperty('id');
      expect(rule).toHaveProperty('inspect');
      expect(typeof rule.inspect).toBe('function');
    });
  });
});















