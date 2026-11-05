/**
 * DebugSessionController - Controller layer for fast path debugging flow
 * 
 * Orchestrates InitialContextService for immediate graph visualization
 * and triggers background analysis process.
 */

import { ChatMessage, CreateChatMessageRequest, MessageType, Session } from '../../common/models/chat-models';
import { AgentExecutionResult } from '../models/agent-models';
import { InitialContextService } from '../services/InitialContextService';
import { ImageGenerationService } from '../services/ImageGenerationService';
import { SamuraiAgentPanelWebviewViewProvider } from '../../webview/SamuraiAgentPanelWebviewViewProvider';
import { ToolRegistry } from '../tools/ToolRegistry';
import { LLMProviderService } from '../llm/llmProviderService';
import { PlanningAgent, AgentContext } from '../core/PlanningAgent';
import { LedgerState } from '../ledger/searchFileLedger';
import { StreamReporter } from '../utils/StreamReporter';
import { DebugSessionLogger } from '../utils/DebugSessionLogger';
import { DataStore } from '../../persistence/dataStore';
import { GlobalDataStore } from '../../persistence/globalDataStore';
import { LLMCostStorage, LLMCostRecord } from '../../storage/llmCostStorage';
import { LLMRequest, LLMResponse } from '../../common/models/llm-models';
import { ResponseType } from '../../common/models/response-models';
import * as path from 'path';
import * as fs from 'fs';
import { randomUUID } from 'crypto';
import * as vscode from 'vscode';
import { fetchAndExtract, normalizeUrlForCache, truncateContentToTokenBudget, FetchedDocumentation } from '../utils/urlContentFetcher';
import { sanitizeErrorForUser } from '../utils/errorSanitizer';

interface CachedDocumentation {
  url: string;
  title: string;
  content: string;
  fetchedAt: Date;
}

export class DebugSessionController {
  // Store final root cause messages by session ID for image generation
  private sessionRootCauseMap: Map<string, string> = new Map();
  // Track costs per session for cost observer aggregation
  private sessionCostMap: Map<string, number> = new Map();
  // Store unsubscribe functions for cost observers
  private costObserverUnsubscribes: Map<string, () => void> = new Map();
  // Track active PlanningAgent executions per session to prevent duplicate invocations
  private activePlanningAgentExecutions: Map<string, Promise<void>> = new Map();
  // AbortControllers per session — used to cancel running PlanningAgent executions
  private sessionAbortControllers: Map<string, AbortController> = new Map();
  // Documentation cache: Map<sessionId, Map<normalizedUrl, CachedDocumentation>>
  private documentationCache: Map<string, Map<string, CachedDocumentation>> = new Map();
  // Search & File Ledger: Map<sessionId, LedgerState>
  private sessionLedgers: Map<string, LedgerState> = new Map();
  private _webviewProvider: SamuraiAgentPanelWebviewViewProvider | null = null;

  private globalDataStore: GlobalDataStore;

  constructor(
    private initialContextService: InitialContextService,
    private toolRegistry: ToolRegistry,
    private llmProvider: LLMProviderService,
    webviewProvider: SamuraiAgentPanelWebviewViewProvider | null = null,
    private dataStore?: DataStore,
    private imageService?: ImageGenerationService,
    private workspaceRoot?: string,
    private llmCostStorage?: LLMCostStorage
  ) {
    this._webviewProvider = webviewProvider;
    this.globalDataStore = new GlobalDataStore();
  }

  public setWebviewProvider(provider: SamuraiAgentPanelWebviewViewProvider | null): void {
    this._webviewProvider = provider;
  }

  /**
   * Returns whether a PlanningAgent execution is in progress for the given session.
   * Used by the webview to restore busy state (e.g. after tab switch).
   */
  public isSessionBusy(sessionId: string): boolean {
    return this.activePlanningAgentExecutions.has(sessionId);
  }

  /**
   * Aborts a running PlanningAgent execution for the given session.
   * The abort signal propagates into PlanningAgent.execute() which checks it
   * at each iteration of its analysis loop.
   */
  public abortSession(sessionId: string): void {
    const controller = this.sessionAbortControllers.get(sessionId);
    if (controller) {
      console.log('[DebugSessionController] Aborting session', { sessionId });
      controller.abort();
      this.sessionAbortControllers.delete(sessionId);
    } else {
      console.log('[DebugSessionController] No active AbortController for session', { sessionId });
    }
  }

  /**
   * Clears all files from the sandbox directory.
   * Safe to call independently; failures are logged and non-fatal.
   */
  public async cleanSandbox(): Promise<void> {
    try {
      const sandboxTool = this.toolRegistry.getTool('sandbox-fs');
      if (sandboxTool) {
        await sandboxTool.execute({ action: 'cleanup' });
        console.log('[DebugSessionController] Sandbox cleaned');
      } else {
        console.warn('[DebugSessionController] Sandbox tool not available');
      }
    } catch (e) {
      console.warn('[DebugSessionController] Failed to clean sandbox (non-fatal):', e);
    }
  }

