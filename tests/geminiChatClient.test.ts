jest.mock('@google/genai', () => {
    const generateContentMock = jest.fn();

    const GoogleGenAIMock = jest.fn().mockImplementation((options?: { apiKey?: string; baseUrl?: string }) => {
        return {
            models: {
                generateContent: generateContentMock
            },
            __options: options
        };
    });

    return {
        GoogleGenAI: GoogleGenAIMock,
        __mock: {
            generateContent: generateContentMock
        }
    };
});

import { GeminiChatClient } from '../src/agent/llm/geminiChatClient';
import { ResponseType } from '../src/common/models/response-models';
import { LLMRequest } from '../src/common/models/llm-models';

const genAIModule = jest.requireMock('@google/genai');
const GoogleGenAIConstructor = genAIModule.GoogleGenAI as jest.Mock;
const generateContentMock = genAIModule.__mock.generateContent as jest.Mock;

describe('GeminiChatClient', () => {
    let client: GeminiChatClient;
    let baseRequest: LLMRequest;

    beforeEach(() => {
        jest.clearAllMocks();
        client = new GeminiChatClient();
        baseRequest = {
            id: 'request-1',
            provider: 'google',
            model: 'gemini-2.5-flash',
            maxTokens: 1024,
            messages: [
                { role: 'system', content: 'You are friendly' },
                { role: 'user', content: 'Hello Gemini!' }
            ],
            metadata: {
                apiKey: 'gemini-key',
                customApiEndpoints: { google: 'https://generativelanguage.googleapis.com/v1beta' }
            },
            createdAt: new Date(),
            updatedAt: new Date()
        };
    });

    it('should call Gemini API with transformed message payload', async () => {
        generateContentMock.mockResolvedValue({
            text: 'Hallå!',
            usageMetadata: {
                promptTokenCount: 10,
                candidatesTokenCount: 5,
                totalTokenCount: 15
            }
        });

        const result = await client.chat(baseRequest);

        expect(result.type).toBe(ResponseType.SUCCESS);
        expect(GoogleGenAIConstructor).toHaveBeenCalledWith({ 
            apiKey: 'gemini-key', 
            baseUrl: 'https://generativelanguage.googleapis.com/v1beta' 
        });

        expect(generateContentMock).toHaveBeenCalledWith({
            model: 'gemini-2.5-flash',
            contents: [
                { role: 'user', parts: [{ text: 'Hello Gemini!' }] }
            ],
            config: expect.objectContaining({ 
                maxOutputTokens: 1024,
                systemInstruction: 'You are friendly'
            })
        });

        expect(result.payload?.content).toBe('Hallå!');
        expect(result.payload?.usage.totalTokens).toBe(15);
    });

    it('should fall back to candidate text when .text() throws', async () => {
        generateContentMock.mockResolvedValue({
            text: '',
            candidates: [
                {
                    content: {
                        parts: [{ text: 'Partial result' }]
                    }
                }
            ],
            usageMetadata: {
                promptTokenCount: 5,
                candidatesTokenCount: 3,
                totalTokenCount: 8
            }
        });

        const result = await client.chat(baseRequest);

        expect(result.type).toBe(ResponseType.SUCCESS);
        expect(result.payload?.content).toBe('Partial result');
    });

    it('should fall back to candidate text when .text() returns empty', async () => {
        generateContentMock.mockResolvedValue({
            text: '',
            candidates: [
                {
                    content: {
                        parts: [{ text: 'From candidate part' }]
                    }
                }
            ],
            usageMetadata: {
                promptTokenCount: 5,
                candidatesTokenCount: 3,
                totalTokenCount: 8
            }
        });

        const result = await client.chat(baseRequest);

        expect(result.type).toBe(ResponseType.SUCCESS);
        expect(result.payload?.content).toBe('From candidate part');
    });

    it('should return promptFeedback diagnostic when no text and no parts', async () => {
        generateContentMock.mockResolvedValue({
            text: '',
            candidates: [],
            promptFeedback: {
                blockReason: 'SAFETY',
                safetyRatings: [
                    { category: 'HARM_CATEGORY_DANGEROUS_CONTENT', blocked: true, probability: 'HIGH' }
                ]
            },
            usageMetadata: {
                promptTokenCount: 5,
                candidatesTokenCount: 0,
                totalTokenCount: 5
            }
        });

        const result = await client.chat(baseRequest);

        expect(result.type).toBe(ResponseType.SUCCESS);
        expect(result.payload?.content).toMatch(/^\[GEMINI_PROMPT_FEEDBACK]/);
        expect(result.payload?.content).toContain('SAFETY');
    });

    it('should surface API errors as error responses', async () => {
        const apiError = Object.assign(new Error('Network error'), { status: 500 });
        generateContentMock.mockRejectedValue(apiError);

        const result = await client.chat(baseRequest);

        expect(result.type).toBe(ResponseType.ERROR);
        expect(result.error).toContain('Network error');
        expect(result.payload?.errorCode).toBe('http_500');
        expect(result.payload?.retryable).toBe(true);
    });

    it('should return validation error when API key missing', async () => {
        const result = await client.chat({
            ...baseRequest,
            metadata: { ...baseRequest.metadata, apiKey: '' }
        });

        expect(result.type).toBe(ResponseType.ERROR);
        expect(result.error).toContain('API key');
        expect(GoogleGenAIConstructor).not.toHaveBeenCalled();
    });

    it('should return validation error when messages are empty', async () => {
        const result = await client.chat({
            ...baseRequest,
            messages: []
        });

        expect(result.type).toBe(ResponseType.ERROR);
        expect(result.error).toContain('message');
    });

    it('should pass the user-provided model name through unchanged', async () => {
        generateContentMock.mockResolvedValue({
            text: 'Free tier response',
            usageMetadata: {
                promptTokenCount: 10,
                candidatesTokenCount: 5,
                totalTokenCount: 15
            }
        });

        const customModelRequest = {
            ...baseRequest,
            model: 'gemini-2.5-flash'
        };

        const result = await client.chat(customModelRequest);

        expect(result.type).toBe(ResponseType.SUCCESS);
        
        // Verify that the API was called with the exact model name
        expect(generateContentMock).toHaveBeenCalledWith(
            expect.objectContaining({
                model: 'gemini-2.5-flash'
            })
        );

        expect(result.payload?.content).toBe('Free tier response');
    });

    it('should detect rate limit errors correctly', async () => {
        const quotaError = Object.assign(new Error('Quota exceeded'), { status: 429 });
        generateContentMock.mockRejectedValue(quotaError);

        const result = await client.chat(baseRequest);

        expect(result.type).toBe(ResponseType.ERROR);
        expect(result.payload?.errorCode).toBe('RATE_LIMIT_EXCEEDED');
    });

    it('should detect rate limit from error message patterns', async () => {
        const resourceExhaustedError = new Error('resource_exhausted: Quota exceeded for requests');
        generateContentMock.mockRejectedValue(resourceExhaustedError);

        const result = await client.chat(baseRequest);

        expect(result.type).toBe(ResponseType.ERROR);
        expect(result.payload?.errorCode).toBe('RATE_LIMIT_EXCEEDED');
    });

    it('should retry on empty response and succeed on retry', async () => {
        // Mock: first call returns empty, second succeeds
        generateContentMock
            .mockResolvedValueOnce({
                text: '',
                candidates: [],
                usageMetadata: {
                    promptTokenCount: 5,
                    candidatesTokenCount: 0,
                    totalTokenCount: 5
                }
            })
            .mockResolvedValueOnce({
                text: 'Success after retry',
                usageMetadata: {
                    promptTokenCount: 10,
                    candidatesTokenCount: 8,
                    totalTokenCount: 18
                }
            });

        const result = await client.chat(baseRequest);

        expect(generateContentMock).toHaveBeenCalledTimes(2);
        expect(result.type).toBe(ResponseType.SUCCESS);
        expect(result.payload?.content).toBe('Success after retry');
    });

    it('should return error after max retries with empty responses', async () => {
        // Mock: all 3 attempts return empty (maxRetries = 2, so 3 total attempts)
        generateContentMock.mockResolvedValue({
            text: '',
            candidates: [],
            usageMetadata: {
                promptTokenCount: 5,
                candidatesTokenCount: 0,
                totalTokenCount: 5
            }
        });

        const result = await client.chat(baseRequest);

        expect(generateContentMock).toHaveBeenCalledTimes(3); // maxRetries + 1
        expect(result.type).toBe(ResponseType.ERROR);
        expect(result.error).toContain('Empty response');
    });

    it('should mark empty response errors as retryable', async () => {
        // Mock: all attempts return empty
        generateContentMock.mockResolvedValue({
            text: '',
            candidates: [],
            usageMetadata: {
                promptTokenCount: 5,
                candidatesTokenCount: 0,
                totalTokenCount: 5
            }
        });

        const result = await client.chat(baseRequest);

        expect(result.type).toBe(ResponseType.ERROR);
        expect(result.payload?.retryable).toBe(true);
        expect(result.error).toContain('Empty response');
    });

    it('should not retry when elapsed time exceeds retry time budget (empty response)', async () => {
        jest.useFakeTimers();
        const clientWithShortBudget = new GeminiChatClient({ maxRetryTimeBudgetMs: 5000 });

        const emptyResponse = {
            text: '',
            candidates: [],
            usageMetadata: {
                promptTokenCount: 5,
                candidatesTokenCount: 0,
                totalTokenCount: 5
            }
        };

        generateContentMock.mockImplementation(() =>
            new Promise<typeof emptyResponse>((resolve) => {
                setTimeout(() => resolve(emptyResponse), 6000);
            })
        );

        const chatPromise = clientWithShortBudget.chat(baseRequest);
        await jest.advanceTimersByTimeAsync(6000);
        const result = await chatPromise;

        expect(generateContentMock).toHaveBeenCalledTimes(1);
        expect(result.type).toBe(ResponseType.ERROR);
        expect(result.error).toContain('Empty response');

        jest.useRealTimers();
    });
});


