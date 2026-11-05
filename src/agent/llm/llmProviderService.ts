import { GlobalDataStore } from "../../persistence/globalDataStore";
import { DataStore } from "../../persistence/dataStore";
import {
  LLMRequest,
  LLMResponse,
  LLMError,
  LLMMessage,
} from "../../common/models/llm-models";
import { ApiResponse, ResponseType } from "../../common/models/response-models";
import { getModelById } from "../../common/constants/llm-models";
import { LlmEntry } from "../../common/models/settings-models";
import { calculateLLMCost } from "../../common/utils/llmCostCalculator";
import { getKey } from "../../common/utils/llmSecretStore";
import { estimateTokenCount, truncateMessagesToTokenLimit } from "../../common/utils/tokenEstimator";

export const MISSING_MODEL_MESSAGE =
  "Add a model and API key in Samurai Agent Settings before running a review.";

export interface ChatClient {
  chat(request: LLMRequest): Promise<ApiResponse<LLMResponse | LLMError>>;
}

type LLMCostObserver = (payload: { request: LLMRequest; response: LLMResponse }) => void;

export class LLMProviderService {
  private clients: Map<string, ChatClient>;
  private cachedGlobalSettings: any | undefined;
  private costObservers: Set<LLMCostObserver> = new Set();

  constructor(
    private readonly globalDataStore: GlobalDataStore,
    private readonly dataStore?: DataStore,
    clients?: Map<string, ChatClient>,
  ) {
    this.clients = clients ?? new Map();
  }

  public addCostObserver(observer: LLMCostObserver): () => void {
    this.costObservers.add(observer);
    return () => {
      this.costObservers.delete(observer);
    };
  }

  private notifyCostObservers(event: { request: LLMRequest; response: LLMResponse }): void {
    if (this.costObservers.size === 0) {
      return;
    }
    for (const observer of this.costObservers) {
      try {
        observer(event);
      } catch (error) {
        console.error("[LLMProviderService] Cost observer threw error:", error);
      }
    }
  }

  public registerClient(provider: string, client: ChatClient): void {
    this.clients.set(provider.toLowerCase(), client);
  }

  public getCachedGlobalSettings(): any | undefined {
    return this.cachedGlobalSettings;
  }

  /**
   * Resolve which BYOK entry serves this request: an entry whose id matches
   * `request.model`, otherwise the globally active entry.
   */
  private resolveEntry(globalSettings: any, requestedModel?: string): LlmEntry | undefined {
    const entries: LlmEntry[] = globalSettings.llmEntries ?? [];
    return (
      entries.find((entry) => entry.id === requestedModel) ??
      entries.find((entry) => entry.id === globalSettings.activeLlmEntryId)
    );
  }

  private buildModelRequest(
    request: LLMRequest,
    entry: LlmEntry,
    apiKey: string,
    globalSettings: any,
  ): LLMRequest {
    const modelRequest: LLMRequest = {
      ...request,
      provider: entry.provider,
      model: entry.modelName,
      messages: this.normalizeMessages(request.messages, apiKey, entry.provider),
      metadata: {
        ...request.metadata,
        apiKey,
        provider: entry.provider,
        customApiEndpoints: globalSettings.customApiEndpoints,
      },
    };
    this.truncateToModelLimit(modelRequest);
    return modelRequest;
  }

  private truncateToModelLimit(modelRequest: LLMRequest): void {
    const maxInputTokens = getModelById(modelRequest.model)?.maxInputTokens;
    if (!maxInputTokens) {
      return;
    }
    const tokenCount = estimateTokenCount(modelRequest.messages);
    if (tokenCount > maxInputTokens) {
      console.warn(`[LLMProviderService] Token count ${tokenCount} exceeds limit ${maxInputTokens} for model ${modelRequest.model}, applying truncation`);
      modelRequest.messages = truncateMessagesToTokenLimit(modelRequest.messages, maxInputTokens);
    }
  }

