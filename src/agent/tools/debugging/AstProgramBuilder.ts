/**
 * AST Program Builder for debugging code extraction
 * 
 * Builds TypeScript programs and extracts import/call graphs for execution analysis
 * Implements robust TypeScript compiler integration with proper resolution and caching
 */

import * as ts from 'typescript';
import * as path from 'path';
import * as fs from 'fs';
import { parse } from '@babel/parser';
import traverse from '@babel/traverse';
import { TsProgram, ImportExportRelation, CallRelation, SymbolDef, SymbolCall } from './types';

// Constants for AST building limits
const MAX_SYMBOLS_PER_FILE = 300;                 // Max symbols per file
const CACHE_MAX_FILES = 50;                       // LRU cache size
const CACHE_MAX_MB = 20;                           // LRU cache memory limit (approx)

// Enhanced interfaces for better type safety and functionality
interface AstIndexes {
  importAdj: Map<string, Set<string>>;           // file -> neighbors
  symbolDefs: Map<string, SymbolDef[]>;        // file -> SymbolDef[]
  fileExports: Map<string, string[]>;            // quick lookup
  barrels: Map<string, string[]>;                // barrel -> concrete files
  httpRoutes: Map<string, string[]>;             // "/api/user" -> [files]
}

// LRU cache entry for file content
interface FileCacheEntry {
  content: string;
  size: number;
  lastAccess: number;
}

interface PathPattern {
  re: RegExp;
  outs: string[];
}

interface SourceMapResolver {
  map(jsFile: string, line: number, col: number): { file: string; line: number; col: number } | null;
}

interface CallTarget {
  name: string;
  file: string | null;
  start: number | null;
  end: number | null;
  confidence: number;
}

interface ResolvedImportInfo {
  targetFile: string;
  targetFiles: string[];
  namespace?: string;
  isNamespace: boolean;
  exportName?: string;
}

interface AstProgramBuilderOptions {
  fallbackCompilerOptions?: ts.CompilerOptions;
  includeGlobs?: string[];
  excludeGlobs?: string[];
}

export class AstProgramBuilder {
  private readonly workspaceRoot: string;
  private readonly opts?: AstProgramBuilderOptions;
  private programCache = new Map<string, TsProgram>();
  private indexesCache = new Map<string, AstIndexes>();
  private pathPatternsCache = new Map<string, PathPattern[]>();
  private fileContentCache = new Map<string, FileCacheEntry>(); // LRU cache for file content
  private cacheTotalSize = 0; // Total size in bytes
  private treeSitterAvailable = false; // Feature flag for Tree-sitter
  private treeSitterInitialized = false; // Track if we've checked Tree-sitter availability

  constructor(workspaceRoot: string, opts?: AstProgramBuilderOptions) {
    this.workspaceRoot = workspaceRoot;
    this.opts = opts;
  }

  /**
   * Build TypeScript program with proper compiler integration
   */
  public buildTsProgram(workspace: string, config?: any): TsProgram {
    const cacheKey = this.createCacheKey(workspace, config);
    
    // Check cache first
    if (this.programCache.has(cacheKey)) {
      return this.programCache.get(cacheKey)!;
    }

    try {
      const program = this.createTypeScriptProgram(workspace, config);
      
      // Safety check: if program has no meaningful source files, fallback to Babel
      if (!this.hasMeaningfulSourceFiles(program)) {
        console.log('[AstProgramBuilder] TS program empty, using Babel fallback');
        return this.buildWithBabel(workspace, config);
      }
      
      const tsProgram = this.wrapTsProgram(program, workspace, config);
      
      // Cache the result
      this.programCache.set(cacheKey, tsProgram);
      
      return tsProgram;
    } catch (error) {
      console.warn('TypeScript program build failed, falling back to Babel:', error);
      return this.buildWithBabel(workspace, config);
    }
  }

  /**
   * Detect realistic baseUrl for project
   */
  private detectBaseUrl(workspace: string): string {
    const srcPath = path.join(workspace, 'src');
    return fs.existsSync(srcPath) ? srcPath : workspace;
  }

  /**
   * Check if program has meaningful source files
   */
  private hasMeaningfulSourceFiles(program: ts.Program): boolean {
    const sourceFiles = program.getSourceFiles().filter(sf => !sf.isDeclarationFile);
    return sourceFiles.length > 0;
  }

  /**
   * Create TypeScript program using proper compiler APIs
   */
  private createTypeScriptProgram(workspace: string, config?: any): ts.Program {
    const cfgPath = ts.findConfigFile(workspace, ts.sys.fileExists, 'tsconfig.json') ||
                   ts.findConfigFile(workspace, ts.sys.fileExists, 'jsconfig.json');
    
    if (!cfgPath) {
      // Create minimal config with realistic defaults
      const compilerOptions: ts.CompilerOptions = {
        target: ts.ScriptTarget.ES2020,
        module: ts.ModuleKind.ESNext,
        moduleResolution: ts.ModuleResolutionKind.NodeJs,
        allowJs: true,
        checkJs: false,
        strict: false,
        esModuleInterop: true,
        skipLibCheck: true,
        forceConsistentCasingInFileNames: true,
        baseUrl: this.detectBaseUrl(workspace),
        ...(this.opts?.fallbackCompilerOptions ?? {})
      };
      
      // Scan workspace for source files with safety filters
      const rootNames = this.getAllSourceFiles(workspace, {
        exts: ['.ts', '.tsx', '.js', '.jsx'],
        ignore: [
          '**/node_modules/**',
          '**/.git/**',
          '**/.next/**',
          '**/dist/**',
          '**/build/**',
          '**/coverage/**'
        ],
        maxFiles: 2000
      });
      
      if (!rootNames.length) {
        console.warn('[AstProgramBuilder] Fallback discovered 0 files in workspace:', workspace);
      }
      
      return ts.createProgram(rootNames, compilerOptions);
    }

    // Parse config with proper extends support
    const configFile = ts.readConfigFile(cfgPath, ts.sys.readFile);
    const parsedConfig = ts.parseJsonConfigFileContent(
      configFile.config,
      ts.sys,
      path.dirname(cfgPath),
      undefined,
      cfgPath
    );

    // Use compiler's file names instead of manual walking
    const fileNames = parsedConfig.fileNames.filter(file => 
      !this.isNoiseFile(file) && !file.endsWith('.d.ts')
    );
    
    return ts.createProgram({
      rootNames: fileNames,
      options: parsedConfig.options,
      projectReferences: parsedConfig.projectReferences,
      host: ts.createCompilerHost(parsedConfig.options)
    });
  }

