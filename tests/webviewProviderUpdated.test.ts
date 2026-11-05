/**
 * Tests for Updated Webview Provider
 * Validates the webview provider's handling of initial settings and model filtering
 */

import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { SamuraiAgentPanelWebviewViewProvider } from '../src/webview/SamuraiAgentPanelWebviewViewProvider';
import { GlobalDataStore } from '../src/persistence/globalDataStore';
import { DataStore } from '../src/persistence/dataStore';
import { LLMProviderService } from '../src/agent/llm/llmProviderService';
import { ProjectDetailService } from '../src/agent/memory/projectDetailService';

// Use real fs and path modules for these tests
jest.unmock('fs');
jest.unmock('path');

// Mock VS Code API
const mockWebview = {
    postMessage: jest.fn(),
    options: {},
    asWebviewUri: jest.fn((uri: any) => uri)
};

const mockWebviewView = {
    webview: mockWebview,
    onDidReceiveMessage: jest.fn()
};

const mockExtensionUri = {
    fsPath: '/test/extension'
};

let provider: SamuraiAgentPanelWebviewViewProvider;
let testWorkspaceRoot: string;
let testConfigDir: string;
let originalConfigDir: string;

function createProvider(workspaceRoot: string) {
    const globalDataStore = new GlobalDataStore();
    const dataStore = new DataStore(workspaceRoot);
    const llmProviderService = new LLMProviderService(globalDataStore);
    const projectDetailService = new ProjectDetailService(llmProviderService, dataStore);

    return new SamuraiAgentPanelWebviewViewProvider(mockExtensionUri as any, {
        llmProviderService,
        projectDetailService,
        dataStore,
        globalDataStore
    });
}

beforeEach(() => {
    // Create temporary test directories
    testWorkspaceRoot = path.join(os.tmpdir(), 'samurai-agent-test-workspace-webview', Date.now().toString());
    testConfigDir = path.join(os.tmpdir(), 'samurai-agent-test-global-webview', Date.now().toString());

    fs.mkdirSync(testWorkspaceRoot, { recursive: true });
    fs.mkdirSync(testConfigDir, { recursive: true });

    // Mock environment
    originalConfigDir = process.env.HOME || os.homedir();
    process.env.HOME = testConfigDir;

    const mockWorkspaceFolder = {
        uri: { fsPath: testWorkspaceRoot },
        name: 'test-workspace',
        index: 0
    };
    (require('vscode').workspace as any).workspaceFolders = [mockWorkspaceFolder];

    provider = createProvider(testWorkspaceRoot);

    // Clear mocks
    jest.clearAllMocks();

    // Initialize the provider's data stores by calling resolveWebviewView
    provider.resolveWebviewView(mockWebviewView as any, {} as any, {} as any);
});

describe('SamuraiAgentPanelWebviewViewProvider (BYOK models)', () => {
    afterEach(() => {
        // Clean up test directories
        if (fs.existsSync(testWorkspaceRoot)) {
            fs.rmSync(testWorkspaceRoot, { recursive: true, force: true });
        }
        if (fs.existsSync(testConfigDir)) {
            fs.rmSync(testConfigDir, { recursive: true, force: true });
        }
        
        // Restore original HOME
        process.env.HOME = originalConfigDir;
    });

    const entries = [
        { id: 'entry-claude', provider: 'anthropic', modelName: 'my-claude' },
        { id: 'entry-gpt', provider: 'openai', modelName: 'my-gpt', label: 'Work GPT' }
    ];

    function writeSettings(llmEntries: any[], primaryLLMModel: string | null = null) {
        const now = new Date().toISOString();
        const globalSettings = {
            id: 'test-global-settings', userId: 'test-user', openaiApiKey: '', geminiApiKey: '', claudeApiKey: '',
            llmEntries, activeLlmEntryId: llmEntries[0]?.id ?? null,
            defaultProvider: 'openai', defaultModel: '', defaultMode: 'default', fontSize: 14,
            showTokenCounts: true, showCostEstimates: true, autoSaveInterval: 30, maxHistoryItems: 100,
            enableNotifications: true, customApiEndpoints: {}, metadata: {}, createdAt: now, updatedAt: now
        };
        const projectSettings = {
            id: 'test-project-settings', projectId: 'test-project', projectName: 'Test Project',
            rawProjectDetailContent: '', digestedProjectDetailContent: '', defaultModel: '', defaultMode: 'default',
            customPrompts: {}, projectSpecificConfig: {}, theme: 'auto', autoSave: true, primaryLLMModel,
            metadata: {}, createdAt: now, updatedAt: now
        };
        const globalFile = path.join(testConfigDir, '.config', 'samurai-agent', 'global_user_settings.json');
        const projectFile = path.join(testWorkspaceRoot, '.vscode', 'samurai-agent', 'project_settings.json');
        [globalFile, projectFile].forEach(file => fs.mkdirSync(path.dirname(file), { recursive: true }));
        fs.writeFileSync(globalFile, JSON.stringify(globalSettings, null, 2));
        fs.writeFileSync(projectFile, JSON.stringify(projectSettings, null, 2));
    }

    async function sendAndGetPayload() {
        await (provider as any).sendInitialSettingsToWebview(mockWebview);
        return mockWebview.postMessage.mock.calls[0][0].payload;
    }

    describe('getAvailableModels method', () => {
        it('returns the user llmEntries mapped to models', () => {
            const models = (provider as any).getAvailableModels({ llmEntries: entries });

            assert.deepStrictEqual(models.map((m: any) => [m.id, m.name, m.provider]), [
                ['entry-claude', 'my-claude', 'anthropic'],
                ['entry-gpt', 'Work GPT', 'openai']
            ]);
        });

        it('returns an empty list when there are no entries (no built-in catalog)', () => {
            assert.strictEqual((provider as any).getAvailableModels({ llmEntries: [] }).length, 0);
            assert.strictEqual((provider as any).getAvailableModels({}).length, 0);
        });

        it('ignores legacy plaintext API keys', () => {
            const models = (provider as any).getAvailableModels({ openaiApiKey: 'k', geminiApiKey: 'k', claudeApiKey: 'k' });
            assert.strictEqual(models.length, 0);
        });
    });

    describe('sendInitialSettingsToWebview method', () => {
        it('sends entries as available models and selects the first as primaryLLMModel', async () => {
            writeSettings(entries);
            const payload = await sendAndGetPayload();

            assert.strictEqual(payload.availableModels.length, entries.length);
            assert.strictEqual(payload.llmModels, undefined, 'No built-in catalog should be sent');
            assert.strictEqual(payload.projectSettings.primaryLLMModel, 'entry-claude');
        });

        it('preserves an existing primaryLLMModel that is still available', async () => {
            writeSettings(entries, 'entry-gpt');
            const payload = await sendAndGetPayload();

            assert.strictEqual(payload.projectSettings.primaryLLMModel, 'entry-gpt');
        });

        it('keeps primaryLLMModel null when no entries are configured', async () => {
            writeSettings([]);
            const payload = await sendAndGetPayload();

            assert.strictEqual(payload.availableModels.length, 0);
            assert.strictEqual(payload.projectSettings.primaryLLMModel, null);
        });
    });
});