  /**
   * Main Entry Point for the new "Fast Path" Debug Flow
   */
  async startSession(
    userMessage: ChatMessage,
    session: Session,
    workspaceRoot: string
  ): Promise<AgentExecutionResult> {
    const userQuery = userMessage.content;
    const logs = userMessage.metadata?.log;
    const pinnedFiles = session.pinnedFilePaths || [];
    const model = session.metadata?.model;

    // Create StreamReporter for real-time status updates
    const reporter = new StreamReporter(this._webviewProvider, session.id);

    // Check if debug logging is enabled before creating logger
    let logger: DebugSessionLogger | undefined = undefined;
    const globalSettingsResponse = this.globalDataStore.loadGlobalSettings();
    const enableDebugLogging = globalSettingsResponse.type === ResponseType.SUCCESS 
      && globalSettingsResponse.payload?.enableDebugLogging === true;

    if (enableDebugLogging) {
      // Create DebugSessionLogger for checkpoint saving (auto-wipes previous session)
      logger = new DebugSessionLogger(session.id, workspaceRoot);
    }

    try {
      // --- STEP 1: FAST PATH (Initial Context) ---
      // Goal: Get the graph in < 3 seconds
      
      // Emit initial phase events
      reporter.report('phase', 'Initializing debugging session...');
      reporter.report('phase', 'Scanning logs and workspace to find epicenter...');

      // Log user request (only if logger is enabled)
      logger?.logUserRequest(userQuery, logs);

      const context = await this.initialContextService.getInitialContext(
        session.id,
        userQuery,
        workspaceRoot,
        logs,
        pinnedFiles.length > 0 ? pinnedFiles : undefined,
        model
      );

      // Capture initial context cost for aggregation
      let sessionTotalCost = context.cost || 0;

      // Save initial context cost to LLMCostStorage if present
      if (context.cost && context.cost > 0 && this.llmCostStorage) {
        try {
          const modelUsed = model || session.metadata?.model || 'unknown';
          
const costRecord: LLMCostRecord = {
            id: `initial-context-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
            timestamp: new Date().toISOString(),
            provider: 'initial-context', // InitialContextService may use different providers
            model: modelUsed,
            promptTokens: 0, // InitialContextService doesn't expose token counts
            completionTokens: 0,
            totalTokens: 0,
            cost: context.cost,
            sessionId: session.id,
            requestId: `initial-context-${session.id}-${Date.now()}`,
          };
          
          await this.llmCostStorage.saveRecord(costRecord);
          console.log('[DebugController] Saved initial context cost record to LLMCostStorage', {
            sessionId: session.id,
            cost: costRecord.cost,
            model: costRecord.model
          });
        } catch (error) {
          console.error('[DebugController] Failed to save initial context cost record:', error);
          // Continue even if save fails - don't break the flow
        }
      }

      if (!context.success) {
        // Fast Fail: Ask user for clarification
        return {
          success: false,
          message: context.error || "I couldn't identify the file to debug. Please mention a filename.",
          metadata: { status: 'needs_info', fastPath: true }
        };
      }

      // Log epicenter and initial graph (only if logger is enabled)
      if (context.epicenterFile) {
        logger?.logEpicenter({ file: context.epicenterFile, source: context.source });
        const epicenterFileName = path.basename(context.epicenterFile);
        reporter.report('phase', `Epicenter identified: ${epicenterFileName}`);
      }
      if (context.graphData) {
        logger?.logGraph(context.graphData);
      }
      reporter.report('phase', 'Dependency graph mapped.');

      // --- STEP 2: BACKGROUND AGENT (Fire & Forget) ---
      // Note: Initial graph data is kept in context for agent use, but not sent to frontend
      // The frontend will receive graphs from the background agent when graph-context tool is called
      // We do NOT await this. It runs in the background.
      // We pass the context we just found so it doesn't search again.
      const documentationUrl = userMessage.metadata?.documentationUrl as string | undefined;
      this.runBackgroundAgent(session, userQuery, logs, context, reporter, logger, sessionTotalCost, documentationUrl).catch(err => {
        console.error('[BackgroundAgent] Failed:', err);
        if (this._webviewProvider) {
          this._webviewProvider.postMessage({
            type: 'agentError',
            payload: { sessionId: session.id, error: String(err) },
            timestamp: new Date()
          });
        }
      });

      // --- STEP 4: RETURN IMMEDIATE RESPONSE ---
      // No message needed - graph visualization and live status updates are sufficient
      return {
        success: true,
        message: ``,
        metadata: {
          userIntent: 'debugging',
          fastPath: true,
          epicenter: context.epicenterFile,
          source: context.source,
          // HIDDEN: Visualization disabled but preserved for future use
          visualization: null // context.graphData?.mermaid
        }
      };
    } catch (error: any) {
      console.error('[DebugController] Critical Error:', error);

      return {
        success: false,
        message: `System Error: ${error.message}`,
        metadata: { error: error.message, fastPath: true }
      };
    }
  }

  /**
   * Handles the long-running analysis loop
   * Uses PlanningAgent with Investigation Board pattern
   */
  private async runBackgroundAgent(
    session: Session,
    query: string,
    logs: string | undefined,
    initialContext: any,
    reporter: StreamReporter,
    logger: DebugSessionLogger | undefined,
    sessionTotalCost: number = 0,
    documentationUrl?: string
  ): Promise<void> {
    const sessionId = session.id;
    
    // Check if PlanningAgent execution is already in progress for this session
    const existingExecution = this.activePlanningAgentExecutions.get(sessionId);
    if (existingExecution) {
      console.log('[BackgroundAgent] PlanningAgent execution already in progress for session, waiting for completion', {
        sessionId: sessionId
      });
      try {
        await existingExecution;
        console.log('[BackgroundAgent] Previous PlanningAgent execution completed, skipping duplicate invocation', {
          sessionId: sessionId
        });
      } catch (error) {
        console.warn('[BackgroundAgent] Previous PlanningAgent execution failed, allowing new execution', {
          sessionId: sessionId,
          error: error instanceof Error ? error.message : String(error)
        });
        // If previous execution failed, remove it from map and proceed
        this.activePlanningAgentExecutions.delete(sessionId);
      } finally {
        return; // Exit early to prevent duplicate execution
      }
    }

    // Only create fallback logger if debug logging is enabled
    if (!logger) {
      const globalSettingsResponse = this.globalDataStore.loadGlobalSettings();
      const enableDebugLogging = globalSettingsResponse.type === ResponseType.SUCCESS 
        && globalSettingsResponse.payload?.enableDebugLogging === true;
      
      if (enableDebugLogging) {
        const fallbackRoot = this.workspaceRoot || '';
        console.warn('[BackgroundAgent] Logger was undefined. Creating fallback DebugSessionLogger.');
        logger = new DebugSessionLogger(session.id, fallbackRoot);
      } else {
        // Debug logging is disabled, so logger should remain undefined
        logger = undefined;
      }
    }
    
    console.log('[BackgroundAgent] Starting PlanningAgent analysis', {
      sessionId: sessionId,
      epicenter: initialContext.epicenterFile,
      source: initialContext.source
    });

    // Create AbortController for this session so it can be cancelled externally
    const abortController = new AbortController();
    this.sessionAbortControllers.set(sessionId, abortController);

    // Create and store execution promise to prevent duplicate invocations
    const executionPromise = this.executePlanningAgent(
      session,
      query,
      logs,
      initialContext,
      reporter,
      logger,
      sessionTotalCost,
      documentationUrl,
      abortController.signal
    );

    this.activePlanningAgentExecutions.set(sessionId, executionPromise);

    // Wait for execution and ensure cleanup happens
    try {
      await executionPromise;
    } finally {
      // Clean up execution guard and abort controller regardless of success or failure
      this.activePlanningAgentExecutions.delete(sessionId);
      this.sessionAbortControllers.delete(sessionId);
      console.log('[BackgroundAgent] PlanningAgent execution completed and guard removed', {
        sessionId: sessionId
      });
    }
  }

  /**
   * Persists the agent response to the DataStore.
   * Called from the backend so the message is saved even if the webview is closed.
   * @returns true if save succeeded, false otherwise
   */
  private saveAgentResponseToDataStore(
    session: Session,
    messageId: string,
    content: string,
    epilogue: { steps: number; files: string[]; cost: number }
  ): boolean {
    const projectId = session.metadata?.projectId;
    if (!this.dataStore || !projectId) {
      return false;
    }
    try {
      const payload: CreateChatMessageRequest = {
        id: messageId,
        sessionId: session.id,
        projectId,
        type: MessageType.ASSISTANT,
        content,
        role: 'assistant',
        metadata: {
          samuraiAgentResponse: true,
          debugSessionFinished: true,
          sessionId: session.id,
          epilogue
        }
      };
      this.dataStore.handleWebviewMessage({ command: 'saveChatMessage', payload });
      return true;
    } catch (error) {
      console.error('[DebugSessionController] Failed to save agent response to DataStore:', error);
      return false;
    }
  }

  /**
   * Internal method to execute PlanningAgent analysis
   * Separated from runBackgroundAgent to enable proper promise tracking
   */
  private async executePlanningAgent(
    session: Session,
    query: string,
    logs: string | undefined,
    initialContext: any,
    reporter: StreamReporter,
    logger: DebugSessionLogger | undefined,
    sessionTotalCost: number = 0,
    documentationUrl?: string,
    abortSignal?: AbortSignal
  ): Promise<void> {
    console.log('[BackgroundAgent] PlanningAgent.execute() invoked', {
      sessionId: session.id,
      timestamp: new Date().toISOString()
    });

    // Initialize session cost tracking
    this.sessionCostMap.set(session.id, sessionTotalCost);

    // Fetch documentation context if URL is provided
    let documentationContext: { url: string; title: string; content: string; fetchedAt: Date } | undefined = undefined;
    if (documentationUrl && documentationUrl.trim()) {
      try {
        const normalizedUrl = normalizeUrlForCache(documentationUrl);
        
        // Get or create session cache
        let sessionCache = this.documentationCache.get(session.id);
        if (!sessionCache) {
          sessionCache = new Map();
          this.documentationCache.set(session.id, sessionCache);
        }

        // Check cache
        let cached = sessionCache.get(normalizedUrl);
        
        if (!cached) {
          // Fetch from URL
          console.log('[DebugController] Fetching documentation from URL:', documentationUrl);
          reporter.report('phase', 'Fetching documentation...');
          
          const fetched = await fetchAndExtract(documentationUrl);
          
          // Store in cache
          cached = {
            url: fetched.url,
            title: fetched.title,
            content: fetched.content,
            fetchedAt: fetched.fetchedAt
          };
          sessionCache.set(normalizedUrl, cached);
          
          console.log('[DebugController] Documentation fetched successfully:', {
            url: fetched.url,
            title: fetched.title,
            contentLength: fetched.content.length
          });
        } else {
          console.log('[DebugController] Using cached documentation:', {
            url: cached.url,
            title: cached.title,
            cachedAt: cached.fetchedAt
          });
        }

        // Calculate token budget (15-25% of model's input limit)
        const model = session.metadata?.model || 'gpt-4o';
        // Estimate token limits for common models
        const modelTokenLimits: Record<string, number> = {
          'gpt-4o': 128000,
          'gpt-4-turbo': 128000,
          'gpt-4': 8192,
          'gpt-3.5-turbo': 16385,
          'claude-3-5-sonnet-20241022': 200000,
          'claude-3-opus-20240229': 200000,
          'gemini-2.0-flash-exp': 1000000,
          'gemini-1.5-pro': 2000000
        };
        const modelLimit = modelTokenLimits[model] || 128000;
        const docTokenBudget = Math.floor(modelLimit * 0.20); // 20% of input limit

        // Truncate content to fit token budget
        const { content: truncatedContent, wasTruncated } = truncateContentToTokenBudget(
          cached.content,
          cached.title,
          docTokenBudget
        );

        documentationContext = {
          url: cached.url,
          title: cached.title,
          content: truncatedContent + (wasTruncated ? '\n\n[Content truncated to fit token limit]' : ''),
          fetchedAt: cached.fetchedAt
        };

        console.log('[DebugController] Documentation context prepared:', {
          url: documentationContext.url,
          title: documentationContext.title,
          contentLength: documentationContext.content.length,
          wasTruncated,
          tokenBudget: docTokenBudget
        });
      } catch (error: any) {
        console.error('[DebugController] Failed to fetch documentation:', error);
        // Don't block execution - continue without documentation context
        reporter.report('phase', `Documentation fetch failed: ${error.message}`);
      }
    }

    // Subscribe to cost observers to track image description generation and other LLM costs
    const unsubscribe = this.llmProvider.addCostObserver(async ({ request, response }) => {
      const requestSessionId = request.metadata?.sessionId;
      if (requestSessionId === session.id) {
        // Update in-memory session cost map (existing behavior); record tokens even when cost is 0
        const currentCost = this.sessionCostMap.get(session.id) || 0;
        const newCost = currentCost + (response.cost ?? 0);
        this.sessionCostMap.set(session.id, newCost);
        
        // NEW: Save to LLMCostStorage as a record
        if (this.llmCostStorage && response.cost > 0) {
          try {
            const modelUsed = response.model || request.metadata?.model || session.metadata?.model || 'unknown';
            
const costRecord: LLMCostRecord = {
              id: `cost-observer-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
              timestamp: new Date().toISOString(),
              provider: response.provider || 'unknown',
              model: modelUsed,
              promptTokens: response.usage?.promptTokens || 0,
              completionTokens: response.usage?.completionTokens || 0,
              totalTokens: response.usage?.totalTokens || 0,
              cost: response.cost,
              sessionId: session.id,
              requestId: request.id || `observer-${Date.now()}`,
            };
            
            await this.llmCostStorage.saveRecord(costRecord);
            console.log('[DebugController] Cost observer: Saved record to LLMCostStorage', {
              sessionId: session.id,
              cost: costRecord.cost,
              model: costRecord.model
            });
          } catch (error) {
            console.error('[DebugController] Cost observer: Failed to save record', error);
            // Continue even if save fails - don't break the flow
          }
        }
        
        console.log('[DebugController] Cost observer: Updated session cost', {
          sessionId: session.id,
          addedCost: response.cost,
          totalCost: newCost
        });
      }
    });
    this.costObserverUnsubscribes.set(session.id, unsubscribe);

    try {
      // Map InitialContextResult to AgentContext
      const agentContext: AgentContext = {
        initialEpicenter: initialContext.epicenterFile,
        initialGraph: initialContext.graphData
      };

      // Load chat history (limit to last 20 messages to prevent token explosion)
      let chatHistory: Array<{ role: string; content: string }> = [];
      if (this.dataStore) {
        try {
          const rawHistory = this.dataStore.loadChatMessagesForSession(session.id);
          chatHistory = rawHistory
            .slice(-20) // GUARDRAIL: Limit to last 20 messages
            .map(msg => {
              let content = msg.content;
              // Strip cost footer pattern to prevent LLM from seeing and repeating cost information
              // Pattern matches: "*Analysis complete: N step(s), M file(s) analyzed. Cost: $X.XXXX*"
              content = content.replace(/\*Analysis complete:.*?Cost: \$[\d.]+\s*\*/g, '').trim();
              return {
                role: msg.role, // Ensure valid 'user' | 'assistant' | 'system'
                content: content
              };
            });
          console.log(`[BackgroundAgent] Loaded ${chatHistory.length} historical messages (cost footers stripped)`);
        } catch (error) {
          console.warn('[BackgroundAgent] Failed to load chat history:', error);
          // Continue without history if loading fails
        }
      }

      // Get or initialize ledger for session
      let ledgerState = this.sessionLedgers.get(session.id);
      if (!ledgerState) {
        ledgerState = { searches: [], openedFiles: [] };
        this.sessionLedgers.set(session.id, ledgerState);
      }

      // Create PlanningAgent instance
      const planningAgent = new PlanningAgent(
        this.toolRegistry,
        this.llmProvider,
      this._webviewProvider
      );

      // Execute the analysis loop (pass ledger state and abort signal)
      const result = await planningAgent.execute(
        query,
        session,
        logs,
        agentContext,
        reporter,
        logger,
        chatHistory,
        documentationContext,
        ledgerState,
        abortSignal
      );

      // Aggregate costs from initial context and planning agent
      // Note: Cost observer may have already captured some costs, so we update the map
      const currentSessionCost = this.sessionCostMap.get(session.id) || sessionTotalCost;
      const updatedCost = currentSessionCost + (result.metadata?.cost || 0);
      this.sessionCostMap.set(session.id, updatedCost);
      sessionTotalCost = updatedCost;

      // Persist PlanningAgent cost to llmCostStorage
      // Note: PlanningAgent's LLM calls don't include sessionId in metadata,
      // so the cost observer won't capture them. We need to save the total cost here.
      if (result.metadata?.cost !== undefined && result.metadata.cost > 0 && this.llmCostStorage) {
        try {
          const modelUsed = session.metadata?.model || 'unknown';
          
const costRecord: LLMCostRecord = {
            id: `cost-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
            timestamp: new Date().toISOString(),
            provider: 'agent-execution', // PlanningAgent uses multiple providers internally
            model: modelUsed,
            promptTokens: 0, // PlanningAgent doesn't expose individual token counts
            completionTokens: 0,
            totalTokens: 0,
            cost: result.metadata.cost,
            sessionId: session.id,
            requestId: `planning-agent-${session.id}-${Date.now()}`,
          };
          
          console.log('[COST DEBUG] DebugSessionController - Saving PlanningAgent cost record:', {
            sessionId: session.id,
            cost: costRecord.cost,
            model: costRecord.model
          });
          
          await this.llmCostStorage.saveRecord(costRecord);
          console.log('[COST DEBUG] DebugSessionController - PlanningAgent cost record saved successfully');
        } catch (error) {
          // Log error but don't fail the session - cost tracking is non-critical
          console.error('[COST DEBUG] DebugSessionController - Failed to save PlanningAgent cost record:', error);
        }
      }

      // Guard: If the execution was cancelled (user started new conversation), exit silently.
      // No response should be sent to the frontend — the user has already moved on.
      if (result.metadata?.isCancelled) {
        console.log('[DebugSessionController] PlanningAgent execution was cancelled, skipping response', {
          sessionId: session.id
        });
        return;
      }

      // Guard: PlanningAgent returned an error result — sanitize for user
      if (result.success === false && result.message) {
        console.error('[DebugSessionController] PlanningAgent returned error:', result.message);
        const sanitized = sanitizeErrorForUser(result.message);
        const errorMsgId = randomUUID();
        const errorEpilogue = {
          steps: result.metadata?.stepsTaken || 0,
          files: result.metadata?.filesAnalyzed || [],
          cost: sessionTotalCost
        };
        const errorSaveSucceeded = this.saveAgentResponseToDataStore(session, errorMsgId, sanitized.userMessage, errorEpilogue);
        if (this._webviewProvider) {
          this._webviewProvider.postMessage({
            type: 'debugSessionFinished',
            payload: {
              id: errorMsgId,
              sessionId: session.id,
              content: sanitized.userMessage,
              visualization: null,
              epilogue: errorEpilogue,
              alreadyPersisted: errorSaveSucceeded
            },
            timestamp: new Date()
          });
        }
        return; // Exit early
      }

      // Store final root cause message for image generation
      if (result.message) {
        this.sessionRootCauseMap.set(session.id, result.message);
      }

      // Guard: Don't send empty messages to users
      if (!result.message || result.message.trim().length === 0) {
        console.error('[DebugSessionController] PlanningAgent returned empty message, sending error to user');
        const emptyMessageId = randomUUID();
        const emptyContent = 'I apologize, but I received an empty response from the language model. Please try asking your question again.';
        const emptyEpilogue = {
          steps: result.metadata?.stepsTaken || 0,
          files: result.metadata?.filesAnalyzed || [],
          cost: sessionTotalCost
        };
        // Save is synchronous, so committed before postMessage and before process exit.
        const emptySaveSucceeded = this.saveAgentResponseToDataStore(session, emptyMessageId, emptyContent, emptyEpilogue);
        if (this._webviewProvider) {
          this._webviewProvider.postMessage({
            type: 'debugSessionFinished',
            payload: {
              id: emptyMessageId,
              sessionId: session.id,
              content: emptyContent,
              visualization: null,
              epilogue: emptyEpilogue,
              alreadyPersisted: emptySaveSucceeded
            },
            timestamp: new Date()
          });
        }
        return; // Exit early, don't continue with graph generation
      }

      // 2. SEND TEXT IMMEDIATELY (Low Latency)
      // We send 'visualization: null' (or keep previous) to avoid delaying the text.
      // Generate message ID in backend (source of truth) BEFORE sending event
      // This ensures consistent ID across all save attempts and breaks the infinite loop
      const responseId = randomUUID();
      const epilogue = {
        steps: result.metadata?.stepsTaken || 0,
        files: result.metadata?.filesAnalyzed || [],
        cost: sessionTotalCost
      };
      // Build stats footer to match webview (chat.js) so stored content is identical
      const steps = epilogue.steps;
      const filesCount = Array.isArray(epilogue.files) ? epilogue.files.length : 0;
      const cost = epilogue.cost || 0;
      const statsFooter = `\n\n*Analysis complete: ${steps} step${steps !== 1 ? 's' : ''}, ${filesCount} file${filesCount !== 1 ? 's' : ''} analyzed. Cost: $${cost.toFixed(4)}*`;
      const contentWithFooter = result.message + statsFooter;
      // Save is synchronous (DataStore.handleWebviewMessage → saveChatMessageInternal), so it is
      // committed before postMessage and before process exit; no floating promise.
      const saveSucceeded = this.saveAgentResponseToDataStore(session, responseId, contentWithFooter, epilogue);

      if (this._webviewProvider) {
        try {
          this._webviewProvider.postMessage({
            type: 'debugSessionFinished',
            payload: {
              id: responseId,
              sessionId: session.id,
              content: result.message,
              visualization: null,
              epilogue,
              alreadyPersisted: saveSucceeded
            },
            timestamp: new Date()
          });
        } catch (error) {
          console.error('[BackgroundAgent] Failed to post message to webview:', error);
        }
      }

      // HIDDEN: Final graph generation disabled but preserved for future use
      /*
      // 3. GENERATE & SEND FINAL GRAPH (Async)
      // Now we generate the perfect "Function-Level" graph for the *final* epicenter.
      if (result.finalEpicenter) {
        console.log(`[Controller] Generating final graph for: ${result.finalEpicenter}`);
        
        try {
          // --- NEW STEP: Refine the Symbol using ALL analyzed files ---
          const filesAnalyzed = result.metadata?.filesAnalyzed || [];
          const model = session.metadata?.model || 'gpt-4o-mini';
          const preciseEpicenter = await this.refineEpicenterSymbol(
            result.finalEpicenter,
            filesAnalyzed, // Pass all files the agent analyzed
            result.message, // Pass the final solution text context
            model, // Use user-selected model
            logger // Pass logger for debugging
          );

          // Parse the composite key (file::symbol) or use file path directly
          const [file, symbol] = preciseEpicenter.includes('::') 
            ? preciseEpicenter.split('::') 
            : [preciseEpicenter, undefined];

          // Reuse the Tool Logic directly!
          const graphTool = this.toolRegistry.getTool('graph-context');
          if (graphTool) {
            const graphResult = await graphTool.execute({
              filePath: file,
              focusSymbol: symbol, // <--- Now we have a symbol for precision!
              depth: 4, // Keep it focused
              visualizationMode: 'hard-error'
            });

            if (graphResult.success && graphResult.structuredData?.mermaid) {
              // Send the "Late Update"
              if (this._webviewProvider) {
                this._webviewProvider.postMessage({
                  type: 'debugGraphUpdate', // Reuse the update channel
                  payload: {
                    sessionId: session.id,
                    status: 'final_map',
                    epicenter: preciseEpicenter, // Use refined epicenter
                    visualization: graphResult.structuredData.mermaid,
                    graphNodes: graphResult.structuredData.nodes,
                    nodeLocationMap: graphResult.structuredData.nodeLocationMap // Include pre-built map with normalized IDs
                  },
                  timestamp: new Date()
                });
              }
            }
          }
        } catch (e) {
          console.warn("[Controller] Failed to generate final graph", e);
        }
      }
      */

      console.log('[BackgroundAgent] Analysis complete');
    } catch (error: any) {
      console.error('[BackgroundAgent] Analysis failed:', error);

      // Save error response to DataStore so chat_interaction event is emitted
      const rawErrorMsg = error instanceof Error ? error.message : String(error);
      const sanitizedCatchError = sanitizeErrorForUser(rawErrorMsg);
      const errorMessageId = randomUUID();
      const errorContent = `I encountered an error while analyzing your code: ${sanitizedCatchError.userMessage}`;
      const errorEpilogue = {
        steps: 0,
        files: [],
        cost: this.sessionCostMap.get(session.id) || 0
      };
      this.saveAgentResponseToDataStore(session, errorMessageId, errorContent, errorEpilogue);

      if (this._webviewProvider) {
        this._webviewProvider.postMessage({
          type: 'agentError',
          payload: {
            sessionId: session.id,
            error: sanitizedCatchError.userMessage
          },
          timestamp: new Date()
        });
      }
    } finally {
      // Cleanup: Unsubscribe from cost observers when session ends
      const unsubscribe = this.costObserverUnsubscribes.get(session.id);
      if (unsubscribe) {
        unsubscribe();
        this.costObserverUnsubscribes.delete(session.id);
      }
    }
  }

  /**
   * Handles concept image generation request
   */
  async handleGenerateConceptImage(sessionId: string, messageId: string, rootCauseText?: string): Promise<void> {
    // Declare variables in outer scope so they're accessible in catch block
    let userSelectedModelId: string | undefined;
    let session: Session | undefined;
    
    try {
      console.log('[DebugController] handleGenerateConceptImage called', { 
        sessionId,
        messageId,
        rootCauseTextProvided: !!rootCauseText,
        rootCauseTextLength: rootCauseText?.length || 0,
        rootCauseTextPreview: rootCauseText ? rootCauseText.substring(0, 100) : 'none'
      });

      // Get session to retrieve user's selected model
      if (this.dataStore) {
        session = this.dataStore.loadSession(sessionId);
        userSelectedModelId = session?.metadata?.model;
      }

      if (!userSelectedModelId) {
        console.warn('[DebugController] User selected model not found, proceeding without cost tracking');
      }

      // Get root cause text - prefer passed text, then stored, then fallback
      // Validate that rootCauseText is not just whitespace before using it
      let rootCause = rootCauseText && rootCauseText.trim().length > 0 ? rootCauseText.trim() : undefined;
      let rootCauseSource = 'parameter';
      
      if (!rootCause) {
        rootCause = this.sessionRootCauseMap.get(sessionId);
        rootCauseSource = 'sessionRootCauseMap';
        console.log('[DebugController] Using rootCause from sessionRootCauseMap', { 
          sessionId, 
          hasRootCause: !!rootCause 
        });
      }
      
      if (!rootCause) {
        // Fallback: try to get from dataStore if available
        if (this.dataStore) {
          const messages = this.dataStore.loadChatMessagesForSession(sessionId);
          const lastAssistantMessage = messages
            .filter(msg => msg.role === 'assistant')
            .pop();
          if (lastAssistantMessage) {
            rootCause = lastAssistantMessage.content;
            rootCauseSource = 'dataStore';
            console.log('[DebugController] Using rootCause from dataStore', { 
              sessionId, 
              messageId: lastAssistantMessage.id 
            });
          }
        }
      }
      
      if (!rootCause) {
        rootCause = 'Unknown error - root cause analysis not available';
        rootCauseSource = 'fallback';
        console.warn('[DebugController] No root cause found, using fallback text', { sessionId });
      }

      console.log('[DebugController] Root cause determined', { 
        sessionId, 
        source: rootCauseSource,
        rootCauseLength: rootCause.length,
        rootCausePreview: rootCause.substring(0, 100)
      });

      // Step 2: Text-to-Text (Get the Visual Description)
      const promptTemplate = this.loadImagePrompt('diagram_description.md');
      const prompt = promptTemplate.replace('{{ROOT_CAUSE}}', rootCause);

      const descResponse = await this.llmProvider.chat({
        id: `image-desc-${Date.now()}`,
        provider: 'auto',
        model: '',
        messages: [{ role: 'user', content: prompt }],
        maxTokens: 10000,
        metadata: {
          purpose: 'image_description_generation',
          sessionId: sessionId
        },
        createdAt: new Date(),
        updatedAt: new Date()
      });

      if (descResponse.type !== 'success' || !descResponse.payload || !('content' in descResponse.payload)) {
        throw new Error('Failed to generate visual description');
      }

      const visualPrompt = descResponse.payload.content;

      // Step 3: Text-to-Image (Generate Pixels)
      if (!this.imageService || !this.workspaceRoot) {
        throw new Error('Image generation service not available');
      }

      const imagePath = await this.imageService.generateAndSave(sessionId, visualPrompt, userSelectedModelId);

      // Step 4: Persist Cost Immediately
      const IMAGE_GENERATION_COST = 0.13;
      if (imagePath && userSelectedModelId) {
        const requestId = `image-gen-${sessionId}-${Date.now()}`;

        // Save cost record to LLMCostStorage
        if (this.llmCostStorage) {
          try {
            const costRecord: LLMCostRecord = {
              id: `cost-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
              timestamp: new Date().toISOString(),
              provider: 'google',
              model: 'gemini-3-pro-image-preview',
              promptTokens: 0, // Image generation doesn't use tokens
              completionTokens: 0,
              totalTokens: 0,
              cost: IMAGE_GENERATION_COST,
              sessionId: sessionId,
              requestId: requestId,
            };

            await this.llmCostStorage.saveRecord(costRecord);
            console.log('[DebugController] Image generation cost saved:', costRecord);
          } catch (error) {
            console.error('[DebugController] Failed to save image generation cost record:', error);
            // Continue even if cost saving fails
          }
        }

        this.addImageCostToSession(sessionId, session, IMAGE_GENERATION_COST);
      }

      // Step 5: Convert to Webview URI and send to frontend
      if (imagePath && this._webviewProvider) {
        // Get webview instance from provider
        const webviewView = (this._webviewProvider as any)._webviewView;
        if (!webviewView || !webviewView.webview) {
          throw new Error('Webview not available for URI conversion');
        }

        const webview = webviewView.webview;

        // Convert file path to webview URI
        const fullPath = path.join(this.workspaceRoot, imagePath);
        const fileUri = vscode.Uri.file(fullPath);
        const webviewUri = webview.asWebviewUri(fileUri);

        // Ensure sessionId is never overwritten - use the parameter that was passed in
        const responseSessionId = sessionId;
        console.log('[DebugController] Sending conceptImageReady response', { 
          sessionId: responseSessionId,
          messageId,
          imagePath,
          rootCauseSource
        });

        this._webviewProvider.postMessage({
          type: 'conceptImageReady',
          payload: {
            sessionId: responseSessionId, // Explicitly use the sessionId parameter to prevent any overwriting
            messageId: messageId,
            imageUrl: webviewUri.toString()
          },
          timestamp: new Date()
        });
      } else {
        throw new Error('Failed to generate or save image');
      }
    } catch (e) {
      console.error('[DebugController] Image generation failed:', e);
      
      if (this._webviewProvider) {
        this._webviewProvider.postMessage({
          type: 'agentError',
          payload: {
            sessionId,
            error: `Failed to generate image: ${e instanceof Error ? e.message : String(e)}`
          },
          timestamp: new Date()
        });
      }
    }
  }

  /** Adds the image generation cost to the session total and notifies the UI. */
  private addImageCostToSession(sessionId: string, session: Session | undefined | null, cost: number): void {
    if (this.dataStore && session) {
      try {
        const updatedSession = this.dataStore.updateSession(sessionId, {
          totalCost: (session.totalCost || 0) + cost
        });
        console.log('[DebugController] Session cost updated:', {
          sessionId,
          previousCost: session.totalCost,
          newCost: updatedSession.totalCost
        });
      } catch (error) {
        console.error('[DebugController] Failed to update session cost:', error);
      }
    }

    this.sessionCostMap.set(sessionId, (this.sessionCostMap.get(sessionId) || 0) + cost);
    this._webviewProvider?.postMessage({
      type: 'costUpdate',
      payload: { sessionId, addedCost: cost },
      timestamp: new Date()
    });
  }

  /**
   * Extracts function, class, and method names from TypeScript/JavaScript source code.
   * Uses lightweight regex parsing to avoid heavy AST operations.
   * 
   * @param fileContent - The source code content
   * @param filePath - The file path (for context)
   * @returns Array of symbol names with their types
   */
  private extractSymbolsFromFile(
    fileContent: string,
    filePath: string
  ): Array<{ name: string; type: 'function' | 'class' | 'method'; exported: boolean }> {
    const symbols: Array<{ name: string; type: 'function' | 'class' | 'method'; exported: boolean }> = [];
    
    // Extract exported functions: export function name() or export const name = () =>
    const functionPatterns = [
      /export\s+(?:async\s+)?function\s+(\w+)/g,
      /export\s+const\s+(\w+)\s*=\s*(?:async\s*)?\(/g,
      /export\s+(?:async\s+)?function\s+(\w+)/g,
      /^export\s+(\w+)\s*=/gm,
      // Default exports: export default function name() or export default const name = () =>
      /export\s+default\s+(?:async\s+)?function\s+(\w+)/g,
      /export\s+default\s+const\s+(\w+)\s*=\s*(?:async\s*)?\(/g,
      // Named exports: export { name }
      /export\s*\{\s*(\w+)\s*(?:,|\})/g
    ];
    
    // Extract non-exported functions (for LLM selection)
    const nonExportedFunctionPatterns = [
      /^(?:async\s+)?function\s+(\w+)/gm,
      /^const\s+(\w+)\s*=\s*(?:async\s*)?\(/gm,
      /^let\s+(\w+)\s*=\s*(?:async\s*)?\(/gm,
      /^var\s+(\w+)\s*=\s*(?:async\s*)?\(/gm
    ];
    
    // Extract classes: export class Name or class Name
    const classPatterns = [
      /export\s+class\s+(\w+)/g,
      /^class\s+(\w+)/gm,
      // Default export class
      /export\s+default\s+class\s+(\w+)/g
    ];
    
    // Extract methods: 
    // - Class methods with/without modifiers: "async execute(", "public execute(", "execute("
    // - Arrow functions assigned to properties: "execute = async () =>"
    // - Getter/setter methods
    const methodPatterns = [
      // Matches: "  async execute(", "  execute(", "  public execute(", "  static async execute("
      /^\s*(?:(?:public|private|protected|static|async|readonly)\s+)*(\w+)\s*(?:<.*>)?\s*\(/gm,
      // Matches: "  execute = async () =>" or "  execute = () =>"
      /^\s*(?:(?:public|private|protected|static|readonly)\s+)*(\w+)\s*=\s*(?:async\s*)?(?:\([^)]*\)|[a-zA-Z0-9_]+)\s*=>/gm,
      // Matches: "methodName: () =>" or "methodName: async () =>"
      /^\s*(\w+)\s*:\s*(?:async\s*)?\(/gm,
      // Getter methods: "get propertyName()"
      /^\s*(?:public|private|protected|static|readonly)?\s*get\s+(\w+)\s*\(/gm,
      // Setter methods: "set propertyName()"
      /^\s*(?:public|private|protected|static|readonly)?\s*set\s+(\w+)\s*\(/gm
    ];
    
    // Extract exported functions
    functionPatterns.forEach(pattern => {
      let match;
      while ((match = pattern.exec(fileContent)) !== null) {
        const name = match[1];
        if (name && !symbols.find(s => s.name === name && s.type === 'function')) {
          symbols.push({ name, type: 'function', exported: true });
        }
      }
    });
    
    // Extract non-exported functions (include all for LLM selection)
    nonExportedFunctionPatterns.forEach(pattern => {
      let match;
      while ((match = pattern.exec(fileContent)) !== null) {
        const name = match[1];
        // Skip if already added as exported
        if (name && !symbols.find(s => s.name === name && s.type === 'function')) {
          symbols.push({ name, type: 'function', exported: false });
        }
      }
    });
    
    // Extract classes
    classPatterns.forEach(pattern => {
      let match;
      while ((match = pattern.exec(fileContent)) !== null) {
        const name = match[1];
        if (name && !symbols.find(s => s.name === name && s.type === 'class')) {
          symbols.push({ name, type: 'class', exported: match[0].includes('export') });
        }
      }
    });
    
    // Extract methods (within classes)
    methodPatterns.forEach(pattern => {
      let match;
      while ((match = pattern.exec(fileContent)) !== null) {
        const name = match[1];
        if (name && !symbols.find(s => s.name === name && s.type === 'method')) {
          symbols.push({ name, type: 'method', exported: false });
        }
      }
    });
    
    return symbols;
  }

  /**
   * Refines a file-level epicenter into a symbol-level epicenter
   * by analyzing ALL files the agent read during investigation and asking an LLM
   * to pick the most relevant symbol across all files.
   * 
   * @param finalEpicenter - The final epicenter file path
   * @param filesAnalyzed - Array of all file paths the agent analyzed
   * @param finalMessage - The final solution text from PlanningAgent for context
   * @param model - The model to use for refinement (defaults to 'gpt-4o-mini')
   * @param logger - Optional logger for saving intermediate results
   * @returns Refined epicenter in format "filePath::symbolName" or original filePath if refinement fails
   */
  private async refineEpicenterSymbol(
    finalEpicenter: string,
    filesAnalyzed: string[],
    finalMessage: string,
    model: string = 'gpt-4o-mini',
    logger?: DebugSessionLogger
  ): Promise<string> {
    // If it's already a symbol (file::symbol), return as is
    if (finalEpicenter.includes('::')) return finalEpicenter;

    // Limit to max 10 files to avoid token explosion
    const filesToAnalyze = filesAnalyzed.slice(0, 10);
    if (filesToAnalyze.length === 0) {
      return finalEpicenter;
    }

    try {
      const analysisTool = this.toolRegistry.getTool('static-analysis');
      if (!analysisTool) return finalEpicenter;

      // 1. Get file structures from all analyzed files
      const fileSymbols: Array<{
        file: string;
        symbols: Array<{ name: string; type: string; exported: boolean }>;
      }> = [];

      for (const filePath of filesToAnalyze) {
        try {
          const structureResult = await analysisTool.execute({
            filePath: filePath,
            mode: 'source'
          });

          if (structureResult.success && structureResult.evidence && structureResult.evidence.length > 0) {
            const fileContent = structureResult.evidence[0]?.text || '';
            if (fileContent) {
              const symbols = this.extractSymbolsFromFile(fileContent, filePath);
              if (symbols.length > 0) {
                fileSymbols.push({ file: filePath, symbols });
              }
            }
          }
        } catch (e) {
          console.warn(`[Controller] Failed to analyze ${filePath} for symbol extraction:`, e);
          // Continue with other files
        }
      }

      if (fileSymbols.length === 0) {
        const outcome = 'No symbols extracted from analyzed files';
        if (logger) {
          logger.logEpicenterRefinement('', '', outcome, model, fileSymbols);
        }
        console.log(`[Controller] ${outcome}, returning original epicenter: ${finalEpicenter}`);
        return finalEpicenter; // Fallback if no symbols extracted
      }

      // 2. Build symbol list for LLM
      const symbolList = fileSymbols.map(({ file, symbols }) => {
        const symbolNames = symbols.map(s => {
          const prefix = s.exported ? 'exported ' : '';
          return `  - ${prefix}${s.type}: ${s.name}`;
        }).join('\n');
        return `File: ${file}\n${symbolNames}`;
      }).join('\n\n');

      // 3. Ask LLM to pick the winner across all files
      const prompt = `You are a code visualizer helping to identify the most relevant symbol for graph visualization.

I have a bug fix explanation:
"${finalMessage.substring(0, 800)}..."

The debugging agent analyzed these files during investigation:

${symbolList}

**CRITICAL TASK:** Identify the SINGLE most relevant function, class, or method name to visualize.

**Selection Criteria (in priority order):**
1. Which symbol is MOST DIRECTLY related to the bug fix described above?
2. Which symbol appears in the final epicenter file: ${finalEpicenter}?
3. Prefer exported symbols when multiple candidates exist (they are more likely entry points).

**OUTPUT FORMAT (STRICT):**
You MUST return your answer in EXACTLY one of these formats:
- "filePath::symbolName" (if a specific symbol is identified)
- "${finalEpicenter}" (if the whole file is relevant, no specific symbol)

**Examples of CORRECT format:**
- "src/auth.ts::login" (login function in auth.ts)
- "src/services/AuthService.ts::AuthService" (AuthService class)
- "src/utils/helpers.ts::validateInput" (validateInput function)
- "${finalEpicenter}" (whole file relevant)

**IMPORTANT:** Return ONLY the file path and symbol name. Do not include any explanation, reasoning, or additional text.`;

      console.log(`[Controller] Refining epicenter with model: ${model}`);
      console.log(`[Controller] Extracted ${fileSymbols.length} files with symbols`);

      const response = await this.llmProvider.chat({
        id: `epicenter-refine-${Date.now()}`,
        provider: 'auto',
        model: model,
        messages: [{ role: 'user', content: prompt }],
        maxTokens: 10000,
        metadata: {
          purpose: 'epicenter_refinement',
          sessionId: 'refinement'
        },
        createdAt: new Date(),
        updatedAt: new Date()
      });

      if (response.type !== 'success' || !response.payload || !('content' in response.payload)) {
        const outcome = `LLM call failed: ${response.type !== 'success' ? 'non-success response' : 'no payload'}`;
        if (logger) {
          logger.logEpicenterRefinement(prompt, '', outcome, model, fileSymbols);
        }
        console.warn(`[Controller] ${outcome}, returning original epicenter: ${finalEpicenter}`);
        return finalEpicenter;
      }

      const rawResponse = response.payload.content;
      const refined = rawResponse.trim().replace(/['"`]/g, '').trim();
      
      // Normalize paths for comparison
      const normalizePath = (p: string) => p.replace(/\\/g, '/').toLowerCase();
      const normalizedEpicenter = normalizePath(finalEpicenter);
      const normalizedFilesToAnalyze = filesToAnalyze.map(normalizePath);
      
      // Validate the response format
      let outcome = '';
      let finalResult = finalEpicenter;
      
      if (refined.includes('::')) {
        const [file, symbol] = refined.split('::');
        const normalizedFile = normalizePath(file.trim());
        
        if (!file || !symbol) {
          outcome = `Invalid format: missing file or symbol in "${refined}"`;
        } else if (symbol.length === 0) {
          outcome = `Invalid format: symbol is empty in "${refined}"`;
        } else if (symbol.length >= 100) {
          outcome = `Invalid format: symbol name too long (${symbol.length} chars) in "${refined}"`;
        } else {
          // Verify the file was in our analyzed list (more lenient matching)
          const isValidFile = normalizedFilesToAnalyze.some(f => 
            f === normalizedFile || 
            f.endsWith(normalizedFile) || 
            normalizedFile.endsWith(f) ||
            path.basename(f) === path.basename(normalizedFile)
          );
          
          if (isValidFile) {
            outcome = `Success: Refined epicenter to ${refined}`;
            finalResult = refined;
            console.log(`[Controller] ${outcome}`);
          } else {
            outcome = `File validation failed: "${file}" not found in analyzed files. Analyzed: ${filesToAnalyze.join(', ')}`;
          }
        }
      } else {
        const normalizedRefined = normalizePath(refined);
        // Check if it matches the epicenter or any analyzed file
        if (normalizedRefined === normalizedEpicenter || normalizedFilesToAnalyze.some(f => 
          f === normalizedRefined || 
          f.endsWith(normalizedRefined) ||
          normalizedRefined.endsWith(f)
        )) {
          outcome = `LLM returned file path (no symbol): ${refined}`;
          finalResult = refined;
        } else {
          outcome = `Invalid response: "${refined}" does not match epicenter or analyzed files`;
        }
      }
      
      // Log the refinement attempt
      if (logger) {
        logger.logEpicenterRefinement(prompt, rawResponse, outcome, model, fileSymbols);
      }
      
      return finalResult;
    } catch (e) {
      console.warn("[Controller] Failed to refine epicenter symbol", e);
    }
    
    return finalEpicenter; // Fallback to original file
  }

  /**
   * Load image prompt template from file
   */
  private loadImagePrompt(fileName: string): string {
    const candidates: string[] = [
      // In packaged extensions, __dirname points to the dist directory
      // Webpack copies src/agent/prompts/**/*.md to dist/prompts/**/*.md
      path.join(__dirname, 'prompts', 'image', fileName),
      // Check extension's out/prompts directory (for development - if copied)
      path.join(__dirname, '..', '..', '..', 'out', 'prompts', 'image', fileName),
      // Check extension's src/agent/prompts directory (for development)
      path.join(__dirname, '..', '..', '..', 'src', 'agent', 'prompts', 'image', fileName),
      // Alternative relative paths from controllers directory
      path.join(__dirname, '..', 'prompts', 'image', fileName),
      // Legacy fallback paths
      path.join(__dirname, '..', '..', 'prompts', 'image', fileName),
    ];

    // Add extension context path if available (like other services do)
    try {
      const extensionPath = vscode.extensions.getExtension('samurai-agent.samurai-agent')?.extensionPath;
      if (extensionPath) {
        candidates.push(
          path.join(extensionPath, 'dist', 'prompts', 'image', fileName),
          path.join(extensionPath, 'out', 'prompts', 'image', fileName),
          path.join(extensionPath, 'src', 'agent', 'prompts', 'image', fileName)
        );
      }
    } catch (error) {
      // Extension context not available, continue with other paths
    }

    for (const candidate of candidates) {
      if (fs.existsSync(candidate)) {
        console.log(`[DebugController] Found image prompt file at: ${candidate}`);
        return fs.readFileSync(candidate, 'utf-8');
      }
    }

    // Fallback template if file not found
    console.warn(`[DebugController] Image prompt file not found, using fallback template`);
    console.warn(`[DebugController] __dirname: ${__dirname}`);
    console.warn(`[DebugController] Checked ${candidates.length} paths:`, candidates);
    return `You are an expert Technical Illustrator.

The user has a software bug.

Root Cause Analysis:

"{{ROOT_CAUSE}}"

**Task:** Write a detailed prompt for an Image Generation AI to create a high-level **System Diagram** explaining this bug.

**Visual Guidelines:**

- Style: Minimalist, flat vector art, technical schematic, white background.

- Elements: Use simple boxes for components (e.g. "Backend", "Frontend", "Database").

- Action: Use arrows to show data flow.

- Color: Use **RED** to highlight the specific step where the failure happens. Use **GREEN** or **BLUE** for working parts.

- **Constraint:** Do NOT ask for text inside the image. Image models are bad at text. Describe visual icons instead (e.g. "a database icon", "a broken link icon").

**Output:** Just the prompt string for the image generator.`;
  }
}