  public async chat(
    request: LLMRequest,
  ): Promise<ApiResponse<LLMResponse | LLMError>> {
    const globalSettingsResponse = this.globalDataStore.loadGlobalSettings();
    if (
      globalSettingsResponse.type !== ResponseType.SUCCESS ||
      !globalSettingsResponse.payload
    ) {
      return this.createErrorResponse("Global settings could not be loaded", request.id);
    }
    const globalSettings = globalSettingsResponse.payload;
    this.cachedGlobalSettings = globalSettings;

    const entry = this.resolveEntry(globalSettings, request.model);
    const apiKey = entry ? (await getKey(entry.id))?.trim() : undefined;
    if (!entry || !apiKey) {
      return this.createErrorResponse(MISSING_MODEL_MESSAGE, request.id);
    }

    const client = this.clients.get(entry.provider);
    if (!client) {
      return this.createErrorResponse(`No client registered for provider ${entry.provider}`, request.id);
    }

    const modelRequest = this.buildModelRequest(request, entry, apiKey, globalSettings);
    const response = await this.chatWithEmptyRetry(client, modelRequest);
    return response.type === ResponseType.SUCCESS && response.payload
      ? this.applyCost(modelRequest, response)
      : response;
  }

  /** Calls the client; retries once when a successful response has empty content. */
  private async chatWithEmptyRetry(
    client: ChatClient,
    modelRequest: LLMRequest,
  ): Promise<ApiResponse<LLMResponse | LLMError>> {
    const response = await client.chat(modelRequest);
    if (response.type !== ResponseType.SUCCESS || !response.payload || this.hasValidContent(response)) {
      return response;
    }
    console.warn('[LLMProviderService] Received empty content in SUCCESS response, retrying once...', {
      requestId: modelRequest.id,
      model: modelRequest.model,
    });
    const retryResponse = await client.chat(modelRequest);
    if (this.hasValidContent(retryResponse)) {
      return retryResponse;
    }
    const reason = retryResponse.type === ResponseType.SUCCESS ? 'after retry' : 'and retry failed';
    return this.createErrorResponse(`LLM returned empty response ${reason}`, modelRequest.id);
  }

  private hasValidContent(response: ApiResponse<LLMResponse | LLMError>): boolean {
    if (response.type !== ResponseType.SUCCESS) return false;
    const payload = response.payload as LLMResponse;
    return !!(payload.content && payload.content.trim().length > 0);
  }

  /** Adds cost (0 for unknown/custom models) to a successful response and notifies observers. */
  private applyCost(
    request: LLMRequest,
    response: ApiResponse<LLMResponse | LLMError>,
  ): ApiResponse<LLMResponse | LLMError> {
    const llmResponse = response.payload as LLMResponse;
    const costCalculation = calculateLLMCost({
      provider: llmResponse.provider,
      model: llmResponse.model,
      promptTokens: llmResponse.usage?.promptTokens ?? 0,
      completionTokens: llmResponse.usage?.completionTokens ?? 0,
    });
    llmResponse.cost = costCalculation.totalCost;
    llmResponse.metadata = {
      ...llmResponse.metadata,
      costBreakdown: {
        promptCost: costCalculation.promptCost,
        completionCost: costCalculation.completionCost,
        pricing: costCalculation.pricing,
      },
    };
    this.notifyCostObservers({ request, response: llmResponse });
    return response;
  }

  private normalizeMessages(
    messages: LLMMessage[],
    apiKey: string,
    provider: string,
  ): LLMMessage[] {
    return messages.map((message, index) => ({
      ...message,
      metadata: {
        ...message.metadata,
        apiKey,
        provider,
        order: index,
      },
    }));
  }

  private createErrorResponse(
    message: string,
    requestId?: string,
  ): ApiResponse<LLMError> {
    return {
      type: ResponseType.ERROR,
      requestId,
      error: message,
      timestamp: new Date(),
    };
  }
}
