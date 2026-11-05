/**
 * Enhanced Report Generator for Root Cause Analysis
 * 
 * Formats comprehensive markdown diagnostic reports with precise anchors,
 * fail paths, calibrated confidence, and actionable fixes
 */

import { DebugContext, Hypothesis, RootCauseReport, FindingFeedback } from './rootCauseTypes';

interface FailPathNode {
  nodeId: string;
  label: string;
  file: string;
  line?: number;
}

interface Anchor {
  file: string;
  start: number;
  end?: number;
  symbol?: string;
}

interface DiffHunk {
  file: string;
  commit: string;
  hunk: string;
}

interface TestCase {
  name: string;
  kind: 'unit' | 'integration';
  code: string;
}

interface Patch {
  file: string;
  diff: string;
}

interface Redaction {
  kind: 'secret' | 'pii' | 'token';
  placeholder: string;
  original: string;
}

interface EnhancedRootCauseReport extends RootCauseReport {
  failPath?: FailPathNode[];
  anchors?: Anchor[];
  diffHunks?: DiffHunk[];
  tests?: TestCase[];
  patches?: Patch[];
  redactions?: Redaction[];
  infoRequests?: any[];
}

export class ReportGenerator {
  private readonly MAX_EVIDENCE_ITEMS = 10;
  private readonly MAX_LOG_LINES = 5;

  /**
   * Generate comprehensive root cause analysis report
   */
  generateReport(
    hypotheses: Hypothesis[],
    debugContext: DebugContext,
    feedback: FindingFeedback[],
    timings: Record<string, number>,
    workspaceRoot?: string,
    infoRequests?: any[],
    style?: "default" | "samurai"
  ): EnhancedRootCauseReport {
    console.log('[ReportGenerator] Generating enhanced root cause report');

    // Sort hypotheses by normalized confidence
    const sortedHypotheses = this.sortHypotheses(hypotheses, feedback);
    const topHypothesis = sortedHypotheses[0] || null;
    
    // Generate enhanced components
    const summary = this.generateSummary(debugContext, topHypothesis, style);
    const likelyRootCause = this.generateLikelyRootCause(topHypothesis, debugContext);
    const reasoningSteps = this.generateReasoningSteps(sortedHypotheses, feedback, debugContext);
    const recommendedFix = this.generateRecommendedFix(topHypothesis, debugContext, feedback);
    const evidence = this.generateEvidenceList(debugContext, topHypothesis);
    const confidenceSummaryTable = this.generateConfidenceSummaryTable(sortedHypotheses, feedback);
    
    // Calculate calibrated confidence
    const overallConfidence = this.computeNormalizedConfidence(sortedHypotheses, feedback, debugContext);
    
    // Generate enhanced components
    const failPath = this.buildFailPath(debugContext.graph, topHypothesis, debugContext);
    const anchors = this.collectAnchors(topHypothesis, debugContext);
    const diffHunks = this.collectDiffHunks(topHypothesis, debugContext);
    const tests = this.generateTestCases(topHypothesis, debugContext);
    const patches = this.generatePatches(topHypothesis, debugContext);
    const redactions = this.identifyRedactions(debugContext);
    
    // Generate clarifying questions and quick actions
    const clarifyingQuestions = this.generateClarifyingQuestions(debugContext, topHypothesis, overallConfidence);
    const recommendedQuickActions = this.generateQuickActions(debugContext, topHypothesis);

    const report: EnhancedRootCauseReport = {
      summary,
      likelyRootCause,
      reasoningSteps,
      recommendedFix,
      evidence,
      confidence: overallConfidence,
      hypotheses: sortedHypotheses,
      confidenceSummaryTable,
      timings,
      clarifyingQuestions,
      recommendedQuickActions,
      failPath,
      anchors,
      diffHunks,
      tests,
      patches,
      redactions,
      infoRequests
    };

    console.log('[ReportGenerator] Enhanced report generated with confidence:', overallConfidence);
    return report;
  }

