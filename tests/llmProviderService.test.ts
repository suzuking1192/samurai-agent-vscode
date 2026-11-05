import { LLMProviderService, ChatClient, MISSING_MODEL_MESSAGE } from '../src/agent/llm/llmProviderService';
import { GlobalDataStore } from '../src/persistence/globalDataStore';
import { ApiResponse, ResponseType } from '../src/common/models/response-models';
import { LLMRequest, LLMResponse } from '../src/common/models/llm-models';
import { LlmEntry } from '../src/common/models/settings-models';
import { setSecretStorageContext, setKey } from '../src/common/utils/llmSecretStore';

class MockGlobalDataStore extends GlobalDataStore {
    constructor(private readonly settings: any) {
        super();
    }

    public loadGlobalSettings(): ApiResponse {
        return { type: ResponseType.SUCCESS, payload: this.settings, timestamp: new Date() } as ApiResponse;
    }
}

class MockChatClient implements ChatClient {
    public lastRequest: LLMRequest | undefined;
    public calls = 0;

    constructor(private readonly content: string = 'mock-response') {}

    async chat(request: LLMRequest): Promise<ApiResponse<LLMResponse>> {
        this.lastRequest = request;
        this.calls++;
        const timestamp = new Date();
        return {
            type: ResponseType.SUCCESS,
            payload: {
                id: 'response-id',
                requestId: request.id,
                provider: request.provider,
                model: request.model,
                content: this.content,
                usage: { promptTokens: 1000, completionTokens: 1000, totalTokens: 2000 },
                cost: 0,
                processingTime: 0,
                metadata: {},
                createdAt: timestamp,
                updatedAt: timestamp
            },
            timestamp
        } as ApiResponse<LLMResponse>;
    }
}

function installFakeSecrets(): Map<string, string> {
    const store = new Map<string, string>();
    setSecretStorageContext({
        secrets: {
            get: async (key: string) => store.get(key),
            store: async (key: string, value: string) => { store.set(key, value); },
            delete: async (key: string) => { store.delete(key); }
        }
    } as any);
    return store;
}

function makeSettings(llmEntries: LlmEntry[], activeLlmEntryId: string | null): any {
    return {
        id: 'global-settings',
        userId: 'test-user',
        openaiApiKey: '',
        geminiApiKey: '',
        claudeApiKey: '',
        llmEntries,
        activeLlmEntryId,
        defaultProvider: 'openai',
        defaultModel: '',
        defaultMode: 'default',
        customApiEndpoints: {},
        metadata: {}
    };
}

function makeRequest(overrides: Partial<LLMRequest> = {}): LLMRequest {
    return {
        id: 'request-1',
        provider: 'auto',
        model: '',
        messages: [{ role: 'user', content: 'hello' } as any],
        metadata: {},
        createdAt: new Date(),
        updatedAt: new Date(),
        ...overrides
    } as LLMRequest;
}

