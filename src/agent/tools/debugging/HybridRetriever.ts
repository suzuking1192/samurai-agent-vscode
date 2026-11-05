/**
 * Hybrid Retriever for debugging code extraction
 * 
 * Combines existing LLM ranking methods with evidence-based boosting
 * Implements robust score fusion, symbol scoring, and audit trails
 */

import { Evidence, SearchPlan, CandidateFile, CandidateSymbolRef, ScoreComponents } from './types';
import { ExtractCodeTool } from '../extractCodeTool';
import { CodeElement, FileInfo } from '../../../common/models/context-models';

// Types for improved scoring and auditing
interface Audit {
  bm25?: number;
  dense?: number;
  symbol?: number;
  evidence?: Record<string, number>;
  fused?: number;
  ranks?: Record<string, number>;
}

interface Weights {
  bm25: number;
  dense: number;
  symbol: number;
  evidence: number;
  routeMatch?: number;
  softSignal?: number;
  astProximity?: number;
  gitRecency?: number;
}

interface RetrievalDeps {
  rankRelevantFilesWithLLM: (fileInfos: Map<string, FileInfo>, query: string, projectId: string, model: string) => Promise<Map<string, any[]>>;
  performKeywordBasedSearch: (fileInfos: Map<string, FileInfo>, options: any) => Promise<Map<string, any[]>>;
}

// Constants for candidate file limits (tiered progressive degradation)
const MAX_CANDIDATE_FILES_TIERED = [20, 12, 8];

export class HybridRetriever {
  private readonly extractCodeTool: ExtractCodeTool;
  private readonly weights: Weights;
  private readonly maxCandidatesPerSource: number = 20; // Reduced from 200
  private readonly rrfK: number = 60;
  // Feature flag to toggle between batch API (new) and loop-based API (old)
  // Defaults to true (use batch API) for better performance
  private readonly useBatchKeywordSearch: boolean = 
    process.env.USE_BATCH_KEYWORD_SEARCH !== 'false'; // Default true unless explicitly disabled

  constructor(extractCodeTool: ExtractCodeTool, weights?: Partial<Weights>) {
    this.extractCodeTool = extractCodeTool;
    this.weights = {
      bm25: 0.4,
      dense: 0.3,
      symbol: 0.2,
      evidence: 0.1,
      routeMatch: 0.0,
      softSignal: 0.0,
      astProximity: 0.0,
      gitRecency: 0.0,
      ...weights
    };
  }

