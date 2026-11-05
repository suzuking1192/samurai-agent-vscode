/**
 * Enhanced Hypothesis Tester for Root Cause Analysis
 * 
 * Tests and validates hypotheses through deterministic static checks,
 * execution graph analysis, and LLM-based data flow simulation
 */

import { LLMProviderService } from '../../llm/llmProviderService';
import { LLMMessage, LLMRequest } from '../../../common/models/llm-models';
import { DebugContext, Hypothesis, FindingFeedback, SnippetRecord, LLMCallDebugInfo, truncateDebugText } from './rootCauseTypes';
import { llmCache } from '../../../common/utils/llmCache';
import { ExtractCodeTool } from '../extractCodeTool';
import { BudgetManager } from '../../util/BudgetManager';
import { analyzeCoverage, needsMoreContext } from '../../util/coverageAnalyzer';
import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import { loadDebuggingPrompt } from './promptLoader';
import { ResponseType } from '../../../common/models/response-models';
import { SnippetUtils } from './SnippetStore';

interface StaticFinding {
  type: "null_deref" | "missing_await" | "hook_deps" | "import_mismatch" | "circular_import" | "thrown_match";
  file: string;
  line: number;
  snippetId?: string;
  severity: "low" | "medium" | "high";
  rationale: string;
}

interface LLMTestResponse {
  verdict: "confirmed" | "refuted" | "uncertain";
  confidence: number;
  findings: string[];
  verifiedEvidence: Array<{
    type: "snippet" | "graphNode" | "commit";
    id?: string;
    hash?: string;
  }>;
  newClues: string[];
}

interface ExecutionPath {
  from: string;
  to: string;
  distance: number;
  edges: Array<{ kind: string; confidence: number }>;
}

export class HypothesisTester {
  private llmProvider: LLMProviderService;
  private extractCodeTool: ExtractCodeTool;
  private budgetManager: BudgetManager;
  private readonly MAX_SNIPPETS = 5;
  private readonly MAX_STACK_FRAMES = 3;
  private readonly MAX_STATIC_FINDINGS = 5;
  private readonly MAX_PATHS = 2;
  private readonly MAX_PATH_LENGTH = 6;
  private readonly TIMEOUT_MS = 30000;

  private llmDebugCalls: LLMCallDebugInfo[] = [];
  private lastPrompt: string = '';
  private lastSnippets: SnippetRecord[] = [];

  constructor(llmProvider: LLMProviderService, extractCodeTool: ExtractCodeTool, budgetManager: BudgetManager) {
    this.llmProvider = llmProvider;
    this.extractCodeTool = extractCodeTool;
    this.budgetManager = budgetManager;
  }

  getLLMDebugInfo(): LLMCallDebugInfo[] {
    return this.llmDebugCalls;
  }

  clearLLMDebugInfo(): void {
    this.llmDebugCalls = [];
  }

  /**
   * Test a single hypothesis with enhanced analysis
   */
  async testHypothesis(
    hypothesis: Hypothesis,
    debugContext: DebugContext,
    model: string
  ): Promise<FindingFeedback> {
    console.log(`[HypothesisTester] Testing hypothesis: ${hypothesis.id}`);

    try {
      // Get relevant snippets from store (not file reading)
      const relevantSnippets = this.getRelevantSnippets(hypothesis, debugContext);
      
      // Run deterministic static checks
      const staticFindings = this.runStaticChecks(hypothesis, debugContext, relevantSnippets);
      
      // Calculate execution paths from error nodes to hypothesis nodes
      const executionPaths = this.calculateExecutionPaths(hypothesis, debugContext);
      
      // Simulate data flow using LLM with constrained prompt
      const dataFlowResult = await this.simulateDataFlow(
        hypothesis, 
        debugContext, 
        model, 
        relevantSnippets, 
        executionPaths, 
        staticFindings
      );
      
      // Check if we need more context and perform dynamic extraction
      let enrichedSnippets = relevantSnippets;
      const startTime = Date.now();
      
      // Analyze coverage to determine if more context is needed
      const coverageAnalysis = analyzeCoverage(
        relevantSnippets,
        hypothesis.evidence,
        debugContext.candidates
      );
      
      const needsMore = dataFlowResult.verdict === 'uncertain' || 
                       needsMoreContext(coverageAnalysis) ||
                       this.budgetManager.trackCalls('focusedExtract');
      
      if (needsMore && this.budgetManager.withinTime(startTime, 500)) {
        console.log(`[HypothesisTester] Extracting additional context for hypothesis ${hypothesis.id}`);
        
        try {
          // Extract additional focused code
          const additionalCandidates = await this.extractCodeTool.extractFocused({
            query: hypothesis.summary,
            allowFiles: hypothesis.relatedFiles,
            topK: 3
          });
          
          // Convert candidates to snippets and merge
          const additionalSnippets = await this.convertCandidatesToSnippets(additionalCandidates);
          enrichedSnippets = this.mergeSnippets(relevantSnippets, additionalSnippets);
          
          console.log(`[HypothesisTester] Added ${additionalSnippets.length} additional snippets`);
          
          // Skip enriched context re-test for beta - keep extraction but don't re-test with LLM
          // This reduces LLM calls while maintaining context availability
          
        } catch (error) {
          console.warn(`[HypothesisTester] Dynamic extraction failed:`, error);
          // Continue with original snippets
        }
      }
      
      // Calibrate confidence with deterministic signals
      const calibratedConfidence = this.calibrateConfidence(
        dataFlowResult.confidence,
        staticFindings,
        executionPaths,
        enrichedSnippets,
        debugContext
      );
      
      // Determine verdict using rule-based logic
      const verdict = this.determineVerdict(
        dataFlowResult.verdict,
        staticFindings,
        executionPaths,
        calibratedConfidence
      );
      
      // Reconcile evidence against allowlists
      const reconciledEvidence = this.reconcileEvidence(dataFlowResult.verifiedEvidence, debugContext);
      
      const feedback: FindingFeedback = {
        hypothesisId: hypothesis.id,
        verdict,
        newClues: dataFlowResult.newClues,
        revisedConfidence: calibratedConfidence,
        verifiedEvidence: [...staticFindings.map(f => f.rationale), ...reconciledEvidence.map(e => JSON.stringify(e))]
      };

      console.log(`[HypothesisTester] Hypothesis ${hypothesis.id} verdict: ${verdict} (${calibratedConfidence})`);
      return feedback;

    } catch (error) {
      console.error(`[HypothesisTester] Error testing hypothesis ${hypothesis.id}:`, error);
      
      return {
        hypothesisId: hypothesis.id,
        verdict: 'uncertain',
        newClues: ['Error occurred during testing'],
        revisedConfidence: 0.3,
        verifiedEvidence: []
      };
    }
  }

