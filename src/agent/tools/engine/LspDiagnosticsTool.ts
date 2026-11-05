/**
 * LspDiagnosticsTool - "Check it."
 * 
 * Acts as the "Sanity Check" layer. It fetches existing compiler errors, warnings, and linter issues
 * directly from VS Code's "Problems" tab. Used as a Filter - if this returns errors, the Agent should
 * stop deeper analysis and tell the user to fix the syntax/types first.
 */

import * as vscode from 'vscode';
import * as path from 'path';
import { ITool, ToolResult } from '../definitions/ITool';
import { LspDiagnosticsToolSchema } from '../definitions/ToolSchemas';
import { z } from 'zod';

type LspDiagnosticsParams = z.infer<typeof LspDiagnosticsToolSchema>;

export class LspDiagnosticsTool implements ITool<LspDiagnosticsParams> {
  readonly name = 'lsp-diagnostics';
  readonly description = "Checks for active compiler errors, syntax issues, or type mismatches in a file (The 'Problems' tab).";
  readonly inputSchema = LspDiagnosticsToolSchema;

  async execute(params: LspDiagnosticsParams): Promise<ToolResult> {
    const { filePath, severity } = params;

    // 1. Safety Check: Is workspace open?
    const workspaceFolders = vscode.workspace.workspaceFolders;
    if (!workspaceFolders) {
      return { success: false, summary: "No workspace is currently open in VS Code." };
    }
    
    // 2. Resolve Path: Handle relative paths vs absolute paths
    const rootPath = workspaceFolders[0].uri.fsPath;
    const absPath = path.isAbsolute(filePath) ? filePath : path.resolve(rootPath, filePath);
    const uri = vscode.Uri.file(absPath);

    // 3. Fetch Diagnostics (Synchronous API call to VS Code internal cache)
    const diagnostics = vscode.languages.getDiagnostics(uri);

    // 4. Filter Results
    const filtered = diagnostics.filter(d => {
      if (!severity) return true; // Show all if no filter
      // VS Code Severity Enum: Error=0, Warning=1, Info=2, Hint=3
      if (severity === 'Error') return d.severity === vscode.DiagnosticSeverity.Error;
      if (severity === 'Warning') return d.severity === vscode.DiagnosticSeverity.Warning;
      return false;
    });

    // 5. Handle "Clean" State
    if (filtered.length === 0) {
      return {
        success: true,
        summary: `No ${severity || 'active'} issues found in '${filePath}'.`,
        structuredData: { count: 0 }
      };
    }

    // 6. Map to Evidence (RCA Optimized)
    const evidence = filtered.map(d => {
      // CRITICAL: Extract "Related Information" (e.g., "Duplicate identifier 'x' was also declared here...")
      // This allows the Agent to see multi-file errors.
      const related = d.relatedInformation?.map(r => 
        `${vscode.workspace.asRelativePath(r.location.uri)}:${r.location.range.start.line + 1} (${r.message})`
      ).join('; ');

      return {
        file: filePath,
        line: d.range.start.line + 1, // Convert 0-index to 1-index for humans
        text: d.message,
        severity: this.mapSeverity(d.severity),
        source: d.source || 'LSP', // e.g., 'ts', 'eslint', 'json'
        relatedInfo: related || undefined
      };
    });

    // 7. Construct Summary
    const errorCount = filtered.filter(d => d.severity === vscode.DiagnosticSeverity.Error).length;
    const topIssue = evidence.find(e => e.severity === 'Error') || evidence[0];
    
    const summary = `Found ${filtered.length} issues (${errorCount} Errors) in '${filePath}'.\nTop Issue (Line ${topIssue.line}): ${topIssue.text}`;

    return {
      success: true,
      summary,
      evidence,
      structuredData: {
        totalErrors: errorCount,
        totalWarnings: filtered.length - errorCount,
        // Helpful for the agent to know if this is a syntax blocker or just lint noise
        blockers: errorCount > 0
      }
    };
  }

  private mapSeverity(s: vscode.DiagnosticSeverity): string {
    switch(s) {
      case vscode.DiagnosticSeverity.Error: return 'Error';
      case vscode.DiagnosticSeverity.Warning: return 'Warning';
      case vscode.DiagnosticSeverity.Information: return 'Info';
      case vscode.DiagnosticSeverity.Hint: return 'Hint';
      default: return 'Unknown';
    }
  }
}


