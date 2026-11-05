/**
 * Agent Prompt Generator
 * 
 * Generates LLM-backed prompts for AI coding agents to add instrumentation/logs
 */

import { LLMProviderService } from '../../llm/llmProviderService';
import { Evidence, CandidateFile, AgentPrompt, AgentPromptKind } from './types';
import { RedactionUtil } from './RedactionUtil';

export interface AgentPromptInput {
  itemId: string;
  evidence: Evidence;
  topCandidates: CandidateFile[]; // limited view (top 3)
  graphSummary?: string;
  chatSummary?: string;
}

export interface GeneratedAgentPrompt {
  kind: AgentPromptKind;
  text: string;
  highlights: string[];
}

export class AgentPromptGenerator {
  private llmProvider: LLMProviderService;
  private redactionUtil: RedactionUtil;
  private cache: Map<string, { prompt: GeneratedAgentPrompt; timestamp: number }> = new Map();
  private readonly CACHE_TTL = 60 * 60 * 1000; // 1 hour
  private readonly MAX_PROMPT_LENGTH = 10000;
  
  constructor(llmProvider: LLMProviderService) {
    this.llmProvider = llmProvider;
    this.redactionUtil = new RedactionUtil();
  }
  
  /**
   * Generate agent prompt (LLM-backed for instrumentation requests only)
   */
  async generate(input: AgentPromptInput, model: string): Promise<GeneratedAgentPrompt | null> {
    // Only generate for agent instrumentation requests
    const agentRequestIds = ['need_full_stack', 'need_request_id_logs', 'need_module_resolution_trace'];
    if (!agentRequestIds.includes(input.itemId)) {
      return null;
    }
    
    // Check cache
    const cacheKey = this.createCacheKey(input);
    const cached = this.cache.get(cacheKey);
    if (cached && Date.now() - cached.timestamp < this.CACHE_TTL) {
      console.log('[AgentPromptGenerator] Using cached prompt');
      return cached.prompt;
    }
    
    try {
      const prompt = await this.generateWithLLM(input, model);
      
      // Cache result
      this.cache.set(cacheKey, { prompt, timestamp: Date.now() });
      
      // Enforce cache limit
      if (this.cache.size > 100) {
        const oldestKey = Array.from(this.cache.keys())[0];
        this.cache.delete(oldestKey);
      }
      
      return prompt;
    } catch (error) {
      console.error('[AgentPromptGenerator] Failed to generate prompt:', error);
      return this.createFallbackPrompt(input.itemId);
    }
  }
  
  /**
   * Generate prompt using LLM
   */
  private async generateWithLLM(input: AgentPromptInput, model: string): Promise<GeneratedAgentPrompt> {
    const prompt = this.buildLLMPrompt(input);
    
    // Redact sensitive data
    const redacted = this.redactionUtil.redactSensitiveData(prompt);
    
    try {
      const chatResponse = await this.llmProvider.chat({
        id: 'agent-prompt-generator',
        provider: '',
        model,
        messages: [
          {
            role: 'system',
            content: 'You are a code instrumentation assistant. Generate copyable prompts for AI coding agents to add debug logs.'
          },
          {
            role: 'user',
            content: redacted.redacted
          }
        ],
        temperature: 0.3,
        maxTokens: 20000,
        metadata: {},
        createdAt: new Date(),
        updatedAt: new Date()
      });
      
      if (chatResponse.type !== 'success' || !chatResponse.payload) {
        throw new Error('LLM request failed');
      }
      
      // Type guard: check if payload is LLMResponse
      if ('error' in chatResponse.payload) {
        throw new Error('LLM request failed: ' + chatResponse.payload.error);
      }
      
      const content = chatResponse.payload.content.trim();
      const parsed = this.parseLLMResponse(content);
      
      // Verify and truncate
      if (parsed.text.length > this.MAX_PROMPT_LENGTH) {
        parsed.text = parsed.text.substring(0, this.MAX_PROMPT_LENGTH) + '...';
      }
      
      // Verify referenced files/symbols
      this.verifyAgentPrompt(parsed, input);
      
      return parsed;
    } catch (error) {
      console.error('[AgentPromptGenerator] LLM call failed:', error);
      throw error;
    }
  }
  