  /**
   * Main hybrid retrieval orchestrator with improved fusion
   */
  public async retrieveHybrid(
    plan: SearchPlan,
    evidence: Evidence,
    fileInfos: Map<string, FileInfo>,
    model: string,
    projectId: string
  ): Promise<CandidateFile[]> {
    // Get base scores from existing methods
    const [llmMap, kwMap] = await Promise.all([
      this.getLLMFileScores(plan, fileInfos, model, projectId),
      this.getKeywordScores(plan, fileInfos, model, projectId)
    ]);

    // Keep top-N per source to control cost
    const llmTop = this.getTopN(llmMap, this.maxCandidatesPerSource);
    const kwTop = this.getTopN(kwMap, this.maxCandidatesPerSource);

    // Build universe of files, filtering noise
    const allFiles = [...new Set([...llmTop.keys(), ...kwTop.keys()])]
      .filter(p => !this.isNoise(p));

    // Precompute sets once for performance
    const frameFiles = new Set(evidence.frames.map(f => f.file));
    const frameDirs = new Set(evidence.frames.map(f => this.getDirectory(f.file)));
    
    // Normalize source scores
    const normL = this.minMaxNormalize([...llmTop.values()]);
    const normK = this.minMaxNormalize([...kwTop.values()]);
    
    // Build rank maps for RRF
    const ranks = this.buildRankMaps(llmTop, kwTop);

    // Apply mode-based weighting
    this.applyModeBasedWeights(plan.mode, evidence);

    const candidates: CandidateFile[] = [];
    const audits = new Map<string, Audit>();

    for (const file of allFiles) {
      const fileInfo = fileInfos.get(file);
      if (!fileInfo) continue;

      // Get normalized scores
      const bm25 = normK(kwTop.get(file) ?? 0);
      const dense = normL(llmTop.get(file) ?? 0);
      const symbol = this.symbolScore(fileInfo, plan, evidence);
      const evidenceScore = this.evidenceScoreContinuous(file, frameFiles, frameDirs, evidence);

      // Get new mode-specific scores
      const routeMatch = this.routeMatchScore(file, evidence, fileInfo);
      const softSignal = this.softSignalScore(file, evidence, fileInfo);
      const astProximity = this.astProximityScore(file, evidence, fileInfo);
      const gitRecency = this.gitRecencyScore(file, evidence, fileInfo);

      // Rank-fusion safeguard
      const rrf = this.reciprocalRankFusion(ranks.get(file)?.llm, ranks.get(file)?.keyword);
      
      // Combine scores with mode-specific weights
      const combined = this.combineScoresWithMode(
        { bm25, dense, symbol, evidence: evidenceScore, routeMatch, softSignal, astProximity, gitRecency }, 
        this.weights
      ) + rrf;
      
      // Apply sigmoid to compress outliers
      const finalScore = this.sigmoid(combined);

      // Build audit trail
      const audit: Audit = {
        bm25,
        dense,
        symbol,
        evidence: { 
          frame: evidenceScore, 
          routeMatch, 
          softSignal, 
          astProximity, 
          gitRecency 
        },
        fused: combined,
        ranks: ranks.get(file)
      };
      audits.set(file, audit);

      const candidateSymbols = this.buildCandidateSymbols(fileInfo, finalScore);

      candidates.push({
        file,
        score: finalScore,
        evidence: this.buildEvidenceList(file, { bm25, dense, symbol, evidence: evidenceScore }, evidence),
        symbols: candidateSymbols.length ? candidateSymbols : undefined,
        debug: audit
      });
    }

    // Sort by score (descending)
    const sortedCandidates = candidates.sort((a, b) => b.score - a.score);

    // Apply tiered caps for progressive degradation
    const totalCandidates = sortedCandidates.length;
    let tierIndex = 0;
    let maxCandidates = MAX_CANDIDATE_FILES_TIERED[0];

    // Determine which tier to use based on total candidates (progressive degradation)
    if (totalCandidates > MAX_CANDIDATE_FILES_TIERED[0]) {
      tierIndex = 0;
      maxCandidates = MAX_CANDIDATE_FILES_TIERED[0];
    } else if (totalCandidates > MAX_CANDIDATE_FILES_TIERED[1]) {
      tierIndex = 1;
      maxCandidates = MAX_CANDIDATE_FILES_TIERED[1];
    } else if (totalCandidates > MAX_CANDIDATE_FILES_TIERED[2]) {
      tierIndex = 2;
      maxCandidates = MAX_CANDIDATE_FILES_TIERED[2];
    } else {
      // No cap needed, use all candidates
      return sortedCandidates;
    }

    const cappedCandidates = sortedCandidates.slice(0, maxCandidates);
    
    // Log tier chosen and reason
    if (totalCandidates > maxCandidates) {
      console.log(`[HybridRetriever] Applied tier ${tierIndex + 1} cap: ${totalCandidates} candidates → ${maxCandidates} (reason: too many matches, tiered limits: ${MAX_CANDIDATE_FILES_TIERED.join(' → ')})`);
    }

    return cappedCandidates;
  }

  /**
   * Get LLM-based file scores using existing method
   */
  private async getLLMFileScores(
    plan: SearchPlan,
    fileInfos: Map<string, FileInfo>,
    model: string,
    projectId: string
  ): Promise<Map<string, number>> {
    // Use existing rankRelevantFileswithLLM method
    const query = plan.queries.join(' ');
    const llmResults = await this.extractCodeTool['rankRelevantFileswithLLM'](
      fileInfos,
      query,
      projectId,
      model
    );

    // Convert to score map with better scoring
    const scores = new Map<string, number>();
    for (const [filePath, elements] of llmResults) {
      // Improved scoring based on element relevance
      const score = elements.length > 0 ? Math.min(1, elements.length / 5) : 0;
      scores.set(filePath, score);
    }

    return scores;
  }

