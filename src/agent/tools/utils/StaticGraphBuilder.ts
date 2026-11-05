/**
 * StaticGraphBuilder - Builds raw MethodExecutionGraph from file system
 * 
 * Crawls the codebase using ts-morph to extract symbols, imports, and calls.
 * This creates the "haystack" that GraphCompressor will refine into the "needle".
 */

import { Project, SourceFile, SyntaxKind, FunctionDeclaration, MethodDeclaration, ClassDeclaration } from 'ts-morph';
import {
  MethodExecutionGraph,
  SymbolDef,
  SymbolCall,
  ImportExportRelation,
  GraphNode,
  GraphEdge
} from '../debugging/types';
import { GraphCompressor } from '../debugging/GraphCompressor';
import { LLMProviderService } from '../../llm/llmProviderService';

interface FileQueueItem {
  path: string;
  currentDepth: number;
}

export class StaticGraphBuilder {
  private project: Project;

  constructor(project: Project) {
    this.project = project;
  }

  /**
   * Crawls the codebase from an epicenter to build a raw graph.
   */
  async buildGraph(filePath: string, depth: number): Promise<MethodExecutionGraph> {
    const symbols: SymbolDef[] = [];
    const symbolEdges: SymbolCall[] = [];
    const files: string[] = [filePath];
    const fileEdges: ImportExportRelation[] = [];
    const processedFiles = new Set<string>();

    const queue: FileQueueItem[] = [{ path: filePath, currentDepth: 0 }];

    while (queue.length > 0) {
      const { path: currentPath, currentDepth } = queue.shift()!;
      
      if (processedFiles.has(currentPath) || currentDepth > depth) {
        continue;
      }
      
      processedFiles.add(currentPath);

      // Add file to project if needed
      let sourceFile = this.project.getSourceFile(currentPath);
      if (!sourceFile) {
        try {
          sourceFile = this.project.addSourceFileAtPath(currentPath);
        } catch (error) {
          // Skip files that can't be parsed
          continue;
        }
      }

      if (!sourceFile) {
        continue;
      }

      // 1. Collect Symbols (Nodes)
      this.extractSymbols(sourceFile, symbols);

      // 2. Collect Imports (Edges & Queue)
      const imports = sourceFile.getImportDeclarations();
      for (const imp of imports) {
        const moduleSpecifier = imp.getModuleSpecifierValue();
        const modulePath = imp.getModuleSpecifierSourceFile()?.getFilePath();
        
        if (modulePath && !modulePath.includes('node_modules')) {
          fileEdges.push({
            from: currentPath,
            to: modulePath,
            kind: 'import',
            line: imp.getStartLineNumber(),
            confidence: 1.0
          });
          
          if (!files.includes(modulePath)) {
            files.push(modulePath);
          }

          // Add to queue for next hop
          if (!processedFiles.has(modulePath)) {
            queue.push({ path: modulePath, currentDepth: currentDepth + 1 });
          }
        }
      }

      // 3. Collect Calls (Symbol Edges) - Lightweight scan
      // Note: For a robust implementation, this duplicates some logic from Compressor,
      // but we need a baseline graph to feed INTO the compressor.
      // We can implement a simplified call finder here.
      this.extractSimpleCalls(sourceFile, symbolEdges, symbols);
    }

    return {
      symbols,
      symbolEdges,
      files: Array.from(new Set(files)),
      fileEdges
    };
  }

  private extractSymbols(sourceFile: SourceFile, symbols: SymbolDef[]) {
    const filePath = sourceFile.getFilePath();

    // Add Functions
    sourceFile.getFunctions().forEach(f => {
      const name = f.getName() || 'anonymous';
      symbols.push({
        id: this.getSymbolId(filePath, name),
        name: name,
        file: filePath,
        kind: 'function',
        startLine: f.getStartLineNumber(),
        endLine: f.getEndLineNumber(),
        exportName: f.isExported() ? name : undefined
      });
    });

    // Add Classes & Methods
    sourceFile.getClasses().forEach(c => {
      const className = c.getName() || 'AnonClass';
      symbols.push({
        id: this.getSymbolId(filePath, className),
        name: className,
        file: filePath,
        kind: 'class',
        startLine: c.getStartLineNumber(),
        endLine: c.getEndLineNumber(),
        exportName: c.isExported() ? className : undefined
      });

      c.getMethods().forEach(m => {
        const methodName = m.getName();
        symbols.push({
          id: this.getSymbolId(filePath, `${className}.${methodName}`),
          name: methodName,
          file: filePath,
          kind: 'method',
          startLine: m.getStartLineNumber(),
          endLine: m.getEndLineNumber(),
          receiverType: className
        });
      });
    });
  }

