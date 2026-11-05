/**
 * Enhanced Hypothesis Generator for Root Cause Analysis
 * 
 * Generates multiple ranked hypotheses using LLM + heuristics with improved
 * safety, accuracy, and cost efficiency
 */

import { LLMProviderService } from '../../llm/llmProviderService';
import { LLMMessage, LLMRequest } from '../../../common/models/llm-models';
import { DebugContext, Hypothesis, LLMCallDebugInfo, truncateDebugText } from './rootCauseTypes';
import { FeedbackRecord } from '../feedback/FeedbackTypes';
import { llmCache } from '../../../common/utils/llmCache';
import { GraphNode, GraphEdge } from './types';
import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import { loadDebuggingPrompt } from './promptLoader';
import { ResponseType } from '../../../common/models/response-models';

interface CompactContext {
  errorLine: string;
  stackFrames: Array<{ file: string; line: number; function: string }>;
  logSignatures: string[];
  gitChanges: Array<{ hash: string; message: string; files: string[]; relevance: number }>;
  graphPaths: Array<{ from: string; to: string; distance: number }>;
  heuristicFindings: Array<{ file: string; line: number; pattern: string; severity: string }>;
  allowedFiles: string[];
  allowedNodeIds: string[];
  codeSnippets: string[];
  chatSummary?: string;
}

interface HypothesisSchema {
  hypotheses: Array<{
    id: string;
    summary: string;
    evidence: string[];
    relatedNodes: string[];
    relatedFiles: string[];
    confidence: number;
    checks: string[];
    assumptions: string[];
  }>;
}

interface GraphCandidate {
  id: string;
  reason: string;
  score: number;
  neighborhood: { nodes: GraphNode[]; edges: GraphEdge[] };
}

interface FocusSelection {
  focusNodes: string[];
  reason: string;
}

export class HypothesisGenerator {
  private llmProvider: LLMProviderService;
  private workspaceRoot?: string;
  private hypothesisCache = new Map<string, { data: Hypothesis[]; timestamp: number }>();
  private readonly CACHE_TTL = 30 * 60 * 1000; // 30 minutes
  private readonly MAX_HYPOTHESES = 3;
  private readonly MAX_SIMILARITY = 0.9; // Less aggressive filtering
  
  // Hybrid graph-LLM constants
  private readonly MAX_GRAPH_CANDIDATES = 5;
  private readonly UPSTREAM_HOPS = 2;
  private readonly DOWNSTREAM_HOPS = 1;
  private readonly MAX_CONTEXT_CHARS = 8000;
  private readonly FOCUS_LLM_MAX_TOKENS = 20000;
  private readonly MAX_SNIPPETS_PER_FILE = 10;

  private llmDebugCalls: LLMCallDebugInfo[] = [];

  constructor(llmProvider: LLMProviderService, workspaceRoot?: string) {
    this.llmProvider = llmProvider;
    this.workspaceRoot = workspaceRoot;
  }

  getLLMDebugInfo(): LLMCallDebugInfo[] {
    return this.llmDebugCalls;
  }

  clearLLMDebugInfo(): void {
    this.llmDebugCalls = [];
  }

  /**
   * Get config value from environment variable with default
   */
  private getConfigValue(key: string, defaultValue: number): number {
    const envValue = process.env[key];
    if (envValue) {
      const parsed = parseInt(envValue, 10);
      if (!isNaN(parsed) && parsed > 0) {
        return parsed;
      }
    }
    return defaultValue;
  }

  /**
   * Calculate adaptive maxTokens based on context size
   */
  private calculateMaxTokens(debugContext: DebugContext): number {
    // Check for explicit override
    const override = this.getConfigValue('HYPOTHESIS_MAX_TOKENS', 0);
    if (override > 0) {
      return Math.min(override, 65536); // Cap at 65536 (safe for Gemini 2.5 Flash)
    }

    const baseMax = 20000;
    const heavyContext = 
      (debugContext.candidates?.length ?? 0) > 5 ||
      (debugContext.logs?.length ?? 0) > 2000 ||
      Boolean(debugContext.evidence?.chatSummary);

    const maxTokens = heavyContext ? 65536 : baseMax;
    return Math.min(maxTokens, 65536); // Cap at 65536 (safe for Gemini 2.5 Flash)
  }

  /**
   * Generate hypotheses with diversity sampling and validation
   * Uses hybrid graph-first + LLM validation approach
   */
  async generateHypotheses(
    debugContext: DebugContext,
    model: string,
    feedbackExamples?: FeedbackRecord[],
    chatHistory?: LLMMessage[],
    chatSummary?: string,
    options?: { forcedFocusNodeId?: string }
  ): Promise<Hypothesis[]> {
    console.log('[HypothesisGenerator] Generating hypotheses with hybrid graph-LLM approach');

    // Create cache key with more context
    const cacheKey = this.createCacheKey(debugContext, chatHistory, chatSummary);
    
    // Check cache first
    const cached = this.getCached(cacheKey);
    if (cached) {
      console.log('[HypothesisGenerator] Using cached hypotheses');
      return cached;
    }

    try {
      // Stage 1: Generate graph candidates (deterministic)
      const candidates = this.generateGraphCandidates(debugContext);
      console.log('[HypothesisGenerator] graph_candidates_generated:', candidates.length);
      
      // Stage 2: LLM focus check (if multiple candidates)
      let selectedNodeIds: string[] = [];
      let llmFocusFallback = false;
      let usedForcedFocus = false;
      
      // Check for forced focus override first
      if (options?.forcedFocusNodeId) {
        const forcedId = options.forcedFocusNodeId;
        
        // Safeguard #1: Validate against BOTH candidates AND graph nodes
        const inCandidates = candidates.some(c => c.id === forcedId);
        const inGraph = debugContext.graph.nodes.some(n => n.id === forcedId);
        
        if (inCandidates || inGraph) {
          selectedNodeIds = [forcedId];
          usedForcedFocus = true;
          console.log('[HypothesisGenerator] using_forced_focus:', forcedId, {
            inCandidates,
            inGraph
          });
        } else {
          console.warn('[HypothesisGenerator] forced_focus_invalid:', forcedId, 'not found in candidates or graph');
          // Fall through to normal LLM selection
        }
      }
      
      // If no forced focus was applied, proceed with LLM selection
      if (!usedForcedFocus) {
        if (candidates.length > 1) {
          try {
            const focusResult = await this.llmSelectFocus(
              debugContext.bugDescription || debugContext.userMessage,
              debugContext.logs,
              candidates,
              model
            );
            
            // Validate LLM selected nodes exist in graph
            const nodeIdSet = new Set(debugContext.graph.nodes.map(n => n.id));
            const validFocus = focusResult.focusNodes.filter(id => nodeIdSet.has(id));
            
            if (validFocus.length > 0) {
              selectedNodeIds = validFocus;
              console.log('[HypothesisGenerator] llm_focus_selected:', selectedNodeIds);
              console.log('[HypothesisGenerator] llm_focus_reason:', focusResult.reason);
            } else {
              // LLM picked invalid nodes, fallback to first candidate
              selectedNodeIds = [candidates[0].id];
              llmFocusFallback = true;
              console.log('[HypothesisGenerator] llm_focus_fallback: true (invalid node IDs selected)');
            }
          } catch (error) {
            // LLM call failed, fallback to first candidate
            selectedNodeIds = [candidates[0].id];
            llmFocusFallback = true;
            console.log('[HypothesisGenerator] llm_focus_fallback: true (LLM call failed)', error);
          }
        } else if (candidates.length === 1) {
          // Only one candidate, use it directly
          selectedNodeIds = [candidates[0].id];
          console.log('[HypothesisGenerator] Single candidate selected:', selectedNodeIds);
        } else {
          // No candidates, proceed with full context
          console.log('[HypothesisGenerator] No candidates generated, using full context');
        }
      }

      // Stage 3: Build filtered code context from selected nodes
      let workingContext = debugContext;
      if (selectedNodeIds.length > 0) {
        workingContext = this.buildCodeContextFromGraph(debugContext, selectedNodeIds);
        console.log('[HypothesisGenerator] filtered_context_size:', {
          nodes: workingContext.graph.nodes.length,
          edges: workingContext.graph.edges.length,
          candidates: workingContext.candidates.length,
          chars: JSON.stringify(workingContext).length
        });
      }

      // Stage 4: Build compact context from filtered context
      const compactContext = this.buildCompactContext(workingContext);
      
      // Stage 5: Generate diverse hypotheses using multiple samples with feedback examples
      const allHypotheses = await this.generateDiverseHypotheses(compactContext, model, workingContext, feedbackExamples, chatHistory, chatSummary);
      
      // If no hypotheses were generated, use fallback
      if (allHypotheses.length === 0) {
        console.log('[HypothesisGenerator] No hypotheses generated, using fallback');
        return this.createFallbackHypotheses(workingContext);
      }
      
      // Validate and reconcile references
      const validatedHypotheses = this.reconcileReferences(allHypotheses, workingContext);
      
      // Apply enhanced heuristic scoring
      const scoredHypotheses = this.applyEnhancedHeuristicScoring(validatedHypotheses, workingContext);
      
      // Filter for diversity and cap results
      const finalHypotheses = this.filterForDiversity(scoredHypotheses);
      
      // Cache results
      this.setCached(cacheKey, finalHypotheses);
      
      console.log('[HypothesisGenerator] Generated hypotheses:', finalHypotheses.length);
      return finalHypotheses;

    } catch (error) {
      console.error('[HypothesisGenerator] Error generating hypotheses:', error);
      return this.createFallbackHypotheses(debugContext);
    }
  }

  /**
   * Smart log trimming: keep top 30 lines and 30 lines around first error
   */
  private trimLogs(logs: string): string {
    if (!logs || logs.length <= 2000) {
      return logs;
    }

    const lines = logs.split('\n');
    if (lines.length <= 60) {
      return logs;
    }

    // Find first error line
    const errorLineIndex = lines.findIndex(line => 
      line.toLowerCase().includes('error') || 
      line.toLowerCase().includes('exception') ||
      line.toLowerCase().includes('failed')
    );

    // Keep top 30 lines
    const topLines = lines.slice(0, 30);

    // Keep 30 lines around first error (15 before, 15 after)
    let errorLines: string[] = [];
    if (errorLineIndex >= 0) {
      const start = Math.max(30, errorLineIndex - 15); // Don't overlap with top
      const end = Math.min(lines.length, errorLineIndex + 16);
      errorLines = lines.slice(start, end);
    }

    // Combine and deduplicate
    const trimmed = [...new Set([...topLines, ...errorLines])].join('\n');
    return trimmed;
  }

