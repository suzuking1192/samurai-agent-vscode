/**
 * RuntimeAnalysisAgent - "The Scientist"
 *
 * Specialized sub-agent for autonomous runtime analysis of backend Node.js/TypeScript code.
 * Creates reproduction scripts, runs them, and captures runtime values.
 */

import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { ToolRegistry } from "../tools/ToolRegistry";
import { LLMProviderService } from "../llm/llmProviderService";
import { ToolExecutionService } from "../services/ToolExecutionService";
import { loadDebuggingPrompt } from "../tools/debugging/promptLoader";
import { LLMResponse, LLMError } from "../../common/models/llm-models";
import { ResponseType } from "../../common/models/response-models";
import { isRetryableFromErrorString } from "../utils/errorSanitizer";
import { zodToJsonSchema } from "zod-to-json-schema";
import { StreamReporter } from "../utils/StreamReporter";
import { DebugSessionLogger } from "../utils/DebugSessionLogger";
import { ConsoleFallbackLogger } from "../utils/ConsoleFallbackLogger";
import { NodeProcessTool } from "../tools/engine/NodeProcessTool";
import { ThoughtStep } from "./InvestigationState";

export interface RuntimeAnalysisResult {
  value: any;
  type: string;
  logs: string[];
  insights?: string[];
  hypothesis?: string;
  rootCauseFound?: boolean;
  totalCost?: number;
}

export class RuntimeAnalysisAgent {
  private toolExecutor: ToolExecutionService;
  private reporter?: StreamReporter;
  private logger: DebugSessionLogger;
  private sessionId?: string;

  // Configurable timeout (default 10 minutes, override via env for testing)
  private static readonly DEFAULT_MAX_EXECUTION_TIME_MS = 10 * 60 * 1000; // 10 minutes
  private getMaxExecutionTime(): number {
    const envOverride = process.env.SAMURAI_RUNTIME_ANALYSIS_TIMEOUT_MS;
    return envOverride ? parseInt(envOverride, 10) : RuntimeAnalysisAgent.DEFAULT_MAX_EXECUTION_TIME_MS;
  }

  constructor(
    private registry: ToolRegistry,
    private llm: LLMProviderService,
    private workspaceRoot: string,
  ) {
    this.toolExecutor = new ToolExecutionService(registry);
    this.logger = new ConsoleFallbackLogger();
  }

  /**
   * Set the StreamReporter for real-time log streaming
   * @param reporter - StreamReporter instance (optional)
   */
  setReporter(reporter?: StreamReporter): void {
    this.reporter = reporter;
  }

  /**
   * Set the DebugSessionLogger for saving intermediate results
   * @param logger - DebugSessionLogger instance (optional)
   */
  setLogger(logger?: DebugSessionLogger): void {
    this.logger = logger || new ConsoleFallbackLogger();
    // Extract sessionId if available
    if (logger) {
      this.sessionId = logger.getSessionId();
    } else {
      this.sessionId = undefined;
    }
  }

  /**
   * Analyze a variable or expression at a specific location in backend code.
   * Wrapped with Promise.race() to enforce timeout even when stuck on async operations
   *
   * @param targetFile - Relative path to the file
   * @param targetLine - Line number (1-based)
   * @param expression - Variable name or expression to capture
   * @param description - Optional high-level description of what to test
   * @param model - Optional model name to use (defaults to 'gpt-4o' if not provided)
   * @returns Captured runtime value, type, and logs
   */
  async analyze(
    targetFile: string,
    targetLine: number,
    expression: string,
    description?: string,
    model?: string,
  ): Promise<RuntimeAnalysisResult> {
    const startTime = Date.now();
    const maxExecutionTime = this.getMaxExecutionTime();

    // Create timeout promise
    const timeoutPromise = new Promise<RuntimeAnalysisResult>((_, reject) => {
      setTimeout(() => {
        reject(new Error(`RuntimeAnalysisAgent execution timed out after ${maxExecutionTime}ms (${maxExecutionTime / 60000} minutes)`));
      }, maxExecutionTime);
    });

    // Wrap the actual execution (preserve finally block)
    const executionPromise = this.analyzeInternal(
      [{ file: targetFile, line: targetLine, expression }],
      description,
      model
    ).then(results => results[0]); // Extract first result from array

    // Race between execution and timeout
    try {
      return await Promise.race([executionPromise, timeoutPromise]);
    } catch (error: any) {
      if (error.message?.includes('timed out')) {
        // Ensure cleanup happens (finally block will run)
        const elapsed = Date.now() - startTime;
        const elapsedSeconds = Math.round(elapsed / 1000);
        if (this.reporter) {
          this.reporter.report('phase', `Runtime analysis timed out after ${elapsedSeconds} seconds`);
        }
        throw new Error(`Failed to capture runtime value: Execution timed out after ${elapsedSeconds} seconds`);
      }
      throw error;
    }
  }

