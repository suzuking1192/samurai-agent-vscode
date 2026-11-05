/**
 * SandboxFileSystemTool - "The Sandbox"
 * 
 * File operations strictly within .samurai/sandbox/ directory.
 * Provides safe, isolated file operations for runtime analysis scripts.
 */

import { ITool, ToolResult } from '../definitions/ITool';
import { SandboxFileSystemSchema, SandboxFileSystemParams } from '../definitions/ToolSchemas';
import { StreamReporter } from '../../utils/StreamReporter';
import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';

export class SandboxFileSystemTool implements ITool<SandboxFileSystemParams> {
  name = "sandbox-fs";
  description = "Manages files in the isolated .samurai/sandbox directory. Use this to create reproduction scripts.";
  inputSchema = SandboxFileSystemSchema;
  private reporter?: StreamReporter;

  setReporter(reporter?: StreamReporter): void {
    this.reporter = reporter;
  }

  async execute(params: SandboxFileSystemParams): Promise<ToolResult> {
    const workspaceFolders = vscode.workspace.workspaceFolders;
    if (!workspaceFolders || workspaceFolders.length === 0) {
      return { success: false, summary: "No workspace open." };
    }

    const rootPath = workspaceFolders[0].uri.fsPath;
    const sandboxRoot = path.join(rootPath, '.samurai', 'sandbox');

    const log = (message: string) => {
      try {
        this.reporter?.sendLogUpdate(message, 'stdout');
      } catch {
        // best effort; ignore logging failures
      }
    };

    // Ensure sandbox exists
    if (!fs.existsSync(sandboxRoot)) {
      fs.mkdirSync(sandboxRoot, { recursive: true });
    }

    try {
      // 1. LIST
      if (params.action === 'list') {
        log(`$ sandbox-fs list`);
        const files = fs.readdirSync(sandboxRoot);
        log(`Listed ${files.length} file(s)`);
        return {
          success: true,
          summary: `Sandbox contains ${files.length} files.`,
          structuredData: files
        };
      }

      // 2. CLEANUP
      if (params.action === 'cleanup') {
        log(`$ sandbox-fs cleanup`);
        // Safety: Only delete the contents, keep the folder
        fs.rmSync(sandboxRoot, { recursive: true, force: true });
        fs.mkdirSync(sandboxRoot);
        log(`Sandbox cleaned`);
        return { success: true, summary: "Sandbox cleared." };
      }

      // Check for unknown action before requiring filename
      if (!['write', 'delete'].includes(params.action)) {
        return { success: false, summary: "Unknown action." };
      }

      // For Write/Delete, filename is required
      if (!params.filename) {
        return { success: false, summary: "Filename required for this action." };
      }

      // SECURITY: Path Traversal Protection
      // Prevent "repro.ts" from becoming "../../src/index.ts"
      const targetPath = path.resolve(sandboxRoot, params.filename);
      if (!targetPath.startsWith(sandboxRoot)) {
        return { success: false, summary: "Security Error: Cannot access files outside the sandbox." };
      }

      // 3. WRITE
      if (params.action === 'write') {
        if (typeof params.content !== 'string') {
          return { success: false, summary: "Content required for write." };
        }

        // Ensure parent directories exist
        const dirPath = path.dirname(targetPath);
        if (!fs.existsSync(dirPath)) {
          fs.mkdirSync(dirPath, { recursive: true });
        }

        log(`$ sandbox-fs write ${params.filename}`);
        fs.writeFileSync(targetPath, params.content, 'utf8');
        log(`Wrote ${params.content.length} bytes to ${params.filename}`);
        return {
          success: true,
          summary: `Wrote ${params.content.length} bytes to ${params.filename}.`,
          structuredData: { path: targetPath }
        };
      }

      // 4. DELETE
      if (params.action === 'delete') {
        if (fs.existsSync(targetPath)) {
          log(`$ sandbox-fs delete ${params.filename}`);
          fs.unlinkSync(targetPath);
          log(`Deleted ${params.filename}`);
          return { success: true, summary: `Deleted ${params.filename}` };
        }
        return { success: true, summary: "File did not exist (no action taken)." };
      }

      // This should never be reached due to the check above, but TypeScript needs it
      return { success: false, summary: "Unknown action." };
    } catch (e: any) {
      log(`Sandbox Error: ${e.message}`);
      return { success: false, summary: `Sandbox Error: ${e.message}` };
    }
  }
}

