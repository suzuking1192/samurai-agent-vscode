/**
 * EditBurstTracker - Detects AI-like edit bursts via workspace.onDidChangeTextDocument
 * and FileSystemWatcher (for CLI tools like Claude Code that write directly to disk).
 * Two-phase detection: threshold crossing → idle timeout / max duration safety valve.
 * Per-repo tracking via git root resolution.
 */

import * as vscode from 'vscode';
import * as path from 'path';
import { simpleGit } from 'simple-git';

// --- Types ---

export interface FileSnapshot {
  startText: string;
  startVersion: number;
  endText?: string;
  endTextSource?: 'editor' | 'disk';
}

export interface BurstSummary {
  repoRoot: string;
  touchedFiles: string[];
  touchedFilesDuringBurst: string[];
  totalCharsChanged: number;
  largestSingleEdit: number;
  durationMs: number;
  triggeredAt: number;
  editCount: number;
  fileSnapshots: Map<string, { startText: string; endText?: string }>;
}

interface RollingEdit {
  filePath: string;
  chars: number;
  timestamp: number;
  isPaste: boolean;
  source: 'editor' | 'fs';
}

interface BurstState {
  // Rolling window (phase 1)
  rollingEdits: RollingEdit[];
  // Pre-edit content per file (first time seen in window) for snapshot baseline
  preEditStore: Map<string, string>;
  // Pending snapshot promises (await before emitting burst)
  pendingSnapshotPromises: Promise<void>[];
  // Accumulation state (phase 2)
  accumulating: boolean;
  accumulationStart: number;
  idleTimer: NodeJS.Timeout | undefined;
  maxDurationTimer: NodeJS.Timeout | undefined;
  touchedFiles: Set<string>;
  totalCharsChanged: number;
  largestSingleEdit: number;
  editCount: number;
  fileSnapshots: Map<string, FileSnapshot>;
  // Cooldown
  lastBurstEmit: number;
  // Staleness tracking
  lastEditTime: number;
}

interface RepoCacheEntry {
  repoRoot: string;
  resolvedAt: number;
}

// --- Constants ---

const RELEVANT_EXTENSIONS = new Set(['.ts', '.tsx', '.js', '.jsx', '.json', '.yaml', '.yml']);
const IGNORED_PATH_SEGMENTS = [
  'node_modules/', 'dist/', 'out/', '.next/', 'build/', 'coverage/', '.git/',
  '.tsbuildinfo', '.cache/', '.vite/', '.turbo/', '.eslintcache'
];
const FS_WATCH_GLOB = '**/*.{ts,tsx,js,jsx,json,yaml,yml}';

const ROLLING_WINDOW_MS = 5000;
const CHAR_THRESHOLD = 400;
const CHAR_WINDOW_MS = 1500;
const FILE_THRESHOLD = 3;
const PASTE_THRESHOLD = 200;

const DEFAULT_IDLE_MS = 45000;              // 45s — accommodates AI thinking pauses
const DEFAULT_MAX_BURST_DURATION_MS = 300000; // 5min — accommodates multi-file refactorings
const DEFAULT_COOLDOWN_MS = 60000;
const REPO_CACHE_TTL_MS = 60000;
const STALE_STATE_CLEANUP_MS = 300000; // 5 minutes

const MAX_FILE_SNAPSHOT_SIZE = 500 * 1024; // 500KB
const MAX_FILES_PER_BURST = 20;

// FS watcher constants
const FS_DEBOUNCE_MS = 500;
const EDITOR_DEDUPE_WINDOW_MS = 1000;
const DELETE_CREATE_WINDOW_MS = 500;

// Bulk operation suppression
const BULK_FILE_THRESHOLD = 10;
const BULK_TIME_WINDOW_MS = 2000;

const SNAPSHOT_AWAIT_TIMEOUT_MS = 5000;

export class EditBurstTracker {
  private _enabled = false;
  private _disposable: vscode.Disposable | undefined;
  private _saveDisposable: vscode.Disposable | undefined;

  private _burstStates: Map<string, BurstState> = new Map();
  private _repoCache: Map<string, RepoCacheEntry> = new Map();
  private _cleanupInterval: NodeJS.Timeout | undefined;

  // FS watcher state
  private _fsWatchers: vscode.FileSystemWatcher[] = [];
  private _fileContentCache: Map<string, string> = new Map();
  private _recentEditorActivity: Map<string, number> = new Map();
  private _pendingFsChanges: Map<string, NodeJS.Timeout> = new Map();
  private _pendingDeletes: Map<string, number> = new Map();
  private _openDocDisposable: vscode.Disposable | undefined;

