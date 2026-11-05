import { URL } from 'url';
import { LLMRequest, LLMResponse, LLMError, LLMMessage } from '../../common/models/llm-models';
import { ApiResponse, ResponseType } from '../../common/models/response-models';
import type { ChatClient } from './llmProviderService';

// Use require for ESM module compatibility with webpack
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { GoogleGenAI } = require('@google/genai');

type CustomApiEndpoints = Record<string, string> | undefined;

type Content = {
    role: 'user' | 'model';
    parts: Array<{ text: string }>;
};

export interface GeminiChatClientOptions {
    /** Max total time (ms) for chat including first attempt and retries. Default 60000. */
    maxRetryTimeBudgetMs?: number;
}

export class GeminiChatClient implements ChatClient {
    private readonly maxRetries = 2; // 3 total attempts
    private readonly baseDelayMs = 1000; // 1 second base delay
    private readonly maxRetryTimeBudgetMs: number;

    constructor(options?: GeminiChatClientOptions) {
        this.maxRetryTimeBudgetMs = options?.maxRetryTimeBudgetMs ?? 60000; // 60s max total time for chat (including first attempt and retries)
    }

    public async chat(request: LLMRequest): Promise<ApiResponse<LLMResponse | LLMError>> {
        const validationError = this.validate(request);
        if (validationError) {
            return validationError;
        }

        const startTime = Date.now();
        let lastError: unknown = null;
        let retryCount = 0;
        let errorClass: string = 'unknown';

        // Attempt request with retry logic
        for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
            try {
                const genAI = this.createClient(request);
                const { contents, systemInstruction } = this.transformMessages(request.messages);
                const config = this.buildConfig(request, systemInstruction);
                
                const requestParams: any = {
                    model: request.model,
                    contents
                };
                
                if (Object.keys(config).length > 0) {
                    requestParams.config = config;
                }
                
                const response = await genAI.models.generateContent(requestParams);
                
                // Check for empty content before building success response
                const generatedText = this.extractText(response) ?? '';
                if (!generatedText || generatedText.trim() === '') {
                    console.error('[GeminiChatClient] Empty content returned from Gemini API');
                    throw new Error('Empty response from Gemini API');
                }
                
                // Log successful request with retry info
                const totalLatency = Date.now() - startTime;
                if (retryCount > 0) {
                    console.log(`[GeminiChatClient] Request completed after ${retryCount} retries:`, {
                        requestId: request.id,
                        retries: retryCount,
                        totalLatency
                    });
                }
                
                return this.buildSuccessResponse(request, response);
            } catch (error) {
                lastError = error;
                errorClass = this.classifyError(error);

                // Check if this is a retryable error and we haven't exceeded max retries
                const isRetryable = this.isRetryable(error);
                const elapsedTime = Date.now() - startTime;
                const hasTimeBudget = elapsedTime < this.maxRetryTimeBudgetMs;

                if (attempt < this.maxRetries && isRetryable && hasTimeBudget) {
                    // Calculate exponential backoff with jitter
                    const baseDelay = this.baseDelayMs * Math.pow(2, attempt);
                    const jitter = 0.7 + Math.random() * 0.6; // 70-130% of base delay
                    const delay = Math.round(baseDelay * jitter);
                    
                    retryCount++;
                    console.log(`[GeminiChatClient] Attempt ${attempt + 1} failed (${errorClass}), retrying in ${delay}ms:`, 
                        error instanceof Error ? error.message : String(error));
                    
                    // Check for abort signal before waiting
                    // Note: AbortSignal support would require request.metadata to include signal
                    // For now, we'll check if error is an abort error
                    if (this.isAbortError(error)) {
                        console.log('[GeminiChatClient] Request aborted, stopping retries');
                        break;
                    }
                    
                    await this.sleep(delay);
                    continue;
                }
                
                // Not retryable or max retries reached
                break;
            }
        }
        
        // All retries failed or error is not retryable
        const totalLatency = Date.now() - startTime;
        console.log(`[GeminiChatClient] Request failed after ${retryCount} retries:`, {
            requestId: request.id,
            retries: retryCount,
            errorClass,
            totalLatency
        });
        
