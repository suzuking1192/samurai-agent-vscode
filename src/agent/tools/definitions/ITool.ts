/**
 * Base interface for all tools in Samurai Agent v2
 * 
 * Defines the contract that all tool implementations must follow.
 * Uses Zod schemas for runtime validation and MCP-style tool definitions.
 */

import { z } from 'zod';

/**
 * Standard output for ANY tool.
 * The 'structuredData' field allows your Heuristic Engine (Code) to use the tool
 * differently than the LLM (Text).
 */
export interface ToolResult<T = any> {
  success: boolean;
  summary: string;       // Human/LLM readable: "Found 3 nested loops."
  structuredData?: T;    // Machine readable: { complexity: 15, loops: [4, 10] }
  evidence?: {           // For the UI to highlight code
    file: string;
    line: number;
    text: string;
    description?: string; // Optional description of the evidence
  }[];
  cost?: number;         // Optional cost incurred by tool execution
}

/**
 * Base interface for all tools
 */
export interface ITool<TInput = any> {
  name: string;          // Unique ID: "static-analysis"
  description: string;   // Prompt instructions: "Analyzes code structure..."
  inputSchema: z.ZodType<TInput>; // Runtime validation
  
  // The Main Method
  execute(params: TInput): Promise<ToolResult>;
  
  // Optional cleanup method for tools that manage resources (processes, connections, etc.)
  cleanup?(): void;
}

