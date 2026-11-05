/**
 * CodeSearchTool - "Find it."
 * 
 * Searches for files, definitions (symbols), or text patterns to orient the agent.
 * Implements the "Search -> Rank -> Tease" pipeline for high-quality results.
 * Returns file paths and a short teaser (5 lines around the match). Use
 * static-analysis (mode: 'source') to read full implementations after locating the file.
 */

import * as vscode from 'vscode';
import { ITool, ToolResult } from '../definitions/ITool';
import { CodeSearchToolSchema, CodeSearchParams } from '../definitions/ToolSchemas';
import { SearchUtils } from '../utils/SearchUtils';

export class CodeSearchTool implements ITool<CodeSearchParams> {
  readonly name = 'code-search';
  readonly description = 'Searches for files, definitions (symbols), or text patterns to orient the agent. Returns file paths plus a short teaser (not full code). Use static-analysis to read full implementations.';
  readonly inputSchema = CodeSearchToolSchema;

  private static readonly EXCLUDE_PATTERN = '{**/node_modules/**,**/.vscode-test/**,**/dist/**,**/build/**,**/.git/**,**/coverage/**}';
  private static readonly CACHE_TTL_MS = 30_000;
  private cache = new Map<string, { results: vscode.Uri[], timestamp: number }>();

  private async findFilesCached(pattern: string, exclude: string, limit: number): Promise<vscode.Uri[]> {
    const key = `${pattern}|${exclude}|${limit}`;
    const cached = this.cache.get(key);
    if (cached && Date.now() - cached.timestamp < CodeSearchTool.CACHE_TTL_MS) {
      return cached.results;
    }
    const results = await vscode.workspace.findFiles(pattern, exclude, limit);
    this.cache.set(key, { results, timestamp: Date.now() });
    return results;
  }

  /**
   * Normalizes a glob pattern to ensure it works with VS Code's findFiles.
   * If the pattern looks like a simple filename (no path separators or wildcards),
   * prepends a recursive glob prefix to make it search recursively.
   * 
   * @param pattern - The glob pattern to normalize
   * @returns The normalized pattern
   */
  private normalizePattern(pattern?: string): string {
    if (!pattern) return '';
    
    const trimmed = pattern.trim();
    
    // If it looks like a filename (no path separators and no wildcards),
    // make it recursive by prepending '**/'
    if (!trimmed.includes('/') && !trimmed.includes('*')) {
      return `**/${trimmed}`;
    }
    
    return trimmed;
  }

  async execute(params: CodeSearchParams): Promise<ToolResult> {
    const { query, mode, pattern } = params;

    try {
      // Safety check: Is workspace open?
      const workspaceFolders = vscode.workspace.workspaceFolders;
      if (!workspaceFolders) {
        return { success: false, summary: "No workspace is currently open in VS Code." };
      }

      // 1. GATHER CANDIDATES (Raw VS Code Search)
      let candidates: { uri: vscode.Uri, file: string, line: number }[] = [];
      let normalizedPattern: string | undefined; // Track normalized pattern for error messages

      if (mode === 'file') {
        // Build glob pattern: normalize if provided, otherwise search for query in filename
        const rawPattern = pattern || `**/*${query}*`;
        normalizedPattern = this.normalizePattern(rawPattern);
        
        // Log if pattern was normalized (for debugging)
        if (pattern && pattern !== normalizedPattern) {
          console.log(`[CodeSearchTool] Normalized pattern: "${pattern}" -> "${normalizedPattern}"`);
        }
        
        const files = await this.findFilesCached(normalizedPattern, CodeSearchTool.EXCLUDE_PATTERN, 50);
        candidates = files.map(uri => ({ 
          uri, 
          file: vscode.workspace.asRelativePath(uri), 
          line: 0 
        }));
      } 
      else if (mode === 'symbol') {
        const symbols = await vscode.commands.executeCommand<vscode.SymbolInformation[]>(
          'vscode.executeWorkspaceSymbolProvider', 
          query
        );
        
        if (symbols && Array.isArray(symbols)) {
          candidates = symbols.map(s => ({ 
            uri: s.location.uri, 
            file: vscode.workspace.asRelativePath(s.location.uri), 
            line: s.location.range.start.line 
          }));
        }
      } 
      else if (mode === 'text') {
        // For text search, find candidate files first, then search within them
        const rawPattern = pattern || '**/*.{ts,tsx,js,jsx,py,java,go,rs,cpp,c,cs}';
        const filePattern = this.normalizePattern(rawPattern);
        
        // Log if pattern was normalized (for debugging)
        if (pattern && pattern !== filePattern) {
          console.log(`[CodeSearchTool] Normalized pattern: "${pattern}" -> "${filePattern}"`);
        }
        
        const candidateFiles = await this.findFilesCached(
          filePattern,
          CodeSearchTool.EXCLUDE_PATTERN,
          100
        );

        // Search for query in each file (parallel)
        const queryLower = query.toLowerCase();
        const results = await Promise.all(candidateFiles.map(async (uri) => {
          try {
            const document = await vscode.workspace.openTextDocument(uri);
            const text = document.getText();
            const lines = text.split(/\r?\n/);
            for (let i = 0; i < lines.length; i++) {
              if (lines[i].toLowerCase().includes(queryLower)) {
                return { uri, file: vscode.workspace.asRelativePath(uri), line: i };
              }
            }
          } catch (e) { /* skip */ }
          return null;
        }));
        candidates = results.filter(Boolean) as typeof candidates;
      }

      // 2. RANK RESULTS (Filter Noise)
      const ranked = SearchUtils.rankResults(candidates, query);

      if (ranked.length === 0) {
        // Provide helpful feedback when no results are found
        let summary = `No matches found for '${query}' in mode '${mode}'.`;
        
        // If a pattern was provided and it might have been invalid, give a hint
        if (pattern && mode === 'file' && normalizedPattern) {
          if (pattern !== normalizedPattern) {
            summary += ` Note: Pattern "${pattern}" was normalized to "${normalizedPattern}". If you intended a specific path, use a glob pattern like "src/**/*.ts" or "**/Tool.ts".`;
          } else if (!pattern.includes('*') && !pattern.includes('**')) {
            summary += ` Tip: If searching for files, use glob patterns with wildcards (e.g., "**/*Tool.ts" or "src/**/*.ts").`;
          }
        }
        
        return { 
          success: true, 
          summary,
          structuredData: [] 
        };
      }

      // 3. GENERATE TEASERS (Only for winners)
      const evidence = await Promise.all(ranked.map(async (match) => ({
        file: match.file,
        line: match.line + 1,
        text: await SearchUtils.extractTeaser(match.uri, match.line),
        description: `Score: ${match.score} (Match: ${query})`
      })));

      return {
        success: true,
        summary: `Found ${candidates.length} raw matches. Showing top ${ranked.length} ranked results (teasers only; use static-analysis for full code).`,
        evidence,
        structuredData: ranked.map(r => ({ file: r.file, score: r.score, line: r.line + 1 }))
      };

    } catch (error: any) {
      return { 
        success: false, 
        summary: `Search failed: ${error.message}` 
      };
    }
  }
}


