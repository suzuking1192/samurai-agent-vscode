/**
 * Tests for GlobalDataStore
 * Validates the global settings persistence functionality (BYOK: no plaintext API keys)
 */

import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { GlobalDataStore } from '../src/persistence/globalDataStore';
import { GlobalSettings } from '../src/common/models/settings-models';

function baseSettings(overrides: Partial<GlobalSettings> = {}): GlobalSettings {
    return {
        id: 'global-settings',
        userId: 'test-user',
        openaiApiKey: '',
        geminiApiKey: '',
        claudeApiKey: '',
        betaCode: '',
        defaultProvider: 'openai',
        defaultModel: '',
        defaultMode: 'default',
        fontSize: 14,
        showTokenCounts: true,
        showCostEstimates: true,
        autoSaveInterval: 30,
        maxHistoryItems: 100,
        enableNotifications: true,
        enableDebugLogging: false,
        enableRegressionDetection: false,
        regressionBannerDismissed: false,
        customApiEndpoints: {},
        metadata: {},
        llmEntries: [],
        activeLlmEntryId: null,
        createdAt: new Date('2024-01-01'),
        updatedAt: new Date('2024-01-01'),
        ...overrides,
    };
}

describe('GlobalDataStore', () => {
    let globalDataStore: GlobalDataStore;
    let testConfigDir: string;
    let originalXdg: string | undefined;

    beforeEach(() => {
        testConfigDir = path.join(os.tmpdir(), 'samurai-agent-test-global', Date.now().toString());
        fs.mkdirSync(testConfigDir, { recursive: true });
        originalXdg = process.env.XDG_CONFIG_HOME;
        process.env.XDG_CONFIG_HOME = testConfigDir;
        globalDataStore = new GlobalDataStore();
    });

    afterEach(() => {
        if (fs.existsSync(testConfigDir)) {
            fs.rmSync(testConfigDir, { recursive: true, force: true });
        }
        if (originalXdg === undefined) {
            delete process.env.XDG_CONFIG_HOME;
        } else {
            process.env.XDG_CONFIG_HOME = originalXdg;
        }
    });

    describe('Constructor and Configuration', () => {
        it('should create config directory on instantiation', () => {
            assert(fs.existsSync(globalDataStore.getGlobalConfigDir()));
        });

        it('should use XDG_CONFIG_HOME when set', () => {
            const expectedDir = path.join(testConfigDir, 'samurai-agent');
            assert.strictEqual(globalDataStore.getGlobalConfigDir(), expectedDir);
        });
    });

    describe('loadGlobalSettings', () => {
        it('should return default settings when file does not exist', () => {
            const response = globalDataStore.loadGlobalSettings('test-request-1');
            assert.strictEqual(response.type, 'success');
            assert(response.payload);
            const settings = response.payload as GlobalSettings;
            assert.strictEqual(settings.id, 'global-settings');
            assert.strictEqual(settings.openaiApiKey, '');
            assert.strictEqual(settings.geminiApiKey, '');
            assert.strictEqual(settings.claudeApiKey, '');
            assert.deepStrictEqual(settings.llmEntries, []);
            assert.strictEqual(settings.activeLlmEntryId, null);
            assert(!('theme' in settings));
        });

        it('should load existing settings from file including llmEntries', () => {
            const testSettings = baseSettings({
                fontSize: 16,
                maxHistoryItems: 200,
                metadata: { test: 'value' },
                llmEntries: [{ id: 'entry-1', provider: 'openai', modelName: 'gpt-4o' }],
                activeLlmEntryId: 'entry-1',
                createdAt: new Date('2024-01-01'),
                updatedAt: new Date('2024-01-02'),
            });
            fs.writeFileSync(globalDataStore.getGlobalSettingsPath(), JSON.stringify(testSettings, null, 2));

            const response = globalDataStore.loadGlobalSettings('test-request-2');
            assert.strictEqual(response.type, 'success');
            const loaded = response.payload as GlobalSettings;
            assert.strictEqual(loaded.fontSize, 16);
            assert.strictEqual(loaded.maxHistoryItems, 200);
            assert.strictEqual(loaded.metadata.test, 'value');
            assert.strictEqual(loaded.llmEntries?.length, 1);
            assert.strictEqual(loaded.activeLlmEntryId, 'entry-1');
        });

        it('should ignore theme and autoSave fields from old format files', () => {
            const oldFormatSettings = {
                ...baseSettings(),
                theme: 'dark',
                autoSave: false,
            };
            fs.writeFileSync(globalDataStore.getGlobalSettingsPath(), JSON.stringify(oldFormatSettings, null, 2));

            const response = globalDataStore.loadGlobalSettings('test-request-3');
            assert.strictEqual(response.type, 'success');
            const loaded = response.payload as GlobalSettings;
            assert(!('theme' in loaded));
            assert(!('autoSave' in loaded));
            assert.strictEqual(loaded.fontSize, 14);
        });

        it('should handle corrupted JSON files gracefully', () => {
            fs.writeFileSync(globalDataStore.getGlobalSettingsPath(), 'invalid json content');
            const response = globalDataStore.loadGlobalSettings('test-request-4');
            assert.strictEqual(response.type, 'error');
            assert(response.error?.includes('Failed to load global settings'));
        });
    });

    describe('saveGlobalSettings', () => {
        it('should save settings without plaintext API keys', () => {
            const testSettings = baseSettings({
                openaiApiKey: 'sk-test-save-key',
                geminiApiKey: 'gemini-test-key',
                claudeApiKey: 'claude-test-key',
                defaultProvider: 'anthropic',
                defaultModel: 'claude-3-opus',
                fontSize: 18,
                metadata: { env: 'test' },
                llmEntries: [{ id: 'e1', provider: 'anthropic', modelName: 'claude-3-opus' }],
                activeLlmEntryId: 'e1',
                createdAt: new Date('2024-02-01'),
                updatedAt: new Date('2024-02-01'),
            });

            const response = globalDataStore.saveGlobalSettings(testSettings, 'test-request-5');
            assert.strictEqual(response.type, 'success');
            assert.strictEqual(response.payload?.openaiApiKey, '');
            assert.strictEqual(response.payload?.geminiApiKey, '');
            assert.strictEqual(response.payload?.claudeApiKey, '');

            const savedData = JSON.parse(fs.readFileSync(globalDataStore.getGlobalSettingsPath(), 'utf8'));
            assert.strictEqual(savedData.openaiApiKey, '');
            assert.strictEqual(savedData.geminiApiKey, '');
            assert.strictEqual(savedData.claudeApiKey, '');
            assert.strictEqual(savedData.defaultProvider, 'anthropic');
            assert.strictEqual(savedData.metadata.env, 'test');
            assert.strictEqual(savedData.llmEntries[0].id, 'e1');
            assert.strictEqual(savedData.activeLlmEntryId, 'e1');
        });

        it('should update timestamps when saving', () => {
            const beforeSave = new Date();
            globalDataStore.saveGlobalSettings(baseSettings(), 'test-request-6');
            const afterSave = new Date();
            const savedData = JSON.parse(fs.readFileSync(globalDataStore.getGlobalSettingsPath(), 'utf8'));
            const savedUpdatedAt = new Date(savedData.updatedAt);
            assert(savedUpdatedAt >= beforeSave && savedUpdatedAt <= afterSave);
        });

        it('should return error when saving null/undefined settings', () => {
            const response = globalDataStore.saveGlobalSettings(null as any, 'test-request-7');
            assert.strictEqual(response.type, 'error');
            assert(response.error?.includes('Global settings data is required'));
        });
    });

    describe('BYOK model entries', () => {
        it('should persist llmEntries across save/load cycles', () => {
            const initial = baseSettings({
                llmEntries: [{ id: 'entry-a', provider: 'openai', modelName: 'gpt-4o', label: 'Main' }],
                activeLlmEntryId: 'entry-a',
            });
            globalDataStore.saveGlobalSettings(initial, 'initial');

            const loaded = globalDataStore.loadGlobalSettings('load').payload as GlobalSettings;
            loaded.llmEntries = [
                ...(loaded.llmEntries ?? []),
                { id: 'entry-b', provider: 'google', modelName: 'gemini-2.5-flash' },
            ];
            loaded.activeLlmEntryId = 'entry-b';
            globalDataStore.saveGlobalSettings(loaded, 'update');

            const finalSettings = globalDataStore.loadGlobalSettings('final').payload as GlobalSettings;
            assert.strictEqual(finalSettings.llmEntries?.length, 2);
            assert.strictEqual(finalSettings.activeLlmEntryId, 'entry-b');
            assert.strictEqual(finalSettings.openaiApiKey, '');
            assert.strictEqual(finalSettings.geminiApiKey, '');
        });
    });
});