describe('LLMProviderService (BYOK)', () => {
    const openaiEntry: LlmEntry = { id: 'e-openai', provider: 'openai', modelName: 'my-gpt' };
    const googleEntry: LlmEntry = { id: 'e-google', provider: 'google', modelName: 'my-gemini' };
    const anthropicEntry: LlmEntry = { id: 'e-claude', provider: 'anthropic', modelName: 'my-claude' };
    const entries = [openaiEntry, googleEntry, anthropicEntry];

    let secrets: Map<string, string>;
    let clients: Record<string, MockChatClient>;

    function createService(settings: any): LLMProviderService {
        const service = new LLMProviderService(new MockGlobalDataStore(settings));
        Object.entries(clients).forEach(([provider, client]) => service.registerClient(provider, client));
        return service;
    }

    beforeEach(() => {
        secrets = installFakeSecrets();
        clients = { openai: new MockChatClient(), google: new MockChatClient(), anthropic: new MockChatClient() };
    });

    it('refuses to call the LLM when there are no entries', async () => {
        const response = await createService(makeSettings([], null)).chat(makeRequest());

        expect(response.type).toBe(ResponseType.ERROR);
        expect(response.error).toBe(MISSING_MODEL_MESSAGE);
        expect(clients.openai.calls + clients.google.calls + clients.anthropic.calls).toBe(0);
    });

    it('refuses to call the LLM when no entry is active', async () => {
        await setKey(openaiEntry.id, 'sk-test');
        const response = await createService(makeSettings(entries, null)).chat(makeRequest());

        expect(response.type).toBe(ResponseType.ERROR);
        expect(response.error).toBe(MISSING_MODEL_MESSAGE);
    });

    it('refuses to call the LLM when the active entry has no stored key', async () => {
        const response = await createService(makeSettings(entries, openaiEntry.id)).chat(makeRequest());

        expect(response.type).toBe(ResponseType.ERROR);
        expect(response.error).toBe(MISSING_MODEL_MESSAGE);
        expect(clients.openai.calls).toBe(0);
    });

    it.each([
        ['openai', openaiEntry],
        ['google', googleEntry],
        ['anthropic', anthropicEntry]
    ])('routes the active %s entry to its client with modelName and SecretStorage key', async (provider, entry) => {
        await setKey(entry.id, `key-for-${provider}`);
        const response = await createService(makeSettings(entries, entry.id)).chat(makeRequest());

        expect(response.type).toBe(ResponseType.SUCCESS);
        const sent = clients[provider].lastRequest!;
        expect(sent.model).toBe(entry.modelName);
        expect(sent.provider).toBe(provider);
        expect(sent.metadata?.apiKey).toBe(`key-for-${provider}`);
    });

    it('uses the entry whose id matches request.model over the active entry', async () => {
        await setKey(openaiEntry.id, 'k1');
        await setKey(googleEntry.id, 'k2');
        await createService(makeSettings(entries, openaiEntry.id)).chat(makeRequest({ model: googleEntry.id }));

        expect(clients.google.lastRequest?.model).toBe(googleEntry.modelName);
        expect(clients.openai.calls).toBe(0);
    });

    it('falls back to the active entry when request.model matches no entry', async () => {
        await setKey(openaiEntry.id, 'k1');
        await createService(makeSettings(entries, openaiEntry.id)).chat(makeRequest({ model: 'gpt-4o' }));

        expect(clients.openai.lastRequest?.model).toBe(openaiEntry.modelName);
    });

    it('reports a missing client for the entry provider', async () => {
        await setKey(openaiEntry.id, 'k1');
        const service = new LLMProviderService(new MockGlobalDataStore(makeSettings(entries, openaiEntry.id)));
        const response = await service.chat(makeRequest());

        expect(response.type).toBe(ResponseType.ERROR);
        expect(response.error).toContain('No client registered');
    });

    it('does not persist or require keys in settings JSON', async () => {
        await setKey(openaiEntry.id, 'sk-secret');
        const settings = makeSettings(entries, openaiEntry.id);
        await createService(settings).chat(makeRequest());

        expect(JSON.stringify(settings)).not.toContain('sk-secret');
        expect(secrets.get('samurai-agent.llm-key.e-openai')).toBe('sk-secret');
    });

    it('reports zero cost for custom models', async () => {
        await setKey(openaiEntry.id, 'k1');
        const response = await createService(makeSettings(entries, openaiEntry.id)).chat(makeRequest());

        expect((response.payload as LLMResponse).cost).toBe(0);
    });

    it('returns an error when the client returns empty content twice', async () => {
        clients.openai = new MockChatClient('   ');
        await setKey(openaiEntry.id, 'k1');
        const response = await createService(makeSettings(entries, openaiEntry.id)).chat(makeRequest());

        expect(response.type).toBe(ResponseType.ERROR);
        expect(clients.openai.calls).toBe(2);
    });
});
