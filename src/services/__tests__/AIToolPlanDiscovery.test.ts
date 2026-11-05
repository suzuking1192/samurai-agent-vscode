import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as vscode from 'vscode';
import { discoverRecentPlanFile, PlanFileContext } from '../AIToolPlanDiscovery';

// We'll use a real temp directory for test isolation
let tmpDir: string;
let repoRoot: string;
let homeDir: string;

// Mock os.homedir() to use our temp directory
jest.mock('os', () => {
  const actual = jest.requireActual('os');
  return {
    ...actual,
    homedir: jest.fn(() => homeDir),
  };
});

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'plan-discovery-test-'));
  repoRoot = path.join(tmpDir, 'repo');
  homeDir = path.join(tmpDir, 'home');
  fs.mkdirSync(repoRoot, { recursive: true });
  fs.mkdirSync(homeDir, { recursive: true });
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function setFileMtime(filePath: string, mtime: Date): void {
  fs.utimesSync(filePath, mtime, mtime);
}

describe('AIToolPlanDiscovery', () => {
  describe('Cursor plans', () => {
    it('finds a Cursor plan within 24h', async () => {
      const plansDir = path.join(repoRoot, '.cursor', 'plans');
      fs.mkdirSync(plansDir, { recursive: true });
      const planFile = path.join(plansDir, 'refactor.plan.md');
      fs.writeFileSync(planFile, '# Refactor auth module\nUpdate login.ts to use JWT');
      setFileMtime(planFile, new Date()); // recent

      const result = await discoverRecentPlanFile(
        repoRoot,
        Date.now(),
        ['src/login.ts'],
      );

      expect(result).toBeDefined();
      expect(result!.toolName).toBe('cursor');
      expect(result!.content).toContain('Refactor auth module');
    });

    it('returns undefined when plan is older than 24h', async () => {
      const plansDir = path.join(repoRoot, '.cursor', 'plans');
      fs.mkdirSync(plansDir, { recursive: true });
      const planFile = path.join(plansDir, 'old.plan.md');
      fs.writeFileSync(planFile, '# Old plan');
      setFileMtime(planFile, new Date(Date.now() - 25 * 60 * 60 * 1000)); // 25h ago

      const result = await discoverRecentPlanFile(
        repoRoot,
        Date.now(),
        ['src/index.ts'],
      );

      expect(result).toBeUndefined();
    });

    it('finds a Cursor plan from global ~/.cursor/plans/', async () => {
      const globalPlansDir = path.join(homeDir, '.cursor', 'plans');
      fs.mkdirSync(globalPlansDir, { recursive: true });
      const planFile = path.join(globalPlansDir, 'global-refactor_abc123.plan.md');
      fs.writeFileSync(planFile, '# Global Cursor plan\nRefactor api.ts for better error handling');
      setFileMtime(planFile, new Date());

      const result = await discoverRecentPlanFile(
        repoRoot,
        Date.now(),
        ['src/api.ts'],
      );

      expect(result).toBeDefined();
      expect(result!.toolName).toBe('cursor');
      expect(result!.content).toContain('Global Cursor plan');
    });

    it('prefers global Cursor plan that mentions changed files over local plan that does not', async () => {
      // Local plan: no file mention
      const localPlansDir = path.join(repoRoot, '.cursor', 'plans');
      fs.mkdirSync(localPlansDir, { recursive: true });
      const localPlan = path.join(localPlansDir, 'local.plan.md');
      fs.writeFileSync(localPlan, '# Local plan about unrelated docs');
      setFileMtime(localPlan, new Date());

      // Global plan: mentions the changed file
      const globalPlansDir = path.join(homeDir, '.cursor', 'plans');
      fs.mkdirSync(globalPlansDir, { recursive: true });
      const globalPlan = path.join(globalPlansDir, 'global_abc.plan.md');
      fs.writeFileSync(globalPlan, '# Global plan\nFix validation in handler.ts');
      setFileMtime(globalPlan, new Date());

      const result = await discoverRecentPlanFile(
        repoRoot,
        Date.now(),
        ['src/handler.ts'],
      );

      expect(result).toBeDefined();
      expect(result!.content).toContain('handler.ts');
    });

    it('ignores global Cursor plans older than 24h', async () => {
      const globalPlansDir = path.join(homeDir, '.cursor', 'plans');
      fs.mkdirSync(globalPlansDir, { recursive: true });
      const planFile = path.join(globalPlansDir, 'stale_xyz.plan.md');
      fs.writeFileSync(planFile, '# Stale global plan');
      setFileMtime(planFile, new Date(Date.now() - 25 * 60 * 60 * 1000)); // 25h ago

      const result = await discoverRecentPlanFile(
        repoRoot,
        Date.now(),
        ['src/index.ts'],
      );

      expect(result).toBeUndefined();
    });

    it('finds Cursor plan under workspace root when repo root has no .cursor/plans', async () => {
      // Simulate monorepo: repoRoot is git root, workspace is a subfolder with its own .cursor/plans
      const workspaceRoot = path.join(repoRoot, 'packages', 'app');
      fs.mkdirSync(workspaceRoot, { recursive: true });
      const plansDir = path.join(workspaceRoot, '.cursor', 'plans');
      fs.mkdirSync(plansDir, { recursive: true });
      const planFile = path.join(plansDir, 'monorepo.plan.md');
      fs.writeFileSync(planFile, '# Monorepo app plan for dashboard.ts');
      setFileMtime(planFile, new Date());

      const result = await discoverRecentPlanFile(
        repoRoot,
        Date.now(),
        ['packages/app/src/dashboard.ts'],
        { workspaceRoots: [workspaceRoot] },
      );

      expect(result).toBeDefined();
      expect(result!.toolName).toBe('cursor');
      expect(result!.content).toContain('Monorepo app plan');
    });
  });

  describe('Windsurf plans', () => {
    it('finds a Windsurf workflow within 24h', async () => {
      const workflowsDir = path.join(repoRoot, '.windsurf', 'workflows');
      fs.mkdirSync(workflowsDir, { recursive: true });
      const planFile = path.join(workflowsDir, 'add-feature.md');
      fs.writeFileSync(planFile, '# Add dark mode\nModify theme.ts');
      setFileMtime(planFile, new Date());

      const result = await discoverRecentPlanFile(
        repoRoot,
        Date.now(),
        ['src/theme.ts'],
      );

      expect(result).toBeDefined();
      expect(result!.toolName).toBe('windsurf');
      expect(result!.content).toContain('Add dark mode');
    });
  });

  describe('Antigravity plans', () => {
    it('finds a workflow in <repoRoot>/.agent/workflows/', async () => {
      const workflowsDir = path.join(repoRoot, '.agent', 'workflows');
      fs.mkdirSync(workflowsDir, { recursive: true });
      const planFile = path.join(workflowsDir, 'migrate-db.md');
      fs.writeFileSync(planFile, '# Migrate database\nUpdate schema.ts for new columns');
      setFileMtime(planFile, new Date());

      const result = await discoverRecentPlanFile(
        repoRoot,
        Date.now(),
        ['src/schema.ts'],
      );

      expect(result).toBeDefined();
      expect(result!.toolName).toBe('antigravity');
      expect(result!.content).toContain('Migrate database');
    });

    it('finds a workflow in global ~/.gemini/antigravity/global_workflows/', async () => {
      const globalDir = path.join(homeDir, '.gemini', 'antigravity', 'global_workflows');
      fs.mkdirSync(globalDir, { recursive: true });
      const planFile = path.join(globalDir, 'global-task.md');
      fs.writeFileSync(planFile, '# Global Antigravity workflow\nRefactor routes.ts');
      setFileMtime(planFile, new Date());

      const result = await discoverRecentPlanFile(
        repoRoot,
        Date.now(),
        ['src/routes.ts'],
      );

      expect(result).toBeDefined();
      expect(result!.toolName).toBe('antigravity');
      expect(result!.content).toContain('Global Antigravity workflow');
    });

    it('ignores workflows older than 24h', async () => {
      const workflowsDir = path.join(repoRoot, '.agent', 'workflows');
      fs.mkdirSync(workflowsDir, { recursive: true });
      const planFile = path.join(workflowsDir, 'old-task.md');
      fs.writeFileSync(planFile, '# Old Antigravity workflow');
      setFileMtime(planFile, new Date(Date.now() - 25 * 60 * 60 * 1000)); // 25h ago

      const result = await discoverRecentPlanFile(
        repoRoot,
        Date.now(),
        ['src/index.ts'],
      );

      expect(result).toBeUndefined();
    });

    it('prefers Antigravity plan when in Antigravity IDE', async () => {
      // Create an Antigravity workflow
      const workflowsDir = path.join(repoRoot, '.agent', 'workflows');
      fs.mkdirSync(workflowsDir, { recursive: true });
      const agPlan = path.join(workflowsDir, 'ag-task.md');
      fs.writeFileSync(agPlan, '# Antigravity plan for config.ts');
      setFileMtime(agPlan, new Date());

      // Create a Cursor plan
      const plansDir = path.join(repoRoot, '.cursor', 'plans');
      fs.mkdirSync(plansDir, { recursive: true });
      const cursorPlan = path.join(plansDir, 'cursor.plan.md');
      fs.writeFileSync(cursorPlan, '# Cursor plan for config.ts');
      setFileMtime(cursorPlan, new Date());

      const originalAppName = vscode.env.appName;
      try {
        (vscode.env as { appName: string }).appName = 'Google Antigravity';
        const result = await discoverRecentPlanFile(
          repoRoot,
          Date.now(),
          ['src/config.ts'],
        );
        expect(result).toBeDefined();
        expect(result!.toolName).toBe('antigravity');
      } finally {
        (vscode.env as { appName: string }).appName = originalAppName;
      }
    });
  });

  describe('scoring', () => {
    it('scores by proximity to burst time, not just raw recency', async () => {
      const plansDir = path.join(repoRoot, '.cursor', 'plans');
      fs.mkdirSync(plansDir, { recursive: true });

      const now = Date.now();
      const burstTime = now - 60_000; // 1 minute ago

      // Plan A: more recent but farther from burst
      const planA = path.join(plansDir, 'a.plan.md');
      fs.writeFileSync(planA, '# Plan A - not related');
      setFileMtime(planA, new Date(now - 1000)); // 1s ago (far from burst)

      // Plan B: older but closer to burst time
      const planB = path.join(plansDir, 'b.plan.md');
      fs.writeFileSync(planB, '# Plan B - burst aligned');
      setFileMtime(planB, new Date(burstTime)); // exactly at burst time

      const result = await discoverRecentPlanFile(
        repoRoot,
        burstTime,
        ['src/unrelated.ts'],
      );

      expect(result).toBeDefined();
      // Plan B should win because it's closer to burst time
      expect(result!.content).toContain('Plan B');
    });

    it('sets confidence high when plan mentions changed filenames', async () => {
      const plansDir = path.join(repoRoot, '.cursor', 'plans');
      fs.mkdirSync(plansDir, { recursive: true });
      const planFile = path.join(plansDir, 'fix.plan.md');
      fs.writeFileSync(planFile, '# Fix bug in auth.ts\nUpdate the login flow in auth.ts');
      setFileMtime(planFile, new Date());

      const result = await discoverRecentPlanFile(
        repoRoot,
        Date.now(),
        ['src/auth.ts'],
      );

      expect(result).toBeDefined();
      expect(result!.confidence).toBe('high');
    });

    it('sets confidence low when no file match', async () => {
      const plansDir = path.join(repoRoot, '.cursor', 'plans');
      fs.mkdirSync(plansDir, { recursive: true });
      const planFile = path.join(plansDir, 'docs.plan.md');
      fs.writeFileSync(planFile, '# Update documentation for API endpoints');
      setFileMtime(planFile, new Date());

      const result = await discoverRecentPlanFile(
        repoRoot,
        Date.now(),
        ['src/server.ts'],
      );

      expect(result).toBeDefined();
      expect(result!.confidence).toBe('low');
    });

    it('prefers plan that mentions changed files over closer-in-time plan', async () => {
      const plansDir = path.join(repoRoot, '.cursor', 'plans');
      fs.mkdirSync(plansDir, { recursive: true });

      const now = Date.now();

      // Plan A: closer to burst but doesn't mention files
      const planA = path.join(plansDir, 'a.plan.md');
      fs.writeFileSync(planA, '# Unrelated documentation update');
      setFileMtime(planA, new Date(now - 100));

      // Plan B: slightly farther but mentions the changed file (bonus of 1000 overcomes the 400ms gap)
      const planB = path.join(plansDir, 'b.plan.md');
      fs.writeFileSync(planB, '# Fix the bug in utils.ts');
      setFileMtime(planB, new Date(now - 500));

      const result = await discoverRecentPlanFile(
        repoRoot,
        now,
        ['src/utils.ts'],
      );

      expect(result).toBeDefined();
      expect(result!.content).toContain('utils.ts');
      expect(result!.confidence).toBe('high');
    });

    it('prefers Cursor plan when in Cursor IDE and both Cursor and Claude Code have plans', async () => {
      const plansDir = path.join(repoRoot, '.cursor', 'plans');
      fs.mkdirSync(plansDir, { recursive: true });
      const cursorPlan = path.join(plansDir, 'cursor.plan.md');
      fs.writeFileSync(cursorPlan, '# Cursor plan for auth.ts refactor');
      setFileMtime(cursorPlan, new Date());

      const encoded = repoRoot.replace(/\//g, '-');
      const projectDir = path.join(homeDir, '.claude', 'projects', encoded);
      fs.mkdirSync(projectDir, { recursive: true });
      const jsonlPath = path.join(projectDir, 'session.jsonl');
      fs.writeFileSync(jsonlPath, JSON.stringify({ type: 'user', message: 'Claude plan for auth.ts and login flow' }) + '\n');
      setFileMtime(jsonlPath, new Date());

      const originalAppName = vscode.env.appName;
      try {
        (vscode.env as { appName: string }).appName = 'Cursor';
        const result = await discoverRecentPlanFile(
          repoRoot,
          Date.now(),
          ['src/auth.ts'],
        );
        expect(result).toBeDefined();
        expect(result!.toolName).toBe('cursor');
        expect(result!.content).toContain('Cursor plan');
      } finally {
        (vscode.env as { appName: string }).appName = originalAppName;
      }
    });
  });

  describe('Claude Code CLI', () => {
    it('finds plan via slug in JSONL', async () => {
      // Set up project dir with exact encoding
      const encoded = repoRoot.replace(/\//g, '-');
      const projectDir = path.join(homeDir, '.claude', 'projects', encoded);
      fs.mkdirSync(projectDir, { recursive: true });

      // Create JSONL with slug reference
      const jsonlPath = path.join(projectDir, 'session.jsonl');
      const jsonlContent = [
        JSON.stringify({ type: 'system', slug: 'my-plan-slug' }),
        JSON.stringify({ type: 'user', message: 'implement the plan' }),
      ].join('\n');
      fs.writeFileSync(jsonlPath, jsonlContent);
      setFileMtime(jsonlPath, new Date());

      // Create the plan file
      const plansDir = path.join(homeDir, '.claude', 'plans');
      fs.mkdirSync(plansDir, { recursive: true });
      const planFile = path.join(plansDir, 'my-plan-slug.md');
      fs.writeFileSync(planFile, '# My plan for refactoring auth.ts');
      setFileMtime(planFile, new Date());

      const result = await discoverRecentPlanFile(
        repoRoot,
        Date.now(),
        ['src/auth.ts'],
      );

      expect(result).toBeDefined();
      expect(result!.toolName).toBe('claude-code');
      expect(result!.content).toContain('refactoring auth.ts');
    });

    it('falls back to user messages when no slug', async () => {
      const encoded = repoRoot.replace(/\//g, '-');
      const projectDir = path.join(homeDir, '.claude', 'projects', encoded);
      fs.mkdirSync(projectDir, { recursive: true });

      const jsonlPath = path.join(projectDir, 'session.jsonl');
      const jsonlContent = [
        JSON.stringify({ type: 'user', message: 'Please add error handling to the parser module with proper types' }),
        JSON.stringify({ type: 'assistant', message: 'I will add error handling.' }),
        JSON.stringify({ type: 'user', message: 'Also update the tests for parser.ts to cover edge cases fully' }),
      ].join('\n');
      fs.writeFileSync(jsonlPath, jsonlContent);
      setFileMtime(jsonlPath, new Date());

      const result = await discoverRecentPlanFile(
        repoRoot,
        Date.now(),
        ['src/parser.ts'],
      );

      expect(result).toBeDefined();
      expect(result!.toolName).toBe('claude-code');
      expect(result!.content).toContain('error handling');
      expect(result!.content).toContain('parser.ts');
    });

    it('tolerates path encoding variations (basename match)', async () => {
      // Use a different encoding than exact
      const projectDir = path.join(homeDir, '.claude', 'projects', 'some-prefix-repo');
      fs.mkdirSync(projectDir, { recursive: true });

      // repoRoot basename is "repo" which matches "some-prefix-repo"
      const jsonlPath = path.join(projectDir, 'session.jsonl');
      fs.writeFileSync(jsonlPath, JSON.stringify({ type: 'user', message: 'Implement the new feature for the login page with validation' }) + '\n');
      setFileMtime(jsonlPath, new Date());

      const result = await discoverRecentPlanFile(
        repoRoot,
        Date.now(),
        ['src/login.ts'],
      );

      expect(result).toBeDefined();
      expect(result!.toolName).toBe('claude-code');
      expect(result!.content).toContain('login page');
    });

    it('filters out meta messages and short messages', async () => {
      const encoded = repoRoot.replace(/\//g, '-');
      const projectDir = path.join(homeDir, '.claude', 'projects', encoded);
      fs.mkdirSync(projectDir, { recursive: true });

      const jsonlPath = path.join(projectDir, 'session.jsonl');
      const jsonlContent = [
        JSON.stringify({ type: 'user', isMeta: true, message: 'system init message that should be filtered out' }),
        JSON.stringify({ type: 'user', message: 'short' }), // too short (< 20 chars)
        JSON.stringify({ type: 'user', message: '<command-name>some command that should be filtered out' }),
        JSON.stringify({ type: 'user', message: 'Please refactor the authentication service to use dependency injection properly' }),
      ].join('\n');
      fs.writeFileSync(jsonlPath, jsonlContent);
      setFileMtime(jsonlPath, new Date());

      const result = await discoverRecentPlanFile(
        repoRoot,
        Date.now(),
        ['src/auth.ts'],
      );

      expect(result).toBeDefined();
      expect(result!.content).toContain('refactor the authentication');
      expect(result!.content).not.toContain('system init');
      expect(result!.content).not.toContain('<command-name>');
    });
  });

  describe('truncation', () => {
    it('truncates content exceeding 8,000 chars', async () => {
      const plansDir = path.join(repoRoot, '.cursor', 'plans');
      fs.mkdirSync(plansDir, { recursive: true });
      const planFile = path.join(plansDir, 'big.plan.md');
      const longContent = '# Big plan\n' + 'x'.repeat(10_000);
      fs.writeFileSync(planFile, longContent);
      setFileMtime(planFile, new Date());

      const result = await discoverRecentPlanFile(
        repoRoot,
        Date.now(),
        ['src/index.ts'],
      );

      expect(result).toBeDefined();
      expect(result!.truncated).toBe(true);
      expect(result!.content.length).toBe(8_000);
    });

    it('sets truncated to false for small content', async () => {
      const plansDir = path.join(repoRoot, '.cursor', 'plans');
      fs.mkdirSync(plansDir, { recursive: true });
      const planFile = path.join(plansDir, 'small.plan.md');
      fs.writeFileSync(planFile, '# Small plan\nJust a few lines.');
      setFileMtime(planFile, new Date());

      const result = await discoverRecentPlanFile(
        repoRoot,
        Date.now(),
        ['src/index.ts'],
      );

      expect(result).toBeDefined();
      expect(result!.truncated).toBe(false);
    });
  });

  describe('edge cases', () => {
    it('returns undefined when no plan dirs exist', async () => {
      const result = await discoverRecentPlanFile(
        repoRoot,
        Date.now(),
        ['src/index.ts'],
      );

      expect(result).toBeUndefined();
    });

    it('handles filesystem errors gracefully', async () => {
      // Create a plan dir with a file that can't be read
      const plansDir = path.join(repoRoot, '.cursor', 'plans');
      fs.mkdirSync(plansDir, { recursive: true });
      const planFile = path.join(plansDir, 'unreadable.plan.md');
      fs.writeFileSync(planFile, '# Test');
      fs.chmodSync(planFile, 0o000);

      // Should not throw
      const result = await discoverRecentPlanFile(
        repoRoot,
        Date.now(),
        ['src/index.ts'],
      );

      // May or may not find the file (depends on OS), but should not throw
      expect(true).toBe(true);

      // Restore permissions for cleanup
      fs.chmodSync(planFile, 0o644);
    });

    it('returns undefined when all candidates have empty content', async () => {
      const plansDir = path.join(repoRoot, '.cursor', 'plans');
      fs.mkdirSync(plansDir, { recursive: true });
      const planFile = path.join(plansDir, 'empty.plan.md');
      fs.writeFileSync(planFile, '');
      setFileMtime(planFile, new Date());

      const result = await discoverRecentPlanFile(
        repoRoot,
        Date.now(),
        ['src/index.ts'],
      );

      expect(result).toBeUndefined();
    });
  });
});
