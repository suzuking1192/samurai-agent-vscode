/**
 * One-time migration of legacy plaintext provider keys (stored in global settings JSON)
 * into BYOK entries backed by SecretStorage.
 */

import { randomUUID } from 'crypto';
import { GlobalDataStore } from '../../persistence/globalDataStore';
import { GlobalSettings, LlmEntry, LlmEntryProvider } from '../models/settings-models';
import { setKey } from './llmSecretStore';

interface LegacyKeySource {
    keyField: 'openaiApiKey' | 'geminiApiKey' | 'claudeApiKey';
    provider: LlmEntryProvider;
    modelName: string;
}

/** Legacy defaults used to pre-fill entries; users can edit them in Settings. */
const LEGACY_SOURCES: LegacyKeySource[] = [
    { keyField: 'openaiApiKey', provider: 'openai', modelName: 'gpt-4o' },
    { keyField: 'geminiApiKey', provider: 'google', modelName: 'gemini-2.5-flash' },
    { keyField: 'claudeApiKey', provider: 'anthropic', modelName: 'claude-sonnet-4-20250514' },
];

async function createEntry(source: LegacyKeySource, key: string): Promise<LlmEntry> {
    const entry: LlmEntry = { id: randomUUID(), provider: source.provider, modelName: source.modelName };
    await setKey(entry.id, key);
    return entry;
}

async function buildEntries(settings: GlobalSettings): Promise<LlmEntry[]> {
    const entries: LlmEntry[] = [];
    for (const source of LEGACY_SOURCES) {
        const key = settings[source.keyField]?.trim();
        if (key) {
            entries.push(await createEntry(source, key));
        }
    }
    return entries;
}

/**
 * Moves legacy plaintext keys into SecretStorage-backed entries when no entries exist yet,
 * then clears the plaintext keys from the settings file. Returns true if a migration ran.
 */
export async function migrateLegacyKeys(globalDataStore: GlobalDataStore): Promise<boolean> {
    const settings = globalDataStore.loadGlobalSettings().payload;
    if (!settings || (settings.llmEntries?.length ?? 0) > 0) {
        return false;
    }
    const entries = await buildEntries(settings);
    if (entries.length === 0) {
        return false;
    }
    globalDataStore.saveGlobalSettings({
        ...settings,
        llmEntries: entries,
        activeLlmEntryId: entries[0].id,
    });
    return true;
}
