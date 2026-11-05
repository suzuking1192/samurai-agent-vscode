import { computeNeedsGitFallback } from '../RegressionDiffCapture';

// We can only unit test computeNeedsGitFallback since buildSnapshotDiff and
// captureGitDiff depend on vscode/fs/git. Those are tested via integration tests.

describe('computeNeedsGitFallback', () => {
  const makeSnapshots = (count: number): Map<string, { startText: string; endText?: string }> => {
    const map = new Map<string, { startText: string; endText?: string }>();
    for (let i = 0; i < count; i++) {
      map.set(`/repo/file${i}.ts`, { startText: 'content' });
    }
    return map;
  };

  it('returns false when snapshot is complete and sufficient', () => {
    const snapshots = makeSnapshots(3);
    const touchedFiles = Array.from(snapshots.keys());
    const result = computeNeedsGitFallback(
      'a'.repeat(200), // snapshotDiff long enough
      500,             // totalCharsChanged
      snapshots,
      touchedFiles
    );
    expect(result).toBe(false);
  });

  it('returns true when snapshot is too small relative to totalCharsChanged', () => {
    const snapshots = makeSnapshots(3);
    const touchedFiles = Array.from(snapshots.keys());
    const result = computeNeedsGitFallback(
      'tiny',   // < 100 chars
      500,      // > 200 totalCharsChanged
      snapshots,
      touchedFiles
    );
    expect(result).toBe(true);
  });

  it('returns false when snapshot is small but totalCharsChanged is also small', () => {
    const snapshots = makeSnapshots(1);
    const touchedFiles = Array.from(snapshots.keys());
    const result = computeNeedsGitFallback(
      'tiny',   // < 100 chars
      50,       // <= 200 totalCharsChanged
      snapshots,
      touchedFiles
    );
    expect(result).toBe(false);
  });

  it('returns true when some touched files were not snapshotted', () => {
    const snapshots = makeSnapshots(2);
    const touchedFiles = [...Array.from(snapshots.keys()), '/repo/extra.ts'];
    const result = computeNeedsGitFallback(
      'a'.repeat(200),
      500,
      snapshots,
      touchedFiles
    );
    expect(result).toBe(true);
  });

  it('returns true when snapshot count reaches maxFilesPerBurst', () => {
    const snapshots = makeSnapshots(20);
    const touchedFiles = Array.from(snapshots.keys());
    const result = computeNeedsGitFallback(
      'a'.repeat(200),
      500,
      snapshots,
      touchedFiles,
      20 // maxFilesPerBurst
    );
    expect(result).toBe(true);
  });

  it('returns false when snapshot count is below maxFilesPerBurst', () => {
    const snapshots = makeSnapshots(19);
    const touchedFiles = Array.from(snapshots.keys());
    const result = computeNeedsGitFallback(
      'a'.repeat(200),
      500,
      snapshots,
      touchedFiles,
      20
    );
    expect(result).toBe(false);
  });

  it('handles empty snapshots with no changes', () => {
    const result = computeNeedsGitFallback(
      '',
      0,
      new Map(),
      []
    );
    expect(result).toBe(false);
  });

  it('handles empty snapshot diff with large totalCharsChanged', () => {
    const result = computeNeedsGitFallback(
      '',
      1000,
      new Map(),
      ['/repo/file.ts']
    );
    expect(result).toBe(true);
  });
});