  // Configuration
  public idleMs = DEFAULT_IDLE_MS;
  public maxBurstDurationMs = DEFAULT_MAX_BURST_DURATION_MS;
  public cooldownMs = DEFAULT_COOLDOWN_MS;

  // Event emitter
  private _onAIBurstDetected = new vscode.EventEmitter<BurstSummary>();
  public readonly onAIBurstDetected: vscode.Event<BurstSummary> = this._onAIBurstDetected.event;

  enable(): void {
    if (this._enabled) return;
    this._enabled = true;
    console.log('[EditBurstTracker] Service enabled and listening for document changes');

    this._disposable = vscode.workspace.onDidChangeTextDocument(e => this._onDocumentChange(e));
    this._cleanupInterval = setInterval(() => this._cleanupStaleStates(), STALE_STATE_CLEANUP_MS);

    // Track saves for FS watcher dedupe
    this._saveDisposable = vscode.workspace.onDidSaveTextDocument(doc => {
      if (doc.uri.scheme === 'file') {
        this._recentEditorActivity.set(doc.uri.fsPath, Date.now());
      }
    });

    // Seed _fileContentCache with already-open documents so first edits have a baseline
    for (const doc of vscode.workspace.textDocuments) {
      if (doc.uri.scheme === 'file') {
        const ext = path.extname(doc.uri.fsPath).toLowerCase();
        if (RELEVANT_EXTENSIONS.has(ext) && !this._isIgnoredPath(doc.uri.fsPath)) {
          this._fileContentCache.set(doc.uri.fsPath, doc.getText());
        }
      }
    }

    // Track newly opened documents to seed cache before first edit
    this._openDocDisposable = vscode.workspace.onDidOpenTextDocument(doc => {
      if (doc.uri.scheme === 'file') {
        const ext = path.extname(doc.uri.fsPath).toLowerCase();
        if (RELEVANT_EXTENSIONS.has(ext) && !this._isIgnoredPath(doc.uri.fsPath)) {
          if (!this._fileContentCache.has(doc.uri.fsPath)) {
            this._fileContentCache.set(doc.uri.fsPath, doc.getText());
          }
        }
      }
    });

    // Create FS watchers per workspace folder (required for multi-root + remote compatibility)
    for (const folder of vscode.workspace.workspaceFolders ?? []) {
      const pattern = new vscode.RelativePattern(folder, FS_WATCH_GLOB);
      const watcher = vscode.workspace.createFileSystemWatcher(pattern);
      watcher.onDidChange(uri => this._onFsEvent(uri, 'change'));
      watcher.onDidCreate(uri => this._onFsEvent(uri, 'create'));
      watcher.onDidDelete(uri => this._onFsEvent(uri, 'delete'));
      this._fsWatchers.push(watcher);
    }
    console.log(`[EditBurstTracker] Created ${this._fsWatchers.length} FS watcher(s)`);

    // Pre-warm _repoCache for every workspace folder so _optimisticTimerReset has cache
    // from the first edit (avoids burst-race where timer is not reset on subsequent edits)
    this._prewarmRepoCache();
  }

  disable(): void {
    if (!this._enabled) return;
    this._enabled = false;

    this._disposable?.dispose();
    this._disposable = undefined;

    this._saveDisposable?.dispose();
    this._saveDisposable = undefined;

    this._openDocDisposable?.dispose();
    this._openDocDisposable = undefined;

    if (this._cleanupInterval) {
      clearInterval(this._cleanupInterval);
      this._cleanupInterval = undefined;
    }

    // Clear all timers
    for (const state of this._burstStates.values()) {
      if (state.idleTimer) clearTimeout(state.idleTimer);
      if (state.maxDurationTimer) clearTimeout(state.maxDurationTimer);
    }
    this._burstStates.clear();

    // Clean up FS watchers
    for (const watcher of this._fsWatchers) watcher.dispose();
    this._fsWatchers = [];
    this._fileContentCache.clear();
    this._recentEditorActivity.clear();
    for (const timeout of this._pendingFsChanges.values()) clearTimeout(timeout);
    this._pendingFsChanges.clear();
    this._pendingDeletes.clear();
  }

  dispose(): void {
    this.disable();
    this._onAIBurstDetected.dispose();
  }

