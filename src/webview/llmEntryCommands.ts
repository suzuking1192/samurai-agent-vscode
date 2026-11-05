/**
 * Webview command handlers for BYOK model entries.
 * Settings JSON stores provider + model name; API keys go to SecretStorage.
 */

import { randomUUID } from 'crypto';
import { GlobalDataStore } from '../persistence/globalDataStore';
import { GlobalSettings, LlmEntry } from '../common/models/settings-models';
import { deleteKey, setKey } from '../common/utils/llmSecretStore';
import { isLlmEntryProvider, removeEntry, setActiveEntry, upsertEntry } from '../common/utils/llmEntries';

export const LLM_ENTRY_COMMANDS = ['saveLlmEntry', 'deleteLlmEntry', 'setActiveLlmEntry'] as const;

export function isLlmEntryCommand(command: unknown): boolean {
    return LLM_ENTRY_COMMANDS.includes(command as (typeof LLM_ENTRY_COMMANDS)[number]);
}

function loadSettings(store: GlobalDataStore): GlobalSettings {
    const response = store.loadGlobalSettings();
    if (!response.payload) {
        throw new Error(response.error || 'Global settings could not be loaded');
    }
    return response.payload;
}

function persist(store: GlobalDataStore, settings: GlobalSettings): GlobalSettings {
    const response = store.saveGlobalSettings(settings);
    if (!response.payload) {
        throw new Error(response.error || 'Failed to save settings');
    }
    return response.payload;
}

function parseEntry(payload: any, existing: LlmEntry[]): { entry: LlmEntry; apiKey: string } {
    const modelName = String(payload?.modelName ?? '').trim();
    const apiKey = String(payload?.apiKey ?? '').trim();
    const id = payload?.id ? String(payload.id) : randomUUID();
    if (!isLlmEntryProvider(payload?.provider)) {
        throw new Error('Provider must be openai, google, or anthropic');
    }
    if (!modelName) {
        throw new Error('Model name is required');
    }
    if (!apiKey && !existing.some((entry) => entry.id === id)) {
        throw new Error('API key is required');
    }
    const label = String(payload?.label ?? '').trim();
    return { entry: { id, provider: payload.provider, modelName, ...(label ? { label } : {}) }, apiKey };
}

async function saveEntry(store: GlobalDataStore, payload: any): Promise<GlobalSettings> {
    const settings = loadSettings(store);
    const { entry, apiKey } = parseEntry(payload, settings.llmEntries ?? []);
    if (apiKey) {
        await setKey(entry.id, apiKey);
    }
    return persist(store, upsertEntry(settings, entry));
}

async function deleteEntry(store: GlobalDataStore, payload: any): Promise<GlobalSettings> {
    const id = String(payload?.id ?? '');
    await deleteKey(id);
    return persist(store, removeEntry(loadSettings(store), id));
}

/** Executes a BYOK entry command and returns the updated global settings. */
export async function handleLlmEntryCommand(
    store: GlobalDataStore,
    command: string,
    payload: any,
): Promise<GlobalSettings> {
    switch (command) {
        case 'saveLlmEntry':
            return saveEntry(store, payload);
        case 'deleteLlmEntry':
            return deleteEntry(store, payload);
        case 'setActiveLlmEntry':
            return persist(store, setActiveEntry(loadSettings(store), String(payload?.id ?? '')));
        default:
            throw new Error(`Unknown LLM entry command: ${command}`);
    }
}