  /**
   * Sort hypotheses by normalized confidence, path length, and git recency
   */
  private sortHypotheses(hypotheses: Hypothesis[], feedback: FindingFeedback[]): Hypothesis[] {
    return [...hypotheses].sort((a, b) => {
      // Primary: normalized confidence (descending)
      const aConf = this.computeNormalizedConfidence([a], feedback, {} as DebugContext);
      const bConf = this.computeNormalizedConfidence([b], feedback, {} as DebugContext);
      if (Math.abs(aConf - bConf) > 0.01) return bConf - aConf;
      
      // Secondary: path length (ascending) - shorter paths are better
      const aPathLen = this.calculatePathLength(a, {} as DebugContext);
      const bPathLen = this.calculatePathLength(b, {} as DebugContext);
      if (aPathLen !== bPathLen) return aPathLen - bPathLen;
      
      // Tertiary: git recency (descending) - more recent is better
      const aRecency = this.calculateGitRecency(a, {} as DebugContext);
      const bRecency = this.calculateGitRecency(b, {} as DebugContext);
      return bRecency - aRecency;
    });
  }

  /**
   * Compute normalized confidence using deterministic scoring
   */
  private computeNormalizedConfidence(
    hypotheses: Hypothesis[],
    feedback: FindingFeedback[],
    debugContext: DebugContext
  ): number {
    if (hypotheses.length === 0) return 0;
    
    const hypothesis = hypotheses[0];
    const feedbackForHypothesis = feedback.find(f => f.hypothesisId === hypothesis.id);
    
    // Path score (1 - normalized shortest path length)
    const pathLength = this.calculatePathLength(hypothesis, debugContext);
    const pathScore = pathLength > 0 ? 1 / (1 + pathLength) : 0;
    
    // Git recency score (exponential decay)
    const gitRecencyScore = this.calculateGitRecency(hypothesis, debugContext);
    
    // Evidence richness (distinct evidence types)
    const evidenceRichness = this.calculateEvidenceRichness(hypothesis, debugContext);
    
    // Test verdict score
    const verdictScore = this.calculateVerdictScore(feedbackForHypothesis);
    
    // Consistency score (logs + frames reference same files/nodes)
    const consistencyScore = this.calculateConsistencyScore(hypothesis, debugContext);
    
    // Weighted combination
    const normalizedConfidence = 
      0.25 * pathScore +
      0.2 * gitRecencyScore +
      0.2 * evidenceRichness +
      0.25 * verdictScore +
      0.1 * consistencyScore;
    
    return Math.max(0, Math.min(1, normalizedConfidence));
  }

  /**
   * Calculate path length from error nodes to hypothesis
   */
  private calculatePathLength(hypothesis: Hypothesis, debugContext: DebugContext): number {
    const errorNodes = debugContext.graph?.nodes?.filter(node => node.badges?.includes('error')) || [];
    if (errorNodes.length === 0) return 0;
    
    // Simplified path length calculation
    const hypothesisNodes = new Set(hypothesis.relatedNodes);
    const hasDirectConnection = errorNodes.some(errorNode => 
      hypothesisNodes.has(errorNode.id) ||
      debugContext.graph?.edges?.some(edge => 
        edge.from === errorNode.id && hypothesisNodes.has(edge.to)
      )
    );
    
    return hasDirectConnection ? 1 : 3; // 1 for direct, 3 for indirect/unknown
  }

  /**
   * Calculate git recency score
   */
  private calculateGitRecency(hypothesis: Hypothesis, debugContext: DebugContext): number {
    if (!debugContext.gitChanges?.length) return 0.5;
    
    const now = Date.now();
    const halfLife = 7 * 24 * 60 * 60 * 1000; // 7 days
    
    const relevantChanges = debugContext.gitChanges.filter(change =>
      change.files?.some(f => hypothesis.relatedFiles.includes(f.path))
    );
    
    if (relevantChanges.length === 0) return 0.3;
    
    const mostRecent = relevantChanges[0];
    const daysSince = (now - mostRecent.date.getTime()) / (24 * 60 * 60 * 1000);
    
    return Math.exp(-daysSince / 7);
  }

  /**
   * Calculate evidence richness score
   */
  private calculateEvidenceRichness(hypothesis: Hypothesis, debugContext: DebugContext): number {
    const evidenceTypes = new Set<string>();
    
    // Stack frames
    if (debugContext.evidence?.frames?.length) evidenceTypes.add('stack');
    
    // Graph nodes
    if (hypothesis.relatedNodes?.length) evidenceTypes.add('graph');
    
    // Git changes
    if (debugContext.gitChanges?.length) evidenceTypes.add('git');
    
    // Snippets
    if (hypothesis.verifiedSnippets?.length) evidenceTypes.add('snippet');
    
    // Heuristics
    if (debugContext.heuristicFindings?.length) evidenceTypes.add('heuristic');
    
    return Math.min(evidenceTypes.size / 5, 1);
  }

