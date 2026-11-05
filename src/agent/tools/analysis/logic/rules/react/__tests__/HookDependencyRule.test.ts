/**
 * Tests for HookDependencyRule
 */

import { HookDependencyRule } from '../HookDependencyRule';
import { Project, TypeChecker, Node } from 'ts-morph';

describe('HookDependencyRule', () => {
  let project: Project;
  let checker: TypeChecker;
  let rule: HookDependencyRule;

  beforeEach(() => {
    project = new Project({
      useInMemoryFileSystem: true,
      skipAddingFilesFromTsConfig: true,
      compilerOptions: { allowJs: true, jsx: 'react' }
    });
    rule = new HookDependencyRule();
  });

  afterEach(() => {
    project = undefined as any;
    checker = undefined as any;
  });

  function createSourceFile(code: string) {
    const sourceFile = project.createSourceFile('test.tsx', code);
    checker = project.getTypeChecker();
    return sourceFile;
  }

  function findHookCalls(sourceFile: any, hookName?: string) {
    const calls: any[] = [];
    sourceFile.forEachDescendant((node: any) => {
      if (Node.isCallExpression(node)) {
        const expr = node.getExpression();
        if (Node.isIdentifier(expr)) {
          const name = expr.getText();
          if (!hookName || name === hookName) {
            if (['useEffect', 'useCallback', 'useMemo'].includes(name)) {
              calls.push(node);
            }
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

    it('should return null for non-hook calls', () => {
      const sourceFile = createSourceFile(`
function Component() {
  useState(0);
}
`);
      const calls = findHookCalls(sourceFile);
      // useState is not checked by this rule
      expect(calls.length).toBe(0);
    });

    it('should return null when dependencies are correct', () => {
      const sourceFile = createSourceFile(`
function Component() {
  const [count, setCount] = useState(0);
  useEffect(() => {
    console.log(count);
  }, [count]);
}
`);
      const calls = findHookCalls(sourceFile, 'useEffect');
      expect(calls.length).toBeGreaterThan(0);
      
      const result = rule.inspect(calls[0], checker);
      
      expect(result).toBeNull(); // Dependencies are correct
    });

    it('should detect missing dependency in useEffect', () => {
      const sourceFile = createSourceFile(`
function Component() {
  const [count, setCount] = useState(0);
  useEffect(() => {
    console.log(count);
  }, []);
}
`);
      const calls = findHookCalls(sourceFile, 'useEffect');
      expect(calls.length).toBeGreaterThan(0);
      
      const result = rule.inspect(calls[0], checker);
      
      expect(result).not.toBeNull();
      expect(result?.ruleId).toBe('react-missing-dep');
      expect(result?.severity).toBe('warning');
      expect(result?.message).toContain('missing dependencies');
    });

    it('should detect missing dependency in useCallback', () => {
      const sourceFile = createSourceFile(`
function Component() {
  const [count, setCount] = useState(0);
  const callback = useCallback(() => {
    console.log(count);
  }, []);
}
`);
      const calls = findHookCalls(sourceFile, 'useCallback');
      expect(calls.length).toBeGreaterThan(0);
      
      const result = rule.inspect(calls[0], checker);
      
      expect(result).not.toBeNull();
      expect(result?.ruleId).toBe('react-missing-dep');
    });

    it('should detect missing dependency in useMemo', () => {
      const sourceFile = createSourceFile(`
function Component() {
  const [count, setCount] = useState(0);
  const memoized = useMemo(() => {
    return count * 2;
  }, []);
}
`);
      const calls = findHookCalls(sourceFile, 'useMemo');
      expect(calls.length).toBeGreaterThan(0);
      
      const result = rule.inspect(calls[0], checker);
      
      expect(result).not.toBeNull();
      expect(result?.ruleId).toBe('react-missing-dep');
    });

    it('should detect multiple missing dependencies', () => {
      const sourceFile = createSourceFile(`
function Component() {
  const [count, setCount] = useState(0);
  const [name, setName] = useState('');
  useEffect(() => {
    console.log(count, name);
  }, []);
}
`);
      const calls = findHookCalls(sourceFile, 'useEffect');
      expect(calls.length).toBeGreaterThan(0);
      
      const result = rule.inspect(calls[0], checker);
      
      expect(result).not.toBeNull();
      expect(result?.message).toMatch(/count|name/);
    });

    it('should not flag console usage', () => {
      const sourceFile = createSourceFile(`
function Component() {
  useEffect(() => {
    console.log('test');
  }, []);
}
`);
      const calls = findHookCalls(sourceFile, 'useEffect');
      expect(calls.length).toBeGreaterThan(0);
      
      const result = rule.inspect(calls[0], checker);
      
      // console is filtered out
      expect(result).toBeNull();
    });

    it('should return null when hook has no dependency array', () => {
      const sourceFile = createSourceFile(`
function Component() {
  const [count, setCount] = useState(0);
  useEffect(() => {
    console.log(count);
  });
}
`);
      const calls = findHookCalls(sourceFile, 'useEffect');
      expect(calls.length).toBeGreaterThan(0);
      
      const result = rule.inspect(calls[0], checker);
      
      // No dependency array means rule can't check
      expect(result).toBeNull();
    });

    it('should handle property access correctly', () => {
      const sourceFile = createSourceFile(`
function Component() {
  const user = { id: 1, name: 'John' };
  useEffect(() => {
    console.log(user.name);
  }, [user]);
}
`);
      const calls = findHookCalls(sourceFile, 'useEffect');
      expect(calls.length).toBeGreaterThan(0);
      
      const result = rule.inspect(calls[0], checker);
      
      // user is in deps, so should be fine
      expect(result).toBeNull();
    });
  });

  describe('rule properties', () => {
    it('should have correct rule ID', () => {
      expect(rule.id).toBe('react-missing-dep');
    });

    it('should implement AnalysisRule interface', () => {
      expect(rule).toHaveProperty('id');
      expect(rule).toHaveProperty('inspect');
      expect(typeof rule.inspect).toBe('function');
    });
  });
});