  /**
   * Get keyword-based scores using batched search API for improved performance
   * 
   * When useBatchKeywordSearch is true (default), uses the batch API to process all queries,
   * symbols, and error tokens in a single pass, eliminating redundant file scans while preserving
   * the same scoring logic (score = min(1, elements.length / 3), then max across all tokens).
   * 
   * When useBatchKeywordSearch is false, falls back to the original loop-based implementation
   * for compatibility testing and parity verification.
   */
  private async getKeywordScores(
    plan: SearchPlan,
    fileInfos: Map<string, FileInfo>,
    model: string,
    projectId: string
  ): Promise<Map<string, number>> {
    if (this.useBatchKeywordSearch) {
      return this.getKeywordScoresBatch(plan, fileInfos, model);
    } else {
      return this.getKeywordScoresLegacy(plan, fileInfos, model, projectId);
    }
  }

  /**
   * Batch-based implementation (new, default)
   */
  private async getKeywordScoresBatch(
    plan: SearchPlan,
    fileInfos: Map<string, FileInfo>,
    model: string
  ): Promise<Map<string, number>> {
    // Extract queries, symbols, and error tokens separately for batch processing
    const queries = plan.queries;
    const symbols = plan.symbols;
    const errorTokens = this.extractErrorTokens(plan, fileInfos);

    // Use batch API to process all tokens in a single pass
    const batchResults = await this.extractCodeTool['performKeywordBasedSearchBatch'](
      fileInfos,
      {
        queries,
        symbols,
        errorTokens,
        filenameKeywords: plan.candidateFiles,
        options: {
          caseSensitive: false,
          maxResultsPerFile: 20
        }
      }
    );

    // Handle case where batch API returns undefined or null
    if (!batchResults) {
      return new Map<string, number>();
    }

    // Compute scores with per-token attribution (preserving original scoring logic)
    const allScores = new Map<string, number>();
    const contributions = new Map<string, Record<string, number>>(); // For explainability

    // For each file, compute score based on all matching tokens
    for (const [filePath, tokenMatches] of batchResults.entries()) {
      let maxScore = 0;
      const fileContributions: Record<string, number> = {};

      // Process each token match for this file
      for (const tokenMatch of tokenMatches) {
        // Compute score for this token: same logic as original (min(1, elements.length / 3))
        const tokenScore = tokenMatch.elements.length > 0 
          ? Math.min(1, tokenMatch.elements.length / 3) 
          : 0;

        // Track max score across all tokens (same as original: Math.max across queries)
        maxScore = Math.max(maxScore, tokenScore);

        // Track contributions for explainability
        const tokenKey = `${tokenMatch.kind}:${tokenMatch.token}`;
        fileContributions[tokenKey] = (fileContributions[tokenKey] || 0) + tokenScore;
      }

      if (maxScore > 0) {
        allScores.set(filePath, maxScore);
        contributions.set(filePath, fileContributions);
      }
    }

    return allScores;
  }

  /**
   * Legacy loop-based implementation (old, for parity testing)
   */
  private async getKeywordScoresLegacy(
    plan: SearchPlan,
    fileInfos: Map<string, FileInfo>,
    model: string,
    projectId: string
  ): Promise<Map<string, number>> {
    // Build multiple atomic queries for better scoring
    const queries = [
      ...plan.queries,
      ...plan.symbols,
      ...this.extractErrorTokens(plan, fileInfos)
    ];

    const allScores = new Map<string, number>();

    // Score each query separately and take max
    for (const query of queries) {
      const keywordResults = await this.extractCodeTool['performKeywordBasedSearch'](
        fileInfos,
        {
          query,
          projectId,
          model,
          filenameKeywords: plan.candidateFiles,
          methodNameKeywords: plan.symbols,
          codeKeywords: [query],
          maxIterations: 1,
          maxDependencyDepth: 1,
          manuallyPinnedFilePaths: []
        }
      );

      for (const [filePath, elements] of keywordResults) {
        const score = elements.length > 0 ? Math.min(1, elements.length / 3) : 0;
        const currentScore = allScores.get(filePath) || 0;
        allScores.set(filePath, Math.max(currentScore, score));
      }
    }

    return allScores;
  }

