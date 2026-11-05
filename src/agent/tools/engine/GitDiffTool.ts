/**
 * GitDiffTool - Agent tool for getting git diffs with token/memory safety caps.
 */

import { ITool, ToolResult } from '../definitions/ITool';
import { GitDiffToolSchema } from '../definitions/ToolSchemas';
import { z } from 'zod';
import { simpleGit, SimpleGit } from 'simple-git';
import * as vscode from 'vscode';
import * as path from 'path';

const MAX_DIFF_CHARS = 20000;

export class GitDiffTool implements ITool<z.infer<typeof GitDiffToolSchema>> {
  readonly name = 'git-diff';
  readonly description = 'Get git diffs for working tree, branch comparisons, or between commits. Returns unified diff with safety caps to prevent token explosion.';
  readonly inputSchema = GitDiffToolSchema;

  private getWorkspaceRoot(workspaceRoot?: string): string | undefined {
    if (workspaceRoot) return workspaceRoot;
    return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  }

  async execute(params: z.infer<typeof GitDiffToolSchema>): Promise<ToolResult> {
    const wsRoot = this.getWorkspaceRoot(params.workspaceRoot);
    if (!wsRoot) {
      return { success: false, summary: 'No workspace folder open', evidence: [] };
    }

    const git = simpleGit({ baseDir: wsRoot, maxConcurrentProcesses: 2, config: ['core.quotepath=off'] });

    try {
      const isRepo = await git.checkIsRepo();
      if (!isRepo) {
        return { success: false, summary: 'Not a git repository', evidence: [] };
      }

      switch (params.mode) {
        case 'working-tree':
          return await this._workingTreeDiff(git, wsRoot, params.files);
        case 'branch':
          return await this._branchDiff(git, wsRoot, params.baseRef || 'main');
        case 'commits':
          return await this._commitsDiff(git, wsRoot, params.baseRef || 'HEAD~1', params.targetRef || 'HEAD');
        default:
          return { success: false, summary: `Unknown mode: ${params.mode}`, evidence: [] };
      }
    } catch (error) {
      return {
        success: false,
        summary: `Git diff failed: ${error instanceof Error ? error.message : String(error)}`,
        evidence: [],
      };
    }
  }

  private async _workingTreeDiff(git: SimpleGit, wsRoot: string, files?: string[]): Promise<ToolResult> {
    const args = ['--no-renames', '--no-color'];
    if (files && files.length > 0) {
      const relFiles = files.map(f => path.isAbsolute(f) ? path.relative(wsRoot, f) : f);
      args.push('--', ...relFiles);
    }

    let diffText = await git.diff(args);
    // Also include staged
    const stagedDiff = await git.diff(['--cached', '--no-renames', '--no-color', ...(files ? ['--', ...files] : [])]);
    diffText = (diffText + '\n' + stagedDiff).trim();

    return this._buildResult(diffText, wsRoot, git);
  }

  private async _branchDiff(git: SimpleGit, wsRoot: string, baseRef: string): Promise<ToolResult> {
    const diffText = await git.diff([`${baseRef}...HEAD`, '--no-renames', '--no-color']);
    return this._buildResult(diffText, wsRoot, git);
  }

  private async _commitsDiff(git: SimpleGit, wsRoot: string, baseRef: string, targetRef: string): Promise<ToolResult> {
    const diffText = await git.diff([baseRef, targetRef, '--no-renames', '--no-color']);
    return this._buildResult(diffText, wsRoot, git);
  }

  private async _buildResult(diffText: string, wsRoot: string, git: SimpleGit): Promise<ToolResult> {
    // Parse stats
    const changedFiles: string[] = [];
    let additions = 0;
    let deletions = 0;
    for (const line of diffText.split('\n')) {
      if (line.startsWith('+++ b/')) changedFiles.push(line.slice(6));
      else if (line.startsWith('+') && !line.startsWith('+++')) additions++;
      else if (line.startsWith('-') && !line.startsWith('---')) deletions++;
    }

    let truncated = false;
    const omittedFiles: string[] = [];

    if (diffText.length > MAX_DIFF_CHARS) {
      truncated = true;
      diffText = diffText.slice(0, MAX_DIFF_CHARS);
    }

    // Build per-file summary for large diffs
    let summary: string;
    if (truncated) {
      const fileSummary = changedFiles.map(f => `  ${f}`).join('\n');
      summary = `Diff truncated (${changedFiles.length} files, +${additions}/-${deletions}). Files:\n${fileSummary}\nUse 'files' param to inspect specific files.`;
    } else {
      summary = `Diff for ${changedFiles.length} file(s): +${additions}/-${deletions} lines`;
    }

    return {
      success: true,
      summary,
      structuredData: {
        changedFiles,
        stats: { additions, deletions, fileCount: changedFiles.length },
        truncated,
        omittedFiles: truncated ? omittedFiles : undefined,
      },
      evidence: diffText ? [{
        file: 'git-diff',
        line: 1,
        text: diffText,
      }] : [],
    };
  }
}
