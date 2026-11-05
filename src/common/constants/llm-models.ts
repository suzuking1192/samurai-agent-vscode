/**
 * LLM Models Constants
 * 
 * Centralized definition of available LLM models and their associated costs
 * for use across the Samurai Agent extension.
 */

/**
 * LLM Model definition interface
 */
export interface LLMModel {
    id: string;
    name: string;
    provider: string;
    inputCostPerMTokens: number;
    outputCostPerMTokens: number;
    description?: string;
    maxTokens?: number;
    maxInputTokens?: number;
    supportsStreaming?: boolean;
}

/**
 * Built-in model catalog. Intentionally empty: models are user-defined BYOK
 * entries (see `llmEntries` in global settings). Cost fields default to 0 for custom models.
 */
export const LLM_MODELS: Record<string, LLMModel[]> = {};

/**
 * Get all models as a flat array
 */
export function getAllModels(): LLMModel[] {
    return Object.values(LLM_MODELS).flat();
}

/**
 * Get models for a specific provider
 */
export function getModelsByProvider(provider: string): LLMModel[] {
    return LLM_MODELS[provider] || [];
}

/**
 * Get a specific model by ID
 */
export function getModelById(modelId: string): LLMModel | undefined {
    return getAllModels().find(model => model.id === modelId);
}

/**
 * Get available providers
 */
export function getAvailableProviders(): string[] {
    return Object.keys(LLM_MODELS);
}