  /**
   * Calculate verdict score
   */
  private calculateVerdictScore(feedback: FindingFeedback | undefined): number {
    if (!feedback) return 0.5;
    
    switch (feedback.verdict) {
      case 'confirmed': return 1.0;
      case 'uncertain': return 0.5;
      case 'refuted': return 0.0;
      default: return 0.5;
    }
  }

  /**
   * Calculate consistency score
   */
  private calculateConsistencyScore(hypothesis: Hypothesis, debugContext: DebugContext): number {
    const hypothesisFiles = new Set(hypothesis.relatedFiles);
    const frameFiles = new Set(debugContext.evidence?.frames?.map(f => f.file) || []);
    
    const overlap = [...hypothesisFiles].filter(f => frameFiles.has(f)).length;
    const total = Math.max(hypothesisFiles.size, frameFiles.size);
    
    return total > 0 ? overlap / total : 0.5;
  }

  /**
   * Build fail path from error nodes to hypothesis
   */
  private buildFailPath(
    graph: { nodes: any[]; edges: any[] },
    topHypothesis: Hypothesis | null,
    debugContext: DebugContext
  ): FailPathNode[] {
    if (!topHypothesis || !graph?.nodes?.length) return [];
    
    const errorNodes = graph.nodes.filter(node => node.badges?.includes('error'));
    if (errorNodes.length === 0) return [];
    
    const hypothesisNodes = topHypothesis.relatedNodes;
    const path: FailPathNode[] = [];
    
    // Find shortest path (simplified)
    for (const errorNode of errorNodes) {
      for (const hypothesisNode of hypothesisNodes) {
        const node = graph.nodes.find(n => n.id === hypothesisNode);
        if (node) {
          path.push({
            nodeId: node.id,
            label: node.label,
            file: node.file || 'unknown',
            line: node.line
          });
        }
      }
    }
    
    return path.slice(0, 5); // Limit to 5 nodes
  }

  /**
   * Collect anchors for VS Code links
   */
  private collectAnchors(topHypothesis: Hypothesis | null, debugContext: DebugContext): Anchor[] {
    const anchors: Anchor[] = [];
    
    if (topHypothesis?.relatedFiles?.length) {
      topHypothesis.relatedFiles.forEach(file => {
        anchors.push({
          file,
          start: 1,
          end: 1,
          symbol: 'file'
        });
      });
    }
    
    // Add stack frame anchors
    debugContext.evidence?.frames?.forEach(frame => {
      anchors.push({
        file: frame.file,
        start: frame.line,
        end: frame.line,
        symbol: frame.fn
      });
    });
    
    return anchors.slice(0, 10); // Limit to 10 anchors
  }

  /**
   * Collect diff hunks for relevant commits
   */
  private collectDiffHunks(topHypothesis: Hypothesis | null, debugContext: DebugContext): DiffHunk[] {
    const hunks: DiffHunk[] = [];
    
    if (!topHypothesis?.relatedFiles?.length || !debugContext.gitChanges?.length) {
      return hunks;
    }
    
    const relevantCommits = debugContext.gitChanges.filter(change =>
      change.files?.some(f => topHypothesis.relatedFiles.includes(f.path))
    );
    
    relevantCommits.slice(0, 3).forEach(commit => {
      const relevantFile = commit.files?.find(f => 
        topHypothesis.relatedFiles.includes(f.path)
      );
      
      if (relevantFile) {
        hunks.push({
          file: relevantFile.path,
          commit: commit.hash.substring(0, 8),
          hunk: `+${relevantFile.additions || 0} -${relevantFile.deletions || 0}`
        });
      }
    });
    
    return hunks;
  }

  /**
   * Generate test cases for the hypothesis
   */
  private generateTestCases(topHypothesis: Hypothesis | null, debugContext: DebugContext): TestCase[] {
    if (!topHypothesis) return [];
    
    const tests: TestCase[] = [];
    
    // Generate unit test based on hypothesis type
    if (topHypothesis.summary.toLowerCase().includes('null')) {
      tests.push({
        name: 'should handle null input gracefully',
        kind: 'unit',
        code: `it('should handle null input gracefully', () => {
  expect(() => processUser(null)).toThrow('User cannot be null');
});`
      });
    }
    
    if (topHypothesis.summary.toLowerCase().includes('async')) {
      tests.push({
        name: 'should properly await async operations',
        kind: 'unit',
        code: `it('should properly await async operations', async () => {
  const result = await fetchData();
  expect(result).toBeDefined();
});`
      });
    }
    
    return tests;
  }

