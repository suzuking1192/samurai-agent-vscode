/**
 * Global DataStore for user-wide settings persistence
 * Handles storage and retrieval of GlobalSettings in user-specific config directory
 */

import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs';
import { randomUUID } from 'crypto';
import { GlobalSettings } from '../common/models/settings-models';
import { ApiResponse, ResponseType } from '../common/models/response-models';

export class GlobalDataStore {
    private globalConfigDir: string;
    private globalSettingsFile: string;
    
    constructor() {
        // Determine user-specific config directory based on platform
        const homeDir = os.homedir();
        if (process.platform === 'win32') {
            // Windows: %APPDATA%/samurai-agent/
            this.globalConfigDir = path.join(homeDir, 'AppData', 'Roaming', 'samurai-agent');
        } else {
            const configHome = process.env.XDG_CONFIG_HOME || path.join(homeDir, '.config');
            this.globalConfigDir = path.join(configHome, 'samurai-agent');
        }

        this.globalSettingsFile = path.join(this.globalConfigDir, 'global_user_settings.json');
        this.ensureConfigDirectory();
    }
    
    /**
     * Ensures the global config directory exists
     */
    private ensureConfigDirectory(): void {
        if (!fs.existsSync(this.globalConfigDir)) {
            fs.mkdirSync(this.globalConfigDir, { recursive: true });
        }
    }
    
    /**
     * Creates a standardized API response
     */
    private createResponse<T>(
        type: ResponseType, 
        requestId?: string, 
        payload?: T, 
        error?: string
    ): ApiResponse<T> {
        return {
            type,
            requestId,
            payload,
            error,
            timestamp: new Date()
        };
    }
    
    /**
     * Creates a success response
     */
    private createSuccessResponse<T>(requestId?: string, payload?: T): ApiResponse<T> {
        return this.createResponse(ResponseType.SUCCESS, requestId, payload);
    }
    
    /**
     * Creates an error response
     */
    private createErrorResponse<T>(requestId?: string, error?: string): ApiResponse<T> {
        return this.createResponse(ResponseType.ERROR, requestId, undefined as T, error);
    }
    
    /**
     * Reads global settings from the user-specific config directory
     * Alias for loadGlobalSettings for consistency with requirements
     */
    public readGlobalSettings(requestId?: string): ApiResponse<GlobalSettings> {
        return this.loadGlobalSettings(requestId);
    }

