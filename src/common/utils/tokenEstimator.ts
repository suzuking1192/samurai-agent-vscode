/**
 * Token Estimation and Truncation Utilities
 * 
 * Provides utilities for estimating token counts and intelligently truncating
 * messages to fit within model token limits.
 */

import { LLMMessage } from '../models/llm-models';

/**
 * Estimate token count from messages using heuristic (~4 characters per token)
 * Handles multimodal content (strings, arrays, objects)
 */
export function estimateTokenCount(messages: LLMMessage[] | Array<{ content?: string | any[] }>): number {
  if (!Array.isArray(messages)) {
    return 0;
  }

  const countChars = (content: any): number => {
    if (typeof content === 'string') {
      return content.length;
    }
    if (Array.isArray(content)) {
      return content.reduce((sum: number, item: any) => sum + countChars(item), 0);
    }
    if (typeof content === 'object' && content !== null) {
      // Handle multimodal shapes like { type: 'text', text: '...' }
      return Object.values(content).reduce((sum: number, value: any) => sum + countChars(value), 0);
    }
    return 0;
  };

  const totalChars = messages.reduce((sum: number, message: any) => {
    if (!message || message.content === undefined || message.content === null) {
      return sum;
    }
    return sum + countChars(message.content);
  }, 0);

  // Rough heuristic: ~4 characters per token
  return Math.ceil(totalChars / 4);
}

/**
 * Estimate token count from a single string
 */
export function estimateTokenCountFromString(text: string): number {
  if (!text || typeof text !== 'string') {
    return 0;
  }
  return Math.ceil(text.length / 4);
}

/**
 * Remove code snippets from the bottom of a message content string
 * Identifies code snippets by patterns like code blocks, file headers, etc.
 */
function removeCodeSnippetsFromBottom(content: string): string {
  if (!content || typeof content !== 'string') {
    return content;
  }

  // Patterns to identify code sections
  const codeBlockPattern = /```[\s\S]*?```/g;
  const fileHeaderPattern = /\/\/\s*File:\s*[^\n]+/g;
  const codeSectionPattern = /(?:^|\n)(?:```|##+\s*Code|###+\s*Code|File:|Source:)/gim;

  // Find all code block positions
  const codeBlocks: Array<{ start: number; end: number }> = [];
  let match: RegExpExecArray | null;

  // Find code blocks (```...```)
  const codeBlockRegex = /```[\s\S]*?```/g;
  while ((match = codeBlockRegex.exec(content)) !== null) {
    codeBlocks.push({ start: match.index, end: match.index + match[0].length });
  }

  // Find file headers (// File: ...)
  const fileHeaderRegex = /\/\/\s*File:\s*[^\n]+/g;
  while ((match = fileHeaderRegex.exec(content)) !== null) {
    // Check if this header is followed by code (next 200 chars)
    const afterHeader = content.substring(match.index + match[0].length, match.index + match[0].length + 200);
    if (afterHeader.trim().length > 0) {
      // Find the end of this code section (next code block or end of content)
      const nextCodeBlock = codeBlocks.find(cb => cb.start > match!.index);
      const endPos = nextCodeBlock ? nextCodeBlock.start : content.length;
      codeBlocks.push({ start: match.index, end: endPos });
    }
  }

  // Sort by position (bottom to top)
  codeBlocks.sort((a, b) => b.start - a.start);

  // Remove code blocks from bottom
  let result = content;
  for (const block of codeBlocks) {
    // Remove this code block
    result = result.substring(0, block.start) + result.substring(block.end);
  }

  return result.trim();
}

/**
 * Truncate messages to fit within token limit using smart two-phase strategy
 * 
 * Phase 1: If >4 user messages, remove messages before 4th most recent user message
 * Phase 2: If still exceeds, remove code snippets from bottom of final message
 * 
 * @param messages - Array of LLM messages
 * @param maxTokens - Maximum allowed tokens
 * @returns Truncated messages array
 */
export function truncateMessagesToTokenLimit(
  messages: LLMMessage[],
  maxTokens: number
): LLMMessage[] {
  if (!Array.isArray(messages) || messages.length === 0) {
    return messages;
  }

  let currentMessages = [...messages];
  let currentTokenCount = estimateTokenCount(currentMessages);

  // Only truncate if exceeds limit
  if (currentTokenCount <= maxTokens) {
    return currentMessages;
  }

  const originalTokenCount = currentTokenCount;
  console.warn(`[TokenEstimator] Token count ${currentTokenCount} exceeds limit ${maxTokens}, applying truncation`);

  // Phase 1: Remove old messages if >4 user messages exist
  const userMessages = currentMessages.filter(msg => msg.role === 'user');
  if (userMessages.length > 4) {
    // Find the 4th most recent user message
    const fourthMostRecentUserMessage = userMessages[userMessages.length - 4];
    const fourthMostRecentIndex = currentMessages.indexOf(fourthMostRecentUserMessage);

    // Keep system messages and messages from 4th most recent user message onwards
    const systemMessages = currentMessages.filter(msg => msg.role === 'system');
    const recentMessages = currentMessages.slice(fourthMostRecentIndex);

    // Combine: system messages first, then recent messages
    currentMessages = [...systemMessages, ...recentMessages];
    currentTokenCount = estimateTokenCount(currentMessages);

    console.warn(`[TokenEstimator] Phase 1: Removed messages before 4th most recent user message. Token count: ${originalTokenCount} -> ${currentTokenCount}`);

    // Check if we're now within limit
    if (currentTokenCount <= maxTokens) {
      return currentMessages;
    }
  }

  // Phase 2: Remove code snippets from bottom of final message
  if (currentMessages.length > 0) {
    const finalMessage = currentMessages[currentMessages.length - 1];
    if (finalMessage && finalMessage.content && typeof finalMessage.content === 'string') {
      const originalContent = finalMessage.content;
      const truncatedContent = removeCodeSnippetsFromBottom(originalContent);
      
      if (truncatedContent.length < originalContent.length) {
        currentMessages[currentMessages.length - 1] = {
          ...finalMessage,
          content: truncatedContent
        };
        currentTokenCount = estimateTokenCount(currentMessages);

        console.warn(`[TokenEstimator] Phase 2: Removed code snippets from final message. Token count: ${currentTokenCount}`);
      }
    }
  }

  return currentMessages;
}

