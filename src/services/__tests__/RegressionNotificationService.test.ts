import { RegressionNotificationService, getRiskLevel } from '../RegressionNotificationService';

// Mock vscode
const mockShowWarningMessage = jest.fn();
const mockExecuteCommand = jest.fn();
let mockVscodeEnabled = false;
let mockRiskThreshold = 'always';
const mockGetConfiguration = jest.fn((section: string) => ({
  get: jest.fn((key: string, defaultVal: any) => {
    if (section === 'samurai-agent.regressionDetection' && key === 'enabled') {
      return mockVscodeEnabled;
    }
    if (section === 'samurai-agent.regressionDetection' && key === 'riskThreshold') {
      return mockRiskThreshold;
    }
    return defaultVal;
  }),
}));

jest.mock('vscode', () => ({
  workspace: {
    getConfiguration: (...args: any[]) => mockGetConfiguration(...args),
    getWorkspaceFolder: jest.fn(() => undefined),
  },
  window: {
    showWarningMessage: (...args: any[]) => mockShowWarningMessage(...args),
  },
  commands: {
    executeCommand: (...args: any[]) => mockExecuteCommand(...args),
  },
  Uri: {
    file: jest.fn((path: string) => ({ fsPath: path })),
  },
}));

jest.mock('../RegressionRiskScorer', () => ({
  scoreRegressionRisk: jest.fn(() => ({ totalRiskScore: 60, signals: [] })),
}));

jest.mock('../RegressionDiffCapture', () => ({
  buildSnapshotDiff: jest.fn(() => 'mock diff'),
  captureGitDiff: jest.fn(async () => ({ gitDiff: '', statusOutput: '' })),
  computeNeedsGitFallback: jest.fn(() => false),
}));

const mockDiscoverRecentPlanFile = jest.fn().mockResolvedValue(undefined);
jest.mock('../AIToolPlanDiscovery', () => ({
  discoverRecentPlanFile: (...args: any[]) => mockDiscoverRecentPlanFile(...args),
}));

function makeMockTracker() {
  let listener: ((burst: any) => void) | null = null;
  return {
    onAIBurstDetected: jest.fn((cb: any) => {
      listener = cb;
      return { dispose: jest.fn() };
    }),
    fire(burst: any) {
      listener?.(burst);
    },
  };
}

function makeMockGlobalDataStore(enabled: boolean) {
  return {
    loadGlobalSettings: jest.fn(() => ({
      payload: { enableRegressionDetection: enabled },
    })),
  };
}

const dummyBurst = {
  fileSnapshots: new Map(),
  repoRoot: '/repo',
  totalCharsChanged: 500,
  touchedFiles: ['/repo/src/index.ts'],
};