  // --- Private methods ---

  private async _onDocumentChange(event: vscode.TextDocumentChangeEvent): Promise<void> {
    const doc = event.document;
    console.log(`[EditBurstTracker] onDidChangeTextDocument: ${doc.uri.fsPath} (${event.contentChanges.length} changes)`);

    if (doc.uri.scheme !== 'file') return;

    const filePath = doc.uri.fsPath;
    const ext = path.extname(filePath).toLowerCase();
    if (!RELEVANT_EXTENSIONS.has(ext)) return;
    if (this._isIgnoredPath(filePath)) return;
    if (event.contentChanges.length === 0) return;

    // Optimistically reset idle timer before async repo resolution
    this._optimisticTimerReset(filePath);

    // Record activity for FS watcher dedupe
    this._recentEditorActivity.set(filePath, Date.now());

    // Resolve repo root
    const repoRoot = await this._resolveRepoRoot(filePath);
    if (!repoRoot) return;

    // Calculate edit metrics
    let totalChars = 0;
    let largestEdit = 0;
    let isPaste = false;
    for (const change of event.contentChanges) {
      const chars = change.text.length + change.rangeLength;
      totalChars += chars;
      if (change.text.length > largestEdit) largestEdit = change.text.length;
      if (change.text.length >= PASTE_THRESHOLD) isPaste = true;
    }

    // Capture pre-edit before overwriting (for editor-triggered burst snapshots)
    const preEditContent = this._fileContentCache.get(filePath);

    // Sync cache with editor state for FS watcher accuracy (Fix #3: Editor/FS cache de-sync)
    this._fileContentCache.set(filePath, doc.getText());

    // Feed into unified burst detection
    this._ingestEdit(filePath, repoRoot, totalChars, isPaste, 'editor', preEditContent);
  }

  // --- FS Watcher Handlers ---

  private _onFsEvent(uri: vscode.Uri, type: 'change' | 'create' | 'delete'): void {
    const filePath = uri.fsPath;

    // Skip ignored paths (includes .git, node_modules, dist, hidden folders, etc.)
    if (this._isIgnoredPath(filePath)) return;

    // Skip if recent editor activity (dedupe with onDidChangeTextDocument)
    const lastEditorActivity = this._recentEditorActivity.get(filePath) ?? 0;
    if (Date.now() - lastEditorActivity < EDITOR_DEDUPE_WINDOW_MS) return;

    // Handle delete: record timestamp for atomic rename detection
    if (type === 'delete') {
      this._pendingDeletes.set(filePath, Date.now());
      return;
    }

    // Handle create: check if it's part of atomic rename (recent delete of same file)
    if (type === 'create') {
      const deleteTime = this._pendingDeletes.get(filePath);
      if (deleteTime && Date.now() - deleteTime < DELETE_CREATE_WINDOW_MS) {
        this._pendingDeletes.delete(filePath);
        // Treat as 'change' - atomic rename pattern (fall through)
      }
    }

    // Optimistically reset idle timer before debounce delay
    this._optimisticTimerReset(filePath);

    // Debounce: cancel previous pending change for this file
    const existing = this._pendingFsChanges.get(filePath);
    if (existing) clearTimeout(existing);

    const timeout = setTimeout(() => {
      this._pendingFsChanges.delete(filePath);
      this._processFsChange(filePath).catch(err => {
        console.error('[EditBurstTracker] FS change error:', err);
      });
    }, FS_DEBOUNCE_MS);

    this._pendingFsChanges.set(filePath, timeout);
  }

  /**
   * Check if a file path should be ignored (build artifacts, dependencies, hidden config folders).
   * Hidden folders (starting with .) like .vscode/, .github/, .husky/ are ignored as they contain
   * configuration files, not main code.
   */
  private _isIgnoredPath(filePath: string): boolean {
    // Check hardcoded ignored segments (node_modules, dist, etc.)
    if (IGNORED_PATH_SEGMENTS.some(seg => filePath.includes(seg))) {
      return true;
    }

    // Check for hidden folders (any path segment starting with '.')
    // This covers .vscode/, .github/, .husky/, .idea/, etc.
    const segments = filePath.split(/[\\/]/);
    return segments.some(seg => seg.startsWith('.') && seg !== '.' && seg !== '..');
  }

