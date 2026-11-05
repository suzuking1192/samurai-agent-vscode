/**
 * Enhanced Feedback Refiner for Root Cause Analysis
 * 
 * Updates and refines hypotheses based on test results and findings
 * with machine-tight LLM contracts, lineage tracking, and robust controls
 */

import { LLMProviderService } from '../../llm/llmProviderService';
import { LLMMessage, LLMRequest } from '../../../common/models/llm-models';
import { DebugContext, Hypothesis, FindingFeedback, IterationMemory, LLMCallDebugInfo, truncateDebugText } from './rootCauseTypes';
import { llmCache } from '../../../common/utils/llmCache';
import * as crypto from 'crypto';

interface RefinementBudget {
  maxIter: number;
  msMax: number;
  msSpent: number;
  tokensUsed: number;
  maxTokens: number;
}

interface RefinementPolicy {
  mode: 'exploit' | 'explore';
  maxHypotheses: number;
  diversityThreshold: number;
}

interface RefinedHypothesis {
  id: string;
  action: 'keep' | 'revise' | 'replace';
  summary: string;
  rationale: string;
  evidence: string[];
  relatedFiles: string[];
  relatedNodes: string[];
  confidence: number;
}

interface RefinementResponse {
  hypotheses: RefinedHypothesis[];
  reasoningSummary: string;
}

export class FeedbackRefiner {
  private llmProvider: LLMProviderService;
  private readonly TIMEOUT_MS = 30000;
  private readonly MAX_HYPOTHESES = 3;
  private readonly DIVERSITY_THRESHOLD = 0.8;

  private llmDebugCalls: LLMCallDebugInfo[] = [];

  constructor(llmProvider: LLMProviderService) {
    this.llmProvider = llmProvider;
  }

  getLLMDebugInfo(): LLMCallDebugInfo[] {
    return this.llmDebugCalls;
  }

  clearLLMDebugInfo(): void {
    this.llmDebugCalls = [];
  }

  /**
   * Refine hypotheses based on test feedback with enhanced controls
   */
  async refineHypotheses(
    hypotheses: Hypothesis[],
    feedback: FindingFeedback[],
    debugContext: DebugContext,
    model: string,
    iterationMemory?: IterationMemory,
    budget?: RefinementBudget
  ): Promise<{
    refinedHypotheses: Hypothesis[];
    shouldContinue: boolean;
    reasoningSummary: string;
    delta: {
      kept: string[];
      revised: string[];
      replaced: Array<{ from: string; to: string }>;
    };
  }> {
    console.log('[FeedbackRefiner] Refining hypotheses based on feedback');

    const startTime = Date.now();
    const currentBudget: RefinementBudget = budget || {
      maxIter: 3,
      msMax: 300000, // 5 minutes
      msSpent: 0,
      tokensUsed: 0,
      maxTokens: 10000
    };

    try {
      // Analyze feedback to determine next steps
      const analysis = this.analyzeFeedback(hypotheses, feedback);
      
      if (!analysis.shouldRefine) {
        return {
          refinedHypotheses: hypotheses,
          shouldContinue: false,
          reasoningSummary: analysis.reasoning,
          delta: { kept: hypotheses.map(h => h.id), revised: [], replaced: [] }
        };
      }

      // Determine policy based on current state
      const policy = this.determinePolicy(hypotheses, feedback, analysis);
      
      // Generate refined hypotheses using LLM
      const refinedHypotheses = await this.generateRefinedHypotheses(
        hypotheses,
        feedback,
        debugContext,
        model,
        iterationMemory,
        policy,
        currentBudget
      );

      // Apply diversity filtering and merge duplicates
      const filteredHypotheses = this.filterForDiversity(refinedHypotheses);
      
      // Calculate delta for tracking changes
      const delta = this.calculateDelta(hypotheses, filteredHypotheses);

      // Update budget
      currentBudget.msSpent += Date.now() - startTime;

      // Determine if should continue
      const shouldContinue = this.shouldContinueIteration(
        filteredHypotheses,
        feedback,
        iterationMemory,
        currentBudget
      );

      // Build reasoning summary
      const reasoningSummary = this.buildReasoningSummary(
        hypotheses,
        feedback,
        filteredHypotheses,
        analysis,
        delta
      );

      console.log('[FeedbackRefiner] Refinement completed:', {
        originalCount: hypotheses.length,
        refinedCount: filteredHypotheses.length,
        shouldContinue,
        delta,
        budgetUsed: currentBudget.msSpent
      });

      return {
        refinedHypotheses: filteredHypotheses,
        shouldContinue,
        reasoningSummary,
        delta
      };

    } catch (error) {
      console.error('[FeedbackRefiner] Error refining hypotheses:', error);
      
      // Fallback: return original hypotheses with simple heuristic adjustments
      const fallbackHypotheses = this.createFallbackHypotheses(hypotheses, feedback, debugContext);
      
      return {
        refinedHypotheses: fallbackHypotheses,
        shouldContinue: false,
        reasoningSummary: 'Error occurred during refinement, applied fallback heuristics',
        delta: { kept: [], revised: [], replaced: [] }
      };
    }
  }

