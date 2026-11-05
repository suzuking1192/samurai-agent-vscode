/**
 * GitHistoryTool - "Trace it."
 * 
 * Retrieves git history for files, commits, and changes.
 * This tool provides version control information and change tracking.
 */

import { ITool, ToolResult } from '../definitions/ITool';
import { GitHistoryToolSchema } from '../definitions/ToolSchemas';
import { z } from 'zod';
import { simpleGit, SimpleGit } from 'simple-git';
import * as vscode from 'vscode';
import * as path from 'path';

export class GitHistoryTool implements ITool<z.infer<typeof GitHistoryToolSchema>> {
  readonly name = 'git-history';
  readonly description = 'Retrieves git history for files, commits, and changes. Provides version control information including commit messages, authors, dates, and file diffs.';
  readonly inputSchema = GitHistoryToolSchema;

  private getWorkspaceRoot(): string | undefined {
    return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  }

  private async getGitInstance(workspaceRoot: string): Promise<SimpleGit> {
    return simpleGit({
      baseDir: workspaceRoot,
      maxConcurrentProcesses: 2,
      config: ['core.quotepath=off']
    });
  }

  async execute(params: z.infer<typeof GitHistoryToolSchema>): Promise<ToolResult> {
    const workspaceRoot = this.getWorkspaceRoot();
    
    if (!workspaceRoot) {
      return {
        success: false,
        summary: 'No workspace folder open',
        structuredData: undefined,
        evidence: []
      };
    }

    try {
      const git = await this.getGitInstance(workspaceRoot);
      
      // Check if this is a git repository
      const isRepo = await git.checkIsRepo();
      if (!isRepo) {
        return {
          success: false,
          summary: 'Not a git repository',
          structuredData: undefined,
          evidence: []
        };
      }

      // Normalize file path relative to workspace root
      const filePath = path.isAbsolute(params.filePath) 
        ? path.relative(workspaceRoot, params.filePath)
        : params.filePath;

      switch (params.mode) {
        case 'diff':
          return await this.executeDiff(git, filePath, params.since);
        case 'log':
          return await this.executeLog(git, filePath);
        case 'blame':
          return await this.executeBlame(git, filePath, params.lineRange);
        default:
          return {
            success: false,
            summary: `Unknown mode: ${params.mode}`,
            structuredData: undefined,
            evidence: []
          };
      }
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      return {
        success: false,
        summary: `Git operation failed: ${errorMessage}`,
        structuredData: undefined,
        evidence: []
      };
    }
  }

  private async executeDiff(git: SimpleGit, filePath: string, since?: string): Promise<ToolResult> {
    // Default to HEAD~1 to show most recent committed changes
    // Compare HEAD~1 to HEAD to see what changed in the last commit
    const baseRef = since || 'HEAD~1';
    
    try {
      // git diff HEAD~1 -- filePath compares HEAD~1 to HEAD (or working directory)
      // For custom since, git diff since -- filePath compares since to HEAD
      const diff = await git.diff([baseRef, '--', filePath]);
      
      if (!diff || diff.trim().length === 0) {
        return {
          success: true,
          summary: `No changes found in '${filePath}' since ${baseRef}`,
          structuredData: {
            mode: 'diff',
            base: baseRef,
            filePath: filePath
          },
          evidence: []
        };
      }

      return {
        success: true,
        summary: `Found changes in '${filePath}' since ${baseRef}`,
        structuredData: {
          mode: 'diff',
          base: baseRef,
          filePath: filePath
        },
        evidence: [
          {
            file: filePath,
            line: 1,
            text: diff
          }
        ]
      };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      return {
        success: false,
        summary: `Failed to get diff: ${errorMessage}`,
        structuredData: undefined,
        evidence: []
      };
    }
  }

  private async executeLog(git: SimpleGit, filePath: string): Promise<ToolResult> {
    try {
      const log = await git.log({
        file: filePath,
        maxCount: 5
      });

      if (!log.all || log.all.length === 0) {
        return {
          success: true,
          summary: `No commit history found for '${filePath}'`,
          structuredData: {
            mode: 'log',
            filePath: filePath,
            commits: []
          },
          evidence: []
        };
      }

      const commits = log.all.map(commit => ({
        hash: commit.hash,
        date: commit.date,
        author_name: commit.author_name,
        message: commit.message
      }));

      return {
        success: true,
        summary: `Found ${commits.length} recent commit(s) for '${filePath}'`,
        structuredData: {
          mode: 'log',
          filePath: filePath,
          commits: commits
        },
        evidence: commits.map((commit, index) => ({
          file: filePath,
          line: index + 1,
          text: `${commit.hash.substring(0, 7)} - ${commit.author_name} - ${commit.date}\n${commit.message}`
        }))
      };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      return {
        success: false,
        summary: `Failed to get log: ${errorMessage}`,
        structuredData: undefined,
        evidence: []
      };
    }
  }

  private async executeBlame(git: SimpleGit, filePath: string, lineRange?: [number, number]): Promise<ToolResult> {
    if (!lineRange) {
      return {
        success: false,
        summary: 'lineRange is required for blame mode',
        structuredData: undefined,
        evidence: []
      };
    }

    const [startLine, endLine] = lineRange;
    
    if (startLine < 1 || endLine < 1 || startLine > endLine) {
      return {
        success: false,
        summary: 'Invalid lineRange: start and end must be >= 1, and start <= end',
        structuredData: undefined,
        evidence: []
      };
    }

    try {
      // git blame -L start,end -- filePath
      const blame = await git.raw(['blame', `-L${startLine},${endLine}`, '--', filePath]);
      
      if (!blame || blame.trim().length === 0) {
        return {
          success: true,
          summary: `No blame information found for lines ${startLine}-${endLine} in '${filePath}'`,
          structuredData: {
            mode: 'blame',
            filePath: filePath,
            lineRange: [startLine, endLine],
            lines: []
          },
          evidence: []
        };
      }

      // Parse blame output
      // Format: <commit-hash> (<author> <date> <line-number>) <line-content>
      const lines = blame.trim().split('\n').map((line, index) => {
        const match = line.match(/^(\S+)\s+\(([^)]+)\s+(\d{4}-\d{2}-\d{2})\s+(\d+):\d+\)\s+(.*)$/);
        if (match) {
          const [, commit, author, date, lineNum, content] = match;
          return {
            line: parseInt(lineNum, 10),
            commit: commit,
            author: author.trim(),
            date: date,
            content: content
          };
        }
        // Fallback for lines that don't match the expected format
        return {
          line: startLine + index,
          commit: 'unknown',
          author: 'unknown',
          date: 'unknown',
          content: line
        };
      });

      return {
        success: true,
        summary: `Blame information for lines ${startLine}-${endLine} in '${filePath}'`,
        structuredData: {
          mode: 'blame',
          filePath: filePath,
          lineRange: [startLine, endLine],
          lines: lines
        },
        evidence: lines.map(line => ({
          file: filePath,
          line: line.line,
          text: `${line.commit.substring(0, 7)} - ${line.author} - ${line.date}: ${line.content}`
        }))
      };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      return {
        success: false,
        summary: `Failed to get blame: ${errorMessage}`,
        structuredData: undefined,
        evidence: []
      };
    }
  }
}


