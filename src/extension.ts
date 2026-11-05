/**
 * Main Backend Entry Point for Samurai Agent VS Code Extension
 *
 * This file serves as the primary backend handler for the extension, managing:
 * - VS Code command registrations and handlers
 * - Webview provider registrations for UI communication
 * - Extension lifecycle management (activate/deactivate)
 * - Future backend endpoint registrations for AI agent functionality
 *
 * The extension acts as a bridge between VS Code's API and the AI agent core logic,
 * providing the necessary infrastructure for command handling, webview communication,
 * and integration with the broader agent ecosystem.
 */

// Load environment variables from .env file for development
import * as dotenv from 'dotenv';
import * as path from 'path';
import * as fs from 'fs';

// Add extension_node_modules to module resolution path for external dependencies
// This allows ws and chrome-remote-interface to be resolved from the packaged extension
// We patch Module._nodeModulePaths globally so ALL modules can find packages in extension_node_modules
const extensionRoot = path.resolve(__dirname, '..');
const extensionNodeModules = path.join(extensionRoot, 'extension_node_modules');
if (fs.existsSync(extensionNodeModules)) {
  // Use require() to access Module internals (can't use import for this)
  const Module = require('module');
  
  // Patch Module._nodeModulePaths which is called for ALL modules when building their paths
  // This ensures every module (including chrome-remote-interface when it requires ws) can find extension_node_modules
  try {
    const originalNodeModulePaths = Module._nodeModulePaths;
    if (originalNodeModulePaths && typeof originalNodeModulePaths === 'function') {
      // Check if we can actually modify it
      const descriptor = Object.getOwnPropertyDescriptor(Module, '_nodeModulePaths');
      if (!descriptor || descriptor.writable !== false) {
        Module._nodeModulePaths = function(from: string) {
          const paths = originalNodeModulePaths.call(this, from);
          // Add extension_node_modules to all module paths
          if (paths && Array.isArray(paths) && !paths.includes(extensionNodeModules)) {
            paths.unshift(extensionNodeModules); // Add to beginning for priority
          }
          return paths;
        };
      }
    }
  } catch (e) {
    // If patching fails, fall back to other methods
    console.warn('[Samurai Agent] Could not patch Module._nodeModulePaths:', e);
  }
  
  // Also modify current module's paths as a backup
  if (module.paths && Array.isArray(module.paths) && !module.paths.includes(extensionNodeModules)) {
    module.paths.unshift(extensionNodeModules);
  }
  
  // Set NODE_PATH as a final fallback
  const nodePath = process.env.NODE_PATH || '';
  if (!nodePath.split(path.delimiter).includes(extensionNodeModules)) {
    process.env.NODE_PATH = extensionNodeModules + (nodePath ? path.delimiter + nodePath : '');
  }
}

// Load .env file from the extension root directory
dotenv.config({ path: path.resolve(__dirname, '..', '.env') });

import * as vscode from "vscode";
import { SamuraiAgentPanelWebviewViewProvider } from "./webview/SamuraiAgentPanelWebviewViewProvider";
import { GlobalDataStore } from "./persistence/globalDataStore";
import { DataStore } from "./persistence/dataStore";
import { LLMProviderService } from "./agent/llm/llmProviderService";
import { OpenAIChatClient } from "./agent/llm/openaiChatClient";
import { GeminiChatClient } from "./agent/llm/geminiChatClient";
import { AnthropicChatClient } from "./agent/llm/anthropicChatClient";
import { ProjectDetailService } from "./agent/memory/projectDetailService";
import { ProjectTechStackService } from "./agent/memory/projectTechStackService";
import { TreeSitterLoaderService } from "./agent/code_parser/TreeSitterLoaderService";
import { ExtractCodeTool } from "./agent/tools/extractCodeTool";
import { CodeParserService } from "./agent/code_parser/CodeParserService";
import { LLMCostStorage, LLMCostRecord } from "./storage/llmCostStorage";
import { formatCost } from "./common/utils/llmCostCalculator";
import { LLMResponse } from "./common/models/llm-models";
import { ResponseType } from "./common/models/response-models";
import { RecentFilesTracker } from "./services/RecentFilesTracker";
import { setSecretStorageContext } from "./common/utils/llmSecretStore";
import { migrateLegacyKeys } from "./common/utils/legacyKeyMigration";
import { ToolRegistry } from "./agent/tools/ToolRegistry";
import { InitialContextService } from "./agent/services/InitialContextService";
import { ImageGenerationService } from "./agent/services/ImageGenerationService";
import { DebugSessionController } from "./agent/controllers/DebugSessionController";
import { SamuraiCodeActionProvider } from "./agent/providers/SamuraiCodeActionProvider";
import { EditBurstTracker } from "./services/EditBurstTracker";
import { RegressionNotificationService, getRiskLevel } from "./services/RegressionNotificationService";
import { DiffCaptureResult } from "./services/RegressionDiffCapture";
import { RiskResult } from "./services/RegressionRiskScorer";

