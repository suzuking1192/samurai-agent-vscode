/**
 * StreamReporter - Helper class for standardized status reporting
 * 
 * Provides a clean interface for emitting real-time status updates
 * (phases, thoughts, tool calls) to the webview during debugging sessions.
 */

import { randomUUID } from 'crypto';
import { DebugStatusUpdateEvent } from '../../common/models/chat-models';
import { SamuraiAgentPanelWebviewViewProvider } from '../../webview/SamuraiAgentPanelWebviewViewProvider';

export class StreamReporter {
  constructor(
    private webviewProvider: SamuraiAgentPanelWebviewViewProvider | null,
    private sessionId: string
  ) {}

  /**
   * Report a status update to the webview
   * @param category - Type of status update: 'phase', 'thought', or 'tool'
   * @param message - Human-readable status message
   */
  report(category: 'phase' | 'thought' | 'tool', message: string): void {
    if (!this.webviewProvider) {
      // Silently fail if webviewProvider is not available
      return;
    }

    try {
      const event: DebugStatusUpdateEvent = {
        type: 'debugStatusUpdate',
        payload: {
          sessionId: this.sessionId,
          stepId: randomUUID(),
          category,
          message,
          timestamp: Date.now()
        }
      };

      this.webviewProvider.postMessage(event);
    } catch (error) {
      // Log but don't throw - status updates should not break the main flow
      console.error('[StreamReporter] Failed to post status update:', error);
    }
  }

  /**
   * Send a log update to the webview (for real-time terminal output)
   * @param log - Raw log text from stdout/stderr
   * @param stream - Stream type: 'stdout' or 'stderr'
   */
  sendLogUpdate(log: string, stream: 'stdout' | 'stderr'): void {
    if (!this.webviewProvider) {
      console.warn(
        `[StreamReporter] sendLogUpdate skipped: no webviewProvider (session: ${this.sessionId})`,
      );
      return;
    }

    try {
      console.debug(
        `[StreamReporter] sendLogUpdate -> session: ${this.sessionId}, stream: ${stream}, length: ${log.length}`,
      );
      const event = {
        type: 'debugLogUpdate',
        payload: {
          sessionId: this.sessionId,
          log,
          stream
        }
      };

      this.webviewProvider.postMessage(event);
    } catch (error) {
      // Log but don't throw - log updates should not break the main flow
      console.error('[StreamReporter] Failed to post log update:', error);
    }
  }
}