  private async _processFsChange(filePath: string): Promise<void> {
    console.log(`[EditBurstTracker] FS watcher: ${filePath}`);

    const repoRoot = await this._resolveRepoRoot(filePath);
    if (!repoRoot) return;

    // Read current content
    let currentContent: string;
    try {
      const bytes = await vscode.workspace.fs.readFile(vscode.Uri.file(filePath));
      currentContent = new TextDecoder().decode(bytes);
    } catch {
      return; // File deleted or unreadable
    }

    // Capture pre-change content for snapshot BEFORE updating cache (Fix #1: Snapshot race)
    const preChangeContent = this._fileContentCache.get(filePath);

    // Simple delta calculation (Fix #2: False positives on first read)
    let chars: number;
    if (preChangeContent !== undefined) {
      chars = Math.abs(currentContent.length - preChangeContent.length);
    } else {
      // First time seeing this file - don't treat entire content as a change
      // Rely on FILE_THRESHOLD (3+ files) to detect CLI bursts
      chars = 0;
    }

    // Update cache for next delta
    this._fileContentCache.set(filePath, currentContent);

    const isPaste = chars >= PASTE_THRESHOLD;

    // Feed into unified burst detection, passing pre-change content for snapshot
    this._ingestEdit(filePath, repoRoot, chars, isPaste, 'fs', preChangeContent);
  }

  // --- Unified Burst Input Method ---

  private _ingestEdit(
    filePath: string,
    repoRoot: string,
    chars: number,
    isPaste: boolean,
    source: 'editor' | 'fs',
    preChangeContent?: string  // For FS: content before change. For editor: content before this edit.
  ): void {
    const now = Date.now();
    let state = this._burstStates.get(repoRoot);
    if (!state) {
      state = this._createBurstState();
      this._burstStates.set(repoRoot, state);
    }
    state.lastEditTime = now;

    if (state.accumulating) {
      // Phase 2: accumulate
      state.totalCharsChanged += chars;
      state.editCount++;
      if (chars > state.largestSingleEdit) state.largestSingleEdit = chars;
      state.touchedFiles.add(filePath);
      const snapPromise = this._snapshotFile(state, filePath, preChangeContent);
      state.pendingSnapshotPromises.push(snapPromise);
      this._resetIdleTimer(state, repoRoot);
    } else {
      // Phase 1: rolling window — store pre-edit content (first time per file in window)
      if (preChangeContent !== undefined && !state.preEditStore.has(filePath)) {
        state.preEditStore.set(filePath, preChangeContent);
      }
      state.rollingEdits.push({ filePath, chars, timestamp: now, isPaste, source });
      // Prune old entries
      state.rollingEdits = state.rollingEdits.filter(e => now - e.timestamp < ROLLING_WINDOW_MS);

      if (this._checkThreshold(state, now)) {
        // Check cooldown
        if (now - state.lastBurstEmit < this.cooldownMs) return;

        // Transition to accumulating
        state.accumulating = true;
        state.accumulationStart = now;

        // Snapshot all files currently in rolling buffer
        const filesInBuffer = new Set(state.rollingEdits.map(e => e.filePath));
        for (const fp of filesInBuffer) {
          const snapshotContent = state.preEditStore.get(fp);
          const snapPromise = this._snapshotFile(state, fp, snapshotContent);
          state.pendingSnapshotPromises.push(snapPromise);
        }

        // Include current edit metrics
        state.totalCharsChanged = state.rollingEdits.reduce((s, e) => s + e.chars, 0);
        state.largestSingleEdit = Math.max(...state.rollingEdits.map(e => e.chars), 0);
        state.editCount = state.rollingEdits.length;
        for (const fp of filesInBuffer) state.touchedFiles.add(fp);

        console.log(`[EditBurstTracker] Burst detected for ${repoRoot} (source: ${source}), accumulating...`);

        // Start idle + max duration timers
        this._resetIdleTimer(state, repoRoot);
        state.maxDurationTimer = setTimeout(
          () => void this._emitBurst(repoRoot),
          this.maxBurstDurationMs
        );
      }
    }
  }

