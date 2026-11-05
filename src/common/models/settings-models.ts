/**
 * Global (user-wide) and project-level settings models.
 */

import { BaseModel, Metadata } from './base-models';

export type LlmEntryProvider = 'openai' | 'google' | 'anthropic';

/** User-managed BYOK model entry. */
export interface LlmEntry {
    id: string;
    provider: LlmEntryProvider;
    modelName: string;
    label?: string;
}

export interface GlobalSettings extends BaseModel {
    userId: string;
    /** Legacy provider keys; kept for migration to `llmEntries` and may be empty strings. */
    openaiApiKey: string;
    geminiApiKey: string;
    claudeApiKey: string;
    betaCode?: string;
    llmEntries?: LlmEntry[];
    activeLlmEntryId?: string | null;
    defaultProvider: string;
    defaultModel: string;
    defaultMode: string;
    fontSize: number;
    showTokenCounts: boolean;
    showCostEstimates: boolean;
    autoSaveInterval: number;
    maxHistoryItems: number;
    enableNotifications: boolean;
    enableDebugLogging?: boolean;
    enableRegressionDetection?: boolean;
    regressionBannerDismissed?: boolean;
    regressionThreshold?: number;
    customApiEndpoints: Record<string, string>;
    proxySettings?: Metadata;
    metadata: Metadata;
}

export interface ProjectSettings extends BaseModel {
    projectId: string;
    projectName: string;
    rawProjectDetailContent: string;
    digestedProjectDetailContent: string;
    /** Legacy fields migrated into the two content fields above. */
    projectDetailText?: string;
    digestedMemory?: string;
    defaultModel: string;
    defaultMode: string;
    customPrompts: Record<string, string>;
    projectSpecificConfig: Metadata;
    theme: string;
    autoSave: boolean;
    primaryLLMModel: string | null;
    currentSessionId?: string | null;
    metadata: Metadata;
}

export type IProjectSettings = ProjectSettings;
