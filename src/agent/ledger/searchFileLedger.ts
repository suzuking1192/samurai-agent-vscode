/**
 * Search & File Ledger
 * 
 * Tracks code-search queries and static-analysis file operations per session
 * to prevent duplicate tool calls and reduce iteration loops.
 */

export interface SearchRecord {
  queryRaw: string;
  queryNorm: string;
  mode: 'file' | 'symbol' | 'text';
  pattern?: string;
  timestamp: number;
  resultCount?: number;
  topFiles?: string[]; // max 3
}

export interface StaticAnalysisRecord {
  filePath: string;
  mode: string; // 'metrics' | 'source' | 'flow'
  target?: string;
  timestamp: number;
  summary?: string; // 1 sentence, max 100 chars, non-code metadata only
}

export interface LedgerState {
  searches: SearchRecord[];
  openedFiles: StaticAnalysisRecord[];
}

/**
 * Normalize search queries for duplicate detection
 */
export function normalizeQuery(q: string): string {
  if (!q || typeof q !== 'string') {
    return '';
  }

  let normalized = q.trim().toLowerCase();

  // Remove surrounding quotes
  if ((normalized.startsWith('"') && normalized.endsWith('"')) ||
      (normalized.startsWith("'") && normalized.endsWith("'"))) {
    normalized = normalized.slice(1, -1);
  }

  // Collapse repeated slashes
  normalized = normalized.replace(/\/+/g, '/');

  // Detect API paths: if contains /api/ and has 2+ segments after /api/, normalize
  // Example: /api/company-admin/users, app/api/company-admin/users -> api/company-admin/users
  // Only normalize paths with 2+ segments after /api/ (e.g., company-admin/users)
  // Single segment paths like "app/api/users" are NOT normalized
  if (normalized.includes('/api/')) {
    const apiMatch = normalized.match(/\/?([^\/]*\/)?api\/([^\/]+(?:\/[^\/]+)+)/);
    if (apiMatch) {
      // Only normalize if there are 2+ segments after /api/
      const segments = apiMatch[2].split('/');
      if (segments.length >= 2) {
        normalized = `api/${segments.join('/')}`;
      }
    }
  }

  return normalized;
}

/**
 * Check if pattern1 is a superset of pattern2
 * Heuristic: pattern with more ** or broader scope is superset
 */
export function isPatternSuperset(
  pattern1: string | undefined,
  pattern2: string | undefined
): boolean {
  if (!pattern1 || !pattern2) {
    return false;
  }

  // Count ** occurrences (more = broader)
  const countWildcards = (p: string): number => {
    return (p.match(/\*\*/g) || []).length;
  };

  const wildcards1 = countWildcards(pattern1);
  const wildcards2 = countWildcards(pattern2);

  // If pattern1 has more **, it's likely a superset
  if (wildcards1 > wildcards2) {
    return true;
  }

  // If pattern1 is **/*.ts and pattern2 is a specific path, pattern1 is superset
  if (pattern1 === '**/*.ts' || pattern1 === '**/*.tsx' || pattern1 === '**/*.js' || pattern1 === '**/*.jsx') {
    if (pattern2.includes('/') && !pattern2.startsWith('**')) {
      return true;
    }
  }

  // If pattern1 is app/api/** and pattern2 is app/api/company-admin/**, pattern1 is superset
  if (pattern1.endsWith('/**') && pattern2.startsWith(pattern1.slice(0, -2))) {
    return true;
  }

  // If pattern2 is app/api/** and pattern1 is app/api/company-admin/**, pattern2 is superset (reverse)
  if (pattern2.endsWith('/**') && pattern1.startsWith(pattern2.slice(0, -2))) {
    return false; // pattern1 is NOT superset, pattern2 is
  }

  return false;
}

/**
 * Check if a search is a duplicate using formal rules
 */
export function isSearchDuplicate(
  state: LedgerState,
  queryNorm: string,
  mode: 'file' | 'symbol' | 'text',
  pattern?: string
): { isDuplicate: boolean; previousRecord?: SearchRecord } {
  for (const record of state.searches) {
    // Must match queryNorm and mode for any duplicate check
    if (record.queryNorm === queryNorm && record.mode === mode) {
      // Exact duplicate: same queryNorm, same mode, same pattern
      if (pattern === undefined && record.pattern === undefined) {
        return { isDuplicate: true, previousRecord: record };
      }
      if (pattern === record.pattern) {
        return { isDuplicate: true, previousRecord: record };
      }

      // Widening duplicate: same queryNorm, same mode, one pattern is superset
      if (pattern && record.pattern) {
        if (isPatternSuperset(pattern, record.pattern) || isPatternSuperset(record.pattern, pattern)) {
          return { isDuplicate: true, previousRecord: record };
        }
      }

      // Variant duplicate: same queryNorm, same mode (regardless of pattern differences)
      // If we get here, patterns differ and neither is a superset, but same query+mode = duplicate
      return { isDuplicate: true, previousRecord: record };
    }
  }

  return { isDuplicate: false };
}

/**
 * Check if a file was already analyzed
 */