  /**
   * Get relevant snippets from the snippet store
   */
  private getRelevantSnippets(hypothesis: Hypothesis, debugContext: DebugContext): SnippetRecord[] {
    const pool = debugContext.snippets.filter(s => 
      hypothesis.relatedFiles.some(file => this.normalizePath(s.file) === this.normalizePath(file))
    );
    
    // Prioritize: overlaps with stack frames > in error path > heuristic tags > recency
    const ranked = this.rankSnippets(pool, debugContext);
    const selected = ranked.slice(0, this.MAX_SNIPPETS);
    
    // Extract actual code from files if snippets lack text content
    return selected.map(snippet => {
      // If snippet already has code text, use it
      if (snippet.text && snippet.text.trim().length > 0 && 
          !snippet.text.startsWith('// Extracted from')) {
        return snippet;
      }
      
      // Otherwise, extract actual code from the file
      try {
        const fullPath = path.isAbsolute(snippet.file) 
          ? snippet.file 
          : path.join(process.cwd(), snippet.file);
        
        if (fs.existsSync(fullPath)) {
          const content = fs.readFileSync(fullPath, 'utf8');
          const lines = content.split('\n');
          const actualStart = Math.max(0, snippet.start - 1);
          const actualEnd = Math.min(lines.length, snippet.end);
          const code = lines.slice(actualStart, actualEnd).join('\n');
          
          return {
            ...snippet,
            text: code || snippet.text
          };
        }
      } catch (error) {
        console.warn(`[HypothesisTester] Failed to extract code from ${snippet.file}:`, error);
      }
      
      return snippet;
    });
  }

  /**
   * Rank snippets by relevance to the hypothesis
   */
  private rankSnippets(snippets: SnippetRecord[], debugContext: DebugContext): SnippetRecord[] {
    return snippets.sort((a, b) => {
      // Stack frame overlap
      const aStackOverlap = debugContext.evidence.frames.some(f => 
        this.normalizePath(f.file) === this.normalizePath(a.file) && 
        f.line >= a.start && f.line <= a.end
      );
      const bStackOverlap = debugContext.evidence.frames.some(f => 
        this.normalizePath(f.file) === this.normalizePath(b.file) && 
        f.line >= b.start && f.line <= b.end
      );
      
      if (aStackOverlap && !bStackOverlap) return -1;
      if (!aStackOverlap && bStackOverlap) return 1;
      
      // Error path proximity (simplified)
      const aErrorProximity = a.file.includes('error') || a.file.includes('fail') ? 1 : 0;
      const bErrorProximity = b.file.includes('error') || b.file.includes('fail') ? 1 : 0;
      
      if (aErrorProximity !== bErrorProximity) return bErrorProximity - aErrorProximity;
      
      // Recency (if we have timestamps)
      return 0;
    });
  }

  /**
   * Run deterministic static checks
   */
  private runStaticChecks(
    hypothesis: Hypothesis, 
    debugContext: DebugContext, 
    snippets: SnippetRecord[]
  ): StaticFinding[] {
    const findings: StaticFinding[] = [];
    
    for (const snippet of snippets) {
      // Check for null/undefined access patterns
      const nullChecks = this.checkNullAccess(snippet);
      findings.push(...nullChecks);
      
      // Check for missing await patterns
      const awaitChecks = this.checkMissingAwait(snippet);
      findings.push(...awaitChecks);
      
      // Check for React hook dependency issues
      const hookChecks = this.checkHookDependencies(snippet);
      findings.push(...hookChecks);
      
      // Check for import/export mismatches
      const importChecks = this.checkImportMismatches(snippet);
      findings.push(...importChecks);
    }
    
    // Check for circular imports in execution graph
    const circularChecks = this.checkCircularImports(hypothesis, debugContext);
    findings.push(...circularChecks);
    
    // Check if thrown error could originate from hypothesis
    const thrownChecks = this.checkThrownMatch(hypothesis, debugContext, snippets);
    findings.push(...thrownChecks);
    
    return findings.slice(0, this.MAX_STATIC_FINDINGS);
  }

