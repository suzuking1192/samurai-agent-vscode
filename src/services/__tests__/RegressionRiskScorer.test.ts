import { scoreRegressionRisk, parseHunks } from '../RegressionRiskScorer';

describe('RegressionRiskScorer', () => {
  // --- Empty / minimal inputs ---
  it('returns 0 for empty input', () => {
    const result = scoreRegressionRisk('', []);
    expect(result.totalRiskScore).toBe(0);
    expect(result.reasons).toHaveLength(0);
    expect(result.riskiestFiles).toHaveLength(0);
  });

  it('returns 0 for diff with no risky patterns', () => {
    const diff = `+  const x = 1;
+  const y = 2;`;
    // Only non-code files
    const result = scoreRegressionRisk(diff, []);
    expect(result.totalRiskScore).toBe(0);
  });

  // --- Hunk parser tests ---
  describe('parseHunks', () => {
    it('parses hunks split by @@ headers', () => {
      const diff = `@@ -1,3 +1,3 @@
- old line
+ new line
  context line
@@ -10,3 +10,3 @@
- another old
+ another new`;
      const hunks = parseHunks(diff);
      expect(hunks).toHaveLength(2);
      expect(hunks[0].addedLines).toEqual(['+ new line']);
      expect(hunks[0].removedLines).toEqual(['- old line']);
      expect(hunks[0].contextLines).toEqual(['  context line']);
      expect(hunks[1].addedLines).toEqual(['+ another new']);
      expect(hunks[1].removedLines).toEqual(['- another old']);
    });

    it('treats entire diff as one hunk when no @@ headers', () => {
      const diff = `+ added line
- removed line
  context`;
      const hunks = parseHunks(diff);
      expect(hunks).toHaveLength(1);
      expect(hunks[0].addedLines).toEqual(['+ added line']);
      expect(hunks[0].removedLines).toEqual(['- removed line']);
      expect(hunks[0].contextLines).toEqual(['  context']);
    });

    it('excludes --- and +++ lines from added/removed', () => {
      const diff = `--- a/file.ts
+++ b/file.ts
@@ -1,3 +1,3 @@
- old
+ new`;
      const hunks = parseHunks(diff);
      expect(hunks).toHaveLength(1);
      expect(hunks[0].removedLines).toEqual(['- old']);
      expect(hunks[0].addedLines).toEqual(['+ new']);
    });

    it('handles empty diff', () => {
      const hunks = parseHunks('');
      expect(hunks).toHaveLength(1);
      expect(hunks[0].addedLines).toHaveLength(0);
    });
  });

  // --- Path-based scoring ---
  describe('path-based scoring', () => {
    it('detects lock files', () => {
      const result = scoreRegressionRisk('', ['package-lock.json']);
      expect(result.reasons.some(r => r.pattern === 'Lock file changed')).toBe(true);
      expect(result.reasons.find(r => r.pattern === 'Lock file changed')!.points).toBe(5);
    });

    it('detects yarn.lock', () => {
      const result = scoreRegressionRisk('', ['yarn.lock']);
      expect(result.reasons.some(r => r.pattern === 'Lock file changed')).toBe(true);
    });

    it('detects pnpm-lock.yaml', () => {
      const result = scoreRegressionRisk('', ['pnpm-lock.yaml']);
      expect(result.reasons.some(r => r.pattern === 'Lock file changed')).toBe(true);
    });

    it('only counts lock files once even if multiple', () => {
      const result = scoreRegressionRisk('', ['package-lock.json', 'yarn.lock']);
      const lockReasons = result.reasons.filter(r => r.pattern === 'Lock file changed');
      expect(lockReasons).toHaveLength(1);
    });

    it('detects package.json with dependency section changes', () => {
      const diff = `+  "dependencies": {`;
      const result = scoreRegressionRisk(diff, ['package.json']);
      expect(result.reasons.some(r => r.pattern.includes('dependency'))).toBe(true);
    });

    it('detects package.json with devDependencies changes', () => {
      const diff = `-  "devDependencies": {`;
      const result = scoreRegressionRisk(diff, ['package.json']);
      expect(result.reasons.some(r => r.pattern.includes('dependency'))).toBe(true);
    });

    it('detects package.json with version string changes', () => {
      const diff = `+  "lodash": "^4.17.21"`;
      const result = scoreRegressionRisk(diff, ['package.json']);
      expect(result.reasons.some(r => r.pattern.includes('dependency'))).toBe(true);
    });

    it('does NOT flag package.json without dependency changes', () => {
      const diff = `+  "name": "my-app"`;
      const result = scoreRegressionRisk(diff, ['package.json']);
      expect(result.reasons.every(r => !r.pattern.includes('dependency'))).toBe(true);
    });

    it('detects config file changes', () => {
      const result = scoreRegressionRisk('', ['tsconfig.json', 'webpack.config.js']);
      expect(result.totalRiskScore).toBeGreaterThanOrEqual(16);
      expect(result.reasons.filter(r => r.pattern.includes('Config file'))).toHaveLength(2);
    });

    it('caps config file scoring at 2 files (max 16 points)', () => {
      const result = scoreRegressionRisk('', [
        'tsconfig.json', 'webpack.config.js', 'vite.config.ts', '.env.local', 'babel.config.js',
      ]);
      const configReasons = result.reasons.filter(r => r.pattern.includes('Config file'));
      expect(configReasons).toHaveLength(2);
      expect(configReasons.reduce((s, r) => s + r.points, 0)).toBe(16);
    });

    it('detects .env files', () => {
      const result = scoreRegressionRisk('', ['.env.production']);
      expect(result.reasons.some(r => r.pattern.includes('.env'))).toBe(true);
    });

    it('detects CI/Docker files', () => {
      const result = scoreRegressionRisk('', ['.github/workflows/deploy.yml']);
      expect(result.reasons.some(r => r.pattern === 'CI/Docker file changed')).toBe(true);
    });

    it('detects Dockerfile', () => {
      const result = scoreRegressionRisk('', ['Dockerfile']);
      expect(result.reasons.some(r => r.pattern === 'CI/Docker file changed')).toBe(true);
    });

    it('detects CI files with Windows path separators', () => {
      const result = scoreRegressionRisk('', ['.github\\workflows\\deploy.yml']);
      expect(result.reasons.some(r => r.pattern === 'CI/Docker file changed')).toBe(true);
    });
  });

  // --- Diff pattern scoring ---
  describe('diff pattern scoring', () => {
    it('detects removed try/catch', () => {
      const diff = `-  try {\n-    doSomething();\n-  catch (e) {`;
      const result = scoreRegressionRisk(diff, ['src/foo.ts']);
      expect(result.reasons.some(r => r.pattern === 'Removed try/catch')).toBe(true);
    });

    it('detects removed try with different indentation', () => {
      const diff = `-try {`;
      const result = scoreRegressionRisk(diff, ['src/foo.ts']);
      expect(result.reasons.some(r => r.pattern === 'Removed try/catch')).toBe(true);
    });

    it('does NOT flag added try/catch', () => {
      const diff = `+  try {\n+    doSomething();\n+  catch (e) {`;
      const result = scoreRegressionRisk(diff, ['src/foo.ts']);
      expect(result.reasons.every(r => r.pattern !== 'Removed try/catch')).toBe(true);
    });

    it('detects removed await', () => {
      const diff = `-  const data = await fetchData();`;
      const result = scoreRegressionRisk(diff, ['src/api.ts']);
      expect(result.reasons.some(r => r.pattern === 'Removed await')).toBe(true);
    });

    it('does NOT flag added await', () => {
      const diff = `+  const data = await fetchData();`;
      const result = scoreRegressionRisk(diff, ['src/api.ts']);
      expect(result.reasons.every(r => r.pattern !== 'Removed await')).toBe(true);
    });

    it('detects changed exports (added)', () => {
      const diff = `+export function newHelper() {}`;
      const result = scoreRegressionRisk(diff, ['src/utils.ts']);
      expect(result.reasons.some(r => r.pattern === 'Changed exports')).toBe(true);
    });

    it('detects changed exports (removed)', () => {
      const diff = `-export function oldHelper() {}`;
      const result = scoreRegressionRisk(diff, ['src/utils.ts']);
      expect(result.reasons.some(r => r.pattern === 'Changed exports')).toBe(true);
    });

    it('detects API boundary changes with fetch', () => {
      const diff = `+  const res = fetch('/api/users');`;
      const result = scoreRegressionRisk(diff, ['src/api.ts']);
      expect(result.reasons.some(r => r.pattern === 'API boundary changes')).toBe(true);
    });

    it('detects API boundary changes with axios', () => {
      const diff = `-  const res = axios.get('/api');`;
      const result = scoreRegressionRisk(diff, ['src/api.ts']);
      expect(result.reasons.some(r => r.pattern === 'API boundary changes')).toBe(true);
    });

    it('detects removed .catch() error handler', () => {
      const diff = `-  promise.catch(err => console.error(err));`;
      const result = scoreRegressionRisk(diff, ['src/api.ts']);
      expect(result.reasons.some(r => r.pattern === 'Removed error handler')).toBe(true);
    });

    it('detects removed .on("error") handler', () => {
      const diff = `-  stream.on('error', handleErr);`;
      const result = scoreRegressionRisk(diff, ['src/stream.ts']);
      expect(result.reasons.some(r => r.pattern === 'Removed error handler')).toBe(true);
    });

    it('does NOT flag added .catch() as "removed"', () => {
      const diff = `+  promise.catch(err => console.error(err));`;
      const result = scoreRegressionRisk(diff, ['src/api.ts']);
      expect(result.reasons.every(r => r.pattern !== 'Removed error handler')).toBe(true);
    });

    it('detects Promise.all added', () => {
      const diff = `+  await Promise.all([a(), b()]);`;
      const result = scoreRegressionRisk(diff, ['src/index.ts']);
      expect(result.reasons.some(r => r.pattern === 'Promise.all/race/any added')).toBe(true);
    });

    it('detects Promise.race added', () => {
      const diff = `+  const first = await Promise.race([a(), b()]);`;
      const result = scoreRegressionRisk(diff, ['src/index.ts']);
      expect(result.reasons.some(r => r.pattern === 'Promise.all/race/any added')).toBe(true);
    });

    it('does NOT flag removed Promise.all', () => {
      const diff = `-  await Promise.all([a(), b()]);`;
      const result = scoreRegressionRisk(diff, ['src/index.ts']);
      expect(result.reasons.every(r => r.pattern !== 'Promise.all/race/any added')).toBe(true);
    });

    it('detects setTimeout added', () => {
      const diff = `+  setTimeout(() => cleanup(), 5000);`;
      const result = scoreRegressionRisk(diff, ['src/index.ts']);
      expect(result.reasons.some(r => r.pattern === 'setTimeout/setInterval added')).toBe(true);
    });

    it('detects setInterval added', () => {
      const diff = `+  setInterval(() => poll(), 1000);`;
      const result = scoreRegressionRisk(diff, ['src/index.ts']);
      expect(result.reasons.some(r => r.pattern === 'setTimeout/setInterval added')).toBe(true);
    });
  });

  // --- JS/TS-specific diff pattern scoring ---
  describe('JS/TS-specific diff pattern scoring', () => {
    // 1. as any
    it('detects added "as any" type assertion', () => {
      const diff = `+  const val = obj as any;`;
      const result = scoreRegressionRisk(diff, ['src/foo.ts']);
      expect(result.reasons.some(r => r.pattern === 'Added "as any" type assertion')).toBe(true);
      expect(result.reasons.find(r => r.pattern === 'Added "as any" type assertion')!.points).toBe(8);
    });

    it('does NOT flag "as any" in removed lines', () => {
      const diff = `-  const val = obj as any;`;
      const result = scoreRegressionRisk(diff, ['src/foo.ts']);
      expect(result.reasons.every(r => r.pattern !== 'Added "as any" type assertion')).toBe(true);
    });

    // 2. Removed optional chaining
    it('detects removed optional chaining without replacement', () => {
      const diff = `-  const name = user?.profile?.name;\n+  const name = user.profile.name;`;
      const result = scoreRegressionRisk(diff, ['src/foo.ts']);
      expect(result.reasons.some(r => r.pattern.includes('optional chaining'))).toBe(true);
    });

    it('does NOT flag optional chaining when replaced with new optional chaining', () => {
      const diff = `-  const name = user?.name;\n+  const name = user?.profile?.name;`;
      const result = scoreRegressionRisk(diff, ['src/foo.ts']);
      expect(result.reasons.every(r => !r.pattern.includes('optional chaining'))).toBe(true);
    });

    // 3. Removed nullish coalescing
    it('detects removed nullish coalescing without replacement', () => {
      const diff = `-  const val = x ?? 'default';`;
      const result = scoreRegressionRisk(diff, ['src/foo.ts']);
      expect(result.reasons.some(r => r.pattern.includes('nullish coalescing'))).toBe(true);
    });

    it('does NOT flag nullish coalescing when replaced', () => {
      const diff = `-  const val = x ?? 'default';\n+  const val = x ?? 'fallback';`;
      const result = scoreRegressionRisk(diff, ['src/foo.ts']);
      expect(result.reasons.every(r => !r.pattern.includes('nullish coalescing'))).toBe(true);
    });

    // 4. Strict to loose equality
    it('detects === changed to ==', () => {
      const diff = `-  if (x === null) {\n+  if (x == null) {`;
      const result = scoreRegressionRisk(diff, ['src/foo.ts']);
      expect(result.reasons.some(r => r.pattern.includes('Strict equality'))).toBe(true);
    });

    it('does NOT flag when === is only added', () => {
      const diff = `+  if (x === null) {`;
      const result = scoreRegressionRisk(diff, ['src/foo.ts']);
      expect(result.reasons.every(r => !r.pattern.includes('Strict equality'))).toBe(true);
    });

    // 5. Removed finally block
    it('detects removed finally block', () => {
      const diff = `-  } finally {`;
      const result = scoreRegressionRisk(diff, ['src/foo.ts']);
      expect(result.reasons.some(r => r.pattern === 'Removed finally block')).toBe(true);
    });

    it('does NOT flag added finally block', () => {
      const diff = `+  } finally {`;
      const result = scoreRegressionRisk(diff, ['src/foo.ts']);
      expect(result.reasons.every(r => r.pattern !== 'Removed finally block')).toBe(true);
    });

    // 6a. eval()/Function()
    it('detects added eval() call', () => {
      const diff = `+  const result = eval(userInput);`;
      const result = scoreRegressionRisk(diff, ['src/foo.ts']);
      expect(result.reasons.some(r => r.pattern.includes('eval()'))).toBe(true);
      expect(result.reasons.find(r => r.pattern.includes('eval()'))!.points).toBe(10);
    });

    it('detects added Function() constructor', () => {
      const diff = `+  const fn = new Function('return 1');`;
      const result = scoreRegressionRisk(diff, ['src/foo.ts']);
      expect(result.reasons.some(r => r.pattern.includes('eval()'))).toBe(true);
    });

    // 6b. innerHTML/dangerouslySetInnerHTML
    it('detects added innerHTML assignment', () => {
      const diff = `+  element.innerHTML = userContent;`;
      const result = scoreRegressionRisk(diff, ['src/foo.ts']);
      expect(result.reasons.some(r => r.pattern.includes('innerHTML'))).toBe(true);
      expect(result.reasons.find(r => r.pattern.includes('innerHTML'))!.points).toBe(10);
    });

    it('detects added dangerouslySetInnerHTML', () => {
      const diff = `+  <div dangerouslySetInnerHTML={{ __html: html }} />`;
      const result = scoreRegressionRisk(diff, ['src/Component.tsx']);
      expect(result.reasons.some(r => r.pattern.includes('innerHTML'))).toBe(true);
    });

    it('does NOT flag innerHTML in removed lines', () => {
      const diff = `-  element.innerHTML = userContent;`;
      const result = scoreRegressionRisk(diff, ['src/foo.ts']);
      expect(result.reasons.every(r => !r.pattern.includes('innerHTML'))).toBe(true);
    });

    // 7. Removed event listener cleanup
    it('detects removed removeEventListener', () => {
      const diff = `-  window.removeEventListener('resize', handler);`;
      const result = scoreRegressionRisk(diff, ['src/foo.ts']);
      expect(result.reasons.some(r => r.pattern.includes('event listener cleanup'))).toBe(true);
    });

    it('detects removed dispose()', () => {
      const diff = `-  subscription.dispose();`;
      const result = scoreRegressionRisk(diff, ['src/foo.ts']);
      expect(result.reasons.some(r => r.pattern.includes('event listener cleanup'))).toBe(true);
    });

    it('does NOT flag added removeEventListener', () => {
      const diff = `+  window.removeEventListener('resize', handler);`;
      const result = scoreRegressionRisk(diff, ['src/foo.ts']);
      expect(result.reasons.every(r => !r.pattern.includes('event listener cleanup'))).toBe(true);
    });

    // 8. Changed import style
    it('detects default import changed to named import', () => {
      const diff = `-import React from 'react';\n+import { Component } from 'react';`;
      const result = scoreRegressionRisk(diff, ['src/foo.ts']);
      expect(result.reasons.some(r => r.pattern.includes('import style'))).toBe(true);
    });

    it('detects named import changed to default import', () => {
      const diff = `-import { useState } from 'react';\n+import React from 'react';`;
      const result = scoreRegressionRisk(diff, ['src/foo.ts']);
      expect(result.reasons.some(r => r.pattern.includes('import style'))).toBe(true);
    });

    it('does NOT flag when only adding a new import', () => {
      const diff = `+import { useState } from 'react';`;
      const result = scoreRegressionRisk(diff, ['src/foo.ts']);
      expect(result.reasons.every(r => !r.pattern.includes('import style'))).toBe(true);
    });

    // 9. Non-null assertion
    it('detects added non-null assertion with property access', () => {
      const diff = `+  const name = user!.name;`;
      const result = scoreRegressionRisk(diff, ['src/foo.ts']);
      expect(result.reasons.some(r => r.pattern.includes('non-null assertion'))).toBe(true);
    });

    it('detects added non-null assertion at statement end', () => {
      const diff = `+  return value!;`;
      const result = scoreRegressionRisk(diff, ['src/foo.ts']);
      expect(result.reasons.some(r => r.pattern.includes('non-null assertion'))).toBe(true);
    });

    it('does NOT flag non-null assertion in removed lines', () => {
      const diff = `-  const name = user!.name;`;
      const result = scoreRegressionRisk(diff, ['src/foo.ts']);
      expect(result.reasons.every(r => !r.pattern.includes('non-null assertion'))).toBe(true);
    });

    // 10. Regex pattern changed
    it('detects regex pattern changed', () => {
      const diff = `-  const re = /^\\d+$/;\n+  const re = /^\\w+$/;`;
      const result = scoreRegressionRisk(diff, ['src/foo.ts']);
      expect(result.reasons.some(r => r.pattern === 'Regex pattern changed')).toBe(true);
    });

    it('does NOT flag when only adding a new regex', () => {
      const diff = `+  const re = /^\\d+$/;`;
      const result = scoreRegressionRisk(diff, ['src/foo.ts']);
      expect(result.reasons.every(r => r.pattern !== 'Regex pattern changed')).toBe(true);
    });

    // 11. Conditional logic inverted
    it('detects conditional inverted from positive to negated', () => {
      const diff = `-  if (isValid) {\n+  if (!isValid) {`;
      const result = scoreRegressionRisk(diff, ['src/foo.ts']);
      expect(result.reasons.some(r => r.pattern === 'Conditional logic inverted')).toBe(true);
    });

    it('detects conditional inverted from negated to positive', () => {
      const diff = `-  if (!isReady) {\n+  if (isReady) {`;
      const result = scoreRegressionRisk(diff, ['src/foo.ts']);
      expect(result.reasons.some(r => r.pattern === 'Conditional logic inverted')).toBe(true);
    });

    it('does NOT flag when only adding a new conditional', () => {
      const diff = `+  if (isValid) {`;
      const result = scoreRegressionRisk(diff, ['src/foo.ts']);
      expect(result.reasons.every(r => r.pattern !== 'Conditional logic inverted')).toBe(true);
    });

    // 12. Removed type guard
    it('detects removed instanceof check', () => {
      const diff = `-  if (err instanceof TypeError) {`;
      const result = scoreRegressionRisk(diff, ['src/foo.ts']);
      expect(result.reasons.some(r => r.pattern === 'Removed type guard')).toBe(true);
    });

    it('detects removed typeof check', () => {
      const diff = `-  if (typeof val === 'string') {`;
      const result = scoreRegressionRisk(diff, ['src/foo.ts']);
      expect(result.reasons.some(r => r.pattern === 'Removed type guard')).toBe(true);
    });

    it('detects removed Array.isArray check', () => {
      const diff = `-  if (Array.isArray(items)) {`;
      const result = scoreRegressionRisk(diff, ['src/foo.ts']);
      expect(result.reasons.some(r => r.pattern === 'Removed type guard')).toBe(true);
    });

    it('does NOT flag added type guard', () => {
      const diff = `+  if (err instanceof TypeError) {`;
      const result = scoreRegressionRisk(diff, ['src/foo.ts']);
      expect(result.reasons.every(r => r.pattern !== 'Removed type guard')).toBe(true);
    });
  });

  // --- Hunk-aware patterns ---
  describe('hunk-aware patterns', () => {
    describe('Async & Concurrency', () => {
      it('detects forEach(async ...) without Promise.all', () => {
        const diff = `@@ -1,3 +1,3 @@
+  items.forEach(async (item) => {
+    await processItem(item);
+  });`;
        const result = scoreRegressionRisk(diff, ['src/foo.ts']);
        expect(result.reasons.some(r => r.pattern === 'forEach(async ...) without Promise.all')).toBe(true);
      });

      it('suppresses forEach(async ...) when Promise.all present in same hunk', () => {
        const diff = `@@ -1,3 +1,3 @@
+  await Promise.all(items.forEach(async (item) => {
+    await processItem(item);
+  }));`;
        const result = scoreRegressionRisk(diff, ['src/foo.ts']);
        expect(result.reasons.every(r => r.pattern !== 'forEach(async ...) without Promise.all')).toBe(true);
      });

      it('detects map(async ...) without Promise.all', () => {
        const diff = `@@ -1,3 +1,3 @@
+  const results = items.map(async (item) => {
+    return await processItem(item);
+  });`;
        const result = scoreRegressionRisk(diff, ['src/foo.ts']);
        expect(result.reasons.some(r => r.pattern === 'map(async ...) without Promise.all')).toBe(true);
      });

      it('suppresses map(async ...) when Promise.all in same hunk', () => {
        const diff = `@@ -1,3 +1,3 @@
+  const results = await Promise.all(items.map(async (item) => {
+    return await processItem(item);
+  }));`;
        const result = scoreRegressionRisk(diff, ['src/foo.ts']);
        expect(result.reasons.every(r => r.pattern !== 'map(async ...) without Promise.all')).toBe(true);
      });

      it('detects removed AbortController', () => {
        const diff = `@@ -1,3 +1,3 @@
-  const controller = new AbortController();
-  const signal = controller.signal;
+  const response = await fetch(url);`;
        const result = scoreRegressionRisk(diff, ['src/foo.ts']);
        expect(result.reasons.some(r => r.pattern === 'Removed AbortController/signal')).toBe(true);
      });

      it('suppresses AbortController removal when re-added in same hunk', () => {
        const diff = `@@ -1,3 +1,3 @@
-  const controller = new AbortController();
+  const controller = new AbortController();
+  controller.abort();`;
        const result = scoreRegressionRisk(diff, ['src/foo.ts']);
        expect(result.reasons.every(r => r.pattern !== 'Removed AbortController/signal')).toBe(true);
      });

      it('detects async function without await in hunk', () => {
        const diff = `@@ -1,3 +1,3 @@
+  async function processData() {
+    return data.map(x => x * 2);
+  }`;
        const result = scoreRegressionRisk(diff, ['src/foo.ts']);
        expect(result.reasons.some(r => r.pattern === 'Async function without await in hunk')).toBe(true);
      });

      it('does NOT flag async function when await is present in hunk', () => {
        const diff = `@@ -1,3 +1,3 @@
+  async function processData() {
+    const result = await fetchData();
+    return result;
+  }`;
        const result = scoreRegressionRisk(diff, ['src/foo.ts']);
        expect(result.reasons.every(r => r.pattern !== 'Async function without await in hunk')).toBe(true);
      });
    });

    describe('Silent Error Handling', () => {
      it('detects empty catch block', () => {
        const diff = `@@ -1,3 +1,3 @@
+  try { doSomething(); } catch (e) {}`;
        const result = scoreRegressionRisk(diff, ['src/foo.ts']);
        expect(result.reasons.some(r => r.pattern === 'Empty catch block')).toBe(true);
      });

      it('detects .catch(() => {})', () => {
        const diff = `@@ -1,3 +1,3 @@
+  promise.catch(() => {})`;
        const result = scoreRegressionRisk(diff, ['src/foo.ts']);
        expect(result.reasons.some(r => r.pattern === '.catch(() => {}) swallows errors')).toBe(true);
      });

      it('detects .catch(() => null) without logging', () => {
        const diff = `@@ -1,3 +1,3 @@
+  promise.catch(() => null)`;
        const result = scoreRegressionRisk(diff, ['src/foo.ts']);
        expect(result.reasons.some(r => r.pattern === '.catch(() => fallback) without logging')).toBe(true);
      });

      it('suppresses .catch(() => null) when logging present in hunk', () => {
        const diff = `@@ -1,3 +1,3 @@
+  promise.catch((err) => null)
+  console.error('Failed:', err);`;
        const result = scoreRegressionRisk(diff, ['src/foo.ts']);
        expect(result.reasons.every(r => r.pattern !== '.catch(() => fallback) without logging')).toBe(true);
      });

      it('suppresses .catch fallback when logger present in hunk', () => {
        const diff = `@@ -1,3 +1,3 @@
+  promise.catch(() => [])
+  logger.warn('Failed to load data');`;
        const result = scoreRegressionRisk(diff, ['src/foo.ts']);
        expect(result.reasons.every(r => r.pattern !== '.catch(() => fallback) without logging')).toBe(true);
      });
    });

    describe('React State & Effects', () => {
      it('detects useEffect changed', () => {
        const diff = `@@ -1,3 +1,3 @@
-  useEffect(() => { fetchData(); }, []);
+  useEffect(() => { fetchData(); }, [id]);`;
        const result = scoreRegressionRisk(diff, ['src/Component.tsx']);
        expect(result.reasons.some(r => r.pattern === 'useEffect changed')).toBe(true);
      });

      it('does NOT flag useEffect when only added (not changed)', () => {
        const diff = `@@ -1,3 +1,3 @@
+  useEffect(() => { fetchData(); }, []);`;
        const result = scoreRegressionRisk(diff, ['src/Component.tsx']);
        expect(result.reasons.every(r => r.pattern !== 'useEffect changed')).toBe(true);
      });

      it('detects key={index} anti-pattern', () => {
        const diff = `@@ -1,3 +1,3 @@
+  {items.map((item, index) => <Item key={index} />)}`;
        const result = scoreRegressionRisk(diff, ['src/Component.tsx']);
        expect(result.reasons.some(r => r.pattern === 'key={index} anti-pattern')).toBe(true);
      });

      it('detects key={i} variant', () => {
        const diff = `@@ -1,3 +1,3 @@
+  {items.map((item, i) => <Item key={i} />)}`;
        const result = scoreRegressionRisk(diff, ['src/Component.tsx']);
        expect(result.reasons.some(r => r.pattern === 'key={index} anti-pattern')).toBe(true);
      });

      it('does NOT flag key={item.id}', () => {
        const diff = `@@ -1,3 +1,3 @@
+  {items.map((item) => <Item key={item.id} />)}`;
        const result = scoreRegressionRisk(diff, ['src/Component.tsx']);
        expect(result.reasons.every(r => r.pattern !== 'key={index} anti-pattern')).toBe(true);
      });

      it('detects removed useEffect cleanup return', () => {
        const diff = `@@ -1,5 +1,3 @@
   useEffect(() => {
     const id = setInterval(tick, 1000);
-    return () => clearInterval(id);
   }, []);`;
        const result = scoreRegressionRisk(diff, ['src/Component.tsx']);
        expect(result.reasons.some(r => r.pattern === 'Removed useEffect cleanup return')).toBe(true);
      });

      it('suppresses useEffect cleanup removal when replaced', () => {
        const diff = `@@ -1,5 +1,5 @@
   useEffect(() => {
     const id = setInterval(tick, 1000);
-    return () => clearInterval(id);
+    return () => clearTimeout(id);
   }, []);`;
        const result = scoreRegressionRisk(diff, ['src/Component.tsx']);
        expect(result.reasons.every(r => r.pattern !== 'Removed useEffect cleanup return')).toBe(true);
      });
    });
  });

  // --- Confidence weighting ---
  describe('confidence weighting', () => {
    it('applies 0.6x multiplier for medium confidence patterns', () => {
      // map(async ...) without Promise.all is medium confidence, 6pts → 4pts (rounded)
      const diff = `@@ -1,3 +1,3 @@
+  const results = items.map(async (item) => {
+    return await processItem(item);
+  });`;
      const result = scoreRegressionRisk(diff, ['src/foo.ts']);
      const mapAsyncReason = result.reasons.find(r => r.pattern === 'map(async ...) without Promise.all');
      expect(mapAsyncReason).toBeDefined();
      expect(mapAsyncReason!.points).toBe(4); // 6 * 0.6 = 3.6 → rounded to 4
      expect(mapAsyncReason!.confidence).toBe('medium');
    });

    it('applies full points for high confidence patterns', () => {
      const diff = `@@ -1,3 +1,3 @@
+  items.forEach(async (item) => {
+    processItem(item);
+  });`;
      const result = scoreRegressionRisk(diff, ['src/foo.ts']);
      const forEachReason = result.reasons.find(r => r.pattern === 'forEach(async ...) without Promise.all');
      expect(forEachReason).toBeDefined();
      expect(forEachReason!.points).toBe(8);
      expect(forEachReason!.confidence).toBe('high');
    });

    it('all reasons include confidence field', () => {
      const diff = `-  try {\n+  setTimeout(() => {}, 0);`;
      const result = scoreRegressionRisk(diff, ['src/a.ts', 'tsconfig.json']);
      for (const reason of result.reasons) {
        expect(['high', 'medium']).toContain(reason.confidence);
      }
    });
  });

  // --- Category caps ---
  describe('category caps', () => {
    it('caps diff category at 40 points', () => {
      // Trigger many diff patterns to exceed 40
      const diff = `- try {
- catch (e) {
- await fetch()
+ Promise.all([])
+ setTimeout(() => {}, 0)
- .catch(err => {})
+ export function a() {}
+ fetch('/api')
+ const x = obj as any;
+ eval('code')
+ element.innerHTML = val;
- if (err instanceof Error) {`;
      const result = scoreRegressionRisk(diff, []);
      const diffScore = result.reasons
        .filter(r => r.category === 'diff')
        .reduce((s, r) => s + r.points, 0);
      expect(diffScore).toBeLessThanOrEqual(40);
    });

    it('caps path category at 30 points', () => {
      const diff = `+  "dependencies": {\n+  "lodash": "^4.17.21"`;
      const result = scoreRegressionRisk(diff, [
        'package.json', 'package-lock.json',
        'tsconfig.json', 'webpack.config.js',
        '.github/workflows/ci.yml',
      ]);
      const pathScore = result.reasons
        .filter(r => r.category === 'path')
        .reduce((s, r) => s + r.points, 0);
      expect(pathScore).toBeLessThanOrEqual(30);
    });

    it('caps scope category at 25 points', () => {
      const lines = Array(250).fill('+ some line').join('\n');
      const files = Array(15).fill(null).map((_, i) => `src/file${i}.ts`);
      const result = scoreRegressionRisk(lines, files);
      const scopeScore = result.reasons
        .filter(r => r.category === 'scope')
        .reduce((s, r) => s + r.points, 0);
      expect(scopeScore).toBeLessThanOrEqual(25);
    });
  });

  // --- Scope scoring ---
  describe('scope scoring', () => {
    it('detects large diff (>200 lines)', () => {
      const lines = Array(250).fill('+ some line').join('\n');
      const result = scoreRegressionRisk(lines, ['src/big.ts']);
      expect(result.reasons.some(r => r.pattern.includes('Large diff'))).toBe(true);
    });

    it('does NOT flag small diff', () => {
      const lines = Array(50).fill('+ some line').join('\n');
      const result = scoreRegressionRisk(lines, ['src/small.ts']);
      expect(result.reasons.every(r => !r.pattern.includes('Large diff'))).toBe(true);
    });

    it('ignores --- and +++ lines in line count', () => {
      // These should NOT count as changed lines
      const diff = `--- a/file.ts\n+++ b/file.ts\n+ real change`;
      const result = scoreRegressionRisk(diff, ['file.ts']);
      expect(result.reasons.every(r => !r.pattern.includes('Large diff'))).toBe(true);
    });

    it('detects many files changed (>10)', () => {
      const files = Array(12).fill(null).map((_, i) => `src/file${i}.ts`);
      const result = scoreRegressionRisk('+ x', files);
      expect(result.reasons.some(r => r.pattern.includes('Many files'))).toBe(true);
      expect(result.reasons.find(r => r.pattern.includes('Many files'))!.points).toBe(15);
    });

    it('detects several files changed (6-10)', () => {
      const files = Array(7).fill(null).map((_, i) => `src/file${i}.ts`);
      const result = scoreRegressionRisk('+ x', files);
      expect(result.reasons.some(r => r.pattern.includes('Several files'))).toBe(true);
      expect(result.reasons.find(r => r.pattern.includes('Several files'))!.points).toBe(8);
    });

    it('does NOT flag 5 or fewer files', () => {
      const files = Array(5).fill(null).map((_, i) => `src/file${i}.ts`);
      const result = scoreRegressionRisk('+ x', files);
      expect(result.reasons.every(r => !r.pattern.includes('files changed'))).toBe(true);
    });

    it('scores code without test files', () => {
      const result = scoreRegressionRisk('+ new code', ['src/index.ts']);
      expect(result.reasons.some(r => r.pattern.includes('no test files'))).toBe(true);
    });

    it('does NOT flag when test files are present (.test.ts)', () => {
      const result = scoreRegressionRisk('+ x', ['src/index.ts', 'src/index.test.ts']);
      expect(result.reasons.every(r => !r.pattern.includes('no test files'))).toBe(true);
    });

    it('does NOT flag when test files are present (.spec.js)', () => {
      const result = scoreRegressionRisk('+ x', ['src/index.ts', 'src/index.spec.js']);
      expect(result.reasons.every(r => !r.pattern.includes('no test files'))).toBe(true);
    });

    it('does NOT flag when files in __tests__/ dir', () => {
      const result = scoreRegressionRisk('+ x', ['src/index.ts', 'src/__tests__/helper.ts']);
      expect(result.reasons.every(r => !r.pattern.includes('no test files'))).toBe(true);
    });

    it('recognizes test files with Windows path separators', () => {
      const diff = '- removed line';
      const windowsPaths = ['src\\__tests__\\helper.ts', 'src\\index.ts'];

      const result = scoreRegressionRisk(diff, windowsPaths);

      // Should NOT get the "+12 no tests" penalty since test file is present
      expect(result.reasons.some(r => r.pattern.includes('no test files'))).toBe(false);
    });

    it('does NOT flag "no test files" when only non-code files changed', () => {
      const result = scoreRegressionRisk('', ['README.md', 'package.json']);
      expect(result.reasons.every(r => !r.pattern.includes('no test files'))).toBe(true);
    });
  });

  // --- Score capping ---
  it('caps score at 100', () => {
    const diff = `- try {
- catch (e) {
- await fetch()
+ Promise.all([])
+ setTimeout(() => {}, 0)
- .catch(err => {})
+ export function a() {}
+ fetch('/api')
+ const x = obj as any;
+ eval('code')
+ element.innerHTML = val;
- if (err instanceof Error) {`;
    const files = Array(15).fill(null).map((_, i) => `src/file${i}.ts`);
    files.push('package.json', 'tsconfig.json', 'webpack.config.js', '.github/workflows/ci.yml');
    const result = scoreRegressionRisk(diff, files);
    expect(result.totalRiskScore).toBeLessThanOrEqual(100);
  });

  // --- riskiestFiles output ---
  describe('riskiestFiles', () => {
    it('filters out test files from riskiestFiles', () => {
      const result = scoreRegressionRisk('+ x', [
        'src/index.ts',
        'src/index.test.ts',
        'src/utils.spec.js',
      ]);
      expect(result.riskiestFiles).not.toContain('src/index.test.ts');
      expect(result.riskiestFiles).not.toContain('src/utils.spec.js');
      expect(result.riskiestFiles).toContain('src/index.ts');
    });

    it('filters out node_modules from riskiestFiles', () => {
      const result = scoreRegressionRisk('+ x', [
        'src/index.ts',
        'node_modules/foo/bar.js',
      ]);
      expect(result.riskiestFiles).not.toContain('node_modules/foo/bar.js');
    });

    it('caps riskiestFiles at 5', () => {
      const files = Array(10).fill(null).map((_, i) => `src/file${i}.ts`);
      const result = scoreRegressionRisk('+ x', files);
      expect(result.riskiestFiles.length).toBeLessThanOrEqual(5);
    });

    it('filters out __tests__ files with Windows path separators from riskiestFiles', () => {
      const result = scoreRegressionRisk('+ x', [
        'src\\index.ts',
        'src\\__tests__\\helper.ts',
      ]);
      expect(result.riskiestFiles).not.toContain('src\\__tests__\\helper.ts');
      expect(result.riskiestFiles).toContain('src\\index.ts');
    });
  });

  // --- Additive scoring ---
  it('accumulates points from multiple categories', () => {
    const diff = `-  const data = await fetchData();\n+  setTimeout(() => {}, 0);`;
    const result = scoreRegressionRisk(diff, ['src/api.ts', '.github/workflows/ci.yml']);
    // Should have: removed await (8) + setTimeout (6) + CI file (7) + no test files (12) = 33
    expect(result.totalRiskScore).toBeGreaterThanOrEqual(33);
  });

  // --- Reason structure ---
  it('includes correct category in each reason', () => {
    const diff = `-  try {\n+ setTimeout(() => {}, 0);`;
    const result = scoreRegressionRisk(diff, ['src/a.ts', 'tsconfig.json']);
    const categories = new Set(result.reasons.map(r => r.category));
    expect(categories.has('diff')).toBe(true);
    expect(categories.has('path')).toBe(true);
  });
});
