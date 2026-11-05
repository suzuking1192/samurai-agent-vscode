/**
 * GraphContextTool - "Map it."
 * 
 * Builds a visualizable dependency and execution graph around a specific "Epicenter" (File or Symbol).
 * Uses StaticGraphBuilder to create raw graph, then GraphCompressor to optimize it.
 */

import { z } from 'zod';
import { Project } from 'ts-morph';
import * as path from 'path';
import * as fs from 'fs';
import * as ts from 'typescript';
import * as vscode from 'vscode';
import { ITool, ToolResult } from '../definitions/ITool';
import { GraphContextToolSchema, GraphContextParams } from '../definitions/ToolSchemas';
import { StaticGraphBuilder } from '../utils/StaticGraphBuilder';
import { VisualizationService, ExecutionGraph } from '../debugging/VisualizationService';
import { LLMProviderService } from '../../llm/llmProviderService';

export class GraphContextTool implements ITool<GraphContextParams> {
  readonly name = 'graph-context';
  readonly description = 'Builds a visualized dependency graph around a specific file or symbol to understand context.';
  // @ts-expect-error - ZodEffects from transform has different input type, but output type matches GraphContextParams
  readonly inputSchema: z.ZodType<GraphContextParams> = GraphContextToolSchema;

  private project: Project;
  private llmProvider: LLMProviderService;
  private vizService: VisualizationService;

  constructor(llmProvider: LLMProviderService) {
    this.llmProvider = llmProvider;
    this.vizService = new VisualizationService(llmProvider);
    // Initialize shared ts-morph project
    this.project = new Project({
      useInMemoryFileSystem: false,
      skipAddingFilesFromTsConfig: true,
      compilerOptions: {
        allowJs: true,
        checkJs: false,
        skipLibCheck: true,
        noResolve: false, // We need resolution for imports
        target: ts.ScriptTarget.ES2020,
        module: ts.ModuleKind.ESNext,
        moduleResolution: ts.ModuleResolutionKind.NodeNext,
        jsx: ts.JsxEmit.ReactJSX,
      },
    });
  }

  /**
   * Find tsconfig.json path in workspace
   */
  private findTsConfigPath(workspaceRoot: string): string | undefined {
    const candidates = [
      path.join(workspaceRoot, 'tsconfig.json'),
      path.join(workspaceRoot, 'jsconfig.json'),
    ];

    for (const candidate of candidates) {
      try {
        if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) {
          return candidate;
        }
      } catch {
        // Continue searching
      }
    }

    // Try parent directories (up to 3 levels)
    let current = workspaceRoot;
    for (let i = 0; i < 3; i++) {
      const parent = path.dirname(current);
      if (parent === current) break;
      current = parent;

      for (const candidate of candidates.map(c => path.join(current, path.basename(c)))) {
        try {
          if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) {
            return candidate;
          }
        } catch {
          // Continue searching
        }
      }
    }

    return undefined;
  }

  /**
   * Initialize or update ts-morph Project with workspace configuration
   */
  private initializeProject(workspaceRoot: string): void {
    const tsConfigPath = this.findTsConfigPath(workspaceRoot);
    const hasTsConfig = !!tsConfigPath;

    // Reinitialize project with proper config
    this.project = new Project({
      tsConfigFilePath: tsConfigPath ?? undefined,
      skipAddingFilesFromTsConfig: !hasTsConfig,
      compilerOptions: {
        allowJs: true,
        checkJs: false,
        skipLibCheck: true,
        noResolve: false, // We need resolution for imports
        target: ts.ScriptTarget.ES2020,
        module: ts.ModuleKind.ESNext,
        moduleResolution: ts.ModuleResolutionKind.NodeNext,
        jsx: ts.JsxEmit.ReactJSX,
      },
    });
  }

  async execute(params: GraphContextParams): Promise<ToolResult> {
    const { filePath, depth = 1, focusSymbol, visualizationMode = 'hard-error' } = params;

    // 1. Resolve Workspace Path
    const workspaceFolders = vscode.workspace.workspaceFolders;
    if (!workspaceFolders) {
      return {
        success: false,
        summary: 'No workspace open.',
        evidence: []
      };
    }

    const rootPath = workspaceFolders[0].uri.fsPath;
    const absPath = path.resolve(rootPath, filePath);

    // Verify file exists
    if (!fs.existsSync(absPath)) {
      return {
        success: false,
        summary: `File not found: ${filePath}`,
        evidence: []
      };
    }

    try {
      // 2. Initialize Project with workspace config
      this.initializeProject(rootPath);

      // 3. Build Graph using the proven buildGraphFromEpicenter method
      const builder = new StaticGraphBuilder(this.project);
      const { nodes, edges } = await builder.buildGraphFromEpicenter(
        absPath,
        rootPath,
        depth || 4,
        focusSymbol,  // Pass focusSymbol directly
        this.llmProvider
      );

      if (nodes.length === 0) {
        return {
          success: false,
          summary: `No graph nodes generated for ${filePath}. Is it a valid TS/JS file?`,
          evidence: []
        };
      }

      // 4. Convert to ExecutionGraph format
      const executionGraph: ExecutionGraph = {
        nodes,
        edges
      };

      const vizResult = await this.vizService.generateVisualization(
        executionGraph,
        undefined, // No RootCauseReport yet
        visualizationMode,
        "auto",
        rootPath
      );

      // 6. Format Dual Output
      // View A: The "Agent Graph" (Slim JSON for LLM Context)
      // We strip out visual noise (colors, shapes) and keep logic (files, edges, badges)
      // Use executionGraph so agent's mental model matches what the user sees in the diagram
      const agentGraph = {
        nodes: executionGraph.nodes.map(n => ({
          id: n.id,
          file: n.file, // Critical: Agent needs file path to navigate
          badges: n.badges, // Critical: Agent needs to know if node is 'error' or 'spine'
        })),
        edges: executionGraph.edges.map(e => ({
          from: e.from,
          to: e.to,
        })),
      };

      const nodeCount = executionGraph.nodes.length;

      return {
        success: true,
        summary: `Graph generated around ${path.basename(filePath)} (${nodeCount} nodes). Visualization updated.`,
        
        // Structured Data: Consumed by your Frontend / Extension UI
        // Use normalized nodes from vizResult to ensure node IDs match what's rendered in the Mermaid diagram
        structuredData: {
          mermaid: vizResult.mermaid, // <--- UI renders this diagram
          nodes: vizResult.normalizedNodes || executionGraph.nodes, // Use normalized nodes with IDs matching Mermaid diagram
          edges: executionGraph.edges, // Use the refined edges for consistency
          isValid: vizResult.isValid,
          nodeLocationMap: vizResult.nodeLocationMap, // Include pre-built map with normalized IDs matching Mermaid diagram
        },

        // Evidence: Consumed by the LLM (Agent)
        evidence: [{
          file: "graph-analysis.json",
          line: 0,
          text: JSON.stringify(agentGraph, null, 2), // <--- Agent reads this map
        }],
      };
    } catch (error: any) {
      return {
        success: false,
        summary: `Graph generation failed: ${error.message}`,
        evidence: [],
      };
    }
  }
}