  /**
   * Check for null/undefined access patterns
   */
  private checkNullAccess(snippet: SnippetRecord): StaticFinding[] {
    const findings: StaticFinding[] = [];
    const lines = snippet.text.split('\n');
    
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      
      // Pattern: obj.property or obj[property] where obj might be null/undefined
      if (line.match(/[a-zA-Z_$][a-zA-Z0-9_$]*\.[a-zA-Z_$][a-zA-Z0-9_$]*/) ||
          line.match(/[a-zA-Z_$][a-zA-Z0-9_$]*\[/)) {
        const beforeLine = i > 0 ? lines[i - 1] : '';
        const hasNullCheck = beforeLine.includes('if') && 
          (beforeLine.includes('null') || beforeLine.includes('undefined'));
        
        if (!hasNullCheck) {
          findings.push({
            type: 'null_deref',
            file: snippet.file,
            line: snippet.start + i,
            snippetId: snippet.id,
            severity: 'high',
            rationale: `Potential null/undefined access at line ${snippet.start + i + 1}`
          });
        }
      }
    }
    
    return findings;
  }

  /**
   * Check for missing await patterns
   */
  private checkMissingAwait(snippet: SnippetRecord): StaticFinding[] {
    const findings: StaticFinding[] = [];
    const lines = snippet.text.split('\n');
    
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      
      // Pattern: function call that returns Promise but not awaited
      if (line.match(/[a-zA-Z_$][a-zA-Z0-9_$]*\([^)]*\)/) && 
          !line.includes('await') && 
          !line.includes('return') &&
          !line.includes('Promise.')) {
        
        // Check if this looks like an async function call
        const hasAsyncKeyword = line.includes('async') || 
          lines.slice(Math.max(0, i - 5), i).some((l: string) => l.includes('async'));
        
        if (hasAsyncKeyword) {
          findings.push({
            type: 'missing_await',
            file: snippet.file,
            line: snippet.start + i,
            snippetId: snippet.id,
            severity: 'medium',
            rationale: `Possible missing await on async function call at line ${snippet.start + i + 1}`
          });
        }
      }
    }
    
    return findings;
  }

  /**
   * Check for React hook dependency issues
   */
  private checkHookDependencies(snippet: SnippetRecord): StaticFinding[] {
    const findings: StaticFinding[] = [];
    const lines = snippet.text.split('\n');
    
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      
      if (line.includes('useEffect') || line.includes('useMemo') || line.includes('useCallback')) {
        // Look for dependency array
        const nextLines = lines.slice(i, i + 5);
        const depArrayLine = nextLines.find((l: string) => l.includes('[') && l.includes(']'));
        
        if (depArrayLine) {
          // Check if variables used in the effect are in dependencies
          const effectLines = lines.slice(i, i + 10);
          const usedVars = this.extractUsedVariables(effectLines.join('\n'));
          const depVars = this.extractDependencyVariables(depArrayLine);
          
          const missingDeps = usedVars.filter(v => !depVars.includes(v));
          if (missingDeps.length > 0) {
            findings.push({
              type: 'hook_deps',
              file: snippet.file,
              line: snippet.start + i,
              snippetId: snippet.id,
              severity: 'medium',
              rationale: `Missing dependencies in hook: ${missingDeps.join(', ')}`
            });
          }
        }
      }
    }
    
    return findings;
  }

  /**
   * Check for import/export mismatches
   */
  private checkImportMismatches(snippet: SnippetRecord): StaticFinding[] {
    const findings: StaticFinding[] = [];
    const lines = snippet.text.split('\n');
    
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      
      // Check for default import of named export
      if (line.match(/import\s+\w+\s+from/)) {
        const importName = line.match(/import\s+(\w+)\s+from/)?.[1];
        if (importName && importName[0] === importName[0].toUpperCase()) {
          // This looks like a default import of a class/component
          findings.push({
            type: 'import_mismatch',
            file: snippet.file,
            line: snippet.start + i,
            snippetId: snippet.id,
            severity: 'low',
            rationale: `Potential import/export mismatch: default import of ${importName}`
          });
        }
      }
    }
    
    return findings;
  }

  /**
   * Check for circular imports
   */
  private checkCircularImports(hypothesis: Hypothesis, debugContext: DebugContext): StaticFinding[] {
    const findings: StaticFinding[] = [];
    
    // Simplified circular import detection
    const relatedFiles = hypothesis.relatedFiles;
    for (let i = 0; i < relatedFiles.length; i++) {
      for (let j = i + 1; j < relatedFiles.length; j++) {
        const file1 = relatedFiles[i];
        const file2 = relatedFiles[j];
        
        // Check if there's a circular dependency in the graph
        const hasPath1to2 = this.hasPath(file1, file2, debugContext.graph);
        const hasPath2to1 = this.hasPath(file2, file1, debugContext.graph);
        
        if (hasPath1to2 && hasPath2to1) {
          findings.push({
            type: 'circular_import',
            file: file1,
            line: 0,
            severity: 'medium',
            rationale: `Circular import detected between ${file1} and ${file2}`
          });
        }
      }
    }
    
    return findings;
  }

  /**
   * Check if thrown error could originate from hypothesis
   */
  private checkThrownMatch(
    hypothesis: Hypothesis, 
    debugContext: DebugContext, 
    snippets: SnippetRecord[]
  ): StaticFinding[] {
    const findings: StaticFinding[] = [];
    const errorMessage = debugContext.evidence.error || '';
    
    if (!errorMessage) return findings;
    
    for (const snippet of snippets) {
      const lines = snippet.text.split('\n');
      
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        
        // Check if line could throw the observed error
        if (line.includes('throw') || line.includes('Error') || line.includes('Exception')) {
          const lineError = line.toLowerCase();
          const observedError = errorMessage.toLowerCase();
          
          // Simple keyword matching
          const keywords = observedError.split(/\s+/).filter(w => w.length > 3);
          const matches = keywords.filter(k => lineError.includes(k));
          
          if (matches.length > 0) {
            findings.push({
              type: 'thrown_match',
              file: snippet.file,
              line: snippet.start + i,
              snippetId: snippet.id,
              severity: 'high',
              rationale: `Line could throw observed error: ${matches.join(', ')}`
            });
          }
        }
      }
    }
    
    return findings;
  }

  /**
   * Calculate execution paths from error nodes to hypothesis nodes
   */
  private calculateExecutionPaths(hypothesis: Hypothesis, debugContext: DebugContext): ExecutionPath[] {
    const errorNodes = debugContext.graph.nodes.filter(node => node.badges?.includes('error'));
    const hypothesisNodes = hypothesis.relatedNodes;
    const paths: ExecutionPath[] = [];
    
    // If no error nodes, use all nodes as potential error sources
    const sourceNodes = errorNodes.length > 0 ? errorNodes : debugContext.graph.nodes.slice(0, 3);
    
    for (const errorNode of sourceNodes) {
      for (const hypothesisNode of hypothesisNodes) {
        const path = this.findShortestPath(errorNode.id, hypothesisNode, debugContext.graph);
        if (path && path.distance <= this.MAX_PATH_LENGTH) {
          paths.push(path);
        }
      }
    }
    
    return paths.slice(0, this.MAX_PATHS);
  }

  /**
   * Find shortest path between two nodes
   */
  private findShortestPath(from: string, to: string, graph: any): ExecutionPath | null {
    const queue = [{ node: from, distance: 0, path: [from] }];
    const visited = new Set<string>();
    
    while (queue.length > 0) {
      const { node, distance, path } = queue.shift()!;
      
      if (node === to) {
        return {
          from,
          to,
          distance,
          edges: this.getPathEdges(path, graph)
        };
      }
      
      if (visited.has(node)) continue;
      visited.add(node);
      
      const edges = graph.edges.filter((e: any) => e.from === node);
      for (const edge of edges) {
        if (!visited.has(edge.to)) {
          queue.push({
            node: edge.to,
            distance: distance + 1,
            path: [...path, edge.to]
          });
        }
      }
    }
    
    return null;
  }

  /**
   * Get edges for a path
   */
  private getPathEdges(path: string[], graph: any): Array<{ kind: string; confidence: number }> {
    const edges: Array<{ kind: string; confidence: number }> = [];
    
    for (let i = 0; i < path.length - 1; i++) {
      const edge = graph.edges.find((e: any) => e.from === path[i] && e.to === path[i + 1]);
      if (edge) {
        edges.push({ kind: edge.kind, confidence: edge.confidence });
      }
    }
    
    return edges;
  }

  /**
   * Check if there's a path between two files
   */
  private hasPath(file1: string, file2: string, graph: any): boolean {
    const node1 = graph.nodes.find((n: any) => n.file === file1);
    const node2 = graph.nodes.find((n: any) => n.file === file2);
    
    if (!node1 || !node2) return false;
    
    return this.findShortestPath(node1.id, node2.id, graph) !== null;
  }

  /**
   * Simulate data flow using LLM with constrained prompt
   */
  private async simulateDataFlow(
    hypothesis: Hypothesis,
    debugContext: DebugContext,
    model: string,
    snippets: SnippetRecord[],
    executionPaths: ExecutionPath[],
    staticFindings: StaticFinding[]
  ): Promise<LLMTestResponse> {
    const prompt = this.buildConstrainedPrompt(hypothesis, debugContext, snippets, executionPaths, staticFindings);
    
    // Store for debug capture
    this.lastPrompt = prompt;
    this.lastSnippets = snippets;
    
    // Create enhanced cache key
    const cacheKey = this.createCacheKey(hypothesis, debugContext, snippets, executionPaths);
    let response = llmCache.getCachedResponse(cacheKey);
    
    if (!response) {
      response = await this.callLLMWithTimeout(prompt, model);
      llmCache.setCachedResponse(cacheKey, response, 30 * 60 * 1000);
    }

    return this.parseLLMResponse(response.content || '', debugContext);
  }

  /**
   * Build constrained prompt with allowlists using markdown template
   */
  private buildConstrainedPrompt(
    hypothesis: Hypothesis,
    debugContext: DebugContext,
    snippets: SnippetRecord[],
    executionPaths: ExecutionPath[],
    staticFindings: StaticFinding[]
  ): string {
    // Load template from markdown file
    let template: string;
    try {
      template = loadDebuggingPrompt('hypothesis_testing.md');
    } catch (error) {
      console.warn('[HypothesisTester] Failed to load prompt template, using fallback');
      return this.buildFallbackPrompt(hypothesis, debugContext, snippets, executionPaths, staticFindings);
    }
    
    // Prepare data for template substitution
    const allowedFiles = debugContext.candidates.map(c => this.normalizePath(c.file));
    const allowedNodeIds = debugContext.graph.nodes.map(n => n.id);
    const allowedSnippetIds = debugContext.snippets.map(s => s.id);
    
    const topStackFrames = debugContext.evidence.frames
      .filter(f => !f.file.includes('node_modules'))
      .slice(0, this.MAX_STACK_FRAMES);
    
    const errorLine = this.extractTopErrorLine(debugContext.logs);
    const logSignatures = this.extractLogSignatures(debugContext.logs).slice(0, 2);
    
    // Format code snippets
    const formattedSnippets = snippets.length > 0
      ? snippets.map(s => `--- ${s.file}:${s.start}-${s.end} (id:${s.id}) ---\n${s.text}`).join('\n\n')
      : 'No code snippets provided.';
    
    // Format execution paths
    const formattedPaths = executionPaths.length > 0
      ? executionPaths.map(p => `${p.from} → ${p.to} (distance: ${p.distance})`).join('\n')
      : 'No execution paths found.';
    
    // Format static findings
    const formattedFindings = staticFindings.length > 0
      ? staticFindings.map(f => `- ${f.type}: ${f.rationale} (${f.severity})`).join('\n')
      : 'No static findings.';
    
    // Format error context
    const formattedErrorContext = `${errorLine}\n${logSignatures.join('\n')}`.trim();
    
    // Format stack frames
    const formattedStackFrames = topStackFrames.length > 0
      ? topStackFrames.map(f => `${f.file}:${f.line} (${f.fn || 'unknown'})`).join('\n')
      : 'No stack frames available.';
    
    // Substitute template variables
    const prompt = template
      .replace(/{hypothesisSummary}/g, hypothesis.summary)
      .replace(/{hypothesisEvidence}/g, hypothesis.evidence.join(', ') || 'No additional evidence')
      .replace(/{codeSnippets}/g, formattedSnippets)
      .replace(/{executionPaths}/g, formattedPaths)
      .replace(/{staticFindings}/g, formattedFindings)
      .replace(/{errorContext}/g, formattedErrorContext)
      .replace(/{stackFrames}/g, formattedStackFrames)
      .replace(/{allowedFiles}/g, allowedFiles.join(', ') || 'None')
      .replace(/{allowedNodeIds}/g, allowedNodeIds.join(', ') || 'None')
      .replace(/{allowedSnippetIds}/g, allowedSnippetIds.join(', ') || 'None');
    
    return prompt;
  }

  /**
   * Build fallback prompt if template loading fails
   */
  private buildFallbackPrompt(
    hypothesis: Hypothesis,
    debugContext: DebugContext,
    snippets: SnippetRecord[],
    executionPaths: ExecutionPath[],
    staticFindings: StaticFinding[]
  ): string {
    const allowedFiles = debugContext.candidates.map(c => this.normalizePath(c.file));
    const allowedNodeIds = debugContext.graph.nodes.map(n => n.id);
    const allowedSnippetIds = debugContext.snippets.map(s => s.id);
    
    const topStackFrames = debugContext.evidence.frames
      .filter(f => !f.file.includes('node_modules'))
      .slice(0, this.MAX_STACK_FRAMES);
    
    const errorLine = this.extractTopErrorLine(debugContext.logs);
    const logSignatures = this.extractLogSignatures(debugContext.logs).slice(0, 2);
    
    return `Test this hypothesis about a bug:

HYPOTHESIS: ${hypothesis.summary}
EVIDENCE: ${hypothesis.evidence.join(', ')}

CODE SNIPPETS:
${snippets.map(s => `--- ${s.file}:${s.start}-${s.end} (id:${s.id}) ---\n${s.text}`).join('\n\n')}

EXECUTION PATHS (error → hypothesis):
${executionPaths.map(p => `${p.from} → ${p.to} (distance: ${p.distance})`).join('\n')}

STATIC FINDINGS:
${staticFindings.map(f => `- ${f.type}: ${f.rationale} (${f.severity})`).join('\n')}

ERROR CONTEXT:
${errorLine}
${logSignatures.join('\n')}

STACK FRAMES:
${topStackFrames.map(f => `${f.file}:${f.line} (${f.fn || 'unknown'})`).join('\n')}

ALLOWED FILES: ${allowedFiles.join(', ')}
ALLOWED NODES: ${allowedNodeIds.join(', ')}
ALLOWED SNIPPETS: ${allowedSnippetIds.join(', ')}

You must reply with JSON only inside a single code fence:

\`\`\`json
{
  "verdict": "confirmed" | "refuted" | "uncertain",
  "confidence": 0.0-1.0,
  "findings": ["evidence-light statement"],
  "verifiedEvidence": [
    {"type": "snippet", "id": "snippetId"},
    {"type": "graphNode", "id": "nodeId"},
    {"type": "commit", "hash": "commitHash"}
  ],
  "newClues": ["new insight"]
}
\`\`\``;
  }

  /**
   * Call LLM with timeout and retry
   */
  private async callLLMWithTimeout(prompt: string, model: string): Promise<any> {
    const startTime = Date.now();
    
    const messages: LLMMessage[] = [
      {
        role: 'system',
        content: this.loadSystemPrompt()
      },
      {
        role: 'user',
        content: prompt
      }
    ];

    const request: LLMRequest = {
      id: `hypothesis-test-${Date.now()}`,
      provider: '',
      model,
      messages,
      temperature: 0.1,
      maxTokens: 20000,
      metadata: {},
      createdAt: new Date(),
      updatedAt: new Date()
    };

    try {
      const llmResponse = await Promise.race([
        this.llmProvider.chat(request),
        new Promise<never>((_, reject) => 
          setTimeout(() => reject(new Error('LLM call timeout')), this.TIMEOUT_MS)
        )
      ]);

      // Log response details for debugging
      console.log('[HypothesisTester] LLM response received:', {
        type: llmResponse.type,
        hasPayload: !!llmResponse.payload,
        error: llmResponse.error,
        requestId: llmResponse.requestId
      });
      
      if (llmResponse.type !== ResponseType.SUCCESS) {
        const errorMessage = llmResponse.error || 'Unknown error from LLM provider';
        console.error('[HypothesisTester] LLM response error:', {
          type: llmResponse.type,
          error: errorMessage,
          requestId: llmResponse.requestId,
          payload: llmResponse.payload
        });
        throw new Error(`Failed to get LLM response: ${errorMessage}`);
      }
      
      if (!llmResponse.payload) {
        console.error('[HypothesisTester] LLM response missing payload:', llmResponse);
        throw new Error('Failed to get LLM response: No payload in response');
      }

      // Capture debug info for successful calls
      const duration = Date.now() - startTime;
      const systemPrompt = this.loadSystemPrompt();
      const tokensUsed = (llmResponse.payload as any)?.usage?.totalTokens;
      const content = (llmResponse.payload as any)?.content || '';
      
      const debugInfo: LLMCallDebugInfo = {
        id: `hyp-test-${Date.now()}`,
        stage: 'hypothesis-testing',
        timestamp: startTime,
        request: {
          prompt: truncateDebugText(this.lastPrompt || prompt),
          systemPrompt: truncateDebugText(systemPrompt),
          codeSnippets: this.lastSnippets.map(s => ({
            file: s.file,
            code: truncateDebugText(s.text),
            reason: s.reasons.join(', ')
          })),
          model,
          temperature: 0.1,
          maxTokens: 20000
        },
        response: {
          content: truncateDebugText(content),
          tokensUsed,
          duration
        }
      };
      this.llmDebugCalls.push(debugInfo);

      return llmResponse.payload;
    } catch (error) {
      // Capture debug info for errors
      const duration = Date.now() - startTime;
      const systemPrompt = this.loadSystemPrompt();
      const debugInfo: LLMCallDebugInfo = {
        id: `hyp-test-${Date.now()}`,
        stage: 'hypothesis-testing',
        timestamp: startTime,
        request: {
          prompt: truncateDebugText(prompt.substring(0, 200)), // Only first 200 chars for errors
          model,
          temperature: 0.1,
          maxTokens: 20000
        },
        error: error instanceof Error ? error.message : String(error)
      };
      this.llmDebugCalls.push(debugInfo);

      if (Date.now() - startTime < this.TIMEOUT_MS && 
          error instanceof Error && (error.message.includes('rate limit') || error.message.includes('timeout'))) {
        await new Promise(resolve => setTimeout(resolve, 1000));
        return this.callLLMWithTimeout(prompt, model);
      }
      throw error;
    }
  }

  /**
   * Parse LLM response with fenced JSON extraction
   */
  private parseLLMResponse(content: string, debugContext: DebugContext): LLMTestResponse {
    try {
      const fencedJson = this.extractFencedJson(content);
      const jsonContent = fencedJson || content;
      
      const parsed = JSON.parse(jsonContent);
      
      const response: LLMTestResponse = {
        verdict: parsed.verdict || 'uncertain',
        confidence: Math.max(0, Math.min(1, parsed.confidence || 0.5)),
        findings: Array.isArray(parsed.findings) ? parsed.findings : [],
        verifiedEvidence: Array.isArray(parsed.verifiedEvidence) ? parsed.verifiedEvidence : [],
        newClues: Array.isArray(parsed.newClues) ? parsed.newClues : []
      };

      // Validate and filter response against allowlists
      return this.validateAndFilterResponse(response, debugContext);
    } catch (error) {
      console.warn('[HypothesisTester] Failed to parse LLM response, using fallback');
      return {
        verdict: 'uncertain',
        confidence: 0.3,
        findings: ['Failed to parse analysis response'],
        verifiedEvidence: [],
        newClues: ['Analysis inconclusive due to parsing error']
      };
    }
  }

  /**
   * Extract JSON from fenced code blocks
   */
  private extractFencedJson(content: string): string | null {
    const match = content.match(/```json\s*([\s\S]*?)\s*```/i);
    return match?.[1] ?? null;
  }

  /**
   * Calibrate confidence with deterministic signals
   */
  private calibrateConfidence(
    llmConfidence: number,
    staticFindings: StaticFinding[],
    executionPaths: ExecutionPath[],
    snippets: SnippetRecord[],
    debugContext: DebugContext
  ): number {
    const highSeverityFindings = staticFindings.filter(f => f.severity === 'high').length;
    const staticFindingsHit = Math.min(highSeverityFindings / 2, 1); // Changed from 3 to 2
    
    const shortestPathLen = executionPaths.length > 0 ? Math.min(...executionPaths.map(p => p.distance)) : undefined;
    const inErrorPath = shortestPathLen ? 1 / (1 + shortestPathLen) : 0;
    
    const snippetOverlap = Math.min(snippets.length / 2, 1); // Changed from 3 to 2
    
    const gitRecency = this.calculateGitRecency(debugContext);
    
    const signals = 0.4 * staticFindingsHit + 
                   0.3 * inErrorPath + 
                   0.2 * snippetOverlap + 
                   0.1 * gitRecency;
    
    return 0.4 * llmConfidence + 0.6 * signals; // Changed weights
  }

  /**
   * Calculate git recency score
   */
  private calculateGitRecency(debugContext: DebugContext): number {
    if (debugContext.gitChanges.length === 0) return 0;
    
    const now = Date.now();
    const halfLife = 14 * 24 * 60 * 60 * 1000; // 14 days
    
    const recentChange = debugContext.gitChanges[0];
    const daysSince = (now - recentChange.date.getTime()) / (24 * 60 * 60 * 1000);
    
    return Math.exp(-daysSince / 14);
  }

  /**
   * Determine verdict using rule-based logic
   */
  private determineVerdict(
    llmVerdict: string,
    staticFindings: StaticFinding[],
    executionPaths: ExecutionPath[],
    calibratedConfidence: number
  ): 'confirmed' | 'refuted' | 'uncertain' {
    const highFindings = staticFindings.filter(f => f.severity === 'high').length;
    const pathLen = executionPaths.length > 0 ? Math.min(...executionPaths.map(p => p.distance)) : undefined;
    
    if (highFindings >= 1 && (llmVerdict === 'confirmed' || calibratedConfidence >= 0.75)) {
      return 'confirmed';
    }
    
    if (llmVerdict === 'refuted' && highFindings === 0 && (!pathLen || pathLen > 6)) {
      return 'refuted';
    }
    
    return 'uncertain';
  }

  /**
   * Reconcile evidence against allowlists
   */
  private reconcileEvidence(
    evidence: Array<{ type: string; id?: string; hash?: string }>,
    debugContext: DebugContext
  ): Array<{ type: string; id?: string; hash?: string }> {
    const fileSet = new Set(debugContext.candidates.map(c => this.normalizePath(c.file)));
    const nodeSet = new Set(debugContext.graph.nodes.map(n => n.id));
    const snippetSet = new Set(debugContext.snippets.map(s => s.id));
    
    return evidence.filter(e => {
      if (e.type === 'snippet') return e.id && snippetSet.has(e.id);
      if (e.type === 'graphNode') return e.id && nodeSet.has(e.id);
      if (e.type === 'commit') return e.hash && /^[0-9a-f]{6,40}$/.test(e.hash);
      return false;
    });
  }

  /**
   * Validate and filter response against allowlists
   */
  private validateAndFilterResponse(
    response: LLMTestResponse,
    debugContext: DebugContext
  ): LLMTestResponse {
    // Validate and filter verifiedEvidence using existing reconcileEvidence method
    const validatedEvidence = this.reconcileEvidence(response.verifiedEvidence, debugContext) as Array<{
      type: "snippet" | "graphNode" | "commit";
      id?: string;
      hash?: string;
    }>;

    // Build allowed files set for findings validation
    // Include files from both candidates and snippets to match what's in the prompt
    const candidateFiles = debugContext.candidates.map(c => this.normalizePath(c.file));
    const snippetFiles = debugContext.snippets.map(s => this.normalizePath(s.file));
    const allowedFilesSet = new Set([...candidateFiles, ...snippetFiles]);

    // Filter findings to remove references to files not in allowlist
    const filteredFindings = response.findings.filter(finding => {
      // Extract file path patterns from finding text
      // Common patterns: "file.ts", "src/file.ts", "file.ts:123", etc.
      const filePathPatterns = [
        // Match patterns like "file.ts", "src/file.ts", "./file.ts"
        /([a-zA-Z0-9_./-]+\.[a-z]+)/g,
        // Match patterns like "file.ts:123" (with line numbers)
        /([a-zA-Z0-9_./-]+\.[a-z]+):\d+/g
      ];

      let hasInvalidReference = false;
      
      for (const pattern of filePathPatterns) {
        const matches = finding.match(pattern);
        if (matches) {
          for (const match of matches) {
            // Extract just the file path part (remove line numbers if present)
            const filePath = match.split(':')[0];
            const normalizedPath = this.normalizePath(filePath);
            
            // Check if this file path is in the allowed set
            // We check both the exact path and common variations
            const pathVariations = [
              normalizedPath,
              normalizedPath.startsWith('./') ? normalizedPath.substring(2) : `./${normalizedPath}`,
              path.basename(normalizedPath) // Check if just the filename matches
            ];
            
            const isAllowed = pathVariations.some(variant => allowedFilesSet.has(variant));
            
            // If we found a file reference that's not in the allowlist, mark this finding as invalid
            // However, we want to be lenient - only filter if we're confident it's a file reference
            // and it's clearly not allowed. Simple words or partial matches should not be filtered.
            if (!isAllowed && filePath.includes('/') && filePath.match(/\.(ts|js|tsx|jsx|json|md)$/)) {
              // This looks like a real file path reference that's not allowed
              hasInvalidReference = true;
              break;
            }
          }
        }
        if (hasInvalidReference) break;
      }

      // Keep findings that don't have invalid file references
      // Also keep findings with no file references at all
      return !hasInvalidReference;
    });

    return {
      ...response,
      verifiedEvidence: validatedEvidence,
      findings: filteredFindings
    };
  }

  /**
   * Create enhanced cache key
   */
  private createCacheKey(
    hypothesis: Hypothesis,
    debugContext: DebugContext,
    snippets: SnippetRecord[],
    executionPaths: ExecutionPath[]
  ): string {
    const graphFingerprint = this.digestIds(debugContext.graph.nodes.map(n => n.id));
    const snippetIds = snippets.map(s => s.id).sort();
    const topStackFrames = debugContext.evidence.frames
      .slice(0, 3)
      .map(f => `${f.file}:${f.line}`);
    
    return crypto.createHash('sha256').update(JSON.stringify({
      hId: hypothesis.id,
      commit: debugContext.commitHash,
      graph: graphFingerprint,
      snippets: snippetIds,
      topStackFrames
    })).digest('hex');
  }

  /**
   * Digest node IDs for fingerprinting
   */
  private digestIds(ids: string[]): string {
    return crypto.createHash('sha256').update(ids.sort().join(',')).digest('hex').slice(0, 8);
  }

  /**
   * Extract top error line from logs
   */
  private extractTopErrorLine(logs: string): string {
    const lines = logs.split('\n');
    return lines.find(line => 
      line.toLowerCase().includes('error') || 
      line.toLowerCase().includes('exception') ||
      line.toLowerCase().includes('failed')
    ) || lines[0] || 'Unknown error';
  }

  /**
   * Extract log signatures
   */
  private extractLogSignatures(logs: string): string[] {
    const lines = logs.split('\n').filter(line => line.trim());
    return lines.slice(0, 2).map(line => line.substring(0, 100));
  }

  /**
   * Extract used variables from code
   */
  private extractUsedVariables(code: string): string[] {
    // Simplified variable extraction
    const matches = code.match(/\b[a-zA-Z_$][a-zA-Z0-9_$]*\b/g) || [];
    return [...new Set(matches)].filter(v => v.length > 1 && !['if', 'for', 'while', 'const', 'let', 'var'].includes(v));
  }

  /**
   * Extract dependency variables from dependency array
   */
  private extractDependencyVariables(depArrayLine: string): string[] {
    const match = depArrayLine.match(/\[([^\]]+)\]/);
    if (!match) return [];
    
    return match[1].split(',').map(dep => dep.trim().replace(/['"]/g, ''));
  }

  /**
   * Load system prompt from file
   */
  private loadSystemPrompt(): string {
    try {
      return loadDebuggingPrompt('hypothesis_testing.md');
    } catch (error) {
      console.warn('[HypothesisTester] Failed to load system prompt, using fallback');
      return `You are a senior software engineer testing bug hypotheses through code analysis.

You must reply with JSON only inside a single code fence:

\`\`\`json
{ ... }
\`\`\`

* Use only IDs listed in allowedNodeIds and file paths listed in allowedFiles.
* Output schema:
  {
  "verdict": "confirmed" | "refuted" | "uncertain",
  "confidence": number,        // 0..1
  "findings": string[],        // plain, evidence-light statements
  "verifiedEvidence": [        // MUST cite real artifacts
  {"type":"snippet","id":"<snippetId>"},
  {"type":"graphNode","id":"<nodeId>"},
  {"type":"commit","hash":"<hash>"}
  ],
  "newClues": string[]
  }`;
    }
  }

  /**
   * Convert candidates to snippets for hypothesis testing
   */
  private async convertCandidatesToSnippets(candidates: any[]): Promise<SnippetRecord[]> {
    const snippets: SnippetRecord[] = [];
    
    for (const candidate of candidates) {
      try {
        // Determine line range from candidate
        let startLine = 1;
        let endLine = 50;
        
        // Use symbol line range if available
        if (candidate.symbols && candidate.symbols.length > 0) {
          const symbol = candidate.symbols[0];
          startLine = symbol.startLine || 1;
          endLine = symbol.endLine || Math.max(50, startLine + 49);
        }
        
        // Extract actual code using SnippetUtils
        const fullPath = path.isAbsolute(candidate.file) 
          ? candidate.file 
          : path.join(process.cwd(), candidate.file);
        
        if (fs.existsSync(fullPath)) {
          const extracted = await SnippetUtils.extractCodeSnippet(
            fullPath,
            startLine,
            endLine,
            5 // context lines
          );
          
          const snippet: SnippetRecord = {
            id: `extracted_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
            file: candidate.file,
            start: startLine,
            end: endLine,
            text: extracted.code || `// Failed to extract code from ${candidate.file}`,
            reasons: ['dynamic_extraction', `score_${candidate.score}`, ...(candidate.evidence || [])]
          };
          
          snippets.push(snippet);
        } else {
          // Fallback if file doesn't exist
          const snippet: SnippetRecord = {
            id: `extracted_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
            file: candidate.file,
            start: startLine,
            end: endLine,
            text: `// File not found: ${candidate.file}\n// Score: ${candidate.score}\n// Evidence: ${candidate.evidence?.join(', ') || 'N/A'}`,
            reasons: ['dynamic_extraction', `score_${candidate.score}`, 'file_not_found']
          };
          snippets.push(snippet);
        }
      } catch (error) {
        console.warn(`[HypothesisTester] Failed to convert candidate ${candidate.file} to snippet:`, error);
        // Create a minimal snippet with error info
        const snippet: SnippetRecord = {
          id: `extracted_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
          file: candidate.file,
          start: 1,
          end: 50,
          text: `// Error extracting code: ${error instanceof Error ? error.message : String(error)}`,
          reasons: ['dynamic_extraction', 'extraction_error']
        };
        snippets.push(snippet);
      }
    }
    
    return snippets;
  }

  /**
   * Merge additional snippets with existing ones
   */
  private mergeSnippets(existing: SnippetRecord[], additional: SnippetRecord[]): SnippetRecord[] {
    const merged = [...existing];
    const existingFiles = new Set(existing.map(s => s.file));
    
    // Add additional snippets that don't duplicate existing files
    for (const snippet of additional) {
      if (!existingFiles.has(snippet.file)) {
        merged.push(snippet);
      }
    }
    
    // Limit to MAX_SNIPPETS
    return merged.slice(0, this.MAX_SNIPPETS);
  }

  /**
   * Normalize file path
   */
  private normalizePath(filePath: string): string {
    return filePath.replace(/\\/g, '/');
  }
}