/**
 * Provider-agnostic LLM request / response / error models.
 */

import { BaseModel, Metadata } from './base-models';

export interface LLMMessage {
    role: 'system' | 'user' | 'assistant';
    content: string;
    metadata?: Metadata;
}

export interface LLMUsage {
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
}

export interface LLMRequest extends BaseModel {
    requestId?: string;
    /** Provider id ('openai' | 'google' | 'anthropic') or 'auto' to let the provider service resolve it. */
    provider: string;
    model: string;
    messages: LLMMessage[];
    temperature?: number;
    maxTokens?: number;
    topP?: number;
    frequencyPenalty?: number;
    presencePenalty?: number;
    stream?: boolean;
    metadata?: Metadata;
}

export interface LLMResponse extends BaseModel {
    requestId: string;
    provider: string;
    model: string;
    content: string;
    usage: LLMUsage;
    cost: number;
    finishReason?: string;
    processingTime?: number;
    metadata?: Metadata;
}

export interface LLMError extends BaseModel {
    requestId: string;
    provider: string;
    model: string;
    error: string;
    errorCode: string;
    retryable: boolean;
    metadata?: Metadata;
}