  private async _snapshotFile(
    state: BurstState,
    filePath: string,
    preChangeContent?: string  // For FS events, use this instead of reading from disk (Fix #1)
  ): Promise<void> {
    if (state.fileSnapshots.size >= MAX_FILES_PER_BURST) return;
    if (state.fileSnapshots.has(filePath)) return;

    // For FS events, use the pre-change content directly if available
    // This fixes the snapshot race where disk reads return the already-modified content
    if (preChangeContent !== undefined) {
      if (preChangeContent.length <= MAX_FILE_SNAPSHOT_SIZE) {
        state.fileSnapshots.set(filePath, { startText: preChangeContent, startVersion: 0 });
      }
      return;
    }

    // Try open document first (sync, already in memory) - for editor events
    const doc = vscode.workspace.textDocuments.find(d => d.uri.fsPath === filePath);
    if (doc) {
      const text = doc.getText();
      if (text.length <= MAX_FILE_SNAPSHOT_SIZE) {
        state.fileSnapshots.set(filePath, { startText: text, startVersion: doc.version });
      }
      return;
    }

    // Read from disk async (safe for remote FS, won't freeze extension host)
    // Only reached for files not open in editor and no preChangeContent provided
    try {
      const bytes = await vscode.workspace.fs.readFile(vscode.Uri.file(filePath));
      const text = new TextDecoder().decode(bytes);
      if (text.length <= MAX_FILE_SNAPSHOT_SIZE) {
        state.fileSnapshots.set(filePath, { startText: text, startVersion: 0 });
      }
    } catch {
      // File unreadable or deleted
    }
  }

  /**
   * Synchronously reset the idle timer using cached repo root.
   * Called BEFORE async operations or debounce to prevent
   * premature burst emission during processing delays.
   */
  private _optimisticTimerReset(filePath: string): void {
    const wsFolder = vscode.workspace.getWorkspaceFolder(vscode.Uri.file(filePath));
    if (!wsFolder) return;
    const cached = this._repoCache.get(wsFolder.uri.fsPath);
    if (!cached) return;
    const state = this._burstStates.get(cached.repoRoot);
    if (state?.accumulating) {
      state.lastEditTime = Date.now();
      this._resetIdleTimer(state, cached.repoRoot);
    }
  }

  private _resetIdleTimer(state: BurstState, repoRoot: string): void {
    if (state.idleTimer) clearTimeout(state.idleTimer);
    state.idleTimer = setTimeout(() => void this._emitBurst(repoRoot), this.idleMs);
  }

  private _checkThreshold(state: BurstState, now: number): boolean {
    const edits = state.rollingEdits;

    // Single paste >= 200 chars
    if (edits.some(e => e.isPaste)) return true;

    // >= 400 chars in 1500ms
    const recentChars = edits
      .filter(e => now - e.timestamp < CHAR_WINDOW_MS)
      .reduce((s, e) => s + e.chars, 0);
    if (recentChars >= CHAR_THRESHOLD) return true;

    // 3+ files in 5s
    const recentFiles = new Set(edits.map(e => e.filePath));
    if (recentFiles.size >= FILE_THRESHOLD) return true;

    return false;
  }

  private async _emitBurst(repoRoot: string): Promise<void> {
    const state = this._burstStates.get(repoRoot);
    if (!state || !state.accumulating) return;

    // Clear timers
    if (state.idleTimer) { clearTimeout(state.idleTimer); state.idleTimer = undefined; }
    if (state.maxDurationTimer) { clearTimeout(state.maxDurationTimer); state.maxDurationTimer = undefined; }

    // Await pending snapshots with timeout before building summary
    const pending = state.pendingSnapshotPromises.length > 0
      ? Promise.all(state.pendingSnapshotPromises)
      : Promise.resolve();
    const timeout = new Promise<void>((_, reject) =>
      setTimeout(() => reject(new Error('snapshot timeout')), SNAPSHOT_AWAIT_TIMEOUT_MS)
    );
    try {
      await Promise.race([pending, timeout]);
    } catch {
      // Proceed with whatever snapshots completed
    }

    const now = Date.now();
    const durationMs = now - state.accumulationStart;

    // Bulk operation suppression: many files in short time (e.g., git checkout, npm install)
    if (state.touchedFiles.size >= BULK_FILE_THRESHOLD && durationMs < BULK_TIME_WINDOW_MS) {
      console.log('[EditBurstTracker] Burst suppressed (bulk operation detected)');
      this._resetBurstState(state);
      return;
    }

    // Formatter heuristic: if avgCharsPerEdit < 5, raise thresholds
    const avgCharsPerEdit = state.editCount > 0 ? state.totalCharsChanged / state.editCount : 0;
    if (avgCharsPerEdit < 5) {
      if (state.totalCharsChanged < 800 && state.touchedFiles.size < 5) {
        console.log('[EditBurstTracker] Burst suppressed (formatter heuristic)');
        this._resetBurstState(state);
        return;
      }
    }

    // Capture endText for all snapshotted files (freeze current state before any further edits)
    for (const [fp, snap] of state.fileSnapshots) {
      const doc = vscode.workspace.textDocuments.find(d => d.uri.fsPath === fp);
      if (doc) {
        snap.endText = doc.getText();
      } else {
        // Fallback: read from FS cache (most recent content we've seen)
        const cached = this._fileContentCache.get(fp);
        if (cached !== undefined) {
          snap.endText = cached;
        }
        // If neither available, endText stays undefined — resolved lazily downstream
      }
    }

    // Build snapshot map for summary
    const snapshotMap = new Map<string, { startText: string; endText?: string }>();
    for (const [fp, snap] of state.fileSnapshots) {
      snapshotMap.set(fp, { startText: snap.startText, endText: snap.endText });
    }

    const summary: BurstSummary = {
      repoRoot,
      touchedFiles: Array.from(state.touchedFiles),
      touchedFilesDuringBurst: Array.from(state.touchedFiles),
      totalCharsChanged: state.totalCharsChanged,
      largestSingleEdit: state.largestSingleEdit,
      durationMs: now - state.accumulationStart,
      triggeredAt: state.accumulationStart,
      editCount: state.editCount,
      fileSnapshots: snapshotMap,
    };

    console.log(`[EditBurstTracker] Burst emitted: ${summary.editCount} edits, ${summary.touchedFiles.length} files, ${summary.totalCharsChanged} chars`);

    state.lastBurstEmit = now;
    this._resetBurstState(state);

    this._onAIBurstDetected.fire(summary);
  }