  /**
   * Internal analysis method (renamed from analyze)
   * Handles multiple targets in a single session
   */
  private async analyzeInternal(
    targets: Array<{ file: string; line: number; expression: string }>,
    description?: string,
    model?: string,
  ): Promise<RuntimeAnalysisResult[]> {
    // Defensive check: warn if persistent logger was not injected
    if (this.logger instanceof ConsoleFallbackLogger) {
      console.warn(
        "[RuntimeAnalysisAgent] WARNING: Using ConsoleFallbackLogger. Reports will NOT be saved to disk. Ensure setLogger is called with a persistent logger.",
      );
    }

    // Get the first target (for single target analysis)
    const firstTarget = targets[0];
    if (!firstTarget) {
      throw new Error("No targets provided for analysis");
    }

    console.log(
      `[RuntimeAnalysisAgent] Starting analysis: ${firstTarget.expression} at ${firstTarget.file}:${firstTarget.line}`,
    );

    // Report initial phase
    if (this.reporter) {
      this.reporter.report(
        "phase",
        `Starting runtime analysis of "${firstTarget.expression}" at ${firstTarget.file}:${firstTarget.line}`,
      );
    }

    // Pre-flight cleanup: Ensure port 9229 is free before we do anything
    try {
      const nodeProcessTool = this.registry.getTool("node-process");
      if (nodeProcessTool) {
        await nodeProcessTool.execute({ action: "kill_all" });
        console.log("[RuntimeAnalysisAgent] Pre-flight cleanup completed");
      }
    } catch (error) {
      console.warn(
        "[RuntimeAnalysisAgent] Pre-flight cleanup failed (non-fatal):",
        error,
      );
    }

    // Track current target and accumulated insights
    let currentTarget = firstTarget;
    let accumulatedInsights: string[] = [];
    let currentHypothesis =
      description || `Analyze ${firstTarget.expression} at ${firstTarget.file}:${firstTarget.line}`;
    let rootCauseFound = false;
    let cleanupListeners: (() => void) | null = null;
    const thoughtHistory: ThoughtStep[] = [];
    const runLabel = `run-${Date.now().toString(36)}-${Math.random()
      .toString(36)
      .slice(2, 6)}`;

    const cleanupOutputListener = () => {
      if (cleanupListeners) {
        cleanupListeners();
        cleanupListeners = null;
        console.log("[RuntimeAnalysisAgent] Output listener removed");
      }
    };

    // Wrap entire analysis in try/finally for post-flight cleanup
    try {
      // Save lightweight diagnostics for the run
      try {
        const diagnostics = this.collectDiagnostics();
        this.logger.logDiagnostics(diagnostics);
      } catch (diagError) {
        console.warn(
          "[RuntimeAnalysisAgent] Failed to collect diagnostics:",
          diagError,
        );
      }

      // Load system prompt from markdown file
      let systemPrompt: string;
      try {
        systemPrompt = loadDebuggingPrompt("runtime_analysis.md");
      } catch (error) {
        console.warn(
          "[RuntimeAnalysisAgent] Failed to load prompt file, using fallback",
        );
        systemPrompt = `You are a QA Engineer specializing in backend Node.js/TypeScript code testing. 
Create minimal reproduction scripts, run them, and extract runtime values for variables or expressions.

When asked to analyze a variable or expression:
1. Use static-analysis to read the target file
2. Generate a minimal reproduction script
3. Write it using sandbox-fs
4. Run it with node-process using the atomic debug action (provide breakpoints with content snippets—code snippets from the target file, not line numbers—and watch variables)
5. Clean up and return the result

Use relative imports. Handle errors and retry if needed.`;
      }

      // Inject workspace root so the LLM can construct absolute imports for wrapper scripts
      const workspaceContext = `

## Workspace Context
- Workspace root: ${this.workspaceRoot}
- Use absolute paths from this root when importing user code into sandbox wrapper scripts.`;
      systemPrompt += workspaceContext;

      // Get available tools
      const runtimeTools = this.registry.getRuntimeTools();
      const toolDefinitions = runtimeTools.map((tool) => ({
        name: tool.name,
        description: tool.description,
        parameters: zodToJsonSchema(tool.inputSchema),
      }));

      // Load initial source code context
      let currentSourceCode: string | null = null;
      let lastLoadedSourceFile: string | null = null;
      try {
        const staticAnalysisTool = this.registry.getTool("static-analysis");
        if (staticAnalysisTool) {
          const sourceResult = await staticAnalysisTool.execute({
            filePath: currentTarget.file,
            mode: "source",
          });
          if (
            sourceResult.success &&
            sourceResult.evidence &&
            sourceResult.evidence.length > 0
          ) {
            currentSourceCode = sourceResult.evidence[0].text;
            lastLoadedSourceFile = currentTarget.file;
          }
        }
      } catch (error) {
        console.warn(
          "[RuntimeAnalysisAgent] Failed to load initial source code:",
          error,
        );
      }

      // Build initial user message
      const buildUserMessage = (
        target: typeof currentTarget,
        hypothesis: string,
        insights: string[],
        sourceCode: string | null,
        thoughts: ThoughtStep[],
      ) => {
        let message = `Analyze the variable/expression "${target.expression}" at line ${target.line} in file "${target.file}".\n\n`;

        if (hypothesis) {
          message += `Current Hypothesis: ${hypothesis}\n\n`;
        }

        if (insights.length > 0) {
          message += `Accumulated Insights from Previous Attempts:\n${insights.map((insight, i) => `${i + 1}. ${insight}`).join("\n")}\n\n`;
        }

        if (sourceCode) {
          message += `Source Code Context:\n\`\`\`typescript\n${sourceCode}\n\`\`\`\n\n`;
        }

        if (thoughts.length > 0) {
          const formattedThoughts = thoughts
            .map(
              (t) =>
                `Step ${t.step} | Action: ${t.action}\nReasoning: ${t.reasoning}\nObservation: ${t.observation}\nOutcome: ${t.outcome}`,
            )
            .join("\n\n");
          message += `Recent Thoughts (Last 5 Steps):\n${formattedThoughts}\n\n`;
        }

        message += `Your goal is to:\n`;
        message += `1. ${insights.length > 0 ? "Based on the insights above, " : ""}Read the code at ${target.file}\n`;
        message += `2. Create a minimal reproduction script that executes the code path leading to line ${target.line}\n`;
        message += `3. Capture the runtime value of "${target.expression}" at that line\n`;
        message += `4. Return the value, its type, and any console logs\n\n`;
        message += `Use the available tools to accomplish this task.`;

        if (insights.length > 0) {
          message += `\n\nRemember: Evaluate whether the captured value provides sufficient ground truth to prove or disprove the root cause hypothesis. Only continue iterating if the value doesn't clarify the root cause and more investigation is needed. If you have sufficient ground truth, return a final_result.`;
        }

        return message;
      };

    const determineAction = (parsed: any): string => {
      if (parsed?.final_result) {
        return "Final Result";
      }
      if (parsed?.error) {
        return "Error";
      }
      if (parsed?.next_hypothesis) {
        return "Hypothesis Refinement";
      }
      if (parsed?.call_tools && Array.isArray(parsed.call_tools)) {
        return parsed.call_tools.map((t: any) => t.name).join(", ") || "Tool Call";
      }
      return "Thought";
    };

    const summarizeOutcome = (parsed: any): string => {
      if (parsed?.final_result) {
        const result = parsed.final_result;
        const valuePreview =
          typeof result.value === "object"
            ? JSON.stringify(result.value).substring(0, 120)
            : String(result.value);
        return `Value captured (${result.type || typeof result.value}): ${valuePreview}`;
      }
      if (parsed?.error) {
        return `Error: ${parsed.error}`;
      }
      if (parsed?.next_hypothesis) {
        return `Hypothesis: ${parsed.next_hypothesis}`;
      }
      if (parsed?.insights && Array.isArray(parsed.insights) && parsed.insights.length > 0) {
        return parsed.insights.join(" | ");
      }
      return "No outcome recorded";
    };

    const recordThought = (stepIndex: number, parsed: any): ThoughtStep | null => {
      const reasoning = parsed?.thought || determineAction(parsed);
      if (!reasoning) {
        return null;
      }

      const action = determineAction(parsed);
      const observation =
        parsed?.call_tools && Array.isArray(parsed.call_tools) && parsed.call_tools.length > 0
          ? "Awaiting tool results"
          : parsed?.insights && Array.isArray(parsed.insights) && parsed.insights.length > 0
          ? parsed.insights.join(" | ")
          : "No observation recorded";

      const thought: ThoughtStep = {
        step: stepIndex + 1,
        timestamp: Date.now(),
        reasoning,
        action,
        observation,
        outcome: summarizeOutcome(parsed),
      };

      thoughtHistory.push(thought);
      if (thoughtHistory.length > 5) {
        thoughtHistory.splice(0, thoughtHistory.length - 5);
      }

      return thought;
    };

    const summarizeToolResults = (toolResults: any[]): string => {
      if (!toolResults || toolResults.length === 0) {
        return "No tool results";
      }

      return toolResults
        .map((result: any) => {
          const preview =
            result.content && typeof result.content === "string"
              ? result.content.substring(0, 160)
              : "";
          return preview ? `${result.name}: ${preview}` : result.name;
        })
        .join(" | ");
    };

      const userMessage = buildUserMessage(
        currentTarget,
        currentHypothesis,
        accumulatedInsights,
        currentSourceCode,
        thoughtHistory,
      );

      // Build messages array
      const messages: any[] = [
        { role: "system", content: systemPrompt },
        { role: "user", content: userMessage },
      ];

      // Add tool definitions to system prompt
      const toolsPrompt = `
## Available Tools

${toolDefinitions
  .map(
    (tool) => `
### ${tool.name}
${tool.description}

Parameters:
\`\`\`json
${JSON.stringify(tool.parameters, null, 2)}
\`\`\`
`,
  )
  .join("\n")}

## Response Format

**CRITICAL: You MUST return JSON only. Do not output any text, markdown, or tool results outside of the JSON structure. All your reasoning must be inside the JSON object, in the "thought" field.**

You must return JSON with one of these formats:

**Option 1: Tool Calls (to gather more information)**
\`\`\`json
{
  "thought": "Your reasoning about what to do next",
  "call_tools": [
    {
      "name": "tool-name",
      "arguments": { ... }
    }
  ]
}
\`\`\`

**Option 2: Continue Iteration (refine hypothesis)**
\`\`\`json
{
  "thought": "What you learned and why you're continuing",
  "insights": ["insight 1", "insight 2"],
  "next_hypothesis": "Your refined hypothesis about what to investigate next",
  "new_target": {
    "file": "path/to/file.ts",
    "line": 42,
    "expression": "variableName"
  }
}
\`\`\`

**Note**: \`new_target\` is optional. Only include it if insights suggest investigating a different file/line/expression.

**Option 3: Final Result (when value is captured or sufficient insight gathered)**
\`\`\`json
{
  "thought": "Your final reasoning",
  "insights": ["accumulated", "insights", "from", "all", "iterations"],
  "final_result": {
    "value": <any JSON-serializable value>,
    "type": "string describing the type (e.g., 'undefined', 'object', 'number')",
    "logs": ["array", "of", "console", "logs"],
    "rootCauseFound": true/false
  }
}
\`\`\`

**Option 4: Error (if analysis fails completely)**
\`\`\`json
{
  "thought": "Explanation of what went wrong",
  "error": "Error message"
}
\`\`\`
`;

