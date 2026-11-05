import * as vscode from "vscode";
import * as path from "path";
import * as fs from "fs";
import { DataStore } from "../persistence/dataStore";
import { GlobalDataStore } from "../persistence/globalDataStore";
import { toAvailableModels } from "../common/utils/llmEntries";
import { handleLlmEntryCommand, isLlmEntryCommand } from "./llmEntryCommands";
import { LLMProviderService } from "../agent/llm/llmProviderService";
import { ProjectDetailService } from "../agent/memory/projectDetailService";
import { TreeSitterLoaderService } from "../agent/code_parser/TreeSitterLoaderService";
import { ExtractCodeTool } from "../agent/tools/extractCodeTool";
import { ChatMessage, MessageType, Session } from "../common/models/chat-models";
import { LLMCostStorage, LLMCostRecord } from "../storage/llmCostStorage";
import { DebugSessionController } from "../agent/controllers/DebugSessionController";
import { setSyncingSettings } from "../extension";

// Resolve each asset to whichever folder actually has that file
const assetUri = (
  webview: vscode.Webview,
  extUri: vscode.Uri,
  filename: string,
): vscode.Uri => {
  // Check in order: dist (production), out (development), src (fallback)
  const dist = vscode.Uri.joinPath(extUri, "dist", "webview", filename);
  const out = vscode.Uri.joinPath(extUri, "out", "webview", filename);
  const src = vscode.Uri.joinPath(extUri, "src", "webview", filename);
  
  if (fs.existsSync(dist.fsPath)) {
    return webview.asWebviewUri(dist);
  } else if (fs.existsSync(out.fsPath)) {
    return webview.asWebviewUri(out);
  } else {
    return webview.asWebviewUri(src);
  }
};

export interface SamuraiAgentPanelDependencies {
  llmProviderService: LLMProviderService;
  projectDetailService?: ProjectDetailService;
  dataStore?: DataStore;
  globalDataStore: GlobalDataStore;
  treeSitterLoaderService?: TreeSitterLoaderService;
  extractCodeTool?: ExtractCodeTool;
  llmCostStorage?: LLMCostStorage;
  debugSessionController?: DebugSessionController;
  editBurstTracker?: { enable(): void; disable(): void };
}

