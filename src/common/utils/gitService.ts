/**
 * Enhanced Git Service for root cause analysis
 * 
 * Provides comprehensive git operations with structured diffs, batching,
 * and relevance scoring to support debugging analysis with historical context
 */

import { simpleGit, SimpleGit, LogResult } from 'simple-git';
import * as path from 'path';
import * as fs from 'fs';
import { GitChange } from '../../agent/tools/debugging/rootCauseTypes';

// Enhanced types for structured diffs
export interface GitFileChange {
  path: string;
  oldPath?: string;      // for renames/copies
  status: "A"|"M"|"D"|"R"|"C";
  additions?: number;
  deletions?: number;
  isBinary?: boolean;
}

export interface RelevanceOpts {
  relevantFiles?: string[];
  graphFiles?: string[];
  errorFiles?: string[];
  recencyHalfLifeDays?: number;
}

export interface BlameResult {
  hash: string;
  author: string;
  summary: string;
  date: Date;
}

export type Result<T> = {
  ok: true;
  value: T;
} | {
  ok: false;
  error: string;
}

export class GitService {
  private git: SimpleGit;
  private workspaceRoot: string;
  private gitCachePath: string;
  private cache: Map<string, { data: any; timestamp: number }> = new Map();
  private readonly CACHE_TTL = 5 * 60 * 1000; // 5 minutes
  private isGitRepo: boolean | null = null; // null = not checked yet
  private gitCheckLogged: boolean = false; // Track if we've logged the warning

  constructor(workspaceRoot: string) {
    this.workspaceRoot = workspaceRoot;
    this.git = simpleGit({ 
      baseDir: workspaceRoot, 
      maxConcurrentProcesses: 2, 
      config: ['core.quotepath=off'] 
    });
    this.gitCachePath = path.join(workspaceRoot, '.samurai_cache', 'git.json');
    this.ensureCacheDir();
  }

  private ensureCacheDir(): void {
    try {
      const cacheDir = path.dirname(this.gitCachePath);
      if (!fs.existsSync(cacheDir)) {
        fs.mkdirSync(cacheDir, { recursive: true });
      }
    } catch (error) {
      // Ignore cache directory creation errors in tests
      console.warn('[GitService] Failed to create cache directory:', error);
    }
  }

  private normalizePath(filePath: string): string {
    return filePath.replace(/\\/g, '/');
  }