      messages[0].content = systemPrompt + toolsPrompt;

      // LLM Loop
      let step = 0;
      const MAX_STEPS = 10;
      const MAX_LLM_RETRIES = 1;
      const LLM_RETRY_DELAY_MS = 3000;
      let llmRetryCount = 0;
      let capturedValue: any = undefined;
      let capturedType: string = "unknown";
      let capturedLogs: string[] = [];
      let totalCost = 0;

      while (step < MAX_STEPS) {
        console.log(`[RuntimeAnalysisAgent] Step ${step + 1}/${MAX_STEPS}`);

        // Ensure source code is available for the current target each iteration
        if (
          currentSourceCode === null ||
          currentTarget.file !== lastLoadedSourceFile
        ) {
          try {
            const staticAnalysisTool = this.registry.getTool("static-analysis");
            if (staticAnalysisTool) {
              const sourceResult = await staticAnalysisTool.execute({
                filePath: currentTarget.file,
                mode: "source",
              });

              if (
                sourceResult.success &&
                sourceResult.evidence &&
                sourceResult.evidence.length > 0
              ) {
                currentSourceCode = sourceResult.evidence[0].text;
                lastLoadedSourceFile = currentTarget.file;
                console.log(
                  `[RuntimeAnalysisAgent] Source code (re)loaded for ${currentTarget.file}`,
                );
              } else {
                console.warn(
                  `[RuntimeAnalysisAgent] Failed to load source code for ${currentTarget.file} during loop iteration.`,
                );
                currentSourceCode = null;
              }
            }
          } catch (error) {
            console.warn(
              `[RuntimeAnalysisAgent] Error (re)loading source code for ${currentTarget.file}:`,
              error,
            );
            currentSourceCode = null;
          }
        }

        // Periodic diagnostics every 5 steps to aid mid-run debugging
        if (step > 0 && step % 5 === 0) {
          try {
            const diagnostics = this.collectDiagnostics();
            const label = `runtime-diagnostics-step-${step
              .toString()
              .padStart(2, "0")}`;
            this.logger.logDiagnostics(diagnostics, label);
          } catch (diagError) {
            console.warn(
              "[RuntimeAnalysisAgent] Failed to collect periodic diagnostics:",
              diagError,
            );
          }
        }

        // Log prompt (messages + metadata) before sending to LLM
        const estimatedPromptTokens = this.estimatePromptTokens(messages);
        this.logger.logRuntimeStep(
          step,
          "prompt",
          {
            model: model || "gpt-4o",
            step,
            runLabel,
            tokenMetadata: {
              estimatedInputTokens: estimatedPromptTokens,
            },
            messages,
          },
          runLabel,
        );

        // Call LLM
        const llmRequest = {
          id: `runtime-analysis-step-${step}`,
          provider: "auto",
          model: model || "gpt-4o", // Use provided model or default to gpt-4o
          messages: messages,
          maxTokens: 30000,
          metadata: {
            response_format: { type: "json_object" },
            sessionId: this.sessionId,
          },
          createdAt: new Date(),
          updatedAt: new Date(),
        };
        let response = await this.llm.chat(llmRequest);

        if (response.type !== ResponseType.SUCCESS || !response.payload) {
          const isRetryable = (response.payload as LLMError)?.retryable === true
            || isRetryableFromErrorString(response.error || '');

          if (isRetryable && llmRetryCount < MAX_LLM_RETRIES) {
            llmRetryCount++;
            console.warn(`[RuntimeAnalysisAgent] Retryable LLM error, retrying (${llmRetryCount}/${MAX_LLM_RETRIES}):`, response.error);
            this.reporter?.report('phase', 'Retrying after temporary error...');
            await new Promise(resolve => setTimeout(resolve, LLM_RETRY_DELAY_MS));
            response = await this.llm.chat(llmRequest);
          }

          if (response.type !== ResponseType.SUCCESS || !response.payload) {
            // Report LLM call failure
            if (this.reporter) {
              this.reporter.report(
                "phase",
                `LLM call failed: ${response.error || "Unknown error"}`,
              );
            }
            throw new Error(
              `LLM call failed: ${response.error || "Unknown error"}`,
            );
          }
        }

        const llmResponse = response.payload as LLMResponse;
        const rawContent = llmResponse.content || "{}";

        // Track cost from LLM call
        if (llmResponse.cost !== undefined) {
          totalCost += llmResponse.cost;
        }

        // Log LLM response
        this.logger.logRuntimeStep(step, "response", llmResponse, runLabel);

        // Parse JSON response
        let parsed: any;
        try {
          // Extract JSON using improved parsing strategy
          const jsonString = this.extractJsonFromText(rawContent);

          if (!jsonString) {
            // No JSON found at all - this is a plain text response
            throw new Error("No JSON object found in response");
          }

          parsed = JSON.parse(jsonString);
        } catch (parseError: any) {
          console.error(
            `[RuntimeAnalysisAgent] JSON parse failed:`,
            parseError,
          );

          // Persist raw response + parse failure so the iteration is visible in logs
          if (this.logger) {
            // 1) Save the raw LLM output (same behavior as PlanningAgent) for quick inspection
            this.logger.logParseFailure(
              "RuntimeAnalysisAgent.analyze",
              parseError,
              rawContent,
            );
            // 2) Save a state snapshot for this step to avoid "missing" iterations in the per-step logs
            this.logger.logRuntimeStep(step, "state", {
              error: "json_parse_failed",
              message: parseError?.message || String(parseError),
              rawPreview:
                typeof rawContent === "string"
                  ? rawContent.substring(0, 4000)
                  : rawContent,
            }, runLabel);
          }

          // Report parse error
          if (this.reporter) {
            this.reporter.report("phase", `JSON parse error, retrying...`);
          }

          // Determine if this is a "no JSON found" error or malformed JSON
          const noJsonFound =
            parseError.message === "No JSON object found in response" ||
            !this.containsJsonAttemptPattern(rawContent);

          // Retry with specific error message
          const errorMessage = noJsonFound
            ? `SYSTEM ERROR: No JSON object found in your response. You outputted raw text/markdown. You MUST wrap your response in a single JSON object block. Do not output any text outside the JSON.`
            : `SYSTEM ERROR: Your response contained invalid JSON. Error: ${parseError.message}\n\nPlease return ONLY valid JSON.`;

          messages.push({
            role: "user",
            content: errorMessage,
          });
          step++;
          continue;
        }

        console.log(
          `[RuntimeAnalysisAgent] Parsed response fields:`,
          Object.keys(parsed),
        );

        // Report thought from LLM response
        if (this.reporter && parsed.thought) {
          this.reporter.report("thought", parsed.thought);
        }

        // Log parsed state
        this.logger.logRuntimeStep(step, "state", {
          thought: parsed.thought,
          insights: parsed.insights,
          hypothesis: parsed.next_hypothesis || currentHypothesis,
          target: currentTarget,
          hasFinalResult: !!parsed.final_result,
          hasNextHypothesis: !!parsed.next_hypothesis,
          hasToolCalls: !!(parsed.call_tools && parsed.call_tools.length > 0),
          hasError: !!parsed.error,
        }, runLabel);

        const currentThought = recordThought(step, parsed);

        // Check for final result
        if (parsed.final_result) {
          capturedValue = parsed.final_result.value;
          capturedType = parsed.final_result.type || typeof capturedValue;
          capturedLogs = parsed.final_result.logs || [];
          rootCauseFound = parsed.final_result.rootCauseFound || false;
          // Accumulate insights from final result
          if (parsed.insights && Array.isArray(parsed.insights)) {
            accumulatedInsights.push(...parsed.insights);
          }
          currentHypothesis = parsed.thought || currentHypothesis;
          console.log(`[RuntimeAnalysisAgent] Value captured:`, capturedValue);

          // Report final result captured
          if (this.reporter) {
            const valuePreview =
              typeof capturedValue === "object"
                ? JSON.stringify(capturedValue).substring(0, 100) + "..."
                : String(capturedValue).substring(0, 100);
            this.reporter.report(
              "phase",
              `Captured runtime value: ${valuePreview} (type: ${capturedType})`,
            );
          }

          // Log final result
          this.logger.logRuntimeStep(step, "final_result", {
            value: capturedValue,
            type: capturedType,
            logs: capturedLogs,
            insights: accumulatedInsights,
            hypothesis: currentHypothesis,
            rootCauseFound: rootCauseFound,
          }, runLabel);
          break;
        }

        // Check for iteration continuation (hypothesis refinement)
        if (parsed.next_hypothesis) {
          console.log(
            `[RuntimeAnalysisAgent] Refining hypothesis: ${parsed.next_hypothesis}`,
          );

          // Report hypothesis refinement
          if (this.reporter) {
            this.reporter.report(
              "phase",
              `Refining hypothesis: ${parsed.next_hypothesis}`,
            );
          }

          // Accumulate insights from this iteration
          if (parsed.insights && Array.isArray(parsed.insights)) {
            accumulatedInsights.push(...parsed.insights);
          }

          // Update hypothesis
          currentHypothesis = parsed.next_hypothesis;

          // Check if target changed
          if (parsed.new_target) {
            const newTarget = parsed.new_target;
            const oldFile = currentTarget.file;
            const fileChanged = newTarget.file && newTarget.file !== oldFile;

            // Update target
            currentTarget = {
              file: newTarget.file || currentTarget.file,
              line: newTarget.line || currentTarget.line,
              expression: newTarget.expression || currentTarget.expression,
            };

            // CRITICAL: Refresh source code context if file changed
            if (fileChanged && newTarget.file) {
              console.log(
                `[RuntimeAnalysisAgent] Target file changed from ${oldFile} to ${newTarget.file}, refreshing source code...`,
              );
              try {
                const staticAnalysisTool =
                  this.registry.getTool("static-analysis");
                if (staticAnalysisTool) {
                  const sourceResult = await staticAnalysisTool.execute({
                    filePath: newTarget.file,
                    mode: "source",
                  });
                  if (
                    sourceResult.success &&
                    sourceResult.evidence &&
                    sourceResult.evidence.length > 0
                  ) {
                    currentSourceCode = sourceResult.evidence[0].text;
                    console.log(
                      `[RuntimeAnalysisAgent] Source code refreshed for ${newTarget.file}`,
                    );
                  } else {
                    console.warn(
                      `[RuntimeAnalysisAgent] Failed to load source code for ${newTarget.file}`,
                    );
                    currentSourceCode = null;
                  }
                }
              } catch (error) {
                console.warn(
                  `[RuntimeAnalysisAgent] Error refreshing source code:`,
                  error,
                );
                currentSourceCode = null;
              }
            }
          }

          // Add assistant response to history
          messages.push({
            role: "assistant",
            content: rawContent,
          });

          // Update user message with new context
          const updatedUserMessage = buildUserMessage(
            currentTarget,
            currentHypothesis,
            accumulatedInsights,
            currentSourceCode,
            thoughtHistory,
          );
          messages.push({
            role: "user",
            content: `Continuing with refined hypothesis. ${updatedUserMessage}`,
          });

          step++;
          continue;
        }

        // Check for error
        if (parsed.error) {
          // Report error
          if (this.reporter) {
            this.reporter.report(
              "phase",
              `Runtime analysis error: ${parsed.error}`,
            );
          }

          // Log error before throwing
          this.logger.logRuntimeStep(step, "final_result", {
            error: parsed.error,
            insights: accumulatedInsights,
            hypothesis: currentHypothesis,
          }, runLabel);
          this.logger.generateSummary({ steps: step, cost: totalCost });
          throw new Error(`Runtime analysis failed: ${parsed.error}`);
        }

        // Handle tool calls
        if (
          parsed.call_tools &&
          Array.isArray(parsed.call_tools) &&
          parsed.call_tools.length > 0
        ) {
          // Guardrail: reject node-process breakpoints that use line numbers
          const hasLineNumberBreakpoint = parsed.call_tools.some((toolCall: any) => {
            if (toolCall?.name !== "node-process") return false;
            const bps = toolCall.arguments?.breakpoints;
            return Array.isArray(bps) && bps.some((bp) => bp && bp.line !== undefined);
          });

          if (hasLineNumberBreakpoint) {
            const errorMessage =
              "node-process breakpoints must use content snippets (code snippets), not line numbers. Extract an executable snippet with static-analysis and retry.";
            if (this.reporter) {
              this.reporter.report("phase", errorMessage);
            }
            this.logger.logRuntimeStep(
              step,
              "final_result",
              {
                error: errorMessage,
                insights: accumulatedInsights,
                hypothesis: currentHypothesis,
              },
              runLabel,
            );
            throw new Error(errorMessage);
          }

          // Report tool calls before execution
          if (this.reporter) {
            for (const toolCall of parsed.call_tools) {
              let detail = "";
              try {
                if (toolCall.arguments?.filePath) {
                  detail = ` (${toolCall.arguments.filePath})`;
                } else if (toolCall.arguments?.path) {
                  detail = ` (${toolCall.arguments.path})`;
                } else if (
                  toolCall.arguments?.targets &&
                  Array.isArray(toolCall.arguments.targets)
                ) {
                  const firstTarget = toolCall.arguments.targets[0];
                  if (firstTarget?.file) {
                    detail = ` (${firstTarget.file}:${firstTarget.line})`;
                  }
                } else if (toolCall.arguments?.query) {
                  detail = ` (query: "${toolCall.arguments.query}")`;
                  if (toolCall.arguments?.mode) {
                    detail += ` (mode: ${toolCall.arguments.mode})`;
                  }
                  if (toolCall.arguments?.pattern) {
                    detail += ` (pattern: "${toolCall.arguments.pattern}")`;
                  }
                } else if (
                  toolCall.arguments &&
                  Object.keys(toolCall.arguments).length > 0
                ) {
                  detail = ` (${JSON.stringify(toolCall.arguments)})`;
                }
              } catch (e) {
                // Ignore parsing errors
              }
              this.reporter.report(
                "tool",
                `Running ${toolCall.name}${detail}...`,
              );
            }
          }

          // Add assistant response to history
          messages.push({
            role: "assistant",
            content: rawContent,
          });

          // Execute tools
          const toolCalls = parsed.call_tools.map((t: any, index: number) => ({
            id: `call_${Date.now()}_${step}_${index}`,
            function: {
              name: t.name,
              arguments: JSON.stringify(t.arguments || {}),
            },
          }));

          // Wire up NodeProcessTool event stream if reporter is available
          const processToolCalls = toolCalls.filter(
            (tc: { function: { name: string } }) => {
              return tc.function.name === "node-process";
            },
          );

          if (processToolCalls.length > 0 && this.reporter) {
            try {
              const processTool = this.registry.getTool(
                "node-process",
              ) as NodeProcessTool;
              if (processTool) {
                cleanupOutputListener();
                const onOutput = (data: string, type: "stdout" | "stderr") => {
                  // Forward to reporter (trim whitespace to avoid spamming empty lines)
                  if (data.trim()) {
                    this.reporter!.sendLogUpdate(data, type);
                  }
                };

                processTool.on("output", onOutput);
                cleanupListeners = () => {
                  processTool.removeListener("output", onOutput);
                };
              }
            } catch (error) {
              console.warn(
                "[RuntimeAnalysisAgent] Failed to wire up log streaming:",
                error,
              );
            }
          }

          let toolResults;
          try {
            toolResults = await this.toolExecutor.executeToolCalls(
              toolCalls,
              this.reporter,
              this.logger,
            );

            // Automatic crash diagnosis: Check for crashed node-process debug runs
            for (const result of toolResults) {
              if (result.name === "node-process" && result.rawResult) {
                const rawResult = result.rawResult;

                // Check if process crashed (success: false with exit code)
                if (
                  !rawResult.success &&
                  rawResult.structuredData?.exitCode !== undefined
                ) {
                  const exitCode = rawResult.structuredData.exitCode;
                  const errorLogs = rawResult.structuredData.error || "";
                  const command = rawResult.structuredData.command || "unknown";

                  console.log(
                    `[RuntimeAnalysisAgent] Detected process crash (Exit Code: ${exitCode})`,
                  );

                  // Heuristic detection for common issues
                  const errorLogsLower = errorLogs.toLowerCase();
                  let detectedIssue = "";

                  if (
                    errorLogsLower.includes("command not found") ||
                    (errorLogsLower.includes("cannot find module") &&
                      errorLogsLower.includes("ts-node"))
                  ) {
                    detectedIssue =
                      "MISSING_DEPENDENCY: ts-node may not be installed. Try: npm install -D ts-node";
                  } else if (
                    errorLogsLower.includes("cannot find module") ||
                    errorLogsLower.includes("module not found")
                  ) {
                    detectedIssue =
                      "MODULE_NOT_FOUND: Import path issue or missing dependency";
                  } else if (
                    errorLogsLower.includes("syntaxerror") ||
                    errorLogsLower.includes("syntax error")
                  ) {
                    detectedIssue =
                      "SYNTAX_ERROR: Script contains syntax errors";
                  } else if (
                    errorLogsLower.includes("typescript") &&
                    (errorLogsLower.includes("error") ||
                      errorLogsLower.includes("ts"))
                  ) {
                    detectedIssue =
                      "TYPESCRIPT_ERROR: TypeScript compilation failed";
                  }

                  // Enhance the result content with diagnostic information
                  if (errorLogs && errorLogs !== "(No output captured)") {
                    const structuredData = rawResult.structuredData || {};
                    const logsArray = Array.isArray(structuredData.logs)
                      ? structuredData.logs.filter(
                          (log: unknown): log is string =>
                            typeof log === "string",
                        )
                      : [];
                    const errorsArray = Array.isArray(structuredData.errors)
                      ? structuredData.errors.filter(
                          (err: unknown): err is string =>
                            typeof err === "string",
                        )
                      : [];
                    const breakpointsHit = Array.isArray(structuredData.breakpoints_hit)
                      ? structuredData.breakpoints_hit
                      : [];
                    const finalOutput =
                      typeof structuredData.finalOutput === "string"
                        ? structuredData.finalOutput
                        : "";
                    const summary = rawResult.summary || "No summary available.";

                    // Extract runtime duration if present in any error message
                    const runtimeMatch = errorsArray
                      .map((msg: string) => msg.match(/Runtime:\s*(\d+)ms/i))
                      .find(
                        (match: RegExpMatchArray | null): match is RegExpMatchArray =>
                          Boolean(match && match[1]),
                      );
                    const runtimeMs = runtimeMatch ? runtimeMatch[1] : null;

                    const capturedLogsText =
                      logsArray.length > 0
                        ? logsArray.join("\n")
                        : finalOutput || errorLogs;
                    const capturedErrorsText =
                      errorsArray.length > 0 ? errorsArray.join("\n") : errorLogs;
                    const breakpointsText =
                      breakpointsHit.length > 0
                        ? JSON.stringify(breakpointsHit, null, 2)
                        : "None";
                    const fullContext = JSON.stringify(structuredData, null, 2);

                    const diagnosticText = `[DIAGNOSTIC] ${detectedIssue ? `Issue: ${detectedIssue}\n` : ""}Exit Code: ${exitCode}${runtimeMs ? `\nRuntime: ${runtimeMs}ms` : ""}\nSummary: ${summary}\n\nCaptured Logs:\n${capturedLogsText}\n\nErrors:\n${capturedErrorsText}\n\nBreakpoints Hit (${breakpointsHit.length}):\n${breakpointsText}\n\nFull Context:\n${fullContext}`;

                    let enhancedContent = result.content;

                    // If content is JSON, parse and enhance it
                    try {
                      const parsed = JSON.parse(enhancedContent);
                      if (
                        Array.isArray(parsed) &&
                        parsed.length > 0 &&
                        parsed[0].text
                      ) {
                        // Already has evidence format, enhance it
                        parsed[0].text = diagnosticText;
                        enhancedContent = JSON.stringify(parsed);
                      } else {
                        // Wrap in evidence format
                        enhancedContent = JSON.stringify([
                          {
                            file: "crash-diagnosis.txt",
                            line: 0,
                            text: diagnosticText,
                            description: "Process Crash Diagnosis",
                          },
                        ]);
                      }
                    } catch {
                      // Not JSON, append diagnostic info
                      enhancedContent = diagnosticText;
                    }

                    result.content = enhancedContent;

                    // Report diagnostic information
                    if (this.reporter) {
                      if (detectedIssue) {
                        this.reporter.report(
                          "phase",
                          `Process crash detected: ${detectedIssue}`,
                        );
                      } else {
                        this.reporter.report(
                          "phase",
                          `Process crashed with exit code ${exitCode}. Check logs for details.`,
                        );
                      }
                    }
                  } else {
                    // No logs captured - this is unusual
                    console.warn(
                      `[RuntimeAnalysisAgent] Process crashed but no logs were captured. Exit code: ${exitCode}`,
                    );
                    if (this.reporter) {
                      this.reporter.report(
                        "phase",
                        `Process crashed (Exit Code: ${exitCode}) but no error output was captured. This may indicate a very early crash or environment issue.`,
                      );
                    }
                  }
                }
              }
            }

            // Log tool calls and results
            this.logger.logRuntimeStep(step, "tools", {
              calls: parsed.call_tools,
              results: toolResults.map((r) => ({
                name: r.name,
                content:
                  r.content.length > 1000
                    ? r.content.substring(0, 1000) + "... [truncated]"
                    : r.content,
              })),
            }, runLabel);

            if (thoughtHistory.length > 0) {
              const latestThought = thoughtHistory[thoughtHistory.length - 1];
              latestThought.observation = summarizeToolResults(toolResults);
            }

            // Add results to history
            messages.push({
              role: "user",
              content: `Tool Results:\n\n${toolResults.map((r) => `### ${r.name}\n${r.content}\n`).join("\n")}`,
            });

            step++;
          } finally {
            // Clean up event listeners to prevent memory leaks
            cleanupOutputListener();
          }
        } else {
          // No tool calls and no final result - might be done or stuck
          console.warn(
            "[RuntimeAnalysisAgent] No tool calls and no final result. Ending analysis.",
          );

          // Report unexpected end
          if (this.reporter) {
            this.reporter.report(
              "phase",
              "Analysis ended unexpectedly - no tool calls and no final result",
            );
          }

          // Log this edge case
          this.logger.logRuntimeStep(step, "final_result", {
            error:
              "No tool calls and no final result - analysis ended unexpectedly",
            insights: accumulatedInsights,
            hypothesis: currentHypothesis,
          }, runLabel);
          break;
        }
      }