    /**
     * Loads global settings from the user-specific config directory
     * Ignores theme, autoSave, and model arrays if they exist in old format files
     */
    public loadGlobalSettings(requestId?: string): ApiResponse<GlobalSettings> {
        try {
            if (!fs.existsSync(this.globalSettingsFile)) {
                // Create and persist default global settings if file doesn't exist
                // This ensures userId is persisted immediately and remains consistent across installations
                const defaultSettings: GlobalSettings = {
                    id: 'global-settings',
                    userId: randomUUID(), // Generate anonymized user ID
                    openaiApiKey: '',
                    geminiApiKey: '',
                    claudeApiKey: '',
                    betaCode: '', // Deprecated; kept only for settings-file compatibility
                    llmEntries: [],
                    activeLlmEntryId: null,
                    defaultProvider: 'google' as any,
                    defaultModel: '',
                    defaultMode: 'default' as any,
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
                    createdAt: new Date(),
                    updatedAt: new Date()
                };
                // Persist the default settings immediately to ensure userId is saved
                this.ensureConfigDirectory();
                fs.writeFileSync(this.globalSettingsFile, JSON.stringify(defaultSettings, null, 2));
                return this.createSuccessResponse(requestId, defaultSettings);
            }
            
            const data = fs.readFileSync(this.globalSettingsFile, 'utf8');
            const rawSettings = JSON.parse(data);
            
            // Filter out theme, autoSave, and model arrays if they exist (migration from old format)
            const { theme, autoSave, openaiModels, geminiModels, claudeModels, ...cleanSettings } = rawSettings;
            
            // Ensure required fields exist with defaults
            const settings: GlobalSettings = {
                id: cleanSettings.id || 'global-settings',
                userId: cleanSettings.userId || randomUUID(), // Generate anonymized user ID if missing
                openaiApiKey: cleanSettings.openaiApiKey || '',
                geminiApiKey: cleanSettings.geminiApiKey || '',
                claudeApiKey: cleanSettings.claudeApiKey || '',
                betaCode: cleanSettings.betaCode || '', // Deprecated; kept only for settings-file compatibility
                llmEntries: Array.isArray(cleanSettings.llmEntries) ? cleanSettings.llmEntries : [],
                activeLlmEntryId: cleanSettings.activeLlmEntryId ?? null,
                defaultProvider: cleanSettings.defaultProvider || 'openai',
                defaultModel: cleanSettings.defaultModel || '',
                defaultMode: cleanSettings.defaultMode || 'default',
                fontSize: cleanSettings.fontSize || 14,
                showTokenCounts: cleanSettings.showTokenCounts !== undefined ? cleanSettings.showTokenCounts : true,
                showCostEstimates: cleanSettings.showCostEstimates !== undefined ? cleanSettings.showCostEstimates : true,
                autoSaveInterval: cleanSettings.autoSaveInterval || 30,
                maxHistoryItems: cleanSettings.maxHistoryItems || 100,
                enableNotifications: cleanSettings.enableNotifications !== undefined ? cleanSettings.enableNotifications : true,
                enableDebugLogging: cleanSettings.enableDebugLogging !== undefined ? cleanSettings.enableDebugLogging : false,
                enableRegressionDetection: cleanSettings.enableRegressionDetection !== undefined ? cleanSettings.enableRegressionDetection : false,
                regressionBannerDismissed: cleanSettings.regressionBannerDismissed !== undefined ? cleanSettings.regressionBannerDismissed : false,
                customApiEndpoints: cleanSettings.customApiEndpoints || {},
                proxySettings: cleanSettings.proxySettings,
                metadata: cleanSettings.metadata || {},
                createdAt: cleanSettings.createdAt ? new Date(cleanSettings.createdAt) : new Date(),
                updatedAt: cleanSettings.updatedAt ? new Date(cleanSettings.updatedAt) : new Date()
            };
            
            return this.createSuccessResponse(requestId, settings);
        } catch (error) {
            console.error('Error loading global settings:', error);
            return this.createErrorResponse(requestId, `Failed to load global settings: ${error instanceof Error ? error.message : 'Unknown error'}`);
        }
    }
    
    /**
     * Saves global settings to the user-specific config directory
     */
    public saveGlobalSettings(settings: GlobalSettings, requestId?: string): ApiResponse<GlobalSettings> {
        try {
            if (!settings) {
                return this.createErrorResponse(requestId, 'Global settings data is required');
            }
            
            // Ensure config directory exists
            this.ensureConfigDirectory();
            
            // Merge with existing on-disk settings to prevent accidental field erasure
            const existingOnDisk = this.loadSettingsFromDisk();

            // Update timestamps
            const now = new Date();
            const updatedSettings: GlobalSettings = {
                ...existingOnDisk,   // existing values as base
                ...settings,          // incoming values override
                // API keys live in SecretStorage; never persist plaintext provider keys.
                // Legacy keys are moved into SecretStorage by migrateLegacyKeys on activation.
                openaiApiKey: '',
                geminiApiKey: '',
                claudeApiKey: '',
                updatedAt: now,
                createdAt: settings.createdAt || existingOnDisk?.createdAt || now
            };
            
            // Write to file
            fs.writeFileSync(this.globalSettingsFile, JSON.stringify(updatedSettings, null, 2));
            
            return this.createSuccessResponse(requestId, updatedSettings);
        } catch (error) {
            console.error('Error saving global settings:', error);
            return this.createErrorResponse(requestId, `Failed to save global settings: ${error instanceof Error ? error.message : 'Unknown error'}`);
        }
    }
    
    /**
     * Gets the path to the global settings file (for debugging/testing)
     */
    public getGlobalSettingsPath(): string {
        return this.globalSettingsFile;
    }
    
    /**
     * Gets the path to the global config directory (for debugging/testing)
     */
    public getGlobalConfigDir(): string {
        return this.globalConfigDir;
    }

    /**
     * Reads raw settings JSON from disk without the full loadGlobalSettings response wrapper.
     * Used for defensive merge in saveGlobalSettings to prevent accidental field erasure.
     */
    private loadSettingsFromDisk(): Partial<GlobalSettings> | null {
        try {
            if (!fs.existsSync(this.globalSettingsFile)) {
                return null;
            }
            return JSON.parse(fs.readFileSync(this.globalSettingsFile, 'utf8'));
        } catch {
            return null;
        }
    }
}