  /**
   * Generate patches for the hypothesis
   */
  private generatePatches(topHypothesis: Hypothesis | null, debugContext: DebugContext): Patch[] {
    if (!topHypothesis?.relatedFiles?.length) return [];
    
    const patches: Patch[] = [];
    const mainFile = topHypothesis.relatedFiles[0];
    
    if (topHypothesis.summary.toLowerCase().includes('null')) {
      patches.push({
        file: mainFile,
        diff: `@@ -1,3 +1,5 @@
-const result = user.name.toUpperCase();
+const result = user?.name?.toUpperCase() || '';
+if (!user) return res.status(400).json({ error: 'User required' });
`
      });
    }
    
    return patches;
  }

  /**
   * Identify redactions needed
   */
  private identifyRedactions(debugContext: DebugContext): Redaction[] {
    const redactions: Redaction[] = [];
    
    // Check logs for potential secrets
    const logContent = debugContext.logs || '';
    const secretPatterns = [
      /(password|pwd|pass)=[^\s]+/gi,
      /(token|key|secret)=[^\s]+/gi,
      /(api_key|apikey)=[^\s]+/gi
    ];
    
    secretPatterns.forEach(pattern => {
      const matches = logContent.match(pattern);
      matches?.forEach(match => {
        redactions.push({
          kind: 'secret',
          placeholder: '[REDACTED]',
          original: match
        });
      });
    });
    
    return redactions;
  }

  /**
   * Generate executive summary with fail path
   */
  private generateSummary(debugContext: DebugContext, topHypothesis: Hypothesis | null, style?: "default" | "samurai"): string {
    const samurai = style === "samurai";
    const evidence = debugContext.evidence;
    const fileCount = debugContext.candidates?.length || 0;
    const gitChanges = debugContext.gitChanges?.length || 0;
    
    const header = samurai
      ? "## ⚔️ Root Cause Analysis Report\n\n"
      : "## 🧩 Root Cause Analysis Report\n\n";
    
    let summary = header;
    
    // Mode-aware summary
    if (evidence?.hasHardError) {
      const exceptionLabel = samurai
        ? "**Enemy Identified (Exception):**"
        : "**Exception detected:**";
      summary += `${exceptionLabel} ${evidence.error || 'Unknown error'}\n\n`;
    } else if (evidence?.softSignals && evidence.softSignals.length > 0) {
      summary += `**No explicit exceptions detected.** Signals observed:\n`;
      const topSignals = evidence.softSignals.slice(0, 3);
      topSignals.forEach(signal => {
        summary += `- ${signal.kind.toUpperCase()}: ${signal.text}\n`;
      });
      summary += `\n`;
    } else if (evidence?.hasLogs) {
      summary += `**Logs provided but no errors detected.** Analysis based on description and log patterns.\n\n`;
    } else {
      summary += `**No logs provided.** Analysis based on description and code patterns.\n\n`;
    }
    
    if (topHypothesis) {
      const confidence = this.computeNormalizedConfidence([topHypothesis], [], debugContext);
      const rootCauseLabel = samurai
        ? "**Primary Target Located (Likely Root Cause):**"
        : "**Likely Root Cause:**";
      const confidenceText = samurai
        ? `${Math.round(confidence * 100)}% strike precision`
        : `${Math.round(confidence * 100)}% confidence`;
      summary += `${rootCauseLabel} ${topHypothesis.summary} (${confidenceText})\n\n`;
    } else {
      const statusLabel = samurai
        ? "**Battle Assessment Incomplete (Status):**"
        : "**Status:**";
      summary += `${statusLabel} Analysis inconclusive\n\n`;
    }
    
    const scopeLabel = samurai
      ? "**Battlefield Surveyed (Analysis Scope):**"
      : "**Analysis Scope:**";
    summary += `${scopeLabel} ${fileCount} files examined, ${gitChanges} recent commits analyzed\n\n`;
    
    return summary;
  }

