/**
 * Tests for AstProgramBuilder
 */

import { AstProgramBuilder } from '../AstProgramBuilder';
import { TsProgram, ImportExportRelation, CallRelation } from '../types';
import * as fs from 'fs';
import * as path from 'path';

// Mock fs module
jest.mock('fs', () => ({
  existsSync: jest.fn(),
  readFileSync: jest.fn(),
  readdirSync: jest.fn(),
  statSync: jest.fn().mockReturnValue({ mtime: { getTime: () => 1234567890 } }),
  realpathSync: jest.fn(path => path)
}));

// Mock TypeScript
jest.mock('typescript', () => ({
  findConfigFile: jest.fn(),
  readConfigFile: jest.fn(),
  parseJsonConfigFileContent: jest.fn(),
  createProgram: jest.fn(),
  createCompilerHost: jest.fn(),
  resolveModuleName: jest.fn(),
  sys: {
    fileExists: jest.fn(),
    readFile: jest.fn(),
    getCurrentDirectory: jest.fn(),
    getCanonicalFileName: jest.fn(),
    getNewLine: jest.fn()
  },
  ScriptTarget: { ES2020: 5 },
  ModuleKind: { ESNext: 99 },
  ModuleResolutionKind: { NodeJs: 2 },
  forEachChild: jest.fn(),
  isImportDeclaration: jest.fn(),
  isExportDeclaration: jest.fn(),
  isCallExpression: jest.fn(),
  isStringLiteral: jest.fn(),
  isIdentifier: jest.fn(),
  isPropertyAccessExpression: jest.fn(),
  isElementAccessExpression: jest.fn(),
  isFunctionDeclaration: jest.fn(),
  isMethodDeclaration: jest.fn(),
  isArrowFunction: jest.fn(),
  isFunctionExpression: jest.fn(),
  isClassDeclaration: jest.fn(),
  isVariableDeclaration: jest.fn(),
  isNamedImports: jest.fn(),
  isNamespaceImport: jest.fn(),
  isNamedExports: jest.fn(),
  isExportAssignment: jest.fn(),
  isDeclarationFile: false,
  SymbolFlags: { Alias: 1 }
}));

// Mock Babel
jest.mock('@babel/parser', () => ({
  parse: jest.fn()
}));

jest.mock('@babel/traverse', () => ({
  default: jest.fn()
}));