// Module-level variable to store toolRegistry for cleanup
let toolRegistryInstance: ToolRegistry | null = null;

// Guard flag to prevent infinite sync loops between VS Code config and GlobalDataStore
let isSyncingSettings = false;

// Exported setter so the webview provider can set the flag before calling config.update()
export function setSyncingSettings(value: boolean): void {
  isSyncingSettings = value;
}

/**
 * Extension activation function - main backend entry point
 * Registers all commands, webview providers, and initializes the agent system
 */
export async function activate(context: vscode.ExtensionContext) {
  console.log('[Samurai Agent] 🚀 Ext5ension activation starting...');
  
  try {
    setSecretStorageContext(context);
    const globalDataStore = new GlobalDataStore();
    console.log('[Samurai Agent] ✓ GlobalDataStore initialized');
    await migrateLegacyKeys(globalDataStore);
    
    const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    console.log('[Samurai Agent] Workspace root:', workspaceRoot || 'No workspace folder open');
    
    const dataStore = workspaceRoot ? new DataStore(workspaceRoot) : undefined;
    console.log('[Samurai Agent] ✓ DataStore initialized:', dataStore ? 'available' : 'not available (no workspace)');

    // Initialize LLM Cost Storage
    const llmCostStorage = new LLMCostStorage(context);
    console.log('[Samurai Agent] ✓ LLMCostStorage initialized');
    
    // Migrate cost data from workspaceState to globalState for backward compatibility
    try {
      await llmCostStorage.migrateFromWorkspaceState();
      console.log('[Samurai Agent] ✓ Cost data migration completed');
    } catch (error) {
      console.warn('[Samurai Agent] Cost data migration failed (non-blocking):', error);
      // Migration failure shouldn't block extension activation
    }
    
    // Create status bar item for cost display
    const costStatusBarItem = vscode.window.createStatusBarItem(
      vscode.StatusBarAlignment.Right,
      100
    );
    costStatusBarItem.command = 'samurai-agent.showCostDetails';
    context.subscriptions.push(costStatusBarItem);
    
    // Update status bar with initial cost
    updateCostStatusBar(costStatusBarItem, llmCostStorage);
    costStatusBarItem.show();

    // Initialize RecentFilesTracker (hybrid approach: open tabs + event tracking, workspace-aware)
    const recentFilesTracker = RecentFilesTracker.getInstance();
    recentFilesTracker.initialize();
    context.subscriptions.push({
      dispose: () => recentFilesTracker.dispose()
    });
    console.log('[Samurai Agent] ✓ RecentFilesTracker initialized');

    // Initialize EditBurstTracker and RegressionNotificationService
    const editBurstTracker = new EditBurstTracker();
    const regressionNotificationService = new RegressionNotificationService(
      editBurstTracker,
      globalDataStore,
      0
    );

    // Configure cooldown from VS Code settings
    const regConfig = vscode.workspace.getConfiguration('samurai-agent.regressionDetection');
    const cooldownSec = regConfig.get<number>('cooldownSeconds', 60);
    editBurstTracker.cooldownMs = cooldownSec * 1000;
    const idleSec = regConfig.get<number>('idleSeconds', 30);
    editBurstTracker.idleMs = idleSec * 1000;
    const maxBurstSec = regConfig.get<number>('maxBurstDurationSeconds', 300);
    editBurstTracker.maxBurstDurationMs = maxBurstSec * 1000;

    // Start paused, only enable if either setting is true (VS Code setting or GlobalDataStore)
    const currentGlobalSettings = globalDataStore.loadGlobalSettings().payload;
    const vscodeConfig = vscode.workspace.getConfiguration('samurai-agent.regressionDetection');
    const vscodeEnabled = vscodeConfig.get<boolean>('enabled', false);
    const globalEnabled = currentGlobalSettings?.enableRegressionDetection ?? false;

    if (vscodeEnabled || globalEnabled) {
      editBurstTracker.enable();
    } else {
      console.log('[Samurai Agent] Regression detection disabled (VS Code: ' + vscodeEnabled + ', GlobalDataStore: ' + globalEnabled + ')');
    }
    regressionNotificationService.start();

    // Startup sync: push GlobalDataStore values to VS Code config for discoverability
    try {
      isSyncingSettings = true;
      const samuraiConfig = vscode.workspace.getConfiguration('samurai-agent');
      await samuraiConfig.update('enableDebugLogging', currentGlobalSettings?.enableDebugLogging ?? false, vscode.ConfigurationTarget.Global);
      console.log('[Samurai Agent] ✓ Startup sync: GlobalDataStore → VS Code config');
    } catch (syncError) {
      console.warn('[Samurai Agent] Startup sync failed (non-blocking):', syncError);
    } finally {
      isSyncingSettings = false;
    }

    context.subscriptions.push({
      dispose: () => {
        editBurstTracker.dispose();
        regressionNotificationService.dispose();
      }
    });
    console.log('[Samurai Agent] ✓ EditBurstTracker and RegressionNotificationService initialized');

    const llmProviderService = new LLMProviderService(globalDataStore, dataStore, undefined);
    console.log('[Samurai Agent] ✓ LLMProviderService initialized');

    llmProviderService.registerClient("openai", new OpenAIChatClient());
    llmProviderService.registerClient("google", new GeminiChatClient());
    llmProviderService.registerClient("anthropic", new AnthropicChatClient());
    console.log('[Samurai Agent] ✓ LLM clients registered');
    
    // Initialize ToolRegistry
    const toolRegistry = new ToolRegistry(llmProviderService);
    toolRegistryInstance = toolRegistry; // Store for cleanup
    console.log('[Samurai Agent] ✓ ToolRegistry initialized');
    
    // Initialize InitialContextService for fast path
    const initialContextService = new InitialContextService(toolRegistry, llmProviderService);
    console.log('[Samurai Agent] ✓ InitialContextService initialized');
    
    // Initialize ImageGenerationService
    const imageGenerationService = workspaceRoot
      ? new ImageGenerationService(globalDataStore, workspaceRoot)
      : undefined;
    console.log('[Samurai Agent] ✓ ImageGenerationService initialized:', imageGenerationService ? 'available' : 'not available (no workspace)');
    
    // Initialize DebugSessionController (will be wired to webview provider after it's created)
    const debugSessionController = new DebugSessionController(
      initialContextService,
      toolRegistry,
      llmProviderService,
      null,
      dataStore || undefined,
      imageGenerationService,
      workspaceRoot,
      llmCostStorage
    );
    console.log('[Samurai Agent] ✓ DebugSessionController initialized');
    
    // Initialize TreeSitterLoaderService
    const treeSitterLoaderService = new TreeSitterLoaderService(context.globalStorageUri);
    console.log('[Samurai Agent] ✓ TreeSitterLoaderService initialized');
    
    // Initialize CodeParserService and ExtractCodeTool
    const codeParserService = new CodeParserService(context.extensionUri.fsPath);
    const extractCodeTool = new ExtractCodeTool(llmProviderService, codeParserService);
    console.log('[Samurai Agent] ✓ CodeParserService and ExtractCodeTool initialized');
    
    const projectDetailService = dataStore
      ? new ProjectDetailService(
          llmProviderService,
          dataStore,
          context.extensionUri.fsPath,
        )
      : undefined;
    console.log('[Samurai Agent] ✓ ProjectDetailService initialized:', projectDetailService ? 'available' : 'not available');

    const projectTechStackService = dataStore
      ? new ProjectTechStackService(dataStore)
      : undefined;
    console.log(
      '[Samurai Agent] ✓ ProjectTechStackService initialized:',
      projectTechStackService ? 'available' : 'not available',
    );

    const agentPanelProvider = new SamuraiAgentPanelWebviewViewProvider(
      context.extensionUri,
      {
        llmProviderService,
        projectDetailService,
        dataStore,
        globalDataStore,
        treeSitterLoaderService,
        extractCodeTool,
        llmCostStorage,
        debugSessionController,
        editBurstTracker,
      },
    );
    console.log('[Samurai Agent] ✓ SamuraiAgentPanelWebviewViewProvider created');
    
    // Wire webview provider to controller (circular dependency fix)
    debugSessionController.setWebviewProvider(agentPanelProvider);
    console.log('[Samurai Agent] ✓ DebugSessionController wired to webview provider');

    // Register the webview view provider with explicit options
    const disposable = vscode.window.registerWebviewViewProvider(
      SamuraiAgentPanelWebviewViewProvider.viewType,
      agentPanelProvider,
      {
        webviewOptions: {
          retainContextWhenHidden: true
        }
      }
    );
    
    context.subscriptions.push(disposable);
    
    console.log('[Samurai Agent] ✅ Webview provider registered successfully!');
    console.log('[Samurai Agent]    - ViewType:', SamuraiAgentPanelWebviewViewProvider.viewType);
    console.log('[Samurai Agent]    - Provider instance:', agentPanelProvider.constructor.name);
    console.log('[Samurai Agent]    - Disposable created:', !!disposable);
    console.log('[Samurai Agent]    - Registration options: retainContextWhenHidden=true');
    console.log('[Samurai Agent] 💡 To open the webview, click the Samurai Agent icon in the Activity Bar (left sidebar)');

    // Register a command to open the panel programmatically (as a workaround)
    context.subscriptions.push(
      vscode.commands.registerCommand('samurai-agent.openPanel', async () => {
        console.log('[Samurai Agent] 📱 Command: samurai-agent.openPanel invoked');
        console.log('[Samurai Agent] Attempting to focus view:', SamuraiAgentPanelWebviewViewProvider.viewType);
        try {
          await vscode.commands.executeCommand(`${SamuraiAgentPanelWebviewViewProvider.viewType}.focus`);
          console.log('[Samurai Agent] ✓ View focus command executed');
        } catch (error) {
          console.error('[Samurai Agent] ❌ Failed to focus view:', error);
          vscode.window.showErrorMessage(`Failed to open Samurai Agent panel: ${error}`);
        }
      })
    );
    console.log('[Samurai Agent] ✓ Command "samurai-agent.openPanel" registered');

    // Try to verify the view exists after a short delay
    setTimeout(async () => {
      console.log('[Samurai Agent] 🔍 Verifying view registration...');
      try {
        // Try to execute the view's focus command
        const commands = await vscode.commands.getCommands(true);
        const viewCommands = commands.filter(cmd => cmd.includes('samurai-agent'));
        console.log('[Samurai Agent] Available Samurai Agent commands:', viewCommands);
        
        // Check if our view's focus command exists
        const focusCommand = `${SamuraiAgentPanelWebviewViewProvider.viewType}.focus`;
        if (commands.includes(focusCommand)) {
          console.log('[Samurai Agent] ✓ View focus command exists:', focusCommand);
        } else {
          console.error('[Samurai Agent] ❌ View focus command NOT found:', focusCommand);
          console.error('[Samurai Agent] This suggests the view was not properly registered with VS Code');
        }
      } catch (error) {
        console.error('[Samurai Agent] Error verifying view registration:', error);
      }
    }, 1000);

    // Note: samurai-agent.llm.chat command removed - all chat now uses samurai-agent.execute for consistency

    if (projectDetailService) {
      context.subscriptions.push(
      vscode.commands.registerCommand(
        "samurai-agent.projectDetail.ingest",
        async (args) => {
          const { projectId, rawText, mode } = args;
          const result = await projectDetailService.ingestProjectDetail(
            projectId,
            rawText,
            mode,
          );
          
          // Track cost if LLM was used
          if (result.llmResponse && result.llmResponse.cost !== undefined && result.llmResponse.cost > 0) {
            const modelUsed = result.llmResponse.model;
            
            const costRecord: LLMCostRecord = {
              id: `cost-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
              timestamp: new Date().toISOString(),
              provider: result.llmResponse.provider,
              model: modelUsed,
              promptTokens: result.llmResponse.usage.promptTokens,
              completionTokens: result.llmResponse.usage.completionTokens,
              totalTokens: result.llmResponse.usage.totalTokens,
              cost: result.llmResponse.cost,
              requestId: result.llmResponse.requestId,
            };
            
            console.log('[COST DEBUG] projectDetail.ingest - Saving cost record:', costRecord);
            try {
              await llmCostStorage.saveRecord(costRecord);
              updateCostStatusBar(costStatusBarItem, llmCostStorage);
              console.log('[COST DEBUG] projectDetail.ingest - Cost record saved and status bar updated');
            } catch (error) {
              console.error('[COST DEBUG] projectDetail.ingest - Failed to save cost record:', error);
              // Attempt to update status bar even if save failed (may help show previous costs)
              try {
                updateCostStatusBar(costStatusBarItem, llmCostStorage);
              } catch (statusBarError) {
                console.error('[COST DEBUG] projectDetail.ingest - Failed to update status bar:', statusBarError);
              }
            }
          }
          
          // Return the final text for backward compatibility
          return result.finalText;
        },
      ),
    );
    }


    // Register command to show cost details
    context.subscriptions.push(
    vscode.commands.registerCommand(
      'samurai-agent.showCostDetails',
      () => {
        const stats = llmCostStorage.getStatistics();
        const message = `
LLM Cost Tracker

This Month: ${formatCost(stats.currentMonthCost)}
Session (24h): ${formatCost(stats.currentSessionCost)}
Total (All Time): ${formatCost(stats.totalCost)}
Total Requests: ${stats.totalRecords}

Click to see details in the Samurai Agent panel.
        `.trim();
        
        vscode.window.showInformationMessage(message);
      }
    )
    );

    // Register command to get cost statistics
    context.subscriptions.push(
    vscode.commands.registerCommand(
      'samurai-agent.getCostStatistics',
      () => {
        return llmCostStorage.getStatistics();
      }
    )
    );

    // Register command to get monthly cost from local storage
    context.subscriptions.push(
    vscode.commands.registerCommand(
      'samurai-agent.getBackendMonthlyCost',
      () => {
        try {
          // Get monthly cost from local LLM cost storage
          const stats = llmCostStorage.getStatistics();
          return {
            total_cost: stats.currentMonthCost,
            call_count: stats.totalRecords, // This represents total calls, not just monthly
            month: new Date().toLocaleDateString('en-US', { year: 'numeric', month: 'long' })
          };
        } catch (error) {
          console.error('Error getting monthly cost from storage:', error);
          return null;
        }
      }
    )
    );

    // Register command to clear cost history
    context.subscriptions.push(
      vscode.commands.registerCommand(
        'samurai-agent.clearCostHistory',
        async () => {
          const answer = await vscode.window.showWarningMessage(
            'Are you sure you want to clear all LLM cost history?',
            'Yes',
            'No'
          );
          
          if (answer === 'Yes') {
            await llmCostStorage.clearRecords();
            updateCostStatusBar(costStatusBarItem, llmCostStorage);
            vscode.window.showInformationMessage('LLM cost history cleared.');
          }
        }
      )
    );

    // Register command to add selection to context
    context.subscriptions.push(
      vscode.commands.registerCommand(
        'samurai-agent.addSelection',
        async () => {
          const editor = vscode.window.activeTextEditor;
          
          if (!editor) {
            vscode.window.showWarningMessage('No active editor. Please open a file first.');
            return;
          }

          const selection = editor.selection;
          if (selection.isEmpty) {
            vscode.window.showWarningMessage('Please select some text first.');
            return;
          }

          const document = editor.document;
          if (document.uri.scheme !== 'file') {
            vscode.window.showWarningMessage('Can only add files from the workspace to context.');
            return;
          }

          const filePath = document.uri.fsPath;
          
          try {
            // --- AUTO-OPEN: Force open the sidebar to create the "Magic Moment" ---
            // This makes the extension "pop up" when used, solving onboarding and confirmation
            console.log('[Samurai Agent] Opening sidebar for addSelection command');
            await vscode.commands.executeCommand(`${SamuraiAgentPanelWebviewViewProvider.viewType}.focus`);
            
            // Small delay to ensure view is ready (especially on first launch)
            await new Promise(resolve => setTimeout(resolve, 100));
            
            // Ensure the view is visible
            agentPanelProvider.showView();
            
            // Send message to webview to pin the file (will queue if view not ready)
            agentPanelProvider.postMessage({
              type: 'pinFile',
              filePath: filePath
            });
            
            vscode.window.showInformationMessage(`Added ${path.basename(filePath)} to Samurai context`);
            console.log('[Samurai Agent] Added file to context:', filePath);
          } catch (error) {
            console.error('[Samurai Agent] Failed to add file to context:', error);
            vscode.window.showErrorMessage(
              `Failed to add file to context: ${error instanceof Error ? error.message : 'Unknown error'}`
            );
          }
        }
      )
    );
    console.log('[Samurai Agent] ✓ Command "samurai-agent.addSelection" registered');

    // Register command to open file from webview
    context.subscriptions.push(
      vscode.commands.registerCommand('samurai-agent.openFile', async (relativePath: string) => {
        if (!relativePath) {
          return;
        }

        const workspaceFolders = vscode.workspace.workspaceFolders;
        if (!workspaceFolders) {
          vscode.window.showWarningMessage('No workspace folder open.');
          return;
        }

        try {
          let uri: vscode.Uri;

          if (path.isAbsolute(relativePath)) {
            // Absolute path: use directly
            uri = vscode.Uri.file(relativePath);
          } else {
            // Relative path: try direct resolution first
            uri = vscode.Uri.joinPath(
              workspaceFolders[0].uri,
              relativePath
            );

            // Check if file exists at the direct path
            try {
              await vscode.workspace.fs.stat(uri);
            } catch {
              // File not found at direct path, search for it across workspace
              // This handles cases where workspace root is a parent directory
              const fileName = path.basename(relativePath);
              const searchPattern = `**/${fileName}`;
              const foundFiles = await vscode.workspace.findFiles(
                searchPattern,
                '**/node_modules/**',
                20
              );

              // Filter to exact path matches
              // Check if any found file ends with the relative path (handles subdirectory cases)
              const exactMatches = foundFiles.filter(fileUri => {
                const filePath = fileUri.fsPath;
                // Normalize both paths to use forward slashes for comparison
                const normalizedFile = filePath.replace(/\\/g, '/');
                const normalizedRelative = relativePath.replace(/\\/g, '/');
                // Check if file path ends with the relative path (with or without leading slash)
                return normalizedFile.endsWith(normalizedRelative) || 
                       normalizedFile.endsWith('/' + normalizedRelative);
              });

              if (exactMatches.length > 0) {
                uri = exactMatches[0];
              } else if (foundFiles.length > 0) {
                // Fallback: use first match if exact match not found
                uri = foundFiles[0];
              } else {
                throw new Error(`File not found: ${relativePath}`);
              }
            }
          }

          const doc = await vscode.workspace.openTextDocument(uri);
          await vscode.window.showTextDocument(doc, { preview: false });
        } catch (error) {
          console.error('[Samurai Agent] Failed to open file:', error);
          vscode.window.showWarningMessage(`Failed to open file: ${relativePath}`);
        }
      })
    );
    console.log('[Samurai Agent] ✓ Command "samurai-agent.openFile" registered');

    // Register Code Action Provider
    context.subscriptions.push(
      vscode.languages.registerCodeActionsProvider(
        { scheme: 'file', language: '*' }, // Runs on all files
        new SamuraiCodeActionProvider(),
        {
          providedCodeActionKinds: SamuraiCodeActionProvider.providedCodeActionKinds
        }
      )
    );
    console.log('[Samurai Agent] ✓ Code Action Provider registered');

    // Register regression review command
    context.subscriptions.push(
      vscode.commands.registerCommand(
        'samurai-agent.startRegressionReview',
        async (diffResult: DiffCaptureResult, riskResult: RiskResult) => {
          try {
            // Focus webview
            await vscode.commands.executeCommand(`${SamuraiAgentPanelWebviewViewProvider.viewType}.focus`);
            await new Promise(resolve => setTimeout(resolve, 100));
            agentPanelProvider.showView();

            // Build prefilled message
            const reasonsList = riskResult.reasons.map(r => `- ${r.pattern} (+${r.points}, ${r.confidence} confidence)`).join('\n');
            const fileList = diffResult.changedFilesDuringBurst.map(f => `- ${f}`).join('\n');

            // Add timestamp for temporal context
            const capturedAt = diffResult.capturedAt
              ? new Date(diffResult.capturedAt).toISOString()
              : new Date().toISOString();

            const riskLevel = getRiskLevel(riskResult.totalRiskScore);
            let content = `[Auto-detected] Regression risk: ${riskLevel} (score: ${riskResult.totalRiskScore}/100)\n\n`;
            content += `## Risk reasons\n${reasonsList}\n\n`;

            const snapshotEmpty = diffResult.snapshotDiff.trim().length === 0;
            const hasGitDiff = Boolean(diffResult.gitDiff?.trim());

            if (snapshotEmpty && !hasGitDiff) {
              content += `## Captured diff snapshot (for hypothesis generation)\n`;
              content += `_Captured at: ${capturedAt}_\n\n`;
              content += `Diff could not be captured. Use \`git-diff\` or \`static-analysis\` tools to review changes.\n\n`;
            } else {
              const primaryDiff = snapshotEmpty ? (diffResult.gitDiff ?? '') : diffResult.snapshotDiff;
              const diffLabel = snapshotEmpty
                ? `## Git diff (snapshot unavailable; use for hypothesis generation)\n_Captured at: ${capturedAt}_\n`
                : `## Captured diff snapshot (for hypothesis generation)\n_Captured at: ${capturedAt}_\n`;
              content += diffLabel;
              content += `\`\`\`diff\n${primaryDiff}\n\`\`\`\n\n`;
            }

            content += `## Files changed\n${fileList}\n\n`;

            if (diffResult.planContext) {
              const plan = diffResult.planContext;
              content += `## AI Tool Plan Context\n`;
              content += `_Source: ${plan.sourcePath} (${plan.toolName}, modified: ${plan.modifiedAt})_\n`;
              content += `_Note: This plan was updated within the last 24 hours and is likely related to these changes, but it\'s possible it describes a different task._\n\n`;
              content += `\`\`\`markdown\n${plan.content}\n\`\`\`\n\n`;
              if (plan.confidence === 'low') {
                content += `_Confidence: Low — this plan does not mention any of the changed files. It may describe a different task._\n\n`;
              }
            }

            if (diffResult.needsGitFallback && diffResult.gitDiff && !snapshotEmpty) {
              content += `## Additional git context (may include older uncommitted changes)\n\`\`\`diff\n${diffResult.gitDiff}\n\`\`\`\n`;
              content += `Note: Some files could not be fully captured via snapshots. The above git diff provides supplementary context.\n\n`;
            }

            content += `## Review Protocol\n\n`;

            content += `### Step 1: Understand the Change\n`;
            content += `Analyze what functions/modules were modified. Identify the before vs after behavior from the diff.\n\n`;

            content += `### Step 2: Infer Developer Intent\n`;
            if (diffResult.planContext) {
              content += `Use the AI Tool Plan Context above as the **primary signal** for developer intent. Cross-reference **every change in the diff** against the plan. Flag any change NOT described in the plan that touches runtime behavior (logic, conditions, async boundaries, error handling, security, API calls) as a potential unintended regression. Also flag any planned change that appears missing from the diff. Ignore cosmetic or type-only changes unless they introduce \`any\`, \`ts-ignore\`, \`!\`, etc.\n\n`;
            } else {
              content += `Before looking for bugs, determine WHY this change was made. State the intent in 1-2 sentences.\n\n`;
            }

            if (diffResult.planContext) {
              content += `### Step 2.5: Validate Implementation Against Plan\n`;
              content += `- Does the implementation **fully cover** every requirement in the plan?\n`;
              content += `- Are there runtime-behavior changes in the diff **NOT described** in the plan?\n`;
              content += `- Were any planned changes **skipped or only partially implemented**?\n`;
              content += `- Flag discrepancies between plan and implementation as potential regression sources\n\n`;
            }

            content += `### Step 3: Find Regressions Specific to This Change\n`;
            content += `Only report issues that:\n`;
            content += `- Were **NOT present before** this change\n`;
            content += `- Are **directly caused by the diff**\n`;
            content += `- Could **break existing functionality**\n`;
            content += `- Do NOT report generic code quality issues or pre-existing problems\n\n`;

            // Step 4: Dynamic heuristic signals
            if (riskResult.reasons.length > 0) {
              content += `### Step 4: Investigate Heuristic Signals\n`;
              content += `The following patterns were detected by heuristic analysis. Investigate each one and explain the concrete failure mode:\n\n`;
              for (const r of riskResult.reasons) {
                content += `- **${r.pattern}** (${r.confidence} confidence, +${r.points}pts)\n`;
              }
              content += `\nFor each signal: confirm whether it's a real regression, explain why, or explain why it's safe. For each signal: before concluding "real regression," check that the failure scenario is **reachable** (this code path can run with the inputs you assume). If unreachable, mark safe and explain why.\n\n`;
            }

            // Step 5: Broader LLM-only checklist (specialist categories first)
            content += `### Step 5: Check Additional Regression-Prone Patterns\n`;
            content += `Examine the diff for these patterns. Only report issues **introduced or worsened by this diff**:\n\n`;
            content += `#### Async & Concurrency\n`;
            content += `- Missing \`await\` on async calls (especially inside \`forEach\`, \`map\`, event handlers)\n`;
            content += `- Fire-and-forget promises: \`.then()\` without \`.catch()\`, unhandled rejection paths\n`;
            content += `- Race conditions: concurrent state mutations, missing cancellation logic\n`;
            content += `- Removed debounce/throttle guards\n\n`;
            content += `#### Silent Error Handling\n`;
            content += `- Catch blocks that swallow errors without logging or re-throwing\n`;
            content += `- \`.catch(() => fallbackValue)\` without explicit justification\n`;
            content += `- Removed logging/monitoring (console.error, logger calls)\n\n`;
            content += `#### React State & Effect Bugs\n`;
            content += `- useEffect dependency array changes (stale closures vs infinite loops)\n`;
            content += `- \`setState(value)\` inside async/timer callbacks (use functional update)\n`;
            content += `- useMemo/useCallback with wrong deps, key={index} on reorderable lists\n\n`;
            content += `#### Secondary Regression Patterns\n\n`;
            content += `**API Contract Drift**\n`;
            content += `- Response shape changes: renamed, nested, or removed fields\n`;
            content += `- Required ↔ optional changes, default value changes\n`;
            content += `- Request/response type mismatches between client and server\n\n`;
            content += `**Null/Undefined & Truthiness**\n`;
            content += `- \`||\` where \`??\` is needed (0, "", false treated as falsy)\n`;
            content += `- Removed \`?.\` or \`??\` without null-safe replacement\n`;
            content += `- Added \`!\` non-null assertion, \`as any\`, \`@ts-ignore\`\n\n`;
            content += `**Security & Permissions**\n`;
            content += `- Auth/permission checks removed or moved after data access\n`;
            content += `- CORS widened, cookie security flags removed\n`;
            content += `- eval(), innerHTML, dangerouslySetInnerHTML added\n\n`;
            content += `**Caching & Invalidation**\n`;
            content += `- Cache key/TTL changes, removed invalidation logic\n`;
            content += `- Memoization of request-scoped data at module level\n\n`;
            content += `**Date/Time & Locale**\n`;
            content += `- new Date(string) with non-ISO input, timezone-unaware comparisons\n`;
            content += `- toLocaleString() used for logic (output varies by runtime)\n\n`;

            content += `### Verification\n`;
            content += `**IMPORTANT: The diff is a snapshot and may be stale.** Before drawing conclusions:\n`;
            content += `- Use \`static-analysis\` (mode: 'source') to read the **current** file content\n`;
            content += `- Or use \`git-diff\` to see **current** uncommitted changes\n`;
            content += `- Verify each hypothesis against the current file state before reporting\n\n`;

            content += `### Output Format\n`;
            content += `For each finding report: **file & location**, **what changed**, **why it regresses**, **severity**, and **suggested fix**.`;

            // Build absolute paths for pinned files
            const pinnedFiles = riskResult.riskiestFiles.map(file =>
              path.isAbsolute(file) ? file : path.join(workspaceRoot || '', file)
            );

            // Send single message to create a new code-review session
            agentPanelProvider.postMessage({
              type: 'createCodeReviewSession',
              content,
              pinnedFiles,
            });

            console.log('[Samurai Agent] Regression review prefilled in webview');
          } catch (error) {
            console.error('[Samurai Agent] Failed to start regression review:', error);
            vscode.window.showErrorMessage(`Failed to start regression review: ${error instanceof Error ? error.message : String(error)}`);
          }
        }
      )
    );
    console.log('[Samurai Agent] ✓ Command "samurai-agent.startRegressionReview" registered');

    // Note: samurai-agent.ui.sendAssistantMessageToChat is now handled as a webview message
    // in SamuraiAgentPanelWebviewViewProvider.handleSendAssistantMessageToChat()

    // Listen for regression detection setting changes
    context.subscriptions.push(
      vscode.workspace.onDidChangeConfiguration((event) => {
        if (event.affectsConfiguration('samurai-agent.regressionDetection.enabled')) {
          const config = vscode.workspace.getConfiguration('samurai-agent.regressionDetection');
          const isEnabled = config.get<boolean>('enabled', false);
          if (isEnabled) {
            editBurstTracker.enable();
          } else {
            editBurstTracker.disable();
          }
        }
        if (event.affectsConfiguration('samurai-agent.regressionDetection.cooldownSeconds')) {
          const config = vscode.workspace.getConfiguration('samurai-agent.regressionDetection');
          editBurstTracker.cooldownMs = (config.get<number>('cooldownSeconds', 60)) * 1000;
        }
        if (event.affectsConfiguration('samurai-agent.regressionDetection.idleSeconds')) {
          const config = vscode.workspace.getConfiguration('samurai-agent.regressionDetection');
          editBurstTracker.idleMs = (config.get<number>('idleSeconds', 30)) * 1000;
        }
        if (event.affectsConfiguration('samurai-agent.regressionDetection.maxBurstDurationSeconds')) {
          const config = vscode.workspace.getConfiguration('samurai-agent.regressionDetection');
          editBurstTracker.maxBurstDurationMs = (config.get<number>('maxBurstDurationSeconds', 300)) * 1000;
        }
      })
    );

    // Listen for enableDebugLogging changes from VS Code native Settings UI
    context.subscriptions.push(
      vscode.workspace.onDidChangeConfiguration(async (event) => {
        if (isSyncingSettings) {
          return; // Skip changes triggered by our own sync
        }

        if (event.affectsConfiguration('samurai-agent.enableDebugLogging')) {
          const config = vscode.workspace.getConfiguration('samurai-agent');
          const existingSettings = globalDataStore.loadGlobalSettings().payload;
          if (!existingSettings) {
            return;
          }

          if (event.affectsConfiguration('samurai-agent.enableDebugLogging')) {
            existingSettings.enableDebugLogging = config.get<boolean>('enableDebugLogging', false);
            console.log('[Samurai Agent] enableDebugLogging changed via VS Code Settings');
          }

          globalDataStore.saveGlobalSettings(existingSettings);

          // Notify webview of the updated settings
          const updatedSettings = globalDataStore.loadGlobalSettings().payload;
          agentPanelProvider.postMessage({
            type: 'globalSettingsUpdated',
            payload: { globalSettings: updatedSettings },
            timestamp: new Date(),
          });
        }
      })
    );

    console.log('[Samurai Agent] 🎉 Extension activation completed successfully!');
    
  } catch (error) {
    console.error('[Samurai Agent] ❌ FATAL: Extension activation failed:', error);
    vscode.window.showErrorMessage(
      `Samurai Agent failed to activate: ${error instanceof Error ? error.message : String(error)}`
    );
    throw error;
  }
}

/**
 * Update the status bar with current cost information
 */
function updateCostStatusBar(
  statusBarItem: vscode.StatusBarItem,
  costStorage: LLMCostStorage
): void {
  const stats = costStorage.getStatistics();
  const sessionCost = formatCost(stats.currentSessionCost);
  const totalCost = formatCost(stats.totalCost);
  
  statusBarItem.text = `$(graph) LLM: ${sessionCost} | Total: ${totalCost}`;
  statusBarItem.tooltip = `Session Cost: ${sessionCost}\nTotal Cost: ${totalCost}\nTotal Requests: ${stats.totalRecords}\n\nClick for details`;
}

export function deactivate() {
  // Cleanup runtime processes
  if (toolRegistryInstance) {
    const tools = toolRegistryInstance.getAll();
    tools.forEach(tool => {
      if (typeof (tool as any).cleanup === 'function') {
        try {
          (tool as any).cleanup();
        } catch (error) {
          console.error(`[Samurai Agent] Error during tool cleanup:`, error);
        }
      }
    });
  }
}
