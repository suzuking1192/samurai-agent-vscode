/**
 * Search Planner for debugging code extraction
 * 
 * Generates search plans via LLM for debugging scenarios
 */

import { createHash } from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { loadDebuggingPrompt } from './promptLoader';
import { Evidence, SearchPlan, RepoMeta } from './types';
import { LLMProviderService } from '../../llm/llmProviderService';
import { LLMMessage, LLMRequest } from '../../../common/models/llm-models';
import { ResponseType } from '../../../common/models/response-models';

export class SearchPlanner {
  private readonly llmProviderService: LLMProviderService;
  private readonly planCache = new Map<string, SearchPlan>();

  constructor(llmProviderService: LLMProviderService) {
    this.llmProviderService = llmProviderService;
  }

  /**
   * Generate search plan via LLM with caching
   */
  public async makeSearchPlan(
    evidence: Evidence,
    repoMeta: RepoMeta,
    userMessage: string,
    model: string
  ): Promise<SearchPlan> {
    // Create cache key
    const cacheKey = this.createCacheKey(userMessage, evidence, repoMeta);
    
    // Check cache first
    if (this.planCache.has(cacheKey)) {
      console.log('[SearchPlanner] Using cached search plan');
      return this.planCache.get(cacheKey)!;
    }

    // Generate new plan
    const plan = await this.generateSearchPlan(evidence, repoMeta, userMessage, model);
    
    // Cache the result
    this.planCache.set(cacheKey, plan);
    
    return plan;
  }

  /**
   * Generate search plan using LLM
   */
  private async generateSearchPlan(
    evidence: Evidence,
    repoMeta: RepoMeta,
    userMessage: string,
    model: string
  ): Promise<SearchPlan> {
    const prompt = this.buildCompleteSearchPlanPrompt(evidence, repoMeta, userMessage);
    
    // Use single user message instead of system/user split
    const messages: LLMMessage[] = [
      {
        role: 'user',
        content: prompt
      }
    ];

    const request: LLMRequest = {
      id: `search-plan-${Date.now()}`,
      provider: '',
      model,
      messages,
      temperature: 0.3,
      maxTokens: 4000, // Increased to prevent MAX_TOKENS errors
      metadata: {},
      createdAt: new Date(),
      updatedAt: new Date()
    };

    // Log request details for debugging
    console.log('[SearchPlanner] Request details:', {
      model,
      messageCount: messages.length,
      promptLength: prompt.length,
      promptPreview: prompt.substring(0, 200) + '...',
      maxTokens: request.maxTokens
    });

    try {
      const response = await this.llmProviderService.chat(request);
      
      // Log response details for debugging
      console.log('[SearchPlanner] LLM response received:', {
        type: response.type,
        hasPayload: !!response.payload,
        error: response.error,
        requestId: response.requestId
      });
      
      if (response.type !== ResponseType.SUCCESS) {
        const errorMessage = response.error || 'Unknown error from LLM provider';
        console.error('[SearchPlanner] LLM response error:', {
          type: response.type,
          error: errorMessage,
          requestId: response.requestId,
          payload: response.payload
        });
        throw new Error(`Failed to get LLM response for search planning: ${errorMessage}`);
      }
      
      if (!response.payload) {
        console.error('[SearchPlanner] LLM response missing payload:', response);
        throw new Error('Failed to get LLM response for search planning: No payload in response');
      }

      const llmResponse = response.payload as any; // Type assertion for now
      const content = llmResponse.content?.trim() || '';
      
      if (!content) {
        console.error('[SearchPlanner] Empty content in LLM response:', {
          llmResponse,
          contentLength: content.length,
          hasContent: !!llmResponse.content
        });
        throw new Error('Failed to get LLM response for search planning: Empty content in response');
      }
      
      // Log the raw content for debugging
      console.log('[SearchPlanner] LLM content received:', {
        contentLength: content.length,
        contentPreview: content.substring(0, 500) + (content.length > 500 ? '...' : '')
      });
      
      const parsed = this.parseSearchPlanResponse(content, evidence);
      
      return parsed;
    } catch (error) {
      console.error('Error generating search plan:', error);
      // Return fallback plan
      return this.createFallbackPlan(evidence, repoMeta);
    }
  }

