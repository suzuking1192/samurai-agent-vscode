/**
 * AIToolPlanDiscovery - Discovers plan files from AI coding tools (Cursor, Claude Code, Windsurf, Antigravity)
 * to provide developer intent context for regression review.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as vscode from 'vscode';

export interface PlanFileContext {
  sourcePath: string;          // display path (relative or ~-prefixed)
  toolName: 'cursor' | 'claude-code' | 'windsurf' | 'antigravity';
  content: string;             // plan text (capped at 8,000 chars)
  truncated: boolean;
  modifiedAt: string;          // ISO timestamp
  confidence: 'high' | 'low'; // high if plan mentions changed files
}

const PLAN_MAX_AGE_MS = 86_400_000; // 24 hours
const PLAN_CONTENT_CAP = 8_000;
const JSONL_MAX_READ = 1_024 * 1_024; // 1MB
const JSONL_TAIL_READ = 256 * 1_024;  // 256KB
const JSONL_SLUG_READ = 256 * 1_024;  // 256KB for slug search
const CURSOR_IDE_BONUS = 500;  // When in Cursor IDE, prefer Cursor plans when comparable
const ANTIGRAVITY_IDE_BONUS = 500;  // When in Antigravity IDE, prefer Antigravity plans when comparable
const CLAUDE_BASENAME_MATCH_PENALTY = 200;  // Modest penalty when Claude project matched by basename only
const MAX_CANDIDATES_TO_SCORE = 30;  // Cap to limit I/O while considering all tools

interface PlanCandidate {
  filePath: string;
  toolName: 'cursor' | 'claude-code' | 'windsurf' | 'antigravity';
  mtime: number;
  content?: string; // lazy-loaded
  /** True when this Claude Code candidate was resolved via basename fallback (weaker match). */
  matchedByBasename?: boolean;
}

export interface DiscoverRecentPlanFileOptions {
  workspaceRoots?: string[];
}

export async function discoverRecentPlanFile(
  repoRoot: string,
  burstStartTime: number,
  changedFiles: string[],
  options?: DiscoverRecentPlanFileOptions,
): Promise<PlanFileContext | undefined> {
  const now = Date.now();
  const candidates: PlanCandidate[] = [];
  const workspaceRoots = options?.workspaceRoots;

  // Collect candidates from all sources
  try {
    collectCursorPlans(repoRoot, now, candidates, workspaceRoots);
  } catch { /* ignore fs errors */ }

  try {
    collectWindsurfPlans(repoRoot, now, candidates);
  } catch { /* ignore fs errors */ }

  try {
    collectAntigravityPlans(repoRoot, now, candidates);
  } catch { /* ignore fs errors */ }

  try {
    await collectClaudeCodePlans(repoRoot, now, candidates);
  } catch { /* ignore fs errors */ }

  if (candidates.length === 0) return undefined;

  // Sort by recency, take up to MAX_CANDIDATES_TO_SCORE so all tools can compete
  candidates.sort((a, b) => b.mtime - a.mtime);
  const toScore = candidates.slice(0, MAX_CANDIDATES_TO_SCORE);

  // Load content for candidates we will score
  for (const c of toScore) {
    if (c.content === undefined) {
      try {
        c.content = fs.readFileSync(c.filePath, 'utf-8');
      } catch {
        c.content = '';
      }
    }
  }

  const changedBasenames = changedFiles.map(f => path.basename(f).toLowerCase());
  const appName = typeof vscode !== 'undefined' ? (vscode.env?.appName ?? '') : '';

  let bestCandidate: PlanCandidate | undefined;
  let bestScore = -Infinity;

  for (const c of toScore) {
    if (!c.content) continue;

    const score = scoreCandidate(c, burstStartTime, changedBasenames, appName);
    if (score > bestScore) {
      bestScore = score;
      bestCandidate = c;
    }
  }

  if (!bestCandidate || !bestCandidate.content) return undefined;

  // Determine confidence
  const contentLower = bestCandidate.content.toLowerCase();
  const confidence = changedBasenames.some(bn => contentLower.includes(bn)) ? 'high' : 'low';

  // Truncate content
  let content = bestCandidate.content;
  let truncated = false;
  if (content.length > PLAN_CONTENT_CAP) {
    content = content.slice(0, PLAN_CONTENT_CAP);
    truncated = true;
  }

  // Build display path
  const homeDir = os.homedir();
  let sourcePath = bestCandidate.filePath;
  if (sourcePath.startsWith(homeDir)) {
    sourcePath = '~' + sourcePath.slice(homeDir.length);
  } else {
    const rel = path.relative(repoRoot, sourcePath);
    if (!rel.startsWith('..')) sourcePath = rel;
  }

  return {
    sourcePath,
    toolName: bestCandidate.toolName,
    content,
    truncated,
    modifiedAt: new Date(bestCandidate.mtime).toISOString(),
    confidence,
  };
}

