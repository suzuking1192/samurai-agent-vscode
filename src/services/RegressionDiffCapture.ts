/**
 * RegressionDiffCapture - Two diff sources: snapshot diff (primary) and git diff (supplementary).
 */

import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { createTwoFilesPatch } from 'diff';
import { simpleGit } from 'simple-git';
import { PlanFileContext } from './AIToolPlanDiscovery';

export interface DiffCaptureResult {
  snapshotDiff: string;
  gitDiff?: string;
  changedFilesDuringBurst: string[];
  needsGitFallback: boolean;
  truncated: boolean;
  statusOutput?: string;
  capturedAt?: number;  // Unix timestamp when diff was captured
  planContext?: PlanFileContext;
}

const SNAPSHOT_DIFF_CAP = 15000;
const GIT_DIFF_CAP = 5000;

/**
 * Build unified diff from file snapshots (exact burst changes).
 */
export function buildSnapshotDiff(
  fileSnapshots: Map<string, { startText: string; endText?: string }>,
  repoRoot: string
): string {
  const diffs: string[] = [];
  let totalLen = 0;
  let truncated = false;

  for (const [filePath, snap] of fileSnapshots) {
    if (totalLen >= SNAPSHOT_DIFF_CAP) {
      truncated = true;
      break;
    }

    const relPath = path.relative(repoRoot, filePath);
    const endText = snap.endText ?? resolveEndText(filePath);
    if (endText === undefined) continue;

    if (snap.startText === endText) continue; // No change

    const patch = createTwoFilesPatch(relPath, relPath, snap.startText, endText, '', '', { context: 3 });
    const remaining = SNAPSHOT_DIFF_CAP - totalLen;
    if (patch.length > remaining) {
      diffs.push(patch.slice(0, remaining));
      truncated = true;
      break;
    }
    diffs.push(patch);
    totalLen += patch.length;
  }

  return diffs.join('\n');
}

function pathEquals(a: string, b: string): boolean {
  const normA = path.normalize(a);
  const normB = path.normalize(b);
  if (process.platform === 'win32') {
    return normA.toLowerCase() === normB.toLowerCase();
  }
  return normA === normB;
}

function resolveEndText(filePath: string): string | undefined {
  const normalizedPath = path.normalize(filePath);

  // Try open editor first (path normalization + case-insensitive on Windows)
  const doc = vscode.workspace.textDocuments.find(d => pathEquals(d.uri.fsPath, normalizedPath));
  if (doc) return doc.getText();

  // Fallback to disk
  try {
    return fs.readFileSync(normalizedPath, 'utf-8');
  } catch {
    console.warn('[RegressionDiffCapture] resolveEndText failed for:', normalizedPath);
    return undefined;
  }
}

/**
 * Capture git diff for specified files (fallback, supplementary).
 */
export async function captureGitDiff(
  repoRoot: string,
  filePaths: string[]
): Promise<{ gitDiff: string; changedFiles: string[]; truncated: boolean; statusOutput?: string }> {
  const git = simpleGit({ baseDir: repoRoot, maxConcurrentProcesses: 1 });

  // Normalize to repo-relative paths, skip paths that escape repo
  const relPaths = filePaths
    .map(fp => path.relative(repoRoot, fp))
    .filter(rp => !rp.startsWith('..'));

  let diffText = '';
  let statusOutput: string | undefined;
  const changedFiles: string[] = [...relPaths];

  try {
    // Scoped diff
    if (relPaths.length > 0) {
      diffText = await git.diff(['--no-renames', '--no-color', '--', ...relPaths]);
    }

    // Fallback chain if scoped diff is empty
    if (!diffText.trim()) {
      diffText = await git.diff(['--cached', '--no-renames', '--no-color']);
    }

    if (!diffText.trim()) {
      statusOutput = await git.raw(['status', '--porcelain']);
    }
  } catch (error) {
    console.error('[RegressionDiffCapture] Git diff failed:', error);
  }

  let truncated = false;
  if (diffText.length > GIT_DIFF_CAP) {
    diffText = diffText.slice(0, GIT_DIFF_CAP);
    truncated = true;
  }

  return { gitDiff: diffText, changedFiles, truncated, statusOutput };
}

/**
 * Determine if git fallback is needed based on snapshot completeness.
 */
export function computeNeedsGitFallback(
  snapshotDiff: string,
  totalCharsChanged: number,
  fileSnapshots: Map<string, { startText: string; endText?: string }>,
  touchedFiles: string[],
  maxFilesPerBurst: number = 20,
  maxFileSize: number = 500 * 1024
): boolean {
  // Snapshot too small relative to reported changes
  if (snapshotDiff.length < 100 && totalCharsChanged > 200) return true;

  // Some files weren't snapshotted
  if (touchedFiles.length > fileSnapshots.size) return true;

  // Exceeded file caps (can't tell exactly, but if close to max)
  if (fileSnapshots.size >= maxFilesPerBurst) return true;

  return false;
}