  /**
   * Build complete search plan prompt with instructions and evidence
   */
  private buildCompleteSearchPlanPrompt(evidence: Evidence, repoMeta: RepoMeta, userMessage: string): string {
    // Load the instruction template
    let instructions: string;
    try {
      const promptContent = loadDebuggingPrompt('search_plan.md');
      // Get instructions before template variables
      const lines = promptContent.split('\n');
      const instructionLines = [];
      for (const line of lines) {
        if (line.includes('{{')) {
          break; // Stop at template variables
        }
        instructionLines.push(line);
      }
      instructions = instructionLines.join('\n').trim();
    } catch (error) {
      console.warn('Failed to load search plan prompt file, using fallback:', error);
      instructions = 'You are a search planner for debugging code analysis. Analyze the debugging scenario and return valid JSON with candidateFiles, symbols, queries, reasoning, and mode.';
    }

    // Build evidence sections
    const stackTrace = this.buildStackTraceSection(evidence);
    const errorDetails = this.buildErrorDetailsSection(evidence);
    const routeInfo = this.buildRouteInfoSection(evidence);
    const logSignatures = this.buildLogSignaturesSection(evidence);
    const softSignals = this.buildSoftSignalsSection(evidence);
    const behaviorHints = this.buildBehaviorHintsSection(evidence);
    const availableFiles = this.buildAvailableFilesSection(repoMeta);
    const chatContext = this.buildChatContextSection(evidence);
    
    // Combine instructions with evidence
    return `${instructions}

## USER MESSAGE
${userMessage.substring(0, 512)}

## EVIDENCE ANALYSIS

${chatContext}

${stackTrace}

${errorDetails}

${routeInfo}

${logSignatures}

${softSignals}

${behaviorHints}

${availableFiles}

Please analyze this debugging scenario and return valid JSON with candidateFiles, symbols, queries, reasoning, and mode (hard-error, soft-error, or behavior-first).`;
  }

  /**
   * Build stack trace section
   */
  private buildStackTraceSection(evidence: Evidence): string {
    if (evidence.frames.length === 0) {
      return '### Stack Trace Analysis\nNo stack trace available.';
    }
    
    let section = '### Stack Trace Analysis\n';
    evidence.frames.forEach(frame => {
      section += `- ${frame.file}:${frame.line}${frame.fn ? ` (${frame.fn})` : ''}\n`;
    });
    return section;
  }

  /**
   * Build error details section
   */
  private buildErrorDetailsSection(evidence: Evidence): string {
    if (!evidence.error) {
      return '### Error Details\nNo error message available.';
    }
    
    return `### Error Details\n${evidence.error}`;
  }

  /**
   * Build route info section
   */
  private buildRouteInfoSection(evidence: Evidence): string {
    if (!evidence.route) {
      return '### Route Information\nNo route information available.';
    }
    
    return `### Route Information\n${evidence.route}`;
  }

  /**
   * Build log signatures section
   */
  private buildLogSignaturesSection(evidence: Evidence): string {
    if (!evidence.logSignatures || evidence.logSignatures.length === 0) {
      return '### Log Signatures\nNo log signatures available.';
    }
    
    let section = '### Log Signatures\n';
    evidence.logSignatures.slice(0, 5).forEach(sig => {
      section += `- ${sig}\n`;
    });
    return section;
  }

  /**
   * Build soft signals section
   */
  private buildSoftSignalsSection(evidence: Evidence): string {
    if (!evidence.softSignals || evidence.softSignals.length === 0) {
      return '### Soft Signals\nNo soft failure signals detected.';
    }
    
    let section = '### Soft Signals\n';
    evidence.softSignals.slice(0, 10).forEach(signal => {
      section += `- ${signal.kind.toUpperCase()}: ${signal.text}${signal.at ? ` (${signal.at})` : ''}\n`;
    });
    
    if (evidence.httpSpans && evidence.httpSpans.length > 0) {
      section += '\n**HTTP Requests:**\n';
      evidence.httpSpans.slice(0, 5).forEach(span => {
        section += `- ${span.method} ${span.url} → ${span.status}${span.ms ? ` (${span.ms}ms)` : ''}\n`;
      });
    }
    
    return section;
  }

  /**
   * Build behavior hints section
   */
  private buildBehaviorHintsSection(evidence: Evidence): string {
    if (!evidence.behaviorHints || evidence.behaviorHints.length === 0) {
      return '### Behavior Hints\nNo behavioral hints extracted from user message.';
    }
    
    let section = '### Behavior Hints\n';
    evidence.behaviorHints.forEach(hint => {
      section += `- ${hint.kind}: ${hint.value}\n`;
    });
    return section;
  }

