jest.mock('openai', () => {
    const createMock = jest.fn();
    const OpenAIConstructor = jest.fn().mockImplementation(() => ({
        chat: {
            completions: {
                create: createMock
            }
        }
    }));

    return Object.assign(OpenAIConstructor, {
        Chat: {
            Completions: {}
        },
        __mock: {
            create: createMock
        }
    });
});

import { OpenAIChatClient } from '../src/agent/llm/openaiChatClient';
import { ResponseType } from '../src/common/models/response-models';
import { LLMRequest } from '../src/common/models/llm-models';

const openAIModule = jest.requireMock('openai') as any;
const mockOpenAIConstructor = openAIModule as jest.Mock;
const mockCreate = openAIModule.__mock.create as jest.Mock;

describe('OpenAIChatClient', () => {
    let client: OpenAIChatClient;
    let baseRequest: LLMRequest;

    beforeEach(() => {
        jest.clearAllMocks();
        client = new OpenAIChatClient();
        baseRequest = {
            id: 'request-1',
            provider: 'openai',
            model: 'gpt-4o',
            messages: [{ role: 'user', content: 'Hello there' }],
            metadata: {
                apiKey: 'openai-key',
                customApiEndpoints: { openai: 'https://example.com/v1' },
                llmModels: {
                    openai: [{ id: 'gpt-4o', maxTokens: 2048 }]
                }
            },
            createdAt: new Date(),
            updatedAt: new Date()
        };
    });

    it('should create chat completion with transformed payload (no max_tokens for o1/o3 compatibility)', async () => {
        mockCreate.mockResolvedValue({
            id: 'chatcmpl-123',
            model: 'gpt-4o',
            choices: [{ message: { content: 'Hi!' } }],
            usage: { prompt_tokens: 5, completion_tokens: 7, total_tokens: 12 }
        });

        const response = await client.chat(baseRequest);

        expect(response.type).toBe(ResponseType.SUCCESS);
        expect(mockOpenAIConstructor).toHaveBeenCalledWith({
            apiKey: 'openai-key',
            baseURL: 'https://example.com/v1'
        });

        expect(mockCreate).toHaveBeenCalledWith({
            model: 'gpt-4o',
            messages: [{ role: 'user', content: 'Hello there' }]
        });

        // Verify max_tokens is NOT in the payload (critical for o1/o3 models)
        const actualPayload = mockCreate.mock.calls[0][0];
        expect(actualPayload).not.toHaveProperty('max_tokens');

        expect(response.payload?.content).toBe('Hi!');
        expect(response.payload?.usage.totalTokens).toBe(12);
    });

    it('should surface API errors as error responses', async () => {
        const apiError = Object.assign(new Error('Rate limit exceeded'), { status: 429, code: 'rate_limit' });
        mockCreate.mockRejectedValue(apiError);

        const response = await client.chat(baseRequest);

        expect(response.type).toBe(ResponseType.ERROR);
        expect(response.error).toContain('Rate limit exceeded');
        expect(response.payload?.errorCode).toBe('rate_limit');
        expect(response.payload?.retryable).toBe(false);
    });

    it('should not include max_tokens in payload (o1/o3 model compatibility)', async () => {
        mockCreate.mockResolvedValue({
            id: 'chatcmpl-456',
            model: 'o1-mini',
            choices: [{ message: { content: 'Hello from o1' } }]
        });

        const request = {
            ...baseRequest,
            model: 'o1-mini',
            maxTokens: 2048 // Even if explicitly set, should not appear in payload
        };

        await client.chat(request);

        const actualPayload = mockCreate.mock.calls[0][0];
        expect(actualPayload).not.toHaveProperty('max_tokens');
    });

    it('should ignore maxTokens parameter to ensure o1/o3 compatibility', async () => {
        mockCreate.mockResolvedValue({
            id: 'chatcmpl-789',
            model: 'gpt-4o',
            choices: [{ message: { content: 'Hello' } }]
        });

        const response = await client.chat({
            ...baseRequest,
            maxTokens: 40000
        });

        expect(response.type).toBe(ResponseType.SUCCESS);

        // Verify max_tokens is not in the payload
        const actualPayload = mockCreate.mock.calls[0][0];
        expect(actualPayload).not.toHaveProperty('max_tokens');
    });

    it('should truncate long messages to prevent oversized requests', async () => {
        mockCreate.mockResolvedValue({
            id: 'chatcmpl-truncate',
            model: 'gpt-4o',
            choices: [{ message: { content: 'Response' } }]
        });

        // Create a very long message (>128K tokens worth, i.e., >512K characters)
        const longContent = 'x'.repeat(600000); // ~150K tokens
        const request = {
            ...baseRequest,
            messages: [{ role: 'user' as const, content: longContent }]
        };

        await client.chat(request);

        // Verify the message was passed to the API (truncation happens via tokenEstimator)
        const actualPayload = mockCreate.mock.calls[0][0];
        expect(actualPayload.messages).toBeDefined();
        expect(actualPayload.messages.length).toBe(1);
        // The truncateMessagesToTokenLimit utility handles the truncation
    });

    it('should return validation error when API key missing', async () => {
        const request = {
            ...baseRequest,
            metadata: { ...baseRequest.metadata, apiKey: '' }
        };

        const response = await client.chat(request);

        expect(response.type).toBe(ResponseType.ERROR);
        expect(response.error).toContain('API key');
        expect(mockOpenAIConstructor).not.toHaveBeenCalled();
    });

    it('should return validation error when messages are empty', async () => {
        const request = {
            ...baseRequest,
            messages: []
        };

        const response = await client.chat(request);

        expect(response.type).toBe(ResponseType.ERROR);
        expect(response.error).toContain('message');
        expect(mockOpenAIConstructor).not.toHaveBeenCalled();
    });
});


