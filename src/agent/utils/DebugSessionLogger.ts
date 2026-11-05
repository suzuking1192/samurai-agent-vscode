/**
 * DebugSessionLogger - Session-scoped checkpoint logger for debugging process
 * 
 * Manages saving intermediate debugging results to debug-output/active-session/
 * Automatically wipes previous session data on instantiation.
 */

import * as fs from 'fs';
import * as path from 'path';

export class DebugSessionLogger {
  private outputDir: string;
  private checkpointPaths: string[] = [];
  private sessionId: string;

  constructor(sessionId: string, workspaceRoot: string) {
    this.sessionId = sessionId;
    // Use fixed folder name so we automatically overwrite the previous session
    // No manual cleanup logic needed
    this.outputDir = path.join(workspaceRoot, 'debug-output', 'active-session');
    
    // Initialize directory (wipes previous session)
    this.initializeDir();
    
    // Create metadata file linking this folder to the specific Session ID
    this.save('00-session-info.json', {
      sessionId,
      startTime: new Date().toISOString()
    });
  }

  /**
   * Initialize directory by wiping previous session data
   */
  private initializeDir(): void {
    try {
      if (fs.existsSync(this.outputDir)) {
        // Recursive delete to clear old files
        fs.rmSync(this.outputDir, { recursive: true, force: true });
      }
      fs.mkdirSync(this.outputDir, { recursive: true });
    } catch (error) {
      console.error('[DebugSessionLogger] Failed to initialize directory:', error);
      // Continue anyway - save operations will fail gracefully
    }
  }

  /**
   * Generic save method - handles file writing, error handling, and path tracking
   */
  protected save(filename: string, content: string | object): void {
    try {
      const fullPath = path.join(this.outputDir, filename);
      const data = typeof content === 'string' ? content : JSON.stringify(content, null, 2);
      
      fs.writeFileSync(fullPath, data, 'utf8');
      this.checkpointPaths.push(fullPath);
    } catch (error) {
      // Log error but don't throw - Agent should keep running
      console.error(`[DebugSessionLogger] Failed to save ${filename}:`, error);
    }
  }

  /**
   * Log user request and logs
   */
  logUserRequest(query: string, logs?: string): void {
    const content = `Query: ${query}\n\nLogs:\n${logs || 'None'}`;
    this.save('01-user-request.txt', content);
  }

  /**
   * Log epicenter detection result
   */
  logEpicenter(epicenter: any): void {
    this.save('02-epicenter.json', epicenter);
  }

  /**
   * Log initial graph data
   */
  logGraph(graph: any): void {
    this.save('02-initial-graph.json', graph);
  }

  /**
   * Log a single step of the Agent Loop
   * Uses padded numbers (01, 02) to keep file system sorting correct
   */
  logStep(stepIndex: number, type: 'prompt' | 'response' | 'tools' | 'state', content: any): void {
    // Format: 03-step-01-prompt.json
    const stepStr = stepIndex.toString().padStart(2, '0');
    const filename = `03-step-${stepStr}-${type}.json`;
    this.save(filename, content);
  }

  /**
   * Log a runtime analysis step with custom filename pattern
   * Uses padded numbers (01, 02) to keep file system sorting correct
   */
  logRuntimeStep(
    stepIndex: number,
    type: 'prompt' | 'response' | 'state' | 'tools' | 'final_result',
    content: any,
    runLabel?: string
  ): void {
    // Format: [runLabel-]runtime-step-01-response.json
    const stepStr = stepIndex.toString().padStart(2, '0');
    const prefix = runLabel ? `${runLabel}-` : '';
    const filename = `${prefix}runtime-step-${stepStr}-${type}.json`;
    this.save(filename, content);
  }

  /**
   * Log diagnostic snapshot for runtime analysis
   */
  logDiagnostics(content: any, label: string = 'runtime-diagnostics'): void {
    this.save(`${label}.json`, content);
  }