  private async withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
    const timeout = new Promise<never>((_, reject) => 
      setTimeout(() => reject(new Error('Operation timed out')), timeoutMs)
    );
    return Promise.race([promise, timeout]);
  }

  private getCacheKey(operation: string, ...args: string[]): string {
    return `${operation}:${args.join(':')}`;
  }

  private getCached<T>(key: string): T | null {
    const cached = this.cache.get(key);
    if (cached && (Date.now() - cached.timestamp < this.CACHE_TTL)) {
      return cached.data;
    }
    this.cache.delete(key);
    return null;
  }

  private setCached<T>(key: string, data: T): void {
    this.cache.set(key, { data, timestamp: Date.now() });
  }

  /**
   * Parse git name-status output for file changes
   */
  private parseNameStatus(raw: string): Record<string, { status: string; oldPath?: string }> {
    const map: Record<string, { status: string; oldPath?: string }> = {};
    raw.split('\n').forEach(line => {
      const parts = line.split('\t');
      if (!parts[0]) return;
      const code = parts[0];
      if (code.startsWith('R') || code.startsWith('C')) {
        const [, oldPath, newPath] = parts;
        map[newPath] = { status: code[0], oldPath };
      } else {
        const [, p] = parts;
        if (p) map[p] = { status: code[0] };
      }
    });
    return map;
  }

  /**
   * Parse git numstat output and merge with name-status
   */
  private parseNumstat(raw: string, statusMap: Record<string, { status: string; oldPath?: string }>): GitFileChange[] {
    const out: GitFileChange[] = [];
    raw.split('\n').forEach(line => {
      const m = line.match(/^(\d+|-)\s+(\d+|-)\s+(.+)$/);
      if (!m) return;
      const [, add, del, p] = m;
      const meta = statusMap[p] ?? { status: 'M' };
      out.push({
        path: this.normalizePath(p),
        oldPath: meta.oldPath ? this.normalizePath(meta.oldPath) : undefined,
        status: meta.status as "A"|"M"|"D"|"R"|"C",
        additions: add === '-' ? undefined : Number(add),
        deletions: del === '-' ? undefined : Number(del),
        isBinary: add === '-' || del === '-'
      });
    });
    
    // Include files that had status but no numstat (e.g., deletes)
    for (const [p, meta] of Object.entries(statusMap)) {
      if (!out.find(f => f.path === this.normalizePath(p))) {
        out.push({ 
          path: this.normalizePath(p), 
          oldPath: meta.oldPath ? this.normalizePath(meta.oldPath) : undefined, 
          status: meta.status as "A"|"M"|"D"|"R"|"C" 
        });
      }
    }
    return out;
  }

  /**
   * Parse combined log output for detailed commits
   */
  private parseCombinedLog(raw: string): GitChange[] {
    const commits: GitChange[] = [];
    const lines = raw.split('\n');
    let currentCommit: Partial<GitChange> | null = null;
    let inFileChanges = false;
    const fileChanges: GitFileChange[] = [];
    const statusMap: Record<string, { status: string; oldPath?: string }> = {};

    for (const line of lines) {
      if (line.match(/^[a-f0-9]{40}\t/)) {
        // New commit line
        if (currentCommit) {
          currentCommit.files = fileChanges;
          commits.push(currentCommit as GitChange);
        }
        
        const [hash, parents, author, date, ...messageParts] = line.split('\t');
        currentCommit = {
          hash,
          message: messageParts.join('\t'),
          author,
          date: new Date(date),
          files: [],
          relevanceScore: 0,
          parents: parents ? parents.split(' ') : undefined,
          isMerge: Boolean(parents && parents.split(' ').length > 1)
        };
        inFileChanges = false;
        fileChanges.length = 0;
        Object.keys(statusMap).forEach(k => delete statusMap[k]);
      } else if (line.startsWith('A\t') || line.startsWith('M\t') || line.startsWith('D\t') || 
                 line.startsWith('R') || line.startsWith('C')) {
        // Name-status line
        inFileChanges = true;
        const parts = line.split('\t');
        const code = parts[0];
        if (code.startsWith('R') || code.startsWith('C')) {
          const [, oldPath, newPath] = parts;
          statusMap[newPath] = { status: code[0], oldPath };
        } else {
          const [, p] = parts;
          if (p) statusMap[p] = { status: code[0] };
        }
      } else if (inFileChanges && line.match(/^\d+|-/) && line.includes('\t')) {
        // Numstat line
        const m = line.match(/^(\d+|-)\s+(\d+|-)\s+(.+)$/);
        if (m) {
          const [, add, del, p] = m;
          const meta = statusMap[p] ?? { status: 'M' };
          fileChanges.push({
            path: this.normalizePath(p),
            oldPath: meta.oldPath ? this.normalizePath(meta.oldPath) : undefined,
            status: meta.status as "A"|"M"|"D"|"R"|"C",
            additions: add === '-' ? undefined : Number(add),
            deletions: del === '-' ? undefined : Number(del),
            isBinary: add === '-' || del === '-'
          });
        }
      }
    }

    if (currentCommit) {
      currentCommit.files = fileChanges;
      commits.push(currentCommit as GitChange);
    }

    return commits;
  }

  /**
   * Compute relevance score for a commit
   */
  computeRelevance(change: GitChange, opts: RelevanceOpts = {}): number {
    const {
      relevantFiles = [],
      graphFiles = [],
      errorFiles = [],
      recencyHalfLifeDays = 14
    } = opts;

    const filePaths = change.files.map(f => f.path);
    
    // File overlap scores
    const inGraph = this.overlap(filePaths, graphFiles).length;
    const touchesError = this.overlap(filePaths, errorFiles).length;
    const touchesRelevant = this.overlap(filePaths, relevantFiles).length;
    
    // Lines of code changed
    const loc = change.files.reduce((sum, f) => 
      sum + (f.additions ?? 0) + (f.deletions ?? 0), 0
    );
    
    // Recency decay
    const daysSinceCommit = (Date.now() - change.date.getTime()) / (1000 * 60 * 60 * 24);
    const recency = Math.exp(-daysSinceCommit / recencyHalfLifeDays);
    
    // Fix-related keywords
    const hasFixWord = /\b(fix|bug|hotfix|regression|revert|patch)\b/i.test(change.message) ? 1 : 0;
    
    // Normalize scores
    const normalizedLoc = Math.min(1, loc / 100); // Cap at 100 lines
    const normalizedInGraph = Math.min(1, inGraph / 3); // Cap at 3 files
    const normalizedTouchesError = Math.min(1, touchesError / 2); // Cap at 2 files
    const normalizedTouchesRelevant = Math.min(1, touchesRelevant / 5); // Cap at 5 files

    return 0.35 * recency + 
           0.25 * normalizedLoc + 
           0.2 * normalizedInGraph + 
           0.15 * normalizedTouchesError + 
           0.05 * normalizedTouchesRelevant + 
           0.05 * hasFixWord;
  }

  private overlap(a: string[], b: string[]): string[] {
    const setB = new Set(b);
    return a.filter(item => setB.has(item));
  }

  /**
   * Check if this is a git repository (with caching)
   */
  private async checkIsGitRepository(): Promise<boolean> {
    if (this.isGitRepo !== null) {
      return this.isGitRepo;
    }

    try {
      // Check if .git directory exists
      const gitDir = path.join(this.workspaceRoot, '.git');
      this.isGitRepo = fs.existsSync(gitDir);
      
      if (!this.isGitRepo) {
        // Try parent directories (for submodules or nested git repos)
        let currentDir = this.workspaceRoot;
        for (let i = 0; i < 5; i++) {
          currentDir = path.dirname(currentDir);
          if (currentDir === path.dirname(currentDir)) break; // Reached root
          
          const parentGitDir = path.join(currentDir, '.git');
          if (fs.existsSync(parentGitDir)) {
            this.isGitRepo = true;
            break;
          }
        }
      }

      if (!this.isGitRepo && !this.gitCheckLogged) {
        console.log('[GitService] Not a git repository, skipping git operations');
        this.gitCheckLogged = true;
      }

      return this.isGitRepo;
    } catch (error) {
      this.isGitRepo = false;
      if (!this.gitCheckLogged) {
        console.log('[GitService] Failed to check git repository:', error);
        this.gitCheckLogged = true;
      }
      return false;
    }
  }

  // Repo / state methods
  async isGitRepository(): Promise<boolean> {
    return this.checkIsGitRepository();
  }

  async getCurrentBranch(): Promise<string> {
    if (!(await this.checkIsGitRepository())) {
      return 'unknown';
    }
    
    try {
      const branch = await this.git.revparse(['--abbrev-ref', 'HEAD']);
      return branch.trim();
    } catch (error) {
      console.warn('[GitService] Failed to get current branch:', error);
      return 'unknown';
    }
  }

  async getCurrentCommitHash(): Promise<string> {
    if (!(await this.checkIsGitRepository())) {
      return 'unknown';
    }
    
    try {
      const hash = await this.git.revparse(['HEAD']);
      return hash.trim();
    } catch (error) {
      console.warn('[GitService] Failed to get current commit hash:', error);
      return 'unknown';
    }
  }

  async getMergeBase(a: string = 'HEAD', b: string = 'origin/main'): Promise<string> {
    if (!(await this.checkIsGitRepository())) {
      return a;
    }
    
    try {
      const result = await this.withTimeout(
        this.git.raw(['merge-base', a, b]), 
        5000
      );
      return result.trim();
    } catch (error) {
      console.warn(`[GitService] Failed to get merge base for ${a}..${b}:`, error);
      return a;
    }
  }

  // Commits & ranges methods
  async getDetailedCommits(limit: number = 10): Promise<GitChange[]> {
    if (!(await this.checkIsGitRepository())) {
      return [];
    }
    
    const cacheKey = this.getCacheKey('detailedCommits', String(limit));
    const cached = this.getCached<GitChange[]>(cacheKey);
    if (cached) return cached;

    try {
      const raw = await this.withTimeout(
        this.git.raw([
          'log', `-n`, String(limit),
          '--pretty=format:%H%x09%P%x09%an%x09%ai%x09%s',
          '--name-status', '-M', '-C', '--numstat'
        ]),
        10000
      );
      
      const commits = this.parseCombinedLog(raw);
      this.setCached(cacheKey, commits);
      return commits;
    } catch (error) {
      console.warn('[GitService] Failed to get detailed commits:', error);
      return [];
    }
  }

  async getCommitChanges(commit: string): Promise<GitFileChange[]> {
    if (!(await this.checkIsGitRepository())) {
      return [];
    }
    
    const cacheKey = this.getCacheKey('commitChanges', commit);
    const cached = this.getCached<GitFileChange[]>(cacheKey);
    if (cached) return cached;

    try {
      // Get name-status with renames/copies
      const nameStatus = await this.withTimeout(
        this.git.raw(['show', '--pretty=format:', '--name-status', '-M', '-C', commit]),
        5000
      );

      // Get numstat for additions/deletions
      const numstat = await this.withTimeout(
        this.git.raw(['show', '--pretty=format:', '--numstat', commit]),
        5000
      );

      const statusMap = this.parseNameStatus(nameStatus);
      const changes = this.parseNumstat(numstat, statusMap);
      
      this.setCached(cacheKey, changes);
      return changes;
    } catch (error) {
      console.warn(`[GitService] Failed to get changes for commit ${commit}:`, error);
      return [];
    }
  }

  async getFilesChangedSince(base: string, head: string = 'HEAD'): Promise<GitFileChange[]> {
    if (!(await this.checkIsGitRepository())) {
      return [];
    }
    
    try {
      const nameStatus = await this.withTimeout(
        this.git.raw(['diff', '--name-status', '-M', '-C', base, head]),
        5000
      );

      const numstat = await this.withTimeout(
        this.git.raw(['diff', '--numstat', base, head]),
        5000
      );

      const statusMap = this.parseNameStatus(nameStatus);
      return this.parseNumstat(numstat, statusMap);
    } catch (error) {
      console.warn(`[GitService] Failed to get files changed since ${base}:`, error);
      return [];
    }
  }

  // File methods
  async getFileHistory(filePath: string, limit: number = 5): Promise<GitChange[]> {
    if (!(await this.checkIsGitRepository())) {
      return [];
    }
    
    const normalizedPath = this.normalizePath(filePath);
    const cacheKey = this.getCacheKey('fileHistory', normalizedPath, String(limit));
    const cached = this.getCached<GitChange[]>(cacheKey);
    if (cached) return cached;

    try {
      const raw = await this.withTimeout(
        this.git.raw([
          'log', `-n`, String(limit),
          '--follow', '--pretty=format:%H%x09%P%x09%an%x09%ai%x09%s',
          '--name-status', '-M', '--', normalizedPath
        ]),
        5000
      );

      const commits = this.parseCombinedLog(raw);
      this.setCached(cacheKey, commits);
      return commits;
    } catch (error) {
      console.warn(`[GitService] Failed to get file history for ${filePath}:`, error);
      return [];
    }
  }

  async getFileAtCommit(filePath: string, commit: string): Promise<string> {
    if (!(await this.checkIsGitRepository())) {
      return '';
    }
    
    const normalizedPath = this.normalizePath(filePath);
    try {
      const content = await this.withTimeout(
        this.git.show([`${commit}:${normalizedPath}`]),
        3000
      );
      return content;
    } catch (error) {
      console.warn(`[GitService] Failed to get file ${filePath} at commit ${commit}:`, error);
      return '';
    }
  }

  async blame(filePath: string, line: number): Promise<BlameResult | null> {
    if (!(await this.checkIsGitRepository())) {
      return null;
    }
    
    const normalizedPath = this.normalizePath(filePath);
    try {
      const raw = await this.withTimeout(
        this.git.raw(['blame', `-L`, `${line},${line}`, '--porcelain', '--', normalizedPath]),
        3000
      );

      const lines = raw.split('\n');
      let hash = '';
      let author = '';
      let summary = '';
      let date = '';

      for (const line of lines) {
        if (line.startsWith('author ')) {
          author = line.substring(7);
        } else if (line.startsWith('author-time ')) {
          date = line.substring(12);
        } else if (line.startsWith('summary ')) {
          summary = line.substring(8);
        } else if (line.match(/^[a-f0-9]{40}/)) {
          hash = line.split(' ')[0];
        }
      }

      if (hash && author) {
        return {
          hash,
          author,
          summary: summary || 'No summary',
          date: new Date(parseInt(date) * 1000)
        };
      }
      return null;
    } catch (error) {
      console.warn(`[GitService] Failed to blame ${filePath}:${line}:`, error);
      return null;
    }
  }

  // Working tree methods
  async getWorkingTreeChanges(): Promise<GitFileChange[]> {
    if (!(await this.checkIsGitRepository())) {
      return [];
    }
    
    try {
      const status = await this.git.status();
      const changes: GitFileChange[] = [];

      // Modified files
      status.modified.forEach(file => {
        changes.push({
          path: this.normalizePath(file),
          status: 'M'
        });
      });

      // Added files
      status.created.forEach(file => {
        changes.push({
          path: this.normalizePath(file),
          status: 'A'
        });
      });

      // Deleted files
      status.deleted.forEach(file => {
        changes.push({
          path: this.normalizePath(file),
          status: 'D'
        });
      });

      // Renamed files
      status.renamed.forEach(rename => {
        changes.push({
          path: this.normalizePath(rename.to),
          oldPath: this.normalizePath(rename.from),
          status: 'R'
        });
      });

      return changes;
    } catch (error) {
      console.warn('[GitService] Failed to get working tree changes:', error);
      return [];
    }
  }

  // Legacy methods for backward compatibility
  async getRecentCommits(limit: number = 10): Promise<GitChange[]> {
    const commits = await this.getDetailedCommits(limit);
    return commits; // Return the structured format directly
  }

  async getCommitDiff(commitHash: string): Promise<string> {
    if (!(await this.checkIsGitRepository())) {
      return '';
    }
    
    try {
      const diff = await this.git.show([commitHash, '--name-only']);
      return diff;
    } catch (error) {
      console.warn(`[GitService] Failed to get diff for commit ${commitHash}:`, error);
      return '';
    }
  }

  async getCommitFiles(commitHash: string): Promise<string[]> {
    const changes = await this.getCommitChanges(commitHash);
    return changes.map(f => f.path);
  }

  async fileExistsInGit(filePath: string): Promise<boolean> {
    if (!(await this.checkIsGitRepository())) {
      return false;
    }
    
    try {
      await this.git.show([`HEAD:${this.normalizePath(filePath)}`]);
      return true;
    } catch (error) {
      return false;
    }
  }

  // Cache management
  clearCache(): void {
    this.cache.clear();
  }

  // Helper methods
  rankGitChangesByRelevance(gitChanges: GitChange[], relevantFiles: string[]): GitChange[] {
    return gitChanges.map(change => ({
      ...change,
      relevanceScore: this.computeRelevance(change, { relevantFiles })
    })).sort((a, b) => b.relevanceScore - a.relevanceScore);
  }
}