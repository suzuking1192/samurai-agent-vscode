/**
 * RegressionRiskScorer - Pure deterministic scoring of regression risk from diffs.
 * No LLM involved. Scores based on diff patterns, file paths, and scope.
 */

export interface RiskReason {
  category: string;
  pattern: string;
  points: number;
  confidence: 'high' | 'medium';
}

export interface RiskResult {
  totalRiskScore: number;
  reasons: RiskReason[];
  riskiestFiles: string[];
}

export interface DiffHunk {
  addedLines: string[];
  removedLines: string[];
  contextLines: string[];
  allLines: string[];
}

export function parseHunks(diffText: string): DiffHunk[] {
  const lines = diffText.split('\n');
  const hunkStarts: number[] = [];

  for (let i = 0; i < lines.length; i++) {
    if (/^@@\s/.test(lines[i])) {
      hunkStarts.push(i);
    }
  }

  // Fallback: if no @@ headers found, treat entire diff as one hunk
  if (hunkStarts.length === 0) {
    return [buildHunk(lines)];
  }

  const hunks: DiffHunk[] = [];
  for (let i = 0; i < hunkStarts.length; i++) {
    const start = hunkStarts[i] + 1; // skip the @@ line itself
    const end = i + 1 < hunkStarts.length ? hunkStarts[i + 1] : lines.length;
    hunks.push(buildHunk(lines.slice(start, end)));
  }

  return hunks;
}

function buildHunk(lines: string[]): DiffHunk {
  const addedLines: string[] = [];
  const removedLines: string[] = [];
  const contextLines: string[] = [];

  for (const line of lines) {
    if (line.startsWith('+') && !line.startsWith('+++')) {
      addedLines.push(line);
    } else if (line.startsWith('-') && !line.startsWith('---')) {
      removedLines.push(line);
    } else if (line.startsWith(' ')) {
      contextLines.push(line);
    }
  }

  return { addedLines, removedLines, contextLines, allLines: lines };
}

const CATEGORY_CAPS: Record<string, number> = {
  diff: 40,
  path: 30,
  scope: 25,
};