function scoreCandidate(
  candidate: PlanCandidate,
  burstStartTime: number,
  changedBasenames: string[],
  appName: string,
): number {
  let score = -Math.abs(candidate.mtime - burstStartTime);
  const contentLower = (candidate.content ?? '').toLowerCase();
  const mentionsFile = changedBasenames.some(bn => contentLower.includes(bn));
  if (mentionsFile) score += 1000;

  if (appName === 'Cursor' && candidate.toolName === 'cursor') {
    score += CURSOR_IDE_BONUS;
  }

  if (appName.includes('Antigravity') && candidate.toolName === 'antigravity') {
    score += ANTIGRAVITY_IDE_BONUS;
  }

  if (candidate.toolName === 'claude-code' && candidate.matchedByBasename) {
    score -= CLAUDE_BASENAME_MATCH_PENALTY;
  }

  return score;
}

function getCursorPlanDirs(repoRoot: string, workspaceRoots?: string[]): string[] {
  const dirs: string[] = [];
  const seen = new Set<string>();

  const add = (dir: string) => {
    const normalized = path.normalize(dir);
    if (!seen.has(normalized)) {
      seen.add(normalized);
      dirs.push(dir);
    }
  };

  add(path.join(os.homedir(), '.cursor', 'plans'));
  add(path.join(repoRoot, '.cursor', 'plans'));
  if (workspaceRoots) {
    for (const root of workspaceRoots) {
      add(path.join(root, '.cursor', 'plans'));
    }
  }
  return dirs;
}

// --- Cursor ---

function collectCursorPlans(
  repoRoot: string,
  now: number,
  out: PlanCandidate[],
  workspaceRoots?: string[],
): void {
  const planDirs = getCursorPlanDirs(repoRoot, workspaceRoots);
  const seenPaths = new Set<string>();

  for (const plansDir of planDirs) {
    if (!fs.existsSync(plansDir)) continue;

    try {
      const entries = fs.readdirSync(plansDir);
      for (const entry of entries) {
        if (!entry.endsWith('.plan.md')) continue;
        const filePath = path.join(plansDir, entry);
        if (seenPaths.has(filePath)) continue;
        seenPaths.add(filePath);
        try {
          const stat = fs.statSync(filePath);
          if (now - stat.mtimeMs > PLAN_MAX_AGE_MS) continue;
          out.push({ filePath, toolName: 'cursor', mtime: stat.mtimeMs });
        } catch { /* skip unreadable */ }
      }
    } catch { /* skip unreadable dir */ }
  }
}

// --- Windsurf ---

function collectWindsurfPlans(repoRoot: string, now: number, out: PlanCandidate[]): void {
  const workflowsDir = path.join(repoRoot, '.windsurf', 'workflows');
  if (!fs.existsSync(workflowsDir)) return;

  const entries = fs.readdirSync(workflowsDir);
  for (const entry of entries) {
    if (!entry.endsWith('.md')) continue;
    const filePath = path.join(workflowsDir, entry);
    try {
      const stat = fs.statSync(filePath);
      if (now - stat.mtimeMs > PLAN_MAX_AGE_MS) continue;
      out.push({ filePath, toolName: 'windsurf', mtime: stat.mtimeMs });
    } catch { /* skip unreadable */ }
  }
}