        return this.buildErrorResponse(request, lastError || new Error('Unknown error'));
    }

    private sleep(ms: number): Promise<void> {
        return new Promise(resolve => setTimeout(resolve, ms));
    }

    private classifyError(error: unknown): string {
        if (this.isAbortError(error)) {
            return 'abort';
        }
        if (this.isNetworkError(error)) {
            return 'network';
        }
        if (this.isRateLimitError(error)) {
            return '429';
        }
        if (this.is5xxError(error)) {
            return '5xx';
        }
        if (this.is4xxError(error)) {
            return '4xx';
        }
        return 'unknown';
    }

    private isAbortError(error: unknown): boolean {
        if (error instanceof Error) {
            return error.name === 'AbortError' || error.message.toLowerCase().includes('abort');
        }
        return false;
    }

    private isNetworkError(error: unknown): boolean {
        if (typeof error !== 'object' || error === null) {
            return false;
        }

        // Check structured error codes
        const err = error as any;
        const networkCodes = ['ENOTFOUND', 'ECONNREFUSED', 'ETIMEDOUT', 'ECONNRESET'];
        if (err.code && networkCodes.includes(err.code)) {
            return true;
        }
        if (err.cause?.code && networkCodes.includes(err.cause.code)) {
            return true;
        }

        // Check error message for network error patterns
        const errorMessage = error instanceof Error ? error.message.toLowerCase() : String(error).toLowerCase();
        const networkPatterns = ['fetch failed', 'econnrefused', 'enotfound', 'etimedout', 'econnreset', 'network error'];
        return networkPatterns.some(pattern => errorMessage.includes(pattern));
    }

    private is5xxError(error: unknown): boolean {
        if (typeof error !== 'object' || error === null) {
            return false;
        }

        const err = error as any;
        
        // Check direct HTTP status
        if (typeof err.status === 'number' && err.status >= 500 && err.status < 600) {
            return true;
        }
        
        // Check response status
        if (typeof err.response?.status === 'number' && err.response.status >= 500) {
            return true;
        }
        
        // Check Google nested error structure
        if (typeof err.error?.code === 'number' && err.error.code >= 500) {
            return true;
        }
        
        // Check Google error status strings
        const googleErrorStatuses = ['INTERNAL', 'UNAVAILABLE', 'DEADLINE_EXCEEDED'];
        if (err.error?.status && googleErrorStatuses.includes(err.error.status)) {
            return true;
        }
        
        return false;
    }

    private is4xxError(error: unknown): boolean {
        if (typeof error !== 'object' || error === null) {
            return false;
        }

        const err = error as any;
        const clientErrorCodes = [400, 401, 403, 404];
        
        // Check direct HTTP status
        if (typeof err.status === 'number' && clientErrorCodes.includes(err.status)) {
            return true;
        }
        
        // Check Google nested error structure
        if (typeof err.error?.code === 'number' && clientErrorCodes.includes(err.error.code)) {
            return true;
        }
        
        return false;
    }

    private validate(request: LLMRequest): ApiResponse<LLMError> | undefined {
        const messagesValid = Array.isArray(request.messages) && request.messages.length > 0;
        if (!messagesValid) {
            return this.buildErrorResponse(request, new Error('At least one message is required for Gemini chat.'));
        }

        const apiKey = this.getApiKey(request);
        if (!apiKey) {
            return this.buildErrorResponse(request, new Error('Gemini API key is missing.'));
        }

        if (!request.model) {
            return this.buildErrorResponse(request, new Error('Gemini model is required.'));
        }

        return undefined;
    }

    private createClient(request: LLMRequest): any {
        const apiKey = this.getApiKey(request) as string;
        const clientOptions = this.buildClientOptions(request);
        return new GoogleGenAI({ 
            apiKey,
            ...(clientOptions ? { baseUrl: clientOptions.baseUrl } : {})
        });
    }

    private buildClientOptions(request: LLMRequest): { baseUrl: string } | undefined {
        const baseUrl = this.getBaseUrl(request.metadata?.customApiEndpoints);
        return baseUrl ? { baseUrl } : undefined;
    }

    private transformMessages(messages: LLMMessage[]): { contents: Content[]; systemInstruction?: string } {
        const contents: Content[] = [];
        const systemMessages: string[] = [];

        for (const message of messages) {
            switch (message.role) {
                case 'system':
                    // Collect system messages for systemInstruction
                    systemMessages.push(message.content ?? '');
                    break;
                case 'user':
                    contents.push({
                        role: 'user',
                        parts: [{ text: message.content ?? '' }]
                    });
                    break;
                case 'assistant':
                    contents.push({
                        role: 'model',
                        parts: [{ text: message.content ?? '' }]
                    });
                    break;
            }
        }

        // Combine system messages
        const systemInstruction = systemMessages.length > 0 
            ? systemMessages.join('\n\n') 
            : undefined;

        // Ensure we have at least one content entry
        if (contents.length === 0) {
            contents.push({ role: 'user', parts: [{ text: '' }] });
        }

        return { contents, systemInstruction };
    }

    private buildConfig(request: LLMRequest, systemInstruction?: string): any {
        const maxOutputTokens = this.resolveMaxTokens(request);
        console.log('[GEMINI BUILD GENERATION CONFIG DEBUG] GeminiChatClient - maxOutputTokens:', maxOutputTokens);
        
        const config: any = {};
        
        if (request.temperature !== undefined) {
            config.temperature = request.temperature;
        }
        if (maxOutputTokens !== undefined) {
            config.maxOutputTokens = maxOutputTokens;
        }
        if (request.topP !== undefined) {
            config.topP = request.topP;
        }
        if (systemInstruction) {
            config.systemInstruction = systemInstruction;
        }
        
        return config;
    }

    private buildSuccessResponse(request: LLMRequest, response: any): ApiResponse<LLMResponse> {
        console.log("=== GEMINI BUILD SUCCESS RESPONSE DEBUG START ===");
        console.log("Request details:", {
            requestId: request.id,
            provider: request.provider,
            model: request.model
        });

        const generatedText = this.extractText(response) ?? '';
        const usage = response.usageMetadata;

        console.log("Response processing:", {
            generatedTextType: typeof generatedText,
            generatedTextLength: generatedText?.length || 0,
            generatedTextPreview: generatedText?.substring(0, 100) + (generatedText && generatedText.length > 100 ? '...' : ''),
            hasUsage: !!usage,
            usage: usage
        });

        const payload: LLMResponse = {
            id: `gemini-${Date.now()}`,
            requestId: request.id,
            provider: request.provider,
            model: request.model,
            content: generatedText,
            usage: {
                promptTokens: usage?.promptTokenCount ?? 0,
                completionTokens: usage?.candidatesTokenCount ?? 0,
                totalTokens: usage?.totalTokenCount ?? 0
            },
            cost: 0,
            processingTime: 0,
            metadata: {
                rawResponse: response
            },
            createdAt: new Date(),
            updatedAt: new Date()
        };

        console.log("Final payload:", {
            payloadId: payload.id,
            payloadContentType: typeof payload.content,
            payloadContentLength: payload.content?.length || 0,
            payloadContentPreview: payload.content?.substring(0, 100) + (payload.content && payload.content.length > 100 ? '...' : ''),
            payloadKeys: Object.keys(payload)
        });

        const result = {
            type: ResponseType.SUCCESS,
            requestId: request.id,
            payload,
            timestamp: new Date()
        };

        console.log("=== GEMINI BUILD SUCCESS RESPONSE DEBUG END ===");
        return result;
    }

    private buildErrorResponse(request: LLMRequest, error: unknown): ApiResponse<LLMError> {
        const normalizedError = error instanceof Error ? error : new Error('Unknown Gemini API error');
        const payload: LLMError = {
            id: `gemini-error-${Date.now()}`,
            requestId: request.id,
            provider: request.provider,
            model: request.model,
            error: normalizedError.message,
            errorCode: this.extractErrorCode(error),
            retryable: this.isRetryable(error),
            metadata: {
                rawError: error
            },
            createdAt: new Date(),
            updatedAt: new Date()
        };

        return {
            type: ResponseType.ERROR,
            requestId: request.id,
            error: normalizedError.message,
            payload,
            timestamp: new Date()
        };
    }

    private extractText(response: any): string | undefined {
        console.log("=== GEMINI EXTRACT TEXT DEBUG START ===");
        console.log("Response structure:", {
            hasText: !!response.text,
            hasCandidates: !!response.candidates,
            candidatesLength: response.candidates?.length || 0,
            responseKeys: Object.keys(response)
        });

        try {
            // New API: response.text is a property, not a method
            const text = response.text || '';
            console.log("Text extraction result:", {
                textType: typeof text,
                textLength: text?.length || 0,
                textPreview: text?.substring(0, 100) + (text && text.length > 100 ? '...' : ''),
                fullText: text
            });

            // Only treat as success if non-empty
            if (typeof text === 'string' && text.trim().length > 0) {
                console.log("=== GEMINI EXTRACT TEXT DEBUG END (SUCCESS) ===");
                return text;
            }
            console.warn("Primary text returned empty; proceeding to fallback extraction.");
        } catch (error) {
            console.warn("Text extraction failed, trying fallback:", error);
        }

        try {
            // Try alternative extraction methods
            const candidates = response.candidates;
            if (candidates && candidates.length > 0) {
                console.log("Trying candidates extraction:", {
                    candidatesCount: candidates.length,
                    firstCandidate: candidates[0]
                });
                
                for (let i = 0; i < candidates.length; i++) {
                    const candidate = candidates[i];
                    const content = candidate?.content;
                    const parts = content?.parts;
                    
                    console.log(`Candidate ${i}:`, {
                        hasContent: !!content,
                        hasParts: !!parts,
                        partsLength: parts?.length || 0,
                        hasFinishReason: !!candidate.finishReason,
                        finishReason: candidate.finishReason,
                        hasSafetyRatings: !!candidate.safetyRatings,
                        safetyRatings: candidate.safetyRatings
                    });

                    // Check for safety-related blocks
                    if (candidate.finishReason === 'SAFETY') {
                        console.warn(`⚠️ GEMINI SAFETY BLOCK: Candidate ${i} was blocked due to safety concerns`);
                    }

                    if (candidate.finishReason === 'RECITATION') {
                        console.warn(`⚠️ GEMINI RECITATION BLOCK: Candidate ${i} was blocked due to recitation concerns`);
                    }

                    if (candidate.finishReason === 'OTHER') {
                        console.warn(`⚠️ GEMINI OTHER BLOCK: Candidate ${i} was blocked for other reasons`);
                    }

                    if (candidate.safetyRatings) {
                        console.log(`Candidate ${i} safety ratings:`, candidate.safetyRatings.map((rating: any) => ({
                            category: rating.category,
                            probability: rating.probability,
                            blocked: rating.blocked
                        })));
                    }
                    
                    if (parts && parts.length > 0) {
                        for (let j = 0; j < parts.length; j++) {
                            const part = parts[j];
                            console.log(`Part ${j}:`, {
                                hasText: !!part?.text,
                                textType: typeof part?.text,
                                textLength: part?.text?.length || 0,
                                textPreview: part?.text?.substring(0, 100) + (part?.text && part.text.length > 100 ? '...' : '')
                            });
                            
                            if (part?.text && String(part.text).trim().length > 0) {
                                console.log("=== GEMINI EXTRACT TEXT DEBUG END (FALLBACK SUCCESS) ===");
                                return part.text;
                            }
                        }
                    }
                }
            }
            
            // As a last resort, surface promptFeedback diagnostics to avoid total emptiness
            const promptFeedback = response?.promptFeedback;
            if (promptFeedback) {
                const safetyRatings = Array.isArray(promptFeedback.safetyRatings) ? promptFeedback.safetyRatings : [];
                const blockedReasons = safetyRatings.filter((r: any) => r?.blocked).map((r: any) => r.category);
                const diag = `[GEMINI_PROMPT_FEEDBACK] ${promptFeedback.blockReason || 'blocked'}${blockedReasons.length ? `: ${blockedReasons.join(', ')}` : ''}`;
                console.warn("Gemini promptFeedback present; returning diagnostic string:", diag);
                console.log("=== GEMINI EXTRACT TEXT DEBUG END (DIAGNOSTIC) ===");
                return diag;
            }

            console.warn("All text extraction methods failed");
            console.log("=== GEMINI EXTRACT TEXT DEBUG END (FAILED) ===");
            return undefined;
        } catch (fallbackError) {
            console.warn("Fallback extraction threw unexpectedly:", fallbackError);
            console.log("=== GEMINI EXTRACT TEXT DEBUG END (FAILED) ===");
            return undefined;
        }
    }

    private resolveMaxTokens(request: LLMRequest): number | undefined {
        if (typeof request.maxTokens === 'number') {
            return request.maxTokens;
        }

        return undefined;
    }

    private getApiKey(request: LLMRequest): string | undefined {
        const apiKey = request.metadata?.apiKey;
        return typeof apiKey === 'string' && apiKey.trim() ? apiKey.trim() : undefined;
    }

    private getBaseUrl(endpoints: CustomApiEndpoints): string | undefined {
        if (!endpoints) {
            return undefined;
        }

        const endpoint = endpoints.google ?? endpoints.gemini ?? endpoints.default;
        if (typeof endpoint !== 'string' || !endpoint.trim()) {
            return undefined;
        }

        try {
            const url = new URL(endpoint.trim());
            return url.toString();
        } catch (error) {
            return undefined;
        }
    }

    private removeUndefined<T extends Record<string, unknown>>(payload: T): T {
        return Object.fromEntries(
            Object.entries(payload).filter(([, value]) => value !== undefined)
        ) as T;
    }

    private extractErrorCode(error: unknown): string {
        // Check for rate limit/quota errors
        if (this.isRateLimitError(error)) {
            return 'RATE_LIMIT_EXCEEDED';
        }

        if (typeof error !== 'object' || error === null) {
            return 'unknown_error';
        }

        const err = error as any;

        // Check direct HTTP status
        if (typeof err.status === 'number') {
            return `http_${err.status}`;
        }

        // Check response status
        if (typeof err.response?.status === 'number') {
            return `http_${err.response.status}`;
        }

        // Check Google nested error structure
        if (typeof err.error?.code === 'number') {
            return `http_${err.error.code}`;
        }

        // Check for network error codes
        if (err.code && typeof err.code === 'string') {
            return err.code;
        }
        if (err.cause?.code && typeof err.cause.code === 'string') {
            return err.cause.code;
        }

        return 'unknown_error';
    }

    private isRateLimitError(error: unknown): boolean {
        if (typeof error !== 'object' || error === null) {
            return false;
        }

        // Check HTTP status code 429 (Too Many Requests)
        if ('status' in error) {
            const status = (error as { status?: number }).status;
            if (status === 429) {
                return true;
            }
        }

        // Check error message for rate limit/quota patterns
        const errorMessage = error instanceof Error ? error.message.toLowerCase() : '';
        const rateLimitPatterns = [
            'quota exceeded',
            'rate limit',
            'resource exhausted',
            'too many requests',
            'resource_exhausted'
        ];

        return rateLimitPatterns.some(pattern => errorMessage.includes(pattern));
    }

    private isRetryable(error: unknown): boolean {
        // Hierarchical checks (in order of priority)
        
        // 1. Abort/cancel → not retryable
        if (this.isAbortError(error)) {
            return false;
        }
        
        // 2. Empty response → retryable
        const errorMessage = error instanceof Error ? error.message : String(error);
        if (errorMessage === 'Empty response from Gemini API') {
            return true;
        }
        
        // 3. Network codes → retryable
        if (this.isNetworkError(error)) {
            return true;
        }
        
        // 4. HTTP status 500-599 → retryable
        if (this.is5xxError(error)) {
            return true;
        }
        
        // 5. 429 / RESOURCE_EXHAUSTED → retryable (but no fallback to free-tier)
        if (this.isRateLimitError(error)) {
            return true;
        }
        
        // 6. 4xx auth/validation → not retryable
        if (this.is4xxError(error)) {
            return false;
        }
        
        return false;
    }
}