  private _resetBurstState(state: BurstState): void {
    state.accumulating = false;
    state.accumulationStart = 0;
    state.touchedFiles.clear();
    state.totalCharsChanged = 0;
    state.largestSingleEdit = 0;
    state.editCount = 0;
    state.fileSnapshots.clear();
    state.rollingEdits = [];
    state.preEditStore.clear();
    state.pendingSnapshotPromises = [];
  }

  private _createBurstState(): BurstState {
    return {
      rollingEdits: [],
      preEditStore: new Map(),
      pendingSnapshotPromises: [],
      accumulating: false,
      accumulationStart: 0,
      idleTimer: undefined,
      maxDurationTimer: undefined,
      touchedFiles: new Set(),
      totalCharsChanged: 0,
      largestSingleEdit: 0,
      editCount: 0,
      fileSnapshots: new Map(),
      lastBurstEmit: 0,
      lastEditTime: Date.now(),
    };
  }

  /**
   * Pre-warm _repoCache for all workspace folders so _optimisticTimerReset has cache
   * from the first edit (fixes single-root burst race and multi-root last-edit not resetting).
   */
  private _prewarmRepoCache(): void {
    const folders = vscode.workspace.workspaceFolders ?? [];
    if (folders.length === 0) return;
    Promise.all(
      folders.map(folder => this._resolveRepoRoot(folder.uri.fsPath))
    ).catch(err => console.warn('[EditBurstTracker] Pre-warm repo cache failed:', err));
  }

  private async _resolveRepoRoot(filePath: string): Promise<string | undefined> {
    const wsFolder = vscode.workspace.getWorkspaceFolder(vscode.Uri.file(filePath));
    if (!wsFolder) return undefined;
    const wsFolderPath = wsFolder.uri.fsPath;

    const cached = this._repoCache.get(wsFolderPath);
    if (cached && Date.now() - cached.resolvedAt < REPO_CACHE_TTL_MS) {
      return cached.repoRoot;
    }

    try {
      const git = simpleGit(wsFolderPath);
      const topLevel = await git.revparse(['--show-toplevel']);
      const repoRoot = topLevel.trim();
      this._repoCache.set(wsFolderPath, { repoRoot, resolvedAt: Date.now() });
      return repoRoot;
    } catch {
      // Fallback: Use workspace folder path for non-git repositories
      this._repoCache.set(wsFolderPath, { repoRoot: wsFolderPath, resolvedAt: Date.now() });
      return wsFolderPath;
    }
  }

  private _cleanupStaleStates(): void {
    const now = Date.now();
    for (const [root, state] of this._burstStates) {
      if (now - state.lastEditTime > STALE_STATE_CLEANUP_MS && !state.accumulating) {
        this._burstStates.delete(root);
      }
    }
  }
}