  private extractSimpleCalls(
    sourceFile: SourceFile,
    edges: SymbolCall[],
    knownSymbols: SymbolDef[]
  ) {
    const filePath = sourceFile.getFilePath();

    // Find all CallExpressions
    sourceFile.forEachDescendant(node => {
      if (node.getKind() === SyntaxKind.CallExpression) {
        // Determine Caller (Parent Method)
        const parentMethod = node.getFirstAncestorByKind(SyntaxKind.MethodDeclaration) ||
          node.getFirstAncestorByKind(SyntaxKind.FunctionDeclaration);

        if (parentMethod) {
          let callerName: string | undefined;
          
          if (parentMethod.getKind() === SyntaxKind.MethodDeclaration) {
            callerName = (parentMethod as MethodDeclaration).getName();
          } else if (parentMethod.getKind() === SyntaxKind.FunctionDeclaration) {
            callerName = (parentMethod as FunctionDeclaration).getName();
          }

          if (!callerName) {
            callerName = 'anon';
          }

          // Try to find the full symbol ID (including class context for methods)
          let callerId: string | undefined;
          const classParent = parentMethod.getFirstAncestorByKind(SyntaxKind.ClassDeclaration);
          if (classParent && parentMethod.getKind() === SyntaxKind.MethodDeclaration) {
            const className = (classParent as ClassDeclaration).getName() || 'AnonClass';
            callerId = this.getSymbolId(filePath, `${className}.${callerName}`);
          } else {
            callerId = this.getSymbolId(filePath, callerName);
          }

          // Determine Callee (Approximation based on text matching for speed)
          // The Compressor's 'unresolved' logic handles the rest
          const callText = node.getText().split('(')[0].trim();
          const cleanCallName = callText.split('.').pop() || callText;

          // Create an edge (potentially unresolved)
          edges.push({
            callerId,
            calleeId: cleanCallName, // Compressor resolves this later
            file: filePath,
            line: node.getStartLineNumber(),
            confidence: 0.5,
            via: 'unresolved'
          });
        }
      }
    });
  }

  private getSymbolId(file: string, name: string): string {
    return `symbol:${file}:${name}`;
  }

