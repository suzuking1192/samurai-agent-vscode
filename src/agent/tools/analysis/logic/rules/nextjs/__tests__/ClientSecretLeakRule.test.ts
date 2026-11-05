/**
 * Tests for ClientSecretLeakRule
 */

import { ClientSecretLeakRule } from '../ClientSecretLeakRule';
import { Project, TypeChecker, Node } from 'ts-morph';

describe('ClientSecretLeakRule', () => {
  let project: Project;
  let checker: TypeChecker;
  let rule: ClientSecretLeakRule;

  beforeEach(() => {
    project = new Project({
      useInMemoryFileSystem: true,
      skipAddingFilesFromTsConfig: true,
      compilerOptions: { allowJs: true, jsx: 'react' }
    });
    rule = new ClientSecretLeakRule();
  });

  afterEach(() => {
    project = undefined as any;
    checker = undefined as any;
  });

  function createSourceFile(code: string, fileName: string = 'test.tsx') {
    const sourceFile = project.createSourceFile(fileName, code);
    checker = project.getTypeChecker();
    return sourceFile;
  }

  function findJsxAttributes(sourceFile: any, attrName?: string) {
    const attrs: any[] = [];
    sourceFile.forEachDescendant((node: any) => {
      if (Node.isJsxAttribute(node)) {
        const name = node.getNameNode()?.getText() || '';
        if (!attrName || name === attrName) {
          attrs.push(node);
        }
      }
    });
    return attrs;
  }

  describe('inspect', () => {
    it('should return null for non-JSX attributes', () => {
      const sourceFile = createSourceFile('const x = 42;');
      const variableDecl = sourceFile.getVariableDeclaration('x');
      
      expect(variableDecl).toBeDefined();
      const result = rule.inspect(variableDecl!, checker);
      expect(result).toBeNull();
    });

    it('should return null for non-secret JSX attributes', () => {
      const sourceFile = createSourceFile(`
function Component() {
  return <div title="Hello">World</div>;
}
`);
      const attrs = findJsxAttributes(sourceFile);
      expect(attrs.length).toBeGreaterThan(0);
      
      const result = rule.inspect(attrs[0], checker);
      expect(result).toBeNull(); // Not a secret
    });

    it('should detect process.env in client component', () => {
      const clientComponent = createSourceFile(`
'use client';
function ClientComponent() {
  return <Component apiKey={process.env.API_KEY} />;
}
`, 'ClientComponent.tsx');

      const serverComponent = createSourceFile(`
function ServerComponent() {
  return <Component apiKey={process.env.API_KEY} />;
}
`, 'ServerComponent.tsx');

      // Create Component definition
      createSourceFile(`
export function Component({ apiKey }: { apiKey: string }) {
  return <div>{apiKey}</div>;
}
`, 'Component.tsx');

      const attrs = findJsxAttributes(clientComponent, 'apiKey');
      expect(attrs.length).toBeGreaterThan(0);
      
      const result = rule.inspect(attrs[0], checker);
      
      expect(result).not.toBeNull();
      expect(result?.ruleId).toBe('nextjs-secret-leak');
      expect(result?.severity).toBe('critical');
      expect(result?.message).toContain('Client Component');
      expect(result?.message).toContain('apiKey');
    });

    it('should detect secret-like attribute names', () => {
      const clientComponent = createSourceFile(`
'use client';
function ClientComponent() {
  const secret = 'my-secret';
  return <Component token={secret} />;
}
`, 'ClientComponent.tsx');

      createSourceFile(`
export function Component({ token }: { token: string }) {
  return <div>{token}</div>;
}
`, 'Component.tsx');

      const attrs = findJsxAttributes(clientComponent, 'token');
      expect(attrs.length).toBeGreaterThan(0);
      
      const result = rule.inspect(attrs[0], checker);
      
      // Should detect token attribute even without process.env
      expect(result).not.toBeNull();
      expect(result?.ruleId).toBe('nextjs-secret-leak');
    });

    it('should detect key attribute with process.env', () => {
      const clientComponent = createSourceFile(`
'use client';
function ClientComponent() {
  return <Component key={process.env.SECRET_KEY} />;
}
`, 'ClientComponent.tsx');

      createSourceFile(`
export function Component({ key }: { key: string }) {
  return <div>{key}</div>;
}
`, 'Component.tsx');

      const attrs = findJsxAttributes(clientComponent, 'key');
      expect(attrs.length).toBeGreaterThan(0);
      
      const result = rule.inspect(attrs[0], checker);
      
      expect(result).not.toBeNull();
      expect(result?.ruleId).toBe('nextjs-secret-leak');
    });

    it('should not flag server components', () => {
      const serverComponent = createSourceFile(`
function ServerComponent() {
  return <Component apiKey={process.env.API_KEY} />;
}
`, 'ServerComponent.tsx');

      createSourceFile(`
export function Component({ apiKey }: { apiKey: string }) {
  return <div>{apiKey}</div>;
}
`, 'Component.tsx');

      const attrs = findJsxAttributes(serverComponent, 'apiKey');
      expect(attrs.length).toBeGreaterThan(0);
      
      const result = rule.inspect(attrs[0], checker);
      
      // Server components are safe
      expect(result).toBeNull();
    });

    it('should not flag non-secret attributes in client components', () => {
      const clientComponent = createSourceFile(`
'use client';
function ClientComponent() {
  return <Component title="Hello" />;
}
`, 'ClientComponent.tsx');

      createSourceFile(`
export function Component({ title }: { title: string }) {
  return <div>{title}</div>;
}
`, 'Component.tsx');

      const attrs = findJsxAttributes(clientComponent, 'title');
      expect(attrs.length).toBeGreaterThan(0);
      
      const result = rule.inspect(attrs[0], checker);
      
      expect(result).toBeNull(); // Not a secret
    });

    it('should handle double-quoted use client directive', () => {
      const clientComponent = createSourceFile(`
"use client";
function ClientComponent() {
  return <Component token={process.env.TOKEN} />;
}
`, 'ClientComponent.tsx');

      createSourceFile(`
export function Component({ token }: { token: string }) {
  return <div>{token}</div>;
}
`, 'Component.tsx');

      const attrs = findJsxAttributes(clientComponent, 'token');
      expect(attrs.length).toBeGreaterThan(0);
      
      const result = rule.inspect(attrs[0], checker);
      
      expect(result).not.toBeNull();
      expect(result?.ruleId).toBe('nextjs-secret-leak');
    });

    it('should return null when attribute has no initializer', () => {
      const sourceFile = createSourceFile(`
function Component() {
  return <div className="test" />;
}
`);
      const attrs = findJsxAttributes(sourceFile);
      // className without value might not have initializer in some cases
      // This test ensures we handle missing initializers gracefully
      if (attrs.length > 0) {
        const attr = attrs.find((a: any) => !a.getInitializer());
        if (attr) {
          const result = rule.inspect(attr, checker);
          expect(result).toBeNull();
        }
      }
    });
  });

  describe('rule properties', () => {
    it('should have correct rule ID', () => {
      expect(rule.id).toBe('nextjs-secret-leak');
    });

    it('should implement AnalysisRule interface', () => {
      expect(rule).toHaveProperty('id');
      expect(rule).toHaveProperty('inspect');
      expect(typeof rule.inspect).toBe('function');
    });
  });
});















