jest.mock('@anthropic-ai/sdk', () => {
    const createMock = jest.fn();
    const streamMock = jest.fn();
    const messages = {
        create: createMock,
        stream: streamMock
    };

    const AnthropicConstructor = jest.fn().mockImplementation((_options: { apiKey: string; baseURL?: string }) => ({
        messages
    }));

    return Object.assign(AnthropicConstructor, {
        __mock: {
            create: createMock,
            stream: streamMock
        }
    });
});

import { AnthropicChatClient } from '../src/agent/llm/anthropicChatClient';
import { ResponseType } from '../src/common/models/response-models';
import { LLMRequest } from '../src/common/models/llm-models';

const anthropicModule = jest.requireMock('@anthropic-ai/sdk');
const AnthropicConstructor = anthropicModule as jest.Mock;
const createMock = anthropicModule.__mock.create as jest.Mock;
const streamMock = anthropicModule.__mock.stream as jest.Mock;

describe('AnthropicChatClient', () => {
    let client: AnthropicChatClient;
    let baseRequest: LLMRequest;

    beforeEach(() => {
        jest.clearAllMocks();
        client = new AnthropicChatClient();
        baseRequest = {
            id: 'request-1',
            provider: 'anthropic',
            model: 'claude-3-5-haiku-20241022',
            messages: [
                { role: 'system', content: 'You are concise.' },
                { role: 'user', content: 'Summarize this conversation.' },
                { role: 'assistant', content: 'Summary: ...' }
            ],
            metadata: {
                apiKey: 'anthropic-key',
                customApiEndpoints: { anthropic: 'https://api.anthropic.com' },
                llmModels: {
                    anthropic: [{ id: 'claude-3-5-haiku-20241022', maxTokens: 4096 }]
                }
            },
            createdAt: new Date(),
            updatedAt: new Date()
        };
    });

    it('should call Anthropic API with transformed payload', async () => {
        const mockMessage = {
            id: 'msg-123',
            model: 'claude-3-5-haiku-20241022',
            content: [{ type: 'text', text: 'Here is the summary.' }],
            usage: { input_tokens: 100, output_tokens: 50 }
        };
        streamMock.mockReturnValue({ finalMessage: () => Promise.resolve(mockMessage) });

        const response = await client.chat(baseRequest);

        expect(response.type).toBe(ResponseType.SUCCESS);
        expect(streamMock).toHaveBeenCalledWith({
            model: 'claude-3-5-haiku-20241022',
            temperature: undefined,
            max_tokens: 4096,
            system: 'You are concise.',
            messages: [
                { role: 'user', content: [{ type: 'text', text: 'Summarize this conversation.' }] },
                { role: 'assistant', content: [{ type: 'text', text: 'Summary: ...' }] }
            ]
        });
        expect(createMock).not.toHaveBeenCalled();
        expect(response.payload?.content).toBe('Here is the summary.');
        expect(response.payload?.usage.totalTokens).toBe(150);
    });

    it('should send system in top-level param and messages alternate user/assistant', async () => {
        streamMock.mockReturnValue({
            finalMessage: () =>
                Promise.resolve({
                    id: 'msg-456',
                    model: 'claude-3-5-haiku-20241022',
                    content: [{ type: 'text', text: 'Hello.' }],
                    usage: { input_tokens: 10, output_tokens: 5 }
                })
        });

        const response = await client.chat({
            ...baseRequest,
            messages: [
                { role: 'system', content: 'You are helpful.' },
                { role: 'user', content: 'Hi.' }
            ]
        });

        expect(response.type).toBe(ResponseType.SUCCESS);
        expect(streamMock).toHaveBeenCalledWith(
            expect.objectContaining({
                system: 'You are helpful.',
                messages: [{ role: 'user', content: [{ type: 'text', text: 'Hi.' }] }]
            })
        );
        expect(createMock).not.toHaveBeenCalled();
    });

    it('should not include system key when no system message', async () => {
        streamMock.mockReturnValue({
            finalMessage: () =>
                Promise.resolve({
                    id: 'msg-789',
                    model: 'claude-3-5-haiku-20241022',
                    content: [{ type: 'text', text: 'Reply.' }],
                    usage: { input_tokens: 5, output_tokens: 3 }
                })
        });

        const response = await client.chat({
            ...baseRequest,
            messages: [
                { role: 'user', content: 'Hello.' },
                { role: 'assistant', content: 'Hi there.' },
                { role: 'user', content: 'Bye.' }
            ]
        });

        expect(response.type).toBe(ResponseType.SUCCESS);
        const payload = streamMock.mock.calls[0][0];
        expect(payload).not.toHaveProperty('system');
        expect(payload.messages).toHaveLength(3);
        expect(payload.messages[0].role).toBe('user');
        expect(payload.messages[1].role).toBe('assistant');
        expect(payload.messages[2].role).toBe('user');
        expect(createMock).not.toHaveBeenCalled();
    });

    it('should join multiple system messages and send in top-level param', async () => {
        streamMock.mockReturnValue({
            finalMessage: () =>
                Promise.resolve({
                    id: 'msg-multi',
                    model: 'claude-3-5-haiku-20241022',
                    content: [{ type: 'text', text: 'OK.' }],
                    usage: { input_tokens: 20, output_tokens: 2 }
                })
        });

        const response = await client.chat({
            ...baseRequest,
            messages: [
                { role: 'system', content: 'First.' },
                { role: 'system', content: 'Second.' },
                { role: 'user', content: 'Go.' }
            ]
        });

        expect(response.type).toBe(ResponseType.SUCCESS);
        expect(streamMock).toHaveBeenCalledWith(
            expect.objectContaining({
                system: 'First.\n\nSecond.',
                messages: [{ role: 'user', content: [{ type: 'text', text: 'Go.' }] }]
            })
        );
        expect(createMock).not.toHaveBeenCalled();
    });

    it('should return validation error when only system messages', async () => {
        const response = await client.chat({
            ...baseRequest,
            messages: [{ role: 'system', content: 'You are a bot.' }]
        });

        expect(response.type).toBe(ResponseType.ERROR);
        expect(response.error).toContain('user or assistant');
        expect(streamMock).not.toHaveBeenCalled();
        expect(createMock).not.toHaveBeenCalled();
    });

    it('should surface API errors as error responses', async () => {
        const apiError = Object.assign(new Error('Anthropic rate limit'), { status: 429, code: '429' });
        streamMock.mockReturnValue({ finalMessage: () => Promise.reject(apiError) });

        const response = await client.chat(baseRequest);

        expect(response.type).toBe(ResponseType.ERROR);
        expect(response.error).toContain('Anthropic rate limit');
        expect(response.payload?.errorCode).toBe('http_429');
        expect(response.payload?.retryable).toBe(false);
        expect(streamMock).toHaveBeenCalled();
    });

    it('should return validation error when API key missing', async () => {
        const response = await client.chat({
            ...baseRequest,
            metadata: { ...baseRequest.metadata, apiKey: '' }
        });

        expect(response.type).toBe(ResponseType.ERROR);
        expect(response.error).toContain('API key');
        expect(AnthropicConstructor).not.toHaveBeenCalled();
    });

    it('should return validation error when messages are empty', async () => {
        const response = await client.chat({
            ...baseRequest,
            messages: []
        });

        expect(response.type).toBe(ResponseType.ERROR);
        expect(response.error).toContain('message');
        expect(streamMock).not.toHaveBeenCalled();
    });

    it('should use messages.stream and not messages.create on success path', async () => {
        streamMock.mockReturnValue({
            finalMessage: () =>
                Promise.resolve({
                    id: 'msg-stream',
                    model: 'claude-3-5-haiku-20241022',
                    content: [{ type: 'text', text: 'Streamed.' }],
                    usage: { input_tokens: 1, output_tokens: 1 }
                })
        });

        await client.chat(baseRequest);

        expect(streamMock).toHaveBeenCalledWith(
            expect.objectContaining({
                model: 'claude-3-5-haiku-20241022',
                max_tokens: 4096,
                messages: expect.any(Array)
            })
        );
        expect(createMock).not.toHaveBeenCalled();
    });

    it('should return same response shape when stream succeeds', async () => {
        const mockMessage = {
            id: 'msg-shape',
            model: 'claude-3-5-haiku-20241022',
            content: [{ type: 'text', text: 'Full text content.' }],
            usage: { input_tokens: 200, output_tokens: 75 }
        };
        streamMock.mockReturnValue({ finalMessage: () => Promise.resolve(mockMessage) });

        const response = await client.chat(baseRequest);

        expect(response.type).toBe(ResponseType.SUCCESS);
        expect(response.payload?.content).toBe('Full text content.');
        expect(response.payload?.usage.promptTokens).toBe(200);
        expect(response.payload?.usage.completionTokens).toBe(75);
        expect(response.payload?.usage.totalTokens).toBe(275);
    });

    it('should return error response when finalMessage rejects without throwing', async () => {
        streamMock.mockReturnValue({
            finalMessage: () => Promise.reject(new Error('Network error'))
        });

        const response = await client.chat(baseRequest);

        expect(response.type).toBe(ResponseType.ERROR);
        expect(response.error).toContain('Network error');
        expect(response.payload?.error).toContain('Network error');
    });

    it('should cap max_tokens to model API limit for claude-opus-4-1', async () => {
        streamMock.mockReturnValue({
            finalMessage: () =>
                Promise.resolve({
                    id: 'msg-capped',
                    model: 'claude-opus-4-1-20250805',
                    content: [{ type: 'text', text: 'Response.' }],
                    usage: { input_tokens: 1, output_tokens: 1 }
                })
        });

        await client.chat({
            ...baseRequest,
            model: 'claude-opus-4-1-20250805',
            maxTokens: 40000
        });

        expect(streamMock).toHaveBeenCalledWith(
            expect.objectContaining({
                model: 'claude-opus-4-1-20250805',
                max_tokens: 32000
            })
        );
    });
});
