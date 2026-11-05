/**
 * ToolExecutionService - "The Hands"
 *
 * Safely executes tool calls in parallel and handles errors gracefully.
 * Ensures the Agent never crashes even if a tool fails.
 */

import { ToolRegistry } from '../tools/ToolRegistry';
import { ToolResult } from '../tools/definitions/ITool';
import { StreamReporter } from '../utils/StreamReporter';
import { DebugSessionLogger } from '../utils/DebugSessionLogger';
import { RuntimeDebugTool } from '../tools/engine/RuntimeDebugTool';
import {
  LedgerState,
  normalizeQuery,
  isSearchDuplicate,
  isFileAlreadyOpened,
  addSearchRecord,
  addStaticAnalysisRecord
} from '../ledger/searchFileLedger';

export interface ToolExecutionResult {
  tool_call_id: string;
  role: 'tool';
  name: string;
  content: string;
  /**
   * Raw tool result including structuredData and evidence.
   * Optional so existing callers that only care about content remain unaffected.
   */
  rawResult?: ToolResult<any>;
  /**
   * Best-effort primary file path associated with this tool call (if any).
   * For graph-context this will be the filePath argument the tool was invoked with.
   */
  primaryFilePath?: string;
  /**
   * Cost incurred by tool execution.
   * Optional so existing callers remain unaffected.
   */
  cost?: number;
}

export class ToolExecutionService {
  constructor(private registry: ToolRegistry) {}

  /**
   * Executes a batch of tool calls in parallel.
   * Guaranteed to return a result for every call (no throwing).
   * @param toolCalls - Array of tool calls to execute
   * @param reporter - Optional StreamReporter for real-time log streaming
   * @param logger - Optional DebugSessionLogger for saving intermediate results
   * @param ledgerState - Optional ledger state for duplicate detection
   */
  async executeToolCalls(
    toolCalls: any[],
    reporter?: StreamReporter,
    logger?: DebugSessionLogger,
    ledgerState?: LedgerState
  ): Promise<ToolExecutionResult[]> {
    if (!toolCalls || toolCalls.length === 0) {
      return [];
    }

    console.log(`[ToolExecutor] Executing ${toolCalls.length} tools in parallel...`);

    // Inject reporter and logger into tools if available
    for (const call of toolCalls) {
      const tool = this.registry.getTool(call.function.name);
      if (tool) {
        // 1. Inject Reporter (Existing)
        if (reporter && 'setReporter' in tool && typeof (tool as any).setReporter === 'function') {
          (tool as any).setReporter(reporter);
        }

        // 2. Inject Logger (New Safety Check)
        if (logger && 'setLogger' in tool && typeof (tool as any).setLogger === 'function') {
          (tool as any).setLogger(logger);
        } else if (call.function.name === 'runtime-debug') {
          console.warn('[ToolExecutor] Runtime-debug call received without logger. Using tool-level fallback logger.');
        }
      }
    }

    // Run all tools simultaneously
    const results = await Promise.all(
      toolCalls.map(async (call) => {
        return this.executeSingleTool(call, reporter, logger, ledgerState);
      })
    );

    return results;
  }