  /**
   * Generates a summary text file pointing to what happened
   */
  generateSummary(metrics: { steps: number; cost: number; filesAnalyzed?: string[] }): void {
    const summary = `Session Summary
===============
Generated: ${new Date().toISOString()}

Total Steps: ${metrics.steps}
Total Cost: $${metrics.cost.toFixed(4)}
Files Analyzed: ${metrics.filesAnalyzed?.length || 0}
Files Generated: ${this.checkpointPaths.length}

Checkpoints:
${this.checkpointPaths.map(p => `- ${path.basename(p)}`).join('\n')}
`;
    this.save('00-summary.txt', summary);
  }

  /**
   * Logs JSON parse failure with exact raw output for debugging
   * Always overwrites the previous failure (single latest file pattern)
   * 
   * @param source - Component name where the parse failure occurred
   * @param error - The parse error object
   * @param rawContent - The exact raw output that failed to parse
   */
  public logParseFailure(source: string, error: any, rawContent: string): void {
    try {
      const filename = 'json-parse-failure-latest.txt';
      const fullPath = path.join(this.outputDir, filename);

      const errorMessage = error instanceof Error ? error.message : String(error);
      const logContent = `Timestamp: ${new Date().toISOString()}
Source: ${source}
Error: ${errorMessage}
Raw Output Length: ${rawContent ? rawContent.length : 0}

=== RAW OUTPUT START ===
${rawContent}
=== RAW OUTPUT END ===
`;

      fs.writeFileSync(fullPath, logContent, 'utf8');
      console.log(`[DebugLogger] Saved parse failure to ${filename}`);
    } catch (e) {
      // Log error but don't throw - logging failures shouldn't crash the app
      console.error('[DebugLogger] Failed to log parse failure:', e);
    }
  }

  /**
   * Logs epicenter refinement process with prompt, response, and outcome
   * Always overwrites the previous refinement (single latest file pattern)
   * 
   * @param prompt - The prompt sent to the LLM
   * @param response - The raw response received from the LLM
   * @param outcome - The refinement outcome (success/failure reason)
   * @param model - The model used for refinement
   * @param fileSymbols - The symbols extracted from files (optional, for debugging)
   */
  public logEpicenterRefinement(
    prompt: string,
    response: string,
    outcome: string,
    model?: string,
    fileSymbols?: Array<{ file: string; symbols: Array<{ name: string; type: string; exported: boolean }> }>
  ): void {
    try {
      const filename = 'epicenter-refinement-latest.txt';
      const fullPath = path.join(this.outputDir, filename);

      const symbolsInfo = fileSymbols 
        ? `\n\n=== EXTRACTED SYMBOLS ===\n${fileSymbols.map(({ file, symbols }) => 
            `File: ${file}\n${symbols.map(s => `  - ${s.exported ? 'exported ' : ''}${s.type}: ${s.name}`).join('\n')}`
          ).join('\n\n')}\n`
        : '';

      const logContent = `Timestamp: ${new Date().toISOString()}
Model: ${model || 'not specified'}
Outcome: ${outcome}

=== PROMPT START ===
${prompt}
=== PROMPT END ===

=== RESPONSE START ===
${response}
=== RESPONSE END ===
${symbolsInfo}`;

      fs.writeFileSync(fullPath, logContent, 'utf8');
      console.log(`[DebugLogger] Saved epicenter refinement to ${filename}`);
    } catch (e) {
      // Log error but don't throw - logging failures shouldn't crash the app
      console.error('[DebugLogger] Failed to log epicenter refinement:', e);
    }
  }

  /**
   * Log completion summary (content-free) for local debugging.
   * Writes 99-completion-summary.json to debug-output/active-session/.
   */
  logCompletionSummary(summary: {
    completionPath?: string;
    stepCount: number;
    hasFinalResponse?: boolean;
    hasToolCalls?: boolean;
    responseLength: number;
    inputLength: number;
  }): void {
    this.save('99-completion-summary.json', {
      ...summary,
      timestamp: new Date().toISOString()
    });
  }

  /**
   * Get the session ID associated with this logger
   * @returns The session ID, or undefined if not set
   */
  getSessionId(): string | undefined {
    return this.sessionId;
  }
}