  /**
   * Generate likely root cause with precise anchors
   */
  private generateLikelyRootCause(topHypothesis: Hypothesis | null, debugContext: DebugContext): string {
    if (!topHypothesis) {
      return 'Unable to determine root cause with current evidence';
    }

    let rootCause = topHypothesis.summary;
    
    // Add specific file references with line numbers
    if (topHypothesis.relatedFiles?.length > 0) {
      const mainFile = topHypothesis.relatedFiles[0];
      const frame = debugContext.evidence?.frames?.[0];
      if (frame && frame.file === mainFile) {
        rootCause += ` (${mainFile}:${frame.line})`;
      } else {
        rootCause += ` (${mainFile})`;
      }
    }
    
    return rootCause;
  }

  /**
   * Generate reasoning steps with fail path
   */
  private generateReasoningSteps(
    hypotheses: Hypothesis[],
    feedback: FindingFeedback[],
    debugContext: DebugContext
  ): string[] {
    const steps: string[] = [];
    
    // Add fail path if available
    const topHypothesis = hypotheses[0];
    if (topHypothesis) {
      const failPath = this.buildFailPath(debugContext.graph, topHypothesis, debugContext);
      if (failPath.length > 0) {
        const pathStr = failPath.map(p => `${p.label} (${p.file}${p.line ? `:${p.line}` : ''})`).join(' → ');
        steps.push(`**Fail Path:** ${pathStr}`);
      } else {
        steps.push('**Fail Path:** No graph path found from error to hypothesis; likely false positive or missing edges');
      }
    }
    
    // Add evidence-based steps
    if (debugContext.evidence?.frames?.length > 0) {
      const frame = debugContext.evidence.frames[0];
      steps.push(`Stack trace points to ${frame.file}:${frame.line}${frame.fn ? ` (${frame.fn})` : ''}`);
    }
    
    if (debugContext.gitChanges?.length > 0) {
      const recentChange = debugContext.gitChanges[0];
      const files = recentChange.files?.map(f => f.path).join(', ') || 'unknown files';
      steps.push(`Recent commit ${recentChange.hash.substring(0, 8)} modified ${files}`);
    }
    
    // Add hypothesis-specific steps
    if (topHypothesis) {
      steps.push(`Analysis suggests: ${topHypothesis.rationale}`);
      
      if (topHypothesis.evidence?.length > 0) {
        steps.push(`Supporting evidence: ${topHypothesis.evidence.slice(0, 2).join(', ')}`);
      }
    }
    
    // Add heuristic findings
    const highSeverityFindings = debugContext.heuristicFindings?.filter(f => f.severity === 'high') || [];
    if (highSeverityFindings.length > 0) {
      const finding = highSeverityFindings[0];
      steps.push(`Code analysis detected: ${finding.pattern} in ${finding.file}:${finding.line}`);
    }
    
    return steps;
  }

  /**
   * Generate recommended fix with heuristic-based guidance
   */
  private generateRecommendedFix(
    topHypothesis: Hypothesis | null, 
    debugContext: DebugContext,
    feedback: FindingFeedback[]
  ): string {
    if (!topHypothesis) {
      return 'Unable to provide specific fix without clear root cause identification';
    }

    let fix = `## 💡 Recommended Fix\n\n`;
    
    // Get heuristic tags from feedback
    const feedbackForHypothesis = feedback.find(f => f.hypothesisId === topHypothesis.id);
    const heuristicTags = this.extractHeuristicTags(topHypothesis, debugContext, feedbackForHypothesis);
    
    // Generate fix based on heuristic tags
    if (heuristicTags.includes('null_access')) {
      fix += this.generateNullAccessFix(topHypothesis);
    } else if (heuristicTags.includes('missing_await')) {
      fix += this.generateAsyncFix(topHypothesis);
    } else if (heuristicTags.includes('import_mismatch')) {
      fix += this.generateImportFix(topHypothesis);
    } else if (heuristicTags.includes('useEffect_deps')) {
      fix += this.generateHookFix(topHypothesis);
    } else {
      fix += this.generateGenericFix(topHypothesis);
    }
    
    // Add patch if available
    const patches = this.generatePatches(topHypothesis, debugContext);
    if (patches.length > 0) {
      fix += `\n**Candidate Patch**\n`;
      fix += `\`\`\`diff\n${patches[0].diff}\`\`\`\n\n`;
    }
    
    // Add test cases
    const tests = this.generateTestCases(topHypothesis, debugContext);
    if (tests.length > 0) {
      fix += `**Guardrail Test**\n`;
      fix += `\`\`\`typescript\n${tests[0].code}\`\`\`\n\n`;
    }
    
    return fix;
  }

