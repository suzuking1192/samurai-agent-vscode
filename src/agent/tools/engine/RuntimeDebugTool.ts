/**
 * RuntimeDebugTool - "The API Gateway"
 * 
 * Autonomous runtime debugger for backend Node.js/TypeScript code.
 * Writes reproduction scripts, runs them, and captures variable states at specific lines.
 * Delegates all orchestration to RuntimeAnalysisAgent.
 */

import { ITool, ToolResult } from '../definitions/ITool';
import { RuntimeDebugSchema, RuntimeDebugParams } from '../definitions/ToolSchemas';
import { RuntimeAnalysisAgent } from '../../core/RuntimeAnalysisAgent';
import { ToolRegistry } from '../ToolRegistry';
import { LLMProviderService } from '../../llm/llmProviderService';
import { StreamReporter } from '../../utils/StreamReporter';
import { DebugSessionLogger } from '../../utils/DebugSessionLogger';
import * as vscode from 'vscode';

export class RuntimeDebugTool implements ITool<RuntimeDebugParams> {
  name = "runtime-debug";
  description = "Autonomous runtime debugger for backend code. Writes a reproduction script, runs it, and captures variable states at specific lines.";
  inputSchema = RuntimeDebugSchema;

  private agent: RuntimeAnalysisAgent;
  private model?: string; // Model name from user selection (e.g., from Session)
  private logger?: DebugSessionLogger;

  constructor(
    llmProvider: LLMProviderService,
    registry: ToolRegistry
  ) {
    const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || '';
    this.agent = new RuntimeAnalysisAgent(registry, llmProvider, workspaceRoot);
  }

  /**
   * Set the model name to use for runtime analysis.
   * This should be called by PlanningAgent to match the user's selected model.
   */
  setModel(model: string): void {
    this.model = model;
  }

  /**
   * Set the StreamReporter for real-time log streaming.
   * This allows dependency injection at execution time.
   */
  setReporter(reporter: StreamReporter): void {
    this.agent.setReporter(reporter);
  }

  /**
   * Set the DebugSessionLogger for saving intermediate results.
   * This allows dependency injection at execution time.
   */
  setLogger(logger: DebugSessionLogger): void {
    this.logger = logger;
    this.agent.setLogger(logger);
  }

  async execute(params: RuntimeDebugParams): Promise<ToolResult> {
    try {
      // FAIL-SAFE INJECTION: ensure the agent uses the latest logger for this execution
      if (this.logger) {
        this.agent.setLogger(this.logger);
      }

      const normalizedTargets = this.normalizeTargets(params.targets);

      if (normalizedTargets.length === 0) {
        return {
          success: false,
          summary: "Targets array is required. Provide at least one file/line/expression to capture."
        };
      }

      console.log(`[RuntimeDebugTool] Delegating analysis of ${params.targets.length} target(s) to RuntimeAnalysisAgent...`);

      // Delegate to agent for each target
      // The agent will intelligently group targets that share the same execution context
      const results = await Promise.all(
        normalizedTargets.map(target =>
          this.agent.analyze(
            target.file,
            target.line,
            target.expression,
            params.description,
            this.model // Pass the model name if set, otherwise will default to 'gpt-4o' in agent
          )
        )
      );

      // Format results for multiple targets
      const targetResults = normalizedTargets.map((target, i) => ({
        variable: target.expression,
        value: results[i].value,
        type: results[i].type,
        file: target.file,
        line: target.line
      }));

      // Combine all logs
      const allLogs = results.flatMap(r => r.logs || []);
      
      // Combine all insights
      const allInsights = results.flatMap(r => r.insights || []);
      
      // Check if root cause was found
      const rootCauseFound = results.some(r => r.rootCauseFound === true);
      
      // Sum total costs from all runtime analysis results
      const totalToolCost = results.reduce((sum, r) => sum + (r.totalCost || 0), 0);
      
      // Build summary
      let summary = `Runtime analysis successful. Captured ${results.length} variable(s).`;
      if (rootCauseFound) {
        summary += ' Root cause identified.';
      } else if (allInsights.length > 0) {
        summary += ` Gathered ${allInsights.length} insight(s).`;
      }

      // Build evidence with insights
      const evidence = normalizedTargets.map((target, i) => {
        const result = results[i];
        let text = `${target.expression}: ${JSON.stringify(result.value, null, 2)}\nType: ${result.type}`;
        if (result.insights && result.insights.length > 0) {
          text += `\n\nInsights:\n${result.insights.map((insight: string, idx: number) => `${idx + 1}. ${insight}`).join('\n')}`;
        }
        if (result.hypothesis) {
          text += `\n\nHypothesis: ${result.hypothesis}`;
        }
        return {
          file: target.file,
          line: target.line,
          text: text,
          description: result.rootCauseFound ? "Runtime State Capture - Root Cause Found" : "Runtime State Capture"
        };
      });

      return {
        success: true,
        summary: summary,
        structuredData: {
          targets: targetResults,
          logs: allLogs,
          insights: allInsights.length > 0 ? allInsights : undefined,
          rootCauseFound: rootCauseFound
        },
        evidence: evidence,
        cost: totalToolCost
      };
    } catch (error: any) {
      return {
        success: false,
        summary: `Runtime analysis failed: ${error.message}. The agent could not reproduce the state or encountered an error.`
      };
    }
  }

  /**
   * Normalize runtime-debug targets to accept legacy aliases from LLM output.
   */
  private normalizeTargets(targets: RuntimeDebugParams['targets'] | any[]): Array<{ file: string; line: number; expression: string }> {
    if (!Array.isArray(targets)) {
      return [];
    }

    return targets
      .map(target => {
        const file = target?.file ?? target?.filePath ?? target?.path;
        const line = target?.line ?? target?.lineNumber ?? target?.startLine;
        const expression = target?.expression ?? target?.variable ?? target?.name;

        if (typeof file !== 'string' || typeof line !== 'number' || !expression) {
          return null;
        }

        return { file, line, expression };
      })
      .filter((t): t is { file: string; line: number; expression: string } => t !== null);
  }
}
