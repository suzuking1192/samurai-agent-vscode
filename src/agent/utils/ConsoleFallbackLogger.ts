import { DebugSessionLogger } from "./DebugSessionLogger";

/**
 * ConsoleFallbackLogger - Null Object logger to ensure runtime analysis always logs.
 * Writes to stdout/stderr instead of the file system.
 */
export class ConsoleFallbackLogger extends DebugSessionLogger {
  constructor() {
    // Avoid filesystem operations; pass dummy values.
    super("fallback-session", "");
  }

  // Override to avoid filesystem writes
  protected override save(filename: string, content: string | object): void {
    try {
      const data = typeof content === "string" ? content : JSON.stringify(content, null, 2);
      console.log(`[ConsoleFallbackLogger] ${filename}\n${data}`);
    } catch (error) {
      console.warn("[ConsoleFallbackLogger] Failed to log content:", error);
    }
  }
}