export function scoreRegressionRisk(diffText: string, changedFiles: string[]): RiskResult {
  const reasons: RiskReason[] = [];
  const categoryScores: Record<string, number> = {};

  const addRisk = (category: string, pattern: string, points: number, confidence: 'high' | 'medium' = 'high') => {
    const effectivePoints = confidence === 'medium' ? Math.round(points * 0.6) : points;
    const cap = CATEGORY_CAPS[category];
    if (cap !== undefined) {
      const current = categoryScores[category] || 0;
      if (current >= cap) return;
      const capped = Math.min(effectivePoints, cap - current);
      reasons.push({ category, pattern, points: capped, confidence });
      categoryScores[category] = current + capped;
    } else {
      reasons.push({ category, pattern, points: effectivePoints, confidence });
    }
  };

  // --- Path-based scoring ---
  const lockFiles = changedFiles.filter(f =>
    /package-lock\.json|yarn\.lock|pnpm-lock\.yaml/.test(f)
  );
  if (lockFiles.length > 0) {
    addRisk('path', 'Lock file changed', 5);
  }

  // package.json with dependency changes
  if (changedFiles.some(f => f.endsWith('package.json'))) {
    if (/^[+-]\s*"(dependencies|devDependencies|peerDependencies)"/m.test(diffText) ||
        /^[+-]\s*"[^"]+"\s*:\s*"[\^~]?\d/m.test(diffText)) {
      addRisk('path', 'package.json dependency changes', 25);
    }
  }

  // Config files
  const configPatterns = [
    /tsconfig.*\.json$/,
    /webpack\.config/,
    /vite\.config/,
    /babel\.config/,
    /\.babelrc/,
    /\.env/,
  ];
  let configCount = 0;
  for (const f of changedFiles) {
    if (configPatterns.some(p => p.test(f)) && configCount < 2) {
      configCount++;
      addRisk('path', `Config file: ${f}`, 8);
    }
  }

  // CI files (cross-platform path separators)
  if (changedFiles.some(f => /\.github[/\\]workflows[/\\]|Dockerfile/.test(f))) {
    addRisk('path', 'CI/Docker file changed', 7);
  }

  // --- Diff pattern scoring (flat, existing patterns) ---
  const diffLines = diffText.split('\n');

  if (diffLines.some(l => /^-\s*(try|catch)\b/.test(l))) {
    addRisk('diff', 'Removed try/catch', 10);
  }

  if (diffLines.some(l => /^-.*await\s/.test(l))) {
    addRisk('diff', 'Removed await', 8);
  }

  if (diffLines.some(l => /^[+-]\s*export\s/.test(l))) {
    addRisk('diff', 'Changed exports', 6);
  }

  if (diffLines.some(l => /^[+-].*\b(fetch|axios|http\.request|\.get\(|\.post\()\b/.test(l))) {
    addRisk('diff', 'API boundary changes', 8);
  }

  if (diffLines.some(l => /^-.*\.(catch\(|on\(\s*['"]error)/.test(l))) {
    addRisk('diff', 'Removed error handler', 10);
  }

  if (diffLines.some(l => /^\+.*Promise\.(all|race|any)/.test(l))) {
    addRisk('diff', 'Promise.all/race/any added', 8);
  }

  if (diffLines.some(l => /^\+.*(setTimeout|setInterval)\(/.test(l))) {
    addRisk('diff', 'setTimeout/setInterval added', 6);
  }

  // --- JS/TS-specific diff pattern scoring ---

  // 1. Added `as any` type assertion
  if (diffLines.some(l => /^\+.*\bas\s+any\b/.test(l))) {
    addRisk('diff', 'Added "as any" type assertion', 8);
  }

  // 2. Removed optional chaining `?.` without replacement
  const removedOptionalChaining = diffLines.some(l => /^-.*\?\.\w/.test(l));
  const addedOptionalChaining = diffLines.some(l => /^\+.*\?\.\w/.test(l));
  if (removedOptionalChaining && !addedOptionalChaining) {
    addRisk('diff', 'Removed optional chaining (?.) without replacement', 8);
  }

  // 3. Removed nullish coalescing `??` without replacement
  const removedNullishCoalescing = diffLines.some(l => /^-.*\?\?/.test(l));
  const addedNullishCoalescing = diffLines.some(l => /^\+.*\?\?/.test(l));
  if (removedNullishCoalescing && !addedNullishCoalescing) {
    addRisk('diff', 'Removed nullish coalescing (??) without replacement', 6);
  }

  // 4. Strict equality `===` changed to loose `==`
  const removedStrictEq = diffLines.some(l => /^-.*===/.test(l));
  const addedLooseEq = diffLines.some(l => /^\+.*[^!=]==[^=]/.test(l));
  if (removedStrictEq && addedLooseEq) {
    addRisk('diff', 'Strict equality (===) changed to loose (==)', 6);
  }

  // 5. Removed `finally` block
  if (diffLines.some(l => /^-\s*\}?\s*finally\s*\{/.test(l))) {
    addRisk('diff', 'Removed finally block', 6);
  }

  // 6a. Added eval()/Function() (code injection risk)
  if (diffLines.some(l => /^\+.*\b(eval|Function)\s*\(/.test(l))) {
    addRisk('diff', 'Added eval()/Function() call', 10);
  }

  // 6b. Added innerHTML/outerHTML/dangerouslySetInnerHTML (XSS risk)
  if (diffLines.some(l => /^\+.*\.(innerHTML|outerHTML)\s*=/.test(l) || /^\+.*dangerouslySetInnerHTML/.test(l))) {
    addRisk('diff', 'Added innerHTML/dangerouslySetInnerHTML (XSS risk)', 10);
  }

  // 7. Removed event listener cleanup
  if (diffLines.some(l => /^-.*\b(removeEventListener|removeAllListeners|\.off\(|unsubscribe|dispose)\b/.test(l))) {
    addRisk('diff', 'Removed event listener cleanup', 6);
  }

  // 8. Changed import style (default <-> named)
  const removedDefaultImport = diffLines.some(l => /^-\s*import\s+\w+\s+from\b/.test(l));
  const addedNamedImport = diffLines.some(l => /^\+\s*import\s+\{/.test(l));
  const removedNamedImport = diffLines.some(l => /^-\s*import\s+\{/.test(l));
  const addedDefaultImport = diffLines.some(l => /^\+\s*import\s+\w+\s+from\b/.test(l));
  if ((removedDefaultImport && addedNamedImport) || (removedNamedImport && addedDefaultImport)) {
    addRisk('diff', 'Changed import style (default <-> named)', 6);
  }

  // 9. Added non-null assertion `!`
  if (diffLines.some(l => /^\+.*\w+!\.\w/.test(l) || /^\+.*\w+!;/.test(l) || /^\+.*\w+!\)/.test(l))) {
    addRisk('diff', 'Added non-null assertion (!)', 4);
  }

  // 10. Regex pattern changed
  const removedRegex = diffLines.some(l => /^-.*\/[^/\n]+\/[gimsuy]*/.test(l));
  const addedRegex = diffLines.some(l => /^\+.*\/[^/\n]+\/[gimsuy]*/.test(l));
  if (removedRegex && addedRegex) {
    addRisk('diff', 'Regex pattern changed', 6);
  }

  // 11. Conditional logic inverted (negation changed)
  const removedIfPositive = diffLines.some(l => /^-.*if\s*\(\s*[^!]/.test(l));
  const addedIfNegated = diffLines.some(l => /^\+.*if\s*\(\s*!/.test(l));
  const removedIfNegated = diffLines.some(l => /^-.*if\s*\(\s*!/.test(l));
  const addedIfPositive = diffLines.some(l => /^\+.*if\s*\(\s*[^!]/.test(l));
  if ((removedIfPositive && addedIfNegated) || (removedIfNegated && addedIfPositive)) {
    addRisk('diff', 'Conditional logic inverted', 6);
  }

  // 12. Removed type guard
  if (diffLines.some(l => /^-.*\b(instanceof|typeof\s+\w+\s*[!=]==?|Array\.isArray|\.hasOwnProperty)/.test(l))) {
    addRisk('diff', 'Removed type guard', 8);
  }

  // --- Hunk-aware patterns (Async, Error Handling, React State) ---
  const hunks = parseHunks(diffText);

  // Category 1: Async & Concurrency
  // forEach(async ...) without Promise.all in same hunk
  for (const hunk of hunks) {
    if (hunk.addedLines.some(l => /\.forEach\(\s*async\b/.test(l))) {
      const hasPromiseAll = hunk.allLines.some(l => /await\s+Promise\.all/.test(l));
      if (!hasPromiseAll) {
        addRisk('diff', 'forEach(async ...) without Promise.all', 8);
        break;
      }
    }
  }

  // map(async ...) without Promise.all in same hunk
  for (const hunk of hunks) {
    if (hunk.addedLines.some(l => /\.map\(\s*async\b/.test(l))) {
      const hasPromiseAll = hunk.allLines.some(l => /Promise\.all/.test(l));
      if (!hasPromiseAll) {
        addRisk('diff', 'map(async ...) without Promise.all', 6, 'medium');
        break;
      }
    }
  }

  // Removed AbortController/signal
  for (const hunk of hunks) {
    if (hunk.removedLines.some(l => /\b(AbortController|\.abort\(\)|\.signal)\b/.test(l))) {
      const reAdded = hunk.addedLines.some(l => /\b(AbortController|\.abort\(\)|\.signal)\b/.test(l));
      if (!reAdded) {
        addRisk('diff', 'Removed AbortController/signal', 6, 'medium');
        break;
      }
    }
  }

  // Added async function without await in same hunk
  for (const hunk of hunks) {
    if (hunk.addedLines.some(l => /async\s+(function\b|\w+\s*=\s*async\b)/.test(l))) {
      const hasAwait = hunk.addedLines.some(l => /\bawait\b/.test(l));
      if (!hasAwait) {
        addRisk('diff', 'Async function without await in hunk', 4, 'medium');
        break;
      }
    }
  }

  // Category 2: Silent Error Handling
  // Empty catch block
  for (const hunk of hunks) {
    if (hunk.addedLines.some(l => /catch\s*\([^)]*\)\s*\{\s*\}/.test(l))) {
      addRisk('diff', 'Empty catch block', 8);
      break;
    }
  }

  // .catch(() => {})
  for (const hunk of hunks) {
    if (hunk.addedLines.some(l => /\.catch\(\s*\(\s*\)\s*=>\s*\{\s*\}\s*\)/.test(l))) {
      addRisk('diff', '.catch(() => {}) swallows errors', 8);
      break;
    }
  }

  // .catch(() => fallback) silently
  for (const hunk of hunks) {
    if (hunk.addedLines.some(l => /\.catch\(\s*\(?[^)]*\)?\s*=>\s*(null|undefined|\[\]|\{\})/.test(l))) {
      const hasLogging = hunk.allLines.some(l => /console\.(error|warn)|logger\.|log\.|\.error\(/.test(l));
      if (!hasLogging) {
        addRisk('diff', '.catch(() => fallback) without logging', 6, 'medium');
        break;
      }
    }
  }

  // Category 3: React State & Effects
  // useEffect changed (both removed and added in same hunk)
  for (const hunk of hunks) {
    const removedUseEffect = hunk.removedLines.some(l => /useEffect\(/.test(l));
    const addedUseEffect = hunk.addedLines.some(l => /useEffect\(/.test(l));
    if (removedUseEffect && addedUseEffect) {
      addRisk('diff', 'useEffect changed', 6, 'medium');
      break;
    }
  }

  // key={index} anti-pattern
  for (const hunk of hunks) {
    if (hunk.addedLines.some(l => /key=\{(index|i|idx)\}/.test(l))) {
      addRisk('diff', 'key={index} anti-pattern', 4);
      break;
    }
  }

  // Removed useEffect cleanup return
  for (const hunk of hunks) {
    const hunkHasUseEffect = hunk.allLines.some(l => /useEffect/.test(l));
    if (!hunkHasUseEffect) continue;
    const removedCleanup = hunk.removedLines.some(l =>
      /return\s*\(\s*\)\s*=>/.test(l) || /return\s+cleanup/.test(l)
    );
    if (removedCleanup) {
      const replacedCleanup = hunk.addedLines.some(l => /return\s*\(\s*\)\s*=>/.test(l));
      if (!replacedCleanup) {
        addRisk('diff', 'Removed useEffect cleanup return', 6, 'medium');
        break;
      }
    }
  }

  // --- Scope scoring ---
  const changedLineCount = diffLines.filter(l => /^[+-]/.test(l) && !/^[+-]{3}/.test(l)).length;
  if (changedLineCount > 200) {
    addRisk('scope', `Large diff (${changedLineCount} lines)`, 10);
  }

  if (changedFiles.length > 10) {
    addRisk('scope', `Many files changed (${changedFiles.length})`, 15);
  } else if (changedFiles.length > 5) {
    addRisk('scope', `Several files changed (${changedFiles.length})`, 8);
  }

  // Code changed but no test files (cross-platform path separators)
  const hasTestFile = changedFiles.some(f =>
    /\.(test|spec)\.(ts|tsx|js|jsx)$/.test(f) || /__tests__[/\\]/.test(f)
  );
  const hasCodeFile = changedFiles.some(f =>
    /\.(ts|tsx|js|jsx)$/.test(f) && !/\.(test|spec)\./.test(f) && !/__tests__[/\\]/.test(f)
  );
  if (hasCodeFile && !hasTestFile) {
    addRisk('scope', 'Code changed but no test files touched', 12);
  }

  // Compute total from reasons (already capped per-category)
  const score = reasons.reduce((sum, r) => sum + r.points, 0);

  // Cap at 100
  const totalRiskScore = Math.min(score, 100);

  // Determine riskiest files (files that appear in risk-related diff hunks)
  // Cross-platform path separators for __tests__ directory
  const riskiestFiles = changedFiles
    .filter(f => !/\.(test|spec)\.|__tests__[/\\]|node_modules/.test(f))
    .slice(0, 5);

  return { totalRiskScore, reasons, riskiestFiles };
}