  /**
   * Build compact context to reduce prompt size
   */
  private buildCompactContext(debugContext: DebugContext): CompactContext {
    // Smart trim logs before processing
    const trimmedLogs = this.trimLogs(debugContext.logs);
    
    // Extract top error line from trimmed logs
    const errorLine = this.extractTopErrorLine(trimmedLogs);
    
    // Extract code snippets from graph nodes
    const codeSnippets: Array<{ file: string; code: string; line?: number; span?: { start: number; end: number } }> = [];
    const fileSnippetCount = new Map<string, number>();
    
    // Extract code from graph nodes (prioritize nodes with error badges, then entry nodes)
    const sortedNodes = [...debugContext.graph.nodes].sort((a, b) => {
      const aScore = (a.badges?.includes('error') ? 10 : 0) + 
                     ((a.badges as string[])?.includes('entry') ? 5 : 0);
      const bScore = (b.badges?.includes('error') ? 10 : 0) + 
                     ((b.badges as string[])?.includes('entry') ? 5 : 0);
      return bScore - aScore;
    });

    // Extract code snippets from top nodes (limit to 20 to avoid prompt bloat)
    for (const node of sortedNodes.slice(0, 20)) {
      if (!node.file) continue;
      
      const filePath = this.normalizePath(node.file);
      // Limit snippets per file to avoid duplication
      const count = fileSnippetCount.get(filePath) || 0;
      if (count >= this.MAX_SNIPPETS_PER_FILE) continue;
      
      const snippet = this.extractCodeFromNode(node, this.workspaceRoot);
      if (snippet && snippet.code) {
        codeSnippets.push(snippet);
        fileSnippetCount.set(filePath, count + 1);
      }
    }

    // Format code snippets for prompt
    const formattedCodeSnippets = this.formatCodeSnippets(codeSnippets);
    const codeSnippetArray = formattedCodeSnippets ? [formattedCodeSnippets] : [];
    
    // Extract top 3 stack frames (app frames only)
    const stackFrames = debugContext.evidence.frames
      .filter(frame => !frame.file.includes('node_modules'))
      .slice(0, 3)
      .map(frame => ({
        file: this.normalizePath(frame.file),
        line: frame.line,
        function: frame.fn || 'unknown'
      }));

    // Extract top 3 normalized log signatures from trimmed logs
    const logSignatures = this.extractLogSignatures(trimmedLogs).slice(0, 3);

    // Get top 5 git changes by relevance
    const gitChanges = debugContext.gitChanges
      .slice(0, 5)
      .map(change => ({
        hash: change.hash.substring(0, 8),
        message: change.message.substring(0, 100),
        files: this.normalizeGitFiles(change.files),
        relevance: change.relevanceScore || 0
      }));

    // Calculate shortest paths from error nodes to candidate nodes
    const graphPaths = this.calculateShortestPaths(debugContext);

    // Get top 10 heuristic findings
    const heuristicFindings = debugContext.heuristicFindings
      .slice(0, 10)
      .map(finding => ({
        file: this.normalizePath(finding.file),
        line: finding.line,
        pattern: finding.pattern,
        severity: finding.severity
      }));

    // Get allowed files and nodes
    const allowedFiles = debugContext.candidates
      .slice(0, 20)
      .map(c => this.normalizePath(c.file))
      .filter(Boolean);

    const allowedNodeIds = debugContext.graph.nodes
      .slice(0, 50)
      .map(n => n.id);

    // Get chat summary if available
    const chatSummary = debugContext.evidence.chatSummary;

    return {
      errorLine,
      stackFrames,
      logSignatures,
      gitChanges,
      graphPaths,
      heuristicFindings,
      allowedFiles,
      allowedNodeIds,
      codeSnippets: codeSnippetArray,
      chatSummary
    };
  }

  /**
   * Generate diverse hypotheses using multiple LLM samples
   */
  private async generateDiverseHypotheses(
    context: CompactContext,
    model: string,
    debugContext: DebugContext,
    feedbackExamples?: FeedbackRecord[],
    chatHistory?: LLMMessage[],
    chatSummary?: string
  ): Promise<Hypothesis[]> {
    const samples = [];
    
    // Generate 2 samples with different temperatures and seeds
    for (let i = 0; i < 2; i++) {
      try {
        const prompt = this.buildCompactPrompt(context, feedbackExamples, chatHistory, chatSummary);
        const cacheKey = llmCache.hashPrompt(prompt + `_sample_${i}`, { sample: i });
        
        let response = llmCache.getCachedResponse(cacheKey);
        let wasRecovered = false;
        if (!response) {
          response = await this.callLLMWithTimeout(prompt, model, 0.2 + i * 0.1, i, debugContext);
          // Check if response was recovered from partial JSON (marked in response)
          wasRecovered = response.startsWith('__RECOVERED__');
          if (wasRecovered) {
            response = response.substring('__RECOVERED__'.length);
          }
          llmCache.setCachedResponse(cacheKey, response, 30 * 60 * 1000); // 30 min cache
        }

        const hypotheses = this.parseHypothesisResponse(response);
        
        // Apply confidence floor for recovered hypotheses
        if (wasRecovered) {
          for (const h of hypotheses) {
            if (h.confidence > 0.4) {
              h.confidence = 0.4;
            }
          }
        }
        
        samples.push(...hypotheses);
      } catch (error) {
        console.warn(`[HypothesisGenerator] Sample ${i} failed:`, error instanceof Error ? error.message : String(error));
      }
    }

    return samples;
  }

  /**
   * Call LLM with timeout and retry
   */
  private async callLLMWithTimeout(
    prompt: string,
    model: string,
    temperature: number,
    seed: number,
    debugContext: DebugContext
  ): Promise<string> {
    const timeout = 120000; // 120 seconds
    const startTime = Date.now();

    // Calculate adaptive maxTokens
    const maxTokens = this.calculateMaxTokens(debugContext);

    // Calculate context metrics for telemetry
    const contextMetrics = {
      promptLength: prompt.length,
      promptTokenEstimate: Math.ceil(prompt.length / 4), // Rough estimate: 4 chars per token
      model,
      requestedMaxTokens: maxTokens,
      candidateCount: debugContext.candidates?.length ?? 0,
      logLength: debugContext.logs?.length ?? 0,
      chatSummaryPresent: Boolean(debugContext.evidence?.chatSummary),
      heavyContext: (debugContext.candidates?.length ?? 0) > 5 ||
                    (debugContext.logs?.length ?? 0) > 2000 ||
                    Boolean(debugContext.evidence?.chatSummary)
    };

    console.log('[HypothesisGenerator] LLM request context:', contextMetrics);
    console.log('[HypothesisGenerator] LLM prompt:', prompt);

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
      id: `hypothesis-gen-${Date.now()}-${seed}`,
      provider: '',
      model,
      messages,
      temperature,
      maxTokens,
      metadata: { seed },
      createdAt: new Date(),
      updatedAt: new Date()
    };

