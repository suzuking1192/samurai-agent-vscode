/**
 * RuntimeClient - V8 WebSocket Client (CDP Wrapper)
 * 
 * Manages the Chrome DevTools Protocol connection to a running Node.js process.
 * Handles connection lifecycle, logpoint injection, and crash capture.
 */

import CDP from 'chrome-remote-interface';
import * as path from 'path';
import * as fs from 'fs';
import { pathToFileURL, fileURLToPath } from 'url';
import { EventEmitter } from 'events';

export interface CrashReport {
  error: string;
  location: {
    file: string;
    line: number;
  };
  locals: Array<{
    name: string;
    value: string | number | boolean | null;
    type: string;
  }>;
}

export interface VariableExtractionResult {
  success: boolean;
  value?: any;
  type?: string;
  isObject?: boolean;
  objectId?: string;
  error?: string;
}

export interface FrameExtractionData {
  functionName: string;
  location: number;
  variables: Record<string, VariableExtractionResult>;
}

export interface InspectionState {
  pauseNumber: number;
  lineNumber: number;
  callStackDepth: number;
  callFrames: Array<{ index: number; functionName: string; location: number }>;
  variables: Record<number, FrameExtractionData>;
  timestamp: string;
}

export interface InspectionOptions {
  variables: string | string[];
  breakpoints: Array<{ file: string; line: number }>;
  urlRegex?: string;
  port?: number;
  finishLines?: number | number[];
  extractFromAllFrames?: boolean;
  frameIndices?: number | number[];
  /** 
   * Wait for scripts matching urlRegex to be parsed before setting breakpoints.
   * Essential for TypeScript files where ts-node parses scripts after resume.
   */
  waitForScripts?: boolean;
  /** Timeout in ms to wait for scripts to be parsed (default: 5000) */
  scriptWaitTimeoutMs?: number;
}

export class RuntimeClient extends EventEmitter {
  private client: CDP.Client | null = null;
  private attached = false;
  private pausedRelayInstalled = false;
  private scriptIdToUrl = new Map<string, string>();
  private sourceMapCache = new Map<string, any>();

  constructor() {
    super();
  }
  /**
   * Normalize paths for consistent matching across platforms and URL formats.
   * Strips file:// protocol and normalizes separators.
   */
  private normalizePath(filePath: string): string {
    // Strip file:// or file:/ protocol early to avoid double prefixes
    const withoutProtocol = filePath.replace(/^file:(\/\/)?/, '');
    const resolvedPath = path.isAbsolute(withoutProtocol) ? withoutProtocol : path.resolve(withoutProtocol);
    let realPath = resolvedPath;
    try {
      realPath = fs.realpathSync(resolvedPath);
    } catch {
      // If realpath fails (e.g., file does not exist), fall back to resolved path
    }
    return path.normalize(realPath);
  }

  private escapeRegex(str: string): string {
    return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }

  /**
   * Convert a filesystem path to a regex that matches V8 script URLs.
   * Ensures Windows backslashes are handled and matches end of path.
   */
  private fileToUrlRegex(filePath: string): string {
    const normalized = this.normalizePath(filePath).replace(/\\/g, '/');
    const escaped = this.escapeRegex(normalized);
    return `.*${escaped}.*`;
  }