describe('AstProgramBuilder', () => {
  let astBuilder: AstProgramBuilder;
  let mockFs: any;
  let mockTs: any;

  beforeEach(() => {
    astBuilder = new AstProgramBuilder('/test/workspace');
    mockFs = require('fs');
    mockTs = require('typescript');
    jest.clearAllMocks();
    mockTs.createProgram.mockReset();
    mockTs.createCompilerHost.mockReset();
    mockTs.findConfigFile.mockReset();
    mockTs.readConfigFile.mockReset();
    mockTs.parseJsonConfigFileContent.mockReset();
    mockFs.existsSync.mockReset();
  });

  describe('buildTsProgram', () => {
    it('should build TypeScript program with proper config', () => {
      const workspace = '/test/workspace';
      
      // Mock tsconfig.json exists
      mockFs.existsSync.mockReturnValue(true);
      mockTs.findConfigFile.mockReturnValue('/test/workspace/tsconfig.json');
      
      // Mock config parsing
      mockTs.readConfigFile.mockReturnValue({
        config: {
          compilerOptions: {
            target: 'ES2020',
            module: 'ESNext',
            baseUrl: '.',
            paths: { '@/*': ['./src/*'] }
          }
        }
      });
      
      mockTs.parseJsonConfigFileContent.mockReturnValue({
        fileNames: ['/test/workspace/src/index.ts'],
        options: { target: 5, module: 99 },
        projectReferences: []
      });
      
      // Mock program creation
      const mockProgram = { getSourceFiles: jest.fn(), getTypeChecker: jest.fn() };
      mockTs.createProgram.mockReturnValue(mockProgram);
      mockTs.createCompilerHost.mockReturnValue({});
      
      // Mock source files
      const mockSourceFile = {
        fileName: '/test/workspace/src/index.ts',
        isDeclarationFile: false,
        getLineAndCharacterOfPosition: jest.fn().mockReturnValue({ line: 0, character: 0 })
      };
      mockProgram.getSourceFiles.mockReturnValue([mockSourceFile]);
      mockProgram.getTypeChecker.mockReturnValue({});
      
      const result = astBuilder.buildTsProgram(workspace);
      
      expect(result).toBeDefined();
      expect(result.projectRoot).toBe(workspace);
      expect(result.sourceFiles).toBeDefined();
      expect(mockTs.createProgram).toHaveBeenCalled();
    });

    it('should fallback to Babel when TypeScript fails', () => {
      const workspace = '/test/workspace';
      
      // Mock no tsconfig
      mockFs.existsSync.mockReturnValue(false);
      mockTs.findConfigFile.mockReturnValue(undefined);
      
      // Mock Babel fallback
      const mockParse = require('@babel/parser').parse;
      mockParse.mockReturnValue({ type: 'Program' });
      
      // Mock file system for Babel
      mockFs.readdirSync.mockReturnValue([
        { name: 'src', isDirectory: () => true },
        { name: 'index.ts', isDirectory: () => false }
      ]);
      mockFs.readFileSync.mockReturnValue('export const test = 1;');
      
      const result = astBuilder.buildTsProgram(workspace);
      
      expect(result).toBeDefined();
      expect(result.program).toBeNull();
      expect(result.checker).toBeNull();
    });

    it('should use cache for repeated calls', () => {
      const workspace = '/test/workspace';
      
      // Mock successful build
      mockFs.existsSync.mockReturnValue(true);
      mockTs.findConfigFile.mockReturnValue('/test/workspace/tsconfig.json');
      mockTs.readConfigFile.mockReturnValue({ config: {} });
      mockTs.parseJsonConfigFileContent.mockReturnValue({
        fileNames: [],
        options: {},
        projectReferences: []
      });
      
      const mockProgram = { getSourceFiles: jest.fn(), getTypeChecker: jest.fn() };
      mockTs.createProgram.mockReturnValue(mockProgram);
      mockTs.createCompilerHost.mockReturnValue({});
      mockProgram.getSourceFiles.mockReturnValue([
        { isDeclarationFile: false, fileName: '/test/src/index.ts' } as any
      ]);
      mockProgram.getTypeChecker.mockReturnValue({});
      
      // First call
      const result1 = astBuilder.buildTsProgram(workspace);
      
      // Second call should use cache
      const result2 = astBuilder.buildTsProgram(workspace);
      
      expect(result1).toBe(result2);
      expect(mockTs.createProgram).toHaveBeenCalledTimes(1);
    });
  });

  describe('import resolution helpers', () => {
    it('should expand barrel re-exports when resolving named imports', () => {
      const sourceFile: any = { fileName: '/test/src/consumer.ts' };
      const tsProgram: TsProgram = {
        program: null,
        sourceFiles: new Map(),
        checker: null,
        projectRoot: '/test',
        tsconfigPaths: {}
      };
      
      const moduleSpecifier = { text: './barrel' };
      const importNode: any = {
        importClause: {
          namedBindings: {
            elements: [
              {
                name: { text: 'foo' },
                propertyName: undefined
              }
            ]
          }
        },
        moduleSpecifier
      };
      
      const mockForEach = jest.spyOn(astBuilder as any, 'forEachNodeIterative').mockImplementation((root, cb) => {
        if (root === sourceFile) {
          cb(importNode);
        }
      });
      const mockResolvePath = jest.spyOn(astBuilder as any, 'resolveImportPath').mockImplementation((spec: string) => {
        if (spec === './barrel') {
          return '/test/src/barrel/index.ts';
        }
        return null;
      });
      const mockChecker = jest.spyOn(astBuilder as any, 'resolveTargetFileWithChecker').mockReturnValue(null);
      const mockCollect = jest.spyOn(astBuilder as any, 'collectConcreteFiles').mockReturnValue([
        '/test/src/barrel/index.ts',
        '/test/src/foo.ts'
      ]);
      const mockFilter = jest.spyOn(astBuilder as any, 'filterFilesByExport').mockImplementation(
        (files: string[], exportName?: string) => {
          if (exportName === 'foo') {
            return ['/test/src/foo.ts'];
          }
          return files;
        }
      );
      
      mockFs.existsSync.mockReturnValue(false);
      
      const mockTs = require('typescript');
      mockTs.isImportDeclaration.mockImplementation((node: any) => node === importNode);
      mockTs.isStringLiteral.mockImplementation((node: any) => node === moduleSpecifier);
      mockTs.isNamedImports.mockImplementation((named: any) => named === importNode.importClause.namedBindings);
      mockTs.isNamespaceImport.mockReturnValue(false);
      
      const result = (astBuilder as any).resolveImportedBinding('foo', sourceFile, tsProgram);
      
      expect(result).toBeDefined();
      expect(result.targetFile).toBe('/test/src/foo.ts');
      expect(result.targetFiles).toContain('/test/src/foo.ts');
      
      mockForEach.mockRestore();
      mockResolvePath.mockRestore();
      mockChecker.mockRestore();
      mockCollect.mockRestore();
      mockFilter.mockRestore();
      mockTs.isImportDeclaration.mockReset();
      mockTs.isStringLiteral.mockReset();
      mockTs.isNamedImports.mockReset();
      mockTs.isNamespaceImport.mockReset();
      mockFs.existsSync.mockReset();
    });
  });

  describe('resolveCalleeSymbol', () => {
    it('should consider multiple target files when resolving namespace property access', () => {
      const expression: any = { expression: { text: 'utils' }, name: { text: 'foo' } };
      const sourceFile: any = { fileName: '/test/src/consumer.ts' };
      const symbolIndex = new Map([
        ['/test/src/foo.ts', [
          { id: 'symbol:/test/src/foo.ts:foo', name: 'foo', file: '/test/src/foo.ts', kind: 'function', startLine: 1, endLine: 1, exportName: 'foo' }
        ]]
      ]);
      const tsProgram: TsProgram = {
        program: null,
        sourceFiles: new Map(),
        checker: null,
        projectRoot: '/test',
        tsconfigPaths: {}
      };
      
      const mockResolve = jest.spyOn(astBuilder as any, 'resolveImportedBinding').mockReturnValue({
        targetFile: '/test/src/barrel/index.ts',
        targetFiles: ['/test/src/foo.ts'],
        namespace: 'utils',
        isNamespace: true
      });
      
      const mockTs = require('typescript');
      mockTs.isPropertyAccessExpression.mockImplementation((node: any) => node === expression);
      mockTs.isIdentifier.mockImplementation((node: any) => node === expression.expression);
      
      const result = (astBuilder as any).resolveCalleeSymbol(expression, sourceFile, tsProgram, symbolIndex);
      
      expect(result).toBeDefined();
      expect(result.file).toBe('/test/src/foo.ts');
      expect(result.name).toBe('foo');
      expect(result.via).toBe('import-resolution');
      
      mockResolve.mockRestore();
      mockTs.isPropertyAccessExpression.mockReset();
      mockTs.isIdentifier.mockReset();
    });
  });

  describe('extractImportGraph', () => {
    it('should extract import relations correctly', () => {
      const mockTsProgram: TsProgram = {
        program: null,
        sourceFiles: new Map([
          ['/test/src/index.ts', {
            fileName: '/test/src/index.ts',
            getLineAndCharacterOfPosition: jest.fn().mockReturnValue({ line: 0, character: 0 })
          } as any]
        ]),
        checker: null,
        projectRoot: '/test',
        tsconfigPaths: { '@/*': ['/test/src/*'] }
      };

      const sourceFile = mockTsProgram.sourceFiles.get('/test/src/index.ts') as any;
      const mockNode = {
        moduleSpecifier: { text: './utils' },
        getStart: () => 0,
        getChildren: () => []
      };
      const forEachSpy = jest.spyOn(astBuilder as any, 'forEachNodeIterative').mockImplementation((root, cb) => {
        if (root === sourceFile) {
          cb(mockNode);
        }
      });
      
      mockTs.isImportDeclaration.mockImplementation((node: any) => node === mockNode);
      mockTs.isStringLiteral.mockImplementation((node: any) => node === mockNode.moduleSpecifier);
      mockTs.isExportDeclaration.mockReturnValue(false);
      mockTs.isCallExpression.mockReturnValue(false);
      
      // Mock resolveImportPath
      jest.spyOn(astBuilder as any, 'resolveImportPath').mockReturnValue('/test/src/utils.ts');
      
      const result = astBuilder.extractImportGraph(mockTsProgram);
      
      expect(result).toHaveLength(1);
      expect(result[0]).toEqual({
        from: '/test/src/index.ts',
        to: '/test/src/utils.ts',
        kind: 'import',
        line: 1,
        confidence: 0.95
      });
      
      forEachSpy.mockRestore();
    });

    it('should handle re-exports', () => {
      const mockTsProgram: TsProgram = {
        program: null,
        sourceFiles: new Map([
          ['/test/src/index.ts', {
            fileName: '/test/src/index.ts',
            getLineAndCharacterOfPosition: jest.fn().mockReturnValue({ line: 0, character: 0 })
          } as any]
        ]),
        checker: null,
        projectRoot: '/test',
        tsconfigPaths: {}
      };
      
      const sourceFile = mockTsProgram.sourceFiles.get('/test/src/index.ts') as any;
      const mockNode = {
        moduleSpecifier: { text: './utils' },
        getStart: () => 0,
        getChildren: () => []
      };
      const forEachSpy = jest.spyOn(astBuilder as any, 'forEachNodeIterative').mockImplementation((root, cb) => {
        if (root === sourceFile) {
          cb(mockNode);
        }
      });
      
      mockTs.isImportDeclaration.mockReturnValue(false);
      mockTs.isExportDeclaration.mockImplementation((node: any) => node === mockNode);
      mockTs.isStringLiteral.mockImplementation((node: any) => node === mockNode.moduleSpecifier);
      mockTs.isCallExpression.mockReturnValue(false);
      
      jest.spyOn(astBuilder as any, 'resolveImportPath').mockReturnValue('/test/src/utils.ts');
      
      const result = astBuilder.extractImportGraph(mockTsProgram);
      
      expect(result).toHaveLength(1);
      expect(result[0].kind).toBe('reexport');
      expect(result[0].confidence).toBe(0.7);
      
      forEachSpy.mockRestore();
    });

    it('should handle dynamic imports', () => {
      const mockTsProgram: TsProgram = {
        program: null,
        sourceFiles: new Map([
          ['/test/src/index.ts', {
            fileName: '/test/src/index.ts',
            getLineAndCharacterOfPosition: jest.fn().mockReturnValue({ line: 0, character: 0 })
          } as any]
        ]),
        checker: null,
        projectRoot: '/test',
        tsconfigPaths: {}
      };
      
      const sourceFile = mockTsProgram.sourceFiles.get('/test/src/index.ts') as any;
      const mockNode = {
        expression: { text: 'import' },
        arguments: [{ text: './utils' }],
        getStart: () => 0,
        getChildren: () => []
      };
      const forEachSpy = jest.spyOn(astBuilder as any, 'forEachNodeIterative').mockImplementation((root, cb) => {
        if (root === sourceFile) {
          cb(mockNode);
        }
      });
      
      mockTs.isImportDeclaration.mockReturnValue(false);
      mockTs.isExportDeclaration.mockReturnValue(false);
      mockTs.isCallExpression.mockImplementation((node: any) => node === mockNode);
      mockTs.isIdentifier.mockImplementation((node: any) => node === mockNode.expression);
      mockTs.isStringLiteral.mockImplementation((node: any) => node === mockNode.arguments[0]);
      
      jest.spyOn(astBuilder as any, 'resolveImportPath').mockReturnValue('/test/src/utils.ts');
      
      const result = astBuilder.extractImportGraph(mockTsProgram);
      
      expect(result).toHaveLength(1);
      expect(result[0].kind).toBe('dynamicImport');
      expect(result[0].confidence).toBe(0.4);
      
      forEachSpy.mockRestore();
    });
  });

  describe('extractCallGraph', () => {
    it('should extract call relations correctly', () => {
      const mockTsProgram: TsProgram = {
        program: null,
        sourceFiles: new Map([
          ['/test/src/index.ts', {
            fileName: '/test/src/index.ts',
            getLineAndCharacterOfPosition: jest.fn().mockReturnValue({ line: 0, character: 0 })
          } as any]
        ]),
        checker: null,
        projectRoot: '/test',
        tsconfigPaths: {}
      };
      
      const sourceFile = mockTsProgram.sourceFiles.get('/test/src/index.ts') as any;
      const mockNode = {
        expression: { text: 'testFunction' },
        getStart: () => 0,
        getChildren: () => []
      };
      const forEachSpy = jest.spyOn(astBuilder as any, 'forEachNodeIterative').mockImplementation((root, cb) => {
        if (root === sourceFile) {
          cb(mockNode);
        }
      });

      mockTs.isCallExpression.mockImplementation((node: any) => node === mockNode);
      mockTs.isPropertyAccessExpression.mockReturnValue(false);
      mockTs.isIdentifier.mockImplementation((node: any) => node === mockNode.expression);
      mockTs.isStringLiteral.mockReturnValue(false);
      
      // Mock getContainingFunction and resolveCallee
      jest.spyOn(astBuilder as any, 'getContainingFunction').mockReturnValue('main');
      jest.spyOn(astBuilder as any, 'resolveCallee').mockReturnValue({
        name: 'testFunction',
        file: '/test/src/utils.ts',
        start: 5,
        end: null,
        confidence: 0.9
      });
      
      const result = astBuilder.extractCallGraph(mockTsProgram);
      
      expect(result).toHaveLength(1);
      expect(result[0]).toEqual({
        caller: 'main',
        callee: 'testFunction',
        file: '/test/src/index.ts',
        line: 1,
        confidence: 0.9
      });

      forEachSpy.mockRestore();
    });

  });

  describe('detectFrameworkPatterns', () => {
    it('should emit Next.js route relations for named exports', () => {
      const sourceFile: any = {
        fileName: '/test/src/app/api/users/route.ts',
        getLineAndCharacterOfPosition: jest.fn().mockReturnValue({ line: 0, character: 0 })
      };
      const mockTsProgram: TsProgram = {
        program: null,
        sourceFiles: new Map([['/test/src/app/api/users/route.ts', sourceFile]]),
        checker: null,
        projectRoot: '/test',
        tsconfigPaths: {}
      };
      const node: any = {
        exportClause: {
          elements: [{ name: { text: 'GET' } }]
        },
        getStart: () => 0
      };

      mockTs.isExportDeclaration.mockReturnValue(true);
      mockTs.isNamedExports.mockReturnValue(true);

      const relations: CallRelation[] = [];
      (astBuilder as any).detectFrameworkPatterns(node, sourceFile, mockTsProgram, relations);

      expect(relations).toEqual([
        {
          caller: 'route',
          callee: 'GET',
          file: '/test/src/app/api/users/route.ts',
          line: 1,
          confidence: 0.8
        }
      ]);
    });

    it('should emit Express router relations for call expressions', () => {
      const sourceFile: any = {
        fileName: '/test/src/routes/users.ts',
        getLineAndCharacterOfPosition: jest.fn().mockReturnValue({ line: 0, character: 0 })
      };
      const mockTsProgram: TsProgram = {
        program: null,
        sourceFiles: new Map([['/test/src/routes/users.ts', sourceFile]]),
        checker: null,
        projectRoot: '/test',
        tsconfigPaths: {}
      };
      const node: any = {
        expression: {
          expression: { text: 'router' },
          name: { text: 'get' }
        },
        getStart: () => 0
      };

      mockTs.isCallExpression.mockReturnValue(true);
      mockTs.isPropertyAccessExpression.mockReturnValue(true);
      mockTs.isIdentifier.mockReturnValue(true);

      const relations: CallRelation[] = [];
      (astBuilder as any).detectFrameworkPatterns(node, sourceFile, mockTsProgram, relations);

      expect(relations).toEqual([
        {
          caller: 'router',
          callee: 'get',
          file: '/test/src/routes/users.ts',
          line: 1,
          confidence: 0.7
        }
      ]);
    });
  });

  describe('buildAstIndexes', () => {
    it('should build comprehensive AST indexes', () => {
      const mockTsProgram: TsProgram = {
        program: null,
        sourceFiles: new Map([
          ['/test/src/index.ts', {
            fileName: '/test/src/index.ts',
            getLineAndCharacterOfPosition: jest.fn().mockReturnValue({ line: 0, character: 0 })
          } as any]
        ]),
        checker: null,
        projectRoot: '/test',
        tsconfigPaths: {}
      };
      
      // Mock the extraction methods
      jest.spyOn(astBuilder, 'extractImportGraph').mockReturnValue([
        { from: '/test/src/index.ts', to: '/test/src/utils.ts', kind: 'import', line: 1, confidence: 0.95 }
      ]);
      
      jest.spyOn(astBuilder, 'extractCallGraph').mockReturnValue([
        { caller: 'main', callee: 'test', file: '/test/src/index.ts', line: 1, confidence: 0.9 }
      ]);
      
      // Mock symbol extraction (old method replaced by buildSymbolIndex)
      jest.spyOn(astBuilder, 'buildSymbolIndex').mockReturnValue(new Map([
        ['/test/src/index.ts', [
          { id: 'symbol:/test/src/index.ts:main', name: 'main', file: '/test/src/index.ts', kind: 'function', startLine: 1, endLine: 10 }
        ]]
      ]));
      
      jest.spyOn(astBuilder as any, 'extractFileExports').mockReturnValue(['testFunction']);
      jest.spyOn(astBuilder as any, 'isBarrelFile').mockReturnValue(false);
      jest.spyOn(astBuilder as any, 'getConcreteFilesFromBarrel').mockReturnValue([]);
      
      const result = astBuilder.buildAstIndexes(mockTsProgram);
      
      expect(result.importAdj).toBeDefined();
      expect(result.symbolDefs).toBeDefined();
      expect(result.fileExports).toBeDefined();
      expect(result.barrels).toBeDefined();
      expect(result.httpRoutes).toBeDefined();
    });
  });

  describe('buildSymbolIndex', () => {
    it('should build symbol index from TypeScript program', () => {
      const mockSourceFile = {
        fileName: '/test/src/index.ts',
        isDeclarationFile: false,
        getLineAndCharacterOfPosition: jest.fn().mockReturnValue({ line: 0, character: 0 }),
        getText: jest.fn().mockReturnValue('export function main() {}')
      };

      const mockTsProgram: TsProgram = {
        program: null,
        sourceFiles: new Map([
          ['/test/src/index.ts', mockSourceFile as any]
        ]),
        checker: null,
        projectRoot: '/test',
        tsconfigPaths: {}
      };

      // Mock TypeScript API for symbol extraction
      const mockTs = require('typescript');
      mockTs.isFunctionDeclaration = jest.fn().mockReturnValue(true);
      mockTs.isClassDeclaration = jest.fn().mockReturnValue(false);
      mockTs.isMethodDeclaration = jest.fn().mockReturnValue(false);
      mockTs.isVariableDeclaration = jest.fn().mockReturnValue(false);
      mockTs.isArrowFunction = jest.fn().mockReturnValue(false);
      mockTs.isFunctionExpression = jest.fn().mockReturnValue(false);
      mockTs.isIdentifier = jest.fn().mockReturnValue(false);
      mockTs.getModifiers = jest.fn().mockReturnValue([
        { kind: mockTs.SyntaxKind?.ExportKeyword || 103 }
      ]);
      mockTs.SyntaxKind = { ExportKeyword: 103 };

      const result = astBuilder.buildSymbolIndex(mockTsProgram);

      expect(result).toBeDefined();
      expect(result instanceof Map).toBe(true);
      expect(result.has('/test/src/index.ts')).toBe(true);
    });
  });

  describe('extractSymbolCallGraph', () => {
    it('should extract symbol-level call graph', () => {
      const symbolIndex = new Map([
        ['/test/src/index.ts', [
          { id: 'symbol:/test/src/index.ts:main', name: 'main', file: '/test/src/index.ts', kind: 'function', startLine: 1, endLine: 10 },
          { id: 'symbol:/test/src/index.ts:helper', name: 'helper', file: '/test/src/index.ts', kind: 'function', startLine: 12, endLine: 20 }
        ]]
      ]);

      const mockSourceFile = {
        fileName: '/test/src/index.ts',
        isDeclarationFile: false,
        getLineAndCharacterOfPosition: jest.fn().mockReturnValue({ line: 0, character: 0 }),
        getText: jest.fn().mockReturnValue('function main() { helper(); }')
      };

      const mockTsProgram: TsProgram = {
        program: null,
        sourceFiles: new Map([
          ['/test/src/index.ts', mockSourceFile as any]
        ]),
        checker: null,
        projectRoot: '/test',
        tsconfigPaths: {}
      };

      // Mock TypeScript API
      const mockTs = require('typescript');
      mockTs.isCallExpression = jest.fn().mockReturnValue(true);
      mockTs.isNewExpression = jest.fn().mockReturnValue(false);
      mockTs.isIdentifier = jest.fn().mockReturnValue(true);

      const result = astBuilder.extractSymbolCallGraph(mockTsProgram, symbolIndex);

      expect(result).toBeDefined();
      expect(Array.isArray(result)).toBe(true);
    });
  });

  describe('utility methods', () => {
    it('should check if file is noise correctly', () => {
      const isNoise = (astBuilder as any).isNoiseFile;
      
      expect(isNoise('node_modules/lodash/index.js')).toBe(true);
      expect(isNoise('dist/bundle.js')).toBe(true);
      expect(isNoise('src/__generated__/types.ts')).toBe(true);
      expect(isNoise('src/index.ts')).toBe(false);
    });

    it('should resolve tsconfig paths correctly', () => {
      mockFs.existsSync.mockReturnValue(true);
      mockFs.readFileSync.mockReturnValue(JSON.stringify({
        compilerOptions: {
          baseUrl: '.',
          paths: {
            '@/*': ['./src/*'],
            '~/*': ['./lib/*']
          }
        }
      }));
      
      const result = (astBuilder as any).resolveTsconfigPaths('/test/workspace');
      
      expect(result['@/*']).toContain('/test/workspace/src/*');
      expect(result['~/*']).toContain('/test/workspace/lib/*');
    });

    it('should handle missing tsconfig gracefully', () => {
      mockFs.existsSync.mockReturnValue(false);
      
      const result = (astBuilder as any).resolveTsconfigPaths('/test/workspace');
      
      expect(result).toEqual({});
    });

    it('should compile path patterns correctly', () => {
      const patterns = (astBuilder as any).compilePaths('/test/workspace');
      
      // This will be empty since we're not mocking the tsconfig resolution
      expect(patterns).toEqual([]);
    });
  });

  describe('cache management', () => {
    it('should clear cache correctly', () => {
      // Build a program to populate cache
      mockFs.existsSync.mockReturnValue(true);
      mockTs.findConfigFile.mockReturnValue('/test/workspace/tsconfig.json');
      mockTs.readConfigFile.mockReturnValue({ config: {} });
      mockTs.parseJsonConfigFileContent.mockReturnValue({
        fileNames: [],
        options: {},
        projectReferences: []
      });
      
      const mockProgram = { getSourceFiles: jest.fn(), getTypeChecker: jest.fn() };
      mockTs.createProgram.mockReturnValue(mockProgram);
      mockTs.createCompilerHost.mockReturnValue({});
      mockProgram.getSourceFiles.mockReturnValue([]);
      mockProgram.getTypeChecker.mockReturnValue({});
      
      astBuilder.buildTsProgram('/test/workspace');
      
      // Clear cache
      astBuilder.clearCache();
      
      // Verify cache is cleared by checking that createProgram is called again
      astBuilder.buildTsProgram('/test/workspace');
      expect(mockTs.createProgram).toHaveBeenCalledTimes(2);
    });

    it('should dispose correctly', () => {
      // Build a program to populate cache
      mockFs.existsSync.mockReturnValue(true);
      mockTs.findConfigFile.mockReturnValue('/test/workspace/tsconfig.json');
      mockTs.readConfigFile.mockReturnValue({ config: {} });
      mockTs.parseJsonConfigFileContent.mockReturnValue({
        fileNames: [],
        options: {},
        projectReferences: []
      });
      
      const mockProgram = { getSourceFiles: jest.fn(), getTypeChecker: jest.fn() };
      mockTs.createProgram.mockReturnValue(mockProgram);
      mockTs.createCompilerHost.mockReturnValue({});
      mockProgram.getSourceFiles.mockReturnValue([]);
      mockProgram.getTypeChecker.mockReturnValue({});
      
      astBuilder.buildTsProgram('/test/workspace');
      
      // Dispose
      astBuilder.dispose();
      
      // Should not throw
      expect(() => astBuilder.dispose()).not.toThrow();
    });
  });

  describe('error handling', () => {
    it('should handle TypeScript compilation errors gracefully', () => {
      const workspace = '/test/workspace';
      
      // Mock TypeScript failure
      mockFs.existsSync.mockReturnValue(true);
      mockTs.findConfigFile.mockReturnValue('/test/workspace/tsconfig.json');
      mockTs.readConfigFile.mockImplementation(() => {
        throw new Error('Invalid tsconfig');
      });
      
      // Mock Babel fallback
      const mockParse = require('@babel/parser').parse;
      mockParse.mockReturnValue({ type: 'Program' });
      mockFs.readdirSync.mockReturnValue([]);
      
      const result = astBuilder.buildTsProgram(workspace);
      
      expect(result).toBeDefined();
      expect(result.program).toBeNull();
    });

    it('should handle file system errors gracefully', () => {
      const workspace = '/test/workspace';
      
      // Mock file system errors in createCacheKey
      mockFs.existsSync.mockImplementation((path) => {
        if (path.includes('tsconfig') || path.includes('jsconfig')) {
          return false; // No config files
        }
        return true; // Other files exist
      });
      
      // Mock Babel fallback
      const mockParse = require('@babel/parser').parse;
      mockParse.mockReturnValue({ type: 'Program' });
      mockFs.readdirSync.mockReturnValue([]);
      
      const result = astBuilder.buildTsProgram(workspace);
      
      expect(result).toBeDefined();
    });
  });

});