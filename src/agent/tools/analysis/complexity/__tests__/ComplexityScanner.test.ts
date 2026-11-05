/**
 * Tests for ComplexityScanner
 */

import { ComplexityScanner } from '../ComplexityScanner';
import { Project } from 'ts-morph';

describe('ComplexityScanner', () => {
  let project: Project;
  let scanner: ComplexityScanner;

  beforeEach(() => {
    project = new Project({
      useInMemoryFileSystem: true,
      skipAddingFilesFromTsConfig: true,
      compilerOptions: { allowJs: true }
    });
    scanner = new ComplexityScanner();
  });

  afterEach(() => {
    project = undefined as any;
  });

  function createSourceFile(code: string) {
    return project.createSourceFile('test.ts', code);
  }

  describe('analyze', () => {
    it('should calculate complexity of 1 for simple function', () => {
      const sourceFile = createSourceFile(`
function simpleFunction() {
  return 42;
}
`);
      const result = scanner.analyze(sourceFile);

      expect(result.maxComplexity).toBe(1);
      expect(result.functions.length).toBeGreaterThan(0);
      expect(result.functions[0].complexity).toBe(1);
      expect(result.functions[0].name).toBe('simpleFunction');
    });

    it('should calculate complexity for function with if statement', () => {
      const sourceFile = createSourceFile(`
function ifFunction(x: number) {
  if (x > 0) {
    return x;
  }
  return 0;
}
`);
      const result = scanner.analyze(sourceFile);

      expect(result.maxComplexity).toBeGreaterThan(1);
      const ifFunc = result.functions.find(f => f.name === 'ifFunction');
      expect(ifFunc).toBeDefined();
      expect(ifFunc?.complexity).toBe(2); // Base 1 + 1 if = 2
    });

    it('should calculate complexity for function with multiple conditionals', () => {
      const sourceFile = createSourceFile(`
function complexFunction(x: number) {
  if (x > 0) {
    if (x > 10) {
      return x * 2;
    }
    return x;
  }
  return 0;
}
`);
      const result = scanner.analyze(sourceFile);

      const complexFunc = result.functions.find(f => f.name === 'complexFunction');
      expect(complexFunc).toBeDefined();
      expect(complexFunc?.complexity).toBeGreaterThan(2); // Multiple ifs
    });

    it('should calculate complexity for function with for loop', () => {
      const sourceFile = createSourceFile(`
function loopFunction(items: number[]) {
  for (const item of items) {
    console.log(item);
  }
}
`);
      const result = scanner.analyze(sourceFile);

      const loopFunc = result.functions.find(f => f.name === 'loopFunction');
      expect(loopFunc).toBeDefined();
      expect(loopFunc?.complexity).toBe(2); // Base 1 + 1 for = 2
    });

    it('should calculate complexity for function with while loop', () => {
      const sourceFile = createSourceFile(`
function whileFunction(x: number) {
  while (x > 0) {
    x--;
  }
  return x;
}
`);
      const result = scanner.analyze(sourceFile);

      const whileFunc = result.functions.find(f => f.name === 'whileFunction');
      expect(whileFunc).toBeDefined();
      expect(whileFunc?.complexity).toBe(2); // Base 1 + 1 while = 2
    });

    it('should calculate complexity for function with ternary operator', () => {
      const sourceFile = createSourceFile(`
function ternaryFunction(x: number) {
  return x > 0 ? x : 0;
}
`);
      const result = scanner.analyze(sourceFile);

      const ternaryFunc = result.functions.find(f => f.name === 'ternaryFunction');
      expect(ternaryFunc).toBeDefined();
      expect(ternaryFunc?.complexity).toBe(2); // Base 1 + 1 ternary = 2
    });

    it('should calculate complexity for function with switch statement', () => {
      const sourceFile = createSourceFile(`
function switchFunction(x: number) {
  switch (x) {
    case 1:
      return 'one';
    case 2:
      return 'two';
    default:
      return 'other';
  }
}
`);
      const result = scanner.analyze(sourceFile);

      const switchFunc = result.functions.find(f => f.name === 'switchFunction');
      expect(switchFunc).toBeDefined();
      // Switch with cases increases complexity
      expect(switchFunc?.complexity).toBeGreaterThan(1);
    });

    it('should calculate complexity for function with try-catch', () => {
      const sourceFile = createSourceFile(`
function tryCatchFunction() {
  try {
    riskyOperation();
  } catch (e) {
    console.error(e);
  }
}
`);
      const result = scanner.analyze(sourceFile);

      const tryCatchFunc = result.functions.find(f => f.name === 'tryCatchFunction');
      expect(tryCatchFunc).toBeDefined();
      expect(tryCatchFunc?.complexity).toBe(2); // Base 1 + 1 catch = 2
    });

    it('should calculate complexity for function with logical operators', () => {
      const sourceFile = createSourceFile(`
function logicalFunction(x: number, y: number) {
  if (x > 0 && y > 0) {
    return x + y;
  }
  return 0;
}
`);
      const result = scanner.analyze(sourceFile);

      const logicalFunc = result.functions.find(f => f.name === 'logicalFunction');
      expect(logicalFunc).toBeDefined();
      // Should count both if and && operator
      expect(logicalFunc?.complexity).toBeGreaterThan(2);
    });

    it('should handle class methods', () => {
      const sourceFile = createSourceFile(`
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
`);
      const result = scanner.analyze(sourceFile);

      expect(result.functions.length).toBeGreaterThanOrEqual(2);
      const method1 = result.functions.find(f => f.name === 'method1');
      const method2 = result.functions.find(f => f.name === 'method2');
      
      expect(method1).toBeDefined();
      expect(method2).toBeDefined();
      expect(method1?.complexity).toBe(1);
      expect(method2?.complexity).toBeGreaterThan(1);
    });

    it('should return top 10 most complex functions', () => {
      let code = '';
      for (let i = 0; i < 15; i++) {
        code += `
function func${i}() {
  return ${i};
}
`;
      }
      const sourceFile = createSourceFile(code);
      const result = scanner.analyze(sourceFile);

      expect(result.functions.length).toBeLessThanOrEqual(10);
    });

    it('should sort functions by complexity descending', () => {
      const sourceFile = createSourceFile(`
function simple() {
  return 1;
}

function complex(x: number) {
  if (x > 0) {
    if (x > 10) {
      if (x > 20) {
        return x;
      }
    }
  }
  return 0;
}

function medium(x: number) {
  if (x > 0) {
    return x;
  }
  return 0;
}
`);
      const result = scanner.analyze(sourceFile);

      expect(result.functions.length).toBeGreaterThanOrEqual(3);
      // Most complex should be first
      expect(result.functions[0].complexity).toBeGreaterThanOrEqual(
        result.functions[result.functions.length - 1].complexity
      );
    });

    it('should handle empty file', () => {
      const sourceFile = createSourceFile('');
      const result = scanner.analyze(sourceFile);

      expect(result.maxComplexity).toBe(0);
      expect(result.functions).toEqual([]);
    });

    it('should handle arrow functions assigned to variables', () => {
      const sourceFile = createSourceFile(`
const arrowFunc = () => {
  return 42;
};

function namedFunc() {
  return 43;
}
`);
      const result = scanner.analyze(sourceFile);

      // Should find at least the named function
      expect(result.functions.length).toBeGreaterThan(0);
      const namedFunc = result.functions.find(f => f.name === 'namedFunc');
      expect(namedFunc).toBeDefined();
      // Note: Variable-declared arrow functions are not currently tracked separately
      // Only top-level functions and class methods are analyzed
    });
  });
});