describe('RegressionNotificationService', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockVscodeEnabled = false;
    mockRiskThreshold = 'always';
  });

  it('returns early when both settings are disabled', async () => {
    const tracker = makeMockTracker();
    const store = makeMockGlobalDataStore(false);
    mockVscodeEnabled = false;
    const consoleSpy = jest.spyOn(console, 'log').mockImplementation();

    const service = new RegressionNotificationService(
      tracker as any,
      store as any,
    );
    service.start();
    tracker.fire(dummyBurst);

    // Allow async _handleBurst to settle
    await new Promise(r => setTimeout(r, 0));

    expect(consoleSpy).toHaveBeenCalledWith(
      '[RegressionNotificationService] Feature disabled (VS Code: false, GlobalDataStore: false)',
    );
    expect(mockShowWarningMessage).not.toHaveBeenCalled();
    consoleSpy.mockRestore();
  });

  it('proceeds to scoring when enableRegressionDetection is true', async () => {
    const tracker = makeMockTracker();
    const store = makeMockGlobalDataStore(true);
    mockShowWarningMessage.mockResolvedValue('Ignore');

    const { scoreRegressionRisk } = require('../RegressionRiskScorer');
    (scoreRegressionRisk as jest.Mock).mockReturnValue({ totalRiskScore: 60, reasons: [], riskiestFiles: [] });

    const service = new RegressionNotificationService(
      tracker as any,
      store as any,
    );
    service.start();
    tracker.fire(dummyBurst);

    await new Promise(r => setTimeout(r, 0));

    // Should have shown the warning notification (score 60 >= default threshold 40)
    expect(mockShowWarningMessage).toHaveBeenCalled();
  });

  it('logs risk score and reasons when score is above threshold', async () => {
    const tracker = makeMockTracker();
    const store = makeMockGlobalDataStore(true);
    mockShowWarningMessage.mockResolvedValue('Ignore');

    const { scoreRegressionRisk } = require('../RegressionRiskScorer');
    (scoreRegressionRisk as jest.Mock).mockReturnValue({
      totalRiskScore: 60,
      reasons: [
        { category: 'diff', pattern: 'Removed await', points: 8 },
        { category: 'scope', pattern: 'Code changed but no test files touched', points: 12 },
      ],
      riskiestFiles: ['src/index.ts'],
    });

    const consoleSpy = jest.spyOn(console, 'log').mockImplementation();

    const service = new RegressionNotificationService(tracker as any, store as any);
    service.start();
    tracker.fire(dummyBurst);

    await new Promise(r => setTimeout(r, 0));

    expect(consoleSpy).toHaveBeenCalledWith(
      expect.stringContaining('[RegressionNotificationService] Risk score: 60/100'),
    );
    expect(consoleSpy).toHaveBeenCalledWith(
      expect.stringContaining('[diff] Removed await (+8)'),
    );
    expect(consoleSpy).toHaveBeenCalledWith(
      expect.stringContaining('Showing regression risk notification'),
    );
    consoleSpy.mockRestore();
  });

  it('logs risk score and skipping message when score is below threshold', async () => {
    const tracker = makeMockTracker();
    const store = makeMockGlobalDataStore(true);
    mockRiskThreshold = 'moderate'; // threshold 30

    const { scoreRegressionRisk } = require('../RegressionRiskScorer');
    (scoreRegressionRisk as jest.Mock).mockReturnValue({
      totalRiskScore: 5,
      reasons: [{ category: 'path', pattern: 'Lock file changed', points: 5 }],
      riskiestFiles: [],
    });

    const consoleSpy = jest.spyOn(console, 'log').mockImplementation();

    const service = new RegressionNotificationService(tracker as any, store as any);
    service.start();
    tracker.fire(dummyBurst);

    await new Promise(r => setTimeout(r, 0));

    expect(consoleSpy).toHaveBeenCalledWith(
      expect.stringContaining('[RegressionNotificationService] Risk score: 5/100'),
    );
    expect(consoleSpy).toHaveBeenCalledWith(
      expect.stringContaining('Score below threshold, skipping notification'),
    );
    expect(mockShowWarningMessage).not.toHaveBeenCalled();
    consoleSpy.mockRestore();
  });

  // --- Unified configuration tests ---

  it('proceeds when VS Code setting is enabled but GlobalDataStore is disabled', async () => {
    const tracker = makeMockTracker();
    const store = makeMockGlobalDataStore(false);
    mockVscodeEnabled = true;
    mockShowWarningMessage.mockResolvedValue('Ignore');

    const { scoreRegressionRisk } = require('../RegressionRiskScorer');
    (scoreRegressionRisk as jest.Mock).mockReturnValue({ totalRiskScore: 60, reasons: [], riskiestFiles: [] });

    const service = new RegressionNotificationService(
      tracker as any,
      store as any,
    );
    service.start();
    tracker.fire(dummyBurst);

    await new Promise(r => setTimeout(r, 0));

    // Should have shown the warning notification (not skipped)
    expect(mockShowWarningMessage).toHaveBeenCalled();
  });

  it('proceeds when GlobalDataStore is enabled but VS Code setting is disabled', async () => {
    const tracker = makeMockTracker();
    const store = makeMockGlobalDataStore(true);
    mockVscodeEnabled = false;
    mockShowWarningMessage.mockResolvedValue('Ignore');

    const { scoreRegressionRisk } = require('../RegressionRiskScorer');
    (scoreRegressionRisk as jest.Mock).mockReturnValue({ totalRiskScore: 60, reasons: [], riskiestFiles: [] });

    const service = new RegressionNotificationService(
      tracker as any,
      store as any,
    );
    service.start();
    tracker.fire(dummyBurst);

    await new Promise(r => setTimeout(r, 0));

    // Should have shown the warning notification (not skipped)
    expect(mockShowWarningMessage).toHaveBeenCalled();
  });

  it('proceeds when both settings are enabled', async () => {
    const tracker = makeMockTracker();
    const store = makeMockGlobalDataStore(true);
    mockVscodeEnabled = true;
    mockShowWarningMessage.mockResolvedValue('Ignore');

    const { scoreRegressionRisk } = require('../RegressionRiskScorer');
    (scoreRegressionRisk as jest.Mock).mockReturnValue({ totalRiskScore: 60, reasons: [], riskiestFiles: [] });

    const service = new RegressionNotificationService(
      tracker as any,
      store as any,
    );
    service.start();
    tracker.fire(dummyBurst);

    await new Promise(r => setTimeout(r, 0));

    // Should have shown the warning notification
    expect(mockShowWarningMessage).toHaveBeenCalled();
  });

  // --- Staleness fix tests ---

  it('includes capturedAt timestamp in DiffCaptureResult when user clicks Review', async () => {
    const tracker = makeMockTracker();
    const store = makeMockGlobalDataStore(true);
    mockShowWarningMessage.mockResolvedValue('Review Regression Risk');

    const { scoreRegressionRisk } = require('../RegressionRiskScorer');
    (scoreRegressionRisk as jest.Mock).mockReturnValue({
      totalRiskScore: 60,
      reasons: [],
      riskiestFiles: [],
    });

    const beforeTime = Date.now();

    const service = new RegressionNotificationService(tracker as any, store as any);
    service.start();
    tracker.fire(dummyBurst);

    await new Promise(r => setTimeout(r, 10));

    const afterTime = Date.now();

    expect(mockExecuteCommand).toHaveBeenCalledWith(
      'samurai-agent.startRegressionReview',
      expect.objectContaining({
        capturedAt: expect.any(Number),
      }),
      expect.anything(),
    );

    const diffResult = mockExecuteCommand.mock.calls[0][1];
    expect(diffResult.capturedAt).toBeGreaterThanOrEqual(beforeTime);
    expect(diffResult.capturedAt).toBeLessThanOrEqual(afterTime);
  });

  // --- Threshold setting tests ---

  it('shows notification when threshold is "always" (0) for any score > 0', async () => {
    const tracker = makeMockTracker();
    const store = makeMockGlobalDataStore(true);
    mockRiskThreshold = 'always';
    mockShowWarningMessage.mockResolvedValue('Ignore');

    const { scoreRegressionRisk } = require('../RegressionRiskScorer');
    (scoreRegressionRisk as jest.Mock).mockReturnValue({ totalRiskScore: 5, reasons: [], riskiestFiles: [] });

    const service = new RegressionNotificationService(tracker as any, store as any);
    service.start();
    tracker.fire(dummyBurst);

    await new Promise(r => setTimeout(r, 0));

    // Should show notification for score 5 >= threshold 0
    expect(mockShowWarningMessage).toHaveBeenCalled();
  });

  it('skips notification when threshold is "moderate" (30) for score < 30', async () => {
    const tracker = makeMockTracker();
    const store = makeMockGlobalDataStore(true);
    mockRiskThreshold = 'moderate';

    const { scoreRegressionRisk } = require('../RegressionRiskScorer');
    (scoreRegressionRisk as jest.Mock).mockReturnValue({ totalRiskScore: 25, reasons: [], riskiestFiles: [] });

    const consoleSpy = jest.spyOn(console, 'log').mockImplementation();

    const service = new RegressionNotificationService(tracker as any, store as any);
    service.start();
    tracker.fire(dummyBurst);

    await new Promise(r => setTimeout(r, 0));

    // Should skip notification for score 25 < threshold 30
    expect(mockShowWarningMessage).not.toHaveBeenCalled();
    expect(consoleSpy).toHaveBeenCalledWith(
      expect.stringContaining('Score below threshold, skipping notification'),
    );
    consoleSpy.mockRestore();
  });

  it('shows notification when threshold is "moderate" (30) for score >= 30', async () => {
    const tracker = makeMockTracker();
    const store = makeMockGlobalDataStore(true);
    mockRiskThreshold = 'moderate';
    mockShowWarningMessage.mockResolvedValue('Ignore');

    const { scoreRegressionRisk } = require('../RegressionRiskScorer');
    (scoreRegressionRisk as jest.Mock).mockReturnValue({ totalRiskScore: 35, reasons: [], riskiestFiles: [] });

    const service = new RegressionNotificationService(tracker as any, store as any);
    service.start();
    tracker.fire(dummyBurst);

    await new Promise(r => setTimeout(r, 0));

    // Should show notification for score 35 >= threshold 30
    expect(mockShowWarningMessage).toHaveBeenCalled();
  });

  it('skips notification when threshold is "high" (70) for score < 70', async () => {
    const tracker = makeMockTracker();
    const store = makeMockGlobalDataStore(true);
    mockRiskThreshold = 'high';

    const { scoreRegressionRisk } = require('../RegressionRiskScorer');
    (scoreRegressionRisk as jest.Mock).mockReturnValue({ totalRiskScore: 60, reasons: [], riskiestFiles: [] });

    const consoleSpy = jest.spyOn(console, 'log').mockImplementation();

    const service = new RegressionNotificationService(tracker as any, store as any);
    service.start();
    tracker.fire(dummyBurst);

    await new Promise(r => setTimeout(r, 0));

    // Should skip notification for score 60 < threshold 70
    expect(mockShowWarningMessage).not.toHaveBeenCalled();
    expect(consoleSpy).toHaveBeenCalledWith(
      expect.stringContaining('Score below threshold, skipping notification'),
    );
    consoleSpy.mockRestore();
  });

  it('shows notification when threshold is "high" (70) for score >= 70', async () => {
    const tracker = makeMockTracker();
    const store = makeMockGlobalDataStore(true);
    mockRiskThreshold = 'high';
    mockShowWarningMessage.mockResolvedValue('Ignore');

    const { scoreRegressionRisk } = require('../RegressionRiskScorer');
    (scoreRegressionRisk as jest.Mock).mockReturnValue({ totalRiskScore: 75, reasons: [], riskiestFiles: [] });

    const service = new RegressionNotificationService(tracker as any, store as any);
    service.start();
    tracker.fire(dummyBurst);

    await new Promise(r => setTimeout(r, 0));

    // Should show notification for score 75 >= threshold 70
    expect(mockShowWarningMessage).toHaveBeenCalled();
  });

  // --- Legacy threshold migration tests ---

  it('supports legacy numeric threshold values', async () => {
    const tracker = makeMockTracker();
    const store = makeMockGlobalDataStore(true);
    mockRiskThreshold = 50 as any; // Legacy numeric value
    mockShowWarningMessage.mockResolvedValue('Ignore');

    const { scoreRegressionRisk } = require('../RegressionRiskScorer');
    (scoreRegressionRisk as jest.Mock).mockReturnValue({ totalRiskScore: 40, reasons: [], riskiestFiles: [] });

    const consoleSpy = jest.spyOn(console, 'log').mockImplementation();

    const service = new RegressionNotificationService(tracker as any, store as any);
    service.start();
    tracker.fire(dummyBurst);

    await new Promise(r => setTimeout(r, 0));

    // Score 40 < legacy threshold 50, should skip
    expect(mockShowWarningMessage).not.toHaveBeenCalled();
    expect(consoleSpy).toHaveBeenCalledWith(
      expect.stringContaining('Score below threshold, skipping notification'),
    );
    consoleSpy.mockRestore();
  });

  it('shows notification when score meets legacy numeric threshold', async () => {
    const tracker = makeMockTracker();
    const store = makeMockGlobalDataStore(true);
    mockRiskThreshold = 50 as any; // Legacy numeric value
    mockShowWarningMessage.mockResolvedValue('Ignore');

    const { scoreRegressionRisk } = require('../RegressionRiskScorer');
    (scoreRegressionRisk as jest.Mock).mockReturnValue({ totalRiskScore: 60, reasons: [], riskiestFiles: [] });

    const service = new RegressionNotificationService(tracker as any, store as any);
    service.start();
    tracker.fire(dummyBurst);

    await new Promise(r => setTimeout(r, 0));

    // Score 60 >= legacy threshold 50, should show notification
    expect(mockShowWarningMessage).toHaveBeenCalled();
  });

  // --- Plan context passthrough tests ---

  it('passes planContext through to DiffCaptureResult when plan is discovered', async () => {
    const tracker = makeMockTracker();
    const store = makeMockGlobalDataStore(true);
    mockShowWarningMessage.mockResolvedValue('Review Regression Risk');

    const { scoreRegressionRisk } = require('../RegressionRiskScorer');
    (scoreRegressionRisk as jest.Mock).mockReturnValue({
      totalRiskScore: 60,
      reasons: [],
      riskiestFiles: [],
    });

    const mockPlan = {
      sourcePath: '.cursor/plans/fix.plan.md',
      toolName: 'cursor',
      content: '# Fix auth bug',
      truncated: false,
      modifiedAt: new Date().toISOString(),
      confidence: 'high',
    };
    mockDiscoverRecentPlanFile.mockResolvedValue(mockPlan);

    const service = new RegressionNotificationService(tracker as any, store as any);
    service.start();
    tracker.fire(dummyBurst);

    await new Promise(r => setTimeout(r, 10));

    expect(mockExecuteCommand).toHaveBeenCalledWith(
      'samurai-agent.startRegressionReview',
      expect.objectContaining({
        planContext: mockPlan,
      }),
      expect.anything(),
    );
  });

  it('passes undefined planContext when no plan is discovered', async () => {
    const tracker = makeMockTracker();
    const store = makeMockGlobalDataStore(true);
    mockShowWarningMessage.mockResolvedValue('Review Regression Risk');

    const { scoreRegressionRisk } = require('../RegressionRiskScorer');
    (scoreRegressionRisk as jest.Mock).mockReturnValue({
      totalRiskScore: 60,
      reasons: [],
      riskiestFiles: [],
    });

    mockDiscoverRecentPlanFile.mockResolvedValue(undefined);

    const service = new RegressionNotificationService(tracker as any, store as any);
    service.start();
    tracker.fire(dummyBurst);

    await new Promise(r => setTimeout(r, 10));

    expect(mockExecuteCommand).toHaveBeenCalledWith(
      'samurai-agent.startRegressionReview',
      expect.objectContaining({
        planContext: undefined,
      }),
      expect.anything(),
    );
  });

  // --- getRiskLevel tests ---

  describe('getRiskLevel', () => {
    it.each([
      [0, 'Review Recommended'],
      [1, 'Review Recommended'],
      [19, 'Review Recommended'],
      [20, 'Potential Risk Detected'],
      [49, 'Potential Risk Detected'],
      [50, 'Elevated Risk'],
      [74, 'Elevated Risk'],
      [75, 'High Risk'],
      [100, 'High Risk'],
    ])('returns correct label for score %i', (score, expected) => {
      expect(getRiskLevel(score)).toBe(expected);
    });
  });

  // --- Notification message tests ---

  it('notification message contains risk level label instead of numeric score', async () => {
    const tracker = makeMockTracker();
    const store = makeMockGlobalDataStore(true);
    mockShowWarningMessage.mockResolvedValue('Ignore');

    const { scoreRegressionRisk } = require('../RegressionRiskScorer');
    (scoreRegressionRisk as jest.Mock).mockReturnValue({ totalRiskScore: 25, reasons: [], riskiestFiles: [] });

    const service = new RegressionNotificationService(tracker as any, store as any);
    service.start();
    tracker.fire(dummyBurst);

    await new Promise(r => setTimeout(r, 10));

    expect(mockShowWarningMessage).toHaveBeenCalledWith(
      'Samurai Agent: AI code changes detected — Potential Risk Detected',
      'Review Regression Risk',
      'Ignore',
    );
  });
});