  /**
   * Generate path variants to handle symlinks and macOS /private path differences.
   */
  private buildPathVariants(filePath: string): string[] {
    const variants = new Set<string>();

    const resolved = path.isAbsolute(filePath) ? filePath : path.resolve(filePath);
    variants.add(this.normalizePath(resolved).replace(/\\/g, '/'));

    // Also include basename to match when only file name is available in URLs
    variants.add(path.basename(resolved));

    try {
      const realPath = fs.realpathSync(resolved);
      variants.add(this.normalizePath(realPath).replace(/\\/g, '/'));
    } catch {
      // ignore realpath errors
    }

    // If targeting transpiled JS, also include sibling TS path (and vice versa handled elsewhere)
    if (resolved.endsWith('.js')) {
      const tsCandidate = resolved.replace(/\.js$/, '.ts');
      variants.add(this.normalizePath(tsCandidate).replace(/\\/g, '/'));

      // Also consider source map pointing one level up (e.g., dist/foo.js -> src/foo.ts)
      const dir = path.dirname(resolved);
      const base = path.basename(resolved, '.js');
      const tsSourceMapCandidate = path.join(dir, '..', `${base}.ts`);
      variants.add(this.normalizePath(tsSourceMapCandidate).replace(/\\/g, '/'));

      // Also consider a sibling "src" directory if present (dist/entry.js -> dist/../src/entry.ts)
      const tsSrcSibling = path.join(dir, '..', 'src', `${base}.ts`);
      variants.add(this.normalizePath(tsSrcSibling).replace(/\\/g, '/'));

      // Last resort: realpath of the candidate (in case of symlinks)
      [tsCandidate, tsSourceMapCandidate, tsSrcSibling].forEach(candidate => {
        try {
          const real = fs.realpathSync(candidate);
          variants.add(this.normalizePath(real).replace(/\\/g, '/'));
        } catch {
          // ignore
        }
      });
    }

    // macOS often reports /private/var while users pass /var
    Array.from(variants).forEach((variant) => {
      if (variant.startsWith('/var/')) {
        variants.add(variant.replace(/^\/var\//, '/private/var/'));
      }
      if (variant.startsWith('/private/var/')) {
        variants.add(variant.replace(/^\/private\/var\//, '/var/'));
      }
    });

    return Array.from(variants);
  }

  /**
   * Minimal VLQ decoder for source map segments.
   */
  private decodeVLQSegment(segment: string): number[] {
    const results: number[] = [];
    let value = 0;
    let shift = 0;

    for (const char of segment) {
      const digit = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'.indexOf(char);
      const continuation = digit & 32;
      const digitValue = digit & 31;
      value += digitValue << shift;
      shift += 5;

      if (!continuation) {
        const shouldNegate = value & 1;
        const decoded = value >> 1;
        results.push(shouldNegate ? -decoded : decoded);
        value = 0;
        shift = 0;
      }
    }
    return results;
  }

  /**
   * Resolve a source map path from a script URL and sourceMapURL.
   */
  private resolveSourceMapPath(scriptUrl: string, sourceMapURL: string): string | null {
    if (!sourceMapURL) return null;
    try {
      if (sourceMapURL.startsWith('file:')) {
        return this.normalizePath(fileURLToPath(sourceMapURL));
      }
    } catch {
      // fall through
    }

    const scriptPath = this.normalizePath(scriptUrl);
    const dir = path.dirname(scriptPath);
    return this.normalizePath(path.resolve(dir, sourceMapURL));
  }

  /**
   * Find generated line number (1-based) for a given source file/line using a source map.
   */
  private getGeneratedLineFromMap(mapPath: string, sourceFile: string, sourceLine1: number): number | null {
    const cached = this.sourceMapCache.get(mapPath);
    let map: any;
    if (cached) {
      map = cached;
    } else {
      try {
        const raw = fs.readFileSync(mapPath, 'utf-8');
        map = JSON.parse(raw);
        this.sourceMapCache.set(mapPath, map);
      } catch {
        return null;
      }
    }

    if (!map?.sources || !map.mappings) return null;

    const sourceRoot = map.sourceRoot || '';
    const mapDir = path.dirname(mapPath);
    const normalizeCandidate = (src: string) =>
      this.normalizePath(path.resolve(mapDir, sourceRoot, src));

    const targetNormalized = this.normalizePath(sourceFile);
    let targetIndex = map.sources.findIndex((s: string) => normalizeCandidate(s) === targetNormalized);
    if (targetIndex < 0) {
      targetIndex = map.sources.findIndex((s: string) => path.basename(s) === path.basename(targetNormalized));
    }
    if (targetIndex < 0) return null;

    let generatedLine = 0;
    let generatedColumn = 0;
    let sourceIndex = 0;
    let sourceLine = 0;
    let sourceColumn = 0;

    const lines = map.mappings.split(';');
    for (let line = 0; line < lines.length; line++) {
      const segments = lines[line].split(',').filter(Boolean);
      generatedColumn = 0;
      for (const seg of segments) {
        const decoded = this.decodeVLQSegment(seg);
        if (decoded.length < 4) continue;

        generatedColumn += decoded[0];
        sourceIndex += decoded[1];
        sourceLine += decoded[2];
        sourceColumn += decoded[3];

        if (sourceIndex === targetIndex && sourceLine === sourceLine1 - 1) {
          return line + 1; // convert to 1-based
        }
      }
      generatedLine++;
    }

    return null;
  }

  /**
   * Fallback: locate generated line by matching TS source line content within the transpiled JS.
   * Uses context (surrounding lines) to improve accuracy when similar code appears multiple times.
   */
  private getGeneratedLineByContent(
    scriptPath: string,
    sourceFile: string,
    sourceLine1: number,
    scriptContent?: string
  ): number | null {
    try {
      const tsLines = fs.readFileSync(sourceFile, 'utf-8').split('\n');
      const jsLines = scriptContent
        ? scriptContent.split('\n')
        : fs.readFileSync(scriptPath, 'utf-8').split('\n');
      const targetLine = (tsLines[sourceLine1 - 1] || '').trim();
      if (!targetLine) return null;

      // Get context lines for better matching
      const contextBefore = sourceLine1 > 1 ? (tsLines[sourceLine1 - 2] || '').trim() : '';
      const contextAfter = sourceLine1 < tsLines.length ? (tsLines[sourceLine1] || '').trim() : '';

      // Find all matches for the target line
      const matches: number[] = [];
      for (let i = 0; i < jsLines.length; i++) {
        if (jsLines[i].trim().includes(targetLine)) {
          matches.push(i);
        }
      }

      if (matches.length === 0) return null;
      if (matches.length === 1) return matches[0] + 1;

      // Multiple matches - use context to find the best one
      let bestMatch = matches[0];
      let bestScore = 0;

      for (const matchIdx of matches) {
        let score = 0;
        // Check line before
        if (contextBefore && matchIdx > 0) {
          if (jsLines[matchIdx - 1].trim().includes(contextBefore)) {
            score += 2;
          }
        }
        // Check line after
        if (contextAfter && matchIdx < jsLines.length - 1) {
          if (jsLines[matchIdx + 1].trim().includes(contextAfter)) {
            score += 2;
          }
        }
        // Prefer matches closer to the expected proportional position
        const expectedRatio = sourceLine1 / tsLines.length;
        const actualRatio = matchIdx / jsLines.length;
        const ratioDiff = Math.abs(expectedRatio - actualRatio);
        if (ratioDiff < 0.1) score += 1;

        if (score > bestScore) {
          bestScore = score;
          bestMatch = matchIdx;
        }
      }

      return bestMatch + 1;
    } catch {
      // ignore
    }
    return null;
  }

  /**
   * Debug helper: log scriptParsed events for fixture files
   */
  private logScriptParsed(params: any): void {
    if (params?.url) {
      // stderr so Jest surfaces it
      // eslint-disable-next-line no-console
      console.error(`🔍 V8 SCRIPT: ${params.url} (id=${params.scriptId}, sourceMap=${!!params.sourceMapURL})`);
      this.emit('scriptParsed', params);
    }
  }

  /**
   * Relay Debugger.paused events to external listeners.
   */
  private installPausedRelay(): void {
    if (!this.client || this.pausedRelayInstalled) {
      return;
    }
    this.client.Debugger.paused((params: any) => {
      this.emit('paused', params);
    });
    this.pausedRelayInstalled = true;
  }

  /**
   * Connect to a running Node.js process via CDP
   * 
   * Uses retry logic with exponential backoff as a safety net. Since NodeProcessTool
   * already waits for "Debugger listening" signal before resolving spawn(), this
   * connection should succeed immediately 99% of the time.
   * 
   * @param port - Debug port (default: 9229)
   * @param retries - Maximum number of retry attempts (default: 2)
   * @param initialDelayMs - Initial delay before first retry in milliseconds (default: 100)
   * @returns true if connection successful, false otherwise
   */
  async connect(port: number = 9229, retries: number = 2, initialDelayMs: number = 100): Promise<boolean> {
    const maxAttempts = retries + 1; // Total attempts = retries + initial attempt
    
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      try {
        // Add timeout wrapper to prevent hanging (5 seconds per attempt)
        const connectionPromise = CDP({ port });
        const timeoutPromise = new Promise((_, reject) => 
          setTimeout(() => reject(new Error('Connection timeout')), 5000)
        );
        
        this.client = await Promise.race([connectionPromise, timeoutPromise]) as CDP.Client;
        const { Runtime, Debugger, Console } = this.client;

        // Enable required CDP domains
        await Promise.all([
          Runtime.enable(),
          Debugger.enable(),
          Console.enable()
        ]);
        this.installPausedRelay();

        this.attached = true;
        if (attempt > 0) {
          console.log(`[RuntimeClient] Connected to port ${port} after ${attempt + 1} attempt(s)`);
        }
        return true;
      } catch (err: any) {
        const isLastAttempt = attempt === maxAttempts - 1;
        
        if (isLastAttempt) {
          // Final attempt failed, clean up and return false
          this.attached = false;
          this.client = null;
          const errorMsg = err?.message || 'Unknown error';
          console.warn(`[RuntimeClient] Failed to connect to port ${port} after ${maxAttempts} attempt(s): ${errorMsg}`);
          return false;
        }
        
        // Exponential backoff: delay = initialDelayMs * 2^attempt
        const delayMs = initialDelayMs * Math.pow(2, attempt);
        console.log(`[RuntimeClient] Connection attempt ${attempt + 1} failed, retrying in ${delayMs}ms...`);
        await new Promise(resolve => setTimeout(resolve, delayMs));
      }
    }
    
    // Should never reach here, but TypeScript needs it
    this.attached = false;
    this.client = null;
    return false;
  }

  /**
   * Disconnect from the CDP session
   */
  async disconnect(): Promise<void> {
    if (this.client) {
      try {
        await this.client.close();
      } catch (err) {
        // Ignore errors during cleanup
      }
      this.attached = false;
      this.client = null;
    }
  }

  /**
   * Check if currently attached to a process
   */
  isAttached(): boolean {
    return this.attached && this.client !== null;
  }

  /**
   * Enable console domain and install paused relay for external listeners.
   */
  async enableConsole(): Promise<void> {
    if (!this.attached || !this.client) {
      throw new Error("Not attached to V8 Runtime. Call connect() first.");
    }
    await this.client.Console.enable();
    this.installPausedRelay();
  }

  /**
   * Public helper to set breakpoints by file path + line.
   */
  async setBreakpointByUrl(filePath: string, lineNumber: number): Promise<void> {
    if (!this.attached || !this.client) {
      throw new Error("Not attached to V8 Runtime. Call connect() first.");
    }

    const { Debugger } = this.client;
    const variants = this.buildPathVariants(filePath);
    const basename = path.basename(filePath);
    const regexes = variants.map(v => this.fileToUrlRegex(v));
    const matchers = regexes.map(r => new RegExp(r));

    // set by urlRegex (lazy breakpoint)
    for (const regex of regexes) {
      try {
        await Debugger.setBreakpointByUrl({
          urlRegex: regex,
          lineNumber: lineNumber - 1,
          columnNumber: 0
        });
      } catch (err) {
        console.warn(`[RuntimeClient] Failed to set breakpoint by URL ${regex}:${lineNumber}`, (err as any)?.message || err);
      }
    }

    // also set by scriptId when matching script is parsed
    Debugger.scriptParsed(async (params: any) => {
      this.logScriptParsed(params);
      const url = params.url || '';
      const sourceMapUrl = (params as any).sourceMapURL || '';
      const matches =
        matchers.some(m => m.test(url)) ||
        (!!sourceMapUrl && sourceMapUrl.includes(basename)) ||
        (url === '' && sourceMapUrl === '' && params.scriptId);

      if (matches) {
        try {
          await Debugger.setBreakpoint({
            location: {
              scriptId: params.scriptId,
              lineNumber: lineNumber - 1
            }
          });
        } catch (err) {
          console.warn(`[RuntimeClient] Failed to set scriptId breakpoint for ${filePath}:${lineNumber}`, (err as any)?.message || err);
        }
      }
    });
  }

  /**
   * Alias for disconnect
   */
  async close(): Promise<void> {
    await this.disconnect();
  }

  /**
   * Inject a non-breaking logpoint (virtual breakpoint that logs without pausing)
   * Uses the "logpoint trick": condition evaluates to false, so execution never pauses
   * 
   * @param fileUrlRegex - Regex pattern to match file URL in V8's format
   * @param lineNumber - Line number (1-based, converted to 0-based for V8)
   * @param expression - Variable or expression to evaluate and log
   */
  async injectLogpoint(fileUrlRegex: string, lineNumber: number, expression: string): Promise<void> {
    if (!this.attached || !this.client) {
      throw new Error("Not attached to V8 Runtime. Call connect() first.");
    }

    // V8 trick: 'console.log(...); false' -> evaluates to false -> never pauses execution
    const condition = `console.log('[SAMURAI_WATCH] ${expression} =', ${expression}); false`;

    await this.client.Debugger.setBreakpointByUrl({
      urlRegex: fileUrlRegex,
      lineNumber: lineNumber - 1, // V8 is 0-indexed
      condition
    });
  }

  /**
   * Resume execution of a process that was paused with --inspect-brk
   * This unpauses the process so it can actually run and hit logpoints
   * 
   * Critical: Without this, processes started with --inspect-brk remain paused forever
   * and logpoints will never be hit, causing timeouts.
   */
  async resume(): Promise<void> {
    if (!this.attached || !this.client) {
      throw new Error("Not attached to V8 Runtime. Call connect() first.");
    }

    // First try standard resume for breakpoint pauses
    try {
      await this.client.Debugger.resume();
    } catch (err) {
      // Ignore if not paused
    }

    // Also attempt startup resume for --inspect-brk
    try {
      await this.client.Runtime.runIfWaitingForDebugger();
    } catch (err) {
      // Ignore if already running
    }
  }

  /**
   * Wait for an uncaught exception and capture local variables
   * 
   * @param timeoutMs - Timeout in milliseconds (default: 10000)
   * @returns Crash report with error details and local variables, or null if timeout
   */
  async waitForCrash(timeoutMs: number = 10000): Promise<CrashReport | null> {
    if (!this.attached || !this.client) {
      throw new Error("Not attached to V8 Runtime. Call connect() first.");
    }

    return new Promise<CrashReport | null>(async (resolve) => {
      let resolved = false;
      const timeout = setTimeout(() => {
        if (!resolved) {
          resolved = true;
          resolve(null); // Timed out
        }
      }, timeoutMs);

      try {
        // Set pause on uncaught exceptions
        await this.client!.Debugger.setPauseOnExceptions({ state: 'uncaught' });

        // Set up paused event listener (fires when exception occurs)
        this.client!.Debugger.paused(async (params: any) => {
          if (resolved) return;
          resolved = true;
          clearTimeout(timeout);

          try {
            const topFrame = params.callFrames?.[0];
            if (!topFrame) {
              await this.cleanupPauseOnExceptions();
              resolve({
                error: params.data?.description || params.reason || "Unknown Error",
                location: { file: "unknown", line: 0 },
                locals: []
              });
              return;
            }

            const locals = await this.extractLocals(topFrame);

            await this.client!.Debugger.resume();
            await this.cleanupPauseOnExceptions();

            resolve({
              error: params.data?.description || params.reason || "Unknown Error",
              location: {
                file: topFrame.url || "unknown",
                line: (topFrame.location?.lineNumber || 0) + 1 // Convert to 1-based
              },
              locals
            });
          } catch (error: any) {
            // Ensure cleanup happens even on error
            await this.cleanupPauseOnExceptions();
            resolve({
              error: `Failed to extract crash data: ${error.message}`,
              location: { file: "unknown", line: 0 },
              locals: []
            });
          }
        });
      } catch (error: any) {
        // Cleanup on setup error
        clearTimeout(timeout);
        await this.cleanupPauseOnExceptions();
        if (!resolved) {
          resolved = true;
          resolve(null);
        }
      }
    });
  }

  /**
   * Reset pause on exceptions state (cleanup to prevent zombie state)
   */
  private async cleanupPauseOnExceptions(): Promise<void> {
    if (this.client) {
      try {
        await this.client.Debugger.setPauseOnExceptions({ state: 'none' });
      } catch (err) {
        // Ignore cleanup errors
      }
    }
  }

  /**
   * Extract local variables from a call frame
   * Handles RemoteObject references - sticks to primitives for MVP
   * 
   * @param frame - V8 call frame from paused event
   * @returns Array of local variable name/value/type pairs
   */
  private async extractLocals(frame: any): Promise<Array<{
    name: string;
    value: string | number | boolean | null;
    type: string;
  }>> {
    if (!this.client) {
      return [];
    }

    // Find the local scope in the scope chain
    const localScope = frame.scopeChain?.find((s: any) => s.type === 'local');
    if (!localScope || !localScope.object?.objectId) {
      return [];
    }

    try {
      const { result } = await this.client.Runtime.getProperties({
        objectId: localScope.object.objectId,
        ownProperties: true
      });

      if (!result || !Array.isArray(result)) {
        return [];
      }

      // Extract variable values - handle RemoteObject references
      // For MVP, we stick to primitives (string, number, boolean, null)
      // Complex objects would need recursive expansion which we skip for now
      return result.map((p: any) => {
        const propValue = p.value;
        
        // Handle primitive types directly
        if (propValue?.value !== undefined && 
            (typeof propValue.value === 'string' || 
             typeof propValue.value === 'number' || 
             typeof propValue.value === 'boolean' || 
             propValue.value === null)) {
          return {
            name: p.name,
            value: propValue.value,
            type: propValue.type || 'unknown'
          };
        }

        // For objects/arrays, use description as fallback
        // This gives "[object Object]" or "[Array]" but is better than nothing
        const description = propValue?.description || propValue?.value?.description || 'unknown';
        return {
          name: p.name,
          value: description,
          type: propValue?.type || propValue?.subtype || 'object'
        };
      });
    } catch (error: any) {
      // Return empty array on error rather than failing completely
      return [];
    }
  }

  /**
   * Wait for logpoint output or crash
   * Listens to Console.messageAdded events to capture logpoint output
   * Falls back to waitForCrash if no log received
   * 
   * @param timeoutMs - Timeout in milliseconds (default: 10000)
   * @returns Object with value from logpoint or crash report, or null if timeout
   */
  async waitForLogOrCrash(timeoutMs: number = 10000): Promise<{
    value?: any;
    crash?: CrashReport;
  } | null> {
    if (!this.attached || !this.client) {
      throw new Error("Not attached to V8 Runtime. Call connect() first.");
    }

    return new Promise<{
      value?: any;
      crash?: CrashReport;
    } | null>(async (resolve) => {
      let resolved = false;
      const timeout = setTimeout(() => {
        if (!resolved) {
          resolved = true;
          resolve(null); // Timed out
        }
      }, timeoutMs);

      try {
        // Set up console message listener for logpoint output
        this.client!.Console.messageAdded((params: any) => {
          if (resolved) return;

          const message = params.message;
          const text = message.text || '';

          // Check if this is a SAMURAI_WATCH logpoint output
          // Format: "[SAMURAI_WATCH] expression = value"
          const samuraiWatchMatch = text.match(/\[SAMURAI_WATCH\]\s+(.+?)\s*=\s*(.+)/);
          
          if (samuraiWatchMatch) {
            resolved = true;
            clearTimeout(timeout);

            // Extract the value (second capture group)
            const valueStr = samuraiWatchMatch[2];
            let value: any;
            
            try {
              // Try to parse as JSON first
              value = JSON.parse(valueStr);
            } catch {
              // If not JSON, try to infer type
              if (valueStr === 'undefined') {
                value = undefined;
              } else if (valueStr === 'null') {
                value = null;
              } else if (valueStr === 'true') {
                value = true;
              } else if (valueStr === 'false') {
                value = false;
              } else if (!isNaN(Number(valueStr)) && valueStr.trim() !== '') {
                value = Number(valueStr);
              } else {
                // Keep as string
                value = valueStr;
              }
            }

            resolve({ value });
          }
        });

        // Also set up crash listener as fallback
        await this.client!.Debugger.setPauseOnExceptions({ state: 'uncaught' });

        this.client!.Debugger.paused(async (params: any) => {
          if (resolved) return;
          resolved = true;
          clearTimeout(timeout);

          try {
            const topFrame = params.callFrames?.[0];
            if (!topFrame) {
              await this.cleanupPauseOnExceptions();
              resolve({
                crash: {
                  error: params.data?.description || params.reason || "Unknown Error",
                  location: { file: "unknown", line: 0 },
                  locals: []
                }
              });
              return;
            }

            const locals = await this.extractLocals(topFrame);

            await this.client!.Debugger.resume();
            await this.cleanupPauseOnExceptions();

            resolve({
              crash: {
                error: params.data?.description || params.reason || "Unknown Error",
                location: {
                  file: topFrame.url || "unknown",
                  line: (topFrame.location?.lineNumber || 0) + 1 // Convert to 1-based
                },
                locals
              }
            });
          } catch (error: any) {
            await this.cleanupPauseOnExceptions();
            resolve({
              crash: {
                error: `Failed to extract crash data: ${error.message}`,
                location: { file: "unknown", line: 0 },
                locals: []
              }
            });
          }
        });
      } catch (error: any) {
        clearTimeout(timeout);
        await this.cleanupPauseOnExceptions();
        if (!resolved) {
          resolved = true;
          resolve(null);
        }
      }
    });
  }

  /**
   * Recursively extracts object properties up to a specified depth
   * 
   * @param Runtime - CDP Runtime domain
   * @param objectId - Object ID from V8
   * @param depth - Current recursion depth
   * @param maxDepth - Maximum recursion depth (default: 3)
   * @returns Extracted object properties or '[Max depth reached]'
   */
  private async extractObjectProperties(
    Runtime: any,
    objectId: string,
    depth: number = 0,
    maxDepth: number = 3
  ): Promise<any> {
    if (depth >= maxDepth) {
      return '[Max depth reached]';
    }

    try {
      const props = await Runtime.getProperties({
        objectId: objectId,
        ownProperties: true,
        generatePreview: true
      });

      if (!props.result || props.result.length === 0) {
        return '{}';
      }

      const result: any = {};

      for (const prop of props.result.slice(0, 15)) {
        const name = prop.name;

        if (!prop.value) {
          result[name] = 'N/A';
          continue;
        }

        const val = prop.value;

        if (val.type === 'string') {
          result[name] = val.value;
        } else if (val.type === 'number' || val.type === 'boolean') {
          result[name] = val.value;
        } else if (val.type === 'undefined') {
          result[name] = undefined;
        } else if (val.subtype === 'null') {
          result[name] = null;
        } else if (val.subtype === 'array' && val.objectId) {
          // Extract array elements
          const arrayProps = await this.extractObjectProperties(Runtime, val.objectId, depth + 1, maxDepth);
          if (typeof arrayProps === 'object') {
            // Convert object to array (filter out 'length' property)
            const arr: any[] = [];
            for (const key of Object.keys(arrayProps)) {
              if (key !== 'length' && !isNaN(parseInt(key))) {
                arr[parseInt(key)] = arrayProps[key];
              }
            }
            result[name] = arr;
          } else {
            result[name] = arrayProps;
          }
        } else if (val.type === 'object' && val.objectId) {
          // Recursively extract nested object
          result[name] = await this.extractObjectProperties(Runtime, val.objectId, depth + 1, maxDepth);
        } else if (val.type === 'function') {
          result[name] = `[Function: ${val.description?.split('(')[0] || 'anonymous'}]`;
        } else {
          result[name] = val.description || `[${val.type}]`;
        }
      }

      if (props.result.length > 15) {
        result['...'] = `(+${props.result.length - 15} more properties)`;
      }

      return result;
    } catch (err: any) {
      return `[Error: ${err.message}]`;
    }
  }

  /**
   * Evaluates a variable in the current call frame and returns its value
   * 
   * @param Debugger - CDP Debugger domain
   * @param Runtime - CDP Runtime domain
   * @param callFrameId - Call frame ID from paused event
   * @param variableName - Variable name to evaluate
   * @returns Variable extraction result with value, type, and error info
   */
  private async evaluateVariable(
    Debugger: any,
    Runtime: any,
    callFrameId: string,
    variableName: string
  ): Promise<VariableExtractionResult> {
    try {
      // Check if we're still paused before evaluating
      // If not, return an error result
      // For objects, we need objectId to inspect properties, so use returnByValue: false
      // For primitives, returnByValue: true is more efficient
      // We'll try returnByValue: true first, and if we get an object without objectId, retry
      let evalResult = await Debugger.evaluateOnCallFrame({
        callFrameId,
        expression: variableName,
        returnByValue: true
      });

      let result = evalResult.result;
      const exceptionDetails = evalResult.exceptionDetails;

      // Diagnostic logging
      console.log(`[RuntimeClient] evaluateVariable '${variableName}': type=${result?.type}, subtype=${result?.subtype}, className=${result?.className}`);
      if (result?.value !== undefined) {
        const valuePreview = typeof result.value === 'string' 
          ? result.value.substring(0, 100) 
          : JSON.stringify(result.value)?.substring(0, 100);
        console.log(`[RuntimeClient] evaluateVariable '${variableName}': value preview = ${valuePreview}`);
      }

      // If we got an object but no objectId (complex object that can't be serialized),
      // retry without returnByValue to get objectId for property inspection
      if (result && result.type === 'object' && !result.objectId) {
        const retryResult = await Debugger.evaluateOnCallFrame({
          callFrameId,
          expression: variableName,
          returnByValue: false
        });
        if (retryResult.result && retryResult.result.objectId) {
          result = retryResult.result;
        }
      }

      // Check if there was an exception
      if (exceptionDetails) {
        let errorMessage = 'Evaluation exception';

        // Try to get the full error message
        if (exceptionDetails.exception) {
          if (exceptionDetails.exception.description) {
            errorMessage = exceptionDetails.exception.description;
          } else if (exceptionDetails.exception.value) {
            errorMessage = String(exceptionDetails.exception.value);
          } else if (exceptionDetails.exception.objectId) {
            // Try to get properties of the exception object
            try {
              const props = await Runtime.getProperties({
                objectId: exceptionDetails.exception.objectId,
                ownProperties: true
              });
              if (props.result && props.result.length > 0) {
                const messageProp = props.result.find((p: any) => p.name === 'message');
                if (messageProp && messageProp.value) {
                  errorMessage = messageProp.value.value || messageProp.value.description || errorMessage;
                }
              }
            } catch (e) {
              // Fall through to use text
            }
          }
        }

        if (exceptionDetails.text && exceptionDetails.text !== 'Uncaught') {
          errorMessage = exceptionDetails.text + (errorMessage !== 'Evaluation exception' ? ': ' + errorMessage : '');
        }

        return {
          success: false,
          error: errorMessage,
          value: undefined
        };
      }

      // Handle undefined
      if (result.type === 'undefined') {
        return { success: false, error: 'undefined', value: undefined };
      }

      // If we got a value directly, return it
      if (result.value !== undefined) {
        return { success: true, value: result.value, type: result.type };
      }

      // If it's an object reference, try to get its properties recursively
      if (result.type === 'object') {
        // If we have an objectId, we can inspect its properties
        if (result.objectId) {
          try {
            // Recursively extract nested properties
            const extractedObj = await this.extractObjectProperties(Runtime, result.objectId, 0, 3);

            return {
              success: true,
              value: extractedObj,
              type: result.type,
              isObject: true,
              objectId: result.objectId
            };
          } catch (propErr: any) {
            // If we can't get properties, fall through to description
          }
        }

        // Fallback: return object info with description
        const desc = result.description;
        if (desc === '[object Object]' || desc === 'Object') {
          return {
            success: true,
            value: `[Object${result.subtype ? ': ' + result.subtype : ''}${result.className ? ' (' + result.className + ')' : ''}]`,
            type: result.type,
            isObject: true
          };
        }

        return {
          success: true,
          value: desc || `[Object: ${result.subtype || result.className || 'object'}]`,
          type: result.type,
          isObject: true
        };
      }

      // Fallback: return description or type
      return {
        success: true,
        value: result.description || `[${result.type}]`,
        type: result.type
      };
    } catch (evalErr: any) {
      const errorMsg = evalErr?.message || String(evalErr);
      // Handle "Can only perform operation while paused" more gracefully
      if (errorMsg.includes('Can only perform operation while paused')) {
        return { 
          success: false, 
          error: 'Debugger not paused (process may have exited)', 
          value: undefined 
        };
      }
      return { success: false, error: errorMsg || 'Unknown error', value: undefined };
    }
  }

  /**
   * Extracts variables from a specific call frame
   * 
   * @param Debugger - CDP Debugger domain
   * @param Runtime - CDP Runtime domain
   * @param frame - Call frame from paused event
   * @param variableNames - Array of variable names to extract
   * @param frameIndex - Frame index for logging
   * @returns Record of variable names to extraction results
   */
  private async extractVariablesFromFrame(
    Debugger: any,
    Runtime: any,
    frame: any,
    variableNames: string[],
    frameIndex: number = 0
  ): Promise<Record<string, VariableExtractionResult>> {
    const extracted: Record<string, VariableExtractionResult> = {};

    for (const varName of variableNames) {
      const result = await this.evaluateVariable(Debugger, Runtime, frame.callFrameId, varName);
      extracted[varName] = result;
    }

    return extracted;
  }

  /**
   * Checks if a frame is a Node.js internal frame (should be filtered out)
   * 
   * @param frame - Call frame from paused event
   * @returns true if frame is Node.js internal
   */
  private isNodeInternalFrame(frame: any): boolean {
    const functionName = (frame.functionName || '').toLowerCase();
    const url = frame.url || '';

    const internalPatterns = [
      'tracesync',
      'wrapmoduleload',
      'executeuserentrypoint',
      'module._compile',
      'module.load',
      'function._load',
      'node:internal',
      'node:diagnostics'
    ];

    return internalPatterns.some(pattern =>
      functionName.includes(pattern) || url.includes(pattern)
    );
  }

  /**
   * Extracts variables from the current paused state (from all call frames or specific frames)
   * 
   * @param Debugger - CDP Debugger domain
   * @param Runtime - CDP Runtime domain
   * @param callFrames - Array of call frames from paused event
   * @param variableNames - Array of variable names to extract
   * @param options - Extraction options
   * @returns Record of frame indices to frame extraction data
   */
  private async extractVariables(
    Debugger: any,
    Runtime: any,
    callFrames: any[],
    variableNames: string[],
    options: {
      extractFromAllFrames?: boolean;
      frameIndices?: number[];
      filterInternalFrames?: boolean;
    } = {}
  ): Promise<Record<number, FrameExtractionData>> {
    const {
      extractFromAllFrames = false,
      frameIndices = [0],
      filterInternalFrames = true
    } = options;

    const allFramesData: Record<number, FrameExtractionData> = {};

    // Determine which frames to extract from
    let framesToExtract = extractFromAllFrames
      ? callFrames.map((_, idx) => idx)
      : frameIndices;

    // Filter out internal frames if requested
    if (filterInternalFrames) {
      framesToExtract = framesToExtract.filter(idx => {
        if (idx >= callFrames.length) return false;
        return !this.isNodeInternalFrame(callFrames[idx]);
      });
    }

    for (const frameIdx of framesToExtract) {
      if (frameIdx >= callFrames.length) continue;

      const frame = callFrames[frameIdx];
      const functionName = frame.functionName || '(anonymous)';
      const location = frame.location.lineNumber + 1;
      const frameUrl = frame.url || this.scriptIdToUrl.get(frame.location?.scriptId) || '(unknown)';

      console.log(`[RuntimeClient] Extracting from frame ${frameIdx}: ${functionName} at ${frameUrl}:${location}`);

      const extracted = await this.extractVariablesFromFrame(Debugger, Runtime, frame, variableNames, frameIdx);
      allFramesData[frameIdx] = {
        functionName,
        location,
        variables: extracted
      };
    }

    return allFramesData;
  }

  /**
   * Main inspector function - connects to Chrome DevTools Protocol and extracts variables at breakpoints
   * 
   * @param options - Configuration options
   * @returns Object containing all extracted variable states
   */
  async inspect(options: InspectionOptions): Promise<{
    states: InspectionState[];
    totalPauses: number;
    parsedScripts?: Array<{ url: string; normalized: string; sourceMapURL?: string; isTarget?: boolean }>;
    bindings?: Array<{ url: string; line: number; success: boolean; locations?: any[] }>;
    pauseMismatches?: Array<{ url: string; line: number }>;
    breakpointInstallSucceeded?: boolean;
  }> {
    if (!this.attached || !this.client) {
      throw new Error("Not attached to V8 Runtime. Call connect() first.");
    }

    // Normalize inputs to arrays
    const variableNames = Array.isArray(options.variables) ? options.variables : [options.variables];
    const breakpointSpecs = options.breakpoints;
    const finishAtLines = options.finishLines
      ? (Array.isArray(options.finishLines) ? options.finishLines : [options.finishLines])
      : null;

    // Diagnostic: Log inspection start
    console.log(`[RuntimeClient] ========== INSPECT START ==========`);
    console.log(`[RuntimeClient] Variables to watch: ${variableNames.join(', ')}`);
    console.log(`[RuntimeClient] Breakpoints requested:`);
    for (const bp of breakpointSpecs) {
      console.log(`[RuntimeClient]   - ${bp.file}:${bp.line}`);
    }

    const { Runtime, Debugger } = this.client;
    let pauseCount = 0;
    const allExtractedStates: InspectionState[] = [];
    const parsedScripts: Array<{ url: string; normalized: string; sourceMapURL?: string; isTarget?: boolean }> = [];
    const bindings: Array<{ url: string; line: number; success: boolean; locations?: any[]; [key: string]: any }> = [];
    const pauseMismatches: Array<{ url: string; line: number }> = [];
    let scriptsLoadedResolve: () => void;
    const scriptsLoadedPromise = new Promise<void>(r => { scriptsLoadedResolve = r; });

    type InspectionResult = {
      states: InspectionState[];
      totalPauses: number;
      parsedScripts?: Array<{ url: string; normalized: string; sourceMapURL?: string; isTarget?: boolean }>;
      bindings?: Array<{ url: string; line: number; success: boolean; locations?: any[]; [key: string]: any }>;
      pauseMismatches?: Array<{ url: string; line: number }>;
      breakpointInstallSucceeded?: boolean;
    };
    // Track whether any breakpoint installation succeeded
    let breakpointInstallSucceeded = false;
    // Track generated line numbers for source-mapped breakpoints
    // Maps "originalFile:originalLine" -> Set of generated lines where breakpoints were actually set
    const generatedLineMap = new Map<string, Set<number>>();
    const addGeneratedLine = (originalFile: string, originalLine: number, generatedLine: number) => {
      const key = `${originalFile}:${originalLine}`;
      if (!generatedLineMap.has(key)) {
        generatedLineMap.set(key, new Set());
      }
      generatedLineMap.get(key)!.add(generatedLine);
      // Also add original line as a valid target (for direct bindings)
      generatedLineMap.get(key)!.add(originalLine);
    };

    return new Promise<InspectionResult>(async (resolve) => {
      let isResolved = false;

      const resolveOnce = (result: InspectionResult) => {
        if (!isResolved) {
          isResolved = true;
          resolve(result);
        }
      };

      try {
        const breakpointMatchers = breakpointSpecs.map(bp => {
          const pathVariants = this.buildPathVariants(bp.file);

          // If TypeScript, also target the transpiled .js variants to survive missing source maps
          if (bp.file.endsWith('.ts')) {
            const jsFile = bp.file.replace(/\.ts$/, '.js');
            const jsVariants = this.buildPathVariants(jsFile);
            pathVariants.push(...jsVariants);
          }

          const regexes = pathVariants.map(p => this.fileToUrlRegex(p));
          const normalizedFile = this.normalizePath(bp.file).replace(/\\/g, '/');
          const fileUrl = pathToFileURL(normalizedFile).href;

          // Initialize the generated line map with the original line
          addGeneratedLine(bp.file, bp.line, bp.line);

          return {
            originalFile: bp.file,
            file: pathVariants[0],
            fileUrl,
            line: bp.line,
            fileRegexes: regexes,
            matchers: regexes.map(r => new RegExp(r))
          };
        });

        // Log key lifecycle events for debugging deadlocks / startup pauses
        Debugger.paused((params: any) => {
          const top = params?.callFrames?.[0];
          const line = top ? top.location.lineNumber + 1 : -1;
          const url = top?.url || this.scriptIdToUrl.get(top?.location?.scriptId || '') || '(unknown)';
          // eslint-disable-next-line no-console
          console.error(`[RuntimeClient] DEBUGGER PAUSED at ${url}:${line}`);
        });

        // Track target files we're looking for
        const targetBasenames = new Set(breakpointMatchers.map(bp => path.basename(bp.file)));
        const targetFilesFound = new Set<string>();

        // Also set breakpoints when matching scripts are parsed to handle URL/realpath differences.
        Debugger.scriptParsed(async (params: any) => {
          // Heartbeat for visibility in Jest
          console.error(`[RuntimeClient] HEARTBEAT scriptParsed url=${params?.url} id=${params?.scriptId} sourceMap=${!!params?.sourceMapURL}`);
          this.logScriptParsed(params);
          if (params.scriptId && params.url) {
            this.scriptIdToUrl.set(params.scriptId, params.url);
          }
          const url = params.url || '';
          const scriptName = path.basename(url);
          const normalizedUrl = this.normalizePath(url);
          const sourceMapUrl = params.sourceMapURL || '';
          
          // Check if this is a target file we're looking for
          const isTargetFile = targetBasenames.has(scriptName) || 
                               targetBasenames.has(scriptName.replace(/\.js$/, '.ts')) ||
                               Array.from(targetBasenames).some(t => url.includes(t) || normalizedUrl.includes(t));
          if (isTargetFile) {
            targetFilesFound.add(scriptName);
            console.error(`[RuntimeClient] ⭐ TARGET FILE LOADED: ${url} (id=${params.scriptId}, sourceMap=${!!sourceMapUrl})`);
          }
          
          parsedScripts.push({ url, normalized: normalizedUrl, sourceMapURL: sourceMapUrl, isTarget: isTargetFile });
          // eslint-disable-next-line no-console
          console.error(`[RuntimeClient] SCRIPT PARSED url=${url} normalized=${normalizedUrl} sourceMap=${sourceMapUrl}`);
          // Trace marker so diagnostics can bypass console
          bindings.push({
            url: normalizedUrl,
            line: 0,
            success: false,
            method: 'trace',
            stage: 'scriptParsed',
            scriptId: params.scriptId,
            sourceMap: !!sourceMapUrl
          });

          const sourceMapPath = sourceMapUrl ? this.resolveSourceMapPath(url, sourceMapUrl) : null;
          const scriptFsPath = url.startsWith('file:') ? this.normalizePath(fileURLToPath(url)) : normalizedUrl;
          let scriptSource: string | null = null;
          try {
            const resp = await Debugger.getScriptSource({ scriptId: params.scriptId });
            scriptSource = resp?.scriptSource || null;
            console.error(`[RuntimeClient] getScriptSource for ${scriptName} (${params.scriptId}) length=${scriptSource?.length ?? 0}`);
            bindings.push({
              url: normalizedUrl,
              line: 0,
              success: !!scriptSource,
              method: 'trace',
              stage: 'scriptSource',
              scriptId: params.scriptId,
              sourceLength: scriptSource?.length ?? 0
            });
          } catch (err: any) {
            console.error(`[RuntimeClient] getScriptSource failed for ${scriptName}:`, err?.message || err);
            bindings.push({
              url: normalizedUrl,
              line: 0,
              success: false,
              method: 'trace',
              stage: 'scriptSource-error',
              scriptId: params.scriptId,
              sourceLength: 0,
              error: err?.message || String(err)
            });
          }

          // Aggressive basename binding to handle ts/js split worlds and source maps
          for (const bp of breakpointMatchers) {
            const bpBasename = path.basename(bp.file);
            const bpJsName = bpBasename.replace(/\.ts$/, '.js');
            const isTsTarget = bp.originalFile.endsWith('.ts');
            const scriptIsJs = scriptName.endsWith('.js');

            // If we have a source map and a TS breakpoint, map it to generated JS line and bind via scriptId directly.
            if (isTsTarget && scriptIsJs && sourceMapPath && params.scriptId) {
              let genLine = this.getGeneratedLineFromMap(sourceMapPath, bp.originalFile, bp.line);
              if (genLine === null) {
                // Fallback to textual matching if source map lookup fails
                genLine = this.getGeneratedLineByContent(scriptFsPath, bp.originalFile, bp.line, scriptSource || undefined);
              }
              if (genLine !== null) {
                // Track the generated line for pause matching
                addGeneratedLine(bp.originalFile, bp.line, genLine);
                try {
                  console.error(`[RuntimeClient] Source map/content binding for ${bp.originalFile}:${bp.line} -> ${scriptName}:${genLine}`);
                  const resp = await Debugger.setBreakpoint({
                    location: { scriptId: params.scriptId, lineNumber: genLine - 1, columnNumber: 0 }
                  });
                  // setBreakpoint returns { breakpointId, actualLocation }, NOT { locations }
                  const bpId = (resp as any)?.breakpointId;
                  const actualLoc = (resp as any)?.actualLocation;
                  const success = !!bpId;
                  // Track actual location line if different
                  if (actualLoc?.lineNumber !== undefined) {
                    addGeneratedLine(bp.originalFile, bp.line, actualLoc.lineNumber + 1);
                  }
                  console.error(`[RuntimeClient] Source map binding response -> breakpointId=${bpId}, actualLocation=${JSON.stringify(actualLoc)}`);
                  if (success) {
                    breakpointInstallSucceeded = true;
                  }
                  bindings.push({
                    url: normalizedUrl,
                    line: bp.line,
                    success,
                    locations: actualLoc ? [actualLoc] : [],
                    method: 'scriptId-sourceMap',
                    generatedLine: genLine,
                    breakpointId: bpId
                  });
                  if (success) {
                    scriptsLoadedResolve?.();
                    continue;
                  }
                } catch (err: any) {
                  console.error(`[RuntimeClient] Source map binding failed for ${bp.originalFile}:${bp.line}`, err?.message || err);
                  bindings.push({ url: normalizedUrl, line: bp.line, success: false, method: 'scriptId-sourceMap', generatedLine: genLine });
                }
              } else {
                console.error(`[RuntimeClient] Source map/content binding could not find generated line for ${bp.originalFile}:${bp.line} in ${scriptName}`);
                bindings.push({ url: normalizedUrl, line: bp.line, success: false, method: 'scriptId-sourceMap', generatedLine: null });
              }
            }

            // Brute force: try content-based line lookup on loaded JS regardless of TS/JS target
            if (params.scriptId) {
              const genLine = this.getGeneratedLineByContent(scriptFsPath, bp.originalFile, bp.line, scriptSource || undefined);
              if (genLine !== null) {
                // Track the generated line for pause matching
                addGeneratedLine(bp.originalFile, bp.line, genLine);
                try {
                  console.error(`[RuntimeClient] Content binding for ${bp.originalFile}:${bp.line} -> ${scriptName}:${genLine}`);
                  const resp = await Debugger.setBreakpoint({
                    location: { scriptId: params.scriptId, lineNumber: genLine - 1, columnNumber: 0 }
                  });
                  // setBreakpoint returns { breakpointId, actualLocation }, NOT { locations }
                  const bpId = (resp as any)?.breakpointId;
                  const actualLoc = (resp as any)?.actualLocation;
                  const success = !!bpId;
                  // Track actual location line if different
                  if (actualLoc?.lineNumber !== undefined) {
                    addGeneratedLine(bp.originalFile, bp.line, actualLoc.lineNumber + 1);
                  }
                  console.error(`[RuntimeClient] Content binding response -> breakpointId=${bpId}, actualLocation=${JSON.stringify(actualLoc)}`);
                  if (success) {
                    breakpointInstallSucceeded = true;
                  }
                  bindings.push({
                    url: normalizedUrl,
                    line: bp.line,
                    success,
                    locations: actualLoc ? [actualLoc] : [],
                    method: 'scriptId-content',
                    generatedLine: genLine,
                    breakpointId: bpId
                  });
                  if (success) {
                    scriptsLoadedResolve?.();
                    continue;
                  }
                } catch (err: any) {
                  console.error(`[RuntimeClient] Content binding failed for ${bp.originalFile}:${bp.line}`, err?.message || err);
                  bindings.push({ url: normalizedUrl, line: bp.line, success: false, method: 'scriptId-content', generatedLine: genLine });
                }
              } else {
                console.error(`[RuntimeClient] Content binding not found for ${bp.originalFile}:${bp.line} in ${scriptName}`);
                bindings.push({ url: `${normalizedUrl}#content-not-found`, line: bp.line, success: false, method: 'scriptId-content', generatedLine: null });
              }
            }

            // Avoid binding TS breakpoints to JS scriptIds when we have no mapping
            // BUT allow it if we have a source map (handled above) or content matching (handled above)
            // Only skip if we've already tried source map/content matching and it failed
            if (isTsTarget && scriptIsJs && !sourceMapPath && !scriptSource) continue;

            // More permissive matching for multi-file scenarios
            const matchesByName =
              (scriptName === bpBasename || scriptName === bpJsName) ||
              normalizedUrl.endsWith(`/${bpBasename}`) ||
              normalizedUrl.endsWith(`/${bpJsName}`) ||
              // Also match if the file path contains the basename (for nested imports)
              normalizedUrl.includes(`/${bpBasename}`) ||
              normalizedUrl.includes(`/${bpJsName}`) ||
              // Match if URL ends with the file path components
              normalizedUrl.includes(bpBasename) ||
              normalizedUrl.includes(bpJsName);

            // Also allow direct normalized match
            const matchesByNorm = normalizedUrl === this.normalizePath(bp.originalFile).replace(/\\/g, '/');
            
            // Also try matching the normalized original file path against the normalized URL
            const normalizedBpFile = this.normalizePath(bp.originalFile).replace(/\\/g, '/');
            const matchesByPath = normalizedUrl === normalizedBpFile || 
                                  normalizedUrl.includes(normalizedBpFile) ||
                                  normalizedBpFile.includes(normalizedUrl);

            if ((matchesByName || matchesByNorm || matchesByPath) && params.scriptId) {
              // First, find valid breakpoint locations near the requested line
              let targetLine = bp.line - 1; // 0-indexed
              try {
                // Use getPossibleBreakpoints to find valid locations in a range around the target line
                const possibleBps = await Debugger.getPossibleBreakpoints({
                  start: { scriptId: params.scriptId, lineNumber: Math.max(0, targetLine - 5), columnNumber: 0 },
                  end: { scriptId: params.scriptId, lineNumber: targetLine + 10, columnNumber: 0 },
                  restrictToFunction: false
                });
                const locations = (possibleBps as any)?.locations || [];
                console.error(`[RuntimeClient] getPossibleBreakpoints for ${scriptName}:${bp.line} -> ${locations.length} possible locations`);
                
                // Find the closest valid line to our target
                if (locations.length > 0) {
                  // Log all possible lines for debugging
                  const lineNumbers: number[] = locations.map((l: any) => l.lineNumber + 1);
                  const possibleLines = [...new Set<number>(lineNumbers)].sort((a, b) => a - b);
                  console.error(`[RuntimeClient] Valid breakpoint lines near ${bp.line}: ${possibleLines.slice(0, 10).join(', ')}${possibleLines.length > 10 ? '...' : ''}`);
                  
                  // Find closest line to target
                  let closest = locations[0];
                  let minDist = Math.abs(closest.lineNumber - targetLine);
                  for (const loc of locations) {
                    const dist = Math.abs(loc.lineNumber - targetLine);
                    if (dist < minDist) {
                      minDist = dist;
                      closest = loc;
                    }
                  }
                  
                  if (closest.lineNumber !== targetLine) {
                    console.error(`[RuntimeClient] Line ${bp.line} not valid, using closest: ${closest.lineNumber + 1}`);
                    targetLine = closest.lineNumber;
                    // Track the adjusted line
                    addGeneratedLine(bp.originalFile, bp.line, targetLine + 1);
                  }
                } else {
                  console.error(`[RuntimeClient] ⚠️ NO valid breakpoint locations found near line ${bp.line} in ${scriptName}`);
                }
              } catch (err: any) {
                console.error(`[RuntimeClient] getPossibleBreakpoints failed for ${scriptName}:`, err?.message || err);
              }
              
              try {
                console.log(`[RuntimeClient] Binding ID ${params.scriptId} for ${scriptName}:${targetLine + 1} (Basename/SourceMap Match, requested=${bp.line})`);
                const bpResp = await Debugger.setBreakpoint({
                  location: {
                    scriptId: params.scriptId,
                    lineNumber: targetLine,
                    columnNumber: 0
                  }
                });
                // setBreakpoint returns { breakpointId, actualLocation }
                const bpId = (bpResp as any)?.breakpointId;
                const actualLoc = (bpResp as any)?.actualLocation;
                const success = !!bpId;
                // Track actual location line if different
                if (actualLoc?.lineNumber !== undefined) {
                  addGeneratedLine(bp.originalFile, bp.line, actualLoc.lineNumber + 1);
                }
                console.log(`[RuntimeClient] Breakpoint response for ${scriptName}:${bp.line} -> id=${bpId}, actualLine=${actualLoc?.lineNumber !== undefined ? actualLoc.lineNumber + 1 : 'none'}`);
                if (success) {
                  breakpointInstallSucceeded = true;
                }
                bindings.push({
                  url: normalizedUrl,
                  line: bp.line,
                  success,
                  locations: actualLoc ? [actualLoc] : [],
                  breakpointId: bpId,
                  method: 'scriptId-basename',
                  adjustedLine: targetLine !== bp.line - 1 ? targetLine + 1 : undefined
                });
                scriptsLoadedResolve?.();
              } catch (err: any) {
                console.warn(`[RuntimeClient] Failed to bind ${scriptName}:${bp.line}`, err?.message || err);
                bindings.push({ url: normalizedUrl, line: bp.line, success: false, method: 'scriptId-basename', error: err?.message });
              }
            }
          }
        });

        // Set up paused event handler FIRST (before resuming)
        Debugger.paused(async (params: any) => {
          const callFrames = params.callFrames;
          const topFrame = callFrames[0];
          const resolvedUrl = topFrame.url || this.scriptIdToUrl.get(topFrame.location.scriptId) || '';
          const lineNumber = topFrame.location.lineNumber + 1;

          // stderr so Jest shows pauses
          // eslint-disable-next-line no-console
          console.error(`🛑 PAUSED AT: ${resolvedUrl || '(unknown)'}:${lineNumber}`);

          // Skip startup noise (anonymous scripts with tiny line numbers)
          if (!resolvedUrl && topFrame.location.lineNumber < 5) {
            console.log(`[RuntimeClient] Skipping startup noise at line ${lineNumber}`);
            try { await Debugger.resume(); } catch {}
            return;
          }

          // 1. Filter out pauses that aren't at our target breakpoints
          const frameUrl = resolvedUrl;
          const normalizedFrameUrl = this.normalizePath(frameUrl);
          
          const matchesTarget = breakpointMatchers.some(bp => {
            // Check if pause line matches either the original line OR any generated line
            const key = `${bp.originalFile}:${bp.line}`;
            const validLines = generatedLineMap.get(key) || new Set([bp.line]);
            const lineMatches = validLines.has(lineNumber);
            
            if (!lineMatches) return false;
            
            const bpBasename = path.basename(bp.file);

            // Strict regex match (absolute / normalized)
            if (bp.matchers.some(m => m.test(frameUrl))) return true;
            if (bp.matchers.some(m => m.test(normalizedFrameUrl))) return true;

            // Loose basename match for relative URLs (e.g., "entry.ts")
            if (frameUrl.endsWith(bpBasename)) return true;
            if (normalizedFrameUrl.endsWith(bpBasename)) return true;

            // Very loose: tolerate ts->js transpile (match name without extension)
            const bpName = path.parse(bp.file).name;
            const frameName = path.parse(frameUrl).name || path.parse(normalizedFrameUrl).name;
            const frameExt = path.extname(frameUrl) || path.extname(normalizedFrameUrl);
            if (bpName === frameName && frameExt === '.js') return true;

            return false;
          });
          if (!matchesTarget) {
            // No match by line+file, log and resume
            const normalizedFrame = this.normalizePath(frameUrl || '');
            const expectedLines = breakpointMatchers.map(b => {
              const key = `${b.originalFile}:${b.line}`;
              const genLines = generatedLineMap.get(key);
              const lineInfo = genLines ? Array.from(genLines).join('/') : String(b.line);
              return `${path.basename(b.file)}:${lineInfo}`;
            });
            console.log(`[RuntimeClient] Skipping mismatch: expected ${expectedLines.join(',')} vs actual ${path.basename(normalizedFrame)}:${lineNumber}`);
            pauseMismatches.push({ url: normalizedFrame, line: lineNumber });
            await Debugger.resume();
            return;
          }

          // 2. ACTUAL BUSINESS LOGIC - Process the breakpoint
          pauseCount++;
          // Log which breakpoint matched and the generated line mapping
          const matchedBp = breakpointMatchers.find(bp => {
            const key = `${bp.originalFile}:${bp.line}`;
            const validLines = generatedLineMap.get(key) || new Set([bp.line]);
            return validLines.has(lineNumber);
          });
          if (matchedBp) {
            const key = `${matchedBp.originalFile}:${matchedBp.line}`;
            const validLines = generatedLineMap.get(key);
            console.log(`[RuntimeClient] Breakpoint ${pauseCount} hit at line ${lineNumber} (matches ${path.basename(matchedBp.originalFile)}:${matchedBp.line}, valid lines: ${validLines ? Array.from(validLines).join(',') : 'none'})`);
          } else {
            console.log(`[RuntimeClient] Breakpoint ${pauseCount} hit at line ${lineNumber}`);
          }

          // Normalize frameIndices to array
          const frameIndicesArray = Array.isArray(options.frameIndices)
            ? options.frameIndices
            : options.frameIndices !== undefined
            ? [options.frameIndices]
            : [0];

          let extracted: Record<number, FrameExtractionData> = {};
          try {
            // Extract all requested variables from specified frames
            extracted = await this.extractVariables(Debugger, Runtime, callFrames, variableNames, {
              extractFromAllFrames: options.extractFromAllFrames,
              frameIndices: frameIndicesArray,
              filterInternalFrames: true
            });
          } catch (err: any) {
            console.warn('[RuntimeClient] extractVariables failed:', err?.message || err);
          }

          // Store the state
          const state: InspectionState = {
            pauseNumber: pauseCount,
            lineNumber,
            callStackDepth: callFrames.length,
            callFrames: callFrames.map((f: any, idx: number) => ({
              index: idx,
              functionName: f.functionName || '(anonymous)',
              url: f.url || this.scriptIdToUrl.get(f.location?.scriptId) || '',
              location: f.location
            })),
            variables: extracted,
            timestamp: new Date().toISOString()
          };
          allExtractedStates.push(state);

          // Resume execution
          try {
            await Debugger.resume();
          } catch (err: any) {
            console.warn('[RuntimeClient] resume failed:', err?.message || err);
          }

          // Check if we should close after this pause
          const shouldFinish = finishAtLines && finishAtLines.includes(lineNumber);
          if (shouldFinish) {
            setTimeout(() => {
              // Check final breakpoint installation status from bindings
              const finalBreakpointSuccess = bindings.some(b => b.success);
              resolveOnce({ states: allExtractedStates, totalPauses: pauseCount, breakpointInstallSucceeded: finalBreakpointSuccess });
            }, 200);
          }
        });

        // Set all breakpoints upfront (Lazy Breakpoint approach)
        // For multi-file scenarios, use both exact URL and URL regex for better coverage
        for (const bp of breakpointMatchers) {
          // Try direct URL binding first (works if script is already loaded)
          try {
            const resp = await Debugger.setBreakpointByUrl({
              lineNumber: bp.line - 1,
              url: bp.fileUrl,
              columnNumber: 0
            });
            const locations = (resp as any)?.locations || [];
            const bpId = (resp as any)?.breakpointId;
            // Track actual locations for pause matching
            for (const loc of locations) {
              if (loc?.lineNumber !== undefined) {
                addGeneratedLine(bp.originalFile, bp.line, loc.lineNumber + 1);
              }
            }
            console.log(`[RuntimeClient] Breakpoint set at ${bp.fileUrl}:${bp.line} (direct URL) -> locations=${locations.length}, id=${bpId}`);
            const directSuccess = locations.length > 0;
            if (directSuccess) {
              breakpointInstallSucceeded = true;
            }
            bindings.push({
              url: bp.fileUrl,
              line: bp.line,
              success: directSuccess,
              locations,
              breakpointId: bpId,
              method: 'setBreakpointByUrl-direct'
            });
            if (locations.length > 0) {
              scriptsLoadedResolve?.();
            }
          } catch (err: any) {
            console.warn(`[RuntimeClient] Failed direct URL breakpoint at ${bp.fileUrl}:${bp.line}`, err?.message || err);
            bindings.push({
              url: bp.fileUrl,
              line: bp.line,
              success: false,
              method: 'setBreakpointByUrl-direct',
              error: err?.message
            });
          }
          
          // Also try URL regex patterns for multi-file scenarios (catches imported files)
          // This ensures breakpoints are set even if files aren't loaded yet (creates pending breakpoints)
          for (const regex of bp.fileRegexes) {
            try {
              const resp = await Debugger.setBreakpointByUrl({
                lineNumber: bp.line - 1,
                urlRegex: regex,
                columnNumber: 0
              });
              const locations = (resp as any)?.locations || [];
              const bpId = (resp as any)?.breakpointId;
              if (locations.length > 0) {
                // Track actual locations for pause matching
                for (const loc of locations) {
                  if (loc?.lineNumber !== undefined) {
                    addGeneratedLine(bp.originalFile, bp.line, loc.lineNumber + 1);
                  }
                }
                console.log(`[RuntimeClient] Breakpoint set via URL regex ${regex}:${bp.line} -> locations=${locations.length}, id=${bpId}`);
                breakpointInstallSucceeded = true;
                bindings.push({
                  url: regex,
                  line: bp.line,
                  success: true,
                  locations,
                  breakpointId: bpId,
                  method: 'setBreakpointByUrl-regex'
                });
                scriptsLoadedResolve?.();
              } else {
                // Even if no locations returned, the breakpoint might be pending
                // Pending breakpoints will activate when the script loads
                console.log(`[RuntimeClient] Breakpoint pending via URL regex ${regex}:${bp.line} (will activate when script loads)`);
              }
            } catch (err: any) {
              // URL regex failures for files not yet loaded are expected and will be set via scriptParsed
              // Only log if it's an actual error (not just "no matching scripts")
              if (!err?.message?.includes('No scripts') && !err?.message?.includes('Could not find script')) {
                console.warn(`[RuntimeClient] URL regex breakpoint error ${regex}:${bp.line}`, err?.message || err);
              }
            }
          }
        }

        // NOTE: With --inspect-brk, scripts don't parse until we resume.
        // We trust that setBreakpointByUrl creates pending breakpoints that 
        // will activate when scripts load. Resume immediately.
        const successfulBindings = bindings.filter(b => b.success).length;
        const totalBindings = bindings.length;
        console.log(`[RuntimeClient] ========== BREAKPOINT SETUP COMPLETE ==========`);
        console.log(`[RuntimeClient] Successful bindings: ${successfulBindings}/${totalBindings}`);
        for (const b of bindings) {
          console.log(`[RuntimeClient]   ${b.success ? '✓' : '✗'} ${b.url}:${b.line} (${b.method || 'unknown'})`);
        }
        // Log the generated line map so we can see what pause lines will be accepted
        console.log(`[RuntimeClient] Generated line map (pause lines that will be accepted):`);
        for (const [key, lines] of generatedLineMap) {
          console.log(`[RuntimeClient]   ${key} -> [${Array.from(lines).join(', ')}]`);
        }
        // Check if any breakpoint installation succeeded (note: scriptParsed handlers may set more later)
        if (!breakpointInstallSucceeded && totalBindings > 0) {
          console.error(`[RuntimeClient] ⚠️ WARNING: All breakpoint installation attempts failed during initial setup. Breakpoints may be set later when scripts are parsed.`);
        }
        console.log("[RuntimeClient] Resuming execution (pending breakpoints will activate on script load)...");

        // Resume execution now that breakpoints are set up
        // This is critical: with --inspect-brk, scripts don't parse until we resume.
        // Breakpoints are set as pending breakpoints and will activate when scripts load.
        try {
          await this.resume();
          console.log("[RuntimeClient] ✓ Resumed execution");
        } catch (resumeError: any) {
          console.warn(`[RuntimeClient] Resume warning: ${resumeError?.message || resumeError}`);
          // Continue anyway - process may already be running
        }

        // Listen for execution context destroyed (process exited)
        if (this.client) {
          this.client.Runtime.executionContextDestroyed(() => {
            console.log('[RuntimeClient] Execution context destroyed - process exited');
            // Wait a bit for async handlers to finish, then resolve
            setTimeout(() => {
              if (!isResolved) {
                // Check final breakpoint installation status from bindings
                const finalBreakpointSuccess = bindings.some(b => b.success);
                if (!finalBreakpointSuccess && bindings.length > 0) {
                  console.error(`[RuntimeClient] ⚠️ ERROR: All breakpoint installation attempts failed. No breakpoints were successfully installed.`);
                }
                resolveOnce({ states: allExtractedStates, totalPauses: pauseCount, parsedScripts, bindings, pauseMismatches, breakpointInstallSucceeded: finalBreakpointSuccess });
              }
            }, 500);
          });
        }

        // Safety timeout (10 seconds) - reduced for faster test feedback
        setTimeout(() => {
          if (!isResolved) {
            console.log(`[RuntimeClient] Inspection timeout - captured ${pauseCount} pause(s)`);
            // Check final breakpoint installation status from bindings
            const finalBreakpointSuccess = bindings.some(b => b.success);
            if (!finalBreakpointSuccess && bindings.length > 0) {
              console.error(`[RuntimeClient] ⚠️ ERROR: All breakpoint installation attempts failed. No breakpoints were successfully installed.`);
            }
            resolveOnce({ states: allExtractedStates, totalPauses: pauseCount, parsedScripts, bindings, pauseMismatches, breakpointInstallSucceeded: finalBreakpointSuccess });
          }
        }, 10000);
      } catch (err: any) {
        console.error("[RuntimeClient] Inspection error:", err);
        // Check final breakpoint installation status from bindings
        const finalBreakpointSuccess = bindings.some(b => b.success);
        resolveOnce({ states: allExtractedStates, totalPauses: pauseCount, parsedScripts, bindings, pauseMismatches, breakpointInstallSucceeded: finalBreakpointSuccess });
      }
    });
  }
}