  /**
   * Extract heuristic tags from hypothesis and context
   */
  private extractHeuristicTags(
    hypothesis: Hypothesis,
    debugContext: DebugContext,
    feedback: FindingFeedback | undefined
  ): string[] {
    const tags: string[] = [];
    
    // Check hypothesis summary
    const summary = hypothesis.summary.toLowerCase();
    if (summary.includes('null') || summary.includes('undefined')) tags.push('null_access');
    if (summary.includes('async') || summary.includes('await')) tags.push('missing_await');
    if (summary.includes('import') || summary.includes('export')) tags.push('import_mismatch');
    if (summary.includes('effect') || summary.includes('hook')) tags.push('useEffect_deps');
    
    // Check heuristic findings
    debugContext.heuristicFindings?.forEach(finding => {
      tags.push(finding.pattern);
    });
    
    return [...new Set(tags)]; // Remove duplicates
  }

  /**
   * Generate null access fix
   */
  private generateNullAccessFix(hypothesis: Hypothesis): string {
    return `Add null/undefined checks before accessing object properties:

\`\`\`typescript
// Before
const result = user.name.toUpperCase();

// After
const result = user?.name?.toUpperCase() || '';
if (!user) return res.status(404).json({ error: 'User not found' });
\`\`\`

**ESLint Rules to Enable:**
- \`@typescript-eslint/strict-boolean-expressions\`
- \`@typescript-eslint/no-non-null-assertion\`

`;
  }

  /**
   * Generate async fix
   */
  private generateAsyncFix(hypothesis: Hypothesis): string {
    return `Add proper async/await handling:

\`\`\`typescript
// Before
const data = fetchData();

// After
const data = await fetchData();
\`\`\`

**ESLint Rules to Enable:**
- \`@typescript-eslint/require-await\`
- \`@typescript-eslint/no-floating-promises\`

`;
  }

  /**
   * Generate import fix
   */
  private generateImportFix(hypothesis: Hypothesis): string {
    return `Fix import/export mismatch:

\`\`\`typescript
// Before
import Component from './Component'; // default import

// After
import { Component } from './Component'; // named import
\`\`\`

**ESLint Rules to Enable:**
- \`import/no-named-as-default\`
- \`import/no-named-as-default-member\`

`;
  }

  /**
   * Generate hook fix
   */
  private generateHookFix(hypothesis: Hypothesis): string {
    return `Fix useEffect dependency array:

\`\`\`typescript
// Before
useEffect(() => {
  fetchData(userId);
}, []);

// After
useEffect(() => {
  fetchData(userId);
}, [userId]);
\`\`\`

**ESLint Rules to Enable:**
- \`react-hooks/exhaustive-deps\`

`;
  }

  /**
   * Generate generic fix
   */
  private generateGenericFix(hypothesis: Hypothesis): string {
    return `Based on the analysis, the issue appears to be in ${hypothesis.relatedFiles?.[0] || 'the identified code'}. 

Review the code around the error location and ensure proper error handling and validation.

**Recommended Actions:**
1. Add proper error boundaries
2. Implement input validation
3. Add comprehensive logging
4. Write unit tests for edge cases

`;
  }

