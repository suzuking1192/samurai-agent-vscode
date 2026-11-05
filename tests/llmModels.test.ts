/**
 * Tests for LLM model helpers: there is no built-in catalog (BYOK only).
 */

import { LLM_MODELS, getAllModels, getModelsByProvider, getModelById, getAvailableProviders } from '../src/common/constants/llm-models';
import { toAvailableModels, upsertEntry, removeEntry, setActiveEntry } from '../src/common/utils/llmEntries';
import { calculateLLMCost } from '../src/common/utils/llmCostCalculator';

describe('LLM model catalog', () => {
    it('ships with no built-in models', () => {
        expect(LLM_MODELS).toEqual({});
        expect(getAllModels()).toEqual([]);
        expect(getAvailableProviders()).toEqual([]);
        expect(getModelsByProvider('openai')).toEqual([]);
        expect(getModelById('gpt-4o')).toBeUndefined();
    });

    it('charges nothing for custom models', () => {
        const cost = calculateLLMCost({ provider: 'openai', model: 'my-model', promptTokens: 1_000_000, completionTokens: 1_000_000 });
        expect(cost.totalCost).toBe(0);
    });
});

describe('llmEntries helpers', () => {
    const base: any = { llmEntries: [], activeLlmEntryId: null };
    const a = { id: 'a', provider: 'openai' as const, modelName: 'gpt-x' };
    const b = { id: 'b', provider: 'google' as const, modelName: 'gem-y', label: 'My Gemini' };

    it('maps entries to available models with zero cost', () => {
        expect(toAvailableModels([a, b])).toEqual([
            { id: 'a', name: 'gpt-x', provider: 'openai', inputCostPerMTokens: 0, outputCostPerMTokens: 0 },
            { id: 'b', name: 'My Gemini', provider: 'google', inputCostPerMTokens: 0, outputCostPerMTokens: 0 }
        ]);
        expect(toAvailableModels(undefined)).toEqual([]);
    });

    it('activates the first entry added and keeps the active one afterwards', () => {
        const withA = upsertEntry(base, a);
        expect(withA.activeLlmEntryId).toBe('a');
        expect(upsertEntry(withA, b).activeLlmEntryId).toBe('a');
    });

    it('replaces an entry with the same id', () => {
        const updated = upsertEntry(upsertEntry(base, a), { ...a, modelName: 'gpt-z' });
        expect(updated.llmEntries).toEqual([{ ...a, modelName: 'gpt-z' }]);
    });

    it('falls back to the first remaining entry when deleting the active one', () => {
        const state = setActiveEntry(upsertEntry(upsertEntry(base, a), b), 'b');
        const afterDelete = removeEntry(state, 'b');
        expect(afterDelete.activeLlmEntryId).toBe('a');
        expect(removeEntry(afterDelete, 'a').activeLlmEntryId).toBeNull();
    });

    it('rejects activating an unknown entry', () => {
        expect(() => setActiveEntry(base, 'nope')).toThrow('Model entry not found');
    });
});
