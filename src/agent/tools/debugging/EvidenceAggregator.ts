/**
 * Evidence Aggregator for Root Cause Analysis
 * 
 * Collects and packages all debugging context including git history,
 * execution graph, snippets, and heuristic findings
 */

import { GitService } from '../../../common/utils/gitService';
import { JsHeuristics } from './jsHeuristics';
import { DebugContext, GitChange } from './rootCauseTypes';
import { ExtractionResponse } from './types';

export class EvidenceAggregator {
  private gitService: GitService;
  private jsHeuristics: JsHeuristics;

  constructor(workspacePath: string) {
    this.gitService = new GitService(workspacePath);
    this.jsHeuristics = new JsHeuristics();
  }

  /**
   * Aggregate complete debugging context from extraction results
   */
  async aggregateContext(
    extractionResult: ExtractionResponse,
    workspace: string,
    logs: string,
    userMessage: string
  ): Promise<DebugContext> {
    console.log('[EvidenceAggregator] Starting context aggregation');

    // Get relevant files from candidates and graph
    const relevantFiles = this.extractRelevantFiles(extractionResult);
    
    // Collect git changes
    const gitChanges = await this.collectGitChanges(workspace, relevantFiles);
    
    // Apply JavaScript heuristics
    const heuristicFindings = this.applyJsHeuristics(extractionResult.candidates, extractionResult.graph.nodes);

    // Get current commit hash
    const commitHash = await this.gitService.getCurrentCommitHash();

    const debugContext: DebugContext = {
      projectId: 'debugging',
      commitHash,
      bugDescription: userMessage,
      logs,
      userMessage,
      gitChanges,
      graph: extractionResult.graph,
      snippets: [], // Will be populated from SnippetStore if needed
      evidence: extractionResult.evidence,
      candidates: extractionResult.candidates,
      heuristicFindings
    };

    console.log('[EvidenceAggregator] Context aggregation completed:', {
      gitChanges: gitChanges.length,
      heuristicFindings: heuristicFindings.length,
      relevantFiles: relevantFiles.length
    });

    return debugContext;
  }

  /**
   * Collect git changes for relevant files
   */
  private async collectGitChanges(workspace: string, relevantFiles: string[]): Promise<GitChange[]> {
    try {
      // Check if this is a git repository
      const isGitRepo = await this.gitService.isGitRepository();
      if (!isGitRepo) {
        console.log('[EvidenceAggregator] Not a git repository, skipping git analysis');
        return [];
      }

      // Get recent commits
      const recentCommits = await this.gitService.getDetailedCommits(10);
      
      // Rank commits by relevance to the bug
      const rankedCommits = this.rankGitChangesByRelevance(recentCommits, relevantFiles);

      // Get additional file-specific history for high-relevance files
      const fileHistories: GitChange[] = [];
      for (const file of relevantFiles.slice(0, 5)) { // Limit to top 5 files
        const fileHistory = await this.gitService.getFileHistory(file, 3);
        fileHistories.push(...fileHistory);
      }

      // Combine and deduplicate
      const allChanges = [...rankedCommits, ...fileHistories];
      const uniqueChanges = this.deduplicateGitChanges(allChanges);

      return uniqueChanges.slice(0, 15); // Limit to 15 most relevant changes
    } catch (error) {
      console.warn('[EvidenceAggregator] Failed to collect git changes:', error);
      return [];
    }
  }

  /**
   * Rank git changes by relevance to the bug
   */
  private rankGitChangesByRelevance(commits: GitChange[], relevantFiles: string[]): GitChange[] {
    return commits.map(commit => {
      // Use the enhanced relevance computation from GitService
      const relevanceScore = this.gitService.computeRelevance(commit, {
        relevantFiles,
        recencyHalfLifeDays: 14
      });

      return {
        ...commit,
        relevanceScore
      };
    }).sort((a, b) => (b.relevanceScore || 0) - (a.relevanceScore || 0));
  }

  /**
   * Apply JavaScript heuristics to detect common bug patterns
   */
  private applyJsHeuristics(candidates: any[], graphNodes: any[]): any[] {
    const relevantFiles = candidates
      .slice(0, 10) // Limit to top 10 candidates
      .map(candidate => candidate.file)
      .filter(file => file && this.isJavaScriptFile(file));

    if (relevantFiles.length === 0) {
      return [];
    }

    try {
      return this.jsHeuristics.analyzeFiles(relevantFiles);
    } catch (error) {
      console.warn('[EvidenceAggregator] Failed to apply JS heuristics:', error);
      return [];
    }
  }

  /**
   * Extract relevant files from extraction results
   */
  private extractRelevantFiles(extractionResult: ExtractionResponse): string[] {
    const files = new Set<string>();

    // Add files from candidates
    extractionResult.candidates.forEach(candidate => {
      if (candidate.file) {
        files.add(candidate.file);
      }
    });

    // Add files from graph nodes
    extractionResult.graph.nodes.forEach(node => {
      if (node.file) {
        files.add(node.file);
      }
    });

    // Add files from evidence frames
    extractionResult.evidence.frames.forEach(frame => {
      if (frame.file) {
        files.add(frame.file);
      }
    });

    return Array.from(files);
  }

  /**
   * Check if file is a JavaScript/TypeScript file
   */
  private isJavaScriptFile(filePath: string): boolean {
    const jsExtensions = ['.js', '.jsx', '.ts', '.tsx', '.mjs', '.cjs'];
    return jsExtensions.some(ext => filePath.toLowerCase().endsWith(ext));
  }

  /**
   * Deduplicate git changes by hash
   */
  private deduplicateGitChanges(changes: GitChange[]): GitChange[] {
    const seen = new Set<string>();
    return changes.filter(change => {
      if (seen.has(change.hash)) {
        return false;
      }
      seen.add(change.hash);
      return true;
    });
  }

  /**
   * Get summary of evidence for logging
   */
  getEvidenceSummary(debugContext: DebugContext): string {
    const { gitChanges, heuristicFindings, candidates, evidence } = debugContext;
    
    return [
      `Git changes: ${gitChanges.length}`,
      `Heuristic findings: ${heuristicFindings.length}`,
      `Candidate files: ${candidates.length}`,
      `Evidence frames: ${evidence.frames.length}`,
      `Error: ${evidence.error || 'None'}`
    ].join(', ');
  }
}