  /**
   * Generate evidence list with structured tables
   */
  private generateEvidenceList(debugContext: DebugContext, topHypothesis: Hypothesis | null): string[] {
    const evidence: string[] = [];
    
    // Stack frames table
    if (debugContext.evidence?.frames?.length > 0) {
      evidence.push('**Stack Frames:**');
      evidence.push('| Function | File | Line | Module |');
      evidence.push('|----------|------|------|--------|');
      
      debugContext.evidence.frames.slice(0, 5).forEach(frame => {
        const module = frame.file.includes('node_modules') ? 'external' : 'app';
        evidence.push(`| ${frame.fn || 'unknown'} | ${frame.file} | ${frame.line} | ${module} |`);
      });
      evidence.push('');
    }
    
    // Commits table
    if (debugContext.gitChanges?.length > 0) {
      evidence.push('**Recent Commits:**');
      evidence.push('| Hash | When | Files | Touches Suspect? |');
      evidence.push('|------|------|-------|------------------|');
      
      debugContext.gitChanges.slice(0, 5).forEach(change => {
        const touchesSuspect = topHypothesis?.relatedFiles?.some(file =>
          change.files?.some(f => f.path === file)
        ) ? '✅' : '❌';
        const when = new Date(change.date).toLocaleDateString();
        const files = change.files?.length || 0;
        evidence.push(`| ${change.hash.substring(0, 8)} | ${when} | ${files} | ${touchesSuspect} |`);
      });
      evidence.push('');
    }
    
    // Graph nodes table
    if (debugContext.graph?.nodes?.length > 0) {
      const errorNodes = debugContext.graph.nodes.filter(node => node.badges?.includes('error'));
      if (errorNodes.length > 0) {
        evidence.push('**Graph Nodes:**');
        evidence.push('| ID | Label | File:Line | Badges |');
        evidence.push('|----|-------|-----------|--------|');
        
        errorNodes.slice(0, 5).forEach(node => {
          const fileLine = node.file ? `${node.file}${node.line ? `:${node.line}` : ''}` : 'unknown';
          const badges = node.badges?.join(', ') || 'none';
          evidence.push(`| ${node.id} | ${node.label} | ${fileLine} | ${badges} |`);
        });
        evidence.push('');
      }
    }
    
    // Heuristic findings
    const highSeverityFindings = debugContext.heuristicFindings?.filter(f => f.severity === 'high') || [];
    if (highSeverityFindings.length > 0) {
      evidence.push('**Heuristic Findings:**');
      highSeverityFindings.slice(0, 3).forEach(finding => {
        evidence.push(`- **${finding.pattern}** in ${finding.file}:${finding.line} - ${finding.rationale}`);
      });
      evidence.push('');
    }
    
    return evidence;
  }

  /**
   * Generate confidence summary table
   */
  private generateConfidenceSummaryTable(hypotheses: Hypothesis[], feedback: FindingFeedback[]): string {
    let table = `### 🧮 Confidence Summary\n\n`;
    table += `| Hypothesis | Confidence | Verdict |\n`;
    table += `|-------------|-------------|----------|\n`;
    
    hypotheses.forEach(hypothesis => {
      const feedbackForHypothesis = feedback.find(f => f.hypothesisId === hypothesis.id);
      const verdict = feedbackForHypothesis?.verdict || 'untested';
      const confidence = this.computeNormalizedConfidence([hypothesis], feedback, {} as DebugContext);
      
      let verdictIcon = '❓';
      if (verdict === 'confirmed') verdictIcon = '✅';
      else if (verdict === 'refuted') verdictIcon = '❌';
      else if (verdict === 'uncertain') verdictIcon = '⚠️';
      
      const summary = hypothesis.summary.length > 50 
        ? hypothesis.summary.substring(0, 50) + '...' 
        : hypothesis.summary;
      
      table += `| ${summary} | ${(confidence * 100).toFixed(0)}% | ${verdictIcon} ${verdict} |\n`;
    });
    
    return table;
  }

  /**
   * Format VS Code link
   */
  private formatVsCodeLink(file: string, line: number, workspaceRoot?: string): string {
    if (!workspaceRoot) return `${file}:${line}`;
    
    // Handle both absolute and relative paths
    let absolutePath: string;
    if (file.startsWith('/')) {
      // Already absolute path
      absolutePath = file;
    } else if (file.startsWith(workspaceRoot)) {
      // Already includes workspace root
      absolutePath = file;
    } else {
      // Relative path, prepend workspace root
      absolutePath = `${workspaceRoot}/${file}`;
    }
    
    return `[${file}:${line}](vscode://file${absolutePath}:${line})`;
  }