  /**
   * Builds a symbol-focused graph using the proven traverseCallsDeep + buildDirectedDebugGraph algorithm.
   * This method was moved from samuraiAgent.ts and adapted to accept filePath and focusSymbol directly.
   * 
   * @param filePath - The file containing the symbol
   * @param workspaceRoot - Workspace root path
   * @param maxHops - Maximum traversal depth (default: 3)
   * @param focusSymbol - Optional symbol name to focus on. If not provided, extracts exported symbols from file.
   * @param llmProvider - LLM provider for GraphCompressor initialization
   * @returns Graph with nodes and edges
   */
  async buildGraphFromEpicenter(
    filePath: string,
    workspaceRoot: string,
    maxHops: number = 3,
    focusSymbol?: string,
    llmProvider?: LLMProviderService
  ): Promise<{ nodes: GraphNode[]; edges: GraphEdge[] }> {
    try {
      if (!llmProvider) {
        throw new Error('LLMProviderService is required for buildGraphFromEpicenter');
      }

      const compressor = new GraphCompressor(llmProvider);
      
      // Build spine: if focusSymbol provided, use it; otherwise extract exported symbols
      let spine: Array<{ file: string; method: string }> = [];
      
      if (focusSymbol) {
        spine = [{ file: filePath, method: focusSymbol }];
      } else {
        // Extract exported symbols from the file
        const sourceFile = this.project.getSourceFile(filePath);
        if (!sourceFile) {
          try {
            this.project.addSourceFileAtPath(filePath);
            const addedFile = this.project.getSourceFile(filePath);
            if (addedFile) {
              const exportedSymbols = this.extractExportedSymbols(addedFile);
              if (exportedSymbols.length > 0) {
                spine = exportedSymbols.map(s => ({ file: filePath, method: s }));
                console.log(`[StaticGraphBuilder] Using ${exportedSymbols.length} exported symbols as spine: ${exportedSymbols.join(', ')}`);
              } else {
                // Fallback: use all functions and classes from the file
                const allSymbols = this.extractAllSymbols(addedFile);
                if (allSymbols.length > 0) {
                  spine = allSymbols.map(s => ({ file: filePath, method: s }));
                  console.log(`[StaticGraphBuilder] No exports found, using ${allSymbols.length} symbols from file: ${allSymbols.join(', ')}`);
                }
              }
            }
          } catch (error) {
            console.warn(`[StaticGraphBuilder] Failed to parse file ${filePath}:`, error);
          }
        } else {
          const exportedSymbols = this.extractExportedSymbols(sourceFile);
          if (exportedSymbols.length > 0) {
            spine = exportedSymbols.map(s => ({ file: filePath, method: s }));
          } else {
            const allSymbols = this.extractAllSymbols(sourceFile);
            spine = allSymbols.map(s => ({ file: filePath, method: s }));
          }
        }
      }
      
      if (spine.length === 0) {
        console.warn('[StaticGraphBuilder] No symbols found for spine, returning empty graph');
        return { nodes: [], edges: [] };
      }

      // Initialize ts-morph project
      const entryPaths = Array.from(new Set(spine.map(s => s.file)));
      compressor.getOrCreateTsMorphProject(workspaceRoot, entryPaths);

      // Build deep call graph using traverseCallsDeep with limited hops
      const deepCallGraph = compressor.traverseCallsDeep(spine, workspaceRoot, {
        maxHops,
        maxNodes: 50,
        maxFiles: 20
      });

      console.log(`[StaticGraphBuilder] Graph building returned ${deepCallGraph.size} methods`);

      // Convert deepCallGraph to edges format
      const edges: Array<{
        from: { file?: string; method: string };
        to: { file?: string; method: string };
        kind: "forward" | "backward" | "loop";
        depth: number;
        evidence: string[];
        line?: number;
        order?: number;
        label?: string;
      }> = [];

      for (const [callerKey, callees] of deepCallGraph.entries()) {
        const [callerFile, callerMethod] = callerKey.includes('::')
          ? callerKey.split('::')
          : [undefined, callerKey];

        for (const callee of callees) {
          edges.push({
            from: { file: callerFile, method: callerMethod || 'unknown' },
            to: { file: callee.file, method: callee.name },
            kind: "forward" as const,
            depth: callee.depth,
            evidence: callee.crossFile ? ["ast-forward", "cross-file"] : ["ast-forward"],
            line: callee.line,
            order: callee.order,
            label: callee.edgeLabel
          });
        }
      }

      // Build minimal context for buildDirectedDebugGraph
      const coarsePath = {
        files: Array.from(new Set(spine.map(s => s.file))).slice(0, 4),
        methods: spine.map(s => s.method).slice(0, 10)
      };

      const focus = {
        entrySymbols: spine.map(s => ({
          id: `symbol:${s.file}:${s.method}`,
          name: s.method,
          file: s.file
        })),
        errorFrames: [],
        userMentions: []
      };

      const emptyMethodGraph = {
        symbols: [],
        symbolEdges: [],
        files: [],
        fileEdges: []
      };

      const localContext = compressor.collectLocalContext(coarsePath, focus, emptyMethodGraph);

      // Build directed graph
      const compressedGraph = compressor.buildDirectedDebugGraph({
        spine,
        edges,
        ctx: localContext,
        workspaceRoot
      });

      // Convert to GraphNode[] and GraphEdge[]
      const nodes: GraphNode[] = compressedGraph.nodes.map(n => ({
        id: n.id,
        label: n.label || n.id,
        file: n.file || '',
        kind: (n.kind === 'symbol' ? 'symbol' : n.kind === 'file' ? 'file' : 'symbol') as 'file' | 'symbol' | 'route',
        line: n.line,
        badges: (n.badges || []) as ('error' | 'suspicious' | 'lowConfidence' | 'routeHandler')[],
        analysis: '',
        importance: 0
      }));

      const graphEdges: GraphEdge[] = compressedGraph.edges.map(e => {
        let edgeKind: GraphEdge['kind'] = 'calls';
        if (e.kind === 'imports') edgeKind = 'imports';
        else if (e.kind === 'calls') edgeKind = 'calls';

        return {
          from: e.from,
          to: e.to,
          kind: edgeKind,
          confidence: e.confidence,
          evidence: e.evidence,
          label: e.label
        };
      });

      return { nodes, edges: graphEdges };
    } catch (error) {
      console.error('[StaticGraphBuilder] Error building graph from epicenter:', error);
      return { nodes: [], edges: [] };
    }
  }

  /**
   * Extract exported symbol names from a source file
   */
  private extractExportedSymbols(sourceFile: SourceFile): string[] {
    const symbols: string[] = [];
    const filePath = sourceFile.getFilePath();

    // Extract exported functions
    sourceFile.getFunctions().forEach(f => {
      if (f.isExported()) {
        const name = f.getName();
        if (name) {
          symbols.push(name);
        }
      }
    });

    // Extract exported classes
    sourceFile.getClasses().forEach(c => {
      if (c.isExported()) {
        const name = c.getName();
        if (name) {
          symbols.push(name);
        }
      }
    });

    return symbols;
  }

  /**
   * Extract all function and class names from a source file (not just exported)
   */
  private extractAllSymbols(sourceFile: SourceFile): string[] {
    const symbols: string[] = [];

    // Extract all functions
    sourceFile.getFunctions().forEach(f => {
      const name = f.getName();
      if (name && name !== 'anonymous') {
        symbols.push(name);
      }
    });

    // Extract all classes
    sourceFile.getClasses().forEach(c => {
      const name = c.getName();
      if (name) {
        symbols.push(name);
      }
    });

    return symbols;
  }
}



