/**
 * NodeProcessTool - "The Runner"
 *
 * Spawns and manages Node.js processes, specifically for debugging.
 * Handles process lifecycle, port management, and cleanup.
 *
 * Refactored: Atomic mode only. Removed spawn/get_logs/list_active
 * to reduce agent confusion and always return logs via debug.
 */

import { ITool, ToolResult } from '../definitions/ITool';
import { NodeProcessSchema, NodeProcessParams } from '../definitions/ToolSchemas';
import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import * as cp from 'child_process';
import * as net from 'net';
import { createRequire } from 'module';
import { EventEmitter } from 'events';
import { StreamReporter } from '../../utils/StreamReporter';
import { RuntimeClient } from '../runtime/RuntimeClient';

export class NodeProcessTool extends EventEmitter implements ITool<NodeProcessParams> {
  name = "node-process";
  description = "Executes Node.js/TypeScript scripts with V8 debugging enabled. Returns execution logs and runtime variable states.";
  inputSchema = NodeProcessSchema as any;
  private reporter?: StreamReporter;

  setReporter(reporter?: StreamReporter): void {
    this.reporter = reporter;
  }

  // Track active processes so we can clean them up
  private static activeProcesses = new Map<number, cp.ChildProcess>();

  // Map<PID, string> to store logs (Flight Recorder)
  private static logBuffers = new Map<number, string>();

  // 1MB cap to prevent OOM errors
  private static readonly MAX_LOG_SIZE = 1024 * 1024;

  // Mutex to prevent concurrent debug sessions from killing each other
  private static debugLock: Promise<void> | null = null;
  private static debugLockRelease: (() => void) | null = null;

  /**
   * Determine the real workspace root.
   */
  private getWorkspaceRoot(): string | null {
    const workspaceFolders = vscode.workspace.workspaceFolders;
    if (!workspaceFolders || workspaceFolders.length === 0) {
      return null;
    }

    const candidate = path.resolve(workspaceFolders[0].uri.fsPath);
    const sandboxSuffix = `${path.sep}.samurai${path.sep}sandbox`;

    if (candidate.endsWith(sandboxSuffix)) {
      return candidate.slice(0, candidate.length - sandboxSuffix.length);
    }

    return candidate;
  }

  private async killAllProcesses(): Promise<number> {
    let count = 0;
    const pids = Array.from(NodeProcessTool.activeProcesses.keys());

    for (const pid of pids) {
      const proc = NodeProcessTool.activeProcesses.get(pid);
      if (proc) {
        try {
          proc.stdout?.removeAllListeners('data');
          proc.stderr?.removeAllListeners('data');
          proc.removeAllListeners('exit');
          proc.removeAllListeners('close');
          proc.kill('SIGKILL'); // Force kill
          count++;
        } catch (error: any) {
          if (error.code === 'ESRCH') {
            count++;
          } else {
            console.error(`[NodeProcessTool] Failed to kill process ${pid}:`, error);
          }
        }
      }
    }

    NodeProcessTool.activeProcesses.clear();
    NodeProcessTool.logBuffers.clear();
    NodeProcessTool.releaseAllPorts(); // Release any reserved ports

    // Give killed processes time to fully release ports
    if (count > 0) {
      await new Promise(resolve => setTimeout(resolve, 100));
    }

    return count;
  }

  /**
   * Reserved ports - kept open until we spawn the debug process
   * This prevents race conditions between findFreePort and actual use
   */
  private static reservedPorts = new Map<number, net.Server>();

  /**
   * Find and RESERVE a free port starting from the given port.
   * The port stays reserved (server keeps listening) until releasePort() is called.
   * This prevents race conditions where another process grabs the port between check and use.
   */
  private async findFreePort(startPort: number): Promise<number> {
    // Check if we already have a reserved port in the range
    for (const [port, _server] of NodeProcessTool.reservedPorts) {
      if (port >= startPort) {
        return port; // Reuse existing reservation
      }
    }

    return new Promise((resolve) => {
      const tryPort = (port: number) => {
        const server = net.createServer();
        server.once('error', () => {
          // Port in use, try next one
          tryPort(port + 1);
        });
        server.listen(port, '127.0.0.1', () => {
          // Port available and now reserved! Store the server to keep it open
          NodeProcessTool.reservedPorts.set(port, server);
          console.log(`[NodeProcessTool] Reserved debug port ${port}`);
          resolve(port);
        });
      };
      tryPort(startPort);
    });
  }

  /**
   * Release a previously reserved port.
   * Call this right before spawning the debug process (which will use the port).
   */
  private releasePort(port: number): void {
    const server = NodeProcessTool.reservedPorts.get(port);
    if (server) {
      try {
        server.close();
        console.log(`[NodeProcessTool] Released reserved port ${port}`);
      } catch (e) {
        // Ignore close errors
      }
      NodeProcessTool.reservedPorts.delete(port);
    }
  }

  /**
   * Release all reserved ports (cleanup)
   */
  private static releaseAllPorts(): void {
    for (const [port, server] of NodeProcessTool.reservedPorts) {
      try {
        server.close();
        console.log(`[NodeProcessTool] Released reserved port ${port}`);
      } catch (e) {
        // Ignore close errors
      }
    }
    NodeProcessTool.reservedPorts.clear();
  }

  /**
   * Find the project's tsconfig.json by walking up from workspace root.
   * Returns the path if found, or undefined if not.
   */
  private findProjectTsConfig(workspaceRoot: string): string | undefined {
    const candidates = ['tsconfig.json', 'jsconfig.json'];
    let current = workspaceRoot;
    
    // Walk up to find tsconfig.json (max 10 levels)
    for (let i = 0; i < 10; i++) {
      for (const candidate of candidates) {
        const configPath = path.join(current, candidate);
        if (fs.existsSync(configPath)) {
          return configPath;
        }
      }
      const parent = path.dirname(current);
      if (parent === current) break; // Reached root
      current = parent;
    }
    
    return undefined;
  }

  private isInSandbox(scriptFull: string, workspaceRoot: string): boolean {
    const sandboxRoot = path.resolve(workspaceRoot, '.samurai', 'sandbox');
    // If no sandbox exists, allow execution within the workspace root (test/prod temp dirs).
    if (!fs.existsSync(sandboxRoot)) {
      return true;
    }
    const resolvedScript = path.resolve(scriptFull);
    const relative = path.relative(sandboxRoot, resolvedScript);
    return !relative.startsWith('..') && !path.isAbsolute(relative);
  }

  /**
   * Wait for stdout/stderr to drain without risking a hang.
   * Uses a hybrid strategy: wait for 'end'/'close' OR a timeout.
   */
  private async waitForStreamsToDrain(child: cp.ChildProcess, timeoutMs = 1000): Promise<void> {
    const streams: NodeJS.ReadableStream[] = [
      child.stdout as NodeJS.ReadableStream | null,
      child.stderr as NodeJS.ReadableStream | null,
    ].filter((s): s is NodeJS.ReadableStream => !!s);

    if (streams.length === 0) {
      await new Promise((resolve) => setTimeout(resolve, Math.min(timeoutMs, 200)));
      return;
    }

    const waitForStream = (stream: NodeJS.ReadableStream) =>
      new Promise<void>((resolve) => {
        if ((stream as any).readableEnded || (stream as any).closed) {
          return resolve();
        }
        const done = () => resolve();
        stream.once('end', done);
        stream.once('close', done);
      });

    const drainPromise = Promise.all(streams.map(waitForStream));
    const timeoutPromise = new Promise<void>((resolve) => setTimeout(resolve, timeoutMs));

    await Promise.race([drainPromise, timeoutPromise]);

    // Give a short buffer for any last-moment data events to flush
    await new Promise((resolve) => setTimeout(resolve, 50));
  }

  /**
   * Resolve tsconfig-paths/register with fallback strategies.
   * Returns the resolved path or empty string if not available.
   */
  private resolveTsConfigPaths(workspaceRequire: NodeRequire, workspaceRoot: string): string {
    // Attempt 1: Contextual Require (Best practice for monorepos/pnpm)
    try {
      const resolved = workspaceRequire.resolve('tsconfig-paths/register');
      console.log(`[NodeProcessTool] Resolved tsconfig-paths via workspace require: ${resolved}`);
      return resolved;
    } catch (e1: any) {
      console.warn(`[NodeProcessTool] Workspace require failed for tsconfig-paths: ${e1?.message}`);
    }

    // Attempt 2: Direct resolution from workspace root (fallback for edge cases)
    try {
      const resolved = require.resolve('tsconfig-paths/register', { paths: [workspaceRoot] });
      console.log(`[NodeProcessTool] Resolved tsconfig-paths via fallback: ${resolved}`);
      return resolved;
    } catch (e2: any) {
      console.warn(`[NodeProcessTool] Fallback resolution failed for tsconfig-paths: ${e2?.message}`);
    }

    // Attempt 3: Check common node_modules location directly
    const directPath = path.join(workspaceRoot, 'node_modules', 'tsconfig-paths', 'register.js');
    if (fs.existsSync(directPath)) {
      console.log(`[NodeProcessTool] Found tsconfig-paths via direct path: ${directPath}`);
      return directPath;
    }

    // All attempts failed - log diagnostic info
    console.warn(
      `[NodeProcessTool] Could not resolve tsconfig-paths/register. ` +
      `Path aliases (@/...) will NOT work. Install via: npm install -D tsconfig-paths`
    );
    console.log(`[NodeProcessTool] Diagnostic - workspaceRoot: ${workspaceRoot}`);
    console.log(`[NodeProcessTool] Diagnostic - checked direct path: ${directPath}`);

    return '';
  }

