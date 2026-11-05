/**
 * Tool Registry - Entry point for tool registration and discovery
 * 
 * Manages tool instances and provides access to available tools.
 */

import { ITool } from './definitions/ITool';
import { GitHistoryTool } from './engine/GitHistoryTool';
import { LspDiagnosticsTool } from './engine/LspDiagnosticsTool';
import { CodeSearchTool } from './engine/CodeSearchTool';
import { GraphContextTool } from './engine/GraphContextTool';
import { StaticAnalysisTool } from './engine/StaticAnalysisTool';
import { RuntimeDebugTool } from './engine/RuntimeDebugTool';
import { SandboxFileSystemTool } from './engine/SandboxFileSystemTool';
import { NodeProcessTool } from './engine/NodeProcessTool';
import { RuntimeInspectorTool } from './engine/RuntimeInspectorTool';
import { GitDiffTool } from './engine/GitDiffTool';
import { LLMProviderService } from '../llm/llmProviderService';
import { zodToJsonSchema } from 'zod-to-json-schema';

/**
 * Registry for managing and accessing tools
 */
export class ToolRegistry {
  private tools: Map<string, ITool> = new Map();

  constructor(llmProvider?: LLMProviderService) {
    // Register atomic tools first
    this.register(new SandboxFileSystemTool());
    this.register(new NodeProcessTool());
    this.register(new RuntimeInspectorTool());

    // Register existing tools
    this.register(new GitDiffTool());
    this.register(new GitHistoryTool());
    this.register(new LspDiagnosticsTool());
    this.register(new CodeSearchTool());
    this.register(new StaticAnalysisTool());
    
    // Register tools that require LLM provider and registry
    if (llmProvider) {
      this.register(new GraphContextTool(llmProvider));
      // RuntimeDebugTool requires both llmProvider and registry (this)
      this.register(new RuntimeDebugTool(llmProvider, this));
    }
  }

  /**
   * Register a tool in the registry
   * 
   * @param tool - The tool instance to register
   */
  private register(tool: ITool): void {
    this.tools.set(tool.name, tool);
  }

  /**
   * Returns the tool by name (Used when the LLM says "Call git-history")
   * 
   * @param name - The name of the tool
   * @returns The tool instance or undefined if not found
   */
  getTool(name: string): ITool | undefined {
    return this.tools.get(name);
  }

  /**
   * Get a tool by name (backward compatibility)
   * 
   * @param name - The name of the tool
   * @returns The tool instance or undefined if not found
   */
  get(name: string): ITool | undefined {
    return this.tools.get(name);
  }

  /**
   * Returns the "System Prompt" definitions (The Menu)
   * This is what you feed to the LLM context.
   * 
   * @returns Array of tool definitions with name, description, and parameters
   */
  getToolDefinitions() {
    return Array.from(this.tools.values()).map(tool => ({
      name: tool.name,
      description: tool.description,
      parameters: zodToJsonSchema(tool.inputSchema) // Converts Zod -> JSON Schema
    }));
  }

  /**
   * Get all registered tools
   * 
   * @returns Array of all registered tool instances
   */
  getAll(): ITool[] {
    return Array.from(this.tools.values());
  }

  /**
   * Check if a tool is registered
   * 
   * @param name - The name of the tool
   * @returns True if the tool is registered, false otherwise
   */
  has(name: string): boolean {
    return this.tools.has(name);
  }

  /**
   * Get tools for the High-Level Planner (PlanningAgent)
   * 
   * @returns Array of tools available to PlanningAgent
   */
  getPlanningTools(): ITool[] {
    return [
      this.getTool('code-search'),
      this.getTool('graph-context'),
      this.getTool('git-history'),
      this.getTool('static-analysis'),
      this.getTool('lsp-diagnostics'),
      this.getTool('runtime-debug'), // High-level autonomous runtime analysis
      this.getTool('git-diff')
    ].filter((t): t is ITool => t !== undefined);
  }

  /**
   * Get tools for the Low-Level Runtime Agent (RuntimeAnalysisAgent)
   * 
   * @returns Array of tools available to RuntimeAnalysisAgent
   */
  getRuntimeTools(): ITool[] {
    return [
      this.getTool('static-analysis'),      // To read the user's code context
      this.getTool('code-search'),          // For finding definitions if imports break
      this.getTool('sandbox-fs'),           // To write the repro script
      this.getTool('node-process')          // To run the script
    ].filter((t): t is ITool => t !== undefined);
  }
}

