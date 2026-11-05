/**
 * Chat Summary Generator for Debugging Flow
 * 
 * Generates rolling summaries from chat history with leak guards and length limits
 */

import { LLMMessage } from '../../common/models/llm-models';

export interface ChatSummary {
  summary: string;
  keyFiles: string[];
  keySymbols: string[];
  unresolvedQuestions: string[];
  lastHypothesis?: {
    summary: string;
    verdict?: string;
  };
}

/**
 * Secret patterns to redact from chat history
 */
const SECRET_PATTERNS = [
  // API keys and tokens
  /(?:api[_-]?key|token|secret|password|auth[_-]?token)\s*[:=]\s*['"]?([a-zA-Z0-9_\-\.]{20,})['"]?/gi,
  // JWT tokens
  /eyJ[a-zA-Z0-9_\-]+\.[a-zA-Z0-9_\-]+\.[a-zA-Z0-9_\-]+/g,
  // UUIDs that might be sensitive
  /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi,
  // Common secret prefixes
  /(?:sk-|pk-|xoxb-|xoxp-|ghp_|gho_|ghu_|ghs_|ghr_)[a-zA-Z0-9_\-]+/gi,
  // Database URLs
  /(?:mongodb|postgres|mysql|redis):\/\/[^@]+@[^\s]+/gi,
  // Email addresses (optional - might be too aggressive)
  // /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Z|a-z]{2,}\b/g,
];

/**
 * Generate a rolling chat summary from recent messages
 */
export function generateChatSummary(chatHistory: LLMMessage[]): ChatSummary {
  if (!chatHistory || chatHistory.length === 0) {
    return {
      summary: '',
      keyFiles: [],
      keySymbols: [],
      unresolvedQuestions: [],
    };
  }

  // Take last 3-5 exchanges (6-10 messages)
  const recentMessages = chatHistory.slice(-10);
  
  // Extract key information
  const keyFiles = extractKeyFiles(recentMessages);
  const keySymbols = extractKeySymbols(recentMessages);
  const unresolvedQuestions = extractUnresolvedQuestions(recentMessages);
  const lastHypothesis = extractLastHypothesis(recentMessages);
  
  // Generate summary
  const summary = generateRollingSummary(recentMessages, {
    keyFiles,
    keySymbols,
    unresolvedQuestions,
    lastHypothesis,
  });

  return {
    summary,
    keyFiles,
    keySymbols,
    unresolvedQuestions,
    lastHypothesis,
  };
}

/**
 * Extract file paths mentioned in chat
 */
function extractKeyFiles(messages: LLMMessage[]): string[] {
  const files = new Set<string>();
  const filePattern = /(?:file|path|src|app|lib|utils|components|services|models|api)\/[^\s"'`<>]+\.(?:ts|js|tsx|jsx|py|java|cpp|c|h|go|rs|php|rb|swift|kt|scala|clj|hs|ml|fs|vb|cs|dart|r|m|mm|cc|cxx|hpp|hxx|ipp|tpp|cppm|ixx)/gi;
  
  for (const message of messages) {
    const content = message.content || '';
    const matches = content.match(filePattern);
    if (matches) {
      matches.forEach(file => {
        // Clean up the file path
        const cleanFile = file.replace(/['"`]/g, '').trim();
        if (cleanFile.length > 0 && cleanFile.length < 200) {
          files.add(cleanFile);
        }
      });
    }
  }
  
  return Array.from(files).slice(0, 10); // Limit to 10 files
}

/**
 * Extract symbols (functions, classes, variables) mentioned in chat
 */
function extractKeySymbols(messages: LLMMessage[]): string[] {
  const symbols = new Set<string>();
  const symbolPatterns = [
    // Function calls
    /\b([a-zA-Z_$][a-zA-Z0-9_$]*)\s*\(/g,
    // Class names (capitalized)
    /\b([A-Z][a-zA-Z0-9_$]*)\b/g,
    // Method names with dots
    /\b[a-zA-Z_$][a-zA-Z0-9_$]*\.([a-zA-Z_$][a-zA-Z0-9_$]*)\b/g,
  ];
  
  for (const message of messages) {
    const content = message.content || '';
    
    for (const pattern of symbolPatterns) {
      const matches = content.match(pattern);
      if (matches) {
        matches.forEach(match => {
          // Extract the symbol name
          const symbol = match.replace(/[().]/g, '').trim();
          if (symbol.length > 1 && symbol.length < 50 && !symbol.includes(' ')) {
            symbols.add(symbol);
          }
        });
      }
    }
  }
  
  return Array.from(symbols).slice(0, 15); // Limit to 15 symbols
}

/**
 * Extract unresolved questions from chat
 */
function extractUnresolvedQuestions(messages: LLMMessage[]): string[] {
  const questions: string[] = [];
  const questionPatterns = [
    /\?[^?]*\?/g, // Questions with ?...?
    /(?:why|how|what|when|where|which|who)\s+[^.!?]*[?!]/gi, // Wh-questions
    /(?:can|could|should|would|will|is|are|do|does|did)\s+[^.!?]*[?!]/gi, // Yes/no questions
  ];
  
  for (const message of messages) {
    const content = message.content || '';
    
    for (const pattern of questionPatterns) {
      const matches = content.match(pattern);
      if (matches) {
        matches.forEach(question => {
          const cleanQuestion = question.trim();
          if (cleanQuestion.length > 10 && cleanQuestion.length < 200) {
            questions.push(cleanQuestion);
          }
        });
      }
    }
  }
  
  return questions.slice(0, 5); // Limit to 5 questions
}

/**
 * Extract last hypothesis and its verdict
 */
function extractLastHypothesis(messages: LLMMessage[]): ChatSummary['lastHypothesis'] | undefined {
  // Look for hypothesis-related content in recent messages
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i];
    const content = message.content || '';
    
    // Look for hypothesis patterns
    if (content.toLowerCase().includes('hypothesis') || 
        content.toLowerCase().includes('likely root cause') ||
        content.toLowerCase().includes('analysis shows')) {
      
      // Extract verdict if present
      const verdictMatch = content.match(/(?:confirmed|refuted|uncertain|likely|unlikely)/i);
      const verdict = verdictMatch ? verdictMatch[0].toLowerCase() : undefined;
      
      // Extract summary (first sentence or up to 100 chars)
      const summary = content.split('.')[0].substring(0, 100).trim();
      
      return {
        summary,
        verdict,
      };
    }
  }
  
  return undefined;
}

/**
 * Generate the rolling summary text
 */
function generateRollingSummary(
  messages: LLMMessage[],
  context: {
    keyFiles: string[];
    keySymbols: string[];
    unresolvedQuestions: string[];
    lastHypothesis?: ChatSummary['lastHypothesis'];
  }
): string {
  const parts: string[] = [];
  
  // Add last hypothesis if available
  if (context.lastHypothesis) {
    parts.push(`Last analysis: ${context.lastHypothesis.summary}`);
    if (context.lastHypothesis.verdict) {
      parts.push(`Verdict: ${context.lastHypothesis.verdict}`);
    }
  }
  
  // Add key files
  if (context.keyFiles.length > 0) {
    parts.push(`Key files: ${context.keyFiles.slice(0, 3).join(', ')}`);
  }
  
  // Add key symbols
  if (context.keySymbols.length > 0) {
    parts.push(`Key symbols: ${context.keySymbols.slice(0, 5).join(', ')}`);
  }
  
  // Add unresolved questions
  if (context.unresolvedQuestions.length > 0) {
    parts.push(`Open questions: ${context.unresolvedQuestions[0]}`);
  }
  
  const summary = parts.join(' | ');
  
  // Ensure we don't exceed 600 characters
  if (summary.length <= 600) {
    return summary;
  }
  
  // Truncate intelligently
  const truncated = summary.substring(0, 597) + '...';
  return truncated;
}

/**
 * Redact secrets from text
 */
export function redactSecrets(text: string): string {
  let redacted = text;
  
  for (const pattern of SECRET_PATTERNS) {
    redacted = redacted.replace(pattern, '[REDACTED]');
  }
  
  return redacted;
}

/**
 * Check if text contains secrets
 */
export function containsSecrets(text: string): boolean {
  return SECRET_PATTERNS.some(pattern => pattern.test(text));
}



