  /**
   * Build the command/args using dynamic module resolution.
   */
  private buildCommand(
    scriptFull: string,
    isTypeScript: boolean,
    workspaceRoot: string,
    port: number
  ): { cmd: string; args: string[] } {
    if (isTypeScript) {
      let workspaceRequire: NodeRequire;
      try {
        workspaceRequire = createRequire(path.join(workspaceRoot, 'package.json'));
      } catch {
        // Fallback to current working directory (useful for temp dirs without package.json)
        workspaceRequire = createRequire(path.join(process.cwd(), 'package.json'));
      }

      // 1. Resolve ts-node via Node's resolver (supports pnpm/yarn/monorepos)
      let registerPath: string;
      try {
        registerPath = workspaceRequire.resolve('ts-node/register/transpile-only');
      } catch (errorTranspileOnly: any) {
        // Distinguish between missing ts-node and missing transpile-only entry
        try {
          workspaceRequire.resolve('ts-node');
        } catch (missingTsNode: any) {
          throw new Error(
            `[NodeProcessTool] Could not find 'ts-node' in ${workspaceRoot}. ` +
            `Please install it via 'npm install -D ts-node' to enable TypeScript debugging.`
          );
        }

        throw new Error(
          `[NodeProcessTool] Found 'ts-node', but 'ts-node/register/transpile-only' is not available. ` +
          `Please install a compatible version of 'ts-node' that supports transpile-only mode.`
        );
      }

      const args: string[] = [`--inspect-brk=${port}`, '-r', registerPath];

      // 2. Conditionally add tsconfig-paths (Prevent MODULE_NOT_FOUND crash)
      const pathsPath = this.resolveTsConfigPaths(workspaceRequire, workspaceRoot);
      if (pathsPath) {
        args.push('-r', pathsPath);
      }

      args.push(scriptFull);

      return { cmd: 'node', args };
    }

    // JavaScript Strategy: use native node
    return { cmd: 'node', args: [`--inspect-brk=${port}`, scriptFull] };
  }

  /**
   * Build command without debug flags (for fallback execution).
   */
  private buildCommandWithoutDebugger(
    scriptFull: string,
    isTypeScript: boolean,
    workspaceRoot: string
  ): { cmd: string; args: string[] } {
    if (isTypeScript) {
      let workspaceRequire: NodeRequire;
      try {
        workspaceRequire = createRequire(path.join(workspaceRoot, 'package.json'));
      } catch {
        workspaceRequire = createRequire(path.join(process.cwd(), 'package.json'));
      }

      let registerPath: string;
      try {
        registerPath = workspaceRequire.resolve('ts-node/register/transpile-only');
      } catch (errorTranspileOnly: any) {
        try {
          workspaceRequire.resolve('ts-node');
        } catch (missingTsNode: any) {
          throw new Error(
            `[NodeProcessTool] Could not find 'ts-node' in ${workspaceRoot}. ` +
            `Please install it via 'npm install -D ts-node' to enable TypeScript execution.`
          );
        }
        throw new Error(
          `[NodeProcessTool] Found 'ts-node', but 'ts-node/register/transpile-only' is not available. ` +
          `Please install a compatible version of 'ts-node' that supports transpile-only mode.`
        );
      }

      const args: string[] = ['-r', registerPath];

      const pathsPath = this.resolveTsConfigPaths(workspaceRequire, workspaceRoot);
      if (pathsPath) {
        args.push('-r', pathsPath);
      }

      args.push(scriptFull);

      return { cmd: 'node', args };
    }

    // JavaScript Strategy: use native node
    return { cmd: 'node', args: [scriptFull] };
  }

  /**
   * Execute script without debugger (fallback mode).
   * Captures stdout, stderr, exit code, and execution time.
   */
  private async runWithoutDebugger({
    scriptPath,
    workspaceRoot,
    env,
    timeoutMs = 5000
  }: {
    scriptPath: string;
    workspaceRoot: string;
    env: Record<string, string | undefined>;
    timeoutMs?: number;
  }): Promise<{
    exitCode: number | null;
    signal: NodeJS.Signals | null;
    durationMs: number;
    stdout: string;
    stderr: string;
    combined: string;
  }> {
    const startTime = Date.now();
    const isTypeScript = scriptPath.endsWith('.ts') || scriptPath.endsWith('.tsx');
    
    let cmd: string;
    let args: string[];
    try {
      const built = this.buildCommandWithoutDebugger(scriptPath, isTypeScript, workspaceRoot);
      cmd = built.cmd;
      args = built.args;
    } catch (e: any) {
      throw new Error(`Failed to build fallback command: ${e?.message || 'Unknown error'}`);
    }

    console.log(`[NodeProcessTool] Running fallback execution: ${cmd} ${args.join(' ')}`);

    const child = cp.spawn(cmd, args, {
      cwd: workspaceRoot,
      env,
      stdio: ['ignore', 'pipe', 'pipe'] // Explicitly set stdio: stdin=ignore, stdout=pipe, stderr=pipe
    });

    if (!child.pid) {
      throw new Error('Failed to spawn fallback process');
    }

    let stdout = '';
    let stderr = '';
    let exitCode: number | null = null;
    let exitSignal: NodeJS.Signals | null = null;
    let resolved = false;

    const outputPromise = new Promise<void>((resolve) => {
      // Listen for data on stdout/stderr
      child.stdout?.on('data', (data: Buffer) => {
        const text = data.toString();
        stdout += text;
        console.log(`[NodeProcessTool] Fallback stdout data: ${JSON.stringify(text)}`);
      });

      child.stderr?.on('data', (data: Buffer) => {
        const text = data.toString();
        stderr += text;
        console.log(`[NodeProcessTool] Fallback stderr data: ${JSON.stringify(text)}`);
      });

      // Store exit code/signal when process exits, but don't resolve yet
      child.on('exit', (code, signal) => {
        if (exitCode === null) {
          exitCode = code;
          exitSignal = signal;
        }
      });

      child.on('error', (error) => {
        if (!resolved) {
          resolved = true;
          stderr += `Process error: ${error.message}\n`;
          exitCode = exitCode ?? 1;
          resolve();
        }
      });

      // Wait for both streams to end before resolving
      const streams: NodeJS.ReadableStream[] = [
        child.stdout as NodeJS.ReadableStream | null,
        child.stderr as NodeJS.ReadableStream | null,
      ].filter((s): s is NodeJS.ReadableStream => !!s);

      if (streams.length === 0) {
        // No streams available, resolve immediately after a short delay
        setTimeout(() => {
          if (!resolved) {
            resolved = true;
            resolve();
          }
        }, 100);
        return;
      }

      // Check if streams are already ended
      const allEnded = streams.every((stream) => 
        (stream as any).readableEnded || (stream as any).closed
      );
      
      if (allEnded) {
        // Streams already ended, resolve immediately
        if (!resolved) {
          resolved = true;
          resolve();
        }
        return;
      }

      // Wait for all streams to end
      const streamEndPromises = streams.map((stream) => {
        return new Promise<void>((streamResolve) => {
          if ((stream as any).readableEnded || (stream as any).closed) {
            streamResolve();
            return;
          }
          
          const done = () => streamResolve();
          stream.once('end', done);
          stream.once('close', done);
        });
      });

      Promise.all(streamEndPromises).then(() => {
        if (!resolved) {
          resolved = true;
          resolve();
        }
      });
    });

    const timeoutPromise = new Promise<void>((resolve) => {
      setTimeout(() => {
        if (!resolved) {
          resolved = true;
          console.log(`[NodeProcessTool] Fallback execution timed out after ${timeoutMs}ms, killing process...`);
          try {
            child.kill('SIGKILL');
          } catch (e) {
            // Ignore kill errors
          }
          exitCode = null;
          exitSignal = 'SIGKILL';
          resolve();
        }
      }, timeoutMs);
    });

    await Promise.race([outputPromise, timeoutPromise]);

    // Give a small buffer for any last-moment data events to flush
    await new Promise((resolve) => setTimeout(resolve, 50));

    const durationMs = Date.now() - startTime;
    const combined = stdout + (stderr ? '\n' + stderr : '');

    console.log(`[NodeProcessTool] Fallback execution completed. Exit code: ${exitCode}, stdout: ${JSON.stringify(stdout)}, stderr: ${JSON.stringify(stderr)}`);

    return {
      exitCode,
      signal: exitSignal,
      durationMs,
      stdout: stdout.trim(),
      stderr: stderr.trim(),
      combined: combined.trim()
    };
  }