// --- Antigravity ---

function collectAntigravityPlans(repoRoot: string, now: number, out: PlanCandidate[]): void {
  const dirs = [
    path.join(repoRoot, '.agent', 'workflows'),
    path.join(os.homedir(), '.gemini', 'antigravity', 'global_workflows'),
  ];

  for (const dir of dirs) {
    if (!fs.existsSync(dir)) continue;
    try {
      const entries = fs.readdirSync(dir);
      for (const entry of entries) {
        if (!entry.endsWith('.md')) continue;
        const filePath = path.join(dir, entry);
        try {
          const stat = fs.statSync(filePath);
          if (now - stat.mtimeMs > PLAN_MAX_AGE_MS) continue;
          out.push({ filePath, toolName: 'antigravity', mtime: stat.mtimeMs });
        } catch { /* skip unreadable */ }
      }
    } catch { /* skip unreadable dir */ }
  }
}

// --- Claude Code CLI ---

async function collectClaudeCodePlans(
  repoRoot: string,
  now: number,
  out: PlanCandidate[],
): Promise<void> {
  const homeDir = os.homedir();
  const projectsDir = path.join(homeDir, '.claude', 'projects');
  if (!fs.existsSync(projectsDir)) return;

  const resolved = resolveClaudeProjectDir(projectsDir, repoRoot);
  if (!resolved) return;

  const { projectDir, matchedByBasename } = resolved;

  // Find most recent JSONL file within 24h
  const jsonlFile = findMostRecentJsonl(projectDir, now);
  if (!jsonlFile) return;

  // Try to extract slug and find plan file
  const slug = extractSlugFromJsonl(jsonlFile.filePath);
  if (slug) {
    const planPath = path.join(homeDir, '.claude', 'plans', `${slug}.md`);
    try {
      const stat = fs.statSync(planPath);
      if (now - stat.mtimeMs <= PLAN_MAX_AGE_MS) {
        out.push({
          filePath: planPath,
          toolName: 'claude-code',
          mtime: stat.mtimeMs,
          matchedByBasename,
        });
        return;
      }
    } catch { /* plan file doesn't exist, fall through to fallback */ }
  }

  // Fallback: extract user messages from JSONL
  const fallbackContent = extractUserMessagesFromJsonl(jsonlFile.filePath);
  if (fallbackContent) {
    out.push({
      filePath: jsonlFile.filePath,
      toolName: 'claude-code',
      mtime: jsonlFile.mtime,
      content: fallbackContent,
      matchedByBasename,
    });
  }
}