  /**
   * Analyze feedback to determine if refinement is needed
   */
  private analyzeFeedback(
    hypotheses: Hypothesis[],
    feedback: FindingFeedback[]
  ): {
    shouldRefine: boolean;
    reasoning: string;
    confirmedCount: number;
    refutedCount: number;
    uncertainCount: number;
  } {
    const confirmedCount = feedback.filter(f => f.verdict === 'confirmed').length;
    const refutedCount = feedback.filter(f => f.verdict === 'refuted').length;
    const uncertainCount = feedback.filter(f => f.verdict === 'uncertain').length;

    let shouldRefine = false;
    let reasoning = '';

    if (confirmedCount > 0) {
      reasoning = `Found ${confirmedCount} confirmed hypothesis(es), analysis is conclusive`;
      shouldRefine = false;
    } else if (refutedCount === hypotheses.length) {
      reasoning = `All hypotheses were refuted, need to generate new ones`;
      shouldRefine = true;
    } else if (uncertainCount > 0) {
      reasoning = `Found ${uncertainCount} uncertain hypothesis(es), need refinement`;
      shouldRefine = true;
    } else {
      reasoning = 'No clear verdict, keeping current hypotheses';
      shouldRefine = false;
    }

    return {
      shouldRefine,
      reasoning,
      confirmedCount,
      refutedCount,
      uncertainCount
    };
  }

  /**
   * Determine refinement policy based on current state
   */
  private determinePolicy(
    hypotheses: Hypothesis[],
    feedback: FindingFeedback[],
    analysis: any
  ): RefinementPolicy {
    const hasConfirmed = analysis.confirmedCount > 0;
    const allRefuted = analysis.refutedCount === hypotheses.length;
    const hasUncertain = analysis.uncertainCount > 0;
    
    // Exploit mode: when we have confirmed or close-to-confirmed hypotheses
    // Explore mode: when all are refuted or we need to find new directions
    const mode = (hasConfirmed || (hasUncertain && !allRefuted)) ? 'exploit' : 'explore';
    
    return {
      mode,
      maxHypotheses: this.MAX_HYPOTHESES,
      diversityThreshold: this.DIVERSITY_THRESHOLD
    };
  }

  /**
   * Generate refined hypotheses using LLM with enhanced controls
   */
  private async generateRefinedHypotheses(
    hypotheses: Hypothesis[],
    feedback: FindingFeedback[],
    debugContext: DebugContext,
    model: string,
    iterationMemory: IterationMemory | undefined,
    policy: RefinementPolicy,
    budget: RefinementBudget
  ): Promise<Hypothesis[]> {
    const prompt = this.buildRefinementPrompt(
      hypotheses,
      feedback,
      debugContext,
      iterationMemory,
      policy
    );

    // Create enhanced cache key
    const cacheKey = this.createCacheKey(hypotheses, feedback, debugContext, policy);
    let response = llmCache.getCachedResponse(cacheKey);
    
    if (!response) {
      response = await this.callLLMWithTimeout(prompt, model, budget);
      llmCache.setCachedResponse(cacheKey, response, 30 * 60 * 1000);
    }

    // Parse response with fenced JSON extraction
    const parsed = this.parseRefinementResponse(response.content || '');
    if (!parsed) {
      throw new Error('Failed to parse LLM response');
    }

    // Reconcile and preserve lineage
    return this.reconcileRefinedHypotheses(parsed.hypotheses, hypotheses, debugContext);
  }