  async execute(params: NodeProcessParams): Promise<ToolResult> {
    const workspaceRoot = this.getWorkspaceRoot();
    if (!workspaceRoot) {
      return { success: false, summary: "No workspace." };
    }

    // --- ACTION: DEBUG (The Main Event) ---
    if (params.action === 'debug') {
      return this.executeAtomicDebug(params, workspaceRoot);
    }

    // --- ACTION: KILL_ALL (Cleanup Utility) ---
    if (params.action === 'kill_all') {
      const count = await this.killAllProcesses();
      return {
        success: true,
        summary: `Cleaned up ${count} stray process(es).`,
        structuredData: { killedCount: count }
      };
    }

    // --- ACTION: KILL (Specific Cleanup) ---
    if (params.action === 'kill') {
      if (!params.pid) return { success: false, summary: "PID required." };
      const proc = NodeProcessTool.activeProcesses.get(params.pid);
      if (proc) {
        proc.kill('SIGKILL');
        NodeProcessTool.activeProcesses.delete(params.pid);
        return { success: true, summary: `Killed process ${params.pid}.` };
      }
      return { success: false, summary: `Process ${params.pid} not found.` };
    }

    return { success: false, summary: `Invalid action '${params.action}'. Only 'debug', 'kill', and 'kill_all' are supported.` };
  }

  /**
   * Resolve a content-based breakpoint to a line number.
   * Reads the file and finds the line containing the specified content.
   */
  /**
   * Resolve content to the best line using a relevance score.
   * Scoring:
   * +10 exact snippet match
   * +5  line contains a watch variable
   * +3  neighbors (±2) contain a watch variable
   * -10 comment/log-only line
   */
  private resolveContentToLine(
    filePath: string,
    content: string,
    watchVariables: string[]
  ): { line: number; matchedLine: string; score: number } | { error: string } {
    if (!fs.existsSync(filePath)) {
      return { error: `File not found: ${filePath}` };
    }

    try {
      const fileContent = fs.readFileSync(filePath, 'utf8');
      const lines = fileContent.split('\n');
      const searchContent = content.trim();
      const normalizedSearch = searchContent.replace(/\s+/g, ' ');

      // Helper to strip TypeScript type annotations for matching
      const stripTypeAnnotations = (text: string): string => {
        // Remove type annotations like : Type, : Type[], : Type<Generic>, : { ... }
        let stripped = text;
        // Remove inline type annotations - match : followed by identifier (possibly with generics/arrays)
        // More conservative: only match if followed by = or ; or , or )
        stripped = stripped.replace(/:\s*[A-Za-z_$][A-Za-z0-9_$<>[\]|&\s]*?(?=\s*[=;,\)\n])/g, '');
        // Remove object type annotations : { ... } - be careful not to match object literals
        // Only match if it looks like a type annotation (before = or after function parameter)
        stripped = stripped.replace(/:\s*\{[^{}]*\}(?=\s*[=,;\)])/g, '');
        return stripped.trim();
      };
      
      const strippedSearch = stripTypeAnnotations(searchContent);
      const normalizedStrippedSearch = strippedSearch.replace(/\s+/g, ' ');

      type Candidate = { idx: number; lineText: string; exact: boolean; score: number; hasWatch: boolean; nearWatch: boolean };
      const candidates: Candidate[] = [];

      const isCommentOrLog = (text: string) => {
        const t = text.trim();
        return t.startsWith('//') || t.startsWith('/*') || t.startsWith('*') || t.startsWith('console.');
      };

      const containsWatch = (text: string) =>
        watchVariables.some(v => v && text.includes(v));

      const neighborsHaveWatch = (idx: number) => {
        const range = 2;
        for (let off = -range; off <= range; off++) {
          if (off === 0) continue;
          const i = idx + off;
          if (i >= 0 && i < lines.length) {
            if (containsWatch(lines[i])) return true;
          }
        }
        return false;
      };

      for (let i = 0; i < lines.length; i++) {
        const raw = lines[i];
        const normalizedLine = raw.replace(/\s+/g, ' ').trim();
        const strippedLine = stripTypeAnnotations(raw);
        const strippedNormalized = stripTypeAnnotations(normalizedLine);
        
        // Try exact match first
        const exact = raw.includes(searchContent);
        // Try normalized match (whitespace normalized)
        const normalizedMatch = normalizedLine.includes(normalizedSearch);
        // Try matching with stripped type annotations (both search and line stripped)
        const strippedMatch = strippedLine.includes(normalizedStrippedSearch) || 
                              strippedNormalized.includes(normalizedStrippedSearch) ||
                              strippedLine.includes(normalizedSearch) ||
                              strippedNormalized.includes(normalizedSearch);
        
        if (!(exact || normalizedMatch || strippedMatch)) continue;

        let score = 0;
        if (exact) score += 10;
        else if (normalizedMatch) score += 8;
        else if (strippedMatch) score += 6; // TypeScript stripped match gets lower score but still valid
        
        // Check watch variables in both original and stripped line
        // Also check if stripped line matches the search better
        const hasWatch = containsWatch(raw) || containsWatch(strippedLine);
        if (hasWatch) score += 5;
        const nearWatch = neighborsHaveWatch(i);
        if (nearWatch) score += 3;
        if (isCommentOrLog(raw)) score -= 10;
        
        // For TypeScript, if stripped match works, boost score slightly
        if (strippedMatch && !exact && !normalizedMatch) {
          score += 2; // TypeScript stripped match bonus
        }

        candidates.push({ idx: i, lineText: raw, exact, score, hasWatch, nearWatch });
      }

      if (candidates.length === 0) {
        return { error: `Content not found in file: "${searchContent.substring(0, 50)}${searchContent.length > 50 ? '...' : ''}"` };
      }

      // Pick the highest score; if tie, choose the earliest
      candidates.sort((a, b) => b.score - a.score || a.idx - b.idx);
      const best = candidates[0];

      // Require some relevance to watch vars if any were provided
      const anyWatchRequested = watchVariables.length > 0;
      if (anyWatchRequested && !(best.hasWatch || best.nearWatch)) {
        // Double-check by stripping type annotations and checking again
        const strippedBest = stripTypeAnnotations(best.lineText);
        const hasWatchInStripped = containsWatch(strippedBest);
        if (!hasWatchInStripped) {
          return {
            error: `Matched line ${best.idx + 1} does not reference watch variables (${watchVariables.join(', ')})`
          };
        }
        // If stripped version has watch vars, update the candidate
        best.hasWatch = true;
      }