export class SamuraiAgentPanelWebviewViewProvider
  implements vscode.WebviewViewProvider
{
  public static readonly viewType = "samurai-agent.agentPanel";
  private dataStore: DataStore | undefined;
  private globalDataStore: GlobalDataStore;
  private llmProviderService: LLMProviderService;
  private projectDetailService: ProjectDetailService | undefined;
  private treeSitterLoaderService: TreeSitterLoaderService | undefined;
  private extractCodeTool: ExtractCodeTool | undefined;
  private llmCostStorage: LLMCostStorage | undefined;
  private debugSessionController: DebugSessionController | undefined;
  private editBurstTracker: { enable(): void; disable(): void } | undefined;
  private _webviewView: vscode.WebviewView | undefined;
  private _messageQueue: any[] = []; // Queue for messages sent before view is ready
  private _webviewReady: boolean = false; // Track if webview has sent ready signal
  private _readyTimeoutHandle: NodeJS.Timeout | undefined; // Fallback timeout handle

  constructor(
    private readonly _extensionUri: vscode.Uri,
    dependencies: SamuraiAgentPanelDependencies,
  ) {
    this.llmProviderService = dependencies.llmProviderService;
    this.projectDetailService = dependencies.projectDetailService;
    this.dataStore = dependencies.dataStore;
    this.globalDataStore = dependencies.globalDataStore;
    this.treeSitterLoaderService = dependencies.treeSitterLoaderService;
    this.extractCodeTool = dependencies.extractCodeTool;
    this.llmCostStorage = dependencies.llmCostStorage;
    this.debugSessionController = dependencies.debugSessionController;
    this.editBurstTracker = dependencies.editBurstTracker;
  }

  public resolveWebviewView(
    webviewView: vscode.WebviewView,
    context: vscode.WebviewViewResolveContext,
    _token: vscode.CancellationToken,
  ) {
    this._webviewView = webviewView;
    this._webviewReady = false; // Reset ready state for new webview instance
    
    // Clear any existing fallback timeout from previous webview instance
    if (this._readyTimeoutHandle) {
      clearTimeout(this._readyTimeoutHandle);
      this._readyTimeoutHandle = undefined;
    }
    
    console.log("Webview Provider: resolveWebviewView called");
    console.log("Webview Provider: webviewView visible:", webviewView.visible);

    // Flush queued messages now that the view is ready
    if (this._messageQueue.length > 0) {
      console.log(`[Webview Provider] Flushing ${this._messageQueue.length} queued messages`);
      while (this._messageQueue.length > 0) {
        const msg = this._messageQueue.shift();
        webviewView.webview.postMessage(msg);
      }
    }

    // Allow dist, out, and src roots for maximum compatibility
    const distRoot = vscode.Uri.joinPath(this._extensionUri, "dist", "webview");
    const srcRoot = vscode.Uri.joinPath(this._extensionUri, "src", "webview");
    const outRoot = vscode.Uri.joinPath(this._extensionUri, "out", "webview");

    // Add workspace root to allow access to debug-output images
    const workspaceRoots: vscode.Uri[] = [distRoot, srcRoot, outRoot];
    if (vscode.workspace.workspaceFolders && vscode.workspace.workspaceFolders.length > 0) {
      const workspaceRoot = vscode.Uri.file(vscode.workspace.workspaceFolders[0].uri.fsPath);
      workspaceRoots.push(workspaceRoot);
    }

    console.log("Webview Provider: Allowing all roots:", {
      dist: distRoot.toString(),
      src: srcRoot.toString(),
      out: outRoot.toString(),
      workspace: vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || 'none',
    });

    webviewView.webview.options = {
      enableScripts: true,
      enableCommandUris: true,
      localResourceRoots: workspaceRoots, // include workspace for debug-output access
    };

    webviewView.webview.html = this._getHtmlForWebview(webviewView.webview);
    console.log("Webview Provider: HTML set for webview");

    // Wait for webviewReady signal from webview instead of arbitrary timeout
    // The webview will send 'webviewReady' command when its message listener is initialized
    // Fallback timeout: if ready signal doesn't arrive within 2 seconds, send settings anyway
    this._readyTimeoutHandle = setTimeout(() => {
      if (!this._webviewReady) {
        console.log("Webview Provider: Fallback timeout reached, sending initialSettings anyway");
        this.sendInitialSettingsToWebview(webviewView.webview);
        this._readyTimeoutHandle = undefined;
      }
    }, 2000); // 2 second fallback timeout

    // Send a test message to verify communication
    setTimeout(() => {
      console.log("Webview Provider: Sending test message to webview");
      webviewView.webview.postMessage({
        type: "test",
        message: "Hello from webview provider!",
      });
    }, 200);

    // Set up message listener
    webviewView.webview.onDidReceiveMessage((message) =>
      this.handleWebviewMessage(webviewView.webview, message),
    );

    // Set up workspace change listener to notify webview
    const workspaceChangeDisposable = vscode.workspace.onDidChangeWorkspaceFolders(() => {
      const hasWorkspace = vscode.workspace.workspaceFolders && vscode.workspace.workspaceFolders.length > 0;
      console.log("Webview Provider: Workspace changed, hasWorkspace:", hasWorkspace);
      if (webviewView.webview) {
        webviewView.webview.postMessage({
          type: "workspaceStateChanged",
          payload: { hasWorkspace },
          timestamp: new Date(),
        });
      }
    });

    // Store disposable for cleanup (if needed)
    if (this._webviewView) {
      // Note: VS Code will handle cleanup when webview is disposed
    }

    // CRITICAL FIX: Add visibility change handler to re-initialize webview state
    webviewView.onDidChangeVisibility(() => {
      console.log("Webview Provider: Visibility changed, visible:", webviewView.visible);
      if (webviewView.visible) {
        // When webview becomes visible, re-send initial settings to refresh state
        console.log("Webview Provider: Webview became visible, re-initializing state");
        setTimeout(() => {
          this.sendInitialSettingsToWebview(webviewView.webview);
          
          // Also send a refresh message to trigger webview state refresh
          webviewView.webview.postMessage({
            type: "webviewRefresh",
            message: "Webview became visible, refreshing state",
            timestamp: new Date(),
          });
        }, 50); // Small delay to ensure webview is ready
      }
    });

    // Add debugging for script loading
    console.log("Webview Provider: Setting up webview with options:", {
      enableScripts: true,
      enableCommandUris: true,
      localResourceRoots: [distRoot.toString(), srcRoot.toString(), outRoot.toString()],
    });
  }

  /**
   * Public method to post messages to the webview
   * Queues messages if the view is not ready yet
   */
  public postMessage(message: any): void {
    if (this._webviewView && this._webviewView.webview) {
      // View is ready, send immediately
      this._webviewView.webview.postMessage(message);
      console.log('[Webview Provider] Message sent directly:', message.type);
    } else {
      // View not ready yet, queue the message
      this._messageQueue.push(message);
      console.log(`[Webview Provider] Message queued (queue size: ${this._messageQueue.length}):`, message.type);
    }
  }

  /**
   * Public method to ensure the webview is visible
   * Shows the view if it exists
   */
  public showView(): void {
    if (this._webviewView) {
      this._webviewView.show?.(true);
      console.log('[Webview Provider] View shown');
    } else {
      console.log('[Webview Provider] View not available yet');
    }
  }

  /**
   * Handles messages from the webview
   */
  private async handleWebviewMessage(webview: vscode.Webview, message: any) {
    const { command } = message;

    try {
      // Handle webviewReady signal
      if (command === "webviewReady") {
        console.log("Webview Provider: Received webviewReady signal from webview");
        this._webviewReady = true;
        
        // Clear fallback timeout if it exists
        if (this._readyTimeoutHandle) {
          clearTimeout(this._readyTimeoutHandle);
          this._readyTimeoutHandle = undefined;
        }
        
        // Send initial settings now that webview is ready
        this.sendInitialSettingsToWebview(webview);
        return;
      }

      // Get open files command
      if (command === "getOpenFiles") {
        const openFiles = vscode.workspace.textDocuments
          .filter(doc => !doc.isUntitled && doc.uri.scheme === 'file')
          .map(doc => doc.uri.fsPath);
        
        webview.postMessage({
          type: "success",
          requestId: message.requestId,
          payload: openFiles,
          timestamp: new Date()
        });
        return;
      }

      if (command === "searchWorkspaceFiles") {
        const { query, pinnedFiles } = message.payload ?? {};
        if (!query || typeof query !== 'string') {
          webview.postMessage({
            type: "success",
            requestId: message.requestId,
            payload: [],
            timestamp: new Date()
          });
          return;
        }

        const workspaceFolders = vscode.workspace.workspaceFolders;
        if (!workspaceFolders) {
          webview.postMessage({
            type: "success",
            requestId: message.requestId,
            payload: [],
            timestamp: new Date()
          });
          return;
        }

        // Get pinned files from payload
        const pinnedFilePaths = Array.isArray(pinnedFiles) ? pinnedFiles : [];
        
        // Get opened files
        const openFiles = vscode.workspace.textDocuments
          .filter(doc => !doc.isUntitled && doc.uri.scheme === 'file')
          .map(doc => doc.uri.fsPath);
        
        // Get active file folder for same-folder ranking
        const activeEditor = vscode.window.activeTextEditor;
        const activeFileFolder = activeEditor?.document.uri.fsPath 
          ? path.dirname(activeEditor.document.uri.fsPath) 
          : null;

        // Search workspace files (with exclusions)
        const excludePattern = '**/{node_modules,.git,dist,build,.next,coverage,out}/**';
        
        (async () => {
          try {
            // Search for files with query in filename
            const filenamePattern = `**/*${query}*`;
            const filenameFiles = await vscode.workspace.findFiles(
              filenamePattern,
              excludePattern,
              50 // Limit to 50 results for performance
            );
            
            // Search for files inside directories with query in name
            const directoryPattern = `**/*${query}*/**`;
            const directoryFiles = await vscode.workspace.findFiles(
              directoryPattern,
              excludePattern,
              50 // Limit to 50 results for performance
            );
            
            // Merge and deduplicate by file path
            const workspaceFilesSet = new Set<string>();
            filenameFiles.forEach(uri => workspaceFilesSet.add(uri.fsPath));
            directoryFiles.forEach(uri => workspaceFilesSet.add(uri.fsPath));
            const workspaceFiles = Array.from(workspaceFilesSet).map(path => vscode.Uri.file(path));
            
            // Rank and merge results
            const allFiles = new Map<string, { filePath: string, isPinned: boolean, isOpen: boolean, isSameFolder: boolean, isFilenameMatch: boolean }>();
            
            // Add workspace files
            workspaceFiles.forEach(uri => {
              const filePath = uri.fsPath;
              const fileName = path.basename(filePath).toLowerCase();
              const fileFolder = path.dirname(filePath);
              const queryLower = query.toLowerCase();
              
              if (fileName.includes(queryLower) || filePath.toLowerCase().includes(queryLower)) {
                const isFilenameMatch = fileName.includes(queryLower);
                allFiles.set(filePath, {
                  filePath,
                  isPinned: pinnedFilePaths.includes(filePath),
                  isOpen: openFiles.includes(filePath),
                  isSameFolder: activeFileFolder ? fileFolder === activeFileFolder : false,
                  isFilenameMatch: isFilenameMatch
                });
              }
            });

            // Sort by priority: pinned > open > same folder > filename match > directory match > alphabetical
            const rankedFiles = Array.from(allFiles.values()).sort((a, b) => {
              if (a.isPinned !== b.isPinned) return a.isPinned ? -1 : 1;
              if (a.isOpen !== b.isOpen) return a.isOpen ? -1 : 1;
              if (a.isSameFolder !== b.isSameFolder) return a.isSameFolder ? -1 : 1;
              if (a.isFilenameMatch !== b.isFilenameMatch) return a.isFilenameMatch ? -1 : 1;
              return a.filePath.localeCompare(b.filePath);
            });

            webview.postMessage({
              type: "success",
              requestId: message.requestId,
              payload: rankedFiles.slice(0, 30).map(f => f.filePath), // Return top 30 file paths
              timestamp: new Date()
            });
          } catch (error: unknown) {
            console.error('[WebviewProvider] Error searching workspace files:', error);
            webview.postMessage({
              type: "success",
              requestId: message.requestId,
              payload: [],
              timestamp: new Date()
            });
          }
        })();
        return;
      }

      // Handle regression detection toggle from webview settings/banner
      if (command === "regressionDetectionToggled") {
        const { enabled } = message.payload ?? {};
        console.log(`[Webview Provider] Regression detection toggled: ${enabled}`);
        if (this.editBurstTracker) {
          if (enabled) {
            this.editBurstTracker.enable();
          } else {
            this.editBurstTracker.disable();
          }
        }
        webview.postMessage({
          type: "success",
          requestId: message.requestId,
          payload: { toggled: true },
          timestamp: new Date()
        });
        return;
      }

      // Handle regression threshold change from webview settings
      if (command === "regressionThresholdChanged") {
        const { threshold } = message.payload ?? {};
        console.log(`[Webview Provider] Regression threshold changed: ${threshold}`);
        try {
          const config = vscode.workspace.getConfiguration('samurai-agent.regressionDetection');
          await config.update('riskThreshold', threshold, vscode.ConfigurationTarget.Global);
          webview.postMessage({
            type: "success",
            requestId: message.requestId,
            payload: { updated: true },
            timestamp: new Date()
          });
        } catch (error) {
          console.error('[Webview Provider] Failed to update regression threshold:', error);
          webview.postMessage({
            type: "error",
            requestId: message.requestId,
            error: error instanceof Error ? error.message : String(error),
            timestamp: new Date()
          });
        }
        return;
      }

      // Sandbox cleanup command
      if (command === "samurai-agent.cleanSandbox") {
        if (this.debugSessionController) {
          try {
            await this.debugSessionController.cleanSandbox();
            webview.postMessage({
              type: "success",
              requestId: message.requestId,
              payload: { cleaned: true },
              timestamp: new Date()
            });
          } catch (error) {
            console.error('[WebviewProvider] Failed to clean sandbox:', error);
            webview.postMessage({
              type: "error",
              requestId: message.requestId,
              error: `Failed to clean sandbox: ${error instanceof Error ? error.message : String(error)}`,
              timestamp: new Date()
            });
          }
        } else {
          console.warn('[WebviewProvider] Sandbox cleanup requested but debugSessionController unavailable');
          webview.postMessage({
            type: "error",
            requestId: message.requestId,
            error: "Sandbox cleanup unavailable",
            timestamp: new Date()
          });
        }
        return;
      }

      // Abort a running session's PlanningAgent execution
      if (command === "samurai-agent.abortSession") {
        const sessionId = message.payload?.sessionId;
        if (sessionId && this.debugSessionController) {
          this.debugSessionController.abortSession(sessionId);
          webview.postMessage({
            type: "success",
            requestId: message.requestId,
            payload: { aborted: true },
            timestamp: new Date()
          });
        } else {
          console.warn('[WebviewProvider] abortSession: missing sessionId or debugSessionController');
          webview.postMessage({
            type: "error",
            requestId: message.requestId,
            error: "Cannot abort session: missing sessionId or controller",
            timestamp: new Date()
          });
        }
        return;
      }

      // Fetch documentation URL command
      if (command === "fetchDocumentationUrl") {
        const { url, forceRefresh } = message.payload ?? {};
        if (!url) {
          webview.postMessage({
            type: "error",
            requestId: message.requestId,
            error: "URL is required",
            timestamp: new Date()
          });
          return;
        }

        try {
          const { fetchAndExtract, normalizeUrlForCache } = await import('../agent/utils/urlContentFetcher.js');
          
          // Check cache if not forcing refresh
          let cached: any = null;
          if (!forceRefresh && this.debugSessionController) {
            const sessionId = message.payload?.sessionId;
            if (sessionId) {
              const normalizedUrl = normalizeUrlForCache(url);
              const sessionCache = (this.debugSessionController as any).documentationCache?.get(sessionId);
              if (sessionCache) {
                cached = sessionCache.get(normalizedUrl);
              }
            }
          }

          if (cached && !forceRefresh) {
            // Return cached result
            const fetchedAt = cached.fetchedAt instanceof Date 
              ? cached.fetchedAt.toISOString() 
              : (typeof cached.fetchedAt === 'string' ? cached.fetchedAt : new Date().toISOString());
            webview.postMessage({
              type: "success",
              requestId: message.requestId,
              payload: {
                success: true,
                url: cached.url,
                title: cached.title,
                preview: cached.content.substring(0, 300),
                fetchedAt: fetchedAt
              },
              timestamp: new Date()
            });
            return;
          }

          // Fetch from URL
          const result = await fetchAndExtract(url);
          
          // Store in cache if sessionId provided
          if (this.debugSessionController && message.payload?.sessionId) {
            const sessionId = message.payload.sessionId;
            const normalizedUrl = normalizeUrlForCache(url);
            let sessionCache = (this.debugSessionController as any).documentationCache?.get(sessionId);
            if (!sessionCache) {
              sessionCache = new Map();
              (this.debugSessionController as any).documentationCache.set(sessionId, sessionCache);
            }
            sessionCache.set(normalizedUrl, {
              url: result.url,
              title: result.title,
              content: result.content,
              fetchedAt: result.fetchedAt
            });
          }

          webview.postMessage({
            type: "success",
            requestId: message.requestId,
            payload: {
              success: true,
              url: result.url,
              title: result.title,
              preview: result.content.substring(0, 300),
              fetchedAt: result.fetchedAt.toISOString()
            },
            timestamp: new Date()
          });
        } catch (error: any) {
          console.error('[WebviewProvider] Failed to fetch documentation:', error);
          
          // Provide user-friendly error messages
          let errorMessage = 'Failed to fetch documentation';
          if (error.message) {
            if (error.message.includes('Security:')) {
              errorMessage = `Security: ${error.message.replace('Security: ', '')}`;
            } else if (error.message.includes('timeout')) {
              errorMessage = 'Request timed out after 10 seconds';
            } else if (error.message.includes('redirect')) {
              errorMessage = 'Too many redirects (max 5 allowed)';
            } else if (error.message.includes('HTML content')) {
              errorMessage = 'URL does not return HTML content';
            } else if (error.message.includes('Invalid URL')) {
              errorMessage = 'Invalid URL format';
            } else {
              errorMessage = `Failed to fetch documentation: ${error.message}`;
            }
          }

          webview.postMessage({
            type: "error",
            requestId: message.requestId,
            error: errorMessage,
            timestamp: new Date()
          });
        }
        return;
      }

      // Open external URL in browser
      if (command === "openExternalUrl") {
        const { url } = message.payload ?? {};
        if (url && typeof url === 'string') {
          void vscode.env.openExternal(vscode.Uri.parse(url));
        }
        webview.postMessage({
          type: "success",
          requestId: message.requestId,
          timestamp: new Date()
        });
        return;
      }

      // Open file at line command (for debug visualization node clicks)
      if (command === "samurai-agent.openFileAtLine") {
        const { file, line } = message.payload ?? {};
        console.log('[DEBUG VIZ] openFileAtLine request received', {
          file,
          line,
          hasPayload: !!message.payload,
          requestId: message.requestId
        });
        if (file) {
          try {
            // Resolve workspace-relative paths
            let uri: vscode.Uri;
            if (vscode.workspace.workspaceFolders && !path.isAbsolute(file)) {
              uri = vscode.Uri.joinPath(
                vscode.workspace.workspaceFolders[0].uri,
                file
              );
            } else {
              uri = vscode.Uri.file(file);
            }
            
            const doc = await vscode.workspace.openTextDocument(uri);
            const options: vscode.TextDocumentShowOptions = {
              preview: false
            };
            
            // Line is 1-based in nodeLocationMap, convert to 0-based for VS Code
            if (typeof line === 'number' && line > 0) {
              const pos = new vscode.Position(line - 1, 0);
              options.selection = new vscode.Range(pos, pos);
            }
            
            await vscode.window.showTextDocument(doc, options);
            
            console.log('[DEBUG VIZ] openFileAtLine success', { file, line });

            webview.postMessage({
              type: "success",
              requestId: message.requestId,
              message: `Opened ${file} at line ${line || 1}`,
              timestamp: new Date()
            });
          } catch (error) {
            console.error('Error opening file at line:', error);
            webview.postMessage({
              type: "error",
              requestId: message.requestId,
              error: `Failed to open ${file} at line ${line || 1}: ${error instanceof Error ? error.message : String(error)}`,
              timestamp: new Date()
            });
          }
        }
        else {
          console.warn('[DEBUG VIZ] openFileAtLine invoked without file in payload:', message);
        }
        return;
      }

      // Open file command (for click-to-open from inline code)
      if (command === "openFile") {
        const { filePath } = message.payload ?? {};
        console.log('[WebviewProvider] openFile request received', {
          filePath,
          hasPayload: !!message.payload,
          requestId: message.requestId
        });
        
        if (filePath) {
          try {
            await vscode.commands.executeCommand('samurai-agent.openFile', filePath);
            webview.postMessage({
              type: "success",
              requestId: message.requestId,
              message: `Opened ${filePath}`,
              timestamp: new Date()
            });
          } catch (error) {
            console.error('[WebviewProvider] Error opening file:', error);
            webview.postMessage({
              type: "error",
              requestId: message.requestId,
              error: `Failed to open ${filePath}: ${error instanceof Error ? error.message : String(error)}`,
              timestamp: new Date()
            });
          }
        } else {
          console.warn('[WebviewProvider] openFile invoked without filePath in payload:', message);
          webview.postMessage({
            type: "error",
            requestId: message.requestId,
            error: "No file path provided",
            timestamp: new Date()
          });
        }
        return;
      }

      // Find variable in the active editor file using word-boundary search
      if (command === "findVariableInActiveFile") {
        const { variableName } = message.payload ?? {};

        if (!variableName || typeof variableName !== 'string') {
          webview.postMessage({
            type: "error",
            requestId: message.requestId,
            error: "No variable name provided",
            timestamp: new Date()
          });
          return;
        }

        const activeEditor = vscode.window.activeTextEditor;
        if (!activeEditor || !activeEditor.document) {
          webview.postMessage({
            type: "error",
            requestId: message.requestId,
            error: "No active editor available",
            timestamp: new Date()
          });
          return;
        }

        const document = activeEditor.document;
        const text = document.getText();

        // Escape regex special characters in the variable name
        const escapedVariable = variableName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const regex = new RegExp(`\\b${escapedVariable}\\b`, 'g');
        const match = regex.exec(text);

        if (!match) {
          webview.postMessage({
            type: "error",
            requestId: message.requestId,
            error: `Variable '${variableName}' not found in current file`,
            timestamp: new Date()
          });
          return;
        }

        const startPos = document.positionAt(match.index);
        const endPos = document.positionAt(match.index + variableName.length);
        const selection = new vscode.Range(startPos, endPos);

        try {
          await vscode.window.showTextDocument(document, {
            preview: false,
            selection
          });

          webview.postMessage({
            type: "success",
            requestId: message.requestId,
            message: `Navigated to '${variableName}'`,
            timestamp: new Date()
          });
        } catch (error) {
          console.error('[WebviewProvider] Failed to navigate to variable:', error);
          webview.postMessage({
            type: "error",
            requestId: message.requestId,
            error: `Failed to navigate to '${variableName}': ${error instanceof Error ? error.message : String(error)}`,
            timestamp: new Date()
          });
        }
        return;
      }

      // Generate concept image command
      if (command === "generateConceptImage") {
        const { sessionId, messageId, rootCauseText } = message.payload ?? {};
        if (sessionId && messageId && this.debugSessionController) {
          console.log('[WebviewProvider] Handling generateConceptImage request', { sessionId, messageId });
          this.debugSessionController.handleGenerateConceptImage(sessionId, messageId, rootCauseText)
            .catch(error => {
              console.error('[WebviewProvider] Failed to generate concept image:', error);
              webview.postMessage({
                type: "error",
                requestId: message.requestId,
                error: `Failed to generate image: ${error instanceof Error ? error.message : String(error)}`,
                timestamp: new Date()
              });
            });
        } else {
          console.warn('[WebviewProvider] generateConceptImage invoked without sessionId, messageId, or controller', { sessionId: !!sessionId, messageId: !!messageId });
          webview.postMessage({
            type: "error",
            requestId: message.requestId,
            error: "Session ID, message ID, or debug controller not available",
            timestamp: new Date()
          });
        }
        return;
      }

      // Direct agent execute command
      if (command === "samurai-agent.execute") {
        console.log('[COST DEBUG] WebviewProvider - Received samurai-agent.execute command', {
          hasDebugController: !!this.debugSessionController,
          hasDebugSessionController: !!this.debugSessionController,
          hasPayload: !!message.payload
        });
        
        if (message.payload?.userMessage && message.payload?.session) {
          const { userMessage, session, pinnedFilePaths, documentationUrl } = message.payload;
          
          // Update session with pinned files if provided
          if (pinnedFilePaths && Array.isArray(pinnedFilePaths)) {
            session.pinnedFilePaths = pinnedFilePaths;
            console.log('[Context File Pinning] Received pinned files:', pinnedFilePaths.length);
          } else if (!session.pinnedFilePaths) {
            session.pinnedFilePaths = [];
          }
          
          // Add documentation URL to userMessage metadata if provided
          if (documentationUrl && userMessage.metadata) {
            userMessage.metadata.documentationUrl = documentationUrl;
          }
          
          // Route to DebugSessionController (Fast Path) if available
          if (this.debugSessionController) {
            console.log('[WebviewProvider] Routing to DebugSessionController (Fast Path)');
            
            // Resolve workspace root
            const workspaceRoot = session.metadata?.connectedCodebasePath || 
                                 (vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || '');
            
            // Call controller's startSession method
            this.debugSessionController.startSession(userMessage, session, workspaceRoot)
              .then(async (result) => {
                // Handle cost tracking if available
                if (result.success && result.metadata?.cost !== undefined && result.metadata.cost > 0 && this.llmCostStorage) {
                  const modelUsed = session.metadata?.model || 'unknown';
                  
                  const costRecord: LLMCostRecord = {
                    id: `cost-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
                    timestamp: new Date().toISOString(),
                    provider: 'agent-execution',
                    model: modelUsed,
                    promptTokens: 0,
                    completionTokens: 0,
                    totalTokens: 0,
                    cost: result.metadata.cost,
                    requestId: `agent-${Date.now()}`,
                  };
                  
                  try {
                    await this.llmCostStorage.saveRecord(costRecord);
                  } catch (error) {
                    console.error('[COST DEBUG] WebviewProvider - Failed to save cost record:', error);
                  }
                }
                
                // Skip empty agent messages for fast path debugging sessions
                // Fast path sessions send the graph immediately and don't need an empty message
                const isFastPathEmpty = result.metadata?.fastPath === true && !result.message?.trim();
                
                // Skip backend save for fast path debugging sessions
                // The debugSessionFinished event will handle persistence with a consistent message ID
                // This prevents the "Three-Body Problem" of uncoordinated saves (backend + frontend success + frontend event)
                const isFastPathDebugging = result.metadata?.fastPath === true;
                
                if (!isFastPathEmpty) {
                  // Only save in backend if NOT a fast path debugging session
                  // Fast path debugging sessions will be saved via debugSessionFinished event
                  if (!isFastPathDebugging) {
                    // Save assistant message to database
                    const assistantMessage: ChatMessage = {
                      id: `assistant-${Date.now()}`,
                      sessionId: userMessage.sessionId,
                      projectId: userMessage.projectId,
                      type: MessageType.ASSISTANT,
                      content: result.message || 'No response',
                      role: 'assistant',
                      metadata: result.metadata || {},
                      isEdited: false,
                      createdAt: new Date(),
                      updatedAt: new Date()
                    };
                    
                    if (this.dataStore) {
                      try {
                        this.dataStore.handleWebviewMessage({
                          command: 'saveChatMessage',
                          payload: assistantMessage
                        });
                      } catch (error) {
                        console.error('[PERSISTENCE DEBUG] WebviewProvider - Error saving assistant message:', error);
                      }
                    }
                  }
                }

                // Always send success response to resolve the postCommand promise, even for fast path sessions.
                // The actual agent response will still arrive via debugSessionFinished.
                webview.postMessage({
                  type: "success",
                  requestId: message.requestId,
                  payload: {
                    content: result.message || 'No response',
                    metadata: {
                      ...(result.metadata || {}),
                      samuraiAgentResponse: true,
                      fastPath: isFastPathDebugging,
                    }
                  },
                  timestamp: new Date(),
                });
              })
              .catch(async (error: any) => {
                console.error('[WebviewProvider] DebugSessionController error, retrying once:', error);
                try {
                  const retryResult = await this.debugSessionController!.startSession(userMessage, session, workspaceRoot);
                  webview.postMessage({
                    type: "success",
                    requestId: message.requestId,
                    payload: {
                      content: retryResult.message || 'No response',
                      metadata: {
                        ...(retryResult.metadata || {}),
                        samuraiAgentResponse: true,
                        fastPath: retryResult.metadata?.fastPath === true,
                      }
                    },
                    timestamp: new Date(),
                  });
                } catch (retryError: any) {
                  console.error('[WebviewProvider] DebugSessionController retry also failed:', retryError);
                  webview.postMessage({
                    type: "error",
                    requestId: message.requestId,
                    error: retryError instanceof Error ? retryError.message : "Agent execution failed",
                    timestamp: new Date(),
                  });
                }
              });
          } else {
            webview.postMessage({
              type: "error",
              requestId: message.requestId,
              error: "Agent not available or invalid request",
              timestamp: new Date(),
            });
          }
        } else {
          webview.postMessage({
            type: "error",
            requestId: message.requestId,
            error: "Invalid request payload",
            timestamp: new Date(),
          });
        }
        return;
      }

      // Handle pin file command (from extension command)
      if (command === "pinFile" || message.type === "pinFile") {
        const filePath = message.filePath || message.payload?.filePath;
        console.log('[PIN FILE] WebviewProvider - Received pinFile command', {
          filePath,
          hasFilePath: !!filePath
        });
        
        if (filePath) {
          // Send message to webview to add the pinned file
          webview.postMessage({
            type: "pinFile",
            filePath: filePath,
            timestamp: new Date()
          });
          
          console.log('[PIN FILE] Sent pinFile message to webview:', filePath);
        } else {
          console.warn('[PIN FILE] No file path provided in pinFile command');
        }
        return;
      }

      // Handle debug feedback command
      if (command === "debugFeedback") {
        console.log('[FEEDBACK] WebviewProvider - Received debugFeedback command', {
          hasPayload: !!message.payload,
          result: message.payload?.result
        });
        
        if (message.payload) {
          try {
            // Import feedback components
          const { FeedbackStore } = await import('../agent/tools/feedback/FeedbackStore.js');
          const { FeedbackCollector } = await import('../agent/tools/feedback/FeedbackCollector.js');
            
            // Get workspace root
            const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || '';
            if (!workspaceRoot) {
              throw new Error('No workspace found');
            }
            
            // Initialize feedback components
            const feedbackStore = new FeedbackStore(workspaceRoot);
            const feedbackCollector = new FeedbackCollector(feedbackStore, workspaceRoot);
            
            // Get current git commit hash
            let commitHash: string | undefined;
            try {
              const { execSync } = await import('child_process');
              commitHash = execSync('git rev-parse HEAD', { 
                cwd: workspaceRoot, 
                encoding: 'utf8' 
              }).trim();
            } catch (gitError) {
              console.warn('[FEEDBACK] Could not get git commit hash:', gitError);
            }
            
            // Record feedback
            await feedbackCollector.record(message.payload, commitHash);
            
            webview.postMessage({
              type: "success",
              requestId: message.requestId,
              payload: { success: true },
              timestamp: new Date()
            });
            
          } catch (error) {
            console.error('[FEEDBACK] Failed to record feedback:', error);
            webview.postMessage({
              type: "error",
              requestId: message.requestId,
              error: `Failed to record feedback: ${error instanceof Error ? error.message : 'Unknown error'}`,
              timestamp: new Date()
            });
          }
        } else {
          webview.postMessage({
            type: "error",
            requestId: message.requestId,
            error: "No feedback payload provided",
            timestamp: new Date()
          });
        }
        return;
      }

      if (command === "projectDetail.ingest") {
        console.log("Webview Provider: Received projectDetail.ingest command", {
          hasDebugSessionController: !!this.debugSessionController,
          payload: message.payload,
          requestId: message.requestId,
        });
        const commandPromise = vscode.commands.executeCommand(
          "samurai-agent.projectDetail.ingest",
          message.payload,
        );
        if (commandPromise && typeof commandPromise.then === "function") {
          commandPromise.then(
            (result: unknown) => {
              console.log(
                "Webview Provider: projectDetail.ingest success",
                message.requestId,
              );
              webview.postMessage({
                type: "success",
                requestId: message.requestId,
                payload: { finalText: result },
                timestamp: new Date(),
              });
            },
            (error: unknown) => {
              console.error(
                "Webview Provider: projectDetail.ingest error",
                error,
              );
              webview.postMessage({
                type: "error",
                requestId: message.requestId,
                error:
                  error instanceof Error
                    ? error.message
                    : "Project detail ingestion failed",
                timestamp: new Date(),
              });
            },
          );
        }
        return;
      }

      // Route global settings commands to GlobalDataStore
      if (
        command === "loadGlobalSettings" ||
        command === "saveGlobalSettings"
      ) {
        if (!this.globalDataStore) {
          console.error("GlobalDataStore not initialized");
          webview.postMessage({
            type: "error",
            requestId: message.requestId,
            error: "GlobalDataStore not initialized",
            timestamp: new Date(),
          });
          return;
        }

        let response;
        if (command === "loadGlobalSettings") {
          response = this.globalDataStore.loadGlobalSettings(message.requestId);
        } else {
          // Capture old regression detection state before saving
          const oldSettings = this.globalDataStore.loadGlobalSettings().payload;
          const wasEnabled = oldSettings?.enableRegressionDetection ?? false;

          response = this.globalDataStore.saveGlobalSettings(
            message.payload,
            message.requestId,
          );

          console.log("Webview Provider: Save response:", response.type);

          // If save was successful, notify all tabs that global settings have been updated
          if (response.type === "success") {
            // Sync enableDebugLogging to VS Code config for native Settings UI
            try {
              setSyncingSettings(true);
              const config = vscode.workspace.getConfiguration('samurai-agent');
              await config.update('enableDebugLogging', response.payload?.enableDebugLogging ?? false, vscode.ConfigurationTarget.Global);
              console.log('[Webview Provider] Synced enableDebugLogging to VS Code config');
            } catch (syncError) {
              console.warn('[Webview Provider] Failed to sync settings to VS Code config:', syncError);
            } finally {
              setSyncingSettings(false);
            }

            // Sync editBurstTracker if regression detection changed
            const nowEnabled = response.payload?.enableRegressionDetection ?? false;
            if (nowEnabled !== wasEnabled && this.editBurstTracker) {
              console.log(`[Webview Provider] Regression detection changed via save: ${nowEnabled}`);
              if (nowEnabled) {
                this.editBurstTracker.enable();
              } else {
                this.editBurstTracker.disable();
              }
            }
            console.log(
              "Webview Provider: Sending globalSettingsUpdated notification",
            );
            
            // Get updated available models based on new settings
            const updatedGlobalSettings = response.payload;
            const updatedAvailableModels = this.getAvailableModels(updatedGlobalSettings);
            
            console.log('[Backend] Updated available models after settings save:', {
              modelCount: updatedAvailableModels.length,
              modelIds: updatedAvailableModels.map(m => m.id)
            });
            
            webview.postMessage({
              type: "globalSettingsUpdated",
              payload: {
                globalSettings: updatedGlobalSettings,
                availableModels: updatedAvailableModels
              },
              timestamp: new Date(),
            });
          }
        }
        webview.postMessage(response);
        return;
      }

      // BYOK model entries: keys go to SecretStorage, metadata to global settings
      if (isLlmEntryCommand(command)) {
        await this.handleLlmEntryMessage(webview, message);
        return;
      }

      // Handle cost statistics command
      if (command === "samurai-agent.getCostStatistics") {
        const commandPromise = vscode.commands.executeCommand(command);
        if (commandPromise && typeof commandPromise.then === "function") {
          commandPromise.then(
            (result: unknown) => {
              webview.postMessage({
                type: "success",
                requestId: message.requestId,
                payload: result,
                timestamp: new Date(),
              });
            },
            (error: unknown) => {
              webview.postMessage({
                type: "error",
                requestId: message.requestId,
                error: error instanceof Error ? error.message : "Failed to get cost statistics",
                timestamp: new Date(),
              });
            }
          );
        }
        return;
      }

      // Handle backend monthly cost command
      if (command === "samurai-agent.getBackendMonthlyCost") {
        const commandPromise = vscode.commands.executeCommand(command);
        if (commandPromise && typeof commandPromise.then === "function") {
          commandPromise.then(
            (result: unknown) => {
              webview.postMessage({
                type: "success",
                requestId: message.requestId,
                payload: result,
                timestamp: new Date(),
              });
            },
            (error: unknown) => {
              webview.postMessage({
                type: "error",
                requestId: message.requestId,
                error: error instanceof Error ? error.message : "Failed to get backend monthly cost",
                timestamp: new Date(),
              });
            }
          );
        }
        return;
      }

      // Handle open folder command
      if (command === "workbench.action.files.openFolder") {
        const commandPromise = vscode.commands.executeCommand(command);
        if (commandPromise && typeof commandPromise.then === "function") {
          commandPromise.then(
            () => {
              // Check if workspace was opened successfully
              const hasWorkspace = vscode.workspace.workspaceFolders && vscode.workspace.workspaceFolders.length > 0;
              webview.postMessage({
                type: "success",
                requestId: message.requestId,
                payload: { workspaceOpened: hasWorkspace },
                timestamp: new Date(),
              });
            },
            (error: unknown) => {
              webview.postMessage({
                type: "error",
                requestId: message.requestId,
                error: error instanceof Error ? error.message : "Failed to open folder",
                timestamp: new Date(),
              });
            }
          );
        } else {
          // If command doesn't return a promise, execute it anyway
          Promise.resolve(vscode.commands.executeCommand(command)).then(() => {
            const hasWorkspace = vscode.workspace.workspaceFolders && vscode.workspace.workspaceFolders.length > 0;
            webview.postMessage({
              type: "success",
              requestId: message.requestId,
              payload: { workspaceOpened: hasWorkspace },
              timestamp: new Date(),
            });
          }).catch((error: unknown) => {
            webview.postMessage({
              type: "error",
              requestId: message.requestId,
              error: error instanceof Error ? error.message : "Failed to open folder",
              timestamp: new Date(),
            });
          });
        }
        return;
      }

      // Route namespaced persistence commands to DataStore
      if (command?.startsWith("samurai-agent.persistence.")) {
        if (!this.dataStore) {
          console.error("DataStore not initialized - no workspace folder open");
          webview.postMessage({
            type: "error",
            requestId: message.requestId,
            error: "Please open a workspace folder to start using Samurai Agent",
            timestamp: new Date(),
          });
          return;
        }

        const mappedMessage = {
          ...message,
          command: command.replace("samurai-agent.persistence.", ""),
        };
        const response = this.dataStore.handleWebviewMessage(mappedMessage);
        webview.postMessage(response);
        return;
      }

      // Route all other commands to DataStore (project-specific)
      if (!this.dataStore) {
        console.error("DataStore not initialized - no workspace folder open");
        webview.postMessage({
          type: "error",
          requestId: message.requestId,
          error: "Please open a workspace folder to start using Samurai Agent",
          timestamp: new Date(),
        });
        return;
      }

      const response = this.dataStore.handleWebviewMessage(message);
      webview.postMessage(response);
    } catch (error) {
      console.error("Error handling webview message:", error);
      webview.postMessage({
        type: "error",
        requestId: message.requestId,
        error:
          error instanceof Error ? error.message : "Unknown error occurred",
        timestamp: new Date(),
      });
    }
  }

  private async handleLLMChat(webview: vscode.Webview, message: any) {
    const { requestId, payload } = message;
    try {
      const response = await this.llmProviderService.chat(payload);
      webview.postMessage({
        type: "success",
        requestId,
        payload: response,
        timestamp: new Date(),
      });
    } catch (error) {
      webview.postMessage({
        type: "error",
        requestId,
        error: error instanceof Error ? error.message : "LLM chat failed",
        timestamp: new Date(),
      });
    }
  }

  private async handleProjectDetailIngest(
    webview: vscode.Webview,
    message: any,
  ) {
    const { requestId, payload } = message;
    try {
      const finalText = await this.projectDetailService?.ingestProjectDetail(
        payload.projectId,
        payload.rawText,
        payload.mode,
      );

      webview.postMessage({
        type: "success",
        requestId,
        payload: { finalText },
        timestamp: new Date(),
      });
    } catch (error) {
      webview.postMessage({
        type: "error",
        requestId,
        error:
          error instanceof Error ? error.message : "Unknown error occurred",
        timestamp: new Date(),
      });
    }
  }

  private _getHtmlForWebview(webview: vscode.Webview) {
    // Generate a nonce for CSP
    const nonce =
      Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2);

    // Resolve each asset to whichever folder actually has that file
    const agentPanelCssPath = assetUri(
      webview,
      this._extensionUri,
      "agentPanel.css",
    );
    const agentPanelJsPath = assetUri(
      webview,
      this._extensionUri,
      "agentPanel.js",
    );
    const chatCssPath = assetUri(webview, this._extensionUri, "chat.css");
    const chatJsPath = assetUri(webview, this._extensionUri, "chat.js");
    const statusLogCssPath = assetUri(webview, this._extensionUri, "status-log.css");
    const statusLogJsPath = assetUri(webview, this._extensionUri, "status-log.js");
    const specCssPath = assetUri(webview, this._extensionUri, "spec.css");
    const specJsPath = assetUri(webview, this._extensionUri, "spec.js");
    const settingsCssPath = assetUri(
      webview,
      this._extensionUri,
      "settings.css",
    );
    const settingsJsPath = assetUri(webview, this._extensionUri, "settings.js");
    const webviewApiJsPath = assetUri(
      webview,
      this._extensionUri,
      "webviewApi.js",
    );
    const testJsPath = assetUri(webview, this._extensionUri, "test.js");

    console.log("Webview Provider: Asset paths:", {
      // CSS paths
      agentPanelCssPath: agentPanelCssPath.toString(),
      chatCssPath: chatCssPath.toString(),
      specCssPath: specCssPath.toString(),
      settingsCssPath: settingsCssPath.toString(),
      // JS paths
      webviewApiJsPath: webviewApiJsPath.toString(),
      agentPanelJsPath: agentPanelJsPath.toString(),
      chatJsPath: chatJsPath.toString(),
      specJsPath: specJsPath.toString(),
      settingsJsPath: settingsJsPath.toString(),
      testJsPath: testJsPath.toString(),
    });

    return `<!DOCTYPE html>
        <html lang="en">
        <head>
            <meta charset="UTF-8">
            <meta name="viewport" content="width=device-width, initial-scale=1.0">
            <meta http-equiv="Content-Security-Policy" content="
                default-src 'none';
                img-src ${webview.cspSource} https: data:;
                style-src ${webview.cspSource} 'unsafe-inline' https://cdnjs.cloudflare.com;
                font-src ${webview.cspSource};
                connect-src ${webview.cspSource} https:;
                script-src 'nonce-${nonce}' ${webview.cspSource} https://cdn.jsdelivr.net https://cdnjs.cloudflare.com https://tally.so;
                frame-src https://tally.so;
            ">
            <title>Samurai Agent Panel</title>
            <link href="${agentPanelCssPath}" rel="stylesheet">
            <link href="${chatCssPath}" rel="stylesheet">
            <link href="${statusLogCssPath}" rel="stylesheet">
            <link href="${specCssPath}" rel="stylesheet">
            <link href="${settingsCssPath}" rel="stylesheet">
            <link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/highlight.js/11.9.0/styles/github-dark.min.css">
            <style>
                /* Hide tab header to save space */
                .tab-header {
                    display: none !important;
                }
                
                /* Ensure chat content is visible by default when tabs are removed */
                #chat-content {
                    display: flex !important;
                }
                
                /* Make settings tab overlay chat tab completely */
                #setting-content {
                    position: absolute !important;
                    top: 0 !important;
                    left: 0 !important;
                    right: 0 !important;
                    bottom: 0 !important;
                    z-index: 1000 !important;
                    background-color: var(--vscode-editor-background) !important;
                }
                
                /* Ensure content area has relative positioning for absolute children */
                .content-area {
                    position: relative !important;
                }
                
                /* Chat Input Wrapper - Cursor-style integrated design */
                .chat-input-wrapper {
                    position: relative;
                    display: flex !important;
                    flex-direction: column !important;
                    background-color: var(--vscode-input-background) !important;
                    border: 1px solid var(--vscode-input-border) !important;
                    border-radius: 8px !important;
                    padding: 0 !important;
                    gap: 0 !important;
                    min-height: 60px !important;
                    box-shadow: 0 1px 2px rgba(0, 0, 0, 0.05) !important;
                }
                
                .chat-input-wrapper:focus-within {
                    border-color: var(--vscode-focusBorder) !important;
                    box-shadow: 0 0 0 1px var(--vscode-focusBorder) !important;
                }
                
                .chat-input-footer {
                    display: flex !important;
                    justify-content: flex-start !important;
                    align-items: center !important;
                    padding: 4px 8px !important;
                    gap: 8px !important;
                }
                
                .run-analysis-btn {
                    background-color: var(--vscode-button-background) !important;
                    color: var(--vscode-button-foreground) !important;
                    border: 1px solid var(--vscode-button-border) !important;
                    padding: 4px 12px !important;
                    border-radius: 4px !important;
                    font-size: var(--vscode-font-size) !important;
                    font-family: var(--vscode-font-family) !important;
                    cursor: pointer !important;
                    transition: background-color 0.2s ease !important;
                    margin-left: auto !important;
                    height: 24px !important;
                    display: flex !important;
                    align-items: center !important;
                    justify-content: center !important;
                }
                
                .run-analysis-btn:hover {
                    background-color: var(--vscode-button-hoverBackground) !important;
                }
                
                .run-analysis-btn:active {
                    background-color: var(--vscode-button-activeBackground) !important;
                }
                
                .chat-input-action-btn {
                    background: none !important;
                    border: none !important;
                    color: var(--vscode-foreground) !important;
                    padding: 0 12px !important;
                    cursor: pointer !important;
                    display: flex !important;
                    align-items: center !important;
                    justify-content: center !important;
                    font-size: 18px !important;
                    transition: background-color 0.15s ease !important;
                    flex-shrink: 0 !important;
                    opacity: 0.7 !important;
                    height: 24px !important;
                }
                
                .chat-input-action-btn:hover {
                    background-color: var(--vscode-list-hoverBackground) !important;
                    opacity: 1 !important;
                }
                
                .chat-input-action-btn:active {
                    background-color: var(--vscode-list-activeBackground) !important;
                    opacity: 1 !important;
                }
                
                .chat-input-with-actions {
                    border: none !important;
                    background: transparent !important;
                    padding: 8px 12px !important;
                    color: var(--vscode-input-foreground) !important;
                    font-family: var(--vscode-font-family) !important;
                    font-size: var(--vscode-font-size) !important;
                    outline: none !important;
                    min-height: 20px !important;
                    line-height: 1.5 !important;
                    width: 100% !important;
                    box-sizing: border-box !important;
                }
                
                .chat-input-with-actions::placeholder {
                    color: var(--vscode-input-placeholderForeground) !important;
                    opacity: 0.6 !important;
                }
                
                .chat-input-model-selector {
                    flex-shrink: 0 !important;
                    padding: 0 !important;
                    display: flex !important;
                    align-items: center !important;
                }
                
                .chat-input-dropdown {
                    border: none !important;
                    background: transparent !important;
                    color: var(--vscode-foreground) !important;
                    font-family: var(--vscode-font-family) !important;
                    font-size: 12px !important;
                    padding: 4px 28px 4px 12px !important;
                    cursor: pointer !important;
                    outline: none !important;
                    min-width: 120px !important;
                    max-width: 160px !important;
                    height: 24px !important;
                    appearance: none !important;
                    -webkit-appearance: none !important;
                    -moz-appearance: none !important;
                }
                
                .chat-input-dropdown:hover {
                    background-color: var(--vscode-list-hoverBackground) !important;
                }
                
                .chat-input-dropdown:focus {
                    background-color: var(--vscode-list-hoverBackground) !important;
                }
                
                /* Override any old styles that might interfere */
                #chatInput {
                    border: none !important;
                    background: transparent !important;
                    box-shadow: none !important;
                    border-radius: 0 !important;
                    margin: 0 !important;
                }
                
                /* Ensure wrapper children are properly structured */
                .chat-input-wrapper > input {
                    display: block !important;
                }
                
                .chat-input-wrapper > .chat-input-footer {
                    display: flex !important;
                }
                
                /* Pinned Files Section Styles */
                .pinned-files-section {
                    padding: 8px 10px;
                    background-color: var(--vscode-editor-background);
                    margin-bottom: 8px;
                }
                
                .pinned-files-header {
                    display: flex;
                    justify-content: space-between;
                    align-items: center;
                    margin-bottom: 6px;
                    font-size: 12px;
                }
                
                .pinned-files-count {
                    color: var(--vscode-descriptionForeground);
                }
                
                .pin-file-input {
                    width: 100%;
                    padding: 6px 8px;
                    border: 1px solid var(--vscode-input-border);
                    border-radius: 3px;
                    background-color: var(--vscode-input-background);
                    color: var(--vscode-input-foreground);
                    font-size: 12px;
                }
                
                .file-autocomplete-dropdown {
                    position: absolute;
                    background-color: var(--vscode-dropdown-background);
                    border: 1px solid var(--vscode-dropdown-border);
                    border-radius: 3px;
                    max-height: 200px;
                    overflow-y: auto;
                    z-index: 1000;
                    width: calc(100% - 20px);
                }
                
                .autocomplete-item {
                    padding: 6px 10px;
                    cursor: pointer;
                }
                
                .autocomplete-item:hover {
                    background-color: var(--vscode-list-hoverBackground);
                }
                
                .file-name {
                    font-weight: 600;
                }
                
                .file-path {
                    font-size: 10px;
                    color: var(--vscode-descriptionForeground);
                    margin-left: 8px;
                }
                
                .pinned-files-list {
                    display: flex;
                    flex-wrap: wrap;
                    gap: 6px;
                    margin-top: 6px;
                }
                
                .pinned-file-chip {
                    display: inline-flex;
                    align-items: center;
                    gap: 6px;
                    padding: 4px 8px;
                    background-color: var(--vscode-badge-background);
                    color: var(--vscode-badge-foreground);
                    border-radius: 12px;
                    font-size: 11px;
                }
                
                .chip-remove {
                    background: none;
                    border: none;
                    color: var(--vscode-badge-foreground);
                    cursor: pointer;
                    font-size: 16px;
                    line-height: 1;
                    padding: 0;
                    margin: 0;
                }
                
                .chip-remove:hover {
                    opacity: 0.7;
                }
                
                /* Pinned File Warning Styles */
                .pinned-file-warning {
                    display: flex;
                    flex-direction: column;
                    gap: 8px;
                    padding: 10px 12px;
                    margin-top: 8px;
                    background-color: var(--vscode-inputValidation-warningBackground);
                    border: 1px solid var(--vscode-inputValidation-warningBorder);
                    border-radius: 4px;
                    font-size: 12px;
                    color: var(--vscode-foreground);
                }
                
                .warning-icon {
                    margin-right: 4px;
                    color: var(--vscode-inputValidation-warningBorder);
                }
                
                .warning-text {
                    line-height: 1.4;
                    font-weight: 500;
                    color: var(--vscode-foreground);
                }
                
                .warning-actions {
                    display: flex;
                    gap: 8px;
                    margin-top: 4px;
                }
                
                .warning-action-btn,
                .warning-dismiss-btn {
                    padding: 6px 12px;
                    border: 1px solid var(--vscode-button-border);
                    border-radius: 3px;
                    background-color: var(--vscode-button-background);
                    color: var(--vscode-button-foreground);
                    cursor: pointer;
                    font-size: 11px;
                    font-weight: 500;
                }
                
                .warning-action-btn:hover,
                .warning-dismiss-btn:hover {
                    background-color: var(--vscode-button-hoverBackground);
                }
                
                .warning-dismiss-btn {
                    background-color: transparent;
                    color: var(--vscode-foreground);
                }
                
                .warning-dismiss-btn:hover {
                    background-color: var(--vscode-list-hoverBackground);
                }
                
                /* Context Panel Styles */
                .context-panel {
                    margin-top: 8px;
                    padding: 12px;
                    background-color: var(--vscode-editor-background);
                    border: 1px solid var(--vscode-panel-border);
                    border-radius: 6px;
                    display: flex;
                    flex-direction: column;
                    gap: 12px;
                }
                
                .context-panel-header {
                    display: flex;
                    justify-content: space-between;
                    align-items: flex-start;
                    margin-bottom: 4px;
                }
                
                .context-panel-title {
                    display: flex;
                    flex-direction: column;
                    gap: 4px;
                }
                
                .context-panel-title-text {
                    font-size: 13px;
                    font-weight: 600;
                    color: var(--vscode-foreground);
                }
                
                .context-panel-subtitle {
                    font-size: 11px;
                    color: var(--vscode-descriptionForeground);
                    line-height: 1.4;
                }
                
                .hide-context-btn {
                    background: none;
                    border: none;
                    color: var(--vscode-foreground);
                    cursor: pointer;
                    font-size: 18px;
                    padding: 0;
                    width: 24px;
                    height: 24px;
                    display: flex;
                    align-items: center;
                    justify-content: center;
                    opacity: 0.7;
                    transition: opacity 0.2s;
                }
                
                .hide-context-btn:hover {
                    opacity: 1;
                    background-color: var(--vscode-list-hoverBackground);
                    border-radius: 3px;
                }
                
                .context-panel-content {
                    display: flex;
                    flex-direction: column;
                    gap: 16px;
                }
                
                .context-section {
                    display: flex;
                    flex-direction: column;
                    gap: 8px;
                }
                
                .context-section-header {
                    display: flex;
                    align-items: center;
                }
                
                .context-section-label {
                    font-size: 12px;
                    font-weight: 500;
                    color: var(--vscode-foreground);
                    cursor: default;
                }
                
                .log-input {
                    width: 100%;
                    padding: 8px;
                    border: 1px solid var(--vscode-input-border);
                    border-radius: 3px;
                    background-color: var(--vscode-input-background);
                    color: var(--vscode-input-foreground);
                    font-family: var(--vscode-font-family);
                    font-size: 12px;
                    min-height: 80px;
                    resize: vertical;
                    box-sizing: border-box;
                }
                
                .log-input::placeholder {
                    color: var(--vscode-input-placeholderForeground);
                    opacity: 0.6;
                }
                
                .clear-log-btn {
                    align-self: flex-start;
                    padding: 6px 12px;
                    border: 1px solid var(--vscode-button-border);
                    border-radius: 3px;
                    background-color: var(--vscode-button-secondaryBackground);
                    color: var(--vscode-button-secondaryForeground);
                    font-size: 11px;
                    cursor: pointer;
                    transition: background-color 0.2s;
                }
                
                .clear-log-btn:hover {
                    background-color: var(--vscode-button-secondaryHoverBackground);
                }
                
                .documentation-url-input-container {
                    display: flex;
                    gap: 6px;
                    align-items: center;
                }
                
                .documentation-url-input {
                    flex: 1;
                    padding: 6px 8px;
                    border: 1px solid var(--vscode-input-border);
                    border-radius: 3px;
                    background-color: var(--vscode-input-background);
                    color: var(--vscode-input-foreground);
                    font-size: 12px;
                }
                
                .documentation-refresh-btn {
                    padding: 6px 12px;
                    border: 1px solid var(--vscode-button-border);
                    border-radius: 3px;
                    background-color: var(--vscode-button-background);
                    color: var(--vscode-button-foreground);
                    font-size: 11px;
                    cursor: pointer;
                }
                
                .documentation-refresh-btn:hover {
                    background-color: var(--vscode-button-hoverBackground);
                }
                
                .documentation-refresh-btn:disabled {
                    opacity: 0.5;
                    cursor: not-allowed;
                }
                
                .documentation-preview {
                    margin-top: 8px;
                    padding: 8px;
                    background-color: var(--vscode-editor-background);
                    border: 1px solid var(--vscode-panel-border);
                    border-radius: 3px;
                    font-size: 11px;
                }
                
                .documentation-preview-header {
                    display: flex;
                    justify-content: space-between;
                    align-items: center;
                    margin-bottom: 6px;
                }
                
                .documentation-domain-badge {
                    display: inline-block;
                    padding: 2px 6px;
                    background-color: var(--vscode-badge-background);
                    color: var(--vscode-badge-foreground);
                    border-radius: 3px;
                    font-size: 10px;
                    font-weight: 600;
                }
                
                .documentation-title {
                    font-weight: 600;
                    margin: 4px 0;
                    color: var(--vscode-foreground);
                }
                
                .documentation-preview-text {
                    color: var(--vscode-descriptionForeground);
                    margin: 4px 0;
                    max-height: 60px;
                    overflow: hidden;
                    text-overflow: ellipsis;
                }
                
                .documentation-meta {
                    font-size: 10px;
                    color: var(--vscode-descriptionForeground);
                    margin-top: 4px;
                }
                
                .documentation-remove-btn {
                    padding: 2px 6px;
                    border: 1px solid var(--vscode-button-border);
                    border-radius: 3px;
                    background-color: transparent;
                    color: var(--vscode-button-foreground);
                    font-size: 10px;
                    cursor: pointer;
                }
                
                .documentation-remove-btn:hover {
                    background-color: var(--vscode-button-hoverBackground);
                }
                
                .documentation-loading {
                    display: inline-block;
                    width: 12px;
                    height: 12px;
                    border: 2px solid var(--vscode-progressBar-background);
                    border-top-color: transparent;
                    border-radius: 50%;
                    animation: spin 1s linear infinite;
                }
                
                @keyframes spin {
                    to { transform: rotate(360deg); }
                }
                
                .documentation-error {
                    margin-top: 6px;
                    padding: 6px;
                    background-color: var(--vscode-inputValidation-errorBackground);
                    color: var(--vscode-errorForeground);
                    border: 1px solid var(--vscode-inputValidation-errorBorder);
                    border-radius: 3px;
                    font-size: 11px;
                }
                
                /* Hide tip hints */
                .chat-input-hint {
                    display: none !important;
                }
            </style>
        </head>
        <body>
            <div class="agent-panel-container">
                <!-- Content Areas -->
                <div class="content-area">
                    <!-- Chat Content -->
                    <div class="tab-content" id="chat-content">
                        <!-- Chat Header with Start New Conversation Button -->
                        <div class="chat-header">
                            <div class="session-switcher">
                                <button class="session-title-btn" id="session-title-btn" title="Switch session">
                                    <span class="session-title-text" id="session-title-text">New Conversation</span>
                                    <span class="session-title-chevron">▾</span>
                                </button>
                                <div class="session-dropdown" id="session-dropdown" style="display: none;">
                                    <div class="session-dropdown-list" id="session-dropdown-list"></div>
                                </div>
                            </div>
                            <div class="chat-header-actions">
                                <!-- HIDDEN: Show Code Visuals button - preserved for future use -->
                                <button class="show-code-visuals-btn" id="show-code-visuals-btn" style="display: none !important;">
                                    Show Code Visuals
                                </button>
                                <button class="start-new-conversation-btn" id="start-new-conversation-btn">
                                    Clear Chat
                                </button>
                                <button class="settings-btn" id="settings-btn" title="Settings">
                                    <span class="settings-icon">⚙️</span>
                                </button>
                            </div>
                        </div>
                        
                        <div class="chat-container">
                            <div class="chat-messages" id="chatMessages">
                                <!-- Messages will appear here -->
                            </div>
                            <div class="chat-input-container">
                                <!-- Pin Files Section (context modifier) -->
                                <div class="pinned-files-section">
                                    <div class="pinned-files-header">
                                        <label for="pin-file-input">Context (Pin relevant files to improve accuracy)</label>
                                        <span class="pinned-files-count" id="pinned-files-count">0/5</span>
                                    </div>
                                    <input type="text" 
                                           id="pin-file-input" 
                                           class="pin-file-input" 
                                           placeholder="Type @ to search open files..." />
                                    <div id="file-autocomplete" class="file-autocomplete-dropdown" style="display: none;"></div>
                                    <div id="pinned-files-list" class="pinned-files-list"></div>
                                </div>
                                
                                <div class="chat-input-wrapper">
                                    <!-- Chat Input Text Box -->
                                    <input type="text" id="chatInput" class="chat-input-with-actions" placeholder="Type your message here..." />
                                    
                                    <!-- Footer row for actions -->
                                    <div class="chat-input-footer">
                                        <button id="addContextBtn" class="chat-input-action-btn" title="Add context">📎</button>
                                        <div class="chat-input-model-selector">
                                            <select id="llm-model-select" class="chat-input-dropdown">
                                                <!-- Options will be populated dynamically based on configured API keys -->
                                            </select>
                                        </div>
                                        <button id="run-analysis-btn" class="run-analysis-btn">Run Analysis</button>
                                    </div>
                                </div>
                                
                                <!-- Context Panel (shown when Add context is clicked) -->
                                <div id="contextPanel" class="context-panel" style="display: none;">
                                    <div class="context-panel-header">
                                        <div class="context-panel-title">
                                            <span class="context-panel-title-text">Additional context (optional)</span>
                                            <span class="context-panel-subtitle">Add logs or documentation to improve root-cause accuracy.</span>
                                        </div>
                                        <button id="hideContextBtn" class="hide-context-btn">✕</button>
                                    </div>
                                    
                                    <div class="context-panel-content">
                                        <!-- Logs Section -->
                                        <div class="context-section">
                                            <div class="context-section-header">
                                                <label class="context-section-label">📋 Logs</label>
                                            </div>
                                            <textarea id="logInput" class="log-input" placeholder="Paste your logs here..."></textarea>
                                            <button id="clearLogBtn" class="clear-log-btn">Clear log</button>
                                        </div>
                                        
                                        <!-- Tech Documentation URL Section -->
                                        <div class="context-section">
                                            <div class="context-section-header">
                                                <label class="context-section-label">📚 Tech Documentation URL</label>
                                            </div>
                                            <div class="documentation-url-input-container">
                                                <input type="text" 
                                                       id="documentation-url-input" 
                                                       class="documentation-url-input" 
                                                       placeholder="Enter tech documentation URL (e.g., https://developer.mozilla.org/...)" />
                                                <button id="documentation-refresh-btn" class="documentation-refresh-btn" style="display: none;">Refresh</button>
                                            </div>
                                            <div id="documentation-loading" style="display: none; margin-top: 6px;">
                                                <span class="documentation-loading"></span>
                                                <span style="margin-left: 6px; font-size: 11px; color: var(--vscode-descriptionForeground);">Fetching documentation...</span>
                                            </div>
                                            <div id="documentation-error" class="documentation-error" style="display: none;"></div>
                                            <div id="documentation-preview" class="documentation-preview" style="display: none;">
                                                <div class="documentation-preview-header">
                                                    <span class="documentation-domain-badge" id="documentation-domain-badge"></span>
                                                    <button id="documentation-remove-btn" class="documentation-remove-btn">Remove</button>
                                                </div>
                                                <div class="documentation-title" id="documentation-title"></div>
                                                <div class="documentation-preview-text" id="documentation-preview-text"></div>
                                                <div class="documentation-meta" id="documentation-meta"></div>
                                            </div>
                                        </div>
                                    </div>
                                </div>
                                
                                <!-- Mode Dropdown (hidden by default, shown when needed) -->
                                <div class="chat-controls" style="display: none;">
                                    <div class="dropdown-container" style="display: none;">
                                        <label for="mode-select">Mode:</label>
                                        <select id="mode-select" class="dropdown">
                                            <option value="deep_bug_analysis" selected>Deep Bug Analysis</option>
                                            <option value="spec_planning">Spec Planning</option>
                                        </select>
                                    </div>
                                </div>
                            </div>
                        </div>
                    </div>
                    
                    <!-- Spec Content -->
                    <div class="tab-content" id="spec-content" style="display: none;">
                        <!-- Spec content will be dynamically rendered by spec.js -->
                    </div>
                    
                    <!-- Setting Content -->
                    <div class="tab-content" id="setting-content" style="display: none;">
                        <!-- Settings content will be dynamically rendered by settings.js -->
                    </div>
                </div>
                
                <!-- HIDDEN: Code Visuals Modal - preserved for future use -->
                <div id="code-visuals-modal" class="code-visuals-modal-overlay" style="display: none !important;">
                    <div class="code-visuals-modal">
                        <div class="code-visuals-header">
                            <h3>Code Visuals</h3>
                            <div class="code-visuals-zoom-controls">
                                <button class="code-visuals-zoom-btn" id="code-visuals-zoom-in" title="Zoom In (Ctrl/Cmd + Plus)">+</button>
                                <button class="code-visuals-zoom-btn" id="code-visuals-zoom-out" title="Zoom Out (Ctrl/Cmd + Minus)">−</button>
                                <button class="code-visuals-zoom-btn" id="code-visuals-zoom-reset" title="Reset Zoom (Ctrl/Cmd + 0)">0</button>
                            </div>
                            <button class="code-visuals-close" id="code-visuals-close">&times;</button>
                        </div>
                        <div class="code-visuals-content">
                            <div id="code-visuals-mermaid" class="code-visuals-mermaid"></div>
                            <div class="code-visuals-resize-handle" id="code-visuals-resize-handle"></div>
                            <div id="code-visuals-legend" class="code-visuals-legend"></div>
                        </div>
                    </div>
                </div>
                
            </div>
            <script nonce="${nonce}">
                console.log('Webview: JavaScript is working!');
                console.log('Webview: About to load external scripts...');
                
                // Test if we can access the DOM
                document.addEventListener('DOMContentLoaded', function() {
                    console.log('Webview: DOM is ready!');
                    console.log('Webview: All scripts should be loaded now');
                });
                
                // Listen for messages from the webview provider
                window.addEventListener('message', function(event) {
                    console.log('Webview: Received message:', event.data);
                    if (event.data.type === 'test') {
                        console.log('Webview: Test message received:', event.data.message);
                    }
                });
                
                // Comprehensive debugging for common issues
                console.log('Webview: Environment check:');
                console.log('- User agent:', navigator.userAgent);
                console.log('- Document ready state:', document.readyState);
                console.log('- Window location:', window.location.href);
                
                // Check for CSP violations
                window.addEventListener('error', function(event) {
                    if (event.message && event.message.includes('CSP')) {
                        console.error('Webview: CSP Error detected:', event.message);
                    }
                });
                
            </script>
            <script nonce="${nonce}" src="${testJsPath}"></script>
            <script nonce="${nonce}" src="${webviewApiJsPath}"></script>
            <script nonce="${nonce}" src="${agentPanelJsPath}"></script>
            <script nonce="${nonce}" src="${statusLogJsPath}"></script>
            <script src="https://cdnjs.cloudflare.com/ajax/libs/highlight.js/11.9.0/highlight.min.js"></script>
            <script nonce="${nonce}" src="${chatJsPath}"></script>
            <script nonce="${nonce}" src="${specJsPath}"></script>
            <script nonce="${nonce}" src="${settingsJsPath}"></script>
            
            <!-- Script loading debugging - runs after external scripts are parsed -->
            <script nonce="${nonce}">
                // Debug script loading after all scripts are parsed
                setTimeout(() => {
                    console.log('Webview: Checking script status...');
                    document.querySelectorAll('script[src]').forEach((script, index) => {
                        console.log('Webview: Script present:', script.getAttribute('src'));
                        // Note: load/error listeners may miss already-fired events
                        script.addEventListener('load', function() {
                            console.log('Webview: Script loaded successfully:', script.src);
                        });
                        script.addEventListener('error', function() {
                            console.error('Webview: Failed to load script:', script.src);
                        });
                    });
                    
                    // Check if key functions are available (indicates successful loading)
                    setTimeout(() => {
                        console.log('Webview: Checking for loaded functions...');
                        if (typeof window.WebviewApi !== 'undefined') {
                            console.log('Webview: ✅ WebviewApi is available');
                            console.log('Webview: WebviewApi methods:', Object.keys(window.WebviewApi));
                        } else {
                            console.log('Webview: ❌ WebviewApi is not available');
                            console.log('Webview: Available globals:', Object.keys(window).filter(k => k.startsWith('Webview') || k.startsWith('post')));
                        }
                        
                        // Check if other expected globals exist
                        if (typeof window.postCommand !== 'undefined') {
                            console.log('Webview: ✅ postCommand is available');
                        } else {
                            console.log('Webview: ❌ postCommand is not available');
                        }
                    }, 100);
                }, 0);
            </script>
            
            <!-- HIDDEN: Mermaid.js - preserved for future use -->
            <script src="https://cdn.jsdelivr.net/npm/mermaid@10/dist/mermaid.min.js"></script>
            <script nonce="${nonce}">
                if (typeof mermaid !== 'undefined') {
                    mermaid.initialize({
                        startOnLoad: false,
                        theme: 'base',
                        themeVariables: {
                            background: '#ffffff',
                            primaryColor: '#2563eb',
                            primaryTextColor: '#111827',
                            primaryBorderColor: '#1e40af'
                        }
                    });
                    console.log('Webview: Mermaid.js initialized');
                } else {
                    console.warn('Webview: Mermaid.js failed to load');
                }
            </script>
        </body>
        </html>`;
  }

  /**
   * Sends initial settings to the webview, including determining the initial primaryLLMModel
   */
  private async sendInitialSettingsToWebview(webview: vscode.Webview) {
    try {
      // Load global settings to check API keys
      const globalSettingsResponse = this.globalDataStore?.loadGlobalSettings();
      const globalSettings = globalSettingsResponse?.payload;

      // Load project settings (may be null if no workspace)
      const projectSettingsResponse = this.dataStore?.readProjectSettings();
      const projectSettings = projectSettingsResponse?.payload;

      // Check workspace state
      const hasWorkspace = vscode.workspace.workspaceFolders && vscode.workspace.workspaceFolders.length > 0;

      // Always send settings if globalSettings exists, even if projectSettings is null
      // This ensures frontend knows about workspace state
      if (globalSettings) {
        // Get available models
        const availableModels = this.getAvailableModels(globalSettings);

        // Determine initial primaryLLMModel only if projectSettings exists
        let initialPrimaryLLMModel = projectSettings?.primaryLLMModel;

        if (
          projectSettings &&
          initialPrimaryLLMModel &&
          !this.isModelAvailable(initialPrimaryLLMModel, globalSettings)
        ) {
          initialPrimaryLLMModel = null;
        }

        if (projectSettings && !initialPrimaryLLMModel) {
          // Find the first available model based on API keys
          if (availableModels.length > 0) {
            initialPrimaryLLMModel = availableModels[0].id;

            // Update project settings with the initial model
            const updatedProjectSettings = {
              ...projectSettings,
              primaryLLMModel: initialPrimaryLLMModel,
            };

            // Save the updated project settings
            this.dataStore?.saveProjectSettings(updatedProjectSettings);
          }
        }

        // Include isBusy so webview can restore "waiting" state after tab switch
        const sessionId = projectSettings?.currentSessionId;
        const isBusy = sessionId
          ? (this.debugSessionController?.isSessionBusy(sessionId) ?? false)
          : false;

        // Send settings to webview (always, even if projectSettings is null)
        webview.postMessage({
          type: "initialSettings",
          payload: {
            globalSettings,
            projectSettings: projectSettings
              ? {
                  ...projectSettings,
                  primaryLLMModel: initialPrimaryLLMModel,
                }
              : null,
            availableModels,
            hasWorkspace,
            isBusy,
          },
          timestamp: new Date(),
        });
      }
    } catch (error) {
      console.error("Error sending initial settings to webview:", error);
    }
  }

  /**
   * Gets available models: the user's BYOK entries only (no built-in catalog).
   */
  private getAvailableModels(globalSettings: any) {
    return toAvailableModels(globalSettings?.llmEntries);
  }

  private async handleLlmEntryMessage(webview: vscode.Webview, message: any): Promise<void> {
    try {
      if (!this.globalDataStore) {
        throw new Error("GlobalDataStore not initialized");
      }
      const globalSettings = await handleLlmEntryCommand(this.globalDataStore, message.command, message.payload);
      webview.postMessage({
        type: "globalSettingsUpdated",
        payload: { globalSettings, availableModels: this.getAvailableModels(globalSettings) },
        timestamp: new Date(),
      });
      webview.postMessage({ type: "success", requestId: message.requestId, payload: globalSettings, timestamp: new Date() });
    } catch (error) {
      webview.postMessage({
        type: "error",
        requestId: message.requestId,
        error: error instanceof Error ? error.message : "Failed to update model entry",
        timestamp: new Date(),
      });
    }
  }

  private isModelAvailable(modelId: string, globalSettings: any): boolean {
    const availableModels = this.getAvailableModels(globalSettings);
    return availableModels.some((model) => model.id === modelId);
  }

}
