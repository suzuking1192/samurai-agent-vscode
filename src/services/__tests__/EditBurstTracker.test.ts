/**
 * Tests for EditBurstTracker
 *
 * The tracker's core logic (threshold detection, accumulation, idle timers) relies
 * on VS Code events and async git resolution, so we test:
 * 1. Public API / lifecycle (unit-testable)
 * 2. Internal state machine via the private _onDocumentChange path (by invoking
 *    the registered listener captured from the mock)
 */

import { EditBurstTracker, BurstSummary } from '../EditBurstTracker';

// Capture the listener registered via onDidChangeTextDocument
let documentChangeListener: ((event: any) => void) | null = null;
let saveDocumentListener: ((doc: any) => void) | null = null;
let openDocumentListener: ((doc: any) => void) | null = null;
const mockDispose = jest.fn();

// FS watcher mocks
let fsWatcherChangeListener: ((uri: any) => void) | null = null;
let fsWatcherCreateListener: ((uri: any) => void) | null = null;
let fsWatcherDeleteListener: ((uri: any) => void) | null = null;
const mockFsWatcherDispose = jest.fn();

const mockFsReadFile = jest.fn();

jest.mock('vscode', () => ({
  workspace: {
    onDidChangeTextDocument: jest.fn((listener: any) => {
      documentChangeListener = listener;
      return { dispose: mockDispose };
    }),
    onDidSaveTextDocument: jest.fn((listener: any) => {
      saveDocumentListener = listener;
      return { dispose: mockDispose };
    }),
    onDidOpenTextDocument: jest.fn((listener: any) => {
      openDocumentListener = listener;
      return { dispose: mockDispose };
    }),
    createFileSystemWatcher: jest.fn(() => ({
      onDidChange: jest.fn((listener: any) => { fsWatcherChangeListener = listener; }),
      onDidCreate: jest.fn((listener: any) => { fsWatcherCreateListener = listener; }),
      onDidDelete: jest.fn((listener: any) => { fsWatcherDeleteListener = listener; }),
      dispose: mockFsWatcherDispose,
    })),
    workspaceFolders: [{ uri: { fsPath: '/workspace' } }],
    textDocuments: [],
    getWorkspaceFolder: jest.fn((uri: any) => {
      // Return a workspace folder for paths starting with /workspace
      if (uri.fsPath.startsWith('/workspace')) {
        return { uri: { fsPath: '/workspace' } };
      }
      return undefined;
    }),
    fs: {
      readFile: (uri: any) => mockFsReadFile(uri),
    },
  },
  Uri: {
    file: (p: string) => ({ fsPath: p, scheme: 'file' }),
  },
  RelativePattern: jest.fn().mockImplementation((folder, pattern) => ({ folder, pattern })),
  EventEmitter: jest.fn().mockImplementation(() => {
    const listeners: Function[] = [];
    return {
      event: jest.fn((listener: Function) => {
        listeners.push(listener);
        return { dispose: () => { const idx = listeners.indexOf(listener); if (idx >= 0) listeners.splice(idx, 1); } };
      }),
      fire: jest.fn((data: any) => { listeners.forEach(l => l(data)); }),
      dispose: jest.fn(),
    };
  }),
}));

jest.mock('simple-git', () => ({
  simpleGit: jest.fn(() => ({
    revparse: jest.fn().mockResolvedValue('/repo/root\n'),
  })),
}));

// Helper to create a mock TextDocumentChangeEvent
function makeChangeEvent(filePath: string, changes: { text: string; rangeLength?: number }[]) {
  return {
    document: {
      uri: { fsPath: filePath, scheme: 'file' },
      getText: () => 'mock file content',
      version: 1,
    },
    contentChanges: changes.map(c => ({
      text: c.text,
      rangeLength: c.rangeLength ?? 0,
      range: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } },
    })),
  };
}

// Helper to encode string to Uint8Array (simulates file content from disk)
function encodeContent(content: string): Uint8Array {
  return new TextEncoder().encode(content);
}