  /**
   * Format the complete markdown report
   */
  formatMarkdownReport(report: EnhancedRootCauseReport, workspaceRoot?: string): string {
    let markdown = report.summary;
    
    // Add fail path if available
    if (report.failPath && report.failPath.length > 0) {
      markdown += `### 🔥 Fail Path (shortest execution path)\n`;
      const pathStr = report.failPath.map(p => 
        `${p.label} (${this.formatVsCodeLink(p.file, p.line || 1, workspaceRoot)})`
      ).join(' → ');
      markdown += `${pathStr}\n\n`;
    }
    
    markdown += `### 🧠 Reasoning Steps\n`;
    report.reasoningSteps.forEach((step, index) => {
      markdown += `${index + 1}. ${step}\n`;
    });
    markdown += `\n`;
    
    markdown += report.recommendedFix;
    markdown += `\n`;
    
    markdown += `### 🔍 Evidence\n`;
    report.evidence.forEach(evidence => {
      markdown += `${evidence}\n`;
    });
    markdown += `\n`;
    
    markdown += report.confidenceSummaryTable;
    markdown += `\n`;
    
    // Enhanced timings table
    const formatMinutes = (ms: number | null | undefined): string => {
      if (ms == null || isNaN(ms)) return '—';
      return `${(ms / 60000).toFixed(1)} min`;
    };
    
    markdown += `### ⏱️ Analysis Timings\n`;
    markdown += `| Stage | Time | % |\n`;
    markdown += `|-------|------|---|\n`;
    
    const totalTime = report.timings.total || 0;
    const stages = [
      { name: 'Evidence', key: 'evidence' },
      { name: 'Hypotheses', key: 'hypothesis' },
      { name: 'Testing', key: 'testing' }
    ];
    
    stages.forEach(stage => {
      const time = report.timings[stage.key] || 0;
      const percentage = totalTime > 0 ? ((time / totalTime) * 100).toFixed(0) : '0';
      markdown += `| ${stage.name} | ${formatMinutes(time)} | ${percentage}% |\n`;
    });
    
    markdown += `| **Total** | **${formatMinutes(totalTime)}** | **100%** |\n\n`;
    
    // Add reproduction steps if confidence is low
    if (report.confidence < 0.7) {
      markdown += `### 🔄 What to Try Next\n`;
      markdown += `Since confidence is below 70%, consider:\n`;
      markdown += `- Enable debug logging to capture more details\n`;
      markdown += `- Run specific tests to isolate the issue\n`;
      markdown += `- Instrument variables to trace data flow\n`;
      markdown += `- Narrow search scope to specific modules\n\n`;
    }
    
    return markdown;
  }

  /**
   * Generate clarifying questions when confidence is low
   */
  private generateClarifyingQuestions(
    debugContext: DebugContext, 
    topHypothesis: Hypothesis | null, 
    confidence: number
  ): string[] {
    const questions: string[] = [];
    
    // Only generate questions if confidence is low or no clear hypothesis
    if (confidence >= 0.4 && topHypothesis) {
      return questions;
    }
    
    const evidence = debugContext.evidence;
    
    // Deterministic questions based on missing information
    if (!evidence?.behaviorHints || evidence.behaviorHints.length === 0) {
      questions.push("What specific component, page, or API endpoint is affected?");
    }
    
    if (!evidence?.softSignals || evidence.softSignals.length === 0) {
      questions.push("Are there any error messages, warnings, or unexpected behaviors in the console?");
    }
    
    if (evidence?.evidenceSource === 'user_description') {
      questions.push("What is the expected behavior versus what you're actually seeing?");
    }
    
    // Mode-specific questions
    if (evidence?.softSignals && evidence.softSignals.some(s => s.kind === 'http')) {
      questions.push("Can you capture the response body size/shape for the HTTP calls?");
    }
    
    if (evidence?.softSignals && evidence.softSignals.some(s => s.kind === 'timeout')) {
      questions.push("What is the timeout duration and which specific operation is timing out?");
    }
    
    // Environment questions
    questions.push("What browser, device, or environment are you using?");
    questions.push("When did this issue start occurring?");
    
    // Limit to 3 most relevant questions
    return questions.slice(0, 3);
  }

  /**
   * Generate quick actions for the user
   */
  private generateQuickActions(
    debugContext: DebugContext, 
    topHypothesis: Hypothesis | null
  ): Array<{ id: string; title: string; description?: string }> {
    const actions: Array<{ id: string; title: string; description?: string }> = [];
    
    const evidence = debugContext.evidence;
    
    // Always include basic actions
    actions.push({
      id: 'record-repro',
      title: 'Record Reproduction Steps',
      description: 'Click to open a form to record detailed reproduction steps'
    });
    
    // Mode-specific actions
    if (evidence?.evidenceSource === 'user_description') {
      actions.push({
        id: 'capture-console',
        title: 'Capture Browser Console',
        description: 'Instructions to capture console logs and network activity'
      });
    }
    
    if (evidence?.softSignals && evidence.softSignals.some(s => s.kind === 'http')) {
      actions.push({
        id: 'capture-network',
        title: 'Capture Network Response',
        description: 'Instructions to capture HTTP response details'
      });
    }
    
    if (topHypothesis) {
      actions.push({
        id: 'run-test',
        title: 'Run Suggested Test',
        description: 'Execute the generated test case to verify the hypothesis'
      });
    }
    
    return actions;
  }
}