  /**
   * Calculate symbol score based on plan symbols and evidence frames
   */
  private symbolScore(fileInfo: FileInfo, plan: SearchPlan, evidence: Evidence): number {
    const names = new Set<string>(plan.symbols.map(s => s.toLowerCase()));
    
    // Add function names from evidence frames
    for (const frame of evidence.frames) {
      if (frame.fn) {
        names.add(frame.fn.toLowerCase());
      }
    }

    // Get symbols from file info (assuming FileInfo has symbols property)
    const fileSymbols = (fileInfo as any).symbols || [];
    const syms = fileSymbols.map((s: any) => s.toLowerCase());
    
    // Count symbol hits
    const hits = syms.filter((s: any) => [...names].some(n => s.includes(n))).length;

    // Path token matching
    const pathTokens = fileInfo.path.toLowerCase().split(/[\/.-_]/g);
    const tokenHits = [...names].filter(n => pathTokens.includes(n)).length;

    return Math.min(1, 0.7 * (hits / 5) + 0.3 * (tokenHits / 3));
  }

  /**
   * Calculate continuous evidence score with alias and route awareness
   */
  private evidenceScoreContinuous(
    file: string,
    frameFiles: Set<string>,
    frameDirs: Set<string>,
    evidence: Evidence
  ): number {
    const dir = this.getDirectory(file);
    const isFrame = frameFiles.has(file) ? 1 : 0;
    const sameDir = [...frameDirs].reduce((m, d) => Math.max(m, this.dirSimilarity(dir, d)), 0);
    const route = evidence.route ? this.routeHeuristic(evidence.route, file) : 0;
    const errTok = evidence.error ? this.errorTokenMatch(evidence.error, file) : 0;

    return Math.min(1, 0.6 * isFrame + 0.25 * sameDir + 0.1 * route + 0.05 * errTok);
  }

  /**
   * Calculate directory similarity
   */
  private dirSimilarity(a: string, b: string): number {
    const A = a.split('/');
    const B = b.split('/');
    let i = 0;
    while (i < Math.min(A.length, B.length) && A[i] === B[i]) i++;
    return i / Math.max(A.length, B.length);
  }

  /**
   * Route-based file matching heuristic
   */
  private routeHeuristic(route: string, filePath: string): number {
    const r = route.replace(/^\/+|\/+$/g, '');
    const fp = filePath.toLowerCase();
    // Check for various route patterns - don't double up the api prefix
    return +(fp.includes(`/api/${r}`) || 
             fp.includes(`/pages/api/${r}`) || 
             fp.endsWith(`/api/${r}/route.ts`) ||
             fp.includes(`api/${r}`) ||
             fp.includes(`/${r}`)); // Also check for just the route part
  }

  /**
   * Check for error token matches in filename
   */
  private errorTokenMatch(error: string, filePath: string): number {
    const keywords = this.extractKeywords(error);
    const fileName = this.getFileName(filePath).toLowerCase();
    return +keywords.some(k => fileName.includes(k.toLowerCase()));
  }

  /**
   * Extract error tokens from plan and evidence
   */
  private extractErrorTokens(plan: SearchPlan, fileInfos: Map<string, FileInfo>): string[] {
    const tokens = new Set<string>();
    
    // Add tokens from plan queries
    plan.queries.forEach(q => {
      this.extractKeywords(q).forEach(t => tokens.add(t));
    });

    // Add camelCase splits
    plan.symbols.forEach(s => {
      const camelSplit = s.replace(/([A-Z])/g, ' $1').toLowerCase().trim();
      this.extractKeywords(camelSplit).forEach(t => tokens.add(t));
    });

    return Array.from(tokens);
  }