  /**
   * Build compact, structured refinement prompt
   */
  private buildRefinementPrompt(
    hypotheses: Hypothesis[],
    feedback: FindingFeedback[],
    debugContext: DebugContext,
    iterationMemory: IterationMemory | undefined,
    policy: RefinementPolicy
  ): string {
    // Categorize hypotheses by verdict
    const hypothesisMap = new Map(hypotheses.map(h => [h.id, h]));
    const kept = feedback.filter(f => f.verdict === 'confirmed').map(f => f.hypothesisId);
    const uncertain = feedback.filter(f => f.verdict === 'uncertain').map(f => f.hypothesisId);
    const refuted = feedback.filter(f => f.verdict === 'refuted').map(f => f.hypothesisId);

    // Build compact hypothesis lists
    const keptList = kept.map(id => {
      const h = hypothesisMap.get(id)!;
      return `${id}: ${h.summary} (${h.confidence.toFixed(2)})`;
    });

    const uncertainList = uncertain.map(id => {
      const h = hypothesisMap.get(id)!;
      const f = feedback.find(f => f.hypothesisId === id)!;
      return `${id}: ${h.summary} (${f.revisedConfidence.toFixed(2)}) - ${f.newClues.slice(0, 2).join(', ')}`;
    });

    const refutedList = refuted.map(id => {
      const h = hypothesisMap.get(id)!;
      const f = feedback.find(f => f.hypothesisId === id)!;
      return `${id}: ${h.summary} (${f.revisedConfidence.toFixed(2)}) - ${f.newClues.slice(0, 2).join(', ')}`;
    });

    // Get top new clues and static findings
    const topClues = this.extractTopClues(feedback);
    const topFindings = this.extractTopFindings(debugContext);
    const uncoveredRegions = this.findUncoveredRegions(hypotheses, debugContext);

    // Build allowlists
    const allowedFiles = debugContext.candidates.map(c => this.normalizePath(c.file));
    const allowedNodeIds = debugContext.graph.nodes.map(n => n.id);
    const allowedSnippetIds = debugContext.snippets.map(s => s.id);

    return `Refine these bug hypotheses based on test results:

KEPT (confirmed): ${keptList.join('; ') || 'none'}
UNCERTAIN (revise): ${uncertainList.join('; ') || 'none'}
REFUTED (replace): ${refutedList.join('; ') || 'none'}

NEW CLUES: ${topClues.join(', ')}
STATIC FINDINGS: ${topFindings.join(', ')}
UNCOVERED REGIONS: ${uncoveredRegions.join(', ')}

POLICY: ${policy.mode} mode (max ${policy.maxHypotheses} hypotheses)

ALLOWED FILES: ${allowedFiles.join(', ')}
ALLOWED NODES: ${allowedNodeIds.join(', ')}
ALLOWED SNIPPETS: ${allowedSnippetIds.join(', ')}

You MUST reply with JSON only inside a single code fence:
\`\`\`json
{
  "hypotheses": [
    {
      "id": "string",
      "action": "keep|revise|replace",
      "summary": "string",
      "rationale": "string",
      "evidence": ["string"],
      "relatedFiles": ["posix/path"],
      "relatedNodes": ["GraphNodeId"],
      "confidence": 0.0-1.0
    }
  ],
  "reasoningSummary": "string"
}
\`\`\`

Rules:
* Use only file paths from allowedFiles and node IDs from allowedNodeIds
* Keep confirmed hypotheses intact; for uncertain, revise; for refuted, propose replacements
* Return at most 3 hypotheses total
* For replace actions, use id format "new:<slug>"
* Ground all evidence in concrete findings and observations`;
  }