  /**
   * Wrap TypeScript program with enhanced metadata and indexes
   */
  private wrapTsProgram(program: ts.Program, workspace: string, config?: any): TsProgram {
    const sourceFiles = new Map<string, ts.SourceFile>();
    const allSourceFiles: ts.SourceFile[] = [];
    
    // Collect all source files first
    for (const sourceFile of program.getSourceFiles()) {
      if (!sourceFile.isDeclarationFile && !this.isNoiseFile(sourceFile.fileName)) {
        allSourceFiles.push(sourceFile);
      }
    }

    // Add all source files to the Map (no truncation - per-file limits prevent resource exhaustion)
    for (const sourceFile of allSourceFiles) {
      sourceFiles.set(sourceFile.fileName, sourceFile);
    }

    // Resolve tsconfig paths with proper pattern compilation
    const tsconfigPaths = this.resolveTsconfigPaths(workspace);

    return {
      program,
      sourceFiles,
      checker: program.getTypeChecker(),
      projectRoot: workspace,
      tsconfigPaths: this.convertTsconfigPaths(tsconfigPaths)
    };
  }

  /**
   * Enhanced Babel fallback with real parsing
   */
  private buildWithBabel(workspace: string, config?: any): TsProgram {
    console.log('Using Babel fallback for AST parsing');
    
    const sourceFiles = new Map<string, any>();
    const files = this.getAllSourceFiles(workspace);
    
    for (const file of files) {
      try {
        const content = fs.readFileSync(file, 'utf8');
        const ast = parse(content, {
          sourceType: 'module',
          plugins: [
            'typescript',
            'jsx',
            'decorators-legacy',
            'dynamicImport',
            'importMeta',
            'classProperties',
            'topLevelAwait'
          ]
        });
        
        sourceFiles.set(file, {
          fileName: file,
          text: content,
          getLineAndCharacterOfPosition: (pos: number) => {
            const lines = content.substring(0, pos).split('\n');
            return { line: lines.length - 1, character: lines[lines.length - 1].length };
          }
        });
      } catch (error) {
        console.warn(`Failed to parse ${file} with Babel:`, error);
      }
    }
    
    return {
      program: null,
      sourceFiles,
      checker: null,
      projectRoot: workspace,
      tsconfigPaths: this.convertTsconfigPaths(this.resolveTsconfigPaths(workspace))
    };
  }

  /**
   * Extract import/export graph with enhanced resolution
   */
  public extractImportGraph(tsProgram: TsProgram): ImportExportRelation[] {
    const relations: ImportExportRelation[] = [];
    
    for (const [fileName, sourceFile] of tsProgram.sourceFiles) {
      const fileRelations = this.extractFileImports(sourceFile, tsProgram);
      relations.push(...fileRelations);
    }
    
    return relations;
  }

  /**
   * Extract imports with proper TypeScript resolution
   */
  private extractFileImports(sourceFile: ts.SourceFile, tsProgram: TsProgram): ImportExportRelation[] {
    const relations: ImportExportRelation[] = [];
    const opts = tsProgram.program?.getCompilerOptions() || {};
    
    try {
      this.forEachNodeIterative(sourceFile, (node: ts.Node) => {
        // Handle import declarations
        if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
          const spec = node.moduleSpecifier.text;
          const resolved = this.resolveImportPath(spec, sourceFile.fileName, opts);
          const line = sourceFile.getLineAndCharacterOfPosition(node.getStart()).line + 1;
          
          if (resolved) {
            relations.push({
              from: sourceFile.fileName,
              to: resolved,
              kind: 'import',
              line,
              confidence: 0.95
            });
          }
        }
        
        // Handle export declarations (re-exports)
        if (ts.isExportDeclaration(node) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) {
          const spec = node.moduleSpecifier.text;
          const resolved = this.resolveImportPath(spec, sourceFile.fileName, opts);
          const line = sourceFile.getLineAndCharacterOfPosition(node.getStart()).line + 1;
          
          if (resolved) {
            relations.push({
              from: sourceFile.fileName,
              to: resolved,
              kind: 'reexport',
              line,
              confidence: 0.7
            });
          }
        }
        
        // Handle dynamic imports
        if (ts.isCallExpression(node) && 
            ts.isIdentifier(node.expression) && 
            node.expression.text === 'import' &&
            node.arguments.length > 0 &&
            ts.isStringLiteral(node.arguments[0])) {
          const spec = node.arguments[0].text;
          const resolved = this.resolveImportPath(spec, sourceFile.fileName, opts);
          const line = sourceFile.getLineAndCharacterOfPosition(node.getStart()).line + 1;
          
          if (resolved) {
            relations.push({
              from: sourceFile.fileName,
              to: resolved,
              kind: 'dynamicImport',
              line,
              confidence: 0.4
            });
          }
        }
      });
    } catch (error) {
      console.warn(`[AstProgramBuilder] Error extracting imports from ${sourceFile.fileName}:`, error);
    }
    