  /**
   * Format a human-readable shell-like command string for terminal display.
   */
  private formatCommand(toolName: string, args: any): string {
    const safeArg = (value: unknown) => {
      if (value === undefined || value === null) return '';
      if (typeof value === 'string') return value;
      if (Array.isArray(value)) return value.join(',');
      if (typeof value === 'object') {
        try {
          return JSON.stringify(value);
        } catch {
          return String(value);
        }
      }
      return String(value);
    };

    if (toolName === 'node-process') {
      if (args?.action === 'debug') {
        const target = args?.path || args?.scriptPath || '';
        const debugPort = args?.debugPort;
        const breakpointCount = Array.isArray(args?.breakpoints)
          ? args.breakpoints.length
          : undefined;
        const watchCount = Array.isArray(args?.watch_variables)
          ? args.watch_variables.length
          : undefined;
        const timeout = typeof args?.timeout === 'number' ? args.timeout : undefined;

        const flags: string[] = [];
        if (debugPort) flags.push(`--port ${debugPort}`);
        if (breakpointCount) flags.push(`--breakpoints ${breakpointCount}`);
        if (watchCount) flags.push(`--watch ${watchCount}`);
        if (timeout) flags.push(`--timeout ${timeout}ms`);

        const base = target ? `$ node-process debug ${target}` : `$ node-process debug`;
        return flags.length > 0 ? `${base} ${flags.join(' ')}` : base;
      }
      if (args?.action === 'kill' && args?.pid) {
        return `$ node-process kill ${args.pid}`;
      }
      if (args?.action === 'kill_all') {
        return `$ node-process kill_all`;
      }
    }

    if (toolName === 'sandbox-fs') {
      const action = args?.action || '<action>';
      const target = args?.filename || args?.path || '';
      return target ? `$ sandbox-fs ${action} ${target}` : `$ sandbox-fs ${action}`;
    }

    if (toolName === 'runtime-debug' || toolName === 'runtime-analysis') {
      return `$ ${toolName} ${safeArg(args?.targets) || ''}`.trim();
    }

    if (toolName === 'code-search') {
      const query = args?.query ? `"${safeArg(args.query)}"` : '';
      const flags: string[] = [];
      if (args?.mode) flags.push(`--mode ${args.mode}`);
      if (args?.pattern) flags.push(`--pattern "${safeArg(args.pattern)}"`);
      const parts = [`$ ${toolName}`, query, ...flags].filter(Boolean);
      return parts.join(' ').trim();
    }

    // Fallback generic formatting
    const keyArgs: string[] = [];
    if (args?.filePath) keyArgs.push(args.filePath);
    else if (args?.path) keyArgs.push(args.path);
    else if (args?.target) keyArgs.push(safeArg(args.target));
    else if (args?.targets) keyArgs.push(safeArg(args.targets));
    return keyArgs.length > 0
      ? `$ ${toolName} ${keyArgs.join(' ')}`
      : `$ ${toolName}`;
  }

