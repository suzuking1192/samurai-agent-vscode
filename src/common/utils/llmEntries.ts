/**
 * Pure helpers for user-managed BYOK model entries (`llmEntries` in global settings).
 */

import { GlobalSettings, LlmEntry, LlmEntryProvider } from '../models/settings-models';
import { LLMModel } from '../constants/llm-models';

export const LLM_ENTRY_PROVIDERS: readonly LlmEntryProvider[] = ['openai', 'google', 'anthropic'];

export function isLlmEntryProvider(value: unknown): value is LlmEntryProvider {
    return LLM_ENTRY_PROVIDERS.includes(value as LlmEntryProvider);
}

/** Maps user entries to the model list shown in the webview. Costs default to 0 for custom models. */
export function toAvailableModels(entries: LlmEntry[] | undefined): LLMModel[] {
    return (entries ?? []).map((entry) => ({
        id: entry.id,
        name: entry.label?.trim() || entry.modelName,
        provider: entry.provider,
        inputCostPerMTokens: 0,
        outputCostPerMTokens: 0,
    }));
}

/** Inserts or replaces an entry (matched by id); activates it if nothing is active yet. */
export function upsertEntry(settings: GlobalSettings, entry: LlmEntry): GlobalSettings {
    const existing = settings.llmEntries ?? [];
    const entries = existing.some((e) => e.id === entry.id)
        ? existing.map((e) => (e.id === entry.id ? entry : e))
        : [...existing, entry];
    return { ...settings, llmEntries: entries, activeLlmEntryId: settings.activeLlmEntryId ?? entry.id };
}

/** Removes an entry; if it was active, falls back to the first remaining entry (or null). */
export function removeEntry(settings: GlobalSettings, entryId: string): GlobalSettings {
    const entries = (settings.llmEntries ?? []).filter((entry) => entry.id !== entryId);
    const activeLlmEntryId = settings.activeLlmEntryId === entryId ? (entries[0]?.id ?? null) : settings.activeLlmEntryId;
    return { ...settings, llmEntries: entries, activeLlmEntryId: activeLlmEntryId ?? null };
}

export function setActiveEntry(settings: GlobalSettings, entryId: string): GlobalSettings {
    if (!(settings.llmEntries ?? []).some((entry) => entry.id === entryId)) {
        throw new Error('Model entry not found');
    }
    return { ...settings, activeLlmEntryId: entryId };
}
