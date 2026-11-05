// Settings Tab JavaScript - Handles LLM configuration and project details
console.log('Settings: settings.js script loaded');

// Guard against missing WebviewApi
if (!window.WebviewApi) {
    console.warn('Settings: WebviewApi not ready yet; deferring init...');
    document.addEventListener('readystatechange', function onReady() {
        if (window.WebviewApi) {
            document.removeEventListener('readystatechange', onReady);
            console.log('Settings: WebviewApi now available, initializing...');
            // Initialize settings functionality
            initializeSettings();
        }
    });
} else {
    console.log('Settings: WebviewApi available, initializing...');
    // Initialize settings functionality immediately
    initializeSettings();
}

// Initialize settings functionality
function initializeSettings() {
    console.log('Settings: Initializing settings functionality...');

// Settings state - now using the new persistence API
let settingsState = {
    globalSettings: {
        llmEntries: [],
        activeLlmEntryId: null
    },
    projectSettings: {
        rawProjectDetailContent: '',
        digestedProjectDetailContent: '',
        primaryLLMModel: null
    },
    isLoading: false
};

// Initialize settings functionality when DOM is loaded
document.addEventListener('DOMContentLoaded', function() {
    console.log('Settings: DOMContentLoaded event fired');
    initializeSettingsTab();
    
    // Set up message listener for webview refresh notifications
    setupSettingsMessageListener();
});

// Set up message listener to handle webview refresh notifications
function setupSettingsMessageListener() {
    console.log('Settings: Setting up message listener for webview refresh');
    
    // Listen for messages from the webview provider
    window.addEventListener('message', function(event) {
        const message = event.data;
        if (!message || typeof message !== 'object') {
            return;
        }
        
        console.log('Settings: Received message:', message.type);
        
        if (message.type === 'webviewRefresh') {
            console.log('Settings: Received webviewRefresh notification, refreshing settings state');
            // Call the refresh function if it's available
            if (window.SettingsManager?.refreshSettingsState) {
                window.SettingsManager.refreshSettingsState();
            }
        }
    });
}

async function initializeSettingsTab() {
    console.log('Settings: initializeSettingsTab called');
    
    // Load settings using the new persistence API
    await loadSettingsFromPersistence();
    
    // Render settings when settings tab is shown
    const settingsTab = document.getElementById('setting-tab');
    console.log('Settings: Settings tab element found:', !!settingsTab);
    
    if (settingsTab) {
        settingsTab.addEventListener('click', async function() {
            console.log('Settings: Settings tab clicked');
            // Show loading state while fetching fresh data
            const settingsContent = document.getElementById('setting-content');
            if (settingsContent) {
                const hideLoading = window.WebviewApi?.ui?.showGlobalLoading(settingsContent, 'Loading settings...');
                try {
                    await loadSettingsFromPersistence();
                    setTimeout(renderSettings, 100); // Small delay to ensure tab content is visible
                } finally {
                    if (hideLoading) hideLoading();
                }
            }
        });
    }
    
    // Initial render if settings tab is already active
    const settingsContent = document.getElementById('setting-content');
    console.log('Settings: Settings content element found:', !!settingsContent);
    console.log('Settings: Settings content display:', settingsContent ? settingsContent.style.display : 'not found');
    
    if (settingsContent && settingsContent.style.display !== 'none') {
        console.log('Settings: Rendering settings initially');
        renderSettings();
    }
    
    // Fallback mechanism: Check if settings need to be refreshed periodically
    // This helps in case the visibility change handler doesn't fire
    setInterval(() => {
        const currentSettingsContent = document.getElementById('setting-content');
        if (currentSettingsContent && currentSettingsContent.style.display !== 'none') {
            // If settings tab is visible but we don't have proper state, refresh it
            if (!settingsState.globalSettings || Object.keys(settingsState.globalSettings).length === 0) {
                console.log('Settings: Periodic check - refreshing settings state');
                void loadSettingsFromPersistence().then(() => {
                    renderSettings();
                });
            }
        }
    }, 15000); // Check every 15 seconds
}

function renderSettings() {
    console.log('Settings: renderSettings called');
    
    const settingsContent = document.getElementById('setting-content');
    if (!settingsContent) {
        console.log('Settings: Settings content element not found');
        return;
    }
    
    console.log('Settings: Rendering settings HTML');
    
    settingsContent.innerHTML = `
        <div class="settings-container">
            <div class="settings-header">
                <h3>Settings</h3>
                <div class="settings-header-actions">
                    <button class="settings-save-all-btn" id="save-all-settings">Save All Settings</button>
                    <button class="settings-close-btn" id="settings-close-btn" title="Close Settings">✕</button>
                </div>
            </div>
            
            <!-- API Cost Display -->
            <div class="api-cost-display" id="api-cost-display">
                API Cost: $0.00 this month
            </div>
            
            <!-- Debug Logging Section -->
            ${renderDebugLoggingSection()}

            <!-- Regression Detection Section -->
            ${renderRegressionDetectionSection()}

            <!-- BYOK Models -->
            ${renderLlmEntriesSection()}
        </div>
    `;
    
    // Attach event listeners
    console.log('Settings: About to attach event listeners');
    attachSettingsEventListeners();
    
    // Refresh cost display when settings page is rendered
    if (window.ChatManager?.refreshCostDisplay) {
        window.ChatManager.refreshCostDisplay();
    }
}

function renderDebugLoggingSection() {
    const isEnabled = settingsState.globalSettings.enableDebugLogging || false;
    
    return `
        <div class="telemetry-section">
            <fieldset>
                <legend>Debug Logging</legend>
                
                <div class="settings-form-group">
                    <label class="telemetry-toggle-label">
                        <input type="checkbox" 
                               id="debug-logging-toggle" 
                               ${isEnabled ? 'checked' : ''}
                               class="telemetry-toggle">
                        <span class="telemetry-toggle-text">
                            Enable debug logging
                        </span>
                    </label>
                    <p class="telemetry-description">
                        When enabled, saves debugging logs and intermediate results to the debug-output folder. 
                        Disabled by default to keep your workspace clean.
                    </p>
                </div>
            </fieldset>
        </div>
    `;
}

function renderRegressionDetectionSection() {
    const isEnabled = settingsState.globalSettings.enableRegressionDetection || false;
    const thresholdValue = settingsState.globalSettings.regressionThreshold || 'always';

    return `
        <div class="telemetry-section">
            <fieldset>
                <legend>Regression Detection</legend>

                <div class="settings-form-group">
                    <label class="telemetry-toggle-label">
                        <input type="checkbox"
                               id="regression-detection-toggle"
                               ${isEnabled ? 'checked' : ''}
                               class="telemetry-toggle">
                        <span class="telemetry-toggle-text">
                            Auto Regression Bug Detection
                        </span>
                    </label>
                    <p class="telemetry-description">
                        Automatically detects AI-like edit bursts and scores them for regression risk.
                        When risky changes are detected, you'll be prompted to review them with Samurai Agent.
                    </p>
                </div>

                <div class="settings-form-group">
                    <label for="regression-threshold-select">Warning Sensitivity:</label>
                    <select id="regression-threshold-select" class="settings-select">
                        <option value="always" ${thresholdValue === 'always' ? 'selected' : ''}>Always</option>
                        <option value="moderate" ${thresholdValue === 'moderate' ? 'selected' : ''}>Moderate risk or higher</option>
                        <option value="high" ${thresholdValue === 'high' ? 'selected' : ''}>High risk only</option>
                    </select>
                    <p class="telemetry-description">
                        Controls when regression warnings are shown based on risk score.
                    </p>
                </div>
            </fieldset>
        </div>
    `;
}

const LLM_PROVIDER_LABELS = { openai: 'OpenAI', google: 'Google (Gemini)', anthropic: 'Anthropic (Claude)' };

function escapeHtml(value) {
    const div = document.createElement('div');
    div.textContent = value == null ? '' : String(value);
    return div.innerHTML.replace(/"/g, '&quot;');
}

function renderLlmEntryRow(entry, activeId) {
    const isActive = entry.id === activeId;
    return `
        <li class="model-item" data-entry-id="${escapeHtml(entry.id)}">
            <span class="model-name">${escapeHtml(entry.label || entry.modelName)}</span>
            <span class="model-description">${escapeHtml(LLM_PROVIDER_LABELS[entry.provider] || entry.provider)} · ${escapeHtml(entry.modelName)}${isActive ? ' · Active' : ''}</span>
            ${isActive ? '' : `<button class="settings-secondary-save-btn llm-entry-activate" data-entry-id="${escapeHtml(entry.id)}">Set active</button>`}
            <button class="settings-secondary-save-btn llm-entry-delete" data-entry-id="${escapeHtml(entry.id)}">Delete</button>
        </li>`;
}

function renderLlmEntriesSection() {
    const entries = settingsState.globalSettings.llmEntries || [];
    const activeId = settingsState.globalSettings.activeLlmEntryId;
    const list = entries.length
        ? `<ul class="model-list">${entries.map(entry => renderLlmEntryRow(entry, activeId)).join('')}</ul>`
        : '<p class="telemetry-description">No models yet. Add a model and API key below to start using Samurai Agent.</p>';
    const providerOptions = Object.entries(LLM_PROVIDER_LABELS)
        .map(([value, label]) => `<option value="${value}">${label}</option>`).join('');

    return `
        <div class="llm-provider-section">
            <fieldset>
                <legend>Models (Bring Your Own Key)</legend>
                ${list}
                <div class="settings-form-group">
                    <label for="llm-entry-provider">Provider:</label>
                    <select id="llm-entry-provider" class="settings-select">${providerOptions}</select>
                </div>
                <div class="settings-form-group">
                    <label for="llm-entry-model">Model name:</label>
                    <input type="text" id="llm-entry-model" placeholder="e.g. gpt-4o, gemini-2.5-flash, claude-sonnet-4-20250514" autocomplete="off">
                </div>
                <div class="settings-form-group">
                    <label for="llm-entry-key">API key:</label>
                    <input type="password" id="llm-entry-key" placeholder="Stored securely in VS Code SecretStorage" autocomplete="off">
                </div>
                <div class="settings-form-group">
                    <button class="settings-secondary-save-btn" id="llm-entry-add">Add model</button>
                </div>
            </fieldset>
        </div>
    `;
}

async function runLlmEntryCommand(command, payload, successMessage) {
    try {
        const updated = await window.WebviewApi.postCommand(command, payload);
        if (updated) {
            settingsState.globalSettings = { ...settingsState.globalSettings, ...updated };
        }
        renderSettings();
        showSaveSuccess(successMessage);
    } catch (error) {
        showSaveError(`Failed: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
}

function attachLlmEntryListeners() {
    document.getElementById('llm-entry-add')?.addEventListener('click', () => {
        void runLlmEntryCommand('saveLlmEntry', {
            provider: document.getElementById('llm-entry-provider')?.value,
            modelName: document.getElementById('llm-entry-model')?.value,
            apiKey: document.getElementById('llm-entry-key')?.value
        }, 'Model added.');
    });
    document.querySelectorAll('.llm-entry-activate').forEach(button => {
        button.addEventListener('click', () => {
            void runLlmEntryCommand('setActiveLlmEntry', { id: button.dataset.entryId }, 'Active model updated.');
        });
    });
    document.querySelectorAll('.llm-entry-delete').forEach(button => {
        button.addEventListener('click', () => {
            void runLlmEntryCommand('deleteLlmEntry', { id: button.dataset.entryId }, 'Model deleted.');
        });
    });
}

function renderProjectDetailSection() {
    const projectDetailValue = settingsState.projectSettings.rawProjectDetailContent || '';
    const digestedMemoryValue = settingsState.projectSettings.digestedProjectDetailContent || '';
    
    return `
        <div class="project-detail-section">
            <h4>Project Details</h4>
            
            <div class="settings-form-group">
                <label for="project-detail-text">Project Detailed Text:</label>
                <textarea id="project-detail-text" 
                          placeholder="Enter detailed information about your project...">${projectDetailValue}</textarea>
            </div>
            
            <div class="settings-form-group">
                <button class="settings-save-btn" data-section="project">Save Project Details</button>
            </div>
            
            <div class="digested-memory-section">
                <button id="show-digested-memory">See Digested Project Detail Memory</button>
                <div id="digested-memory-display" class="digested-memory-display" style="display: none;">
                    <textarea id="digested-memory-text" placeholder="No digested project detail available yet.">${digestedMemoryValue}</textarea>
                    <div class="digested-memory-actions" style="margin-top: 8px;">
                        <button id="save-digested-memory" class="settings-secondary-save-btn">Save Digested Project Detail</button>
                        <span id="digested-memory-status" class="digested-memory-status"></span>
                    </div>
                </div>
            </div>
        </div>
    `;
}

function attachSettingsEventListeners() {
    console.log('Settings: attachSettingsEventListeners called');
    
    attachLlmEntryListeners();
    
    // Debug logging toggle
    const debugLoggingToggle = document.getElementById('debug-logging-toggle');
    if (debugLoggingToggle) {
        debugLoggingToggle.addEventListener('change', async function() {
            const isEnabled = this.checked;
            settingsState.globalSettings.enableDebugLogging = isEnabled;
            
            try {
                // Save immediately to global settings
                await saveGlobalSettingsWithFeedback();
                showSaveSuccess(`Debug logging ${isEnabled ? 'enabled' : 'disabled'} successfully!`);
            } catch (error) {
                console.error('Error updating debug logging setting:', error);
                showSaveError(`Failed to update debug logging setting: ${error.message}`);
                // Revert the toggle state
                this.checked = !isEnabled;
                settingsState.globalSettings.enableDebugLogging = !isEnabled;
            }
        });
    }
    
    // Regression detection toggle
    const regressionDetectionToggle = document.getElementById('regression-detection-toggle');
    if (regressionDetectionToggle) {
        regressionDetectionToggle.addEventListener('change', async function() {
            const isEnabled = this.checked;
            settingsState.globalSettings.enableRegressionDetection = isEnabled;

            try {
                await saveGlobalSettingsWithFeedback();
                // Notify extension to toggle the tracker
                window.WebviewApi.postCommand('regressionDetectionToggled', { enabled: isEnabled });
                showSaveSuccess(`Regression detection ${isEnabled ? 'enabled' : 'disabled'} successfully!`);
            } catch (error) {
                console.error('Error updating regression detection setting:', error);
                showSaveError(`Failed to update regression detection setting: ${error.message}`);
                this.checked = !isEnabled;
                settingsState.globalSettings.enableRegressionDetection = !isEnabled;
            }
        });
    }

    // Regression threshold dropdown
    const regressionThresholdSelect = document.getElementById('regression-threshold-select');
    if (regressionThresholdSelect) {
        regressionThresholdSelect.addEventListener('change', async function() {
            const selectedValue = this.value;
            settingsState.globalSettings.regressionThreshold = selectedValue;

            try {
                // Notify extension to update VS Code config
                window.WebviewApi.postCommand('regressionThresholdChanged', { threshold: selectedValue });
                showSaveSuccess(`Warning sensitivity updated to "${selectedValue}"`);
            } catch (error) {
                console.error('Error updating regression threshold setting:', error);
                showSaveError(`Failed to update warning sensitivity: ${error.message}`);
            }
        });
    }

    // Project detail textarea - save on input with loading feedback
    const projectDetailTextarea = document.getElementById('project-detail-text');
    if (projectDetailTextarea) {
        projectDetailTextarea.addEventListener('input', function() {
            settingsState.projectSettings.rawProjectDetailContent = this.value;
        });
    }
    
    // Show digested memory button
    const showDigestedMemoryBtn = document.getElementById('show-digested-memory');
    if (showDigestedMemoryBtn) {
        showDigestedMemoryBtn.addEventListener('click', function() {
            toggleDigestedMemory();
        });
    }

    const digestedMemoryTextarea = document.getElementById('digested-memory-text');
    if (digestedMemoryTextarea) {
        digestedMemoryTextarea.addEventListener('input', function() {
            settingsState.projectSettings.digestedProjectDetailContent = this.value;
        });
    }

    const saveDigestedMemoryBtn = document.getElementById('save-digested-memory');
    if (saveDigestedMemoryBtn) {
        saveDigestedMemoryBtn.addEventListener('click', async function() {
            const hideLoading = window.WebviewApi?.ui?.showLoading(this, 'Saving...');
            const newDigestedValue = document.getElementById('digested-memory-text')?.value ?? '';
            try {
                const projectId = settingsState.projectSettings.projectId || 'default-project';
        const updatedSettings = {
            ...settingsState.projectSettings,
            projectId,
            digestedProjectDetailContent: newDigestedValue,
            updatedAt: new Date()
        };

        settingsState.projectSettings = updatedSettings;
        await window.WebviewApi.persistence.saveProjectSettings(updatedSettings);

                const status = document.getElementById('digested-memory-status');
                if (status) {
                    status.textContent = 'Saved!';
                    setTimeout(() => {
                        status.textContent = '';
                    }, 2000);
                }
                showSaveSuccess('Digested project detail saved successfully!');
            } catch (error) {
                console.error('Error saving digested memory:', error);
                const status = document.getElementById('digested-memory-status');
                if (status) {
                    status.textContent = 'Save failed';
                    setTimeout(() => {
                        status.textContent = '';
                    }, 4000);
                }
                showSaveError(`Failed to save digested project detail: ${error instanceof Error ? error.message : 'Unknown error'}`);
            } finally {
                if (hideLoading) hideLoading();
            }
        });
    }
    
    // Close Settings button
    const closeBtn = document.getElementById('settings-close-btn');
    if (closeBtn) {
        closeBtn.addEventListener('click', function() {
            // Switch back to chat tab
            if (window.SamuraiAgentPanel && typeof window.SamuraiAgentPanel.switchTab === 'function') {
                window.SamuraiAgentPanel.switchTab('chat');
            } else {
                // Fallback: manually hide settings and show chat
                const settingContent = document.getElementById('setting-content');
                const chatContent = document.getElementById('chat-content');
                if (settingContent && chatContent) {
                    settingContent.style.display = 'none';
                    chatContent.style.display = 'flex';
                }
            }
        });
    }
    
    // Save All Settings button
    const saveAllBtn = document.getElementById('save-all-settings');
    if (saveAllBtn) {
        saveAllBtn.addEventListener('click', async function() {
            const hideLoading = window.WebviewApi?.ui?.showLoading(this, 'Saving all settings...');
            try {
                await saveGlobalSettingsWithFeedback();
                if (settingsState.projectSettings.rawProjectDetailContent?.trim()) {
                    await ingestAndPersistProjectDetail();
                } else {
                    await saveProjectSettingsWithFeedback();
                }
                showSaveSuccess('All settings saved successfully!');
            } catch (error) {
                showSaveError(`Save failed: ${error instanceof Error ? error.message : 'Unknown error'}`);
            } finally {
                if (hideLoading) hideLoading();
            }
        });
    }
    
    // Individual Save buttons
    const saveButtons = document.querySelectorAll('.settings-save-btn');
    console.log('Settings: Found save buttons:', saveButtons.length);
    
    saveButtons.forEach(button => {
        button.addEventListener('click', async function() {
            const section = this.getAttribute('data-section');

            const hideLoading = window.WebviewApi?.ui?.showLoading(this, 'Processing...');
            try {
                if (section === 'project') {
                    await ingestAndPersistProjectDetail();
                }
            } catch (error) {
                showSaveError(`Save failed: ${error instanceof Error ? error.message : 'Unknown error'}`);
            } finally {
                if (hideLoading) hideLoading();
            }
        });
    });
}

async function ingestAndPersistProjectDetail() {
    const rawText = (settingsState.projectSettings.rawProjectDetailContent || '').trim();
    if (!rawText) {
        showSaveError('Project detail text is empty. Please provide content before saving.');
        return;
    }

    const projectId = settingsState.projectSettings.projectId || 'default-project';
    const mode = settingsState.projectSettings.digestedProjectDetailContent ? 'merge' : 'synthesis';

    try {
        const result = await window.WebviewApi.projectDetail.ingest({ projectId, rawText, mode });
        const finalText = result?.finalText || result || '';

        settingsState.projectSettings.digestedProjectDetailContent = finalText;
        await window.WebviewApi.persistence.saveProjectSettings(settingsState.projectSettings);

        const textarea = document.getElementById('digested-memory-text');
        if (textarea) {
            textarea.value = finalText;
        }
        const display = document.getElementById('digested-memory-display');
        if (display) {
            display.style.display = 'block';
        }
        showSaveSuccess('Project details processed successfully!');
    } catch (error) {
        showSaveError(`Failed to process project detail: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
}

// New persistence-based save functions
async function loadSettingsFromPersistence() {
    try {
        // Load global settings
        const globalSettings = await window.WebviewApi.persistence.loadGlobalSettings();
        if (globalSettings) {
            settingsState.globalSettings = { ...settingsState.globalSettings, ...globalSettings };
        }
        
        // Load project settings
        const projectSettings = await window.WebviewApi.persistence.loadProjectSettings();
        if (projectSettings) {
            settingsState.projectSettings = { ...settingsState.projectSettings, ...projectSettings };
        }
        
        console.log('Settings loaded from persistence:', settingsState);
    } catch (error) {
        console.error('Error loading settings from persistence:', error);
        showSaveError(`Failed to load settings: ${error.message}`);
    }
}

async function saveGlobalSettingsWithFeedback() {
    try {
        // Update state from UI
        updateGlobalSettingsFromUI();
        
        // Save using persistence API
        await window.WebviewApi.persistence.saveGlobalSettings(globalSettingsForSave());
        
        showSaveSuccess('Global settings saved successfully!');
        console.log('Global settings saved:', settingsState.globalSettings);
        
        // Note: globalSettingsUpdated message will be sent by the webview provider
    } catch (error) {
        console.error('Error saving global settings:', error);
        showSaveError(`Save failed: ${error.message}`);
        throw error;
    }
}

async function saveProjectSettingsWithFeedback() {
    try {
        // Update state from UI
        updateProjectSettingsFromUI();
        
        // Save using persistence API
        await window.WebviewApi.persistence.saveProjectSettings(settingsState.projectSettings);
        
        showSaveSuccess('Project settings saved successfully!');
        console.log('Project settings saved:', settingsState.projectSettings);
    } catch (error) {
        console.error('Error saving project settings:', error);
        showSaveError(`Save failed: ${error.message}`);
        throw error;
    }
}

/** Model entries are managed via dedicated commands; never overwrite them (or keys) from a generic save. */
function globalSettingsForSave() {
    const { llmEntries, activeLlmEntryId, ...rest } = settingsState.globalSettings;
    return rest;
}

function updateGlobalSettingsFromUI() {
    settingsState.globalSettings.enableDebugLogging = document.getElementById('debug-logging-toggle')?.checked || false;
    settingsState.globalSettings.enableRegressionDetection = document.getElementById('regression-detection-toggle')?.checked || false;
}

function updateProjectSettingsFromUI() {
    // Update project detail text
    settingsState.projectSettings.rawProjectDetailContent = document.getElementById('project-detail-text')?.value || '';
}

function showSaveSuccess(message) {
    // Create or update success message
    let successDiv = document.getElementById('settings-success-message');
    if (!successDiv) {
        successDiv = document.createElement('div');
        successDiv.id = 'settings-success-message';
        successDiv.className = 'settings-success-message';
        document.querySelector('.settings-container').appendChild(successDiv);
    }
    
    successDiv.textContent = message;
    successDiv.style.display = 'block';
    
    // Hide after 3 seconds
    setTimeout(() => {
        successDiv.style.display = 'none';
    }, 3000);
}

function showSaveError(message) {
    // Create or update error message
    let errorDiv = document.getElementById('settings-error-message');
    if (!errorDiv) {
        errorDiv = document.createElement('div');
        errorDiv.id = 'settings-error-message';
        errorDiv.className = 'settings-error-message';
        errorDiv.style.color = '#dc3545';
        errorDiv.style.backgroundColor = '#f8d7da';
        errorDiv.style.border = '1px solid #f5c6cb';
        errorDiv.style.padding = '10px';
        errorDiv.style.margin = '10px 0';
        errorDiv.style.borderRadius = '4px';
        document.querySelector('.settings-container').appendChild(errorDiv);
    }
    
    errorDiv.textContent = message;
    errorDiv.style.display = 'block';
    
    // Hide after 5 seconds
    setTimeout(() => {
        errorDiv.style.display = 'none';
    }, 5000);
}

function toggleDigestedMemory() {
    const display = document.getElementById('digested-memory-display');
    const button = document.getElementById('show-digested-memory');
    
    if (display && button) {
        if (display.style.display === 'none') {
            showExistingDigestedMemory();
        } else {
            display.style.display = 'none';
            button.textContent = 'See Digested Project Detail Memory';
        }
    }
}

function showExistingDigestedMemory() {
    const display = document.getElementById('digested-memory-display');
    const button = document.getElementById('show-digested-memory');

    if (!display || !button) {
        return;
    }

    const textarea = document.getElementById('digested-memory-text');
    const digestedContent = settingsState.projectSettings.digestedProjectDetailContent || '';

    if (textarea) {
        textarea.value = digestedContent;
        textarea.removeAttribute('readonly');
        textarea.disabled = false;
    }

    const status = document.getElementById('digested-memory-status');
    if (status) {
        status.textContent = '';
    }

    display.style.display = 'block';
    button.textContent = 'Hide Digested Project Detail Memory';
}

async function generateDigestedMemory() {
    const display = document.getElementById('digested-memory-display');
    const button = document.getElementById('show-digested-memory');
    
    if (!display || !button) {
        return;
    }

    const rawText = (settingsState.projectSettings.rawProjectDetailContent || '').trim();
    if (!rawText) {
        display.textContent = 'No project detail text available. Please enter project details above.';
        display.style.display = 'block';
        button.textContent = 'Hide Digested Project Detail Memory';
        return;
    }

    const hideLoading = window.WebviewApi?.ui?.showLoading(button, 'Processing...');
    try {
        const mode = settingsState.projectSettings.digestedProjectDetailContent ? 'merge' : 'synthesis';
        const projectId = settingsState.projectSettings.projectId || 'default-project';
        const result = await window.WebviewApi.projectDetail.ingest({ projectId, rawText, mode });
        const finalText = result?.finalText || result || '';

        settingsState.projectSettings.digestedProjectDetailContent = finalText;
        const textarea = document.getElementById('digested-memory-text');
        if (textarea) {
            textarea.value = finalText;
        }
        display.style.display = 'block';
        button.textContent = 'Hide Digested Project Detail Memory';

        await window.WebviewApi.persistence.saveProjectSettings(settingsState.projectSettings);
    } catch (error) {
        console.error('Error generating digested project detail:', error);
        display.textContent = `Failed to generate digested project detail: ${error instanceof Error ? error.message : 'Unknown error'}`;
        display.style.display = 'block';
        button.textContent = 'Hide Digested Project Detail Memory';
    } finally {
        if (hideLoading) hideLoading();
    }
}

    // Function to refresh settings state when webview becomes visible
    function refreshSettingsState() {
        console.log('Settings: refreshSettingsState called - refreshing all settings state');
        
        // Reload settings from persistence
        void loadSettingsFromPersistence().then(() => {
            // Re-render settings if the settings tab is currently visible
            const settingsContent = document.getElementById('setting-content');
            if (settingsContent && settingsContent.style.display !== 'none') {
                console.log('Settings: Re-rendering settings after state refresh');
                renderSettings();
            }
        });
        
        console.log('Settings: Settings state refresh completed');
    }

    // Export functions for potential external use
    window.SettingsManager = {
        renderSettings: renderSettings,
        loadSettingsFromPersistence: loadSettingsFromPersistence,
        saveGlobalSettingsWithFeedback: saveGlobalSettingsWithFeedback,
        saveProjectSettingsWithFeedback: saveProjectSettingsWithFeedback,
        getSettings: () => settingsState,
        refreshSettingsState: refreshSettingsState,
        updateGlobalSettings: async (newSettings) => {
            settingsState.globalSettings = { ...settingsState.globalSettings, ...newSettings };
            await saveGlobalSettingsWithFeedback();
            renderSettings();
        },
        updateProjectSettings: async (newSettings) => {
            settingsState.projectSettings = { ...settingsState.projectSettings, ...newSettings };
            await saveProjectSettingsWithFeedback();
            renderSettings();
        }
    };
}