  private async executeSingleTool(
    call: any,
    reporter?: StreamReporter,
    logger?: DebugSessionLogger,
    ledgerState?: LedgerState
  ): Promise<ToolExecutionResult> {
    const toolName = call.function.name;
    const callId = call.id;

    try {
      // 1. Validate Tool Exists
      const tool = this.registry.getTool(toolName);
      if (!tool) {
        console.warn(`[ToolExecutor] Tool not found: ${toolName}`);
        return {
          tool_call_id: callId,
          role: 'tool',
          name: toolName,
          content: JSON.stringify({ error: `Tool '${toolName}' does not exist.` })
        };
      }

      // 2. Parse Arguments Safely
      let args: any;
      let primaryFilePath: string | undefined;
      try {
        args = JSON.parse(call.function.arguments);

        // Best-effort extraction of primary file path for downstream consumers
        if (typeof args?.filePath === 'string') {
          primaryFilePath = args.filePath;
        } else if (typeof args?.path === 'string') {
          primaryFilePath = args.path;
        }
      } catch (e) {
        return {
          tool_call_id: callId,
          role: 'tool',
          name: toolName,
          content: JSON.stringify({ error: "Invalid JSON arguments." })
        };
      }

      // 2.5. Check for duplicates in ledger (before execution)
      if (ledgerState) {
        // Handle code-search duplicate detection
        if (toolName === 'code-search') {
          const force = args.force === true;
          if (!force) {
            const queryNorm = normalizeQuery(args.query || '');
            const duplicateCheck = isSearchDuplicate(
              ledgerState,
              queryNorm,
              args.mode || 'text',
              args.pattern
            );

            if (duplicateCheck.isDuplicate && duplicateCheck.previousRecord) {
              console.log(`[ToolExecutor] Skipping duplicate code-search: ${queryNorm}`);
              return {
                tool_call_id: callId,
                role: 'tool',
                name: toolName,
                content: JSON.stringify({
                  skipped: true,
                  reason: 'DUPLICATE_SEARCH',
                  queryNorm: queryNorm,
                  suggestion: 'Use static-analysis on known candidate files from previous search.',
                  previousHits: duplicateCheck.previousRecord.resultCount || 0,
                  previousTopFiles: duplicateCheck.previousRecord.topFiles || []
                })
              };
            }
          }
        }

        // Handle static-analysis duplicate detection
        if (toolName === 'static-analysis') {
          const force = args.force === true;
          if (!force) {
            const duplicateCheck = isFileAlreadyOpened(
              ledgerState,
              args.filePath || '',
              args.mode,
              args.target
            );

            if (duplicateCheck.isDuplicate) {
              console.log(`[ToolExecutor] Skipping duplicate static-analysis: ${args.filePath}`);
              return {
                tool_call_id: callId,
                role: 'tool',
                name: toolName,
                content: JSON.stringify({
                  skipped: true,
                  reason: 'DUPLICATE_FILE_ANALYSIS',
                  filePath: args.filePath,
                  mode: args.mode,
                  suggestion: 'This file was already analyzed. Use previous results or specify a new target/line.'
                })
              };
            }
          }
        }
      }

      // 3. Emit shell-style command preview
      if (reporter) {
        try {
          const cmdDisplay = this.formatCommand(toolName, args);
          reporter.sendLogUpdate(cmdDisplay, 'stdout');
          if (args && typeof args === 'object') {
            (args as any).__shellLogged = true;
          }
        } catch (e) {
          console.warn(`[ToolExecutor] Failed to format command for ${toolName}:`, e);
        }
      }

      // 4. Execute Tool
      const result: ToolResult<any> = await tool.execute(args);

      // 4.5. Update ledger after execution
      if (ledgerState) {
        if (toolName === 'code-search' && result.success) {
          const queryNorm = normalizeQuery(args.query || '');
          let resultCount: number | undefined;
          let topFiles: string[] = [];

          // Extract result count and top files from result
          if (result.evidence && Array.isArray(result.evidence)) {
            resultCount = result.evidence.length;
            // Extract file paths from evidence (max 3)
            for (const item of result.evidence) {
              if (item.file && typeof item.file === 'string' && topFiles.length < 3) {
                if (!topFiles.includes(item.file)) {
                  topFiles.push(item.file);
                }
              }
            }
          } else if (result.structuredData && Array.isArray(result.structuredData)) {
            resultCount = result.structuredData.length;
            for (const item of result.structuredData) {
              if (item.file && typeof item.file === 'string' && topFiles.length < 3) {
                if (!topFiles.includes(item.file)) {
                  topFiles.push(item.file);
                }
              }
            }
          }

          // Update ledger (immutable update - caller should reassign)
          const updatedState = addSearchRecord(ledgerState, {
            queryRaw: args.query || '',
            queryNorm: queryNorm,
            mode: args.mode || 'text',
            pattern: args.pattern,
            resultCount: resultCount,
            topFiles: topFiles.length > 0 ? topFiles : undefined
          });

          // Update the ledger state reference (caller will handle persistence)
          Object.assign(ledgerState, updatedState);
        }

        if (toolName === 'static-analysis' && result.success) {
          // Extract summary (1 sentence, max 100 chars, non-code metadata only)
          let summary: string | undefined;
          if (result.summary && typeof result.summary === 'string') {
            // Check if summary looks like code (crude heuristic)
            const codeIndicators = ['{', '}', ';', '=>', 'function', 'const ', 'let ', 'var '];
            const hasCodeIndicators = codeIndicators.some(indicator => 
              result.summary.toLowerCase().includes(indicator.toLowerCase())
            );
            
            if (!hasCodeIndicators && result.summary.length <= 100) {
              // Take first sentence
              const firstSentence = result.summary.split(/[.!?]/)[0].trim();
              if (firstSentence.length <= 100) {
                summary = firstSentence;
              } else {
                summary = result.summary.substring(0, 97) + '...';
              }
            }
          }

          // Update ledger (immutable update - caller should reassign)
          const updatedState = addStaticAnalysisRecord(ledgerState, {
            filePath: args.filePath || '',
            mode: args.mode || 'source',
            target: args.target,
            summary: summary
          });

          // Update the ledger state reference (caller will handle persistence)
          Object.assign(ledgerState, updatedState);
        }
      }

      // 5. Format Output for LLM
      // Strategy: Prefer 'evidence' (rich data) if available, otherwise 'summary'.
      // We stringify the output so the LLM can read it.
      let content = "";

      if (!result.success) {
        content = JSON.stringify({ error: result.summary });
      } else if (result.evidence && result.evidence.length > 0) {
        // Return the structured evidence (e.g., file contents, diffs, graph JSON)
        content = JSON.stringify(result.evidence);
      } else {
        content = result.summary;
      }

      return {
        tool_call_id: callId,
        role: 'tool',
        name: toolName,
        content: content,
        rawResult: result,
        primaryFilePath,
        cost: result.cost
      };

    } catch (error: any) {
      console.error(`[ToolExecutor] Crash in ${toolName}:`, error);
      return {
        tool_call_id: callId,
        role: 'tool',
        name: toolName,
        content: JSON.stringify({ error: `Tool execution internal error: ${error.message}` })
      };
    }
  }
}