  /**
   * Call LLM with timeout and retry
   */
  private async callLLMWithTimeout(prompt: string, model: string, budget: RefinementBudget): Promise<any> {
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
      id: `hypothesis-refine-${Date.now()}`,
      provider: '',
      model,
      messages,
      temperature: 0.2,
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

      if (llmResponse.type !== 'success' || !llmResponse.payload) {
        throw new Error('Failed to get LLM response');
      }

      // Capture debug info for successful calls
      const duration = Date.now() - startTime;
      const systemPrompt = this.loadSystemPrompt();
      const tokensUsed = (llmResponse.payload as any)?.usage?.totalTokens;
      const content = (llmResponse.payload as any)?.content || '';
      
      const debugInfo: LLMCallDebugInfo = {
        id: `feedback-refine-${Date.now()}`,
        stage: 'feedback-refinement',
        timestamp: startTime,
        request: {
          prompt: truncateDebugText(prompt),
          systemPrompt: truncateDebugText(systemPrompt),
          model,
          temperature: 0.2,
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
        id: `feedback-refine-${Date.now()}`,
        stage: 'feedback-refinement',
        timestamp: startTime,
        request: {
          prompt: truncateDebugText(prompt.substring(0, 200)), // Only first 200 chars for errors
          model,
          temperature: 0.2,
          maxTokens: 20000
        },
        error: error instanceof Error ? error.message : String(error)
      };
      this.llmDebugCalls.push(debugInfo);

      if (Date.now() - startTime < this.TIMEOUT_MS && 
          error instanceof Error && (error.message.includes('rate limit') || error.message.includes('timeout'))) {
        await new Promise(resolve => setTimeout(resolve, 1000));
        return this.callLLMWithTimeout(prompt, model, budget);
      }
      throw error;
    }
  }