  /**
   * Build prompt for LLM
   */
  private buildLLMPrompt(input: AgentPromptInput): string {
    const { itemId, evidence, topCandidates, chatSummary } = input;
    
    let prompt = `Generate a copyable prompt for an AI coding agent to add instrumentation/logs.\n\n`;
    
    // Add context based on itemId
    if (itemId === 'need_full_stack') {
      prompt += `Context: Add structured debug logs around the failing call site indicated by the latest stack trace.\n`;
      if (evidence.frames && evidence.frames.length > 0) {
        const frame = evidence.frames[0];
        prompt += `File: ${frame.file}:${frame.line}${frame.fn ? ` (${frame.fn})` : ''}\n`;
      }
    } else if (itemId === 'need_request_id_logs') {
      prompt += `Context: Instrument the Express route handler to log start/end and external calls.\n`;
      if (evidence.route) {
        prompt += `Route: ${evidence.route}\n`;
      }
    } else if (itemId === 'need_module_resolution_trace') {
      prompt += `Context: Add debug logs before each dynamic import or DI lookup.\n`;
    }
    
    // Add top candidates
    if (topCandidates.length > 0) {
      prompt += `\nRelevant files (reference these only):\n`;
      topCandidates.forEach((candidate, idx) => {
        prompt += `${idx + 1}. ${candidate.file}\n`;
      });
    }
    
    // Add chat summary if available
    if (chatSummary) {
      prompt += `\nRecent context: ${chatSummary.substring(0, 200)}\n`;
    }
    
    prompt += `\nGenerate a short (max 1600 chars), copyable prompt that:\n`;
    prompt += `1. Tells the agent exactly where (file/function/route) and what to log\n`;
    prompt += `2. Uses requestId correlation when applicable\n`;
    prompt += `3. Guards logs with LOG_LEVEL==='debug' (or equivalent)\n`;
    prompt += `4. Prefers structured messages: [rid={requestId}] step=<x> fn=<y>\n`;
    prompt += `5. Focuses on: start/end logs, branch points, catches, external calls, variable state\n`;
    prompt += `6. Does not change behavior, only adds logging\n`;
    prompt += `\nReturn plain markdown text (NOT JSON). The prompt text should be ready to copy and use directly.\n`;
    
    return prompt;
  }
  
  /**
   * Parse LLM response
   */
  private parseLLMResponse(content: string): GeneratedAgentPrompt {
    // Remove markdown code fences if present
    const cleanContent = content.replace(/```markdown\s*([\s\S]*?)\s*```/g, '$1').trim();
    
    // Try to parse as JSON first (for backward compatibility)
    try {
      const parsed = JSON.parse(cleanContent);
      return {
        kind: this.sanitizeKind(parsed.kind),
        text: parsed.text || cleanContent,
        highlights: Array.isArray(parsed.highlights) ? parsed.highlights : []
      };
    } catch {
      // Markdown/plain text: treat entire response as text
      return {
        kind: 'generic',
        text: cleanContent,
        highlights: []
      };
    }
  }
  
  /**
   * Sanitize prompt kind
   */
  private sanitizeKind(kind: string): AgentPromptKind {
    const validKinds: AgentPromptKind[] = ['generic', 'node_express', 'next_route', 'react_component', 'serverless', 'jest'];
    return validKinds.includes(kind as AgentPromptKind) ? kind as AgentPromptKind : 'generic';
  }
  
  /**
   * Verify agent prompt references only whitelisted files/symbols
   */
  private verifyAgentPrompt(
    prompt: GeneratedAgentPrompt, 
    input: AgentPromptInput
  ): void {
    const whitelistedFiles = new Set(input.topCandidates.map(c => c.file));
    
    // Extract file references from prompt text
    const fileRefs = prompt.text.match(/['"`]([^'"`]+\.(ts|js|tsx|jsx))['"`]/g);
    
    if (fileRefs) {
      for (const ref of fileRefs) {
        const file = ref.replace(/['"`]/g, '');
        // Check if file is in whitelist
        if (!Array.from(whitelistedFiles).some(whitelisted => file.includes(whitelisted) || whitelisted.includes(file))) {
          console.warn('[AgentPromptGenerator] Prompt references non-whitelisted file:', file);
          // Don't reject, just warn (loose check for paths)
        }
      }
    }
  }
  
  /**
   * Create fallback prompt (static template)
   */
  private createFallbackPrompt(itemId: string): GeneratedAgentPrompt {
    if (itemId === 'need_full_stack') {
      return {
        kind: 'generic',
        text: 'Add structured debug logs around the failing call site indicated by the latest stack trace. Include start/end, branch points, and catches; prefix with [rid={requestId}]. Guard with LOG_LEVEL===\'debug\'.',
        highlights: [
          'Add logs at function entry/exit',
          'Log important variable states',
          'Include requestId correlation'
        ]
      };
    } else if (itemId === 'need_request_id_logs') {
      return {
        kind: 'node_express',
        text: 'Instrument the Express route handler to log start/end and external calls using req.id (or generate one if absent). Prefix logs with [rid={requestId}].',
        highlights: [
          'Log at route handler entry',
          'Include requestId in all logs',
          'Log external API calls'
        ]
      };
    } else if (itemId === 'need_module_resolution_trace') {
      return {
        kind: 'generic',
        text: 'Add debug logs before each dynamic import or DI lookup. Log the resolved module path at runtime.',
        highlights: [
          'Log before dynamic imports',
          'Include resolved paths',
          'Track DI lookups'
        ]
      };
    }
    
    return {
      kind: 'generic',
      text: 'Add debug logs to improve diagnostic capabilities.',
      highlights: []
    };
  }
  
  /**
   * Create cache key
   */
  private createCacheKey(input: AgentPromptInput): string {
    const evidenceHash = JSON.stringify({
      frames: input.evidence.frames?.slice(0, 3),
      error: input.evidence.error,
      route: input.evidence.route
    });
    const candidatesHash = input.topCandidates.map(c => c.file).join(',');
    return `${input.itemId}:${evidenceHash}:${candidatesHash}`;
  }
}