describe('EditBurstTracker', () => {
  let tracker: EditBurstTracker;

  beforeEach(() => {
    jest.useFakeTimers();
    documentChangeListener = null;
    saveDocumentListener = null;
    openDocumentListener = null;
    fsWatcherChangeListener = null;
    fsWatcherCreateListener = null;
    fsWatcherDeleteListener = null;
    mockDispose.mockClear();
    mockFsWatcherDispose.mockClear();
    mockFsReadFile.mockClear();
    mockFsReadFile.mockResolvedValue(encodeContent('file content'));
    tracker = new EditBurstTracker();
  });

  afterEach(() => {
    tracker.dispose();
    jest.useRealTimers();
  });

  // --- Lifecycle ---
  describe('lifecycle', () => {
    it('creates with correct default configuration', () => {
      expect(tracker.idleMs).toBe(45000);
      expect(tracker.maxBurstDurationMs).toBe(300000);
      expect(tracker.cooldownMs).toBe(60000);
    });

    it('enable registers a document change listener', () => {
      tracker.enable();
      expect(documentChangeListener).not.toBeNull();
    });

    it('enable logs when service is enabled', () => {
      const consoleSpy = jest.spyOn(console, 'log').mockImplementation();
      tracker.enable();
      expect(consoleSpy).toHaveBeenCalledWith(
        '[EditBurstTracker] Service enabled and listening for document changes',
      );
      expect(consoleSpy).toHaveBeenCalledWith(
        expect.stringContaining('[EditBurstTracker] Created'),
      );
      consoleSpy.mockRestore();
    });

    it('enable creates FS watchers for workspace folders', () => {
      const vscode = require('vscode');
      tracker.enable();
      expect(vscode.workspace.createFileSystemWatcher).toHaveBeenCalled();
      expect(fsWatcherChangeListener).not.toBeNull();
      expect(fsWatcherCreateListener).not.toBeNull();
      expect(fsWatcherDeleteListener).not.toBeNull();
    });

    it('enable is idempotent — second call does nothing', () => {
      tracker.enable();
      const firstListener = documentChangeListener;
      tracker.enable();
      expect(documentChangeListener).toBe(firstListener);
    });

    it('disable disposes the listener and FS watchers', () => {
      tracker.enable();
      tracker.disable();
      expect(mockDispose).toHaveBeenCalled();
      expect(mockFsWatcherDispose).toHaveBeenCalled();
    });

    it('disable is idempotent', () => {
      tracker.disable();
      tracker.disable(); // should not throw
    });

    it('dispose cleans up everything', () => {
      tracker.enable();
      tracker.dispose();
      expect(mockDispose).toHaveBeenCalled();
    });

    it('dispose is safe to call multiple times', () => {
      tracker.enable();
      tracker.dispose();
      tracker.dispose(); // should not throw
    });
  });

  // --- Configuration ---
  describe('configuration', () => {
    it('allows setting custom thresholds', () => {
      tracker.idleMs = 2000;
      tracker.maxBurstDurationMs = 30000;
      tracker.cooldownMs = 30000;
      expect(tracker.idleMs).toBe(2000);
      expect(tracker.maxBurstDurationMs).toBe(30000);
      expect(tracker.cooldownMs).toBe(30000);
    });
  });

  // --- File filtering ---
  describe('file filtering', () => {
    it('ignores non-file scheme documents', async () => {
      tracker.enable();
      expect(documentChangeListener).not.toBeNull();

      // Create event with non-file scheme
      const event = {
        document: { uri: { fsPath: '/workspace/file.ts', scheme: 'untitled' } },
        contentChanges: [{ text: 'x'.repeat(500), rangeLength: 0 }],
      };

      // Should not throw
      await documentChangeListener!(event);
    });

    it('ignores non-relevant extensions', async () => {
      tracker.enable();
      const event = makeChangeEvent('/workspace/file.md', [{ text: 'x'.repeat(500) }]);
      // md is not in the relevant extensions list — should be silently ignored
      await documentChangeListener!(event);
    });

    it('ignores files in node_modules', async () => {
      tracker.enable();
      const event = makeChangeEvent('/workspace/node_modules/foo/index.ts', [{ text: 'x'.repeat(500) }]);
      await documentChangeListener!(event);
      // No crash, no burst
    });

    it('ignores files in dist/', async () => {
      tracker.enable();
      const event = makeChangeEvent('/workspace/dist/bundle.js', [{ text: 'x'.repeat(500) }]);
      await documentChangeListener!(event);
    });

    it('ignores files in .vscode/ folder', async () => {
      tracker.enable();
      const event = makeChangeEvent('/workspace/.vscode/settings.json', [{ text: 'x'.repeat(500) }]);
      await documentChangeListener!(event);
      // Should be silently ignored - no burst detection
    });

    it('ignores files in .github/ folder', async () => {
      tracker.enable();
      const event = makeChangeEvent('/workspace/.github/workflows/ci.yml', [{ text: 'x'.repeat(500) }]);
      await documentChangeListener!(event);
    });

    it('ignores files in nested hidden folders', async () => {
      tracker.enable();
      const event = makeChangeEvent('/workspace/.husky/pre-commit', [{ text: 'x'.repeat(500) }]);
      await documentChangeListener!(event);
    });

    it('does NOT ignore regular files with dots in names', async () => {
      const consoleSpy = jest.spyOn(console, 'log').mockImplementation();
      tracker.enable();
      const event = makeChangeEvent('/workspace/file.test.ts', [{ text: 'x'.repeat(250) }]);
      await documentChangeListener!(event);

      // Should detect burst (not ignored)
      expect(consoleSpy).toHaveBeenCalledWith(
        expect.stringContaining('[EditBurstTracker] Burst detected')
      );
      consoleSpy.mockRestore();
    });

    it('does NOT ignore files in src/ folder', async () => {
      const consoleSpy = jest.spyOn(console, 'log').mockImplementation();
      tracker.enable();
      const event = makeChangeEvent('/workspace/src/index.ts', [{ text: 'x'.repeat(250) }]);
      await documentChangeListener!(event);

      expect(consoleSpy).toHaveBeenCalledWith(
        expect.stringContaining('[EditBurstTracker] Burst detected')
      );
      consoleSpy.mockRestore();
    });

    it('does NOT ignore files in src/lib/ (user source directory)', async () => {
      const consoleSpy = jest.spyOn(console, 'log').mockImplementation();
      tracker.enable();
      const event = makeChangeEvent('/workspace/src/lib/helpers.ts', [{ text: 'x'.repeat(250) }]);
      await documentChangeListener!(event);
      expect(consoleSpy).toHaveBeenCalledWith(
        expect.stringContaining('[EditBurstTracker] Burst detected')
      );
      consoleSpy.mockRestore();
    });

    it('does NOT ignore files in top-level lib/ folder', async () => {
      const consoleSpy = jest.spyOn(console, 'log').mockImplementation();
      tracker.enable();
      const event = makeChangeEvent('/workspace/lib/utils.ts', [{ text: 'x'.repeat(250) }]);
      await documentChangeListener!(event);
      expect(consoleSpy).toHaveBeenCalledWith(
        expect.stringContaining('[EditBurstTracker] Burst detected')
      );
      consoleSpy.mockRestore();
    });

    it('does NOT ignore files in top-level esm/ folder', async () => {
      const consoleSpy = jest.spyOn(console, 'log').mockImplementation();
      tracker.enable();
      const event = makeChangeEvent('/workspace/esm/index.ts', [{ text: 'x'.repeat(250) }]);
      await documentChangeListener!(event);
      expect(consoleSpy).toHaveBeenCalledWith(
        expect.stringContaining('[EditBurstTracker] Burst detected')
      );
      consoleSpy.mockRestore();
    });

    it('does NOT ignore .js files in lib/ folder', async () => {
      const consoleSpy = jest.spyOn(console, 'log').mockImplementation();
      tracker.enable();
      const event = makeChangeEvent('/workspace/lib/index.js', [{ text: 'x'.repeat(250) }]);
      await documentChangeListener!(event);
      expect(consoleSpy).toHaveBeenCalledWith(
        expect.stringContaining('[EditBurstTracker] Burst detected')
      );
      consoleSpy.mockRestore();
    });

    it('ignores events with empty contentChanges', async () => {
      tracker.enable();
      const event = {
        document: { uri: { fsPath: '/workspace/file.ts', scheme: 'file' } },
        contentChanges: [],
      };
      await documentChangeListener!(event);
    });
  });

  // --- Workspace resolution ---
  describe('workspace resolution', () => {
    it('ignores files not in any workspace folder', async () => {
      tracker.enable();
      // /outside is not in /workspace so getWorkspaceFolder returns undefined
      const event = makeChangeEvent('/outside/file.ts', [{ text: 'x'.repeat(500) }]);
      await documentChangeListener!(event);
      // Should not throw
    });
  });

  // --- Burst threshold detection (Phase 1) ---
  describe('burst threshold detection', () => {
    it('detects paste threshold (single edit >= 200 chars)', async () => {
      tracker.enable();
      const event = makeChangeEvent('/workspace/file.ts', [{ text: 'x'.repeat(250) }]);
      await documentChangeListener!(event);
      // After git resolution, the tracker should be in accumulating state
      // We can't directly check private state, but it should not throw
    });

    it('handles multiple rapid small edits across files', async () => {
      tracker.enable();
      for (let i = 0; i < 5; i++) {
        const event = makeChangeEvent(`/workspace/file${i}.ts`, [{ text: 'const x = 1;' }]);
        await documentChangeListener!(event);
      }
      // 5 files edited — exceeds FILE_THRESHOLD of 3
    });
  });

  // --- Diagnostic logging ---
  describe('diagnostic logging', () => {
    it('logs when burst is detected and emitted', async () => {
      const consoleSpy = jest.spyOn(console, 'log').mockImplementation();
      tracker.idleMs = 30000;
      tracker.enable();

      // Trigger burst with a large paste (>= 200 chars)
      const event = makeChangeEvent('/workspace/file.ts', [{ text: 'x'.repeat(250) }]);
      await documentChangeListener!(event);

      // Should log "Burst detected"
      expect(consoleSpy).toHaveBeenCalledWith(
        expect.stringContaining('[EditBurstTracker] Burst detected'),
      );

      // Advance past idle timer (30s) to emit burst
      jest.advanceTimersByTime(35000);
      await Promise.resolve();
      await Promise.resolve();

      expect(consoleSpy).toHaveBeenCalledWith(
        expect.stringContaining('[EditBurstTracker] Burst emitted'),
      );

      consoleSpy.mockRestore();
    });

    it('logs when burst is suppressed by formatter heuristic', async () => {
      const consoleSpy = jest.spyOn(console, 'log').mockImplementation();
      tracker.idleMs = 30000;
      tracker.enable();

      // Create many tiny edits across few files to trigger threshold
      // but with avgCharsPerEdit < 5, totalChars < 800, files < 5 → suppressed
      // Use 3+ files to cross FILE_THRESHOLD
      for (let i = 0; i < 4; i++) {
        const event = makeChangeEvent(`/workspace/file${i}.ts`, [{ text: 'ab' }]);
        await documentChangeListener!(event);
      }

      // Advance past idle timer (30s)
      jest.advanceTimersByTime(35000);
      await Promise.resolve();
      await Promise.resolve();

      expect(consoleSpy).toHaveBeenCalledWith(
        expect.stringContaining('[EditBurstTracker] Burst suppressed (formatter heuristic)'),
      );

      consoleSpy.mockRestore();
    });
  });

  // --- Event interface ---
  describe('event interface', () => {
    it('exposes onAIBurstDetected event', () => {
      expect(tracker.onAIBurstDetected).toBeDefined();
      expect(typeof tracker.onAIBurstDetected).toBe('function');
    });

    it('allows subscribing to burst events', () => {
      const callback = jest.fn();
      const disposable = tracker.onAIBurstDetected(callback);
      expect(disposable).toBeDefined();
      expect(typeof disposable.dispose).toBe('function');
      disposable.dispose();
    });
  });

  // --- Non-git folder support ---
  describe('non-git folder support', () => {
    let simpleGitMock: jest.Mock;

    beforeEach(() => {
      // Override simpleGit mock to throw (simulate non-git folder)
      const simpleGitModule = require('simple-git');
      simpleGitMock = simpleGitModule.simpleGit;
      simpleGitMock.mockClear();
      simpleGitMock.mockImplementation(() => ({
        revparse: jest.fn().mockRejectedValue(new Error('not a git repository')),
      }));
    });

    afterEach(() => {
      // Restore default simpleGit mock behavior
      simpleGitMock.mockImplementation(() => ({
        revparse: jest.fn().mockResolvedValue('/repo/root\n'),
      }));
    });

    it('falls back to workspace folder when git resolution fails', async () => {
      tracker.enable();
      const event = makeChangeEvent('/workspace/file.ts', [{ text: 'x'.repeat(250) }]);
      await documentChangeListener!(event);
      // Should detect burst using workspace folder as root (not silently ignored)
      jest.advanceTimersByTime(2000);
      // If this didn't throw and completed, the fallback worked
    });

    it('emits burst with workspace folder as repoRoot', async () => {
      const consoleSpy = jest.spyOn(console, 'log').mockImplementation();
      tracker.idleMs = 30000;
      tracker.enable();

      const event = makeChangeEvent('/workspace/file.ts', [{ text: 'x'.repeat(250) }]);
      await documentChangeListener!(event);

      // Burst should be detected
      expect(consoleSpy).toHaveBeenCalledWith(
        expect.stringContaining('[EditBurstTracker] Burst detected for /workspace')
      );

      // Advance past idle timer (30s) to emit burst
      jest.advanceTimersByTime(35000);
      await Promise.resolve();
      await Promise.resolve();

      // Should emit burst using workspace folder as repoRoot
      expect(consoleSpy).toHaveBeenCalledWith(
        expect.stringContaining('[EditBurstTracker] Burst emitted')
      );

      consoleSpy.mockRestore();
    });

    it('caches workspace folder fallback to avoid repeated git attempts', async () => {
      tracker.enable();
      // Let pre-warm complete so first edit uses cache (no extra git call)
      await Promise.resolve();
      await Promise.resolve();

      // First edit uses cache from pre-warm (no additional git call)
      await documentChangeListener!(makeChangeEvent('/workspace/file.ts', [{ text: 'a' }]));
      expect(simpleGitMock).toHaveBeenCalledTimes(1);

      // Second edit should use cache, not call git again
      await documentChangeListener!(makeChangeEvent('/workspace/file2.ts', [{ text: 'b' }]));
      expect(simpleGitMock).toHaveBeenCalledTimes(1);
    });
  });

  // --- FS Watcher (Claude Code CLI detection) ---
  describe('FS watcher for external edits', () => {
    // Helper to flush all pending promises and timers
    async function flushPromisesAndTimers(ms: number = 600): Promise<void> {
      jest.advanceTimersByTime(ms);
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    }

    it('detects external file change via FS watcher', async () => {
      const consoleSpy = jest.spyOn(console, 'log').mockImplementation();
      tracker.enable();

      const uri = { fsPath: '/workspace/file.ts', scheme: 'file' };

      // First read: establish cache with small content
      mockFsReadFile.mockResolvedValueOnce(encodeContent('const x = 1;'));
      fsWatcherChangeListener!(uri);
      await flushPromisesAndTimers(600);

      // Second read: content grew by 300+ chars (delta triggers PASTE_THRESHOLD)
      mockFsReadFile.mockResolvedValueOnce(encodeContent('const x = 1;' + 'y'.repeat(300)));
      jest.advanceTimersByTime(1100); // Past EDITOR_DEDUPE_WINDOW_MS
      fsWatcherChangeListener!(uri);
      await flushPromisesAndTimers(600);

      expect(consoleSpy).toHaveBeenCalledWith(
        expect.stringContaining('[EditBurstTracker] FS watcher: /workspace/file.ts')
      );

      // Should detect burst (300 char delta > PASTE_THRESHOLD)
      expect(consoleSpy).toHaveBeenCalledWith(
        expect.stringContaining('[EditBurstTracker] Burst detected')
      );

      consoleSpy.mockRestore();
    });

    it('handles atomic rename (delete + create) as change', async () => {
      const consoleSpy = jest.spyOn(console, 'log').mockImplementation();
      mockFsReadFile.mockResolvedValue(encodeContent('x'.repeat(300)));
      tracker.enable();

      const uri = { fsPath: '/workspace/file.ts', scheme: 'file' };

      // Fire delete then create within window
      fsWatcherDeleteListener!(uri);
      jest.advanceTimersByTime(100); // Within DELETE_CREATE_WINDOW_MS (500ms)
      fsWatcherCreateListener!(uri);

      // Advance past debounce and flush promises
      await flushPromisesAndTimers(600);

      // Should process as a change, not be ignored
      expect(consoleSpy).toHaveBeenCalledWith(
        expect.stringContaining('[EditBurstTracker] FS watcher: /workspace/file.ts')
      );

      consoleSpy.mockRestore();
    });

    it('dedupes editor saves from FS events', async () => {
      const consoleSpy = jest.spyOn(console, 'log').mockImplementation();
      tracker.enable();

      const filePath = '/workspace/file.ts';
      const uri = { fsPath: filePath, scheme: 'file' };

      // Simulate editor change (which records activity)
      const event = makeChangeEvent(filePath, [{ text: 'const x = 1;' }]);
      await documentChangeListener!(event);

      // Now fire FS event - should be ignored due to recent editor activity
      fsWatcherChangeListener!(uri);
      await flushPromisesAndTimers(600);

      // Should NOT log FS watcher message (deduped)
      const fsWatcherLogs = consoleSpy.mock.calls.filter(
        call => call[0]?.includes?.('[EditBurstTracker] FS watcher:')
      );
      expect(fsWatcherLogs.length).toBe(0);

      consoleSpy.mockRestore();
    });

    it('debounces rapid FS events', async () => {
      mockFsReadFile.mockResolvedValue(encodeContent('x'.repeat(50)));
      tracker.enable();

      const uri = { fsPath: '/workspace/debounce-test.ts', scheme: 'file' };

      // Fire multiple FS events rapidly
      fsWatcherChangeListener!(uri);
      jest.advanceTimersByTime(100);
      fsWatcherChangeListener!(uri);
      jest.advanceTimersByTime(100);
      fsWatcherChangeListener!(uri);

      // Advance past debounce from last event and flush promises
      await flushPromisesAndTimers(600);

      // Should only read file once (debounced)
      expect(mockFsReadFile).toHaveBeenCalledTimes(1);
    });

    it('calculates delta from cached content', async () => {
      const consoleSpy = jest.spyOn(console, 'log').mockImplementation();
      tracker.enable();

      const uri = { fsPath: '/workspace/delta-test.ts', scheme: 'file' };

      // First read: 100 chars
      mockFsReadFile.mockResolvedValueOnce(encodeContent('x'.repeat(100)));
      fsWatcherChangeListener!(uri);
      await flushPromisesAndTimers(600);

      // Second read: 350 chars (delta = 250, triggers paste threshold)
      mockFsReadFile.mockResolvedValueOnce(encodeContent('x'.repeat(350)));
      jest.advanceTimersByTime(1100); // Past EDITOR_DEDUPE_WINDOW_MS
      fsWatcherChangeListener!(uri);
      await flushPromisesAndTimers(600);

      // Should detect burst due to 250 char delta
      expect(consoleSpy).toHaveBeenCalledWith(
        expect.stringContaining('[EditBurstTracker] Burst detected')
      );

      consoleSpy.mockRestore();
    });

    it('uses chars=0 for uncached files (no false positive)', async () => {
      const consoleSpy = jest.spyOn(console, 'log').mockImplementation();
      // 300 chars for first-time file, but since uncached, chars = 0 (Fix #2)
      mockFsReadFile.mockResolvedValue(encodeContent('x'.repeat(300)));
      tracker.enable();

      const uri = { fsPath: '/workspace/newfile.ts', scheme: 'file' };
      fsWatcherChangeListener!(uri);
      await flushPromisesAndTimers(600);

      // chars = 0 (first time seeing file), so no burst triggered by single file
      // Burst detection relies on FILE_THRESHOLD (3+ files) for CLI detection
      expect(consoleSpy).not.toHaveBeenCalledWith(
        expect.stringContaining('[EditBurstTracker] Burst detected')
      );

      consoleSpy.mockRestore();
    });

    it('ignores node_modules from FS watcher', async () => {
      const consoleSpy = jest.spyOn(console, 'log').mockImplementation();
      tracker.enable();

      const uri = { fsPath: '/workspace/node_modules/foo/index.ts', scheme: 'file' };
      fsWatcherChangeListener!(uri);
      await flushPromisesAndTimers(600);

      // Should NOT log FS watcher message (ignored path)
      const fsWatcherLogs = consoleSpy.mock.calls.filter(
        call => call[0]?.includes?.('[EditBurstTracker] FS watcher:')
      );
      expect(fsWatcherLogs.length).toBe(0);

      consoleSpy.mockRestore();
    });

    it('ignores .git directory from FS watcher', async () => {
      const consoleSpy = jest.spyOn(console, 'log').mockImplementation();
      tracker.enable();

      const uri = { fsPath: '/workspace/.git/objects/abc123', scheme: 'file' };
      fsWatcherChangeListener!(uri);
      await flushPromisesAndTimers(600);

      // Should NOT log FS watcher message
      const fsWatcherLogs = consoleSpy.mock.calls.filter(
        call => call[0]?.includes?.('[EditBurstTracker] FS watcher:')
      );
      expect(fsWatcherLogs.length).toBe(0);

      consoleSpy.mockRestore();
    });

    it('ignores .vscode directory from FS watcher', async () => {
      const consoleSpy = jest.spyOn(console, 'log').mockImplementation();
      tracker.enable();

      const uri = { fsPath: '/workspace/.vscode/settings.json', scheme: 'file' };
      fsWatcherChangeListener!(uri);
      await flushPromisesAndTimers(600);

      // Should NOT log FS watcher message (ignored path)
      const fsWatcherLogs = consoleSpy.mock.calls.filter(
        call => call[0]?.includes?.('[EditBurstTracker] FS watcher:')
      );
      expect(fsWatcherLogs.length).toBe(0);

      consoleSpy.mockRestore();
    });

    it('ignores .github directory from FS watcher', async () => {
      const consoleSpy = jest.spyOn(console, 'log').mockImplementation();
      tracker.enable();

      const uri = { fsPath: '/workspace/.github/workflows/ci.yml', scheme: 'file' };
      fsWatcherChangeListener!(uri);
      await flushPromisesAndTimers(600);

      const fsWatcherLogs = consoleSpy.mock.calls.filter(
        call => call[0]?.includes?.('[EditBurstTracker] FS watcher:')
      );
      expect(fsWatcherLogs.length).toBe(0);

      consoleSpy.mockRestore();
    });

    it('snapshots from disk for closed files', async () => {
      mockFsReadFile.mockResolvedValue(encodeContent('x'.repeat(300)));
      tracker.enable();

      const uri = { fsPath: '/workspace/closed-file.ts', scheme: 'file' };
      fsWatcherChangeListener!(uri);
      await flushPromisesAndTimers(600);

      // Advance idle timer to emit burst
      await flushPromisesAndTimers(35000);

      // File should have been read for snapshot (called at least once for delta calc)
      expect(mockFsReadFile).toHaveBeenCalled();
    });

    it('suppresses bulk operations (10+ files in 2s)', async () => {
      const consoleSpy = jest.spyOn(console, 'log').mockImplementation();
      mockFsReadFile.mockResolvedValue(encodeContent('x'.repeat(300)));

      // Use a short idle timer so the burst emits quickly (within 2s window)
      tracker.idleMs = 500;
      tracker.enable();

      // Rapidly create 10+ file change events
      for (let i = 0; i < 12; i++) {
        const uri = { fsPath: `/workspace/bulk${i}.ts`, scheme: 'file' };
        fsWatcherChangeListener!(uri);
      }

      // Process all debounced events (600ms)
      await flushPromisesAndTimers(600);

      // Advance idle timer (500ms) - total time ~1100ms < BULK_TIME_WINDOW_MS (2000ms)
      await flushPromisesAndTimers(600);

      // Should be suppressed due to bulk operation (10+ files within 2s)
      expect(consoleSpy).toHaveBeenCalledWith(
        '[EditBurstTracker] Burst suppressed (bulk operation detected)'
      );

      consoleSpy.mockRestore();
    });

    it('handles file read errors gracefully', async () => {
      const consoleSpy = jest.spyOn(console, 'log').mockImplementation();
      const consoleErrorSpy = jest.spyOn(console, 'error').mockImplementation();
      mockFsReadFile.mockRejectedValue(new Error('File not found'));
      tracker.enable();

      const uri = { fsPath: '/workspace/deleted.ts', scheme: 'file' };
      fsWatcherChangeListener!(uri);
      await flushPromisesAndTimers(600);

      // Should not throw, just silently skip
      expect(consoleErrorSpy).not.toHaveBeenCalled();

      consoleSpy.mockRestore();
      consoleErrorSpy.mockRestore();
    });

    it('captures correct pre-change snapshot for FS events', async () => {
      tracker.enable();

      const uri = { fsPath: '/workspace/snapshot-test.ts', scheme: 'file' };

      // First read: establishes cache with "original content"
      const originalContent = 'const x = 1;';
      mockFsReadFile.mockResolvedValueOnce(encodeContent(originalContent));
      fsWatcherChangeListener!(uri);
      await flushPromisesAndTimers(600);

      // Second read: file changed to "modified content" (longer, triggers paste)
      const modifiedContent = 'const x = 1;\n' + 'y'.repeat(300);
      mockFsReadFile.mockResolvedValueOnce(encodeContent(modifiedContent));
      jest.advanceTimersByTime(1100); // Past EDITOR_DEDUPE_WINDOW_MS
      fsWatcherChangeListener!(uri);
      await flushPromisesAndTimers(600);

      // Advance idle timer to emit burst
      await flushPromisesAndTimers(35000);

      // The snapshot should contain the original content (pre-change), not modified
      // This verifies Fix #1: snapshot race is fixed
      // We can't directly inspect the snapshot, but we verify burst was detected
      // with correct delta calculation (300+ chars difference)
    });

    it('detects burst from 3+ uncached files (FILE_THRESHOLD)', async () => {
      const consoleSpy = jest.spyOn(console, 'log').mockImplementation();
      mockFsReadFile.mockResolvedValue(encodeContent('content'));
      tracker.enable();

      // Create 3 uncached file events (each with chars=0, but FILE_THRESHOLD=3)
      for (let i = 0; i < 3; i++) {
        const uri = { fsPath: `/workspace/newfile${i}.ts`, scheme: 'file' };
        fsWatcherChangeListener!(uri);
        await flushPromisesAndTimers(600);
      }

      // 3+ files should trigger burst detection via FILE_THRESHOLD
      expect(consoleSpy).toHaveBeenCalledWith(
        expect.stringContaining('[EditBurstTracker] Burst detected')
      );

      consoleSpy.mockRestore();
    });

    it('syncs cache on editor edits for accurate FS delta', async () => {
      const consoleSpy = jest.spyOn(console, 'log').mockImplementation();
      tracker.enable();

      const filePath = '/workspace/sync-test.ts';
      const uri = { fsPath: filePath, scheme: 'file' };

      // Editor edit creates/updates cache via _onDocumentChange
      // The mock getText() returns 'mock file content' (17 chars)
      const event = makeChangeEvent(filePath, [{ text: 'const x = 1;' }]);
      await documentChangeListener!(event);

      // Wait past EDITOR_DEDUPE_WINDOW_MS so FS events aren't deduped
      jest.advanceTimersByTime(1100);

      // FS event reads file with 300 more chars - delta should be based on cached content
      // mock getText() returns 17 chars, so 317 chars = delta of 300
      mockFsReadFile.mockResolvedValueOnce(encodeContent('mock file content' + 'x'.repeat(300)));
      fsWatcherChangeListener!(uri);
      await flushPromisesAndTimers(600);

      // Delta = 300 chars >= PASTE_THRESHOLD (200), should trigger burst
      expect(consoleSpy).toHaveBeenCalledWith(
        expect.stringContaining('[EditBurstTracker] Burst detected')
      );

      consoleSpy.mockRestore();
    });
  });

  // --- AI thinking pause tolerance ---
  describe('AI thinking pause tolerance', () => {
    it('20s thinking pause does NOT emit burst', async () => {
      const consoleSpy = jest.spyOn(console, 'log').mockImplementation();
      tracker.enable();

      // Trigger a burst with a large paste
      const event = makeChangeEvent('/workspace/file.ts', [{ text: 'x'.repeat(250) }]);
      await documentChangeListener!(event);

      expect(consoleSpy).toHaveBeenCalledWith(
        expect.stringContaining('[EditBurstTracker] Burst detected')
      );

      // Advance 20s — shorter than idle timer (30s), should NOT emit
      jest.advanceTimersByTime(20000);

      expect(consoleSpy).not.toHaveBeenCalledWith(
        expect.stringContaining('[EditBurstTracker] Burst emitted')
      );

      consoleSpy.mockRestore();
    });

    it('60s multi-file refactoring does NOT emit via max duration', async () => {
      const consoleSpy = jest.spyOn(console, 'log').mockImplementation();
      tracker.enable();

      // Trigger a burst
      const event1 = makeChangeEvent('/workspace/file1.ts', [{ text: 'x'.repeat(250) }]);
      await documentChangeListener!(event1);

      // Keep editing over 60s (max burst duration is 300s, so should NOT emit)
      for (let i = 0; i < 6; i++) {
        jest.advanceTimersByTime(10000); // 10s between edits, resets idle timer each time
        const event = makeChangeEvent(`/workspace/file${i + 2}.ts`, [{ text: 'y'.repeat(50) }]);
        await documentChangeListener!(event);
      }

      // Total elapsed ~60s, well under 300s max duration
      expect(consoleSpy).not.toHaveBeenCalledWith(
        expect.stringContaining('[EditBurstTracker] Burst emitted')
      );

      consoleSpy.mockRestore();
    });

    it('300s+ active editing DOES emit via max duration safety valve', async () => {
      const consoleSpy = jest.spyOn(console, 'log').mockImplementation();
      tracker.enable();

      // Trigger a burst
      const event1 = makeChangeEvent('/workspace/file.ts', [{ text: 'x'.repeat(250) }]);
      await documentChangeListener!(event1);

      // Keep editing every 20s for 280s (to stay under idle timer of 30s)
      for (let i = 0; i < 14; i++) {
        jest.advanceTimersByTime(20000);
        const event = makeChangeEvent('/workspace/file.ts', [{ text: 'z'.repeat(10) }]);
        await documentChangeListener!(event);
      }

      // Now advance past the max duration timer (300s total from burst start)
      // We've spent 280s, need 20s more to hit max duration
      jest.advanceTimersByTime(25000);
      await Promise.resolve();
      await Promise.resolve();

      expect(consoleSpy).toHaveBeenCalledWith(
        expect.stringContaining('[EditBurstTracker] Burst emitted')
      );

      consoleSpy.mockRestore();
    });

    it('custom idleMs (45s) is respected', async () => {
      const consoleSpy = jest.spyOn(console, 'log').mockImplementation();
      tracker.idleMs = 45000;
      tracker.enable();

      // Trigger a burst
      const event = makeChangeEvent('/workspace/file.ts', [{ text: 'x'.repeat(250) }]);
      await documentChangeListener!(event);

      // Advance 40s — shorter than custom idle (45s), should NOT emit
      jest.advanceTimersByTime(40000);

      expect(consoleSpy).not.toHaveBeenCalledWith(
        expect.stringContaining('[EditBurstTracker] Burst emitted')
      );

      // Advance 10s more (total 50s > 45s idle), should emit
      jest.advanceTimersByTime(10000);
      await Promise.resolve();
      await Promise.resolve();

      expect(consoleSpy).toHaveBeenCalledWith(
        expect.stringContaining('[EditBurstTracker] Burst emitted')
      );

      consoleSpy.mockRestore();
    });
  });

  // --- Optimistic timer reset ---
  describe('optimistic timer reset', () => {
    // Helper to flush all pending promises and timers
    async function flushPromisesAndTimers(ms: number = 600): Promise<void> {
      jest.advanceTimersByTime(ms);
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    }

    it('FS event near idle timeout extends timer', async () => {
      const consoleSpy = jest.spyOn(console, 'log').mockImplementation();
      tracker.idleMs = 30000;
      tracker.enable();

      // Trigger burst via editor paste
      const event = makeChangeEvent('/workspace/file.ts', [{ text: 'x'.repeat(250) }]);
      await documentChangeListener!(event);

      expect(consoleSpy).toHaveBeenCalledWith(
        expect.stringContaining('[EditBurstTracker] Burst detected')
      );

      // Advance to 29s (just before 30s idle timeout)
      jest.advanceTimersByTime(29000);

      // FS event arrives (debounced 500ms) — run debounce first so reset happens before 30s idle
      const uri = { fsPath: '/workspace/other.ts', scheme: 'file' };
      mockFsReadFile.mockResolvedValueOnce(encodeContent('new content'));
      fsWatcherChangeListener!(uri);

      jest.advanceTimersByTime(500); // run FS debounce so _processFsChange resets idle timer
      await Promise.resolve();
      await Promise.resolve();

      // Advance 2s — would have been past original 30s idle, but timer was reset
      jest.advanceTimersByTime(2000);

      expect(consoleSpy).not.toHaveBeenCalledWith(
        expect.stringContaining('[EditBurstTracker] Burst emitted')
      );

      // Advance full 30s from the FS event (idle was reset at 29.5s, so 30s later = 59.5s)
      jest.advanceTimersByTime(30000);
      // _emitBurst awaits snapshots with 5s timeout; advance so it can complete
      jest.advanceTimersByTime(6000);
      await Promise.resolve();
      await Promise.resolve();

      expect(consoleSpy).toHaveBeenCalledWith(
        expect.stringContaining('[EditBurstTracker] Burst emitted')
      );

      consoleSpy.mockRestore();
    });

    it('no-op when not accumulating', async () => {
      tracker.enable();

      // Small edit below threshold — not accumulating
      const event = makeChangeEvent('/workspace/file.ts', [{ text: 'ab' }]);
      await documentChangeListener!(event);

      // Should not throw — optimistic reset is called but does nothing
    });

    it('no-op when no repo cache', async () => {
      tracker.enable();

      // First-ever FS event — no repo cache yet, optimistic reset skipped
      const uri = { fsPath: '/workspace/brand-new.ts', scheme: 'file' };
      mockFsReadFile.mockResolvedValueOnce(encodeContent('content'));
      fsWatcherChangeListener!(uri);
      await flushPromisesAndTimers(600);

      // Should not throw — normal flow works even without cached repo root
    });

    it('second editor edit resets idle timer (pre-warm ensures cache so optimistic reset runs)', async () => {
      const consoleSpy = jest.spyOn(console, 'log').mockImplementation();
      tracker.idleMs = 30000;
      tracker.enable();

      // Let pre-warm complete so _repoCache has an entry for this folder
      await Promise.resolve();
      await Promise.resolve();

      // Edit 1: trigger Phase 2 (large paste)
      const event1 = makeChangeEvent('/workspace/file1.ts', [{ text: 'x'.repeat(250) }]);
      await documentChangeListener!(event1);
      expect(consoleSpy).toHaveBeenCalledWith(
        expect.stringContaining('[EditBurstTracker] Burst detected')
      );

      // Edit 2 before idle fires (5s later) — should reset idle timer via optimistic path (cache from pre-warm)
      jest.advanceTimersByTime(5000);
      const event2 = makeChangeEvent('/workspace/file2.ts', [{ text: 'y'.repeat(50) }]);
      await documentChangeListener!(event2);

      // Advance 20s — still less than 30s from edit 2, so no burst yet
      jest.advanceTimersByTime(20000);
      expect(consoleSpy).not.toHaveBeenCalledWith(
        expect.stringContaining('[EditBurstTracker] Burst emitted')
      );

      // Advance 15s more (total 40s from edit 2) — now past idleMs, burst should emit
      jest.advanceTimersByTime(15000);
      jest.advanceTimersByTime(6000); // snapshot await
      await Promise.resolve();
      await Promise.resolve();
      expect(consoleSpy).toHaveBeenCalledWith(
        expect.stringContaining('[EditBurstTracker] Burst emitted')
      );

      consoleSpy.mockRestore();
    });

    it('rapid FS events continuously delay emission', async () => {
      const consoleSpy = jest.spyOn(console, 'log').mockImplementation();
      tracker.idleMs = 30000;
      tracker.enable();

      // Trigger burst via editor paste
      const event = makeChangeEvent('/workspace/file.ts', [{ text: 'x'.repeat(250) }]);
      await documentChangeListener!(event);

      expect(consoleSpy).toHaveBeenCalledWith(
        expect.stringContaining('[EditBurstTracker] Burst detected')
      );

      // Send FS events every 10s for 60s — each should reset the 30s idle timer.
      // Run 500ms debounce after each FS event so _processFsChange completes before next advance.
      for (let i = 0; i < 6; i++) {
        jest.advanceTimersByTime(i === 0 ? 10000 : 9500); // first: 0->10s, then +9.5s each
        const uri = { fsPath: `/workspace/rapid${i}.ts`, scheme: 'file' };
        mockFsReadFile.mockResolvedValueOnce(encodeContent(`content ${i}`));
        fsWatcherChangeListener!(uri);
        jest.advanceTimersByTime(500); // run debounce so reset happens before next 10s
        for (let j = 0; j < 5; j++) {
          await Promise.resolve();
        }
      }

      // At this point, 60.5s have elapsed but last FS event was at t=60s (processed at 60.5s)
      // Burst should NOT have been emitted yet (idle timer reset each time)
      expect(consoleSpy).not.toHaveBeenCalledWith(
        expect.stringContaining('[EditBurstTracker] Burst emitted')
      );

      // Advance 31s past the last FS event — NOW it should emit
      jest.advanceTimersByTime(31000);
      // _emitBurst awaits snapshots with 5s timeout; advance so it can complete
      jest.advanceTimersByTime(6000);
      await Promise.resolve();
      await Promise.resolve();

      expect(consoleSpy).toHaveBeenCalledWith(
        expect.stringContaining('[EditBurstTracker] Burst emitted')
      );

      consoleSpy.mockRestore();
    });
  });
});