    return relations;
  }

  /**
   * Extract call graph with symbol resolution
   */
  public extractCallGraph(tsProgram: TsProgram): CallRelation[] {
    const relations: CallRelation[] = [];
    
    for (const [fileName, sourceFile] of tsProgram.sourceFiles) {
      const fileRelations = this.extractFileCalls(sourceFile, tsProgram);
      relations.push(...fileRelations);
    }
    
    return relations;
  }

  /**
   * Extract symbol-level call graph with cross-file resolution
   */
  public extractSymbolCallGraph(
    tsProgram: TsProgram,
    symbolIndex: Map<string, SymbolDef[]>
  ): SymbolCall[] {
    const calls: SymbolCall[] = [];
    const visitedFiles = new Set<string>(); // Prevent cycles in file traversal
    const visitedSymbols = new Set<string>(); // Prevent cycles in symbol traversal
    const edgeDedupe = new Set<string>(); // Track (srcId, dstId) pairs to prevent duplicate edges
    
    // Iterate over all source files (per-file limits prevent resource exhaustion)
    for (const [fileName, sourceFile] of tsProgram.sourceFiles) {
      // Skip if already visited (cycle guard)
      if (visitedFiles.has(fileName)) {
        continue;
      }
      visitedFiles.add(fileName);
      
      try {
        const fileCalls = this.extractSymbolCallsForFile(sourceFile, tsProgram, symbolIndex, visitedSymbols, edgeDedupe);
        calls.push(...fileCalls);
      } catch (error) {
        console.warn(`[AstProgramBuilder] Error extracting symbol calls from ${fileName}:`, error);
      }
    }
    
    return calls;
  }

  /**
   * Extract function calls with proper symbol resolution
   */
  private extractFileCalls(sourceFile: ts.SourceFile, tsProgram: TsProgram): CallRelation[] {
    const relations: CallRelation[] = [];
    
    try {
      this.forEachNodeIterative(sourceFile, (node: ts.Node) => {
        // Handle function calls
        if (ts.isCallExpression(node)) {
          this.tryAddCallRelation(node, sourceFile, tsProgram, relations);
        }

        if (ts.isNewExpression(node)) {
          this.tryAddCallRelation(node, sourceFile, tsProgram, relations);
        }
        
        // Handle framework-specific patterns
        this.detectFrameworkPatterns(node, sourceFile, tsProgram, relations);
      });
    } catch (error) {
      console.warn(`[AstProgramBuilder] Error extracting calls from ${sourceFile.fileName}:`, error);
    }
    
    return relations;
  }

  /**
   * Resolve callee with TypeScript checker
   */
  private resolveCallee(expression: ts.Expression, tsProgram: TsProgram): CallTarget | null {
    if (!tsProgram.checker) {
      // Fallback for Babel mode
      return this.getCallTargetFallback(expression);
    }

    const checker = tsProgram.checker;
    const id = ts.isPropertyAccessExpression(expression) ? expression.name :
               ts.isIdentifier(expression) ? expression : null;
    
    if (!id) {
      return this.getCallTargetFallback(expression);
    }

    const sym = checker.getSymbolAtLocation(id);
    if (!sym) {
      return { name: id.getText(), file: null, start: null, end: null, confidence: 0.6 };
    }

    const decl = sym.declarations?.[0];
    if (!decl) {
      return { name: checker.getFullyQualifiedName(sym), file: null, start: null, end: null, confidence: 0.6 };
    }

    const sf = decl.getSourceFile();
    const { line } = sf.getLineAndCharacterOfPosition(decl.getStart());
    
    return {
      name: checker.getFullyQualifiedName(sym),
      file: sf.fileName,
      start: line + 1,
      end: null,
      confidence: 0.9
    };
  }

  /**
   * Fallback call target resolution
   */
  private getCallTargetFallback(expression: ts.Expression): CallTarget | null {
    if (ts.isIdentifier(expression)) {
      return { name: expression.text, file: null, start: null, end: null, confidence: 0.6 };
    }
    
    if (ts.isPropertyAccessExpression(expression)) {
      return { name: expression.name.text, file: null, start: null, end: null, confidence: 0.5 };
    }
    
    if (ts.isElementAccessExpression(expression)) {
      const argument = expression.argumentExpression;
      if (ts.isStringLiteral(argument)) {
        return { name: argument.text, file: null, start: null, end: null, confidence: 0.3 };
      }
    }
    
    return null;
  }

  /**
   * Detect framework-specific patterns
   */
  private detectFrameworkPatterns(
    node: ts.Node, 
    sourceFile: ts.SourceFile, 
    tsProgram: TsProgram, 
    relations: CallRelation[]
  ): void {
    // Next.js route handlers
    if (ts.isExportDeclaration(node) && node.exportClause) {
      const line = sourceFile.getLineAndCharacterOfPosition(node.getStart()).line + 1;
      
      // Check for Next.js route exports
      if (ts.isNamedExports(node.exportClause)) {
        for (const element of node.exportClause.elements) {
          const name = element.name.text;
          if (['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'HEAD', 'OPTIONS'].includes(name)) {
            // Tag as route handler
            relations.push({
              caller: 'route',
              callee: name,
              file: sourceFile.fileName,
              line,
              confidence: 0.8
            });
          }
        }
      }
    }
    
    // Express/Koa router patterns
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)) {
      const obj = node.expression.expression;
      const method = node.expression.name;
      
      if (ts.isIdentifier(obj) && obj.text === 'router' && 
          ['get', 'post', 'put', 'delete', 'patch'].includes(method.text)) {
        const line = sourceFile.getLineAndCharacterOfPosition(node.getStart()).line + 1;
        
        relations.push({
          caller: 'router',
          callee: method.text,
          file: sourceFile.fileName,
          line,
          confidence: 0.7
        });
      }
    }
  }

  /**
   * Get containing function for a node
   */
  private getContainingFunction(node: ts.Node, sourceFile: ts.SourceFile): string {
    let current = node.parent;
    const moduleLabel = this.getModuleCallerLabel(sourceFile.fileName);
    
    while (current) {
      if (ts.isFunctionDeclaration(current) || ts.isMethodDeclaration(current)) {
        const name = current.name?.getText(sourceFile) || 'anonymous';
        return name;
      }
      if (ts.isArrowFunction(current) || ts.isFunctionExpression(current)) {
        return 'anonymous';
      }
      current = current.parent;
    }
    
    return moduleLabel;
  }

  private getModuleCallerLabel(fileName: string): string {
    const base = path.basename(fileName);
    return `module:${base}`;
  }

  /**
   * Extract symbol calls for a single file
   */
  private extractSymbolCallsForFile(
    sourceFile: ts.SourceFile,
    tsProgram: TsProgram,
    symbolIndex: Map<string, SymbolDef[]>,
    visitedSymbols?: Set<string>,
    edgeDedupe?: Set<string>
  ): SymbolCall[] {
    const calls: SymbolCall[] = [];
    let callCount = 0;
    const maxCallsPerFile = 500; // Performance limit
    const visited = visitedSymbols || new Set<string>();
    const edges = edgeDedupe || new Set<string>();
    
    try {
      this.forEachNodeIterative(sourceFile, (node: ts.Node) => {
        if (callCount >= maxCallsPerFile) return;
        
        if (ts.isCallExpression(node) || ts.isNewExpression(node)) {
          const callerSym = this.getEnclosingSymbol(sourceFile, node, symbolIndex);
          if (!callerSym) return;
          
          // Cycle guard: skip if caller already visited in this traversal
          if (visited.has(callerSym.id)) {
            return;
          }
          
          const callee = this.resolveCalleeSymbol(node.expression, sourceFile, tsProgram, symbolIndex);
          if (!callee) return;
          
          // Edge dedupe: skip if this edge already exists
          const edgeKey = `${callerSym.id}->${callee.id}`;
          if (edges.has(edgeKey)) {
            return;
          }
          edges.add(edgeKey);
          
          // Back-edge detection: if callee is in visited set, it's a cycle
          if (visited.has(callee.id)) {
            // Don't add the edge, but mark it as a detected cycle
            return;
          }
          
          const { line } = sourceFile.getLineAndCharacterOfPosition(node.getStart());
          
          calls.push({
            callerId: callerSym.id,
            calleeId: callee.id,
            file: sourceFile.fileName,
            line: line + 1,
            confidence: callee.confidence ?? 0.8,
            via: callee.via
          });
          
          callCount++;
        }
      });
    } catch (error) {
      console.warn(`[AstProgramBuilder] Error extracting symbol calls from ${sourceFile.fileName}:`, error);
    }
    
    return calls;
  }

  /**
   * Get the enclosing symbol (function/method/class) for a node
   */
  private getEnclosingSymbol(
    sourceFile: ts.SourceFile,
    node: ts.Node,
    symbolIndex: Map<string, SymbolDef[]>
  ): SymbolDef | null {
    let current = node.parent;
    const fileName = sourceFile.fileName;
    const fileSymbols = symbolIndex.get(fileName) || [];
    
    // Walk up to find containing function/method/class
    while (current) {
      if (ts.isFunctionDeclaration(current) && current.name) {
        const name = current.name.getText();
        const symbol = fileSymbols.find(s => s.name === name && s.kind === 'function');
        if (symbol) return symbol;
      }
      
      if (ts.isMethodDeclaration(current) && current.name) {
        const cls = current.parent && ts.isClassDeclaration(current.parent) 
          ? current.parent.name?.getText() 
          : undefined;
        const methodName = current.name.getText();
        const symbolName = cls ? `${cls}.${methodName}` : methodName;
        const symbol = fileSymbols.find(s => s.name === symbolName && s.kind === 'method');
        if (symbol) return symbol;
      }
      
      if (ts.isClassDeclaration(current) && current.name) {
        const name = current.name.getText();
        const symbol = fileSymbols.find(s => s.name === name && s.kind === 'class');
        if (symbol) return symbol;
      }
      
      // Arrow function or function expression in variable
      if (ts.isVariableDeclaration(current) && current.name && current.initializer) {
        if (ts.isArrowFunction(current.initializer) || ts.isFunctionExpression(current.initializer)) {
          const name = current.name.getText();
          const symbol = fileSymbols.find(s => s.name === name && s.kind === 'function');
          if (symbol) return symbol;
        }
      }
      
      current = current.parent;
    }
    
    // Fallback to module-level symbol
    return {
      id: `symbol:${fileName}:<module>`,
      name: '<module>',
      file: fileName,
      kind: 'function',
      startLine: 1,
      endLine: 1
    };
  }

  /**
   * Resolve callee expression to a SymbolDef
   */
  private resolveCalleeSymbol(
    expression: ts.Expression,
    sourceFile: ts.SourceFile,
    tsProgram: TsProgram,
    symbolIndex: Map<string, SymbolDef[]>
  ): { id: string; name: string; file: string; confidence?: number; via?: SymbolCall["via"] } | null {
    const fileName = sourceFile.fileName;
    const fileSymbols = symbolIndex.get(fileName) || [];
    
    // 1. Direct identifier in same file
    if (ts.isIdentifier(expression)) {
      const name = expression.text;
      const localSymbol = fileSymbols.find(s => s.name === name);
      if (localSymbol) {
        return {
          id: localSymbol.id,
          name: localSymbol.name,
          file: fileName,
          confidence: 0.95,
          via: 'ts-checker'
        };
      }
      
      const importInfo = this.resolveImportedBinding(name, sourceFile, tsProgram);
      if (importInfo) {
        const candidateFiles = importInfo.targetFiles && importInfo.targetFiles.length > 0
          ? importInfo.targetFiles
          : [importInfo.targetFile];
        const candidateNames = new Set<string>();
        candidateNames.add(name);
        if (importInfo.exportName) {
          candidateNames.add(importInfo.exportName);
        }

        for (const candidateFile of candidateFiles) {
          const targetFileSymbols = symbolIndex.get(candidateFile) || [];
          const symbol = targetFileSymbols.find(s => 
            candidateNames.has(s.name) || 
            (s.exportName && candidateNames.has(s.exportName))
          );

          if (symbol) {
            return {
              id: symbol.id,
              name: symbol.name,
              file: symbol.file,
              confidence: 0.85,
              via: 'import-resolution'
            };
          }
        }
      }
    }
    
    // 2. Property access (obj.method or obj.prop)
    if (ts.isPropertyAccessExpression(expression)) {
      const propName = expression.name.text;
      
      // Check if base is an imported binding
      const base = expression.expression;
      if (ts.isIdentifier(base)) {
        // Try to resolve base through imports
        const importInfo = this.resolveImportedBinding(base.text, sourceFile, tsProgram);
        
        if (importInfo) {
          const candidateFiles = importInfo.targetFiles && importInfo.targetFiles.length > 0
            ? importInfo.targetFiles
            : [importInfo.targetFile];
          
          for (const candidateFile of candidateFiles) {
            const targetFileSymbols = symbolIndex.get(candidateFile) || [];
            
            const symbol = targetFileSymbols.find(s => 
              s.name === propName || 
              s.name === `${importInfo.namespace}.${propName}` ||
              s.exportName === propName
            );
            
            if (symbol) {
              return {
                id: symbol.id,
                name: symbol.name,
                file: symbol.file,
                confidence: 0.85,
                via: 'import-resolution'
              };
            }
          }
          
          // Namespace import - look for export with matching name
          if (importInfo.isNamespace) {
            for (const candidateFile of candidateFiles) {
              const targetFileSymbols = symbolIndex.get(candidateFile) || [];
              
              const exportSymbol = targetFileSymbols.find(s => 
                s.exportName === propName || s.name === propName
              );
              if (exportSymbol) {
                return {
                  id: exportSymbol.id,
                  name: exportSymbol.name,
                  file: exportSymbol.file,
                  confidence: 0.8,
                  via: 'import-resolution'
                };
              }
            }
          }
        }
        
        // Check if it's a class method (base is class name in same file)
        const baseSymbol = fileSymbols.find(s => s.name === base.text);
        if (baseSymbol && baseSymbol.kind === 'class') {
          const methodName = `${base.text}.${propName}`;
          const methodSymbol = fileSymbols.find(s => s.name === methodName && s.kind === 'method');
          if (methodSymbol) {
            return {
              id: methodSymbol.id,
              name: methodSymbol.name,
              file: fileName,
              confidence: 0.75,
              via: 'property-access'
            };
          }
        }
      }
      
      // Could be instance method call - we can't fully resolve without dataflow
      // Return unresolved for LLM polishing
      return {
        id: `symbol:${fileName}:<unresolved:${expression.getText()}>`,
        name: `<unresolved:${expression.getText()}>`,
        file: fileName,
        confidence: 0.35,
        via: 'unresolved'
      };
    }
    
    // 3. Try TypeScript checker if available
    if (tsProgram.checker) {
      const checker = tsProgram.checker;
      const sym = checker.getSymbolAtLocation(expression);
      
      if (sym && sym.declarations && sym.declarations.length > 0) {
        const decl = sym.declarations[0];
        const declFile = decl.getSourceFile().fileName;
        const declSymbols = symbolIndex.get(declFile) || [];
        
        // Try to match declaration to symbol
        const { line } = decl.getSourceFile().getLineAndCharacterOfPosition(decl.getStart());
        const matchingSymbol = declSymbols.find(s => 
          s.startLine === line + 1 || 
          (s.startLine && s.endLine && line + 1 >= s.startLine && line + 1 <= s.endLine)
        );
        
        if (matchingSymbol) {
          return {
            id: matchingSymbol.id,
            name: matchingSymbol.name,
            file: matchingSymbol.file,
            confidence: 0.9,
            via: 'ts-checker'
          };
        }
      }
    }
    
    // 4. Unresolved - return special symbol for LLM polishing
    return {
      id: `symbol:${fileName}:<unresolved:${expression.getText()}>`,
      name: `<unresolved:${expression.getText()}>`,
      file: fileName,
      confidence: 0.35,
      via: 'unresolved'
    };
  }

  /**
   * Resolve imported binding to target file
   */
  private resolveImportedBinding(
    bindingName: string,
    sourceFile: ts.SourceFile,
    tsProgram: TsProgram
  ): ResolvedImportInfo | null {
    const opts = tsProgram.program?.getCompilerOptions() || {};
    let result: ResolvedImportInfo | null = null;
    
    // Walk through import declarations
    this.forEachNodeIterative(sourceFile, (node: ts.Node) => {
      if (result) return; // Early exit if found
      
      if (ts.isImportDeclaration(node) && node.importClause) {
        // Named imports: import { extractForDebugging } from './extractCodeTool'
        if (node.importClause.namedBindings) {
          if (ts.isNamedImports(node.importClause.namedBindings)) {
            for (const element of node.importClause.namedBindings.elements) {
              const aliasName = element.name?.text;
              const exportName = element.propertyName?.text || aliasName;
              
              if (aliasName === bindingName) {
                if (ts.isStringLiteral(node.moduleSpecifier)) {
                  const resolved = this.resolveImportPath(node.moduleSpecifier.text, sourceFile.fileName, opts);
                  if (resolved) {
                    result = this.createResolvedImportInfo({
                      resolved,
                      tsProgram,
                      exportName,
                      isNamespace: false,
                      bindingNode: element.name,
                      namespace: undefined
                    });
                    return;
                  }
                }
              }
            }
          }
          
          // Namespace import: import * as tools from './extractCodeTool'
          if (ts.isNamespaceImport(node.importClause.namedBindings)) {
            const namespaceName = node.importClause.namedBindings.name.text;
            if (namespaceName === bindingName) {
              if (ts.isStringLiteral(node.moduleSpecifier)) {
                const resolved = this.resolveImportPath(node.moduleSpecifier.text, sourceFile.fileName, opts);
                if (resolved) {
                  result = this.createResolvedImportInfo({
                    resolved,
                    tsProgram,
                    exportName: undefined,
                    isNamespace: true,
                    bindingNode: node.importClause.namedBindings.name,
                    namespace: namespaceName
                  });
                  return;
                }
              }
            }
          }
        }
      }
      
      // Default import: import ExtractCodeTool from './extractCodeTool'
      if (ts.isImportDeclaration(node) && node.importClause && node.importClause.name && node.importClause.name.text === bindingName) {
        if (ts.isStringLiteral(node.moduleSpecifier)) {
          const resolved = this.resolveImportPath(node.moduleSpecifier.text, sourceFile.fileName, opts);
          if (resolved) {
            result = this.createResolvedImportInfo({
              resolved,
              tsProgram,
              exportName: 'default',
              isNamespace: false,
              bindingNode: node.importClause.name,
              namespace: undefined
            });
            return;
          }
        }
      }
    });
    
    return result;
  }

  private createResolvedImportInfo(params: {
    resolved: string;
    tsProgram: TsProgram;
    exportName?: string;
    isNamespace: boolean;
    bindingNode?: ts.Identifier;
    namespace?: string;
  }): ResolvedImportInfo {
    const normalizedResolved = this.normalizeRealPath(params.resolved);
    const checkerFile = params.bindingNode
      ? this.resolveTargetFileWithChecker(params.bindingNode, params.tsProgram)
      : null;
    const initialTarget = checkerFile ?? normalizedResolved;
    const targetFiles = this.collectConcreteFiles(initialTarget, params.tsProgram);
    const filteredFiles = this.filterFilesByExport(targetFiles, params.exportName, params.tsProgram);
    const primaryFile = filteredFiles[0] ?? initialTarget;
    
    return {
      targetFile: primaryFile,
      targetFiles: Array.from(new Set(filteredFiles.length ? filteredFiles : [initialTarget])),
      namespace: params.namespace,
      isNamespace: params.isNamespace,
      exportName: params.exportName
    };
  }

  private resolveTargetFileWithChecker(identifier: ts.Identifier, tsProgram: TsProgram): string | null {
    const checker = tsProgram.checker;
    if (!checker) {
      return null;
    }

    try {
      const symbol = checker.getSymbolAtLocation(identifier);
      if (!symbol) {
        return null;
      }

      const targetSymbol = symbol.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(symbol) : symbol;
      const declaration = targetSymbol?.declarations?.find(
        (decl: ts.Declaration) => !decl.getSourceFile().isDeclarationFile
      );
      if (!declaration) {
        return null;
      }

      return this.normalizeRealPath(declaration.getSourceFile().fileName);
    } catch {
      return null;
    }
  }

  private collectConcreteFiles(
    filePath: string,
    tsProgram: TsProgram,
    visited: Set<string> = new Set()
  ): string[] {
    const normalized = this.normalizeRealPath(filePath);
    if (visited.has(normalized)) {
      return [normalized];
    }
    visited.add(normalized);

    const source = tsProgram.sourceFiles.get(normalized);
    if (!source) {
      return [normalized];
    }

    if (!this.isBarrelFile(source)) {
      return [normalized];
    }

    const concrete = new Set<string>();
    const compilerOpts = tsProgram.program?.getCompilerOptions() || {};

    this.forEachNodeIterative(source, (node: ts.Node) => {
      if (ts.isExportDeclaration(node) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) {
        const resolved = this.resolveImportPath(node.moduleSpecifier.text, normalized, compilerOpts);
        if (!resolved) {
          return;
        }
        const nested = this.collectConcreteFiles(resolved, tsProgram, visited);
        nested.forEach(file => concrete.add(file));
      }
    });

    concrete.add(normalized);

    return Array.from(concrete);
  }

  private filterFilesByExport(
    files: string[],
    exportName: string | undefined,
    tsProgram: TsProgram
  ): string[] {
    if (!exportName) {
      return files;
    }

    const matched: string[] = [];
    const cache = new Map<string, string[]>();

    for (const file of files) {
      const exports = this.getFileExports(file, tsProgram, cache);
      if (!exports) {
        continue;
      }

      if (exports.includes(exportName) || (exportName === 'default' && exports.includes('default'))) {
        matched.push(file);
      }
    }

    return matched.length ? matched : files;
  }

  private getFileExports(
    filePath: string,
    tsProgram: TsProgram,
    cache: Map<string, string[]>
  ): string[] | null {
    if (cache.has(filePath)) {
      return cache.get(filePath)!;
    }

    const source = tsProgram.sourceFiles.get(filePath);
    if (!source) {
      cache.set(filePath, []);
      return [];
    }

    const exports = this.extractFileExports(source);
    cache.set(filePath, exports);
    return exports;
  }

  private normalizeRealPath(filePath: string): string {
    try {
      return fs.existsSync(filePath) ? fs.realpathSync(filePath) : filePath;
    } catch {
      return filePath;
    }
  }

  private tryAddCallRelation(
    node: ts.CallExpression | ts.NewExpression,
    sourceFile: ts.SourceFile,
    tsProgram: TsProgram,
    relations: CallRelation[]
  ): void {
    const caller = this.getContainingFunction(node, sourceFile);
    const callee = this.resolveCallee(node.expression, tsProgram);

    if (!callee) {
      return;
    }

    const line = sourceFile.getLineAndCharacterOfPosition(node.getStart()).line + 1;
    const adjustedConfidence = caller.startsWith('module:') ? Math.min(callee.confidence, 0.6) : callee.confidence;

    relations.push({
      caller,
      callee: callee.name,
      file: sourceFile.fileName,
      line,
      confidence: adjustedConfidence
    });
  }

  /**
   * Iterative AST traversal helper to prevent stack overflow
   * Uses an explicit stack instead of recursion
   */
  private forEachNodeIterative(root: ts.Node, callback: (node: ts.Node) => void): void {
    const stack: ts.Node[] = [root];
    while (stack.length > 0) {
      const node = stack.pop()!;
      callback(node);
      // Use node.getChildren() which gets all child nodes
      // Push in reverse order to maintain left-to-right traversal when popping
      const children = node.getChildren();
      for (let i = children.length - 1; i >= 0; i--) {
        stack.push(children[i]);
      }
    }
  }

  /**
   * Resolve import path using TypeScript compiler
   */
  private resolveImportPath(spec: string, fromFile: string, opts: ts.CompilerOptions): string | null {
    try {
      const { resolvedModule } = ts.resolveModuleName(spec, fromFile, opts, ts.sys);
      const file = resolvedModule?.resolvedFileName;
      
      if (!file) {
        // Fallback to pattern matching
        return this.resolveWithPatterns(spec, fromFile);
      }
      
      // Ignore .d.ts unless it's a top frame
      if (file.endsWith('.d.ts')) {
        return null;
      }
      
      return fs.existsSync(file) ? fs.realpathSync(file) : null;
    } catch (error) {
      return this.resolveWithPatterns(spec, fromFile);
    }
  }

  /**
   * Resolve with compiled path patterns - try local then workspace root
   */
  private resolveWithPatterns(spec: string, fromFile: string): string | null {
    const workspace = path.dirname(fromFile);
    const localPatterns = this.getPathPatterns(workspace);
    
    // Try local patterns first
    const localResult = this.tryPatterns(spec, localPatterns);
    if (localResult) {
      return localResult;
    }
    
    // Fallback to workspace root patterns
    const rootPatterns = this.getPathPatterns(this.workspaceRoot);
    return this.tryPatterns(spec, rootPatterns);
  }

  /**
   * Try pattern matching against a set of compiled patterns
   */
  private tryPatterns(spec: string, patterns: PathPattern[]): string | null {
    for (const pattern of patterns) {
      const match = spec.match(pattern.re);
      if (match) {
        for (const out of pattern.outs) {
          const resolved = out.replace('$1', match[1] || '');
          if (fs.existsSync(resolved)) {
            return fs.realpathSync(resolved);
          }
        }
      }
    }
    return null;
  }

  /**
   * Get compiled path patterns for workspace
   */
  private getPathPatterns(workspace: string): PathPattern[] {
    const cacheKey = workspace;
    
    if (this.pathPatternsCache.has(cacheKey)) {
      return this.pathPatternsCache.get(cacheKey)!;
    }
    
    const patterns = this.compilePaths(workspace);
    this.pathPatternsCache.set(cacheKey, patterns);
    return patterns;
  }

  /**
   * Compile tsconfig paths to regex patterns
   */
  private compilePaths(workspace: string): PathPattern[] {
    const tsconfigPaths = this.resolveTsconfigPaths(workspace);
    const patterns: PathPattern[] = [];
    
    for (const [alias, targets] of Object.entries(tsconfigPaths)) {
      if (Array.isArray(targets)) {
        const re = new RegExp('^' + alias.replace('*', '(.+)') + '$');
        const outs = targets.map(t => path.resolve(workspace, t.replace('*', '$1')));
        patterns.push({ re, outs });
      }
    }
    
    return patterns;
  }

  /**
   * Get all source files in workspace (fallback method)
   */
  private getAllSourceFiles(
    workspace: string,
    options?: {
      exts?: string[];
      ignore?: string[];
      maxFiles?: number;
    }
  ): string[] {
    const startTime = Date.now();
    const files: string[] = [];
    const extensions = options?.exts || ['.ts', '.tsx', '.js', '.jsx'];
    const maxFiles = options?.maxFiles || 2000;
    const ignorePatterns = options?.ignore || [];
    
    // Helper to check if path matches ignore patterns
    const matchesIgnore = (filePath: string): boolean => {
      for (const pattern of ignorePatterns) {
        // Convert glob pattern to regex
        const regexStr = pattern
          .replace(/\*\*/g, '.*')
          .replace(/\*/g, '[^/]*')
          .replace(/\./g, '\\.');
        if (new RegExp(regexStr).test(filePath)) {
          return true;
        }
      }
      return false;
    };
    
    const walkDir = (dir: string) => {
      // Stop if we've hit the max files limit
      if (files.length >= maxFiles) {
        return;
      }
      
      try {
        const entries = fs.readdirSync(dir, { withFileTypes: true });
        
        for (const entry of entries) {
          // Stop if we've hit the limit
          if (files.length >= maxFiles) {
            break;
          }
          
          const fullPath = path.join(dir, entry.name);
          
          if (entry.isDirectory()) {
            // Skip if matches ignore pattern or is noise
            if (!matchesIgnore(fullPath) && !this.isNoiseFile(fullPath)) {
              walkDir(fullPath);
            }
          } else if (entry.isFile()) {
            // Only process if not ignored and has valid extension
            if (!matchesIgnore(fullPath) && !this.isNoiseFile(fullPath)) {
              const ext = path.extname(entry.name);
              if (extensions.includes(ext)) {
                files.push(fullPath);
              }
            }
          }
        }
      } catch (error) {
        // Skip directories we can't read
      }
    };
    
    walkDir(workspace);
    
    const duration = Date.now() - startTime;
    if (files.length >= maxFiles) {
      console.warn(`[AstProgramBuilder] File scan hit maxFiles limit (${maxFiles}) after ${duration}ms. Continuing with partial file set.`);
    }
    
    // Log performance for monitoring
    if (files.length > 0) {
      console.log(`[AstProgramBuilder] Discovered ${files.length} source files in ${duration}ms`);
    }
    
    return files;
  }

  /**
   * Check if file is noise (build artifacts, etc.)
   */
  private isNoiseFile(filePath: string): boolean {
    const noisePatterns = [
      /node_modules/,
      /\.next/,
      /dist/,
      /build/,
      /coverage/,
      /__generated__/,
      /\.d\.ts$/
    ];
    
    return noisePatterns.some(pattern => pattern.test(filePath));
  }

  /**
   * Convert tsconfig paths from array format to single string format
   */
  private convertTsconfigPaths(paths: Record<string, string[]>): Record<string, string> {
    const converted: Record<string, string> = {};
    for (const [alias, targets] of Object.entries(paths)) {
      if (Array.isArray(targets) && targets.length > 0) {
        converted[alias] = targets[0]; // Take first target
      }
    }
    return converted;
  }

  /**
   * Resolve tsconfig paths with proper extends support
   */
  private resolveTsconfigPaths(workspace: string): Record<string, string[]> {
    const tsconfigPath = path.join(workspace, 'tsconfig.json');
    const jsconfigPath = path.join(workspace, 'jsconfig.json');
    
    const configPath = fs.existsSync(tsconfigPath) ? tsconfigPath : 
                      fs.existsSync(jsconfigPath) ? jsconfigPath : null;
    
    if (!configPath) {
      return {};
    }

    try {
      const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
      const paths = config.compilerOptions?.paths || {};
      const baseUrl = config.compilerOptions?.baseUrl || '.';
      
      const resolvedPaths: Record<string, string[]> = {};
      for (const [alias, targets] of Object.entries(paths)) {
        if (Array.isArray(targets)) {
          resolvedPaths[alias] = targets.map(target => 
            path.resolve(workspace, baseUrl, target)
          );
        }
      }
      
      return resolvedPaths;
    } catch (error) {
      console.warn('Failed to parse tsconfig/jsconfig:', error);
      return {};
    }
  }

  /**
   * Build comprehensive AST indexes
   */
  public buildAstIndexes(tsProgram: TsProgram): AstIndexes {
    const cacheKey = this.createCacheKey(tsProgram.projectRoot);
    
    if (this.indexesCache.has(cacheKey)) {
      return this.indexesCache.get(cacheKey)!;
    }
    
    const indexes: AstIndexes = {
      importAdj: new Map(),
      symbolDefs: new Map(),
      fileExports: new Map(),
      barrels: new Map(),
      httpRoutes: new Map()
    };
    
    // Build import adjacency
    const importGraph = this.extractImportGraph(tsProgram);
    for (const rel of importGraph) {
      if (!indexes.importAdj.has(rel.from)) {
        indexes.importAdj.set(rel.from, new Set());
      }
      indexes.importAdj.get(rel.from)!.add(rel.to);
    }
    
    // Build symbol definitions
    const symbolIndex = this.buildSymbolIndex(tsProgram);
    for (const [fileName, symbols] of symbolIndex) {
      indexes.symbolDefs.set(fileName, symbols);
    }
    
    // Build file exports
    for (const [fileName, sourceFile] of tsProgram.sourceFiles) {
      const exports = this.extractFileExports(sourceFile);
      indexes.fileExports.set(fileName, exports);
    }
    
    // Build barrel files
    for (const [fileName, sourceFile] of tsProgram.sourceFiles) {
      if (this.isBarrelFile(sourceFile)) {
        const concreteFiles = this.getConcreteFilesFromBarrel(sourceFile, tsProgram);
        indexes.barrels.set(fileName, concreteFiles);
      }
    }
    
    // Build HTTP routes
    const callGraph = this.extractCallGraph(tsProgram);
    for (const rel of callGraph) {
      if (rel.caller === 'route' || rel.caller === 'router') {
        const route = `/${rel.callee.toLowerCase()}`;
        if (!indexes.httpRoutes.has(route)) {
          indexes.httpRoutes.set(route, []);
        }
        indexes.httpRoutes.get(route)!.push(rel.file);
      }
    }
    
    this.indexesCache.set(cacheKey, indexes);
    return indexes;
  }

  /**
   * Build symbol index for all files in program
   */
  public buildSymbolIndex(tsProgram: TsProgram): Map<string, SymbolDef[]> {
    const index = new Map<string, SymbolDef[]>();

    for (const [fileName, sourceFile] of tsProgram.sourceFiles) {
      const defs: SymbolDef[] = [];

      try {
        // Check if this is a real TypeScript SourceFile
        const isRealTsSourceFile = sourceFile && typeof (sourceFile as any).kind === 'number' && (sourceFile as any).kind === ts.SyntaxKind.SourceFile;
        
        if (!isRealTsSourceFile) {
          console.warn(`[AstProgramBuilder] ${path.basename(fileName)} is not a real TypeScript SourceFile (might be from Babel fallback)`);
          index.set(fileName, []);
          continue;
        }
        
        let nodeCount = 0;
        let functionDeclCount = 0;
        let classDeclCount = 0;
        let methodDeclCount = 0;
        let variableDeclCount = 0;
        
        this.forEachNodeIterative(sourceFile as ts.SourceFile, (node: ts.Node) => {
          // Cap symbols per file to prevent stack overflow
          if (defs.length >= MAX_SYMBOLS_PER_FILE) {
            return;
          }
          
          nodeCount++;
          
          // function foo() {}
          if (ts.isFunctionDeclaration(node)) {
            functionDeclCount++;
            if (node.name && defs.length < MAX_SYMBOLS_PER_FILE) {
              defs.push(this.makeSymbolDef(fileName, node.name.getText(), "function", node));
            }
          }

          // class A {}
          if (ts.isClassDeclaration(node)) {
            classDeclCount++;
            if (node.name && defs.length < MAX_SYMBOLS_PER_FILE) {
              defs.push(this.makeSymbolDef(fileName, node.name.getText(), "class", node));
            }
          }

          // class A { method() {} }
          if (ts.isMethodDeclaration(node)) {
            methodDeclCount++;
            if (node.name && defs.length < MAX_SYMBOLS_PER_FILE) {
              const cls = node.parent && ts.isClassDeclaration(node.parent) ? node.parent.name?.getText() : undefined;
              const methodName = node.name.getText();
              const symbolName = cls ? `${cls}.${methodName}` : methodName;
              defs.push(this.makeSymbolDef(fileName, symbolName, "method", node, cls));
            }
          }

          // const foo = () => {} or const foo = function() {}
          if (ts.isVariableDeclaration(node) && node.name && node.initializer) {
            variableDeclCount++;
            if (defs.length < MAX_SYMBOLS_PER_FILE) {
              if (ts.isArrowFunction(node.initializer) || ts.isFunctionExpression(node.initializer)) {
                defs.push(this.makeSymbolDef(fileName, node.name.getText(), "function", node));
              } else if (ts.isIdentifier(node.name)) {
                // Regular variable
                defs.push(this.makeSymbolDef(fileName, node.name.getText(), "variable", node));
              }
            }
          }
        });
        
        // Log if we hit the symbol limit
        if (defs.length >= MAX_SYMBOLS_PER_FILE) {
          console.log(`[AstProgramBuilder] Capped symbols for ${path.basename(fileName)} at ${MAX_SYMBOLS_PER_FILE}`);
        }
        
        // Debug output for files with expected symbols but found none
        if (fileName.includes('samuraiAgent') || fileName.includes('extractCodeTool') || fileName.includes('StaticSlicer')) {
          console.log(`[AstProgramBuilder] ${path.basename(fileName)}:`, {
            nodes: nodeCount,
            functionDecls: functionDeclCount,
            classDecls: classDeclCount,
            methodDecls: methodDeclCount,
            variableDecls: variableDeclCount,
            symbolsFound: defs.length
          });
          
          if (defs.length === 0 && (functionDeclCount > 0 || classDeclCount > 0 || methodDeclCount > 0)) {
            console.warn(`[AstProgramBuilder] Found declarations but no symbols in ${fileName}:`, {
              nodes: nodeCount,
              functionDecls: functionDeclCount,
              classDecls: classDeclCount,
              methodDecls: methodDeclCount,
              variableDecls: variableDeclCount,
              symbolsFound: defs.length
            });
          }
        }
      } catch (error) {
        console.warn(`[AstProgramBuilder] Error extracting symbols from ${fileName}:`, error);
      }

      index.set(fileName, defs);
    }

    return index;
  }

  /**
   * Create SymbolDef from node
   */
  private makeSymbolDef(
    file: string,
    name: string,
    kind: SymbolDef["kind"],
    node: ts.Node,
    receiverType?: string
  ): SymbolDef {
    const sourceFile = node.getSourceFile();
    const startPos = node.getStart();
    const endPos = node.getEnd();
    const { line: startLine } = sourceFile.getLineAndCharacterOfPosition(startPos);
    const { line: endLine } = sourceFile.getLineAndCharacterOfPosition(endPos);

    // Check if exported
    let exportName: string | undefined;
    if (ts.isFunctionDeclaration(node) || ts.isClassDeclaration(node) || ts.isMethodDeclaration(node)) {
      const modifiers = ts.getModifiers(node);
      if (modifiers) {
        for (const mod of modifiers) {
          if (mod.kind === ts.SyntaxKind.ExportKeyword) {
            exportName = name;
            break;
          }
        }
      }
    }

    // Check parent for export
    if (!exportName && node.parent) {
      if (ts.isVariableStatement(node.parent)) {
        const modifiers = ts.getModifiers(node.parent);
        if (modifiers) {
          for (const mod of modifiers) {
            if (mod.kind === ts.SyntaxKind.ExportKeyword) {
              exportName = name;
              break;
            }
          }
        }
      }
    }

    return {
      id: `symbol:${file}:${name}`,
      name,
      file,
      kind,
      receiverType,
      exportName,
      startLine: startLine + 1,
      endLine: endLine + 1
    };
  }

  /**
   * Extract file exports
   */
  private extractFileExports(sourceFile: ts.SourceFile): string[] {
    const exports: string[] = [];
    
    try {
      this.forEachNodeIterative(sourceFile, (node: ts.Node) => {
        if (ts.isExportDeclaration(node) && node.exportClause) {
          if (ts.isNamedExports(node.exportClause)) {
            for (const element of node.exportClause.elements) {
              exports.push(element.name.text);
            }
          }
        } else if (ts.isExportAssignment(node)) {
          exports.push('default');
        }
      });
    } catch (error) {
      console.warn(`[AstProgramBuilder] Error extracting exports from ${sourceFile.fileName}:`, error);
    }
    
    return exports;
  }

  /**
   * Check if file is a barrel file
   */
  private isBarrelFile(sourceFile: ts.SourceFile): boolean {
    const fileName = path.basename(sourceFile.fileName);
    return fileName === 'index.ts' || fileName === 'index.js';
  }

  /**
   * Get concrete files from barrel
   */
  private getConcreteFilesFromBarrel(sourceFile: ts.SourceFile, tsProgram: TsProgram): string[] {
    const concreteFiles: string[] = [];
    
    try {
      this.forEachNodeIterative(sourceFile, (node: ts.Node) => {
        if (ts.isExportDeclaration(node) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) {
          const spec = node.moduleSpecifier.text;
          const resolved = this.resolveImportPath(spec, sourceFile.fileName, tsProgram.program?.getCompilerOptions() || {});
          if (resolved) {
            concreteFiles.push(resolved);
          }
        }
      });
    } catch (error) {
      console.warn(`[AstProgramBuilder] Error extracting concrete files from barrel ${sourceFile.fileName}:`, error);
    }
    
    return concreteFiles;
  }

  /**
   * Create cache key for program
   */
  private createCacheKey(workspace: string, config?: any): string {
    const tsconfigPath = path.join(workspace, 'tsconfig.json');
    const jsconfigPath = path.join(workspace, 'jsconfig.json');
    const configPath = fs.existsSync(tsconfigPath) ? tsconfigPath : jsconfigPath;
    
    const mtime = configPath && fs.existsSync(configPath) ? 
                  fs.statSync(configPath).mtime.getTime() : 0;
    
    return `${workspace}-${mtime}-${JSON.stringify(config || {})}`;
  }

  /**
   * Clear all caches
   */
  public clearCache(): void {
    this.programCache.clear();
    this.indexesCache.clear();
    this.pathPatternsCache.clear();
  }

  /**
   * Dispose of TypeScript programs to free memory
   */
  public dispose(): void {
    for (const program of this.programCache.values()) {
      if (program.program) {
        // TypeScript programs don't have explicit dispose, but we can clear references
        (program as any).program = null;
        (program as any).checker = null;
      }
    }
    this.clearCache();
    this.fileContentCache.clear();
    this.cacheTotalSize = 0;
  }

  /**
   * Check Tree-sitter availability (for feature flag)
   * This checks once and caches the result
   */
  private checkTreeSitterAvailability(): boolean {
    if (this.treeSitterInitialized) {
      return this.treeSitterAvailable;
    }
    
    // Try to detect if Tree-sitter is available
    // In practice, this would check CodeParserService or TreeSitterLoaderService
    // For now, assume it's available unless explicitly disabled
    this.treeSitterAvailable = true; // Default to true - TypeScript compiler is always available
    this.treeSitterInitialized = true;
    
    return this.treeSitterAvailable;
  }

  /**
   * Get file content with LRU caching
   */
  private getFileContent(filePath: string): string | null {
    const now = Date.now();
    
    // Check cache
    const cached = this.fileContentCache.get(filePath);
    if (cached) {
      cached.lastAccess = now;
      return cached.content;
    }
    
    // Read file
    try {
      const content = fs.readFileSync(filePath, 'utf-8');
      const size = Buffer.byteLength(content, 'utf-8');
      
      // Evict if cache too large
      this.evictCacheIfNeeded(size);
      
      // Add to cache
      this.fileContentCache.set(filePath, {
        content,
        size,
        lastAccess: now
      });
      this.cacheTotalSize += size;
      
      return content;
    } catch (error) {
      return null;
    }
  }

  /**
   * Evict LRU entries if cache exceeds limits
   */
  private evictCacheIfNeeded(newSize: number): void {
    const maxSize = CACHE_MAX_MB * 1024 * 1024; // Convert MB to bytes
    
    // Evict by file count first
    while (this.fileContentCache.size >= CACHE_MAX_FILES) {
      this.evictLRUEntry();
    }
    
    // Evict by size
    while (this.cacheTotalSize + newSize > maxSize && this.fileContentCache.size > 0) {
      this.evictLRUEntry();
    }
  }

  /**
   * Evict least recently used entry
   */
  private evictLRUEntry(): void {
    let lruKey: string | null = null;
    let lruTime = Infinity;
    
    for (const [key, entry] of this.fileContentCache.entries()) {
      if (entry.lastAccess < lruTime) {
        lruTime = entry.lastAccess;
        lruKey = key;
      }
    }
    
    if (lruKey) {
      const entry = this.fileContentCache.get(lruKey);
      if (entry) {
        this.cacheTotalSize -= entry.size;
      }
      this.fileContentCache.delete(lruKey);
    }
  }
}