function resolveClaudeProjectDir(
  projectsDir: string,
  repoRoot: string,
): { projectDir: string; matchedByBasename: boolean } | undefined {
  // Try exact encoding: /Users/foo/myproject → -Users-foo-myproject
  const encoded = repoRoot.replace(/\//g, '-');
  const exactPath = path.join(projectsDir, encoded);
  if (fs.existsSync(exactPath)) {
    return { projectDir: exactPath, matchedByBasename: false };
  }

  // Fallback: find directories whose name contains the repo basename; prefer best alignment
  const repoBasename = path.basename(repoRoot).toLowerCase();
  const candidates: string[] = [];
  try {
    const entries = fs.readdirSync(projectsDir);
    for (const entry of entries) {
      if (entry.toLowerCase().includes(repoBasename)) {
        const fullPath = path.join(projectsDir, entry);
        try {
          const stat = fs.statSync(fullPath);
          if (stat.isDirectory()) candidates.push(fullPath);
        } catch { /* skip */ }
      }
    }
  } catch { /* ignore */ }

  if (candidates.length === 0) return undefined;
  // Prefer the candidate whose path ends with or best matches the encoded repo (longest overlap)
  const encodedLower = encoded.toLowerCase();
  candidates.sort((a, b) => {
    const aTail = path.basename(a).toLowerCase();
    const bTail = path.basename(b).toLowerCase();
    const aMatch = aTail === encodedLower ? 2 : aTail.endsWith(encodedLower) ? 1 : 0;
    const bMatch = bTail === encodedLower ? 2 : bTail.endsWith(encodedLower) ? 1 : 0;
    return bMatch - aMatch;
  });
  return { projectDir: candidates[0], matchedByBasename: true };
}

function findMostRecentJsonl(
  projectDir: string,
  now: number,
): { filePath: string; mtime: number } | undefined {
  try {
    const entries = fs.readdirSync(projectDir);
    let best: { filePath: string; mtime: number } | undefined;

    for (const entry of entries) {
      if (!entry.endsWith('.jsonl')) continue;
      const filePath = path.join(projectDir, entry);
      try {
        const stat = fs.statSync(filePath);
        if (now - stat.mtimeMs > PLAN_MAX_AGE_MS) continue;
        if (!best || stat.mtimeMs > best.mtime) {
          best = { filePath, mtime: stat.mtimeMs };
        }
      } catch { /* skip */ }
    }

    return best;
  } catch {
    return undefined;
  }
}

function extractSlugFromJsonl(filePath: string): string | undefined {
  try {
    const fd = fs.openSync(filePath, 'r');
    try {
      const buf = Buffer.alloc(JSONL_SLUG_READ);
      const bytesRead = fs.readSync(fd, buf, 0, JSONL_SLUG_READ, 0);
      const text = buf.toString('utf-8', 0, bytesRead);

      // Search for slug patterns
      const patterns = [
        /"slug"\s*:\s*"([^"]+)"/,
        /"plan_slug"\s*:\s*"([^"]+)"/,
        /"planId"\s*:\s*"([^"]+)"/,
        /plans\/([^"]+)\.md/,
      ];

      for (const pattern of patterns) {
        const match = text.match(pattern);
        if (match) return match[1];
      }
    } finally {
      fs.closeSync(fd);
    }
  } catch { /* ignore */ }

  return undefined;
}

function extractUserMessagesFromJsonl(filePath: string): string | undefined {
  try {
    const stat = fs.statSync(filePath);
    let text: string;

    if (stat.size > JSONL_MAX_READ) {
      // Read last 256KB
      const fd = fs.openSync(filePath, 'r');
      try {
        const buf = Buffer.alloc(JSONL_TAIL_READ);
        const offset = stat.size - JSONL_TAIL_READ;
        const bytesRead = fs.readSync(fd, buf, 0, JSONL_TAIL_READ, offset);
        text = buf.toString('utf-8', 0, bytesRead);
        // Drop first partial line
        const firstNewline = text.indexOf('\n');
        if (firstNewline >= 0) {
          text = text.slice(firstNewline + 1);
        }
      } finally {
        fs.closeSync(fd);
      }
    } else {
      text = fs.readFileSync(filePath, 'utf-8');
    }

    const lines = text.split('\n').filter(l => l.trim());
    const userMessages: string[] = [];

    const noisePatterns = [
      /^<command-name>/,
      /^<local-command-caveat>/,
      /^<local-command-stdout>/,
    ];

    for (const line of lines) {
      try {
        const entry = JSON.parse(line);
        if (entry.type !== 'user') continue;
        if (entry.isMeta === true) continue;

        // Extract content text
        let content: string | undefined;
        if (typeof entry.message === 'string') {
          content = entry.message;
        } else if (typeof entry.content === 'string') {
          content = entry.content;
        } else if (Array.isArray(entry.message?.content)) {
          content = entry.message.content
            .filter((b: any) => b.type === 'text')
            .map((b: any) => b.text)
            .join('\n');
        }

        if (!content || content.length < 20) continue;
        if (noisePatterns.some(p => p.test(content!))) continue;

        userMessages.push(content);
      } catch { /* skip malformed lines */ }
    }

    if (userMessages.length === 0) return undefined;

    // Take last 5 messages
    const last5 = userMessages.slice(-5);
    let combined = last5.join('\n\n---\n\n');
    if (combined.length > PLAN_CONTENT_CAP) {
      combined = combined.slice(0, PLAN_CONTENT_CAP);
    }

    return combined;
  } catch {
    return undefined;
  }
}