  /**
   * Build available files section
   */
  private buildAvailableFilesSection(repoMeta: RepoMeta): string {
    const fileList = repoMeta.fileList.slice(0, 100);
    let section = '### Available Files\n';
    fileList.forEach(file => {
      section += `- ${file}\n`;
    });
    return section;
  }

  /**
   * Parse LLM response for search plan
   */
  private parseSearchPlanResponse(content: string, evidence: Evidence): SearchPlan {
    try {
      // Try to extract JSON from response
      const jsonMatch = content.match(/\{[\s\S]*\}/);
      if (!jsonMatch) {
        throw new Error('No JSON found in response');
      }
      
      const parsed = JSON.parse(jsonMatch[0]);
      
      // Validate required fields
      if (!Array.isArray(parsed.candidateFiles)) {
        throw new Error('candidateFiles must be an array');
      }
      
      if (!Array.isArray(parsed.symbols)) {
        throw new Error('symbols must be an array');
      }
      
      if (!Array.isArray(parsed.queries)) {
        throw new Error('queries must be an array');
      }
      
      // Determine mode based on evidence
      let mode: 'hard-error' | 'soft-error' | 'behavior-first' = 'behavior-first';
      if (evidence.hasHardError) {
        mode = 'hard-error';
      } else if (evidence.softSignals && evidence.softSignals.length > 0) {
        mode = 'soft-error';
      }

      // Apply limits
      return {
        candidateFiles: parsed.candidateFiles.slice(0, 10),
        symbols: parsed.symbols.slice(0, 15),
        queries: parsed.queries.slice(0, 10),
        reasoning: parsed.reasoning || 'No reasoning provided',
        mode: parsed.mode || mode
      };
    } catch (error) {
      console.error('Failed to parse search plan response:', error);
      throw new Error('Invalid search plan response format');
    }
  }

  /**
   * Create fallback plan when LLM fails
   */
  private createFallbackPlan(evidence: Evidence, repoMeta: RepoMeta): SearchPlan {
    const candidateFiles: string[] = [];
    const symbols: string[] = [];
    const queries: string[] = [];
    
    // Add files from stack traces
    evidence.frames.forEach(frame => {
      if (frame.file && !candidateFiles.includes(frame.file)) {
        candidateFiles.push(frame.file);
      }
    });
    
    // Add error-related queries
    if (evidence.error) {
      queries.push(evidence.error);
    }
    
    // Add route-related queries
    if (evidence.route) {
      queries.push(evidence.route);
    }
    
    // Add generic debugging queries
    queries.push('error', 'bug', 'debug', 'exception');
    
    // Determine mode for fallback plan
    let mode: 'hard-error' | 'soft-error' | 'behavior-first' = 'behavior-first';
    if (evidence.hasHardError) {
      mode = 'hard-error';
    } else if (evidence.softSignals && evidence.softSignals.length > 0) {
      mode = 'soft-error';
    }

    return {
      candidateFiles: candidateFiles.slice(0, 10),
      symbols: symbols.slice(0, 15),
      queries: queries.slice(0, 10),
      reasoning: 'Fallback plan generated due to LLM failure',
      mode
    };
  }

  /**
   * Build chat context section
   */
  private buildChatContextSection(evidence: Evidence): string {
    if (!evidence.chatSummary || evidence.chatSummary.trim() === '') {
      return '### Chat Context\nNo previous conversation context available.';
    }
    
    return `### Chat Context
${evidence.chatSummary}`;
  }

  /**
   * Create cache key for search plan
   */
  private createCacheKey(userMessage: string, evidence: Evidence, repoMeta: RepoMeta): string {
    const content = JSON.stringify({
      userMessage: userMessage.substring(0, 200), // Truncate for key
      frames: evidence.frames.map(f => `${f.file}:${f.line}`),
      error: evidence.error,
      route: evidence.route,
      fileCount: repoMeta.fileList.length,
      commitHash: repoMeta.commitHash
    });
    
    return createHash('sha256').update(content).digest('hex').substring(0, 16);
  }

  /**
   * Clear cache (useful for testing)
   */
  public clearCache(): void {
    this.planCache.clear();
  }
}