      cleanupOutputListener();

      if (capturedValue === undefined) {
        // Report timeout/failure
        if (this.reporter) {
          this.reporter.report(
            "phase",
            `Failed to capture runtime value after ${step} steps. The agent may have encountered errors or reached the step limit.`,
          );
        }

        // Log failure before throwing
        this.logger.logRuntimeStep(step, "final_result", {
          error: `Failed to capture runtime value after ${step} steps`,
          insights: accumulatedInsights,
          hypothesis: currentHypothesis,
        }, runLabel);
        this.logger.generateSummary({ steps: step, cost: totalCost });
        throw new Error(
          `Failed to capture runtime value after ${step} steps. The agent may have encountered errors or reached the step limit.`,
        );
      }

      // Generate summary at the end
      this.logger.generateSummary({ steps: step, cost: totalCost });

      return [{
        value: capturedValue,
        type: capturedType,
        logs: capturedLogs,
        insights:
          accumulatedInsights.length > 0 ? accumulatedInsights : undefined,
        hypothesis: currentHypothesis,
        rootCauseFound: rootCauseFound,
        totalCost: totalCost,
      }];
    } finally {
      // Post-flight cleanup: Even if we crash, clean up the mess
      try {
        cleanupOutputListener();
        const nodeProcessTool = this.registry.getTool("node-process");
        if (nodeProcessTool) {
          await nodeProcessTool.execute({ action: "kill_all" });
          console.log("[RuntimeAnalysisAgent] Post-flight cleanup completed");
        }
      } catch (error) {
        console.warn(
          "[RuntimeAnalysisAgent] Post-flight cleanup failed (non-fatal):",
          error,
        );
      }
    }
  }

  /**
   * Collects lightweight diagnostics about the current workspace and environment.
   * Depth is limited to root + 1 level, with strict ignores to avoid large trees.
   */
  private estimatePromptTokens(messages: Array<{ content?: string }> | any): number {
    if (!Array.isArray(messages)) {
      return 0;
    }

    const totalChars = messages.reduce((sum: number, message: any) => {
      const contentLength =
        message && typeof message.content === "string"
          ? message.content.length
          : 0;
      return sum + contentLength;
    }, 0);

    // Rough heuristic: ~4 characters per token
    return Math.ceil(totalChars / 4);
  }

  private collectDiagnostics(): any {
    const diagnostics: any = {};
    const ignoreNames = new Set([
      ".git",
      "node_modules",
      "dist",
      ".next",
      "coverage",
    ]);

    try {
      diagnostics.environment = {
        cwd: process.cwd(),
        workspaceRoot: this.workspaceRoot,
        nodeVersion: process.version,
        platform: process.platform,
        arch: process.arch,
      };

      // Workspace listing (root + 1 level, no recursion)
      try {
        const entries = fs.readdirSync(this.workspaceRoot, {
          withFileTypes: true,
        });
        diagnostics.workspaceListing = entries
          .filter((entry) => !ignoreNames.has(entry.name))
          .map((entry) => ({
            name: entry.name,
            type: entry.isDirectory() ? "dir" : "file",
          }));
      } catch (listingError) {
        diagnostics.workspaceListing = {
          error: `Failed to list workspace: ${String(listingError)}`,
        };
      }

      // High value target checks
      const checkTarget = (relativePath: string) => {
        const fullPath = path.join(this.workspaceRoot, relativePath);
        return { exists: fs.existsSync(fullPath), path: fullPath };
      };

      diagnostics.highValueTargets = {
        packageJson: checkTarget("package.json"),
        tsconfigJson: checkTarget("tsconfig.json"),
        babelConfig: checkTarget("babel.config.js"),
        nextConfig: checkTarget("next.config.js"),
        tsNodeBinary: checkTarget(path.join("node_modules", ".bin", "ts-node")),
        tsNodeModule: checkTarget(path.join("node_modules", "ts-node")),
      };

      // Node modules locations
      const workspaceNodeModules = path.join(this.workspaceRoot, "node_modules");
      const homeNodeModules = path.join(os.homedir(), "node_modules");
      const npmPrefix =
        process.env.npm_config_prefix ||
        process.env.NPM_CONFIG_PREFIX ||
        process.env.PREFIX;
      const npmPrefixNodeModules = npmPrefix
        ? path.join(npmPrefix, "lib", "node_modules")
        : undefined;

      diagnostics.nodeModules = {
        workspace: {
          exists: fs.existsSync(workspaceNodeModules),
          path: workspaceNodeModules,
        },
        home: {
          exists: fs.existsSync(homeNodeModules),
          path: homeNodeModules,
        },
        npmPrefix: npmPrefix
          ? {
              prefix: npmPrefix,
              nodeModulesPath: npmPrefixNodeModules,
              exists: npmPrefixNodeModules
                ? fs.existsSync(npmPrefixNodeModules)
                : false,
            }
          : undefined,
      };
    } catch (error) {
      diagnostics.error = `Failed to collect diagnostics: ${String(error)}`;
    }

    return diagnostics;
  }

  /**
   * Extract JSON from LLM response text.
   * Steps:
   * 1. Try to parse JSON inside Markdown code fences (```json ... ```).
   * 2. Fallback to brace-based extraction on the full text.
   *
   * @param text - The raw LLM response content
   * @returns Extracted JSON string or null if no valid JSON found
   */
  private extractJsonFromText(text: string): string | null {
    if (!text || typeof text !== "string") {
      return null;
    }

    const trimmedText = text.trim();
    if (!trimmedText) {
      return null;
    }

    // Strategy 0: Handle Markdown-fenced JSON blocks first
    const fencedJson = this.extractJsonFromCodeFence(trimmedText);
    if (fencedJson) {
      return fencedJson;
    }

    return this.extractJsonFromBlock(trimmedText);
  }

  /**
   * Attempt to extract JSON from Markdown code fences (```json ... ```).
   * Handles various formats:
   * - ```json\n{...}\n```
   * - ```\n{...}\n```
   * - Multiple code blocks (returns the first valid JSON)
   * - Handles both greedy and non-greedy matching for robustness
   */
  private extractJsonFromCodeFence(text: string): string | null {
    // First, try to find json-marked code blocks (higher priority)
    const jsonFencePattern = /```json\s*\n?([\s\S]*?)\n?```/gi;
    let match: RegExpExecArray | null;
    
    // Reset lastIndex to ensure we start from the beginning
    jsonFencePattern.lastIndex = 0;
    
    while ((match = jsonFencePattern.exec(text)) !== null) {
      const fencedContent = match[1]?.trim();
      if (!fencedContent) {
        continue;
      }

      const extracted = this.extractJsonFromBlock(fencedContent);
      if (extracted) {
        return extracted;
      }
    }

    // Fallback: try unmarked code blocks (might still contain JSON)
    const genericFencePattern = /```\s*\n?([\s\S]*?)\n?```/gi;
    genericFencePattern.lastIndex = 0;
    
    while ((match = genericFencePattern.exec(text)) !== null) {
      // Skip if this was already matched by the json pattern
      // (we can't easily check this, but it's okay to try again)
      const fencedContent = match[1]?.trim();
      if (!fencedContent) {
        continue;
      }

      // Only try if it looks like JSON (starts with { or [)
      if (fencedContent.startsWith("{") || fencedContent.startsWith("[")) {
        const extracted = this.extractJsonFromBlock(fencedContent);
        if (extracted) {
          return extracted;
        }
      }
    }

    return null;
  }

  /**
   * Extract JSON using brace-based strategies:
   * 1. Substring between the first '{' and last '}'.
   * 2. Balanced brace extraction if the first attempt fails.
   */
  private extractJsonFromBlock(text: string): string | null {
    if (!text) {
      return null;
    }

    // Strategy 1: Substring strategy - find first `{` and last `}`
    const firstBrace = text.indexOf("{");
    const lastBrace = text.lastIndexOf("}");

    if (firstBrace !== -1 && lastBrace !== -1 && lastBrace > firstBrace) {
      const candidate = text.substring(firstBrace, lastBrace + 1);
      try {
        // Try to parse - if it succeeds, we're done
        JSON.parse(candidate);
        return candidate;
      } catch {
        // If substring strategy fails, fall through to balanced brace extraction
      }
    }

    // Strategy 2: Balanced brace extraction (handles nested JSON and edge cases)
    let startIndex = text.indexOf("{");

    while (startIndex !== -1) {
      const balancedBlock = this.extractBalancedBlock(text, startIndex);

      if (balancedBlock) {
        try {
          // Validate it's valid JSON
          JSON.parse(balancedBlock);
          return balancedBlock;
        } catch {
          // Continue searching
        }
      }

      // Move to the next '{'
      startIndex = text.indexOf("{", startIndex + 1);
    }

    return null;
  }

  /**
   * Extract a balanced block of braces from a given starting position.
   * Finds the matching '}' for a given '{' position, accounting for:
   * - Nested braces
   * - String boundaries (braces inside strings are ignored)
   * - Escaped characters
   *
   * @param text - The full text to search in
   * @param start - The index of the opening '{'
   * @returns The extracted block as a string, or null if no balanced block found
   */
  private extractBalancedBlock(text: string, start: number): string | null {
    let balance = 0;
    let inString = false;
    let isEscaped = false;

    for (let i = start; i < text.length; i++) {
      const char = text[i];

      // Handle escaping (e.g., \" or \\ inside a string)
      if (isEscaped) {
        isEscaped = false;
        continue;
      }
      if (char === "\\") {
        isEscaped = true;
        continue;
      }

      // Handle string boundaries
      if (char === '"') {
        inString = !inString;
        continue;
      }

      // Handle braces (only if not inside a string)
      if (!inString) {
        if (char === "{") {
          balance++;
        } else if (char === "}") {
          balance--;

          // We found the matching closing brace for the root object
          if (balance === 0) {
            return text.substring(start, i + 1);
          }
        }
      }
    }

    // No balanced block found
    return null;
  }

  /**
   * Check if the text contains patterns that suggest JSON was attempted.
   * This helps distinguish between "no JSON attempted" vs "malformed JSON".
   *
   * @param text - The text to check
   * @returns true if JSON-like patterns are detected
   */
  private containsJsonAttemptPattern(text: string): boolean {
    if (!text || typeof text !== "string") {
      return false;
    }

    // Check for common JSON field names that RuntimeAnalysisAgent expects
    const jsonPatterns = [
      /\b"thought"\s*:/,
      /\b"call_tools"\s*:/,
      /\b"final_result"\s*:/,
      /\b"insights"\s*:/,
      /\b"next_hypothesis"\s*:/,
      /\b"error"\s*:/,
      /\b"new_target"\s*:/,
    ];

    return jsonPatterns.some((pattern) => pattern.test(text));
  }
}
