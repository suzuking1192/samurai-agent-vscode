/**
 * RegressionNotificationService - Orchestrates burst detection → scoring → notification → agent review.
 */

import * as vscode from 'vscode';
import * as path from 'path';
import { EditBurstTracker, BurstSummary } from './EditBurstTracker';
import { scoreRegressionRisk, RiskResult } from './RegressionRiskScorer';
import { buildSnapshotDiff, captureGitDiff, computeNeedsGitFallback, DiffCaptureResult } from './RegressionDiffCapture';
import { discoverRecentPlanFile } from './AIToolPlanDiscovery';
import { GlobalDataStore } from '../persistence/globalDataStore';

export function getRiskLevel(score: number): string {
  if (score >= 75) return 'High Risk';
  if (score >= 50) return 'Elevated Risk';
  if (score >= 20) return 'Potential Risk Detected';
  return 'Review Recommended';
}

export class RegressionNotificationService {
  private _disposable: vscode.Disposable | undefined;

  constructor(
    private readonly editBurstTracker: EditBurstTracker,
    private readonly globalDataStore: GlobalDataStore,
    private readonly riskThreshold: number = 0,
  ) {}

  start(): void {
    this._disposable = this.editBurstTracker.onAIBurstDetected(burst => {
      this._handleBurst(burst).catch(err => {
        console.error('[RegressionNotificationService] Error handling burst:', err);
      });
    });
  }

  dispose(): void {
    this._disposable?.dispose();
  }

  private async _handleBurst(burst: BurstSummary): Promise<void> {
    // Check if feature is enabled (VS Code setting takes precedence, fallback to GlobalDataStore)
    const vscodeConfig = vscode.workspace.getConfiguration('samurai-agent.regressionDetection');
    const vscodeEnabled = vscodeConfig.get<boolean>('enabled', false);
    const globalSettings = this.globalDataStore.loadGlobalSettings().payload;
    const globalEnabled = globalSettings?.enableRegressionDetection ?? false;

    const isEnabled = vscodeEnabled || globalEnabled;

    if (!isEnabled) {
      console.log('[RegressionNotificationService] Feature disabled (VS Code: ' + vscodeEnabled + ', GlobalDataStore: ' + globalEnabled + ')');
      return;
    }

    // Build snapshot diff (primary, exact)
    const snapshotDiff = buildSnapshotDiff(burst.fileSnapshots, burst.repoRoot);

    // Compute if we need git fallback
    const needsGitFallback = computeNeedsGitFallback(
      snapshotDiff,
      burst.totalCharsChanged,
      burst.fileSnapshots,
      burst.touchedFiles
    );

    // Capture git diff if needed or when snapshot is empty (so Review always has something to show)
    const snapshotEmpty = snapshotDiff.trim().length === 0;
    let gitDiff: string | undefined;
    let statusOutput: string | undefined;
    if (needsGitFallback || snapshotEmpty) {
      const result = await captureGitDiff(burst.repoRoot, burst.touchedFiles);
      gitDiff = result.gitDiff;
      statusOutput = result.statusOutput;
    }

    // Compute changed files (relative paths)
    const changedFiles = burst.touchedFiles.map(f => path.relative(burst.repoRoot, f));

    // Resolve workspace roots that contain burst edits (for Cursor plan path fallback)
    const workspaceRootsSet = new Set<string>();
    for (const touched of burst.touchedFiles) {
      const folder = vscode.workspace.getWorkspaceFolder(vscode.Uri.file(touched));
      if (folder?.uri.fsPath) workspaceRootsSet.add(folder.uri.fsPath);
    }
    const workspaceRoots = workspaceRootsSet.size > 0 ? Array.from(workspaceRootsSet) : undefined;

    // Discover AI tool plan context
    let planContext;
    try {
      planContext = await discoverRecentPlanFile(burst.repoRoot, burst.triggeredAt, changedFiles, { workspaceRoots });
    } catch (err) {
      console.error('[RegressionNotificationService] Plan discovery failed:', err);
    }

    // Score risk using snapshot diff
    const riskResult = scoreRegressionRisk(snapshotDiff, changedFiles);

    // Get threshold from VS Code settings
    // Support both legacy number and new string threshold values for migration
    const config = vscode.workspace.getConfiguration('samurai-agent.regressionDetection');
    const rawSetting = config.get<string | number>('riskThreshold', 'always');

    let threshold: number;
    if (typeof rawSetting === 'number') {
      // Legacy numeric value - use directly
      threshold = rawSetting;
    } else {
      // New string enum value - map to number
      const thresholdMap: Record<string, number> = {
        'always': 0,
        'moderate': 30,
        'high': 70,
      };
      threshold = thresholdMap[rawSetting] ?? this.riskThreshold;
    }

    // Log risk score and reasons
    console.log(`[RegressionNotificationService] Risk score: ${riskResult.totalRiskScore}/100 (threshold: ${threshold})`);
    for (const reason of riskResult.reasons) {
      console.log(`[RegressionNotificationService]  - [${reason.category}] ${reason.pattern} (+${reason.points})`);
    }

    if (riskResult.totalRiskScore < threshold) {
      console.log(`[RegressionNotificationService] Score below threshold, skipping notification`);
      return;
    }

    console.log('[RegressionNotificationService] Showing regression risk notification');

    const riskLevel = getRiskLevel(riskResult.totalRiskScore);

    // Show notification
    const action = await vscode.window.showWarningMessage(
      `Samurai Agent: AI code changes detected — ${riskLevel}`,
      'Review Regression Risk',
      'Ignore'
    );

    if (action === 'Review Regression Risk') {
      const diffCaptureResult: DiffCaptureResult = {
        snapshotDiff,
        gitDiff,
        changedFilesDuringBurst: changedFiles,
        needsGitFallback,
        truncated: snapshotDiff.length >= 15000,
        statusOutput,
        capturedAt: Date.now(),
        planContext,
      };

      await vscode.commands.executeCommand(
        'samurai-agent.startRegressionReview',
        diffCaptureResult,
        riskResult
      );
    }
  }
}