  /**
   * Parse LLM response with fenced JSON extraction and validation
   */
  private parseRefinementResponse(content: string): RefinementResponse | null {
    try {
      const fencedJson = this.extractFencedJson(content);
      const jsonContent = fencedJson || content;
      
      const repaired = this.tryJsonRepair(jsonContent);
      const parsed = JSON.parse(repaired);
      
      // Basic schema validation
      if (!parsed.hypotheses || !Array.isArray(parsed.hypotheses)) {
        return null;
      }

      return {
        hypotheses: parsed.hypotheses.map((h: any) => ({
          id: h.id || 'unknown',
          action: h.action || 'revise',
          summary: h.summary || 'Unknown cause',
          rationale: h.rationale || 'No rationale provided',
          evidence: Array.isArray(h.evidence) ? h.evidence : [],
          relatedFiles: Array.isArray(h.relatedFiles) ? h.relatedFiles : [],
          relatedNodes: Array.isArray(h.relatedNodes) ? h.relatedNodes : [],
          confidence: Math.max(0, Math.min(1, h.confidence || 0.5))
        })),
        reasoningSummary: parsed.reasoningSummary || 'No reasoning provided'
      };
    } catch (error) {
      console.warn('[FeedbackRefiner] Failed to parse refinement response:', error);
      return null;
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
   * Try to repair minor JSON issues
   */
  private tryJsonRepair(json: string): string {
    return json
      .replace(/,(\s*[}\]])/g, '$1') // Remove trailing commas
      .replace(/([{,]\s*)(\w+):/g, '$1"$2":') // Add quotes to unquoted keys
      .replace(/:(\s*)([^",{\[\s][^",}\]\s]*?)(\s*[,}])/g, ':$1"$2"$3'); // Add quotes to unquoted string values
  }

  /**
   * Reconcile refined hypotheses with originals and preserve lineage
   */
  private reconcileRefinedHypotheses(
    refined: RefinedHypothesis[],
    originals: Hypothesis[],
    debugContext: DebugContext
  ): Hypothesis[] {
    const originalMap = new Map(originals.map(h => [h.id, h]));
    const allowedFiles = new Set(debugContext.candidates.map(c => this.normalizePath(c.file)));
    const allowedNodes = new Set(debugContext.graph.nodes.map(n => n.id));
    const allowedSnippets = new Set(debugContext.snippets.map(s => s.id));

    return refined.map((h, index) => {
      const base = originalMap.get(h.id);
      const isNew = h.id.startsWith('new:') || !base;
      
      return {
        id: isNew ? `refined_${Date.now()}_${index}` : h.id,
        summary: h.summary,
        evidence: h.evidence,
        relatedNodes: h.relatedNodes.filter(id => allowedNodes.has(id)),
        confidence: h.confidence,
        normalizedConfidence: this.calculateNormalizedConfidence(h, debugContext),
        rationale: h.rationale,
        relatedFiles: h.relatedFiles
          .map(f => this.normalizePath(f))
          .filter(f => allowedFiles.has(f)),
        parentId: isNew ? undefined : h.id,
        changeReason: `${h.action}: ${h.rationale.substring(0, 100)}`,
        verifiedNodes: h.relatedNodes.filter(id => allowedNodes.has(id)),
        verifiedSnippets: [], // Will be populated by tester
        checks: [], // Will be populated by generator
        assumptions: [] // Will be populated by generator
      };
    });
  }

  /**
   * Calculate normalized confidence combining multiple signals
   */
  private calculateNormalizedConfidence(hypothesis: RefinedHypothesis, debugContext: DebugContext): number {
    const llmConfidence = hypothesis.confidence;
    
    // Evidence richness (count and quality of evidence)
    const evidenceRichness = Math.min(hypothesis.evidence.length / 5, 1);
    
    // Error path proximity (simplified)
    const errorPathProximity = this.calculateErrorPathProximity(hypothesis, debugContext);
    
    // Git recency score
    const gitRecency = this.calculateGitRecency(hypothesis, debugContext);
    
    // Combine signals
    const signals = 0.4 * evidenceRichness + 0.3 * errorPathProximity + 0.3 * gitRecency;
    
    return 0.6 * llmConfidence + 0.4 * signals;
  }

  /**
   * Calculate error path proximity score
   */
  private calculateErrorPathProximity(hypothesis: RefinedHypothesis, debugContext: DebugContext): number {
    const errorNodes = debugContext.graph.nodes.filter(n => n.badges?.includes('error'));
    if (errorNodes.length === 0) return 0.5;
    
    // Simple proximity: check if hypothesis nodes are connected to error nodes
    const hypothesisNodes = new Set(hypothesis.relatedNodes);
    const hasConnection = errorNodes.some(errorNode => 
      hypothesisNodes.has(errorNode.id) || 
      debugContext.graph.edges.some(e => 
        e.from === errorNode.id && hypothesisNodes.has(e.to)
      )
    );
    
    return hasConnection ? 1.0 : 0.3;
  }

  /**
   * Calculate git recency score
   */
  private calculateGitRecency(hypothesis: RefinedHypothesis, debugContext: DebugContext): number {
    if (debugContext.gitChanges.length === 0) return 0.5;
    
    const now = Date.now();
    const halfLife = 7 * 24 * 60 * 60 * 1000; // 7 days
    
    const relevantChanges = debugContext.gitChanges.filter(change =>
      change.files.some(f => hypothesis.relatedFiles.includes(f.path))
    );
    
    if (relevantChanges.length === 0) return 0.3;
    
    const mostRecent = relevantChanges[0];
    const daysSince = (now - mostRecent.date.getTime()) / (24 * 60 * 60 * 1000);
    
    return Math.exp(-daysSince / 7);
  }

  /**
   * Filter hypotheses for diversity
   */
  private filterForDiversity(hypotheses: Hypothesis[]): Hypothesis[] {
    const filtered: Hypothesis[] = [];
    
    for (const hypothesis of hypotheses) {
      const isDuplicate = filtered.some(existing => 
        this.calculateJaccardSimilarity(hypothesis, existing) > this.DIVERSITY_THRESHOLD
      );
      
      if (!isDuplicate) {
        filtered.push(hypothesis);
      } else {
        // Merge with existing if it has higher confidence
        const existing = filtered.find(h => 
          this.calculateJaccardSimilarity(hypothesis, h) > this.DIVERSITY_THRESHOLD
        );
        if (existing && hypothesis.confidence > existing.confidence) {
          const index = filtered.indexOf(existing);
          filtered[index] = this.mergeHypotheses([existing, hypothesis])[0];
        }
      }
    }
    
    return filtered.slice(0, this.MAX_HYPOTHESES);
  }

  /**
   * Calculate Jaccard similarity between two hypotheses
   */
  private calculateJaccardSimilarity(h1: Hypothesis, h2: Hypothesis): number {
    const set1 = new Set([...h1.relatedFiles, ...h1.relatedNodes]);
    const set2 = new Set([...h2.relatedFiles, ...h2.relatedNodes]);
    
    const intersection = new Set([...set1].filter(x => set2.has(x)));
    const union = new Set([...set1, ...set2]);
    
    return union.size > 0 ? intersection.size / union.size : 0;
  }

  /**
   * Calculate delta for tracking changes
   */
  private calculateDelta(original: Hypothesis[], refined: Hypothesis[]): {
    kept: string[];
    revised: string[];
    replaced: Array<{ from: string; to: string }>;
  } {
    const originalMap = new Map(original.map(h => [h.id, h]));
    const kept: string[] = [];
    const revised: string[] = [];
    const replaced: Array<{ from: string; to: string }> = [];
    
    for (const hypothesis of refined) {
      if (hypothesis.parentId) {
        if (originalMap.has(hypothesis.parentId)) {
          if (hypothesis.id === hypothesis.parentId) {
            kept.push(hypothesis.id);
          } else {
            revised.push(hypothesis.id);
          }
        } else {
          // This is a replacement
          replaced.push({ from: hypothesis.parentId, to: hypothesis.id });
        }
      } else {
        // New hypothesis
        replaced.push({ from: 'new', to: hypothesis.id });
      }
    }
    
    return { kept, revised, replaced };
  }

  /**
   * Determine if iteration should continue with enhanced logic
   */
  private shouldContinueIteration(
    hypotheses: Hypothesis[],
    feedback: FindingFeedback[],
    iterationMemory: IterationMemory | undefined,
    budget: RefinementBudget
  ): boolean {
    // Stop if we have confirmed hypotheses
    if (feedback.some(f => f.verdict === 'confirmed')) return false;
    
    // Stop if we've reached max iterations
    const currentIteration = (iterationMemory?.iteration || 0) + 1;
    if (currentIteration >= budget.maxIter) return false;
    
    // Stop if budget exceeded
    if (budget.msSpent >= budget.msMax) return false;
    
    // Continue if we have uncertain hypotheses with new clues
    const uncertainCount = feedback.filter(f => f.verdict === 'uncertain').length;
    const hasNewClues = feedback.some(f => f.newClues.length > 0);
    const avgConfidence = hypotheses.reduce((sum, h) => 
      sum + (h.normalizedConfidence || h.confidence), 0) / hypotheses.length;
    
    return uncertainCount > 0 && avgConfidence < 0.7 && hasNewClues;
  }

  /**
   * Create fallback hypotheses when LLM fails
   */
  private createFallbackHypotheses(
    hypotheses: Hypothesis[],
    feedback: FindingFeedback[],
    debugContext: DebugContext
  ): Hypothesis[] {
    const fallback: Hypothesis[] = [];
    
    // Keep confirmed hypotheses
    const confirmed = feedback.filter(f => f.verdict === 'confirmed');
    for (const f of confirmed) {
      const original = hypotheses.find(h => h.id === f.hypothesisId);
      if (original) {
        fallback.push({ ...original, normalizedConfidence: f.revisedConfidence });
      }
    }
    
    // If we have confirmed hypotheses, only return those
    if (confirmed.length > 0) {
      return fallback;
    }
    
    // Promote best uncertain hypothesis
    const uncertain = feedback.filter(f => f.verdict === 'uncertain');
    if (uncertain.length > 0) {
      const bestUncertain = uncertain.reduce((best, current) => 
        current.revisedConfidence > best.revisedConfidence ? current : best
      );
      const original = hypotheses.find(h => h.id === bestUncertain.hypothesisId);
      if (original) {
        fallback.push({ 
          ...original, 
          normalizedConfidence: bestUncertain.revisedConfidence,
          changeReason: 'promoted from uncertain'
        });
      }
    }
    
    // Generate one exploratory hypothesis if all were refuted
    const allRefuted = feedback.every(f => f.verdict === 'refuted');
    if (allRefuted && debugContext.gitChanges.length > 0) {
      const latestChange = debugContext.gitChanges[0];
      const newHypothesis: Hypothesis = {
        id: `fallback_${Date.now()}`,
        summary: `Recent change in ${latestChange.files[0]?.path} may have introduced the bug`,
        evidence: [`Recent commit: ${latestChange.message}`],
        relatedNodes: [],
        confidence: 0.4,
        normalizedConfidence: 0.4,
        rationale: 'Generated as fallback when all hypotheses were refuted',
        relatedFiles: latestChange.files.map(f => f.path),
        changeReason: 'exploratory fallback'
      };
      fallback.push(newHypothesis);
    }
    
    return fallback.length > 0 ? fallback : hypotheses;
  }

  /**
   * Extract top clues from feedback
   */
  private extractTopClues(feedback: FindingFeedback[]): string[] {
    return feedback
      .flatMap(f => f.newClues)
      .slice(0, 3);
  }

  /**
   * Extract top findings from debug context
   */
  private extractTopFindings(debugContext: DebugContext): string[] {
    return debugContext.heuristicFindings
      .sort((a, b) => {
        const severityOrder = { high: 3, medium: 2, low: 1 };
        return severityOrder[b.severity] - severityOrder[a.severity];
      })
      .slice(0, 5)
      .map(f => `${f.pattern}: ${f.rationale}`);
  }

  /**
   * Find uncovered regions (files not referenced by any hypothesis)
   */
  private findUncoveredRegions(hypotheses: Hypothesis[], debugContext: DebugContext): string[] {
    const coveredFiles = new Set(hypotheses.flatMap(h => h.relatedFiles));
    return debugContext.candidates
      .map(c => this.normalizePath(c.file))
      .filter(file => !coveredFiles.has(file))
      .slice(0, 5);
  }

  /**
   * Create enhanced cache key
   */
  private createCacheKey(
    hypotheses: Hypothesis[],
    feedback: FindingFeedback[],
    debugContext: DebugContext,
    policy: RefinementPolicy
  ): string {
    const hypothesisIds = hypotheses.map(h => h.id).sort();
    const verdicts = feedback.map(f => `${f.hypothesisId}:${f.verdict}`).sort();
    const graphFingerprint = this.digestIds(debugContext.graph.nodes.map(n => n.id));
    
    return crypto.createHash('sha256').update(JSON.stringify({
      hypothesisIds,
      verdicts,
      commit: debugContext.commitHash,
      graph: graphFingerprint,
      policy: policy.mode
    })).digest('hex');
  }

  /**
   * Digest node IDs for fingerprinting
   */
  private digestIds(ids: string[]): string {
    return crypto.createHash('sha256').update(ids.sort().join(',')).digest('hex').slice(0, 8);
  }

  /**
   * Build reasoning summary with delta information
   */
  private buildReasoningSummary(
    originalHypotheses: Hypothesis[],
    feedback: FindingFeedback[],
    refinedHypotheses: Hypothesis[],
    analysis: any,
    delta: any
  ): string {
    let summary = `Analysis: ${analysis.confirmedCount} confirmed, ${analysis.refutedCount} refuted, ${analysis.uncertainCount} uncertain. `;
    
    if (delta.kept.length > 0) {
      summary += `Kept: ${delta.kept.join(', ')}. `;
    }
    
    if (delta.revised.length > 0) {
      summary += `Revised: ${delta.revised.join(', ')}. `;
    }
    
    if (delta.replaced.length > 0) {
      const replacements = delta.replaced.map((r: any) => `${r.from}→${r.to}`).join(', ');
      summary += `Replaced: ${replacements}. `;
    }
    
    summary += `Generated ${refinedHypotheses.length} refined hypotheses.`;
    
    return summary;
  }

  /**
   * Merge hypotheses to avoid duplicates
   */
  private mergeHypotheses(hypotheses: Hypothesis[]): Hypothesis[] {
    if (hypotheses.length <= 1) return hypotheses;
    
    const [h1, h2] = hypotheses;
    return [{
      ...h1,
      evidence: [...new Set([...h1.evidence, ...h2.evidence])],
      relatedNodes: [...new Set([...h1.relatedNodes, ...h2.relatedNodes])],
      relatedFiles: [...new Set([...h1.relatedFiles, ...h2.relatedFiles])],
      confidence: Math.max(h1.confidence, h2.confidence),
      normalizedConfidence: Math.max(
        h1.normalizedConfidence || h1.confidence,
        h2.normalizedConfidence || h2.confidence
      )
    }];
  }

  /**
   * Load system prompt
   */
  private loadSystemPrompt(): string {
    return `You are a senior software engineer refining bug hypotheses based on test results.

You MUST reply with JSON only inside a single code fence:

\`\`\`json
{ ... }
\`\`\`

Your task is to:
1. Keep confirmed hypotheses as-is
2. Improve uncertain hypotheses with new insights
3. Replace refuted hypotheses with new possibilities
4. Ensure all hypotheses are evidence-based and specific
5. Use only allowlisted file paths and node IDs
6. Return at most 3 hypotheses total

Rules:
* Use only file paths from allowedFiles and node IDs from allowedNodeIds
* Keep confirmed hypotheses intact; for uncertain, revise; for refuted, propose replacements
* Return at most 3 hypotheses total
* For replace actions, use id format "new:<slug>"
* Ground all evidence in concrete findings and observations`;
  }

  /**
   * Normalize file path
   */
  private normalizePath(filePath: string): string {
    return filePath.replace(/\\/g, '/');
  }
}