      return { line: best.idx + 1, matchedLine: best.lineText.trim(), score: best.score };
    } catch (err: any) {
      return { error: `Failed to read file: ${err?.message || err}` };
    }
  }

  /**
   * Validate a breakpoint - check if the line exists and contains executable code.
   * Returns validation result with details.
   */
  private validateBreakpoint(filePath: string, line: number): { valid: boolean; reason?: string; lineContent?: string; suggestion?: number } {
    if (!fs.existsSync(filePath)) {
      return { valid: false, reason: `File not found: ${filePath}` };
    }

    try {
      const fileContent = fs.readFileSync(filePath, 'utf8');
      const lines = fileContent.split('\n');
      
      // Check if line exists
      if (line < 1 || line > lines.length) {
        return { 
          valid: false, 
          reason: `Line ${line} out of range (file has ${lines.length} lines)`,
          suggestion: Math.min(line, lines.length)
        };
      }
      
      const lineContent = lines[line - 1];
      const trimmedLine = lineContent.trim();
      
      // Check if line is empty
      if (trimmedLine === '') {
        // Find nearest non-empty line
        let nearestLine: number | undefined;
        for (let offset = 1; offset <= 5; offset++) {
          if (line + offset <= lines.length && lines[line + offset - 1].trim() !== '') {
            nearestLine = line + offset;
            break;
          }
          if (line - offset >= 1 && lines[line - offset - 1].trim() !== '') {
            nearestLine = line - offset;
            break;
          }
        }
        return { 
          valid: false, 
          reason: `Line ${line} is empty/blank`,
          lineContent: '(empty)',
          suggestion: nearestLine
        };
      }
      
      // Check if line is a comment only
      if (trimmedLine.startsWith('//') || trimmedLine.startsWith('/*') || trimmedLine.startsWith('*')) {
        return { 
          valid: false, 
          reason: `Line ${line} is a comment`,
          lineContent: trimmedLine.substring(0, 50)
        };
      }
      
      // Check if line is a TypeScript type definition (not executable)
      if (trimmedLine.startsWith('type ') || trimmedLine.startsWith('interface ') || 
          trimmedLine.startsWith('export type ') || trimmedLine.startsWith('export interface ')) {
        return { 
          valid: false, 
          reason: `Line ${line} is a type definition (not executable at runtime)`,
          lineContent: trimmedLine.substring(0, 50)
        };
      }
      
      return { valid: true, lineContent: trimmedLine.substring(0, 80) };
    } catch (err: any) {
      return { valid: false, reason: `Failed to read file: ${err?.message || err}` };
    }
  }

  /**
   * Check if logs contain only inspector lifecycle messages (no user stdout).
   * Returns true if logs are empty or contain only debugger/inspector noise.
   */
  private hasOnlyInspectorLogs(logs: string[]): boolean {
    if (logs.length === 0) return true;
    
    const inspectorPatterns = [
      /Debugger listening/i,
      /Debugger attached/i,
      /Debugger ending/i,
      /Waiting for the debugger/i,
      /For help, see:/i,
      /chrome-devtools/i,
      /ws:\/\/127\.0\.0\.1:\d+\//i, // WebSocket debugger URLs
    ];
    
    const allLogs = logs.join('\n');
    const hasInspectorMessage = inspectorPatterns.some(pattern => pattern.test(allLogs));
    
    // If we have inspector messages but no other substantial content, it's inspector-only
    if (hasInspectorMessage) {
      // Remove inspector messages and check if anything meaningful remains
      const cleaned = allLogs
        .split('\n')
        .filter(line => {
          const trimmed = line.trim();
          if (!trimmed) return false;
          // Check if line is an inspector message
          return !inspectorPatterns.some(pattern => pattern.test(trimmed));
        })
        .join('\n')
        .trim();
      
      return cleaned.length === 0;
    }
    
    return false;
  }

  /**
   * Resolve and validate all breakpoints.
   * - Converts content-based breakpoints to line numbers
   * - Validates line-based breakpoints
   * - Returns valid breakpoints and a report of issues
   */
  private resolveAndValidateBreakpoints(
    breakpoints: Array<{ file: string; content?: string; line?: number }>,
    workspaceRoot: string,
    watchVariables: string[]
  ): {
    validBreakpoints: Array<{ file: string; line: number }>;
    issues: Array<{ file: string; content?: string; error: string; suggestion?: string }>;
  } {
    const validBreakpoints: Array<{ file: string; line: number }> = [];
    const issues: Array<{ file: string; content?: string; error: string; suggestion?: string }> = [];

    for (const bp of breakpoints) {
      const filePath = path.isAbsolute(bp.file) ? bp.file : path.join(workspaceRoot, bp.file);
      
      // Require content; line numbers are intentionally not supported in beta
      if (!bp.content || bp.content.trim().length === 0) {
        issues.push({
          file: bp.file,
          content: bp.content,
          error: 'Breakpoint must provide `content` (line numbers are not accepted)',
          suggestion: 'Provide a code snippet to match, e.g., "const tokens = tokenize(segment)"'
        });
        continue;
      }

      // Heuristic: reject risky snippets likely to be rewritten by transpilation
      const riskyPatterns = [
        /Object\.entries/,
        /Object\.values/,
        /\bfor\s*\(/,
        /\bfor\s+await\b/,
        /\bfor\s+of\b/,
        /=>/
      ];
      if (riskyPatterns.some(r => r.test(bp.content!))) {
        issues.push({
          file: bp.file,
          content: bp.content,
          error: 'Snippet is likely to be rewritten by transpilation and hard to bind',
          suggestion: 'Target a simple assignment or function call line that includes the watch variable, e.g., "wordCounts[token] = (wordCounts[token] || 0) + 1;"'
        });
        continue;
      }

      // Resolve content to best line using relevance scoring with watch vars
      const resolution = this.resolveContentToLine(filePath, bp.content, watchVariables);
      if ('error' in resolution) {
        issues.push({
          file: bp.file,
          content: bp.content,
          error: resolution.error,
          suggestion: 'Check that the code snippet exists in the file'
        });
        continue;
      }
      const resolvedLine = resolution.line;
      console.log(`[NodeProcessTool] Content "${bp.content.substring(0, 30)}..." resolved to line ${resolvedLine}`);
      console.log(`[NodeProcessTool] Matched line text: "${resolution.matchedLine}" score=${resolution.score}`);
      
      const validation = this.validateBreakpoint(filePath, resolvedLine);
      if (!validation.valid) {
        const suggestionText = validation.suggestion 
          ? `Try line ${validation.suggestion} instead` 
          : undefined;
        issues.push({
          file: bp.file,
          error: validation.reason || 'Invalid breakpoint',
          suggestion: suggestionText
        });
        continue;
      }
      
      validBreakpoints.push({ file: filePath, line: resolvedLine });
      console.log(`[NodeProcessTool] ✓ Valid breakpoint: ${path.basename(filePath)}:${resolvedLine} - "${validation.lineContent}"`);
    }

    return { validBreakpoints, issues };
  }

  /**
   * Acquire an exclusive lock for debug sessions.
   * Prevents concurrent sessions from killing each other.
   */
  private async acquireDebugLock(): Promise<() => void> {
    // Wait for any existing session to complete
    while (NodeProcessTool.debugLock) {
      console.log('[NodeProcessTool] Waiting for previous debug session to complete...');
      await NodeProcessTool.debugLock;
    }

    // Create a new lock
    let release: () => void;
    NodeProcessTool.debugLock = new Promise<void>((resolve) => {
      release = () => {
        NodeProcessTool.debugLock = null;
        NodeProcessTool.debugLockRelease = null;
        resolve();
      };
    });
    NodeProcessTool.debugLockRelease = release!;

    return release!;
  }

  private async executeAtomicDebug(params: NodeProcessParams, workspaceRoot: string): Promise<ToolResult> {
    // Acquire exclusive lock to prevent concurrent sessions
    const releaseLock = await this.acquireDebugLock();
    console.log('[NodeProcessTool] Acquired debug lock');

    try {
      return await this.executeAtomicDebugInternal(params, workspaceRoot);
    } finally {
      console.log('[NodeProcessTool] Releasing debug lock');
      releaseLock();
    }
  }

  private async executeAtomicDebugInternal(params: NodeProcessParams, workspaceRoot: string): Promise<ToolResult> {
    const scriptPath = params.path || params.scriptPath;
    const watchVariables = params.watch_variables ?? [];
    const timeoutMs = params.timeout ?? 10000;

    if (!scriptPath) {
      return { success: false, summary: "Path is required for debug action." };
    }

    // STEP 0: Resolve and validate breakpoints BEFORE starting the debug session
    const rawBreakpoints = params.breakpoints ?? [];
    const { validBreakpoints, issues } = this.resolveAndValidateBreakpoints(rawBreakpoints, workspaceRoot, watchVariables);
    
    // Report breakpoint issues
    if (issues.length > 0) {
      console.warn(`[NodeProcessTool] ⚠️ ${issues.length} breakpoint issue(s):`);
      for (const issue of issues) {
        const snippet = issue.content ? ` snippet="${issue.content.substring(0, 40)}${issue.content.length > 40 ? '...' : ''}"` : '';
        console.warn(`  - ${path.basename(issue.file)}${snippet}: ${issue.error}${issue.suggestion ? ` (${issue.suggestion})` : ''}`);
      }
    }
    
    // If ALL breakpoints are invalid, return early with helpful error
    if (validBreakpoints.length === 0 && rawBreakpoints.length > 0) {
      const issueReport = issues.map(i => {
        const snippet = i.content ? ` snippet="${i.content.substring(0, 40)}${i.content.length > 40 ? '...' : ''}"` : '';
        return `• ${path.basename(i.file)}${snippet} - ${i.error}${i.suggestion ? `\n  Suggestion: ${i.suggestion}` : ''}`;
      }).join('\n');
      
      return {
        success: false,
        summary: `All ${rawBreakpoints.length} breakpoint(s) are invalid. Debug session not started.`,
        evidence: [{
          file: 'breakpoint-validation.txt',
          line: 0,
          text: `=== BREAKPOINT VALIDATION FAILED ===\n\n${issueReport}\n\nTips:\n- Use 'content' instead of 'line' for more robust breakpoints\n- Ensure breakpoints are on executable code (not blank lines, comments, or type definitions)\n- Check that file paths are correct`,
          description: 'Breakpoint validation errors'
        }]
      };
    }
    
    const breakpoints = validBreakpoints;
    // Store issues for diagnostic output
    const breakpointValidationIssues = issues;

    // Ensure clean slate
    await this.killAllProcesses();

    const startTime = Date.now();
    const resolvedScript = path.isAbsolute(scriptPath)
      ? scriptPath
      : path.join(workspaceRoot, scriptPath);

    if (!this.isInSandbox(resolvedScript, workspaceRoot)) {
      return {
        success: false,
        summary: "Debug mode only allows scripts inside .samurai/sandbox/.",
      };
    }

    // 1. Build the robust command
    const isTypeScript = resolvedScript.endsWith('.ts') || resolvedScript.endsWith('.tsx');
    const port = await this.findFreePort(params.debugPort ?? 9229);
    let cmd: string;
    let args: string[];

    try {
      const built = this.buildCommand(resolvedScript, isTypeScript, workspaceRoot, port);
      cmd = built.cmd;
      args = built.args;
    } catch (e: any) {
      return { success: false, summary: e?.message || 'Failed to build debug command.' };
    }

    // 2. Configure Environment (The "Truth Serum" for V8)
    // Override compiler options to ensure compatibility with ts-node
    // Next.js projects often use "bundler" moduleResolution which is incompatible
    
    // Find the project's tsconfig.json to use for path resolution
    const projectTsConfigPath = this.findProjectTsConfig(workspaceRoot);
    
    const env: Record<string, string | undefined> = {
      ...process.env,
      NODE_OPTIONS: `--no-warnings --enable-source-maps`,
      TS_NODE_COMPILER_OPTIONS: JSON.stringify({
        sourceMap: true,
        inlineSourceMap: true,
        inlineSources: true, // Critical: V8 sees source content
        target: 'es2019',
        module: 'commonjs',
        moduleResolution: 'node', // Override 'bundler' which is incompatible with ts-node
        esModuleInterop: true,
        skipLibCheck: true, // Speed up compilation, skip type checking in node_modules
        baseUrl: workspaceRoot, // Set baseUrl to enable tsconfig-paths
      }),
      TS_NODE_TRANSPILE_ONLY: 'true',
      TS_NODE_FILES: 'true',
      FORCE_COLOR: 'true'
    };
    
    // Point ts-node to the project's tsconfig for proper path alias resolution
    if (projectTsConfigPath) {
      env.TS_NODE_PROJECT = projectTsConfigPath;
      console.log(`[NodeProcessTool] Using project tsconfig: ${projectTsConfigPath}`);
    }

    console.log(`[NodeProcessTool] ========== DEBUG SESSION START ==========`);
    console.log(`[NodeProcessTool] Command: ${cmd} ${args.join(' ')}`);
    console.log(`[NodeProcessTool] CWD: ${workspaceRoot}`);
    console.log(`[NodeProcessTool] Script: ${resolvedScript}`);
    console.log(`[NodeProcessTool] Port: ${port}`);

    // 4. Release the reserved port right before spawning (atomic handoff)
    // The debug process will immediately bind to this port
    this.releasePort(port);

    // Small delay to ensure OS has fully released the port
    await new Promise(resolve => setTimeout(resolve, 50));

    // 5. Spawn
    const child = cp.spawn(cmd, args, {
      cwd: workspaceRoot,
      env
    });

    if (!child.pid) {
      return { success: false, summary: "Failed to spawn debug process." };
    }

    NodeProcessTool.activeProcesses.set(child.pid, child);
    NodeProcessTool.logBuffers.set(child.pid, "");

    // 5. Capture Logs
    const logs: string[] = [];
    const resultData: {
      logs: string[];
      breakpoints_hit: any[];
      breakpoints_requested: Array<{ file: string; content?: string; line?: number }>;
      breakpoints_resolved: Array<{ file: string; line: number }>;
      breakpoint_validation_issues: Array<{ file: string; content?: string; error: string; suggestion?: string }>;
      errors: string[];
      exitCode?: number | null;
      exitSignal?: NodeJS.Signals | null;
      command?: { cmd: string; args: string[]; commandLine: string };
      runtimeMs?: number;
      debugPort?: number;
      env?: Record<string, string | undefined>;
      states: any[];
      totalPauses: number;
      parsedScripts?: Array<{ url: string; normalized: string; sourceMapURL?: string }>;
      bindings?: Array<{ url: string; line: number; success: boolean; locations?: any[] }>;
      pauseMismatches?: Array<{ url: string; line: number }>;
    } = {
      logs,
      breakpoints_hit: [],
      breakpoints_requested: rawBreakpoints,
      breakpoints_resolved: breakpoints,
      breakpoint_validation_issues: breakpointValidationIssues,
      errors: [],
      states: [],
      totalPauses: 0,
      parsedScripts: [],
      bindings: [],
      pauseMismatches: [],
    };
    resultData.command = { cmd, args, commandLine: `${cmd} ${args.join(' ')}` };
    resultData.debugPort = port;
    resultData.env = {
      NODE_OPTIONS: env.NODE_OPTIONS,
      TS_NODE_COMPILER_OPTIONS: env.TS_NODE_COMPILER_OPTIONS,
      TS_NODE_TRANSPILE_ONLY: env.TS_NODE_TRANSPILE_ONLY,
      TS_NODE_FILES: env.TS_NODE_FILES,
    };

    const recordBuffer = (data: Buffer, type: 'stdout' | 'stderr') => {
      const msg = data.toString();
      logs.push(`[${type.toUpperCase()}] ${msg.trim()}`);

      let current = NodeProcessTool.logBuffers.get(child.pid!) || "";
      current += msg;
      if (current.length > NodeProcessTool.MAX_LOG_SIZE) {
        current = "...[TRUNCATED]...\n" + current.slice(current.length - NodeProcessTool.MAX_LOG_SIZE);
      }
      NodeProcessTool.logBuffers.set(child.pid!, current);

      if (msg.trim()) {
        this.emit('output', msg, type);
      }
    };

    child.stdout?.on('data', (d) => recordBuffer(d, 'stdout'));
    child.stderr?.on('data', (d) => recordBuffer(d, 'stderr'));
    child.on('error', (error) => {
      const msg = `Failed to spawn process: ${error.message}`;
      resultData.errors.push(msg);
    });

    let processExitedEarly = false;
    let exitCode: number | null = null;
    let exitSignal: NodeJS.Signals | null = null;
    let exitTimestamp: number | null = null;
    let exitReported = false;
    let exitResolve: ((value: { code: number | null; timestamp: number; signal: NodeJS.Signals | null }) => void) | null = null;
    const exitPromise = new Promise<{ code: number | null; timestamp: number; signal: NodeJS.Signals | null }>((resolve) => {
      exitResolve = resolve;
    });
    const reportExit = (code: number | null, signal: NodeJS.Signals | null) => {
      if (exitReported) return;
      exitReported = true;
      processExitedEarly = true;
      exitCode = code ?? exitCode ?? child.exitCode;
      exitSignal = signal ?? exitSignal ?? child.signalCode ?? null;
      exitTimestamp = Date.now();
      exitResolve?.({ code: exitCode, timestamp: exitTimestamp, signal: exitSignal });
    };

    child.on('exit', (code, signal) => {
      // Ignore events from processes that have been cleaned up (ghost events)
      if (!NodeProcessTool.activeProcesses.has(child.pid!)) {
        return;
      }
      console.log(`[NodeProcessTool] Process EXIT event - code: ${code}, signal: ${signal}`);
      reportExit(code, signal);
    });
    child.on('close', (code, signal) => {
      // Ignore events from processes that have been cleaned up (ghost events)
      if (!NodeProcessTool.activeProcesses.has(child.pid!)) {
        return;
      }
      console.log(`[NodeProcessTool] Process CLOSE event - code: ${code}, signal: ${signal}`);
      if (logs.length > 0) {
        console.log(`[NodeProcessTool] Captured output:\n${logs.slice(-5).join('\n')}`);
      }
      reportExit(code, signal);
    });

    // 6. Connect Debugger
    const client = new RuntimeClient();

    try {
      // Wait briefly for process to boot / debugger to open port
      await new Promise((r) => setTimeout(r, 500));

      if (processExitedEarly) {
        await this.waitForStreamsToDrain(child);
        const crashLogs = logs.length > 0 ? logs.join('\n') : "(No output captured)";
        const runtimeMs = Date.now() - startTime;
        const cleanExit = exitCode === 0 && !exitSignal;
        resultData.exitCode = exitCode;
        resultData.exitSignal = exitSignal;
        resultData.runtimeMs = runtimeMs;

        const crashDescriptor = exitSignal
          ? `Signal: ${exitSignal}`
          : `Exit Code: ${exitCode}`;

        return {
          success: cleanExit,
          summary: cleanExit
            ? "Process exited before debugger attached (clean exit)."
            : `Process crashed immediately (${crashDescriptor}).`,
          evidence: [{
             file: "crash-report.txt", line: 0, text: crashLogs, description: "Crash Logs"
          }],
          structuredData: {
            logs: resultData.logs,
            breakpoints_hit: [],
            breakpoints_requested: resultData.breakpoints_requested,
            breakpoints_resolved: resultData.breakpoints_resolved,
            breakpoint_validation_issues: resultData.breakpoint_validation_issues,
            errors: [crashLogs],
            exitCode,
            exitSignal,
            command: { cmd, args },
            runtimeMs,
            debugPort: port,
            env: resultData.env,
            states: [],
            totalPauses: 0,
          }
        };
      }

      console.log(`[NodeProcessTool] Connecting to debugger on port ${port}...`);
      const connected = await client.connect(port);
      if (!connected) {
        throw new Error(`Failed to attach to V8 debugger on port ${port}.`);
      }
      console.log(`[NodeProcessTool] ✓ Connected to debugger`);

      // Log breakpoint targets for diagnosis
      console.log(`[NodeProcessTool] Setting ${breakpoints.length} breakpoint(s):`);
      for (const bp of breakpoints) {
        console.log(`[NodeProcessTool]   → ${bp.file}:${bp.line}`);
      }
      console.log(`[NodeProcessTool] Watch variables: ${watchVariables.join(', ') || '(none)'}`);

      const inspectionPromise = client.inspect({
        variables: watchVariables,
        breakpoints,
        port,
        waitForScripts: true,
        extractFromAllFrames: true,
        scriptWaitTimeoutMs: Math.min(timeoutMs, 5000),
      });

      type InspectionOutcome =
        | { type: 'inspection'; data: Awaited<typeof inspectionPromise> }
        | { type: 'exit'; code: number | null; timestamp: number; signal: NodeJS.Signals | null }
        | { type: 'timeout' };

      const outcome = await Promise.race<InspectionOutcome>([
        inspectionPromise.then((data) => ({ type: 'inspection', data })),
        exitPromise.then(({ code, timestamp, signal }) => ({ type: 'exit', code, timestamp, signal })),
        new Promise<InspectionOutcome>((resolve) =>
          setTimeout(() => resolve({ type: 'timeout' }), timeoutMs),
        ),
      ]);

      console.log(`[NodeProcessTool] Race outcome: ${outcome.type}`);
      if (outcome.type === 'inspection') {
        const data = (outcome as any).data;
        console.log(`[NodeProcessTool] ========== INSPECTION RESULTS ==========`);
        console.log(`[NodeProcessTool] Total pauses: ${data.totalPauses}`);
        console.log(`[NodeProcessTool] States captured: ${data.states?.length || 0}`);
        if (data.parsedScripts?.length > 0) {
          console.log(`[NodeProcessTool] Parsed scripts (${data.parsedScripts.length}):`);
          for (const script of data.parsedScripts.slice(0, 10)) {
            console.log(`[NodeProcessTool]   📜 ${script.url || '(no url)'} ${script.sourceMapURL ? '(has sourcemap)' : ''}`);
          }
          if (data.parsedScripts.length > 10) {
            console.log(`[NodeProcessTool]   ... and ${data.parsedScripts.length - 10} more`);
          }
        }
        if (data.bindings?.length > 0) {
          const successful = data.bindings.filter((b: any) => b.success);
          console.log(`[NodeProcessTool] Breakpoint bindings: ${successful.length}/${data.bindings.length} successful`);
          for (const b of data.bindings.filter((b: any) => b.method !== 'trace').slice(0, 10)) {
            console.log(`[NodeProcessTool]   ${b.success ? '✓' : '✗'} ${b.url}:${b.line} (${b.method || 'unknown'})`);
          }
        }
        if (data.pauseMismatches?.length > 0) {
          console.log(`[NodeProcessTool] Pause mismatches (paused at unexpected locations): ${data.pauseMismatches.length}`);
        }
        
        // Early fallback detection: if all breakpoint installations failed and no pauses occurred
        if (data.bindings && data.bindings.length > 0) {
          const allFailed = data.bindings.every((b: any) => !b.success || b.method === 'trace');
          const noPauses = (data.totalPauses || 0) === 0;
          const breakpointInstallFailed = data.breakpointInstallSucceeded === false;
          
          if ((allFailed || breakpointInstallFailed) && noPauses) {
            console.log(`[NodeProcessTool] ⚠️ All breakpoint installations failed - triggering early fallback`);
            (resultData as any).shouldFallback = true;
            (resultData as any).fallbackReason = 'breakpoint_install_failed';
          }
        }
      }
      if (outcome.type === 'exit') {
        console.log(`[NodeProcessTool] Exit details - code: ${(outcome as any).code}, signal: ${(outcome as any).signal}`);
      }
      // Add trace marker to resultData for diagnostics
      (resultData as any).outcomeType = outcome.type;
      if (outcome.type === 'timeout') {
        const runtimeMs = Date.now() - startTime;
        
        // Check if we should trigger fallback execution
        // Try to get inspection data even on timeout (might have partial results)
        let inspectionData: Awaited<typeof inspectionPromise> | null = null;
        try {
          inspectionData = await Promise.race([
            inspectionPromise,
            new Promise<Awaited<typeof inspectionPromise>>((_, reject) =>
              setTimeout(() => reject(new Error('Inspection check timeout')), 500)
            ),
          ]);
        } catch {
          // Inspection didn't complete, that's fine - we'll check what we have
        }
        
        // Populate resultData with any inspection data we got
        if (inspectionData) {
          resultData.states = inspectionData.states || [];
          resultData.totalPauses = inspectionData.totalPauses || 0;
          if ((inspectionData as any).parsedScripts) {
            (resultData as any).parsedScripts = (inspectionData as any).parsedScripts;
          }
          if ((inspectionData as any).bindings) {
            (resultData as any).bindings = (inspectionData as any).bindings;
          }
          if ((inspectionData as any).pauseMismatches) {
            (resultData as any).pauseMismatches = (inspectionData as any).pauseMismatches;
          }
          // Set breakpoints_hit from states
          resultData.breakpoints_hit = inspectionData.states && inspectionData.states.length > 0
            ? inspectionData.states.map((state: any) => {
                const extracted: Record<string, any> = {};
                for (const frame of Object.values(state.variables)) {
                  for (const [varName, varData] of Object.entries((frame as any).variables)) {
                    if ((varData as any).success) {
                      extracted[varName] = (varData as any).value;
                    }
                  }
                }
                return {
                  line: state.lineNumber,
                  pause: state.pauseNumber,
                  variables: extracted,
                };
              })
            : [];
          
          // Check for breakpoint installation failure on timeout
          if ((inspectionData as any).bindings && (inspectionData as any).bindings.length > 0) {
            const allFailed = (inspectionData as any).bindings.every((b: any) => !b.success || b.method === 'trace');
            const noPauses = (inspectionData.totalPauses || 0) === 0;
            const breakpointInstallFailed = (inspectionData as any).breakpointInstallSucceeded === false;
            
            if ((allFailed || breakpointInstallFailed) && noPauses && !(resultData as any).shouldFallback) {
              console.log(`[NodeProcessTool] ⚠️ Timeout with all breakpoint installations failed - triggering early fallback`);
              (resultData as any).shouldFallback = true;
              (resultData as any).fallbackReason = 'breakpoint_install_failed';
            }
          }
        }
        
        // Check fallback conditions: no breakpoints hit and process still running
        const shouldFallback = 
          resultData.breakpoints_hit.length === 0 &&
          !processExitedEarly;
        
        if (shouldFallback) {
          console.log(`[NodeProcessTool] Timeout with no pauses detected - attempting force resume before fallback`);
          resultData.errors.push(`Execution timed out after ${runtimeMs}ms`);
          
          // Attempt force resume as last-ditch effort
          let forceResumeWorked = false;
          try {
            await client.resume();
            
            // Wait 250-500ms for any paused events
            const graceWaitMs = 375; // Middle of 250-500ms range
            await new Promise(resolve => setTimeout(resolve, graceWaitMs));
            
            // Check again if we got any pauses during grace period
            try {
              const graceInspectionData = await Promise.race([
                inspectionPromise,
                new Promise<Awaited<typeof inspectionPromise>>((_, reject) =>
                  setTimeout(() => reject(new Error('Grace period check timeout')), 100)
                ),
              ]);
              if (graceInspectionData && (graceInspectionData.totalPauses > 0 || (graceInspectionData.states?.length || 0) > 0)) {
                forceResumeWorked = true;
                resultData.states = graceInspectionData.states || [];
                resultData.totalPauses = graceInspectionData.totalPauses || 0;
                // Set breakpoints_hit from states
                resultData.breakpoints_hit = graceInspectionData.states && graceInspectionData.states.length > 0
                  ? graceInspectionData.states.map((state: any) => {
                      const extracted: Record<string, any> = {};
                      for (const frame of Object.values(state.variables)) {
                        for (const [varName, varData] of Object.entries((frame as any).variables)) {
                          if ((varData as any).success) {
                            extracted[varName] = (varData as any).value;
                          }
                        }
                      }
                      return {
                        line: state.lineNumber,
                        pause: state.pauseNumber,
                        variables: extracted,
                      };
                    })
                  : [];
                console.log(`[NodeProcessTool] Force resume succeeded - got ${resultData.totalPauses} pause(s)`);
              }
            } catch {
              // No pauses during grace period, proceed to fallback
            }
          } catch (forceResumeError: any) {
            console.warn(`[NodeProcessTool] Force resume failed: ${forceResumeError?.message || forceResumeError}`);
            (resultData as any).fallbackReason = 'resume_failed';
          }
          
          if (!forceResumeWorked) {
            // Fallback will be handled after the try-catch block
            (resultData as any).shouldFallback = true;
            (resultData as any).fallbackReason = 'timeout_no_pause';
          }
        } else {
          resultData.errors.push(`Execution timed out after ${runtimeMs}ms`);
        }
      } else if (outcome.type === 'exit') {
        console.error(`[NodeProcessTool] Process exited with code ${(outcome as any).code}, waiting for inspection...`);
        const runtimeMs = outcome.timestamp - startTime;
        resultData.exitCode = outcome.code;
        resultData.exitSignal = outcome.signal ?? child.signalCode ?? null;
        resultData.runtimeMs = runtimeMs;
        
        // Process exited, but paused handlers might still be running.
        // Wait a bit for the inspection to complete with states.
        try {
          const inspectionData = await Promise.race([
            inspectionPromise,
            new Promise<Awaited<typeof inspectionPromise>>((_, reject) =>
              setTimeout(() => reject(new Error('Inspection did not complete after exit')), 1000)
            ),
          ]);
          console.error(`[NodeProcessTool] Inspection completed after exit with ${inspectionData.states.length} states`);
          resultData.states = inspectionData.states;
          resultData.totalPauses = inspectionData.totalPauses;
          if ((inspectionData as any).parsedScripts) {
            (resultData as any).parsedScripts = (inspectionData as any).parsedScripts;
          }
          if ((inspectionData as any).bindings) {
            (resultData as any).bindings = (inspectionData as any).bindings;
          }
          if ((inspectionData as any).pauseMismatches) {
            (resultData as any).pauseMismatches = (inspectionData as any).pauseMismatches;
          }
          resultData.breakpoints_hit = inspectionData.states && inspectionData.states.length > 0
            ? inspectionData.states.map((state) => {
                const extracted: Record<string, any> = {};
                for (const frame of Object.values(state.variables)) {
                  for (const [varName, varData] of Object.entries((frame as any).variables)) {
                    if ((varData as any).success) {
                      extracted[varName] = (varData as any).value;
                    }
                  }
                }
                return {
                  line: state.lineNumber,
                  pause: state.pauseNumber,
                  variables: extracted,
                };
              })
            : [];
          // Only add error if there were no pauses
          if (inspectionData.states.length === 0) {
            const crashLogs = logs.length > 0 ? logs.join('\n') : "(No output captured)";
            resultData.errors.push(
              `Process exited during inspection (${resultData.exitSignal ? `Signal: ${resultData.exitSignal}` : `Exit Code: ${outcome.code}`}, Runtime: ${runtimeMs}ms)\n\nCaptured Logs:\n${crashLogs}`,
            );
          }
        } catch {
          // Inspection didn't complete, just log the exit
          const crashLogs = logs.length > 0 ? logs.join('\n') : "(No output captured)";
          resultData.errors.push(
            `Process exited during inspection (${resultData.exitSignal ? `Signal: ${resultData.exitSignal}` : `Exit Code: ${outcome.code}`}, Runtime: ${runtimeMs}ms)\n\nCaptured Logs:\n${crashLogs}`,
          );
        }
      } else {
        resultData.states = outcome.data.states;
        resultData.totalPauses = outcome.data.totalPauses;
        if ((outcome.data as any).parsedScripts) {
          (resultData as any).parsedScripts = (outcome.data as any).parsedScripts;
        }
        if ((outcome.data as any).bindings) {
          (resultData as any).bindings = (outcome.data as any).bindings;
        }
        if ((outcome.data as any).pauseMismatches) {
          (resultData as any).pauseMismatches = (outcome.data as any).pauseMismatches;
        }
        resultData.breakpoints_hit = outcome.data.states && outcome.data.states.length > 0
          ? outcome.data.states.map((state) => {
              const extracted: Record<string, any> = {};
              for (const frame of Object.values(state.variables)) {
                for (const [varName, varData] of Object.entries((frame as any).variables)) {
                  if ((varData as any).success) {
                    extracted[varName] = (varData as any).value;
                  }
                }
              }
              return {
                line: state.lineNumber,
                pause: state.pauseNumber,
                variables: extracted,
              };
            })
          : [];

        // Check if we should fallback: no breakpoints hit and process didn't exit early
        if (resultData.breakpoints_hit.length === 0 && !processExitedEarly) {
          (resultData as any).shouldFallback = true;
          (resultData as any).fallbackReason = 'no_breakpoints_hit';
        }

        // If the process is still running after inspection, allow a short grace period
        // for it to exit naturally before forcing cleanup.
        const processStillRunning = !processExitedEarly && child && !child.killed;
        if (processStillRunning) {
          const gracePeriod = params.gracePeriodMs ?? 2000;
          console.log(`[NodeProcessTool] Waiting up to ${gracePeriod}ms for process to exit naturally...`);
          try {
            await Promise.race([
              exitPromise,
              new Promise<void>((resolve) => setTimeout(resolve, gracePeriod)),
            ]);
          } catch (waitError) {
            console.warn('[NodeProcessTool] Error while waiting for process exit:', waitError);
          }
        }
      }
    } catch (error: any) {
      resultData.errors.push(error?.message || "Unknown debugger error");
    } finally {
      await client.disconnect();

      const stillRunning = child && !child.killed && !processExitedEarly;
      if (stillRunning) {
        console.log('[NodeProcessTool] Process still running after grace period, forcing cleanup...');
        await this.killAllProcesses();
      } else {
        // Process already exited; just clear tracking.
        NodeProcessTool.activeProcesses.clear();
        NodeProcessTool.logBuffers.clear();
      }
    }

    // 6.5. Fallback Execution (if needed)
    // Check if we should trigger fallback based on actual payload data
    // This catches cases even if outcome.type bookkeeping is off
    const shouldFallbackByPayload = 
      resultData.breakpoints_hit.length === 0 &&
      resultData.exitCode === null &&
      resultData.exitSignal === null;

    if (shouldFallbackByPayload && !(resultData as any).shouldFallback) {
      (resultData as any).shouldFallback = true;
      (resultData as any).fallbackReason = 'no_breakpoints_hit';
    }

    if ((resultData as any).shouldFallback) {
      console.log(`[NodeProcessTool] Executing fallback: running script without debugger`);
      try {
        const fallbackResult = await this.runWithoutDebugger({
          scriptPath: resolvedScript,
          workspaceRoot,
          env,
          timeoutMs: 5000
        });

        // Update resultData with fallback results
        (resultData as any).mode = 'log_fallback';
        (resultData as any).reason = (resultData as any).fallbackReason || 'timeout_no_pause';
        (resultData as any).execution = {
          exitCode: fallbackResult.exitCode,
          signal: fallbackResult.signal,
          durationMs: fallbackResult.durationMs
        };
        // Store fallback logs as an object (keep this for buildConciseSummary)
        (resultData as any).fallbackLogs = {
          stdout: fallbackResult.stdout,
          stderr: fallbackResult.stderr,
          combined: fallbackResult.combined
        };

        // Also update the logs array for backward compatibility
        if (fallbackResult.combined) {
          resultData.logs = fallbackResult.combined.split('\n').map(line => line.trim()).filter(Boolean);
        } else {
          // Ensure logs array exists even if no output
          resultData.logs = [];
        }

        resultData.exitCode = fallbackResult.exitCode;
        resultData.exitSignal = fallbackResult.signal;
        resultData.runtimeMs = fallbackResult.durationMs;

        console.log(`[NodeProcessTool] Fallback execution completed: exitCode=${fallbackResult.exitCode}, signal=${fallbackResult.signal}, duration=${fallbackResult.durationMs}ms`);
      } catch (fallbackError: any) {
        console.error(`[NodeProcessTool] Fallback execution failed: ${fallbackError?.message || fallbackError}`);
        resultData.errors.push(`Fallback execution failed: ${fallbackError?.message || 'Unknown error'}`);
        // Keep the shouldFallback flag but mark as failed
        (resultData as any).fallbackFailed = true;
      }
    } else {
      // Normal inspection mode
      (resultData as any).mode = 'inspection';
    }

    // 7. Report Results
    const hitCount = resultData.breakpoints_hit.length;
    const hasLogs = resultData.logs.length > 0;
    const isFallbackMode = (resultData as any).mode === 'log_fallback';
    const success = isFallbackMode ? (hasLogs || (resultData as any).execution?.exitCode === 0) : (hitCount > 0 || hasLogs);

    let summary = "";
    if (isFallbackMode) {
      const fallbackLogs = (resultData as any).fallbackLogs;
      const hasOutput = fallbackLogs && (fallbackLogs.stdout || fallbackLogs.stderr || fallbackLogs.combined);
      const reason = (resultData as any).reason === 'resume_failed' 
        ? 'resume failed' 
        : 'timeout with no breakpoints hit';
      
      summary = `⚠️ Runtime inspection could not attach or resume (${reason}). The script was executed normally and logs are shown below.`;
      
      if (!hasOutput && (resultData as any).execution?.exitCode !== 0) {
        summary += ` Script exited with code ${(resultData as any).execution?.exitCode || 'unknown'}.`;
      }
    } else if (hitCount > 0) {
      summary = `Debug run success. Hit ${hitCount} breakpoint(s).`;
    } else if (hasLogs) {
      summary = `Debug run completed. No breakpoints hit, but logs were captured. Check "logs".`;
    } else {
      summary = `Debug run failed. No breakpoints hit and no logs captured.`;
    }

    resultData.exitCode = resultData.exitCode ?? exitCode;
    resultData.exitSignal = resultData.exitSignal ?? exitSignal;
    resultData.runtimeMs = resultData.runtimeMs ?? (exitTimestamp ? exitTimestamp - startTime : Date.now() - startTime);

    // Build diagnostic summary for visibility
    const parsedWithUrls = (resultData.parsedScripts || []).filter((s: any) => s.url && s.url.length > 0);
    const targetScripts = (resultData.parsedScripts || []).filter((s: any) => s.isTarget);
    const bindingsNonTrace = (resultData.bindings || []).filter((b: any) => b.method !== 'trace');
    const successfulBindings = bindingsNonTrace.filter((b: any) => b.success);
    
    // Extract target file basenames from breakpoints
    const targetBasenames = breakpoints.map(bp => {
      const parts = bp.file.split('/');
      return parts[parts.length - 1];
    });
    
    // Find bindings that are for target files
    const targetFileBindings = bindingsNonTrace.filter((b: any) => {
      const url = b.url || '';
      return targetBasenames.some(basename => url.includes(basename) || url.includes(basename.replace('.ts', '.js')));
    });
    
    // Build validation issues report
    const validationReport = breakpointValidationIssues.length > 0
      ? [
          ``,
          `⚠️ BREAKPOINT VALIDATION ISSUES (${breakpointValidationIssues.length}):`,
          ...breakpointValidationIssues.map(i => {
            const snippet = i.content ? ` snippet="${i.content.substring(0, 40)}${i.content.length > 40 ? '...' : ''}"` : '';
            return `  ✗ ${path.basename(i.file)}${snippet} - ${i.error}${i.suggestion ? ` → ${i.suggestion}` : ''}`;
          }),
        ]
      : [];
    
    const diagnosticSummary = [
      `=== DEBUG DIAGNOSTIC ===`,
      `Breakpoints requested: ${rawBreakpoints.length}`,
      `Breakpoints valid: ${breakpoints.length}`,
      `Total pauses: ${resultData.totalPauses}`,
      `States captured: ${resultData.states?.length || 0}`,
      `Scripts parsed: ${parsedWithUrls.length} (with URLs)`,
      `Breakpoint bindings: ${successfulBindings.length}/${bindingsNonTrace.length} successful`,
      `Pause mismatches: ${resultData.pauseMismatches?.length || 0}`,
      ...validationReport,
      ``,
      `Target files to find: ${targetBasenames.join(', ') || '(none)'}`,
      `Target files FOUND: ${targetScripts.length > 0 ? targetScripts.map((s: any) => s.url).join(', ') : '⚠️ NONE - target file was never loaded!'}`,
      ``,
      `✅ SUCCESSFUL bindings (${successfulBindings.length}):`,
      ...(successfulBindings.length > 0 
        ? successfulBindings.slice(0, 10).map((b: any) => `  ✓ ${b.url}:${b.line} (${b.method})${b.breakpointId ? ` id=${b.breakpointId}` : ''}`)
        : ['  (none)']),
      ``,
      `🎯 TARGET FILE bindings (${targetFileBindings.length} attempts):`,
      ...(targetFileBindings.length > 0
        ? targetFileBindings.slice(0, 20).map((b: any) => `  ${b.success ? '✓' : '✗'} ${b.url}:${b.line} (${b.method})${b.error ? ` err=${b.error}` : ''}${b.generatedLine ? ` gen=${b.generatedLine}` : ''}`)
        : ['  ⚠️ NO binding attempts for target files!']),
      ``,
      `Scripts loaded (first 15):`,
      ...parsedWithUrls.slice(0, 15).map((s: any) => `  ${s.isTarget ? '⭐' : '📜'} ${s.url}`),
    ].join('\n');

    const conciseSummary = this.buildConciseSummary(resultData, success);

    // Build evidence array
    const evidence: Array<{ file: string; line: number; text: string; description?: string }> = [];

    // Add fallback logs as primary evidence if in fallback mode
    if (isFallbackMode && (resultData as any).fallbackLogs) {
      const fallbackLogs = (resultData as any).fallbackLogs;
      const logText = fallbackLogs.combined || fallbackLogs.stdout || fallbackLogs.stderr || '(No output)';
      const execution = (resultData as any).execution || {};
      
      evidence.push({
        file: "fallback-execution-logs.txt",
        line: 0,
        text: `=== FALLBACK EXECUTION LOGS ===\n` +
              `Reason: ${(resultData as any).reason || 'unknown'}\n` +
              `Exit Code: ${execution.exitCode ?? 'null'}\n` +
              `Signal: ${execution.signal ?? 'null'}\n` +
              `Duration: ${execution.durationMs ?? 0}ms\n\n` +
              `=== STDOUT ===\n${fallbackLogs.stdout || '(empty)'}\n\n` +
              `=== STDERR ===\n${fallbackLogs.stderr || '(empty)'}\n\n` +
              `=== COMBINED OUTPUT ===\n${logText}`,
        description: "Console output from fallback execution (script run without debugger)"
      });
    }

    // Add debug summary (always included)
    evidence.push({
      file: "debug-summary.json",
      line: 0,
      text: JSON.stringify(conciseSummary, null, 2),
      description: isFallbackMode 
        ? "Fallback execution summary: logs and execution metadata"
        : "Concise debug results: breakpoints hit, variables, errors, terminal logs",
    });

    // Build finalOutput - use fallback combined logs if available, otherwise use regular logs
    const finalOutput = isFallbackMode && (resultData as any).fallbackLogs?.combined
      ? (resultData as any).fallbackLogs.combined
      : resultData.logs.join('\n');

    return {
      success,
      summary,
      structuredData: {
        ...this.buildPersistedDebugReport(resultData),
        finalOutput
      },
      evidence,
    };
  }

  /**
   * Build a concise summary for LLM evidence.
   * Keeps only essential info: breakpoints hit, errors, truncated terminal logs.
   */
  private buildConciseSummary(resultData: any, success: boolean) {
    const isFallbackMode = resultData.mode === 'log_fallback';
    
    // Use fallback logs if in fallback mode, otherwise use regular logs
    let joinedLogs: string;
    if (isFallbackMode && resultData.fallbackLogs) {
      const fallbackLogs = resultData.fallbackLogs;
      joinedLogs = fallbackLogs.combined || fallbackLogs.stdout || fallbackLogs.stderr || '';
    } else {
      joinedLogs = (resultData.logs || []).join('\n');
    }
    
    const truncatedLogs =
      joinedLogs.length > 500 ? joinedLogs.slice(-500) : joinedLogs;

    const summary: any = {
      success,
      mode: resultData.mode || 'inspection',
      breakpoints_hit: resultData.breakpoints_hit || [],
      errors: resultData.errors || [],
      logs: truncatedLogs,
    };

    // Add fallback-specific fields
    if (isFallbackMode) {
      summary.reason = resultData.reason || 'unknown';
      if (resultData.execution) {
        summary.execution = {
          exitCode: resultData.execution.exitCode,
          signal: resultData.execution.signal,
          durationMs: resultData.execution.durationMs
        };
      }
      if (resultData.fallbackLogs) {
        summary.logs_detail = {
          stdout: resultData.fallbackLogs.stdout || '',
          stderr: resultData.fallbackLogs.stderr || '',
          combined: resultData.fallbackLogs.combined || ''
        };
      }
    }

    // Add exit info if available
    if (resultData.exitCode !== undefined || resultData.exitSignal) {
      summary.exitCode = resultData.exitCode ?? null;
      summary.exitSignal = resultData.exitSignal ?? null;
    }
    if (resultData.runtimeMs !== undefined) {
      summary.runtimeMs = resultData.runtimeMs;
    }

    return summary;
  }

  /**
   * Build a compact version of the debug report to avoid excessive payloads.
   */
  private buildPersistedDebugReport(resultData: any) {
    const maxScripts = 50;
    const maxBindings = 100;

    const parsedScripts = (resultData.parsedScripts || [])
      .slice(0, maxScripts)
      .map((s: any) => ({
        url: s.url,
        normalized: s.normalized,
        isTarget: s.isTarget,
        sourceMapURL: s.sourceMapURL,
      }));

    const bindings = (resultData.bindings || [])
      .slice(0, maxBindings)
      .map((b: any) => ({
        url: b.url,
        line: b.line,
        success: b.success,
        method: b.method,
        generatedLine: (b as any).generatedLine,
        error: (b as any).error,
      }));

    const bindingsTotal = (resultData.bindings || []).length;
    const bindingsSuccess = (resultData.bindings || []).filter((b: any) => b.success).length;

    return {
      ...resultData,
      parsedScripts_total: (resultData.parsedScripts || []).length,
      bindings_total: bindingsTotal,
      bindings_success: bindingsSuccess,
      parsedScripts,
      bindings,
    };
  }

  static cleanupAll() {
    this.activeProcesses.forEach(p => {
      if (p && typeof p.kill === 'function') {
        p.kill('SIGKILL');
      }
    });
    this.activeProcesses.clear();
    this.logBuffers.clear();
    this.releaseAllPorts();
  }

  /**
   * Public cleanup method for extension deactivation
   * Called by extension.deactivate() to ensure processes are killed
   */
  public cleanup(): void {
    try {
      console.log('[NodeProcessTool] Cleanup called - killing all active processes');
      NodeProcessTool.cleanupAll();
    } catch (error) {
      console.error('[NodeProcessTool] Error during cleanup:', error);
    }
  }
}