  /**
   * Min-max normalization utility
   */
  private minMaxNormalize(values: number[]): (x: number) => number {
    if (values.length === 0) return () => 0;
    const min = Math.min(...values);
    const max = Math.max(...values);
    const den = Math.max(1e-9, max - min);
    return (x) => (x - min) / den;
  }

  /**
   * Reciprocal Rank Fusion
   */
  private reciprocalRankFusion(rankA?: number, rankB?: number, k: number = this.rrfK): number {
    const a = rankA != null ? 1 / (k + rankA) : 0;
    const b = rankB != null ? 1 / (k + rankB) : 0;
    return a + b;
  }

  /**
   * Build rank maps for RRF
   */
  private buildRankMaps(llmMap: Map<string, number>, kwMap: Map<string, number>): Map<string, { llm?: number; keyword?: number }> {
    const ranks = new Map<string, { llm?: number; keyword?: number }>();
    
    [...llmMap.keys()].forEach((f, i) => {
      const existing = ranks.get(f) || {};
      ranks.set(f, { ...existing, llm: i + 1 });
    });
    
    [...kwMap.keys()].forEach((f, i) => {
      const existing = ranks.get(f) || {};
      ranks.set(f, { ...existing, keyword: i + 1 });
    });
    
    return ranks;
  }

  /**
   * Get top N items from a map
   */
  private getTopN(map: Map<string, number>, n: number): Map<string, number> {
    return new Map([...map.entries()].sort((a, b) => b[1] - a[1]).slice(0, n));
  }

  /**
   * Check if file is noise (build artifacts, etc.)
   */
  private isNoise(path: string): boolean {
    return /(^|\/)(node_modules|dist|build|coverage|\.next|out)(\/|$)/.test(path) ||
           /\.snap$/.test(path) ||
           /(^|\/)src\/__generated__(\/|$)/.test(path);
  }

  /**
   * Sigmoid function to compress outliers
   */
  private sigmoid(x: number): number {
    return 1 / (1 + Math.exp(-4 * (x - 0.5)));
  }

  /**
   * Combine scores using weighted sum
   */
  private combineScores(scores: ScoreComponents, weights: Weights): number {
    return weights.bm25 * scores.bm25 + 
           weights.dense * scores.dense + 
           weights.symbol * scores.symbol + 
           weights.evidence * scores.evidence;
  }

  /**
   * Build evidence list for a file
   */
  private buildEvidenceList(filePath: string, scores: ScoreComponents, evidence: Evidence): string[] {
    const evidenceList: string[] = [];
    
    if (scores.evidence > 0.5) {
      evidenceList.push('stack_trace');
    }
    
    if (scores.dense > 0.3) {
      evidenceList.push('llm_relevance');
    }
    
    if (scores.bm25 > 0.3) {
      evidenceList.push('keyword_match');
    }
    
    if (scores.symbol > 0.3) {
      evidenceList.push('symbol_match');
    }
    
    // Check for specific evidence
    const frameFiles = evidence.frames.map(f => f.file);
    if (frameFiles.includes(filePath)) {
      evidenceList.push('error_frame');
    }
    
    const frameDirs = evidence.frames.map(f => this.getDirectory(f.file));
    const fileDir = this.getDirectory(filePath);
    if (frameDirs.includes(fileDir)) {
      evidenceList.push('same_directory');
    }
    
    return evidenceList;
  }

  private buildCandidateSymbols(fileInfo: FileInfo, candidateScore: number): CandidateSymbolRef[] {
    const maxSymbols = 5;
    const elements = fileInfo.elements.filter((element) => this.isEligibleSymbolElement(element)).slice(0, maxSymbols);

    return elements.map((element, index) => {
      const symbolName = element.name || `${element.type}_${index}`;
      const startLine = element.lineStart ?? 1;
      const endLine = element.lineEnd ?? element.lineStart ?? startLine;
      const evidence: string[] = [];

      if (element.metadata?.isExported) {
        evidence.push('exported');
      }

      return {
        file: fileInfo.path,
        symbol: symbolName,
        startLine,
        endLine,
        score: Math.max(candidateScore, 0.1),
        evidence
      };
    });
  }