    try {
      const llmResponse = await Promise.race([
        this.llmProvider.chat(request),
        new Promise<never>((_, reject) => 
          setTimeout(() => reject(new Error('LLM call timeout')), timeout)
        )
      ]);

      // Log response details for debugging
      const finishReason = (llmResponse.payload as any)?.metadata?.rawResponse?.response?.candidates?.[0]?.finishReason;
      const actualCompletionTokens = (llmResponse.payload as any)?.usage?.completionTokens ?? 0;
      const totalTokens = (llmResponse.payload as any)?.usage?.totalTokens ?? 0;
      const promptTokens = (llmResponse.payload as any)?.usage?.promptTokens ?? 0;
      const tokenUsageRatio = maxTokens > 0 ? (actualCompletionTokens / maxTokens) * 100 : 0;
      
      console.log('[HypothesisGenerator] LLM response received:', {
        type: llmResponse.type,
        hasPayload: !!llmResponse.payload,
        error: llmResponse.error,
        requestId: llmResponse.requestId,
        finishReason,
        tokenUsage: {
          requestedMaxTokens: maxTokens,
          actualCompletionTokens,
          promptTokens,
          totalTokens,
          usageRatio: `${tokenUsageRatio.toFixed(1)}%`
        }
      });

      // Warn if we're using a high percentage of tokens (indicates we might need more)
      if (tokenUsageRatio > 90) {
        console.warn('[HypothesisGenerator] Token usage warning: Using', tokenUsageRatio.toFixed(1), '% of maxTokens. Consider increasing limit if MAX_TOKENS errors occur.');
      }
      
      if (llmResponse.type !== ResponseType.SUCCESS) {
        const errorMessage = llmResponse.error || 'Unknown error from LLM provider';
        console.error('[HypothesisGenerator] LLM response error:', {
          type: llmResponse.type,
          error: errorMessage,
          requestId: llmResponse.requestId,
          payload: llmResponse.payload,
          contextMetrics
        });
        throw new Error(`Failed to get LLM response: ${errorMessage}`);
      }
      
      if (!llmResponse.payload) {
        console.error('[HypothesisGenerator] LLM response missing payload:', llmResponse);
        throw new Error('Failed to get LLM response: No payload in response');
      }

      // Extract content and handle MAX_TOKENS case
      let content = (llmResponse.payload as any).content?.trim() || '';
      
      // If finishReason is MAX_TOKENS and content is empty, try to extract partial content
      if (finishReason === 'MAX_TOKENS' && !content) {
        console.warn('[HypothesisGenerator] MAX_TOKENS hit with empty content, attempting partial extraction');
        
        // Try to extract from raw response candidates
        const rawResponse = (llmResponse.payload as any)?.metadata?.rawResponse;
        const candidates = rawResponse?.response?.candidates;
        
        if (candidates && candidates.length > 0) {
          const candidate = candidates[0];
          const parts = candidate?.content?.parts;
          
          if (parts && Array.isArray(parts)) {
            // Collect all text from all parts
            const allTextParts: string[] = [];
            for (const part of parts) {
              if (part?.text && String(part.text).trim().length > 0) {
                allTextParts.push(String(part.text).trim());
              }
            }
            
            if (allTextParts.length > 0) {
              const rawText = allTextParts.join('\n').trim();
              console.log('[HypothesisGenerator] Extracted partial content from candidates:', {
                length: rawText.length,
                preview: rawText.substring(0, 200),
                partsCount: allTextParts.length
              });
              
              // Try to recover partial JSON
              const recovered = this.tryRecoverJsonPrefix(rawText, 'hypotheses');
              if (recovered) {
                // Mark as recovered so we can apply confidence floor later
                content = '__RECOVERED__' + recovered;
                console.log('[HypothesisGenerator] Successfully recovered partial JSON');
              } else {
                // Use raw text even if JSON recovery failed
                // Still mark as recovered since it came from partial extraction
                content = '__RECOVERED__' + rawText;
                console.log('[HypothesisGenerator] Using raw text (JSON recovery failed)');
              }
            }
          }
        }
        
        if (!content) {
          console.error('[HypothesisGenerator] MAX_TOKENS hit with no recoverable content:', {
            finishReason,
            hasCandidates: !!candidates,
            contextMetrics
          });
          throw new Error('Failed to get LLM response: MAX_TOKENS hit with no recoverable content');
        }
      }

      if (!content) {
        console.error('[HypothesisGenerator] Empty content in LLM response:', {
          payload: llmResponse.payload,
          contentLength: content.length,
          finishReason,
          contextMetrics
        });
        throw new Error('Failed to get LLM response: Empty content in response');
      }

      // Capture debug info for successful calls
      const duration = Date.now() - startTime;
      const systemPrompt = this.loadSystemPrompt();
      const tokensUsed = (llmResponse.payload as any)?.usage?.totalTokens;
      
      const debugInfo: LLMCallDebugInfo = {
        id: `hyp-gen-${Date.now()}-${seed}`,
        stage: 'hypothesis-generation',
        timestamp: startTime,
        request: {
          prompt: truncateDebugText(prompt),
          systemPrompt: truncateDebugText(systemPrompt),
          model,
          temperature,
          maxTokens
        },
        response: {
          content: truncateDebugText(content),
          tokensUsed,
          duration
        }
      };
      this.llmDebugCalls.push(debugInfo);

      return content;
    } catch (error) {
      // Capture debug info for errors
      const duration = Date.now() - startTime;
      const debugInfo: LLMCallDebugInfo = {
        id: `hyp-gen-${Date.now()}-${seed}`,
        stage: 'hypothesis-generation',
        timestamp: startTime,
        request: {
          prompt: truncateDebugText(prompt.substring(0, 200)), // Only first 200 chars for errors
          model,
          temperature,
          maxTokens
        },
        error: error instanceof Error ? error.message : String(error)
      };
      this.llmDebugCalls.push(debugInfo);

      if (Date.now() - startTime < timeout && error instanceof Error && error.message.includes('rate limit')) {
        // Retry once on rate limit
        await new Promise(resolve => setTimeout(resolve, 1000));
        return this.callLLMWithTimeout(prompt, model, temperature, seed, debugContext);
      }
      throw error;
    }
  }

  /**
   * Attempt to recover partial JSON when MAX_TOKENS is hit
   * Returns recovered JSON string or null if recovery fails
   */
  private tryRecoverJsonPrefix(rawText: string, expectedRootKey: string): string | null {
    try {
      // First try to parse as-is
      const parsed = JSON.parse(rawText);
      return JSON.stringify(parsed);
    } catch (error) {
      // Try to find the last complete object/array
      let lastBrace = rawText.lastIndexOf('}');
      let lastBracket = rawText.lastIndexOf(']');
      const lastComplete = Math.max(lastBrace, lastBracket);
      
      if (lastComplete > 0) {
        // Try to parse up to the last complete structure
        const prefix = rawText.substring(0, lastComplete + 1);
        try {
          const parsed = JSON.parse(prefix);
          
          // If we have the expected structure, return it
          if (parsed[expectedRootKey] && Array.isArray(parsed[expectedRootKey])) {
            return JSON.stringify(parsed);
          }
          
          // If parsed is an array, assume it's hypotheses
          if (Array.isArray(parsed)) {
            const wrapped: any = {};
            wrapped[expectedRootKey] = parsed;
            return JSON.stringify(wrapped);
          }
          
          // If parsed has hypotheses property, use it
          if (parsed.hypotheses && Array.isArray(parsed.hypotheses)) {
            return JSON.stringify(parsed);
          }
          
          // Try wrapping single object as hypothesis array
          const wrapped: any = {};
          wrapped[expectedRootKey] = [parsed];
          return JSON.stringify(wrapped);
        } catch (e) {
          // Try adding missing closing brackets
          const withBrackets = this.addMissingClosingBrackets(prefix);
          try {
            const parsed = JSON.parse(withBrackets);
            return JSON.stringify(parsed);
          } catch (e2) {
            // Recovery failed
          }
        }
      }
    }
    
    return null;
  }

  /**
   * Add missing closing brackets to incomplete JSON
   */
  private addMissingClosingBrackets(json: string): string {
    let depth = 0;
    let brackets = 0;
    
    for (let i = 0; i < json.length; i++) {
      if (json[i] === '{') brackets++;
      if (json[i] === '}') brackets--;
      if (json[i] === '[') depth++;
      if (json[i] === ']') depth--;
    }
    
    let result = json;
    while (depth > 0) {
      result += ']';
      depth--;
    }
    while (brackets > 0) {
      result += '}';
      brackets--;
    }
    
    return result;
  }

  /**
   * Build compact prompt with JSON-only output using markdown template
   */
  private buildCompactPrompt(context: CompactContext, feedbackExamples?: FeedbackRecord[], chatHistory?: LLMMessage[], chatSummary?: string): string {
    const { errorLine, stackFrames, logSignatures, gitChanges, heuristicFindings, codeSnippets } = context;

    // Load markdown template
    let template: string;
    try {
      template = loadDebuggingPrompt('hypothesis_generation.md');
    } catch (error) {
      console.warn('[HypothesisGenerator] Failed to load markdown prompt, using fallback:', error);
      template = this.createFallbackPromptTemplate();
    }

    // Format code snippets (join array if it contains formatted string)
    const formattedCodeSnippets = codeSnippets.length > 0 ? codeSnippets.join('\n\n') : 'No code snippets available.';

    // Format stack frames
    const formattedStackFrames = stackFrames.length > 0
      ? stackFrames.map(f => `- ${f.file}:${f.line} in ${f.function}`).join('\n')
      : 'No stack frames available.';

    // Format log signatures
    const formattedLogSignatures = logSignatures.length > 0
      ? logSignatures.join('\n')
      : 'No log signatures available.';

    // Format git changes
    const formattedGitChanges = gitChanges.length > 0
      ? gitChanges.map(c => `- ${c.hash}: ${c.message} (files: ${c.files.join(', ')})`).join('\n')
      : 'No recent git changes available.';

    // Format heuristic findings
    const formattedHeuristicFindings = heuristicFindings.length > 0
      ? heuristicFindings.map(h => `- ${h.pattern} in ${h.file}:${h.line} (${h.severity})`).join('\n')
      : 'No heuristic findings available.';

    // Format chat context - use provided chatSummary or generate from chatHistory
    let formattedChatContext = '';
    if (chatSummary) {
      const truncatedChatSummary = this.truncateText(chatSummary, 800);
      formattedChatContext = `CHAT CONTEXT:\n${truncatedChatSummary}`;
    } else if (chatHistory && chatHistory.length > 0) {
      // Use last 10 messages from chat history
      const recentMessages = chatHistory.slice(-10);
      const chatText = recentMessages.map(msg => `${msg.role}: ${msg.content}`).join('\n\n');
      const truncatedChat = this.truncateText(chatText, 800);
      formattedChatContext = `CHAT CONTEXT:\n${truncatedChat}`;
    }

    // Format feedback examples
    const formattedFeedbackExamples = this.buildFeedbackExamplesSection(feedbackExamples);

    // Format previous iteration (removed - no longer used)
    const formattedPreviousIteration = '';

    // Perform variable substitution
    let prompt = template
      .replace('{codeSnippets}', formattedCodeSnippets)
      .replace('{errorLine}', errorLine || 'Unknown error')
      .replace('{stackFrames}', formattedStackFrames)
      .replace('{logSignatures}', formattedLogSignatures)
      .replace('{gitChanges}', formattedGitChanges)
      .replace('{heuristicFindings}', formattedHeuristicFindings);

    // Handle optional sections - replace with empty string if not present
    if (formattedChatContext) {
      prompt = prompt.replace('{chatContext}', formattedChatContext + '\n\n');
    } else {
      prompt = prompt.replace('{chatContext}', '');
    }

    if (formattedFeedbackExamples) {
      prompt = prompt.replace('{feedbackExamples}', formattedFeedbackExamples + '\n\n');
    } else {
      prompt = prompt.replace('{feedbackExamples}', '');
    }

    if (formattedPreviousIteration) {
      prompt = prompt.replace('{previousIteration}', formattedPreviousIteration + '\n\n');
    } else {
      prompt = prompt.replace('{previousIteration}', '');
    }

    return prompt;
  }

  /**
   * Create fallback prompt template if markdown file cannot be loaded
   */
  private createFallbackPromptTemplate(): string {
    return `# Root Cause Hypothesis Generation

You are a senior software engineer specializing in debugging. Your task is to generate multiple possible root-cause hypotheses for a reported bug, ranked by likelihood.

## CRITICAL RULES:
- You MUST output markdown format (NOT JSON)
- Propose at most 3 hypotheses
- Each hypothesis must include concrete checks and assumptions
- Avoid generalities; cite specific files, functions, and lines when provided

## Output Format:
Use markdown format with the following structure for each hypothesis:

\`\`\`markdown
## Hypothesis 1

**Summary:** [descriptive summary]
**Evidence:**
- [evidence item 1]
- [evidence item 2]
**Related Nodes:** [node1, node2]
**Related Files:** [file1, file2]
**Confidence:** 0.8
**Checks:**
- [check 1]
- [check 2]
**Assumptions:**
- [assumption 1]
- [assumption 2]
\`\`\`

## Field Requirements:

### Summary (REQUIRED - Must be highly descriptive):
The summary must be a comprehensive description that includes:
- Specific file path(s) where the problem occurs
- Function/method name(s) involved
- Line number(s) if available from code snippets
- Problem description: What is wrong
- Root cause: Why it's happening
- Failure mechanism: How the bug manifests
- Causal chain: Brief explanation of how the root cause leads to the observed error

The summary should read like a detailed bug report, not a one-liner. Aim for 2-4 sentences that tell the complete story.

### Evidence (REQUIRED - Must cite specific sources):
Each evidence item must reference:
- Specific code locations (file:line or function names from code snippets)
- Stack trace frames that support the hypothesis
- Heuristic findings with file:line references
- Git changes with commit hashes and affected files
- Log signatures or error messages

Generic statements are NOT acceptable. Use format like "Stack trace shows error at src/file.ts:45 in function processData()".

### Rationale (REQUIRED - Must explain causal chain):
The rationale must explain:
- The complete causal chain from root cause to observed error
- Why this hypothesis is plausible given the evidence
- How the identified code/pattern causes the failure
- Any intermediate steps or conditions that lead to the bug

This should be 3-5 sentences that walk through the logical flow of how the bug happens.

### Checks (REQUIRED - Must be concrete and actionable):
Each check must be:
- Specific to file/function/line mentioned in summary
- Verifiable through inspection or simple test
- Include the exact location to check

### Assumptions (REQUIRED - Must list unknowns):
List what must be true for this hypothesis to be correct, or what information is still unknown.

## DEBUGGING CONTEXT

{codeSnippets}

ERROR: {errorLine}

{chatContext}

STACK FRAMES:
{stackFrames}

LOG SIGNATURES:
{logSignatures}

RECENT GIT CHANGES:
{gitChanges}

HEURISTIC FINDINGS:
{heuristicFindings}

{feedbackExamples}

{previousIteration}

Generate hypotheses that are specific, evidence-based, and actionable for debugging. Focus on analyzing the code snippets to identify the root cause with complete file paths, function names, line numbers, and detailed mechanism explanations.`;
  }

  /**
   * Parse LLM response with robust markdown extraction and validation
   */
  private parseHypothesisResponse(content: string): Hypothesis[] {
    try {
      // Try parsing as markdown first
      const hypotheses = this.parseMarkdownHypotheses(content);
      if (hypotheses.length > 0) {
        return hypotheses;
      }

      // Fallback: Try parsing as JSON (for backward compatibility)
      const fencedJson = this.extractFencedJson(content);
      const jsonContent = fencedJson || content;
      const parsed = JSON.parse(jsonContent);
      
      if (parsed.hypotheses && Array.isArray(parsed.hypotheses)) {
        return parsed.hypotheses.map((h: any, index: number) => ({
          id: h.id || `hypothesis_${index + 1}`,
          summary: h.summary || 'Unknown cause',
          evidence: Array.isArray(h.evidence) ? h.evidence : [],
          relatedNodes: Array.isArray(h.relatedNodes) ? h.relatedNodes : [],
          relatedFiles: Array.isArray(h.relatedFiles) ? h.relatedFiles.map((f: string) => this.normalizePath(f)) : [],
          confidence: Math.max(0, Math.min(1, h.confidence || 0.5)),
          rationale: h.rationale || 'No rationale provided',
          checks: Array.isArray(h.checks) ? h.checks : [],
          assumptions: Array.isArray(h.assumptions) ? h.assumptions : []
        }));
      }

      throw new Error('No valid hypotheses found');
    } catch (error) {
      console.warn('[HypothesisGenerator] Failed to parse response, attempting repair');
      return this.attemptJsonRepair(content);
    }
  }

  /**
   * Parse markdown format hypotheses
   */
  private parseMarkdownHypotheses(content: string): Hypothesis[] {
    const hypotheses: Hypothesis[] = [];
    
    // Remove markdown code fences if present
    let cleanContent = content.replace(/```markdown\s*([\s\S]*?)\s*```/g, '$1').trim();
    
    // Split by hypothesis headers (## Hypothesis N or ## Hypothesis N:)
    const hypothesisSections = cleanContent.split(/(?=##\s+Hypothesis\s+\d+)/i);
    
    for (let i = 0; i < hypothesisSections.length; i++) {
      const section = hypothesisSections[i].trim();
      if (!section) continue;

      // Extract hypothesis number or use index
      const headerMatch = section.match(/##\s+Hypothesis\s+(\d+)/i);
      const hypothesisNum = headerMatch ? parseInt(headerMatch[1], 10) : i + 1;
      const id = `hypothesis_${hypothesisNum}`;

      // Extract Summary
      const summaryMatch = section.match(/\*\*Summary:\*\*\s*(.+?)(?=\*\*(?:Evidence|Related|Confidence|Checks|Assumptions):|$)/is);
      const summary = summaryMatch ? summaryMatch[1].trim() : 'Unknown cause';

      // Extract Evidence (list items after **Evidence:**)
      const evidenceMatch = section.match(/\*\*Evidence:\*\*\s*([\s\S]*?)(?=\*\*(?:Related|Confidence|Checks|Assumptions):|$)/i);
      const evidence: string[] = [];
      if (evidenceMatch) {
        const evidenceText = evidenceMatch[1];
        const evidenceItems = evidenceText.match(/^[-*]\s+(.+)$/gm);
        if (evidenceItems) {
          evidenceItems.forEach(item => {
            const cleanItem = item.replace(/^[-*]\s+/, '').trim();
            if (cleanItem) evidence.push(cleanItem);
          });
        }
      }

      // Extract Related Nodes
      const nodesMatch = section.match(/\*\*Related\s+Nodes:\*\*\s*(.+?)(?=\*\*(?:Related|Confidence|Checks|Assumptions|Summary):|$)/is);
      const relatedNodes: string[] = [];
      if (nodesMatch) {
        const nodesText = nodesMatch[1].trim();
        relatedNodes.push(...nodesText.split(/[,;]/).map(n => n.trim()).filter(n => n));
      }

      // Extract Related Files
      const filesMatch = section.match(/\*\*Related\s+Files:\*\*\s*(.+?)(?=\*\*(?:Related|Confidence|Checks|Assumptions|Summary):|$)/is);
      const relatedFiles: string[] = [];
      if (filesMatch) {
        const filesText = filesMatch[1].trim();
        relatedFiles.push(...filesText.split(/[,;]/).map(f => this.normalizePath(f.trim())).filter(f => f));
      }

      // Extract Confidence
      const confidenceMatch = section.match(/\*\*Confidence:\*\*\s*([\d.]+)%?/i);
      let confidence = 0.5;
      if (confidenceMatch) {
        const numericValue = parseFloat(confidenceMatch[1]);
        // If value > 1, assume it's a percentage and normalize to 0-1 range
        const normalizedValue = numericValue > 1 ? numericValue / 100 : numericValue;
        confidence = Math.max(0, Math.min(1, normalizedValue));
      }

      // Extract Checks (list items after **Checks:**)
      const checksMatch = section.match(/\*\*Checks:\*\*\s*([\s\S]*?)(?=\*\*(?:Assumptions|Related|Confidence|Summary):|$)/i);
      const checks: string[] = [];
      if (checksMatch) {
        const checksText = checksMatch[1];
        const checkItems = checksText.match(/^[-*]\s+(.+)$/gm);
        if (checkItems) {
          checkItems.forEach(item => {
            const cleanItem = item.replace(/^[-*]\s+/, '').trim();
            if (cleanItem) checks.push(cleanItem);
          });
        }
      }

      // Extract Assumptions (list items after **Assumptions:**)
      const assumptionsMatch = section.match(/\*\*Assumptions:\*\*\s*([\s\S]*?)(?=\*\*(?:Related|Confidence|Checks|Summary|Evidence):|$)/i);
      const assumptions: string[] = [];
      if (assumptionsMatch) {
        const assumptionsText = assumptionsMatch[1];
        const assumptionItems = assumptionsText.match(/^[-*]\s+(.+)$/gm);
        if (assumptionItems) {
          assumptionItems.forEach(item => {
            const cleanItem = item.replace(/^[-*]\s+/, '').trim();
            if (cleanItem) assumptions.push(cleanItem);
          });
        }
      }

      // Extract Rationale if present (might be in Summary or separate)
      const rationale = summary; // Use summary as rationale for now

      hypotheses.push({
        id,
        summary,
        evidence,
        relatedNodes,
        relatedFiles,
        confidence,
        rationale,
        checks,
        assumptions
      });
    }

    return hypotheses;
  }

  /**
   * Extract JSON from fenced code blocks
   */
  private extractFencedJson(content: string): string | null {
    const jsonMatch = content.match(/```json\s*([\s\S]*?)\s*```/);
    return jsonMatch ? jsonMatch[1].trim() : null;
  }

  /**
   * Attempt to repair malformed JSON
   */
  private attemptJsonRepair(content: string): Hypothesis[] {
    try {
      // Try to find and fix common JSON issues
      let repaired = content
        .replace(/,(\s*[}\]])/g, '$1') // Remove trailing commas
        .replace(/([{,]\s*)(\w+):/g, '$1"$2":') // Quote unquoted keys
        .replace(/:(\s*)([^",{\[\s][^,}\]]*?)(\s*[,}])/g, ': "$2"$3'); // Quote unquoted string values

      const parsed = JSON.parse(repaired);
      return this.parseHypothesisResponse(JSON.stringify(parsed));
    } catch (error) {
      console.warn('[HypothesisGenerator] JSON repair failed, creating fallback');
      return this.createFallbackHypotheses({} as DebugContext);
    }
  }

  /**
   * Validate and reconcile references to ensure they exist
   */
  private reconcileReferences(hypotheses: Hypothesis[], debugContext: DebugContext): Hypothesis[] {
    const allowedFiles = new Set(debugContext.candidates.map(c => this.normalizePath(c.file)));
    const allowedNodes = new Set(debugContext.graph.nodes.map(n => n.id));

    const reconciled = hypotheses.map(h => ({
      ...h,
      relatedFiles: (h.relatedFiles || [])
        .map(f => this.normalizePath(f))
        .filter(f => allowedFiles.has(f)),
      relatedNodes: (h.relatedNodes || [])
        .filter(id => allowedNodes.has(id))
    }));

    // Don't filter out hypotheses completely - keep them even if references are invalid
    return reconciled;
  }

  /**
   * Apply enhanced heuristic scoring with bounded features
   */
  private applyEnhancedHeuristicScoring(hypotheses: Hypothesis[], debugContext: DebugContext): Hypothesis[] {
    return hypotheses.map(hypothesis => {
      const features = this.calculateBoundedFeatures(hypothesis, debugContext);
      const llmConfidence = hypothesis.confidence;
      
      // Combine with learned weights
      const combinedConfidence = 0.6 * llmConfidence + 0.4 * features;
      
      // Apply sigmoid transformation
      const normalizedConfidence = this.sigmoid(2.2 * (combinedConfidence - 0.5));
      
      return {
        ...hypothesis,
        normalizedConfidence: Math.max(0, Math.min(1, normalizedConfidence))
      };
    }).sort((a, b) => (b.normalizedConfidence || 0) - (a.normalizedConfidence || 0));
  }

  /**
   * Calculate bounded features for confidence scoring
   */
  private calculateBoundedFeatures(hypothesis: Hypothesis, debugContext: DebugContext): number {
    let features = 0;

    // Error path proximity (0-1)
    const inErrorPath = this.calculateErrorPathProximity(hypothesis, debugContext);
    features += 0.35 * inErrorPath;

    // Recent commit overlap (0-1)
    const touchedRecently = this.calculateRecentCommitOverlap(hypothesis, debugContext);
    features += 0.25 * touchedRecently;

    // Stack frame overlap (0-1)
    const stackOverlap = this.calculateStackOverlap(hypothesis, debugContext);
    features += 0.20 * stackOverlap;

    // Heuristic findings overlap (0-1)
    const hasHeuristicFlag = this.calculateHeuristicOverlap(hypothesis, debugContext);
    features += 0.20 * hasHeuristicFlag;

    return Math.min(1, features);
  }

  /**
   * Calculate error path proximity using shortest path distance
   */
  private calculateErrorPathProximity(hypothesis: Hypothesis, debugContext: DebugContext): number {
    const errorNodes = debugContext.graph.nodes.filter(node => node.badges?.includes('error'));
    if (errorNodes.length === 0) return 0;

    const minDistance = Math.min(...errorNodes.map(errorNode => {
      const distance = this.calculateShortestPathDistance(errorNode.id, hypothesis.relatedNodes, debugContext.graph);
      return distance === -1 ? Infinity : distance;
    }));

    return minDistance === Infinity ? 0 : 1 / (1 + minDistance);
  }

  /**
   * Calculate recent commit overlap
   */
  private calculateRecentCommitOverlap(hypothesis: Hypothesis, debugContext: DebugContext): number {
    const now = Date.now();
    const halfLife = 14 * 24 * 60 * 60 * 1000; // 14 days in ms

    let overlap = 0;
    for (const change of debugContext.gitChanges) {
      const daysSince = (now - change.date.getTime()) / (24 * 60 * 60 * 1000);
      const recencyWeight = Math.exp(-daysSince / 14);
      
      const fileOverlap = this.calculateFileOverlap(hypothesis.relatedFiles, this.normalizeGitFiles(change.files));
      overlap += recencyWeight * fileOverlap;
    }

    return Math.min(1, overlap);
  }

  /**
   * Calculate stack frame overlap
   */
  private calculateStackOverlap(hypothesis: Hypothesis, debugContext: DebugContext): number {
    const stackFiles = new Set(debugContext.evidence.frames.map(f => this.normalizePath(f.file)));
    const hypothesisFiles = new Set(hypothesis.relatedFiles);
    
    const intersection = new Set([...stackFiles].filter(f => hypothesisFiles.has(f)));
    const union = new Set([...stackFiles, ...hypothesisFiles]);
    
    return union.size > 0 ? intersection.size / union.size : 0;
  }

  /**
   * Calculate heuristic findings overlap
   */
  private calculateHeuristicOverlap(hypothesis: Hypothesis, debugContext: DebugContext): number {
    const relevantFindings = debugContext.heuristicFindings.filter(finding =>
      hypothesis.relatedFiles.some(file => this.normalizePath(finding.file) === file)
    );

    let weightedScore = 0;
    for (const finding of relevantFindings) {
      const severityWeight = finding.severity === 'high' ? 0.2 : 
                           finding.severity === 'medium' ? 0.15 : 0.1;
      weightedScore += severityWeight;
    }

    return Math.min(1, weightedScore);
  }

  /**
   * Filter hypotheses for diversity using Jaccard similarity
   */
  private filterForDiversity(hypotheses: Hypothesis[]): Hypothesis[] {
    if (hypotheses.length === 0) return [];
    
    const result: Hypothesis[] = [];
    
    for (const hypothesis of hypotheses) {
      if (result.length >= this.MAX_HYPOTHESES) break;
      
      const isDiverse = result.every(existing => {
        const similarity = this.calculateJaccardSimilarity(
          new Set([...hypothesis.relatedFiles, ...hypothesis.relatedNodes]),
          new Set([...existing.relatedFiles, ...existing.relatedNodes])
        );
        return similarity <= this.MAX_SIMILARITY;
      });
      
      if (isDiverse) {
        result.push(hypothesis);
      }
    }

    // Ensure we have at least one hypothesis
    if (result.length === 0 && hypotheses.length > 0) {
      result.push(hypotheses[0]);
    }

    return result;
  }

  /**
   * Calculate Jaccard similarity between two sets
   */
  private calculateJaccardSimilarity(setA: Set<string>, setB: Set<string>): number {
    const intersection = new Set([...setA].filter(x => setB.has(x)));
    const union = new Set([...setA, ...setB]);
    return union.size > 0 ? intersection.size / union.size : 0;
  }

  /**
   * Create enhanced cache key with more context
   */
  private createCacheKey(debugContext: DebugContext, chatHistory?: LLMMessage[], chatSummary?: string): string {
    const graphHash = this.hashIds(debugContext.graph.nodes.map(n => n.id)).slice(0, 8);
    const commit = debugContext.commitHash || 'working';
    const files = debugContext.candidates?.slice(0, 20).map(c => c.file).sort();
    const logSig = this.hashString(this.extractTopErrorLine(debugContext.logs) + 
      this.extractLogSignatures(debugContext.logs).join('|')).slice(0, 8);
    
    // Include chat history hash in cache key to ensure different hypotheses for different chat contexts
    const chatHash = chatHistory && chatHistory.length > 0
      ? this.hashString(chatHistory.map(m => `${m.role}:${m.content}`).join('|')).slice(0, 8)
      : 'nochat';
    
    // Include chat summary hash to avoid cache collisions when only summary is provided
    const chatSummaryHash = chatSummary
      ? this.hashString(chatSummary).slice(0, 8)
      : 'nosummary';
    
    return JSON.stringify({ 
      commit, 
      graphHash, 
      files, 
      chatHash, 
      chatSummaryHash,
      logSig 
    });
  }

  /**
   * Create fallback hypotheses when LLM fails
   * Deterministic priority: frames → candidates → logging request
   * NEVER returns empty - always returns 1-3 structured hypotheses
   */
  private createFallbackHypotheses(debugContext: DebugContext): Hypothesis[] {
    console.log('[HypothesisGenerator] Creating fallback hypotheses', {
      hasFrames: (debugContext.evidence?.frames?.length ?? 0) > 0,
      hasCandidates: (debugContext.candidates?.length ?? 0) > 0,
      hasGitChanges: (debugContext.gitChanges?.length ?? 0) > 0,
      hasLogs: Boolean(debugContext.logs),
      hasUserMessage: Boolean(debugContext.userMessage || debugContext.bugDescription)
    });

    const hypotheses: Hypothesis[] = [];

    // Priority 1: Stack frame-based hypothesis
    if (debugContext.evidence?.frames?.length > 0) {
      const frame = debugContext.evidence.frames[0];
      const evidence: string[] = [`Stack trace points to ${frame.file}:${frame.line}`];
      
      // Add user message if available
      if (debugContext.userMessage || debugContext.bugDescription) {
        const userMsg = debugContext.userMessage || debugContext.bugDescription;
        evidence.push(`User reported: ${userMsg.substring(0, 200)}`);
      }
      
      // Add log excerpt if available
      if (debugContext.logs) {
        const logExcerpt = this.extractTopErrorLine(debugContext.logs);
        if (logExcerpt) {
          evidence.push(`Error log: ${logExcerpt.substring(0, 200)}`);
        }
      }

      hypotheses.push({
        id: 'fallback-frame',
        summary: `Error in ${frame.file}:${frame.line} in ${frame.fn || 'unknown function'}`,
        evidence,
        relatedNodes: [],
        confidence: 0.4, // Floor confidence for fallback
        rationale: 'Stack trace points to this location. Check for import/alias issues and runtime shape mismatches.',
        relatedFiles: [this.normalizePath(frame.file)],
        checks: [
          `Verify code at ${frame.file}:${frame.line}`,
          `Check imports and exports in ${frame.file}`,
          `Verify function signature matches usage`
        ],
        assumptions: ['Error originates from this specific location', 'Stack trace is accurate']
      });

      // Add additional hypothesis from git changes if available
      if (debugContext.gitChanges?.length > 0) {
        const recentChange = debugContext.gitChanges[0];
        const files = this.normalizeGitFiles(recentChange.files);
        const hasFrameFile = files.some(f => this.normalizePath(f) === this.normalizePath(frame.file));
        
        // Only add if different from frame file
        if (!hasFrameFile && files.length > 0) {
          hypotheses.push({
            id: 'fallback-recent-change',
            summary: `Recent change in ${files[0]} may have introduced the bug`,
            evidence: [
              `Recent commit: ${recentChange.message}`,
              `Files changed: ${files.join(', ')}`
            ],
            relatedNodes: [],
            confidence: 0.35,
            rationale: 'Recent changes often correlate with new bugs. The stack trace may point to a different location affected by this change.',
            relatedFiles: files.slice(0, 3), // Limit to top 3 files
            checks: [
              `Review changes in commit ${recentChange.hash.substring(0, 8)}`,
              `Check if recent changes affected ${frame.file}`
            ],
            assumptions: ['Bug was introduced by recent changes', 'Stack trace location is downstream from root cause']
          });
        }
      }
    }
    // Priority 2: Candidate file-based hypothesis
    else if (debugContext.candidates?.length > 0) {
      const candidate = debugContext.candidates[0];
      const evidence: string[] = [`Candidate file: ${candidate.file}`];
      
      // Add user message if available
      if (debugContext.userMessage || debugContext.bugDescription) {
        const userMsg = debugContext.userMessage || debugContext.bugDescription;
        evidence.push(`User reported: ${userMsg.substring(0, 200)}`);
      }
      
      // Add log excerpt if available
      if (debugContext.logs) {
        const logExcerpt = this.extractTopErrorLine(debugContext.logs);
        if (logExcerpt) {
          evidence.push(`Error log: ${logExcerpt.substring(0, 200)}`);
        }
      }

      hypotheses.push({
        id: 'fallback-candidate',
        summary: `Issue likely in candidate file ${candidate.file}`,
        evidence,
        relatedNodes: [],
        confidence: 0.35,
        rationale: 'User-reported error likely originates here based on code context. Add debug logs and re-run to confirm.',
        relatedFiles: [this.normalizePath(candidate.file)],
        checks: [
          `Add debug logging in ${candidate.file}`,
          `Review code around reported issue location`,
          `Check for common issues: null access, missing await, incorrect types`
        ],
        assumptions: ['Candidate file is relevant to the bug', 'More context needed to pinpoint exact issue']
      });

      // Add hypothesis from git changes if available
      if (debugContext.gitChanges?.length > 0 && hypotheses.length < 3) {
        const recentChange = debugContext.gitChanges[0];
        const files = this.normalizeGitFiles(recentChange.files);
        const hasCandidateFile = files.some(f => this.normalizePath(f) === this.normalizePath(candidate.file));
        
        if (!hasCandidateFile && files.length > 0) {
          hypotheses.push({
            id: 'fallback-candidate-git',
            summary: `Recent change in ${files[0]} may affect candidate file`,
            evidence: [
              `Recent commit: ${recentChange.message}`,
              `Candidate file: ${candidate.file}`
            ],
            relatedNodes: [],
            confidence: 0.3,
            rationale: 'Recent changes may have indirect effects on the candidate file.',
            relatedFiles: [this.normalizePath(candidate.file), ...files.slice(0, 2)],
            checks: [
              `Review commit ${recentChange.hash.substring(0, 8)}`,
              `Check dependencies between changed files and ${candidate.file}`
            ],
            assumptions: ['Recent changes have indirect effects', 'File dependencies exist']
          });
        }
      }
    }
    // Priority 3: Insufficient logging hypothesis (aligned with "Need More Information")
    else {
      const evidence: string[] = [];
      
      if (debugContext.userMessage || debugContext.bugDescription) {
        const userMsg = debugContext.userMessage || debugContext.bugDescription;
        evidence.push(`User message: ${userMsg.substring(0, 200)}`);
      }
      
      if (debugContext.logs) {
        const logExcerpt = debugContext.logs.substring(0, 200);
        evidence.push(`Available logs: ${logExcerpt}`);
      } else {
        evidence.push('No error logs available');
      }

      hypotheses.push({
        id: 'fallback-logging',
        summary: 'Insufficient logs to localize error precisely',
        evidence,
        relatedNodes: [],
        confidence: 0.25,
        rationale: 'Need more debugging information. Ask user to enable source maps and re-run to collect full stack trace.',
        relatedFiles: [],
        checks: [
          'Enable source maps in build configuration',
          'Re-run the failing operation to capture full stack trace',
          'Add debug logging at suspected entry points',
          'Check browser console for additional error messages'
        ],
        assumptions: [
          'Error is reproducible',
          'Source maps are available or can be enabled',
          'More detailed logs will help identify root cause'
        ]
      });

      // Add hypothesis from git changes if available as additional context
      if (debugContext.gitChanges?.length > 0 && hypotheses.length < 3) {
        const recentChange = debugContext.gitChanges[0];
        const files = this.normalizeGitFiles(recentChange.files);
        hypotheses.push({
          id: 'fallback-logging-git',
          summary: `Recent changes in ${files[0]} may be related`,
          evidence: [
            `Recent commit: ${recentChange.message}`,
            'Insufficient logs to confirm'
          ],
          relatedNodes: [],
          confidence: 0.2,
          rationale: 'Recent changes might be related, but cannot confirm without better logs.',
          relatedFiles: files.slice(0, 3),
          checks: [
            `Review commit ${recentChange.hash.substring(0, 8)}`,
            'Enable detailed logging and re-run',
            'Check if recent changes could cause reported issue'
          ],
          assumptions: [
            'Recent changes are potentially related',
            'Better logs needed to confirm',
            'Timing correlation suggests possible link'
          ]
        });
      }
    }

    // Ensure we always have at least one hypothesis (safety check)
    if (hypotheses.length === 0) {
      console.warn('[HypothesisGenerator] Fallback produced no hypotheses, creating minimal fallback');
      hypotheses.push({
        id: 'fallback-minimal',
        summary: 'Unable to generate specific hypothesis - insufficient debugging context',
        evidence: [
          debugContext.userMessage || debugContext.bugDescription || 'No user message',
          debugContext.logs ? `Logs available (${debugContext.logs.length} chars)` : 'No logs'
        ],
        relatedNodes: [],
        confidence: 0.2,
        rationale: 'No structured context available. Need more information to proceed.',
        relatedFiles: [],
        checks: [
          'Provide error logs or stack trace',
          'Describe expected vs actual behavior',
          'Include steps to reproduce'
        ],
        assumptions: ['More context will be provided', 'Error is reproducible']
      });
    }

    console.log('[HypothesisGenerator] Created fallback hypotheses:', hypotheses.length);
    return hypotheses;
  }

  // Utility methods
  
  /**
   * Extract code snippet from a graph node
   * Reads code from file system and extracts relevant section around the node's location
   */
  private extractCodeFromNode(node: GraphNode, workspace?: string): { file: string; code: string; line?: number; span?: { start: number; end: number } } | null {
    if (!node.file) {
      return null;
    }

    try {
      // Resolve file path - handle both absolute and relative paths
      // Default to instance's workspaceRoot when workspace is undefined
      workspace = workspace ?? this.workspaceRoot;
      let filePath = node.file;
      if (workspace && !path.isAbsolute(filePath)) {
        filePath = path.join(workspace, filePath);
      } else if (!path.isAbsolute(filePath)) {
        // Try to resolve from current working directory or use as-is
        filePath = path.resolve(filePath);
      }

      // Check if file exists (use OS-native path format)
      if (!fs.existsSync(filePath)) {
        console.warn(`[HypothesisGenerator] File not found: ${filePath}`);
        return null;
      }

      // Read file content
      const fileContent = fs.readFileSync(filePath, 'utf-8');
      const lines = fileContent.split('\n');

      // Determine line range to extract
      let startLine = 1;
      let endLine = lines.length;
      const contextLines = 15; // Lines of context before/after

      if (node.span) {
        // Use span if available (character-based)
        // Convert character positions to line numbers
        let charCount = 0;
        for (let i = 0; i < lines.length; i++) {
          const lineLength = lines[i].length + 1; // +1 for newline
          if (charCount <= node.span.start && charCount + lineLength > node.span.start) {
            startLine = Math.max(1, i + 1 - contextLines);
            break;
          }
          charCount += lineLength;
        }
        charCount = 0;
        for (let i = 0; i < lines.length; i++) {
          const lineLength = lines[i].length + 1;
          if (charCount <= node.span.end && charCount + lineLength > node.span.end) {
            endLine = Math.min(lines.length, i + 1 + contextLines);
            break;
          }
          charCount += lineLength;
        }
      } else if (node.line) {
        // Use line number if available
        startLine = Math.max(1, node.line - contextLines);
        endLine = Math.min(lines.length, node.line + contextLines);
      } else {
        // No location info, return entire file if it's small, otherwise first 50 lines
        if (lines.length <= 100) {
          startLine = 1;
          endLine = lines.length;
        } else {
          startLine = 1;
          endLine = 50;
        }
      }

      // Extract code snippet
      const codeLines = lines.slice(startLine - 1, endLine);
      const code = codeLines.join('\n');

      return {
        file: node.file,
        code,
        line: node.line,
        span: node.span
      };
    } catch (error) {
      console.warn(`[HypothesisGenerator] Failed to extract code from node ${node.id}:`, error instanceof Error ? error.message : String(error));
      return null;
    }
  }

  /**
   * Format code snippets for the prompt
   */
  private formatCodeSnippets(snippets: Array<{ file: string; code: string; line?: number; span?: { start: number; end: number } }>): string {
    if (snippets.length === 0) {
      return '';
    }

    return snippets.map(snippet => {
      const filePath = this.normalizePath(snippet.file);
      let locationInfo = '';
      
      if (snippet.line) {
        locationInfo = `:${snippet.line}`;
      } else if (snippet.span) {
        locationInfo = `:${snippet.span.start}-${snippet.span.end}`;
      }

      return `--- ${filePath}${locationInfo} ---\n${snippet.code}`;
    }).join('\n\n');
  }

  private normalizePath(filePath: string): string {
    return filePath.replace(/\\/g, '/');
  }

  private normalizeGitFiles(files: any[]): string[] {
    return files.map(f => typeof f === 'string' ? this.normalizePath(f) : this.normalizePath(f.path));
  }

  private extractTopErrorLine(logs: string): string {
    const lines = logs.split('\n');
    return lines.find(line => 
      line.toLowerCase().includes('error') || 
      line.toLowerCase().includes('exception') ||
      line.toLowerCase().includes('failed')
    ) || lines[0] || 'Unknown error';
  }

  private extractLogSignatures(logs: string): string[] {
    const lines = logs.split('\n').filter(line => line.trim());
    return lines.slice(0, 3).map(line => line.substring(0, 100));
  }

  private calculateShortestPaths(debugContext: DebugContext): Array<{ from: string; to: string; distance: number }> {
    const errorNodes = debugContext.graph.nodes.filter(node => node.badges?.includes('error'));
    const candidateNodes = debugContext.graph.nodes
      .slice(0, 10);

    const paths: Array<{ from: string; to: string; distance: number }> = [];
    
    for (const errorNode of errorNodes) {
      for (const candidateNode of candidateNodes) {
        const distance = this.calculateShortestPathDistance(errorNode.id, [candidateNode.id], debugContext.graph);
        if (distance > 0) {
          paths.push({ from: errorNode.id, to: candidateNode.id, distance });
        }
      }
    }

    return paths.slice(0, 5);
  }

  private calculateShortestPathDistance(from: string, to: string[], graph: any): number {
    // Simplified BFS for shortest path
    const queue = [{ node: from, distance: 0 }];
    const visited = new Set<string>();
    
    while (queue.length > 0) {
      const { node, distance } = queue.shift()!;
      
      if (to.includes(node)) {
        return distance;
      }
      
      if (visited.has(node)) continue;
      visited.add(node);
      
      const edges = graph.edges.filter((e: any) => e.from === node);
      for (const edge of edges) {
        queue.push({ node: edge.to, distance: distance + 1 });
      }
    }
    
    return -1;
  }

  private calculateFileOverlap(files1: string[], files2: string[]): number {
    const set1 = new Set(files1);
    const set2 = new Set(files2);
    const intersection = new Set([...set1].filter(f => set2.has(f)));
    const union = new Set([...set1, ...set2]);
    return union.size > 0 ? intersection.size / union.size : 0;
  }

  private sigmoid(x: number): number {
    return 1 / (1 + Math.exp(-x));
  }

  private hashIds(ids: string[]): string {
    return crypto.createHash('sha256').update(ids.sort().join(',')).digest('hex');
  }

  private hashString(str: string): string {
    return crypto.createHash('sha256').update(str).digest('hex');
  }

  private getCached(key: string): Hypothesis[] | null {
    const cached = this.hypothesisCache.get(key);
    if (cached && (Date.now() - cached.timestamp < this.CACHE_TTL)) {
      return cached.data;
    }
    this.hypothesisCache.delete(key);
    return null;
  }

  private setCached(key: string, data: Hypothesis[]): void {
    this.hypothesisCache.set(key, { data, timestamp: Date.now() });
  }

  /**
   * Load system prompt from file
   */
  private loadSystemPrompt(): string {
    try {
      return loadDebuggingPrompt('hypothesis_generation.md');
    } catch (error) {
      console.warn('[HypothesisGenerator] Failed to load system prompt, using fallback');
      return `You are a senior software engineer generating hypotheses about bug root causes.

You MUST output JSON only, inside \`\`\`json fences\`\`\`.
Only use file paths from allowedFiles; only use node IDs from allowedNodeIds.
Propose at most 3 hypotheses; each must include checks and assumptions.
Avoid generalities; cite concrete files, functions, and lines if provided.`;
    }
  }

  /**
   * Builds the feedback examples section for the prompt
   */
  private buildFeedbackExamplesSection(feedbackExamples?: FeedbackRecord[]): string {
    if (!feedbackExamples || feedbackExamples.length === 0) {
      return '';
    }

    const positiveExamples = feedbackExamples.filter(e => e.result === 'positive');
    const negativeExamples = feedbackExamples.filter(e => e.result === 'negative');
    
    let section = `\nPRIOR SUCCESSFUL FIXES FROM THIS REPOSITORY:\n`;
    
    // Add positive examples (up to 2)
    positiveExamples.slice(0, 2).forEach((example, index) => {
      const context = this.truncateText(example.bugDescription, 100);
      const files = example.relatedFiles.slice(0, 3).join(', ');
      const rootCause = this.truncateText(example.likelyRootCause, 150);
      
      section += `\n[Prior Case #${index + 1} — POSITIVE]\n`;
      section += `Context: "${context}"\n`;
      section += `Files: ${files}\n`;
      section += `Hypothesis → Fix: ${rootCause}\n`;
      section += `Outcome: Fixed\n`;
    });

    // Add one negative example for contrast (if available and positive examples are weak)
    if (negativeExamples.length > 0 && positiveExamples.length < 2) {
      const example = negativeExamples[0];
      const context = this.truncateText(example.bugDescription, 100);
      const files = example.relatedFiles.slice(0, 3).join(', ');
      const rootCause = this.truncateText(example.likelyRootCause, 150);
      
      section += `\n[Prior Case — NEGATIVE (avoid this approach)]\n`;
      section += `Context: "${context}"\n`;
      section += `Files: ${files}\n`;
      section += `Hypothesis → Fix: ${rootCause}\n`;
      section += `Outcome: Did not work\n`;
    }

    section += `\nContext includes ${positiveExamples.length} prior successful fixes from this repo.\n`;
    
    return section;
  }

  /**
   * Truncates text to specified length
   */
  private truncateText(text: string, maxLength: number): string {
    if (!text || text.length <= maxLength) {
      return text;
    }
    return text.substring(0, maxLength - 3) + '...';
  }

  /**
   * Clear hypothesis cache
   */
  clearCache(): void {
    this.hypothesisCache.clear();
  }

  /**
   * Generate graph candidates using deterministic methods
   * Returns 3-5 candidate nodes with small neighborhoods
   * Made public for use in RootCauseAnalyzer to capture candidates for refocus feature
   */
  public generateGraphCandidates(debugContext: DebugContext): GraphCandidate[] {
    const candidates: GraphCandidate[] = [];
    const graph = debugContext.graph;
    const nodeMap = new Map(graph.nodes.map(n => [n.id, n]));

    // Candidate A: Error nodes (if found) or entry/root nodes
    const errorNodes = graph.nodes.filter(node => node.badges?.includes('error'));
    if (errorNodes.length > 0) {
      // Use first error node and expand radius
      const errorNode = errorNodes[0];
      const neighborhood = this.extractSubgraph(graph.nodes, graph.edges, errorNode.id, this.UPSTREAM_HOPS, this.DOWNSTREAM_HOPS);
      candidates.push({
        id: errorNode.id,
        reason: 'from log',
        score: 0.95,
        neighborhood
      });
    } else {
      // No error nodes, use entry/root nodes
      const entryNodes = graph.nodes.filter(node => {
        const badges = node.badges || [];
        return (badges as string[]).includes('entry') || 
               (badges as string[]).includes('seed') ||
               (badges as string[]).includes('spine');
      });
      if (entryNodes.length > 0) {
        const entryNode = entryNodes[0];
        const neighborhood = this.extractSubgraph(graph.nodes, graph.edges, entryNode.id, this.UPSTREAM_HOPS, this.DOWNSTREAM_HOPS);
        candidates.push({
          id: entryNode.id,
          reason: 'entrypoint',
          score: 0.6,
          neighborhood
        });
      } else {
        // Fallback to first node in graph
        if (graph.nodes.length > 0) {
          const firstNode = graph.nodes[0];
          const neighborhood = this.extractSubgraph(graph.nodes, graph.edges, firstNode.id, this.UPSTREAM_HOPS, this.DOWNSTREAM_HOPS);
          candidates.push({
            id: firstNode.id,
            reason: 'root node',
            score: 0.5,
            neighborhood
          });
        }
      }
    }

    // Candidate B/C/D: Top nodes by centrality/role
    const nodeDegrees = this.computeNodeDegrees(graph);
    
    // Candidate B: Top node by in-degree (often controller/service)
    const nodesByInDegree = Array.from(nodeDegrees.entries())
      .map(([id, degrees]) => ({ id, degree: degrees.in }))
      .filter(({ id }) => !candidates.some(c => c.id === id))
      .sort((a, b) => b.degree - a.degree);
    
    if (nodesByInDegree.length > 0 && candidates.length < this.MAX_GRAPH_CANDIDATES) {
      const topInNode = nodesByInDegree[0];
      const node = nodeMap.get(topInNode.id);
      if (node) {
        const neighborhood = this.extractSubgraph(graph.nodes, graph.edges, topInNode.id, this.UPSTREAM_HOPS, this.DOWNSTREAM_HOPS);
        const role = this.identifyNodeRole(node, graph);
        candidates.push({
          id: topInNode.id,
          reason: role === 'api' ? 'api controller' : 'high in-degree',
          score: 0.55,
          neighborhood
        });
      }
    }

    // Candidate C: Top node by "API" role (if identifiable and different)
    if (candidates.length < this.MAX_GRAPH_CANDIDATES) {
      const apiNodes = graph.nodes.filter(node => {
        const role = this.identifyNodeRole(node, graph);
        return role === 'api' && !candidates.some(c => c.id === node.id);
      });
      if (apiNodes.length > 0) {
        const apiNode = apiNodes[0];
        const neighborhood = this.extractSubgraph(graph.nodes, graph.edges, apiNode.id, this.UPSTREAM_HOPS, this.DOWNSTREAM_HOPS);
        candidates.push({
          id: apiNode.id,
          reason: 'api controller',
          score: 0.5,
          neighborhood
        });
      }
    }

    // Candidate D: Top node by "data" role (if identifiable and different)
    if (candidates.length < this.MAX_GRAPH_CANDIDATES) {
      const dataNodes = graph.nodes.filter(node => {
        const role = this.identifyNodeRole(node, graph);
        return role === 'data' && !candidates.some(c => c.id === node.id);
      });
      if (dataNodes.length > 0) {
        const dataNode = dataNodes[0];
        const neighborhood = this.extractSubgraph(graph.nodes, graph.edges, dataNode.id, this.UPSTREAM_HOPS, this.DOWNSTREAM_HOPS);
        candidates.push({
          id: dataNode.id,
          reason: 'likely persistence',
          score: 0.4,
          neighborhood
        });
      }
    }

    // If still not enough candidates, add top nodes by total degree
    for (const nextNode of nodesByInDegree) {
      if (candidates.length >= this.MAX_GRAPH_CANDIDATES) {
        break;
      }
      if (candidates.some(c => c.id === nextNode.id)) {
        continue;
      }
      const node = nodeMap.get(nextNode.id);
      if (node) {
        const neighborhood = this.extractSubgraph(graph.nodes, graph.edges, nextNode.id, this.UPSTREAM_HOPS, this.DOWNSTREAM_HOPS);
        candidates.push({
          id: nextNode.id,
          reason: 'high centrality',
          score: 0.4,
          neighborhood
        });
      }
    }

    return candidates.slice(0, this.MAX_GRAPH_CANDIDATES);
  }

  /**
   * LLM focus check: small prompt to validate/redirect focus
   * Returns 1-2 selected node IDs
   */
  private async llmSelectFocus(
    bugReport: string,
    logs: string,
    candidates: GraphCandidate[],
    model: string
  ): Promise<FocusSelection> {
    // Build candidate descriptions with neighborhoods
    const candidateDescriptions = candidates.map((candidate, index) => {
      const nodeCount = candidate.neighborhood.nodes.length;
      const edgeCount = candidate.neighborhood.edges.length;
      const nodeLabels = candidate.neighborhood.nodes
        .slice(0, 5)
        .map(n => `${n.label}${n.file ? ` (${n.file})` : ''}`)
        .join(', ');
      
      return `Candidate ${index + 1} (ID: ${candidate.id}):
  - Reason: ${candidate.reason}
  - Score: ${candidate.score.toFixed(2)}
  - Neighborhood: ${nodeCount} nodes, ${edgeCount} edges
  - Key nodes: ${nodeLabels || 'none'}`;
    }).join('\n\n');

    const trimmedLogs = logs ? this.trimLogs(logs).substring(0, 500) : 'No logs provided';

    const prompt = `You are choosing the most likely area of code to inspect first for a bug.

User bug report: "${bugReport.substring(0, 300)}"

Available logs: ${trimmedLogs}

Here are ${candidates.length} candidate code areas (with call neighbors):

${candidateDescriptions}

Pick 1 or 2 candidate IDs that are most relevant to this bug and explain why.

You MUST reply with JSON only, inside a single code fence \`\`\`json ... \`\`\`.

Schema:
{
  "focusNodes": ["candidate_id_1", "candidate_id_2"],
  "reason": "explanation of why these candidates are most relevant"
}

Rules:
- Use the node IDs exactly as shown (e.g., "${candidates[0]?.id || 'node_id'}")
- Pick at most 2 candidates
- Explain why these candidates match the bug description`;

    const messages: LLMMessage[] = [
      {
        role: 'system',
        content: 'You are a software engineer analyzing bug reports. Choose the most relevant code areas to inspect first.'
      },
      {
        role: 'user',
        content: prompt
      }
    ];

    const request: LLMRequest = {
      id: `focus-select-${Date.now()}`,
      provider: '',
      model,
      messages,
      temperature: 0.2,
      maxTokens: this.FOCUS_LLM_MAX_TOKENS,
      metadata: {},
      createdAt: new Date(),
      updatedAt: new Date()
    };

    try {
      const timeout = 90000; // 90 seconds
      const llmResponse = await Promise.race([
        this.llmProvider.chat(request),
        new Promise<never>((_, reject) => 
          setTimeout(() => reject(new Error('LLM call timeout')), timeout)
        )
      ]);

      if (llmResponse.type !== ResponseType.SUCCESS || !llmResponse.payload) {
        throw new Error('LLM focus check failed');
      }

      let content = (llmResponse.payload as any).content?.trim() || '';
      const fencedJson = this.extractFencedJson(content);
      const jsonContent = fencedJson || content;

      const parsed = JSON.parse(jsonContent);
      return {
        focusNodes: Array.isArray(parsed.focusNodes) ? parsed.focusNodes : [parsed.focusNodes].filter(Boolean),
        reason: parsed.reason || 'No reason provided'
      };
    } catch (error) {
      console.warn('[HypothesisGenerator] LLM focus check failed, falling back to first candidate:', error);
      // Fallback to first candidate
      return {
        focusNodes: [candidates[0].id],
        reason: 'LLM focus check failed, using first candidate'
      };
    }
  }

  /**
   * Build filtered code context from selected node IDs
   * Filters DebugContext to include only selected nodes and their neighbors
   */
  private buildCodeContextFromGraph(
    debugContext: DebugContext,
    selectedNodeIds: string[]
  ): DebugContext {
    const graph = debugContext.graph;
    const nodeSet = new Set<string>();

    // Expand each selected node to 1-hop neighbors
    for (const nodeId of selectedNodeIds) {
      nodeSet.add(nodeId);
      
      // Add outgoing neighbors
      const outgoingEdges = graph.edges.filter(e => e.from === nodeId);
      for (const edge of outgoingEdges) {
        nodeSet.add(edge.to);
      }
      
      // Add incoming neighbors
      const incomingEdges = graph.edges.filter(e => e.to === nodeId);
      for (const edge of incomingEdges) {
        nodeSet.add(edge.from);
      }
    }

    // Filter graph nodes and edges
    const filteredNodes = graph.nodes.filter(n => nodeSet.has(n.id));
    const filteredEdges = graph.edges.filter(e => 
      nodeSet.has(e.from) && nodeSet.has(e.to)
    );

    // Extract file paths from filtered nodes
    const filteredFileSet = new Set<string>();
    for (const node of filteredNodes) {
      if (node.file) {
        filteredFileSet.add(this.normalizePath(node.file));
      }
    }

    // Filter candidates to only include files from filtered nodes
    const filteredCandidates = debugContext.candidates.filter(c => 
      filteredFileSet.has(this.normalizePath(c.file))
    );

    // If filtered context has 0 code blocks, we keep original candidates
    // (in practice, DebugContext.candidates should already have code)
    const finalCandidates = filteredCandidates.length > 0 
      ? filteredCandidates 
      : debugContext.candidates.filter(c => {
          const filePath = this.normalizePath(c.file);
          return Array.from(filteredFileSet).some(filteredFile => 
            filePath.includes(filteredFile) || filteredFile.includes(filePath)
          );
        });

    // Apply hard cap on context size
    let contextChars = JSON.stringify({
      nodes: filteredNodes,
      edges: filteredEdges,
      candidates: finalCandidates
    }).length;

    // Truncate if too large
    let truncatedNodes = filteredNodes;
    let truncatedEdges = filteredEdges;
    let truncatedCandidates = finalCandidates;

    if (contextChars > this.MAX_CONTEXT_CHARS) {
      // Sort nodes by importance (badges, centrality)
      const nodeScores = new Map<string, number>();
      for (const node of filteredNodes) {
        let score = 0;
        const badges = node.badges || [];
        if (badges.includes('error')) score += 10;
        if ((badges as string[]).includes('entry')) score += 5;
        if ((badges as string[]).includes('spine')) score += 5;
        nodeScores.set(node.id, score);
      }

      // Keep top-scored nodes
      const sortedNodes = filteredNodes.sort((a, b) => 
        (nodeScores.get(b.id) || 0) - (nodeScores.get(a.id) || 0)
      );

      truncatedNodes = sortedNodes.slice(0, Math.floor(filteredNodes.length * 0.7));
      truncatedEdges = filteredEdges.filter(e => 
        truncatedNodes.some(n => n.id === e.from || n.id === e.to)
      );
      truncatedCandidates = finalCandidates.slice(0, Math.floor(finalCandidates.length * 0.7));
    }

    return {
      ...debugContext,
      graph: {
        nodes: truncatedNodes,
        edges: truncatedEdges
      },
      candidates: truncatedCandidates
    };
  }

  /**
   * Compute node degrees (in-degree and out-degree) for centrality
   */
  private computeNodeDegrees(
    graph: { nodes: GraphNode[]; edges: GraphEdge[] }
  ): Map<string, { in: number; out: number }> {
    const degrees = new Map<string, { in: number; out: number }>();

    // Initialize all nodes
    for (const node of graph.nodes) {
      degrees.set(node.id, { in: 0, out: 0 });
    }

    // Count edges
    for (const edge of graph.edges) {
      const fromDegrees = degrees.get(edge.from);
      const toDegrees = degrees.get(edge.to);

      if (fromDegrees) {
        fromDegrees.out++;
      }
      if (toDegrees) {
        toDegrees.in++;
      }
    }

    return degrees;
  }

  /**
   * Extract subgraph around a focal node with specified hop distances
   */
  private extractSubgraph(
    nodes: GraphNode[],
    edges: GraphEdge[],
    focusId: string,
    upstreamHops: number,
    downstreamHops: number
  ): { nodes: GraphNode[]; edges: GraphEdge[] } {
    const nodeMap = new Map(nodes.map(n => [n.id, n]));
    const edgeMap = new Map<string, GraphEdge[]>();
    
    // Build edge map
    for (const edge of edges) {
      if (!edgeMap.has(edge.from)) {
        edgeMap.set(edge.from, []);
      }
      edgeMap.get(edge.from)!.push(edge);
    }

    const visited = new Set<string>([focusId]);
    const frontier = [{ nodeId: focusId, hop: 0 }];
    let currentIndex = 0;

    // BFS from focus node (downstream)
    while (currentIndex < frontier.length) {
      const { nodeId, hop } = frontier[currentIndex++];
      
      if (hop >= downstreamHops) continue;

      const neighbors = edgeMap.get(nodeId) || [];
      for (const edge of neighbors) {
        if (!visited.has(edge.to)) {
          visited.add(edge.to);
          frontier.push({ nodeId: edge.to, hop: hop + 1 });
        }
      }
    }

    // BFS backward from focus node (upstream)
    const reverseEdgeMap = new Map<string, GraphEdge[]>();
    for (const edge of edges) {
      if (!reverseEdgeMap.has(edge.to)) {
        reverseEdgeMap.set(edge.to, []);
      }
      reverseEdgeMap.get(edge.to)!.push(edge);
    }

    const upstreamFrontier = [{ nodeId: focusId, hop: 0 }];
    let upstreamIndex = 0;

    while (upstreamIndex < upstreamFrontier.length) {
      const { nodeId, hop } = upstreamFrontier[upstreamIndex++];
      
      if (hop >= upstreamHops) continue;

      const neighbors = reverseEdgeMap.get(nodeId) || [];
      for (const edge of neighbors) {
        if (!visited.has(edge.from)) {
          visited.add(edge.from);
          upstreamFrontier.push({ nodeId: edge.from, hop: hop + 1 });
        }
      }
    }

    const filteredNodes = nodes.filter(n => visited.has(n.id));
    const filteredEdges = edges.filter(e => 
      visited.has(e.from) && visited.has(e.to)
    );

    return { nodes: filteredNodes, edges: filteredEdges };
  }

  /**
   * Identify node role (API, data, controller, etc.) using heuristics
   */
  private identifyNodeRole(node: GraphNode, graph: { nodes: GraphNode[]; edges: GraphEdge[] }): 'api' | 'data' | 'controller' | 'unknown' {
    const label = node.label.toLowerCase();
    const file = node.file ? node.file.toLowerCase() : '';

    // API detection
    if (
      label.includes('api') ||
      label.includes('route') ||
      label.includes('handler') ||
      label.includes('endpoint') ||
      file.includes('/api/') ||
      file.includes('/routes/') ||
      node.badges?.includes('routeHandler')
    ) {
      return 'api';
    }

    // Data/Persistence detection
    if (
      label.includes('db') ||
      label.includes('database') ||
      label.includes('model') ||
      label.includes('repository') ||
      label.includes('store') ||
      label.includes('persist') ||
      file.includes('/db/') ||
      file.includes('/model/') ||
      file.includes('/repository/')
    ) {
      return 'data';
    }

    // Controller detection
    if (
      label.includes('controller') ||
      label.includes('service') ||
      file.includes('/controller/') ||
      file.includes('/service/')
    ) {
      return 'controller';
    }

    return 'unknown';
  }
}