/**
 * RuntimeInspectorTool - "The Observer"
 * 
 * Connects to Node.js debugger via CDP, sets breakpoints, and captures runtime state.
 * Uses RuntimeClient internally for CDP operations.
 */

import { ITool, ToolResult } from '../definitions/ITool';
import { RuntimeInspectorSchema, RuntimeInspectorParams } from '../definitions/ToolSchemas';
import { RuntimeClient } from '../runtime/RuntimeClient';

export class RuntimeInspectorTool implements ITool<RuntimeInspectorParams> {
  name = "runtime-inspector";
  description = "Connects to Node.js debugger via CDP, sets breakpoints, and captures runtime state. Use this to attach to running processes, watch variables, or capture crash information.";
  inputSchema = RuntimeInspectorSchema;

  // Singleton client to maintain connection across tool calls
  private static client = new RuntimeClient();

  async execute(params: RuntimeInspectorParams): Promise<ToolResult> {
    try {
      const { action, port = 9229, target } = params;

      switch (action) {
        case 'attach': {
          const success = await RuntimeInspectorTool.client.connect(port);
          
          if (success) {
            return {
              success: true,
              summary: `Attached to V8 Runtime on port ${port}.`,
              structuredData: { port, attached: true }
            };
          } else {
            return {
              success: false,
              summary: `Failed to connect to V8 Runtime on port ${port}. Ensure the process is running with 'node --inspect' or 'node --inspect-brk' flag.`
            };
          }
        }

        case 'watch': {
          if (!target) {
            return {
              success: false,
              summary: "Target is required for 'watch' action. Provide file and variables/breakpoints."
            };
          }

          // Ensure we're connected
          if (!RuntimeInspectorTool.client.isAttached()) {
            const connected = await RuntimeInspectorTool.client.connect(port);
            if (!connected) {
              return {
                success: false,
                summary: "Not attached to V8 Runtime. Call 'attach' action first or ensure the process is running with --inspect flag."
              };
            }
          }

          try {
            // Determine variables and breakpoints (support legacy mode)
            let variables: string[];
            let breakpoints: Array<{ file: string; line: number }>;

            if (target.variables) {
              // New mode: use variables array
              variables = Array.isArray(target.variables) ? target.variables : [target.variables];
            } else if (target.expression) {
              // Legacy mode: single expression
              variables = [target.expression];
            } else {
              return {
                success: false,
                summary: "Either 'variables' or 'expression' must be provided for 'watch' action."
              };
            }

            if (target.breakpoints) {
              // New mode: use breakpoints array
              const lines = Array.isArray(target.breakpoints) ? target.breakpoints : [target.breakpoints];
              breakpoints = lines.map(line => ({ file: target.file, line }));
            } else if (target.line) {
              // Legacy mode: single line
              breakpoints = [{ file: target.file, line: target.line }];
            } else {
              return {
                success: false,
                summary: "Either 'breakpoints' or 'line' must be provided for 'watch' action."
              };
            }

            // Use new breakpoint-based inspection
            const inspectionResult = await RuntimeInspectorTool.client.inspect({
              variables,
              breakpoints,
              port,
              finishLines: target.finishLines
                ? (Array.isArray(target.finishLines) ? target.finishLines : [target.finishLines])
                : undefined,
              extractFromAllFrames: target.extractFromAllFrames,
              frameIndices: target.frameIndices
            });

            // Format the result
            if (inspectionResult.states.length === 0) {
              return {
                success: true,
                summary: `Breakpoints set at ${target.file} but no pauses occurred.`,
                structuredData: { timeout: true, totalPauses: inspectionResult.totalPauses }
              };
            }

            // Build evidence from all captured states
            const evidence = inspectionResult.states.map((state, idx) => {
              // Find frames with successful extractions
              const relevantFrames = Object.entries(state.variables)
                .filter(([_, frameData]) => {
                  return Object.values(frameData.variables).some(v => v.success);
                })
                .map(([frameIdx, frameData]) => {
                  const successful = Object.entries(frameData.variables)
                    .filter(([_, varData]) => varData.success)
                    .map(([varName, varData]) => {
                      if (varData.isObject) {
                        return `  ${varName} (${varData.type}): ${JSON.stringify(varData.value, null, 2)}`;
                      } else {
                        return `  ${varName} = ${JSON.stringify(varData.value)} (${varData.type})`;
                      }
                    });

                  return `Frame ${frameIdx}: ${frameData.functionName} (line ${frameData.location})\n${successful.join('\n')}`;
                })
                .join('\n\n');

              return {
                file: target.file,
                line: state.lineNumber,
                text: `Pause ${idx + 1} at line ${state.lineNumber}\nCall stack depth: ${state.callStackDepth} frames\n\n${relevantFrames || 'No variables successfully extracted'}`,
                description: `Inspection State ${idx + 1}`
              };
            });

            // Get the last state's values for structured data
            const lastState = inspectionResult.states[inspectionResult.states.length - 1];
            const extractedValues: Record<string, any> = {};
            for (const frameData of Object.values(lastState.variables)) {
              for (const [varName, varData] of Object.entries(frameData.variables)) {
                if (varData.success) {
                  extractedValues[varName] = varData.value;
                }
              }
            }

            return {
              success: true,
              summary: `Captured ${inspectionResult.totalPauses} pause(s) with variable extractions from ${target.file}.`,
              structuredData: {
                states: inspectionResult.states,
                totalPauses: inspectionResult.totalPauses,
                extractedValues
              },
              evidence
            };
          } catch (error: any) {
            return {
              success: false,
              summary: `Failed to watch variables: ${error.message}`
            };
          }
        }

        case 'capture_crash': {
          // Ensure we're connected
          if (!RuntimeInspectorTool.client.isAttached()) {
            const connected = await RuntimeInspectorTool.client.connect(port);
            if (!connected) {
              return {
                success: false,
                summary: "Not attached to V8 Runtime. Call 'attach' action first or ensure the process is running with --inspect flag."
              };
            }
          }

          try {
            const report = await RuntimeInspectorTool.client.waitForCrash(10000);

            if (!report) {
              return {
                success: true,
                summary: "No crash detected within 10 second timeout window. The process may still be running normally.",
                structuredData: { timeout: true }
              };
            }

            return {
              success: true,
              summary: `Captured crash: ${report.error} at ${report.location.file}:${report.location.line}`,
              structuredData: report,
              evidence: [{
                file: report.location.file,
                line: report.location.line,
                text: `Error: ${report.error}\n\nLocal Variables:\n${report.locals.map(v => `  ${v.name}: ${v.value} (${v.type})`).join('\n')}`,
                description: "Crash State"
              }]
            };
          } catch (error: any) {
            return {
              success: false,
              summary: `Failed to capture crash: ${error.message}`
            };
          }
        }

        case 'disconnect': {
          await RuntimeInspectorTool.client.disconnect();
          
          return {
            success: true,
            summary: "Disconnected from V8 Runtime.",
            structuredData: { attached: false }
          };
        }

        default:
          return {
            success: false,
            summary: `Invalid action: ${action}`
          };
      }
    } catch (error: any) {
      return {
        success: false,
        summary: `Runtime Inspector operation failed: ${error.message}`
      };
    }
  }

  /**
   * Cleanup method for extension deactivation
   */
  public cleanup(): void {
    RuntimeInspectorTool.client.disconnect().catch(() => {
      // Ignore errors during cleanup
    });
  }
}