  private isEligibleSymbolElement(element: CodeElement): boolean {
    if (!element?.name) {
      return false;
    }

    const allowedTypes: CodeElement['type'][] = [
      'function',
      'method',
      'class',
      'arrow_function',
      'interface',
      'struct',
      'enum',
      'type_definition'
    ];

    return allowedTypes.includes(element.type);
  }

  /**
   * Extract keywords from text
   */
  private extractKeywords(text: string): string[] {
    return text
      .toLowerCase()
      .replace(/[^\w\s]/g, ' ')
      .split(/\s+/)
      .filter(word => word.length > 2)
      .slice(0, 5); // Limit to 5 keywords
  }

  /**
   * Get directory from file path
   */
  private getDirectory(filePath: string): string {
    const parts = filePath.split('/');
    return parts.slice(0, -1).join('/');
  }

  /**
   * Get file name from file path
   */
  private getFileName(filePath: string): string {
    const parts = filePath.split('/');
    return parts[parts.length - 1];
  }

  /**
   * Apply mode-based weighting based on debugging mode
   */
  private applyModeBasedWeights(mode: 'hard-error' | 'soft-error' | 'behavior-first', evidence: Evidence): void {
    switch (mode) {
      case 'hard-error':
        // Existing weights for hard errors
        this.weights.bm25 = 0.25;
        this.weights.dense = 0.20;
        this.weights.symbol = 0.15;
        this.weights.evidence = 0.40;
        this.weights.routeMatch = 0.0;
        this.weights.softSignal = 0.0;
        this.weights.astProximity = 0.0;
        this.weights.gitRecency = 0.0;
        break;
        
      case 'soft-error':
        // Soft-error mode: prioritize route matching and soft signals
        this.weights.bm25 = 0.20;
        this.weights.dense = 0.20;
        this.weights.symbol = 0.15;
        this.weights.evidence = 0.0;
        this.weights.routeMatch = 0.30;
        this.weights.softSignal = 0.25;
        this.weights.astProximity = 0.15;
        this.weights.gitRecency = 0.10;
        break;
        
      case 'behavior-first':
        // No-log mode: rely on behavior and code patterns
        this.weights.bm25 = 0.35;
        this.weights.dense = 0.25;
        this.weights.symbol = 0.20;
        this.weights.evidence = 0.0;
        this.weights.routeMatch = 0.0;
        this.weights.softSignal = 0.0;
        this.weights.astProximity = 0.20;
        this.weights.gitRecency = 0.20;
        break;
    }
  }

  /**
   * Score based on route/HTTP matching
   */
  private routeMatchScore(file: string, evidence: Evidence, fileInfo: FileInfo): number {
    if (!evidence.httpSpans || evidence.httpSpans.length === 0) {
      return 0;
    }

    let score = 0;
    const fileName = this.getFileName(file).toLowerCase();
    
    for (const span of evidence.httpSpans) {
      const url = span.url.toLowerCase();
      
      // Check if file path matches route patterns
      if (url.includes('/api/') && file.includes('/api/')) {
        score += 0.8;
      }
      if (url.includes('/pages/') && file.includes('/pages/')) {
        score += 0.8;
      }
      if (url.includes('/app/') && file.includes('/app/')) {
        score += 0.8;
      }
      
      // Check for handler patterns
      if (fileName.includes('handler') || fileName.includes('controller')) {
        score += 0.6;
      }
      
      // Check for route-specific files
      const routeName = url.split('/').pop()?.split('?')[0];
      if (routeName && fileName.includes(routeName)) {
        score += 0.9;
      }
    }
    
    return Math.min(score, 1.0);
  }