export function isFileAlreadyOpened(
  state: LedgerState,
  filePath: string,
  mode?: string,
  target?: string
): { isDuplicate: boolean; previousRecord?: StaticAnalysisRecord } {
  for (const record of state.openedFiles) {
    if (record.filePath === filePath) {
      // Exact match: same filePath, same mode, same target
      if (mode === record.mode && target === record.target) {
        return { isDuplicate: true, previousRecord: record };
      }

      // Mode-only match: same filePath, same mode, different target
      // If target is specified in new request, allow it (new analysis)
      // If target is not specified but was specified before, treat as duplicate
      if (mode === record.mode) {
        if (!target && !record.target) {
          return { isDuplicate: true, previousRecord: record };
        }
        // If new request has target but old didn't, or vice versa, allow (different analysis)
        if (target && !record.target) {
          return { isDuplicate: false };
        }
        if (!target && record.target) {
          return { isDuplicate: true, previousRecord: record };
        }
      }
    }
  }

  return { isDuplicate: false };
}

/**
 * Add a search record to the ledger (immutable update)
 */
export function addSearchRecord(
  state: LedgerState,
  record: Omit<SearchRecord, 'timestamp'>
): LedgerState {
  const newRecord: SearchRecord = {
    ...record,
    timestamp: Date.now()
  };

  return {
    ...state,
    searches: [...state.searches, newRecord]
  };
}

/**
 * Add a static analysis record to the ledger (immutable update)
 */
export function addStaticAnalysisRecord(
  state: LedgerState,
  record: Omit<StaticAnalysisRecord, 'timestamp'>
): LedgerState {
  const newRecord: StaticAnalysisRecord = {
    ...record,
    timestamp: Date.now()
  };

  return {
    ...state,
    openedFiles: [...state.openedFiles, newRecord]
  };
}

/**
 * Render a compact ledger summary for prompt injection (<1200 chars)
 */
export function renderLedgerSummary(state: LedgerState): string {
  const parts: string[] = [];

  // Show last 8 searches (most recent last)
  const recentSearches = state.searches.slice(-8);
  if (recentSearches.length > 0) {
    parts.push('## Recent Searches');
    for (const search of recentSearches) {
      const patternStr = search.pattern || 'none';
      const hitsStr = search.resultCount !== undefined ? String(search.resultCount) : '?';
      const topFilesStr = search.topFiles && search.topFiles.length > 0
        ? `[${search.topFiles.join(', ')}]`
        : '[]';
      parts.push(`- q=${search.queryNorm} mode=${search.mode} pattern=${patternStr} hits=${hitsStr} top=${topFilesStr}`);
    }
  }

  // Show last 8 opened files
  const recentFiles = state.openedFiles.slice(-8);
  if (recentFiles.length > 0) {
    parts.push('\n## Opened Files');
    for (const file of recentFiles) {
      const targetStr = file.target ? `, target=${file.target}` : '';
      parts.push(`- ${file.filePath} (${file.mode}${targetStr})`);
    }
  }

  // Extract best candidate files from recent searches (top 3 unique)
  const candidateFiles = new Set<string>();
  for (const search of state.searches.slice(-5).reverse()) {
    if (search.topFiles) {
      for (const file of search.topFiles) {
        if (candidateFiles.size < 3) {
          candidateFiles.add(file);
        }
      }
    }
  }

  if (candidateFiles.size > 0) {
    parts.push('\n## Best Candidate Files');
    parts.push(Array.from(candidateFiles).map(f => `- ${f}`).join('\n'));
    
    // Next action suggestion
    const bestCandidate = Array.from(candidateFiles)[0];
    parts.push(`\n## Next Action Suggestion`);
    parts.push(`Run static-analysis on ${bestCandidate}`);
  }

  // Reminder
  parts.push('\n**Reminder:** If a query/file appears above, do NOT repeat. Pivot to static-analysis on the best candidate.');

  let summary = parts.join('\n');

  // Hard cap at 1200 chars: drop older entries first
  if (summary.length > 1200) {
    // Try removing oldest searches first
    let trimmedSearches = recentSearches;
    let trimmedFiles = recentFiles;
    
    while (summary.length > 1200 && (trimmedSearches.length > 0 || trimmedFiles.length > 0)) {
      if (trimmedSearches.length > trimmedFiles.length) {
        trimmedSearches = trimmedSearches.slice(1);
      } else {
        trimmedFiles = trimmedFiles.slice(1);
      }
      
      // Rebuild summary
      const newParts: string[] = [];
      if (trimmedSearches.length > 0) {
        newParts.push('## Recent Searches');
        for (const search of trimmedSearches) {
          const patternStr = search.pattern || 'none';
          const hitsStr = search.resultCount !== undefined ? String(search.resultCount) : '?';
          const topFilesStr = search.topFiles && search.topFiles.length > 0
            ? `[${search.topFiles.join(', ')}]`
            : '[]';
          newParts.push(`- q=${search.queryNorm} mode=${search.mode} pattern=${patternStr} hits=${hitsStr} top=${topFilesStr}`);
        }
      }
      
      if (trimmedFiles.length > 0) {
        newParts.push('\n## Opened Files');
        for (const file of trimmedFiles) {
          const targetStr = file.target ? `, target=${file.target}` : '';
          newParts.push(`- ${file.filePath} (${file.mode}${targetStr})`);
        }
      }
      
      // Keep best candidates and reminder
      if (candidateFiles.size > 0) {
        newParts.push('\n## Best Candidate Files');
        newParts.push(Array.from(candidateFiles).map(f => `- ${f}`).join('\n'));
        const bestCandidate = Array.from(candidateFiles)[0];
        newParts.push(`\n## Next Action Suggestion`);
        newParts.push(`Run static-analysis on ${bestCandidate}`);
      }
      
      newParts.push('\n**Reminder:** If a query/file appears above, do NOT repeat. Pivot to static-analysis on the best candidate.');
      summary = newParts.join('\n');
    }
  }

  return summary;
}