  /**
   * Score based on soft signal keyword proximity
   */
  private softSignalScore(file: string, evidence: Evidence, fileInfo: FileInfo): number {
    if (!evidence.softSignals || evidence.softSignals.length === 0) {
      return 0;
    }

    let score = 0;
    const fileName = this.getFileName(file).toLowerCase();
    
    for (const signal of evidence.softSignals) {
      const signalText = signal.text.toLowerCase();
      
      // Check file name matches
      if (fileName.includes(signal.kind) || fileName.includes(signalText)) {
        score += 0.7;
      }
      
      // Check for related patterns in file name
      if (signal.kind === 'timeout' && (fileName.includes('timeout') || fileName.includes('retry'))) {
        score += 0.6;
      }
      if (signal.kind === 'empty' && (fileName.includes('empty') || fileName.includes('length'))) {
        score += 0.6;
      }
      
      // Check for common patterns in file path
      if (signal.kind === 'http' && (file.includes('api') || file.includes('handler'))) {
        score += 0.5;
      }
    }
    
    return Math.min(score, 1.0);
  }

  /**
   * Score based on AST proximity to entry points
   */
  private astProximityScore(file: string, evidence: Evidence, fileInfo: FileInfo): number {
    if (!evidence.behaviorHints || evidence.behaviorHints.length === 0) {
      return 0;
    }

    let score = 0;
    const fileName = this.getFileName(file).toLowerCase();
    
    for (const hint of evidence.behaviorHints) {
      const hintValue = hint.value.toLowerCase();
      
      // Check for component matches
      if (hint.kind === 'component' && fileName.includes(hintValue)) {
        score += 0.9;
      }
      
      // Check for route matches
      if (hint.kind === 'route' && file.includes(hintValue)) {
        score += 0.8;
      }
      
      // Check for API matches in file name
      if (hint.kind === 'api' && fileName.includes(hintValue)) {
        score += 0.7;
      }
      
      // Check for label matches in file name (common in component files)
      if (hint.kind === 'label' && fileName.includes(hintValue)) {
        score += 0.6;
      }
      
      // Check for common patterns in file path
      if (hint.kind === 'component' && (file.includes('components') || file.includes('pages'))) {
        score += 0.5;
      }
      if (hint.kind === 'api' && (file.includes('api') || file.includes('services'))) {
        score += 0.5;
      }
    }
    
    return Math.min(score, 1.0);
  }

  /**
   * Score based on git recency (placeholder - would need git service)
   */
  private gitRecencyScore(file: string, evidence: Evidence, fileInfo: FileInfo): number {
    // This is a placeholder implementation
    // In a real implementation, this would check git history
    // For now, return a small random score to avoid bias
    return Math.random() * 0.3;
  }

  /**
   * Combine scores with mode-specific weights
   */
  private combineScoresWithMode(
    scores: ScoreComponents & { routeMatch: number; softSignal: number; astProximity: number; gitRecency: number }, 
    weights: Weights
  ): number {
    return weights.bm25 * scores.bm25 + 
           weights.dense * scores.dense + 
           weights.symbol * scores.symbol + 
           weights.evidence * scores.evidence +
           (weights.routeMatch || 0) * scores.routeMatch +
           (weights.softSignal || 0) * scores.softSignal +
           (weights.astProximity || 0) * scores.astProximity +
           (weights.gitRecency || 0) * scores.gitRecency;
  }

  /**
   * Update weights based on feedback (for future learning)
   */
  public updateWeights(feedback: { file: string; isRelevant: boolean }[]): void {
    // Simple weight adjustment based on feedback
    // This is a placeholder for more sophisticated learning algorithms
    const relevantFiles = feedback.filter(f => f.isRelevant).length;
    const totalFiles = feedback.length;
    
    if (totalFiles > 0) {
      const relevanceRate = relevantFiles / totalFiles;
      
      // Adjust weights slightly based on performance
      if (relevanceRate > 0.7) {
        // Good performance, maintain current weights
        return;
      } else if (relevanceRate < 0.3) {
        // Poor performance, adjust weights
        this.weights.evidence *= 1.1; // Increase evidence weight
        this.weights.symbol *= 1.05; // Increase symbol weight
      }
    }
  }

  /**
   * Get current weights for debugging
   */
  public getWeights(): Weights {
    return { ...this.weights };
  }
}