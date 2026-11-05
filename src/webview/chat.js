// Samurai Agent Chat - JavaScript functionality
// This file handles chat interactions and LLM model selection
(function initChat(globalScope) {
    console.log('Chat: chat.js script loaded');

    // Chat state
    // Note: If vscode state persistence is needed, hydrate Sets from saved arrays:
    // const savedState = vscode.getState() || {};
    // displayedMessageIds: new Set(savedState.displayedMessageIds || [])
    const chatState = {
        globalSettings: null,
        projectSettings: null,
        availableModels: [],
        currentSessionId: null,
        currentSession: null,
        lastAssistantMessageContent: null,
        lastAssistantMessageTimestamp: 0,
        messagesLoaded: false, // Track if messages have been loaded
        lastRefreshTime: 0, // Track when we last refreshed to prevent rapid refreshes
        pinnedFilePaths: [], // Array of absolute file paths for pinned files
        logContent: '', // Track current log input content
        lastDebugCandidates: [], // For refocus feature: candidates from last debug visualization
        lastSelectedCandidateIds: [], // For refocus feature: IDs that were selected
        lastUserMessage: null, // For refocus feature: last user message sent
        currentNodeLocationMap: {}, // Stored node locations for visualization interactions
        currentNodeInfoMap: {}, // Stored node info for hover tooltips
        statusLog: null, // Status log instance for real-time debugging updates
        statusLogElement: null, // DOM element for status log container
        displayedMessageIds: new Set(), // Track displayed message IDs to prevent duplicates
        savedMessageIds: new Set(), // Track saved message IDs to prevent duplicate saves
        listenersInitialized: false, // Track if message listeners have been initialized
        documentationUrl: '', // Sticky documentation URL (persists across messages)
        documentationCache: { title: '', preview: '', fetchedAt: null }, // UI preview cache
        documentationLoading: false, // Loading state
        documentationError: null, // Error message
        pinnedFileWarningShown: false, // Track if pinned file warning has been shown in current session
        isBusy: false // True while agent is running (disables input and Run Analysis button)
    };

    // Queue for createCodeReviewSession messages that arrive before initialSettings
    let pendingCodeReviewSession = null;

    const MessageType = {
        USER: 'user',
        ASSISTANT: 'assistant',
        SYSTEM: 'system',
        ERROR: 'error'
    };

    // Feature flags for UI elements
    const ENABLE_CONCEPT_BUTTON = false;  // Always hide Generate Image button
    const ENABLE_FEEDBACK_FORM = false;   // Always hide Feedback Form

    // Chat input placeholder options for onboarding
    const CHAT_PLACEHOLDER_OPTIONS = [
        "The 'Add to Cart' button fires the click handler, but the cart count remains 0. Can you find the break in the logic flow?",
        "I suspect a race condition in processOrder.ts. The inventory updates correctly locally, but sometimes fails under concurrent load. Can you analyze the async flow?",
        "The main event loop is blocking for 500ms during the data parsing step. Can you profile this function and find the performance bottleneck?",
        "The framework detection logic seems to be misidentifying Next.js 14 projects as generic React apps. Can you inspect the regex pattern in the config parser?",
        "The generated graph is missing nodes when the code contains nested switch-cases. Can you trace why the parser skips these conditional blocks?"
    ];

    function getRandomPlaceholder() {
        const randomIndex = Math.floor(Math.random() * CHAT_PLACEHOLDER_OPTIONS.length);
        return CHAT_PLACEHOLDER_OPTIONS[randomIndex];
    }

    // Code visuals modal sizing
    const MODAL_HEIGHT_STORAGE_KEY = 'samuraiCodeVisualsModalHeight';
    const MODAL_MIN_HEIGHT = 240;
    const MODAL_DEFAULT_HEIGHT_RATIO = 0.25;
    const MODAL_WINDOW_PADDING = 40;
    const CHAT_MODAL_OVERLAP_BUFFER = 16;

    function getMaxAllowedModalHeight() {
        if (typeof window === 'undefined' || !Number.isFinite(window.innerHeight)) {
            return MODAL_MIN_HEIGHT;
        }
        return Math.max(MODAL_MIN_HEIGHT, window.innerHeight - MODAL_WINDOW_PADDING);
    }

    function clampModalHeight(value, fallback = MODAL_MIN_HEIGHT) {
        const candidate = Number.isFinite(value) ? value : fallback;
        const maxAllowed = getMaxAllowedModalHeight();
        const safeCandidate = Number.isFinite(candidate) ? candidate : MODAL_MIN_HEIGHT;
        return Math.max(MODAL_MIN_HEIGHT, Math.min(safeCandidate, maxAllowed));
    }

    function getDefaultModalHeight() {
        if (typeof window === 'undefined' || !Number.isFinite(window.innerHeight) || window.innerHeight <= 0) {
            return MODAL_MIN_HEIGHT;
        }
        const desired = Math.round(window.innerHeight * MODAL_DEFAULT_HEIGHT_RATIO);
        return clampModalHeight(desired, MODAL_MIN_HEIGHT);
    }

    let chatOverlapApplied = false;

    function getModalPanelElement(modal) {
        if (!modal || typeof modal.querySelector !== 'function') {
            return null;
        }
        return modal.querySelector('.code-visuals-modal');
    }

    function applyChatOverlapOffset(modal) {
        const chatMessages = safeGetDocumentElement('chatMessages');
        if (!chatMessages) {
            return;
        }
        const panel = getModalPanelElement(modal);
        if (!modal || modal.style.display === 'none' || !panel) {
            if (chatOverlapApplied) {
                chatMessages.style.removeProperty('--code-visuals-chat-offset');
                chatOverlapApplied = false;
            }
            return;
        }

        const modalRect = panel.getBoundingClientRect();
        const chatMessagesRect = chatMessages.getBoundingClientRect();

        // Calculate the necessary offset to push chatMessages content down
        // so that its visible top aligns just below the modal.
        // This should be modal's bottom (viewport-relative) minus chatMessages's top (viewport-relative).
        const requiredOffset = modalRect.bottom - chatMessagesRect.top;

        // Ensure offset is not negative and add the buffer
        const offset = Math.round(Math.max(0, requiredOffset) + CHAT_MODAL_OVERLAP_BUFFER);
        chatMessages.style.setProperty('--code-visuals-chat-offset', `${offset}px`);
        chatOverlapApplied = true;
    }

    function clearChatOverlapOffset() {
        const chatMessages = safeGetDocumentElement('chatMessages');
        if (!chatMessages) {
            return;
        }
        chatMessages.style.removeProperty('--code-visuals-chat-offset');
        chatOverlapApplied = false;
    }

    function loadStoredModalHeight() {
        if (typeof localStorage === 'undefined') {
            return null;
        }
        try {
            const stored = localStorage.getItem(MODAL_HEIGHT_STORAGE_KEY);
            if (!stored) {
                return null;
            }
            const parsed = parseInt(stored, 10);
            return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
        } catch (error) {
            console.warn('[Code Visuals Modal] Failed to load stored height:', error);
            return null;
        }
    }

    function storeModalHeight(height) {
        if (typeof localStorage === 'undefined') {
            return;
        }
        try {
            localStorage.setItem(MODAL_HEIGHT_STORAGE_KEY, String(Math.round(height)));
        } catch (error) {
            console.warn('[Code Visuals Modal] Failed to persist height:', error);
        }
    }

    function getModalCurrentHeight(modal) {
        if (!modal) {
            return MODAL_MIN_HEIGHT;
        }
        const panel = getModalPanelElement(modal);
        const elementForHeight = panel || modal;
        const computed = elementForHeight ? parseFloat(getComputedStyle(elementForHeight).height) : NaN;
        if (Number.isFinite(computed)) {
            return computed;
        }
        const cssHeight = modal ? parseFloat(modal.style.getPropertyValue('--code-visuals-modal-height')) : NaN;
        if (Number.isFinite(cssHeight)) {
            return cssHeight;
        }
        if (panel) {
            const panelHeight = panel.getBoundingClientRect().height;
            if (Number.isFinite(panelHeight)) {
                return panelHeight;
            }
        }
        const rectHeight = modal?.getBoundingClientRect().height;
        return Number.isFinite(rectHeight) ? rectHeight : MODAL_MIN_HEIGHT;
    }

    function initializeModalHeight(modal) {
        if (!modal) {
            return;
        }
        modal.style.removeProperty('height');
        modal.style.setProperty('--code-visuals-modal-min-height', `${MODAL_MIN_HEIGHT}px`);
        const storedHeight = loadStoredModalHeight();
        const defaultHeight = getDefaultModalHeight();
        const heightToApply = clampModalHeight(storedHeight, defaultHeight);
        modal.style.setProperty('--code-visuals-modal-height', `${Math.round(heightToApply)}px`);
        if (!Number.isFinite(storedHeight)) {
            storeModalHeight(heightToApply);
        }
        applyChatOverlapOffset(modal);
    }

    function applyModalHeight(modal, height) {
        if (!modal) {
            return;
        }
        modal.style.removeProperty('height');
        modal.style.setProperty('--code-visuals-modal-min-height', `${MODAL_MIN_HEIGHT}px`);
        const clamped = clampModalHeight(height, getDefaultModalHeight());
        modal.style.setProperty('--code-visuals-modal-height', `${Math.round(clamped)}px`);
        storeModalHeight(clamped);
        applyChatOverlapOffset(modal);
    }

    function escapeHtml(str) {
        if (!str || typeof str !== 'string') {
            return '';
        }
        return str
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#39;');
    }

    function renderInlineMarkdown(text) {
        if (!text) {
            return '';
        }

        let escaped = escapeHtml(text);

        // Links [text](url)
        escaped = escaped.replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, (_match, label, url) => {
            const safeLabel = escapeHtml(label);
            const safeUrl = escapeHtml(url);
            return `<a href="${safeUrl}" target="_blank" rel="noopener noreferrer">${safeLabel}</a>`;
        });

        // Bold **text**
        escaped = escaped.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');

        // Italic *text*
        escaped = escaped.replace(/(^|\s)\*([^*]+)\*(?=\s|$)/g, (_match, prefix, value) => {
            return `${prefix}<em>${value}</em>`;
        });

        // Inline code `code`
        escaped = escaped.replace(/`([^`]+)`/g, '<code>$1</code>');

        return escaped;
    }

    function renderMarkdown(text) {
        console.log('[renderMarkdown] Function called, text length:', text?.length || 0);
        if (!text) {
            return '';
        }

        // Updated regex to capture optional language identifier separately from code content
        // Pattern: ```[optional space][language]\n[code]``` or ```\n[code]```
        // Handles both \n and \r\n line endings, optional whitespace
        // Language can include common language identifiers (js, ts, javascript, typescript, etc.)
        // More flexible: allows optional space after ```, handles language on same line or next line
        const codeBlockRegex = /```\s*([a-zA-Z0-9_+-]*?)\r?\n([\s\S]*?)```/g;
        
        // Debug: Show actual text format around code blocks
        if (text.includes('```')) {
            const firstBacktickIndex = text.indexOf('```');
            const sample = text.substring(Math.max(0, firstBacktickIndex - 10), Math.min(text.length, firstBacktickIndex + 150));
            console.log('[renderMarkdown] Text sample around first ```:', JSON.stringify(sample));
        }
        let lastIndex = 0;
        const segments = [];
        
        // Find all matches at once to avoid regex state issues
        const matches = [];
        let match;
        // Create a fresh regex instance for each search to avoid state issues
        const freshRegex = new RegExp(codeBlockRegex.source, codeBlockRegex.flags);
        while ((match = freshRegex.exec(text)) !== null) {
            const language = match[1] || '';
            const code = match[2];
            // Debug: Log if language specifier appears in code (should never happen)
            if (code.includes(language) && language) {
                console.warn('[renderMarkdown] Warning: Language specifier found in code content:', language);
            }
            matches.push({
                index: match.index,
                fullMatch: match[0],
                language: language,
                code: code // Code content (without language)
            });
        }
        
        // Debug logging for code block detection
        if (matches.length > 0) {
            console.log(`[renderMarkdown] ✅ Found ${matches.length} code block(s)`, matches.map(m => ({ lang: m.language, codePreview: m.code.substring(0, 30) + '...' })));
        } else {
            // Debug: Log if we expected to find code blocks but didn't
            if (text.includes('```')) {
                console.warn('[renderMarkdown] ⚠️ Text contains ``` but regex found no matches!');
                const firstBacktickIndex = text.indexOf('```');
                const sample = text.substring(Math.max(0, firstBacktickIndex - 20), Math.min(text.length, firstBacktickIndex + 200));
                console.warn('[renderMarkdown] Text sample around first ```:', JSON.stringify(sample));
                
                // Test the regex directly with the same pattern
                const testRegex = /```\s*([a-zA-Z0-9_+-]*?)\r?\n([\s\S]*?)```/g;
                const testMatches = [];
                let testMatch;
                while ((testMatch = testRegex.exec(text)) !== null) {
                    testMatches.push({ lang: testMatch[1], index: testMatch.index, preview: testMatch[2].substring(0, 30) });
                }
                console.warn('[renderMarkdown] Direct regex test found:', testMatches.length, 'matches', testMatches);
                
                // Also try a more permissive pattern to see if that matches
                const permissiveRegex = /```[\s\S]*?```/g;
                const permissiveMatches = text.match(permissiveRegex);
                console.warn('[renderMarkdown] Permissive regex (any content between ```) found:', permissiveMatches?.length || 0, 'matches');
                if (permissiveMatches && permissiveMatches.length > 0) {
                    console.warn('[renderMarkdown] First permissive match preview:', JSON.stringify(permissiveMatches[0].substring(0, 200)));
                    
                    // Try to extract language from the permissive match
                    const firstMatch = permissiveMatches[0];
                    const langMatch = firstMatch.match(/^```\s*([a-zA-Z0-9_+-]+)/);
                    if (langMatch) {
                        console.warn('[renderMarkdown] Language found in permissive match:', langMatch[1]);
                    }
                }
                
                // Fallback: try to parse code blocks with a more flexible approach
                // This handles cases where there might be no newline after the language
                const flexibleRegex = /```([a-zA-Z0-9_+-]*)\s*([\s\S]*?)```/g;
                const flexibleMatches = [];
                let flexMatch;
                while ((flexMatch = flexibleRegex.exec(text)) !== null) {
                    const lang = flexMatch[1] || '';
                    const code = flexMatch[2].trim();
                    flexibleMatches.push({
                        index: flexMatch.index,
                        fullMatch: flexMatch[0],
                        language: lang,
                        code: code
                    });
                }
                if (flexibleMatches.length > 0) {
                    console.warn('[renderMarkdown] Flexible regex found:', flexibleMatches.length, 'matches');
                    matches.push(...flexibleMatches);
                }
            }
        }

        // Process each match
        for (const codeMatch of matches) {
            const before = text.slice(lastIndex, codeMatch.index);
            if (before) {
                segments.push(renderMarkdownBlocks(before));
            }
            // Extract language identifier and default to plaintext if empty
            const language = codeMatch.language ? codeMatch.language.toLowerCase() : 'plaintext';
            // Code content is now free from the language specifier
            const codeContent = escapeHtml(codeMatch.code.trim());
            // Wrap code block in a container for potential copy button
            const codeBlockId = 'code-block-' + Date.now() + '-' + Math.random().toString(36).slice(2, 2 + 9);
            // Add language class to <code> tag for syntax highlighting support
            segments.push(`<div class="code-block-container" data-code-id="${codeBlockId}"><pre><code class="language-${language}">${codeContent}</code></pre></div>`);
            lastIndex = codeMatch.index + codeMatch.fullMatch.length;
        }

        const remaining = text.slice(lastIndex);
        if (remaining) {
            segments.push(renderMarkdownBlocks(remaining));
        }

        // Wrap in .md-body for CSS namespacing
        return `<div class="md-body">${segments.join('')}</div>`;
    }

    function renderMarkdownBlocks(text) {
        const lines = text.split(/\r?\n/);
        const parts = [];
        let inList = false;
        let inTable = false;
        let tableRows = [];

        const closeList = () => {
            if (inList) {
                parts.push('</ul>');
                inList = false;
            }
        };

        const renderTable = (rows) => {
            if (rows.length === 0) return '';
            
            // Filter out empty delimiter rows and find header row
            const validRows = rows.filter(r => r.length > 0);
            if (validRows.length === 0) return '';
            
            let html = '<table role="table" class="table table-compact"><thead>';
            // First row is header
            html += '<tr>';
            validRows[0].forEach(cell => {
                html += `<th>${renderInlineMarkdown(cell.trim())}</th>`;
            });
            html += '</tr></thead><tbody>';
            
            // Process data rows (skip header row)
            for (let i = 1; i < validRows.length; i++) {
                html += '<tr>';
                validRows[i].forEach(cell => {
                    html += `<td>${renderInlineMarkdown(cell.trim())}</td>`;
                });
                html += '</tr>';
            }
            html += '</tbody></table>';
            return html;
        };

        const parseTableRow = (line) => {
            // Split by | (handle escaped pipes later if needed)
            // Remove leading/trailing | and split
            const trimmed = line.trim();
            if (!trimmed.startsWith('|') || !trimmed.endsWith('|')) {
                return [];
            }
            const cells = trimmed.slice(1, -1).split('|').map(c => c.trim());
            return cells;
        };

        const isTableDelimiter = (line) => {
            // Check if line is a table delimiter like |---|---| or |:---|:---:|---:|
            return /^\|[\s\-:]*\|/.test(line.trim());
        };

        for (let i = 0; i < lines.length; i++) {
            const line = lines[i];
            const trimmed = line.trim();

            // Check if this is a table row
            if (trimmed.includes('|') && trimmed.startsWith('|') && trimmed.endsWith('|')) {
                if (!inTable) {
                    // Starting a new table
                    closeList();
                    inTable = true;
                    tableRows = [];
                }
                
                if (isTableDelimiter(trimmed)) {
                    // This is a delimiter row, skip it (don't add to tableRows)
                    continue;
                } else {
                    const cells = parseTableRow(trimmed);
                    if (cells.length > 0) {
                        tableRows.push(cells);
                    }
                }
                continue;
            } else {
                // Not a table row
                if (inTable) {
                    // Close the table
                    parts.push(renderTable(tableRows));
                    inTable = false;
                    tableRows = [];
                }
            }

            if (trimmed.startsWith('- ')) {
                if (!inList) {
                    parts.push('<ul>');
                    inList = true;
                }
                const itemContent = renderInlineMarkdown(trimmed.slice(2).trim());
                parts.push(`<li>${itemContent}</li>`);
                continue;
            }

            closeList();

            if (trimmed.length === 0) {
                parts.push('<br>');
                continue;
            }

            // Check for headings (check longer patterns first to avoid false matches)
            if (trimmed.startsWith('###### ')) {
                parts.push(`<h6>${renderInlineMarkdown(trimmed.slice(7))}</h6>`);
                continue;
            }
            if (trimmed.startsWith('##### ')) {
                parts.push(`<h5>${renderInlineMarkdown(trimmed.slice(6))}</h5>`);
                continue;
            }
            if (trimmed.startsWith('#### ')) {
                parts.push(`<h4>${renderInlineMarkdown(trimmed.slice(5))}</h4>`);
                continue;
            }
            if (trimmed.startsWith('### ')) {
                parts.push(`<h3>${renderInlineMarkdown(trimmed.slice(4))}</h3>`);
                continue;
            }
            if (trimmed.startsWith('## ')) {
                parts.push(`<h2>${renderInlineMarkdown(trimmed.slice(3))}</h2>`);
                continue;
            }
            if (trimmed.startsWith('# ')) {
                parts.push(`<h1>${renderInlineMarkdown(trimmed.slice(2))}</h1>`);
                continue;
            }

            const paragraphContent = renderInlineMarkdown(line);
            parts.push(`<p>${paragraphContent}</p>`);
        }

        // Close any remaining table
        if (inTable && tableRows.length > 0) {
            parts.push(renderTable(tableRows));
        }

        closeList();
        return parts.join('');
    }

    /**
     * Enhance code blocks with copy buttons (idempotent)
     * @param {HTMLElement} scope - The scope to search for code blocks
     */
    function enhanceCodeBlocks(scope) {
        if (!scope) return;
        
        // Find all code block containers (they're wrapped in .code-block-container divs)
        scope.querySelectorAll('.code-block-container:not([data-enhanced])').forEach(container => {
            container.dataset.enhanced = '1';
            
            // Skip if copy button already exists
            if (container.querySelector('.code-block-copy-btn')) {
                return;
            }
            
            const codeElement = container.querySelector('code');
            if (!codeElement) return;
            
            // Apply syntax highlighting if highlight.js is available
            if (typeof window !== 'undefined' && window.hljs) {
                try {
                    window.hljs.highlightElement(codeElement);
                } catch (e) {
                    console.error('Failed to highlight code element:', e);
                }
            }
            
            // Ensure container has relative positioning (already set in CSS, but ensure it)
            const preElement = container.querySelector('pre');
            if (preElement) {
                preElement.style.position = 'relative';
            }
            
            const btn = document.createElement('button');
            btn.className = 'copy-btn code-block-copy-btn';
            btn.type = 'button';
            btn.textContent = '📋 Copy';
            btn.title = 'Copy to clipboard';
            
            btn.addEventListener('click', async () => {
                const codeText = codeElement.innerText || codeElement.textContent;
                try {
                    await navigator.clipboard.writeText(codeText);
                    const originalText = btn.textContent;
                    btn.textContent = '✓ Copied';
                    btn.style.opacity = '0.7';
                    
                    setTimeout(() => {
                        btn.textContent = originalText;
                        btn.style.opacity = '1';
                    }, 2000);
                } catch (err) {
                    console.error('Failed to copy code:', err);
                    // Show toast instead of alert
                    if (globalScope.showToast) {
                        globalScope.showToast('Failed to copy to clipboard', 'error');
                    } else {
                        alert('Failed to copy to clipboard');
                    }
                }
            });
            
            // Append to pre element if available, otherwise to container
            if (preElement) {
                preElement.appendChild(btn);
            } else {
                container.appendChild(btn);
            }
        });
    }

    /**
     * Enhance tables with proper attributes (idempotent)
     * @param {HTMLElement} scope - The scope to search for tables
     */
    function enhanceTables(scope) {
        if (!scope) return;
        
        scope.querySelectorAll('.md-body table:not([data-enhanced])').forEach(table => {
            table.dataset.enhanced = '1';
            table.setAttribute('role', 'table');
            table.classList.add('table', 'table-compact');
        });
    }

    /**
     * Enhance message element with all DOM upgrades (idempotent)
     * @param {HTMLElement} messageElement - The message element to enhance
     */
    function enhanceMessage(messageElement) {
        if (!messageElement) return;
        
        // Check if already enhanced
        if (messageElement.dataset.enhanced === '1') {
            return;
        }
        
        messageElement.dataset.enhanced = '1';
        
        // Enhance code blocks
        enhanceCodeBlocks(messageElement);
        
        // Enhance tables
        enhanceTables(messageElement);
    }

    function safeGetDocumentElement(id) {
        return typeof document !== 'undefined' ? document.getElementById(id) : null;
    }

    const RUN_ANALYSIS_BUTTON_LABEL_IDLE = 'Run Analysis';
    const RUN_ANALYSIS_BUTTON_LABEL_BUSY = 'Running...';

    function setBusyState(busy) {
        chatState.isBusy = busy;
        const chatInput = safeGetDocumentElement('chatInput');
        const runAnalysisBtn = safeGetDocumentElement('run-analysis-btn');
        if (chatInput) {
            chatInput.disabled = busy;
        }
        if (runAnalysisBtn) {
            runAnalysisBtn.disabled = busy;
            runAnalysisBtn.textContent = busy ? RUN_ANALYSIS_BUTTON_LABEL_BUSY : RUN_ANALYSIS_BUTTON_LABEL_IDLE;
        }
    }

    // Log input management functions
    function showContextPanel() {
        const contextPanel = safeGetDocumentElement('contextPanel');
        const logInput = safeGetDocumentElement('logInput');
        
        if (contextPanel) {
            contextPanel.style.display = 'flex';
            // Focus log input if it's empty, otherwise focus documentation URL input
            setTimeout(() => {
                if (logInput && !logInput.value) {
                    logInput.focus();
                } else {
                    const docUrlInput = safeGetDocumentElement('documentation-url-input');
                    if (docUrlInput) {
                        docUrlInput.focus();
                    }
                }
            }, 100);
        }
    }

    function hideContextPanel() {
        const contextPanel = safeGetDocumentElement('contextPanel');
        
        if (contextPanel) {
            contextPanel.style.display = 'none';
        }
    }

    // Keep these for backward compatibility and internal use
    function showLogInput() {
        // Show context panel instead
        showContextPanel();
    }

    function hideLogInput() {
        // Note: We don't auto-hide context panel when hiding log
        // User can manually close the context panel
    }

    function clearLogInput() {
        const logInput = safeGetDocumentElement('logInput');
        if (logInput) {
            logInput.value = '';
            chatState.logContent = '';
        }
    }

    function updateLogContent() {
        const logInput = safeGetDocumentElement('logInput');
        if (logInput) {
            chatState.logContent = logInput.value;
        }
    }

    // Pinned file warning helper functions
    function isPinnedFileWarningDismissed() {
        if (typeof localStorage === 'undefined') return false;
        try {
            return localStorage.getItem('samurai-pinned-file-warning-dismissed') === 'true';
        } catch {
            return false;
        }
    }

    function dismissPinnedFileWarning() {
        if (typeof localStorage === 'undefined') return;
        try {
            localStorage.setItem('samurai-pinned-file-warning-dismissed', 'true');
        } catch (error) {
            console.warn('[Chat] Failed to save pinned file warning dismissal:', error);
        }
    }

    // Review Fix modal preference
    const REVIEW_FIX_MODAL_DISMISSED_KEY = 'samurai-review-fix-modal-dismissed';

    function isReviewFixModalDismissed() {
        if (typeof localStorage === 'undefined') return false;
        try {
            return localStorage.getItem(REVIEW_FIX_MODAL_DISMISSED_KEY) === 'true';
        } catch {
            return false;
        }
    }

    function setReviewFixModalDismissed() {
        if (typeof localStorage === 'undefined') return;
        try {
            localStorage.setItem(REVIEW_FIX_MODAL_DISMISSED_KEY, 'true');
        } catch (error) {
            console.warn('[Chat] Failed to save review fix modal dismissal:', error);
        }
    }

    // Track monthly cost
    let monthlyTotalCost = 0;

    async function updateApiCostDisplay(newCost) {
        console.log('[COST DEBUG] updateApiCostDisplay called with cost:', {
            cost: newCost,
            costType: typeof newCost,
            currentMonthlyTotal: monthlyTotalCost,
            timestamp: new Date().toISOString()
        });
        
        // Query the extension for current monthly cost
        try {
            // Get monthly cost from extension's local storage (persistent across F5 resets)
            if (globalScope.WebviewApi?.postCommand) {
                try {
                    const monthlyStats = await globalScope.WebviewApi.postCommand('samurai-agent.getBackendMonthlyCost');
                    console.log('[COST DEBUG] Got monthly cost from extension:', monthlyStats);
                    
                    if (monthlyStats && typeof monthlyStats.total_cost === 'number') {
                        const previousCost = monthlyTotalCost;
                        monthlyTotalCost = monthlyStats.total_cost;
                        console.log('[COST DEBUG] Updated monthlyTotalCost from extension:', {
                            previous: previousCost,
                            current: monthlyTotalCost,
                            difference: monthlyTotalCost - previousCost,
                            extensionTotalCost: monthlyStats.total_cost,
                            extensionCallCount: monthlyStats.call_count
                        });
                    }
                    
                } catch (extensionError) {
                    console.warn('[COST DEBUG] Extension monthly cost not available, falling back to extension storage:', extensionError);
                }
            }
            
            // Fallback to VS Code extension storage if backend is not available
            if (monthlyTotalCost === 0 && globalScope.WebviewApi?.cost?.getStatistics) {
                const stats = await globalScope.WebviewApi.cost.getStatistics();
                console.log('[COST DEBUG] Got cost statistics from extension storage:', {
                    stats,
                    totalRecords: stats?.totalRecords,
                    totalCost: stats?.totalCost,
                    currentMonthCost: stats?.currentMonthCost,
                    currentSessionCost: stats?.currentSessionCost,
                    oldestRecord: stats?.oldestRecord,
                    newestRecord: stats?.newestRecord
                });
                
                if (stats && typeof stats.currentMonthCost === 'number') {
                    const previousCost = monthlyTotalCost;
                    monthlyTotalCost = stats.currentMonthCost;
                    console.log('[COST DEBUG] Updated monthlyTotalCost from extension storage:', {
                        previous: previousCost,
                        current: monthlyTotalCost,
                        difference: monthlyTotalCost - previousCost,
                        currentMonthCost: stats.currentMonthCost,
                        totalCost: stats.totalCost
                    });
                } else {
                    console.warn('[COST DEBUG] No valid currentMonthCost in extension stats:', stats);
                }
            }
        } catch (error) {
            console.error('[COST DEBUG] Failed to get cost statistics:', error);
        }
        
        const costDisplay = safeGetDocumentElement('api-cost-display');
        console.log('[COST DEBUG] Cost display element:', {
            found: !!costDisplay,
            monthlyTotalCost
        });
        
        if (costDisplay) {
            const formattedCost = monthlyTotalCost < 0.01 
                ? `$${monthlyTotalCost.toFixed(4)}` 
                : `$${monthlyTotalCost.toFixed(2)}`;
            
            // Check if we're in development mode (cost is 0 but we expect some cost)
            const isDevelopmentMode = monthlyTotalCost === 0 && newCost === 0;
            const displayText = isDevelopmentMode 
                ? `API Cost: ${formattedCost} this month`
                : `API Cost: ${formattedCost} this month`;
                
            costDisplay.textContent = displayText;
            console.log('[COST DEBUG] Updated cost display to:', costDisplay.textContent);
        } else {
            console.warn('[COST DEBUG] Cost display element not found!');
        }
    }

    /**
     * Creates a confirmation question block with interactive buttons
     * @param {Object} confirmationQuestion - The confirmation question object with originalQuestionText
     * @returns {HTMLElement} The confirmation block element
     */
    function createConfirmationQuestionBlock(confirmationQuestion) {
        const blockContainer = document.createElement('div');
        blockContainer.className = 'samurai-confirmation-block';
        
        // Create question paragraph
        const questionParagraph = document.createElement('p');
        questionParagraph.className = 'samurai-confirmation-question';
        
        // Store the original question text in a data attribute (for later retrieval)
        questionParagraph.setAttribute('data-question', confirmationQuestion.originalQuestionText);
        
        // Render the question text with markdown
        const renderedQuestionHtml = renderInlineMarkdown(confirmationQuestion.originalQuestionText);
        questionParagraph.innerHTML = renderedQuestionHtml;
        
        blockContainer.appendChild(questionParagraph);
        
        // Create buttons container
        const buttonsContainer = document.createElement('div');
        buttonsContainer.className = 'samurai-confirmation-buttons';
        
        // Create Yes button
        const yesButton = document.createElement('button');
        yesButton.className = 'samurai-button-yes';
        yesButton.textContent = 'Yes';
        yesButton.addEventListener('click', () => {
            handleConfirmationButtonClick(questionParagraph, 'YES');
        });
        
        // Create No button
        const noButton = document.createElement('button');
        noButton.className = 'samurai-button-no';
        noButton.textContent = 'No';
        noButton.addEventListener('click', () => {
            handleConfirmationButtonClick(questionParagraph, 'NO');
        });
        
        // Create AI Recommendation button
        const aiRecommendationButton = document.createElement('button');
        aiRecommendationButton.className = 'samurai-button-ai-recommendation';
        aiRecommendationButton.textContent = 'Ask for AI recommendation';
        aiRecommendationButton.addEventListener('click', () => {
            handleConfirmationButtonClick(questionParagraph, 'AI_RECOMMENDATION');
        });
        
        buttonsContainer.appendChild(yesButton);
        buttonsContainer.appendChild(noButton);
        buttonsContainer.appendChild(aiRecommendationButton);
        
        blockContainer.appendChild(buttonsContainer);
        
        // Create separator
        const separator = document.createElement('hr');
        separator.className = 'samurai-button-separator';
        blockContainer.appendChild(separator);
        
        return blockContainer;
    }
    
    /**
     * Handles confirmation button clicks and populates the chat input
     * @param {HTMLElement} questionElement - The question paragraph element
     * @param {string} buttonType - The type of button clicked (YES, NO, AI_RECOMMENDATION)
     */
    function handleConfirmationButtonClick(questionElement, buttonType) {
        const questionText = questionElement.getAttribute('data-question');
        if (!questionText) {
            console.warn('Chat: No question text found in data-question attribute');
            return;
        }
        
        let messageText = '';
        
        switch (buttonType) {
            case 'YES':
                messageText = `I would like to answer "YES" to ${questionText}`;
                break;
            case 'NO':
                messageText = `I would like to answer "NO" to ${questionText}`;
                break;
            case 'AI_RECOMMENDATION':
                messageText = `Please provide an AI recommendation for: ${questionText}`;
                break;
            default:
                console.warn('Chat: Unknown button type:', buttonType);
                return;
        }
        
        // Populate the chat input field with conditional logic for empty vs non-empty input
        const chatInput = safeGetDocumentElement('chatInput');
        if (chatInput) {
            const currentValue = chatInput.value;
            
            if (currentValue.trim() === '') {
                // If input field is empty, set the value directly without a leading space
                chatInput.value = messageText;
            } else {
                // If input field is not empty, append with a single space separator
                chatInput.value = `${currentValue} ${messageText}`;
            }
            
            chatInput.focus();
            console.log('Chat: Updated chat input with:', chatInput.value);
        } else {
            console.error('Chat: chatInput element not found');
        }
    }

    function shouldShowWelcomeMessage() {
        const chatMessages = safeGetDocumentElement('chatMessages');
        if (!chatMessages) {
            return false;
        }
        const messageElements = chatMessages.querySelectorAll('.chat-message');
        return messageElements.length === 0;
    }

    function showWelcomeMessage() {
        const chatMessages = safeGetDocumentElement('chatMessages');
        if (!chatMessages) {
            return;
        }

        // Check if welcome message already exists
        const existingWelcome = chatMessages.querySelector('#welcomeMessage');
        if (existingWelcome) {
            return;
        }

        // Only show if chat is empty
        if (!shouldShowWelcomeMessage()) {
            return;
        }

        const welcomeElement = document.createElement('div');
        welcomeElement.id = 'welcomeMessage';
        welcomeElement.className = 'welcome-message';
        welcomeElement.innerHTML = `
            <div class="welcome-message-content">
                <h2 class="welcome-title">👋 Welcome to Samurai Agent — stop regression bugs caused by AI fixes</h2>

                <p class="welcome-subtitle">1. Find the real root cause of bugs</p>
                <ol class="welcome-steps">
                    <li>(Optional) Type <strong>@</strong> and select relevant files above the chat box for better accuracy</li>
                    <li>Describe the bug you’re seeing</li>
                    <li>Click <strong>Run Analysis</strong> or press <strong>Enter</strong></li>
                </ol>

                <p class="welcome-description">Samurai will analyze your code and generate:</p>
                <ul class="welcome-features">
                    <li>the most likely root cause</li>
                    <li>a fix prompt you can use with your AI coding agent</li>
                </ul>

                <p class="welcome-time">⏱ Takes ~1–3 minutes</p>
                <p class="welcome-trial">Add a model and API key in Settings to get started.</p>

                <p class="welcome-subtitle">2. Review AI fixes to prevent regressions</p>
                <p class="welcome-time">
                    After applying an AI-generated fix, come back here and click <strong>“Review Fix”</strong> at the bottom of the chat response.
                    Samurai checks whether the root cause was actually addressed and whether any regression bugs were introduced.
                </p>
                </div>

        `;

        chatMessages.insertBefore(welcomeElement, chatMessages.firstChild);

        // Show regression detection promo banner if applicable
        showRegressionDetectionBanner(welcomeElement);
    }

    function showRegressionDetectionBanner(welcomeElement) {
        // Only show if feature is disabled and banner hasn't been dismissed
        const globalSettings = window._globalSettings || {};
        if (globalSettings.enableRegressionDetection || globalSettings.regressionBannerDismissed) {
            return;
        }

        const existingBanner = document.getElementById('regressionDetectionBanner');
        if (existingBanner) return;

        const bannerElement = document.createElement('div');
        bannerElement.id = 'regressionDetectionBanner';
        bannerElement.className = 'regression-detection-banner';
        bannerElement.innerHTML = `
            <div class="regression-banner-content">
                <div class="regression-banner-text">
                    <strong>One-Click Regression Code Review (Beta)</strong> —  
                    Shows a warning whenever AI edits your code and lets you start a focused regression review instantly.
                    <div class="regression-banner-subtext">
                    Experimental feature. You can turn this off anytime in the Settings page.
                    </div>
                    <a class="regression-banner-demo-link" id="regressionBannerDemo">▶ Watch 30s demo</a>
                </div>

                <div class="regression-banner-actions">
                    <button class="regression-banner-btn regression-banner-enable" id="regressionBannerEnable">
                    Enable
                    </button>
                    <button class="regression-banner-btn regression-banner-dismiss" id="regressionBannerDismiss">
                    Don’t show again
                    </button>
                </div>
            </div>

        `;

        welcomeElement.insertBefore(bannerElement, welcomeElement.firstChild);

        document.getElementById('regressionBannerEnable')?.addEventListener('click', () => {
            // Enable regression detection
            if (window._globalSettings) {
                window._globalSettings.enableRegressionDetection = true;
            }
            window.WebviewApi.persistence.saveGlobalSettings({ ...window._globalSettings, enableRegressionDetection: true });
            window.WebviewApi.postCommand('regressionDetectionToggled', { enabled: true });
            bannerElement.remove();
        });

        document.getElementById('regressionBannerDemo')?.addEventListener('click', (e) => {
            e.preventDefault();
            window.WebviewApi.postCommand('openExternalUrl', { url: 'https://youtu.be/pHPy8L_a-B4' });
        });

        document.getElementById('regressionBannerDismiss')?.addEventListener('click', () => {
            // Dismiss banner permanently
            if (window._globalSettings) {
                window._globalSettings.regressionBannerDismissed = true;
            }
            window.WebviewApi.persistence.saveGlobalSettings({ ...window._globalSettings, regressionBannerDismissed: true });
            bannerElement.remove();
        });
    }

    function hideWelcomeMessage() {
        const chatMessages = safeGetDocumentElement('chatMessages');
        if (!chatMessages) {
            return;
        }
        const welcomeElement = chatMessages.querySelector('#welcomeMessage');
        if (welcomeElement) {
            welcomeElement.remove();
        }
    }

    function showWorkspaceBanner() {
        const chatMessages = safeGetDocumentElement('chatMessages');
        if (!chatMessages) {
            return;
        }

        // Check if banner already exists
        const existingBanner = chatMessages.querySelector('#workspaceBanner');
        if (existingBanner) {
            return;
        }

        // Only show if welcome message is visible
        // If welcome message doesn't exist, create it first
        let welcomeElement = chatMessages.querySelector('#welcomeMessage');
        if (!welcomeElement) {
            showWelcomeMessage();
            welcomeElement = chatMessages.querySelector('#welcomeMessage');
            if (!welcomeElement) {
                // Still can't find it after creating, bail out
                return;
            }
        }

        const bannerElement = document.createElement('div');
        bannerElement.id = 'workspaceBanner';
        bannerElement.className = 'workspace-banner';
        bannerElement.innerHTML = `
            <div class="workspace-banner-content">
                <div class="workspace-banner-text">
                    <h3 class="workspace-banner-title">Open a folder to start</h3>
                    <p class="workspace-banner-body">Samurai Agent analyzes your project code, so it needs a workspace folder.</p>
                </div>
                <button class="workspace-banner-button" id="openFolderButton">Open Folder…</button>
            </div>
        `;

        // Insert banner at the top of the welcome message
        welcomeElement.insertBefore(bannerElement, welcomeElement.firstChild);

        // Add click handler for the button
        const openFolderButton = bannerElement.querySelector('#openFolderButton');
        if (openFolderButton && globalScope.WebviewApi?.postCommand) {
            openFolderButton.addEventListener('click', async () => {
                try {
                    await globalScope.WebviewApi.postCommand('workbench.action.files.openFolder');
                } catch (error) {
                    console.error('Chat: Failed to open folder:', error);
                }
            });
        }
    }

    function hideWorkspaceBanner() {
        const chatMessages = safeGetDocumentElement('chatMessages');
        if (!chatMessages) {
            return;
        }
        const bannerElement = chatMessages.querySelector('#workspaceBanner');
        if (bannerElement) {
            bannerElement.remove();
        }
    }

    function displayMessage(message) {
        console.log('Chat: displayMessage called with:', message);
        
        const chatMessages = safeGetDocumentElement('chatMessages');
        if (!chatMessages) {
            console.error('Chat: chatMessages element not found');
            return;
        }
        if (!message) {
            console.error('Chat: message is null or undefined');
            return;
        }

        // Hide welcome message when first message is displayed
        hideWelcomeMessage();

        // PRIMARY DEDUPLICATION: Check message ID first (most reliable)
        if (message.id && chatState.displayedMessageIds.has(message.id)) {
            // console.log('Chat: Skipping duplicate message (ID already displayed):', message.id);
            return;
        }

        const hasRichAssistantContent =
            !!message.specClarificationData ||
            (Array.isArray(message.interactiveQuestions) && message.interactiveQuestions.length > 0) ||
            (Array.isArray(message.interactiveConfirmationQuestions) && message.interactiveConfirmationQuestions.length > 0);

        // FALLBACK: Deduplicate consecutive identical assistant messages without special content
        // CRITICAL: Never skip messages with rich content (spec scores, interactive buttons, etc.)
        if (chatMessages.lastElementChild && !hasRichAssistantContent) {
            const lastElement = chatMessages.lastElementChild;
            if (
                message.role === 'assistant' &&
                lastElement.dataset?.role === 'assistant' &&
                lastElement.dataset?.content === (message.content || '')
            ) {
                // console.log('Chat: Skipping duplicate assistant message (content match)');
                return;
            }
        }

        // FALLBACK: Additional deduplication check for messages without rich content
        if (message.role === 'assistant' && !hasRichAssistantContent) {
            const now = Date.now();
            if (
                chatState.lastAssistantMessageContent === (message.content || '') &&
                now - chatState.lastAssistantMessageTimestamp < 1000
            ) {
                console.log('Chat: Skipping duplicate assistant message (within threshold)');
                return;
            }
        }

        if (message.role === 'assistant') {
            chatState.lastAssistantMessageContent = message.content || '';
            chatState.lastAssistantMessageTimestamp = Date.now();
        }

        console.log('Chat: Creating message element for:', message.content?.substring(0, 100) + '...');

        const messageElement = document.createElement('div');
        messageElement.className = 'chat-message';
        messageElement.dataset.role = message.role || '';
        messageElement.dataset.content = message.content || '';

        if (message.type === (MessageType.ASSISTANT || 'assistant') || message.role === 'assistant') {
            messageElement.classList.add('assistant-message');
        } else if (message.type === (MessageType.USER || 'user') || message.role === 'user') {
            messageElement.classList.add('user-message');
        } else {
            messageElement.classList.add('system-message');
        }

        // Check if this message needs a concept button (final response)
        const needsConceptButton = message.metadata?.debugSessionFinished || 
                                   message.metadata?.finalResponse || 
                                   (message.sessionId && chatState.currentSessionId === message.sessionId && message.role === 'assistant');
        // Only create button if message has a valid sessionId - don't fallback to global currentSessionId
        // This prevents buttons on second chart from using first chart's sessionId
        const sessionId = needsConceptButton && message.sessionId && message.sessionId !== 'unknown-session' ? message.sessionId : null;

        // Create concept wrapper at top if needed
        let conceptWrapper = null;
        if (ENABLE_CONCEPT_BUTTON && needsConceptButton && sessionId) {
            // Use message.id for unique container identification
            const messageId = message.id || `msg-${Date.now()}-${Math.random().toString(36).slice(2, 2 + 9)}`;
            conceptWrapper = createConceptButton(sessionId, messageId);
            messageElement.appendChild(conceptWrapper);
        }

        // Create text container for message content
        const textContainer = document.createElement('div');
        textContainer.className = 'message-content';

        // Process content to replace confirmation questions with unique markers
        let processedContent = message.content || '';
        const confirmationReplacements = [];
        
        if (message.interactiveConfirmationQuestions && Array.isArray(message.interactiveConfirmationQuestions)) {
            message.interactiveConfirmationQuestions.forEach((confirmationQuestion, index) => {
                const marker = `[[CONFIRMATION_BLOCK_${index}]]`;
                confirmationReplacements.push({ marker, question: confirmationQuestion });
                // Replace the question text with marker
                processedContent = processedContent.replace(
                    confirmationQuestion.originalQuestionText,
                    marker
                );
            });
        }
        
        // Debug: Log if content contains code blocks before rendering
        const hasCodeBlocks = processedContent.includes('```');
        if (hasCodeBlocks) {
            console.log('[displayMessage] Content contains code blocks, calling renderMarkdown...');
            const codeBlockCount = (processedContent.match(/```/g) || []).length / 2;
            console.log(`[displayMessage] Estimated ${codeBlockCount} code block(s) in content`);
            console.log('[displayMessage] renderMarkdown function type:', typeof renderMarkdown);
            console.log('[displayMessage] renderMarkdown function exists:', !!renderMarkdown);
        }
        
        let contentHtml;
        try {
            console.log('[displayMessage] About to call renderMarkdown with content length:', processedContent?.length || 0);
            contentHtml = renderMarkdown(processedContent);
            console.log('[displayMessage] renderMarkdown returned, result length:', contentHtml?.length || 0);
        } catch (error) {
            console.error('[displayMessage] Error calling renderMarkdown:', error);
            console.error('[displayMessage] Error stack:', error.stack);
            contentHtml = null;
        }
        if (contentHtml) {
            textContainer.innerHTML = contentHtml;
            // Debug: Check if code blocks were rendered
            const codeBlocks = textContainer.querySelectorAll('.code-block-container');
            if (codeBlocks.length > 0) {
                console.log(`[displayMessage] ✅ Rendered ${codeBlocks.length} code block(s) for message`);
                codeBlocks.forEach((block, idx) => {
                    const codeEl = block.querySelector('code');
                    if (codeEl) {
                        const lang = codeEl.className.match(/language-(\w+)/)?.[1] || 'none';
                        const codeText = codeEl.textContent?.substring(0, 50) || '';
                        console.log(`[displayMessage]   Code block ${idx + 1}: lang="${lang}", preview="${codeText}..."`);
                    }
                });
            } else if (hasCodeBlocks) {
                console.warn('[displayMessage] ⚠️ Content had code blocks but none were rendered!');
                console.warn('[displayMessage] Content sample:', processedContent.substring(0, 500));
            }
        } else {
            textContainer.textContent = processedContent;
        }
        
        // Append text container to message element
        messageElement.appendChild(textContainer);

        // Add analyzed files section if epilogue data is available
        if (message.metadata?.epilogue && Array.isArray(message.metadata.epilogue.files) && message.metadata.epilogue.files.length > 0) {
            const filesSectionHtml = renderAnalyzedFilesSection(message.metadata.epilogue);
            if (filesSectionHtml) {
                const filesSectionContainer = document.createElement('div');
                filesSectionContainer.className = 'analyzed-files-container';
                filesSectionContainer.innerHTML = filesSectionHtml;
                messageElement.appendChild(filesSectionContainer);
                
                // Add event listener for chevron rotation
                const details = filesSectionContainer.querySelector('.analyzed-files-details');
                const chevron = filesSectionContainer.querySelector('.analyzed-files-chevron');
                if (details && chevron) {
                    details.addEventListener('toggle', () => {
                        if (details.open) {
                            chevron.textContent = '▼';
                        } else {
                            chevron.textContent = '▶';
                        }
                    });
                }
            }
        }

        // Replace markers with interactive confirmation blocks
        if (confirmationReplacements.length > 0) {
            confirmationReplacements.forEach(({ marker, question }) => {
                const confirmationBlock = createConfirmationQuestionBlock(question);
                
                // Find all text nodes containing the marker (search in textContainer)
                const walker = document.createTreeWalker(
                    textContainer,
                    NodeFilter.SHOW_TEXT,
                    null
                );
                
                let nodesToReplace = [];
                let node;
                while (node = walker.nextNode()) {
                    if (node.textContent && node.textContent.includes(marker)) {
                        nodesToReplace.push(node);
                    }
                }
                
                // Replace each text node containing the marker
                nodesToReplace.forEach(textNode => {
                    const parent = textNode.parentNode;
                    if (parent) {
                        const parts = textNode.textContent.split(marker);
                        if (parts.length > 1) {
                            // Create text nodes for before and after
                            const beforeText = document.createTextNode(parts[0]);
                            const afterText = document.createTextNode(parts.slice(1).join(marker));
                            
                            // Insert in order: before, block, after
                            parent.insertBefore(beforeText, textNode);
                            parent.insertBefore(confirmationBlock, textNode);
                            if (parts.slice(1).join(marker)) {
                                parent.insertBefore(afterText, textNode);
                            }
                            parent.removeChild(textNode);
                        }
                    }
                });
            });
        }

        // New: Call renderAssistantResponse for assistant messages to add spec score and interactive buttons
        // This ensures these elements are added to messageElement when it's initially constructed,
        // covering both new messages and messages loaded from history.
        if (message.role === 'assistant' && 
            (message.specClarificationData || 
             (Array.isArray(message.interactiveQuestions) && message.interactiveQuestions.length > 0))) {
            renderAssistantResponse(messageElement, message);
        }

        if (message.role === 'assistant') {
            addMessageCopyButton(messageElement, message);
        }

        // Add feedback buttons for debugging messages
        if (ENABLE_FEEDBACK_FORM && message.role === 'assistant' && isDebuggingMessage(message)) {
            renderFeedbackButtons(messageElement, message);
        }

        // Store visualization data from metadata if it exists (for messages loaded from history)
        if (message.role === 'assistant' && message.metadata?.visualization) {
            messageElement.dataset.hasVisualization = 'true';
            messageElement.dataset.visualization = message.metadata.visualization || '';
            messageElement.dataset.visualizationMeta = JSON.stringify(message.metadata.visualizationMeta || {});
            messageElement.dataset.visualizationDiagnostics = JSON.stringify(message.metadata.visualizationDiagnostics || []);
            const nodeInfoMapFromMetadata = message.metadata.nodeInfoMap || message.metadata.nodeMetadataMap || {};
            messageElement.dataset.nodeLocationMap = JSON.stringify(message.metadata.nodeLocationMap || {});
            messageElement.dataset.nodeInfoMap = JSON.stringify(nodeInfoMapFromMetadata);
            messageElement.dataset.pipelineSteps = JSON.stringify(message.metadata.pipelineSteps || []);
            messageElement.dataset.graphCandidates = JSON.stringify(message.metadata.graphCandidates || []);
            messageElement.dataset.selectedCandidateIds = JSON.stringify(message.metadata.selectedCandidateIds || []);
            messageElement.dataset.debugMetaVersion = String(message.metadata.debugMetaVersion || 0);
            messageElement.dataset.llmDebugInfo = JSON.stringify(message.metadata.llmDebugInfo || []);
            if (message.metadata.llmDebugInfoVersion !== undefined) {
                messageElement.dataset.llmDebugInfoVersion = String(message.metadata.llmDebugInfoVersion);
            }
        }

        // Enhance message with idempotent DOM upgrades (code blocks, tables, etc.)
        enhanceMessage(messageElement);

        // Store message ID
        const messageId = message.id || `msg-${Date.now()}-${Math.random().toString(36).slice(2, 2 + 9)}`;
        messageElement.dataset.messageId = messageId;

        // Ensure links open safely
        messageElement.querySelectorAll('a').forEach((link) => {
            link.setAttribute('target', '_blank');
            link.setAttribute('rel', 'noopener noreferrer');
        });
        
        chatMessages.appendChild(messageElement);

        // Track displayed message ID to prevent duplicates
        if (message.id) {
            chatState.displayedMessageIds.add(message.id);
        }

        console.log('Chat: Message element appended to chatMessages');
        messageElement.scrollIntoView({ block: 'start', behavior: 'smooth' });

        // Mark that we have messages loaded
        chatState.messagesLoaded = true;

        return messageElement;
    }

    // Store interval ID for animated loading dots
    let loadingDotsIntervalId = null;

    /**
     * Animates loading dots (., .., ...) for a status message
     * @param {string} baseText - The base text without dots (e.g., "Analyzing")
     * @param {HTMLElement} element - The element to update
     * @returns {number} - The interval ID for cleanup
     */
    function animateLoadingDots(baseText, element) {
        // Clear any existing interval
        if (loadingDotsIntervalId !== null) {
            clearInterval(loadingDotsIntervalId);
            loadingDotsIntervalId = null;
        }

        let dotCount = 0;
        const maxDots = 3;
        
        // Update immediately
        element.textContent = baseText + '.'.repeat(dotCount + 1);
        
        // Set up interval to cycle through dots
        loadingDotsIntervalId = setInterval(() => {
            dotCount = (dotCount + 1) % maxDots;
            element.textContent = baseText + '.'.repeat(dotCount + 1);
        }, 500);

        return loadingDotsIntervalId;
    }

    function showProgressIndicator(update) {
        const chatContainer = safeGetDocumentElement('chatMessages');
        if (!chatContainer) {
            console.warn('Chat: chatMessages element not found for progress indicator');
            return;
        }

        let banner = document.getElementById('agent-progress-banner');
        if (!banner) {
            banner = document.createElement('div');
            banner.id = 'agent-progress-banner';
            banner.className = 'agent-progress-banner';
        }
        
        // ALWAYS reposition banner (moved outside the if block)
        // First, remove from current parent if already in DOM
        if (banner.parentNode) {
            banner.parentNode.removeChild(banner);
        }
        
        // Find the insertion point: after last user message
        let insertionPoint = null;
        const messages = chatContainer.querySelectorAll('.chat-message');
        for (let i = messages.length - 1; i >= 0; i--) {
            if (messages[i].classList.contains('user-message')) {
                insertionPoint = messages[i];
                break;
            }
        }
        
        try {
            if (insertionPoint) {
                // Insert the banner right after the insertion point
                insertionPoint.parentNode.insertBefore(banner, insertionPoint.nextSibling);
            } else {
                // Fallback: append to the end if no insertion point found
                chatContainer.appendChild(banner);
            }
        } catch (error) {
            console.error('Chat: Error inserting progress banner:', error);
            return;
        }

        const { stage, data } = update || {};
        let message = 'Working...';
        let shouldAnimateDots = false;
        
        // Check if this is a debugging status message (from handleDebugging)
        if (stage && typeof stage === 'string') {
            // Use the stage directly as the message
            message = stage;
            // Animate dots for messages that end with "..." (but not completion messages)
            shouldAnimateDots = message.endsWith('...') && !message.includes('Completed');
        } else if (stage === 'analyzing') {
            message = 'Analyzing conversation...';
            shouldAnimateDots = true;
        } else if (stage === 'extracting-code') {
            message = 'Finding relevant code context...';
            shouldAnimateDots = true;
        } else if (stage === 'extraction-complete') {
            const files = (data?.files || []).map((file) => file.path).slice(0, 3);
            message = files.length
                ? `Code context ready: ${files.join(', ')}`
                : 'Code context ready.';
        } else if (stage === 'extraction-failed') {
            message = 'Code extraction failed; continuing without new context.';
        } else if (stage === 'rendering-response') {
            message = 'Generating response...';
            shouldAnimateDots = true;
        }

        // Clear any existing animation
        if (loadingDotsIntervalId !== null) {
            clearInterval(loadingDotsIntervalId);
            loadingDotsIntervalId = null;
        }

        banner.textContent = message;
        banner.style.display = 'block';
        
        // Start animated dots if needed
        if (shouldAnimateDots) {
            // Remove trailing dots for animation
            const baseText = message.replace(/\.+$/, '');
            animateLoadingDots(baseText, banner);
        }
        
        // Scroll to bottom to show the progress message
        chatContainer.scrollTop = chatContainer.scrollHeight;

        if (stage === 'rendering-response' || stage === 'extraction-complete' || stage === 'extraction-failed') {
            setTimeout(() => {
                // Clear animation interval
                if (loadingDotsIntervalId !== null) {
                    clearInterval(loadingDotsIntervalId);
                    loadingDotsIntervalId = null;
                }
                // Properly remove from DOM instead of just hiding
                if (banner && banner.parentNode) {
                    banner.parentNode.removeChild(banner);
                }
            }, 3000);
        }
    }

    async function initializeChatSession() {
        if (!globalScope?.WebviewApi || !chatState.projectSettings) {
            return;
        }

        // Skip if a code-review session was just created — don't overwrite it
        if (chatState._codeReviewJustCreated) {
            chatState._codeReviewJustCreated = false;
            return;
        }

        const { projectSettings } = chatState;
        let sessionId = projectSettings.currentSessionId;

        try {
            if (sessionId) {
                if (!globalScope?.WebviewApi?.persistence?.loadSession) {
                    console.warn('[Chat] WebviewApi.persistence.loadSession not available');
                    sessionId = await createAndPersistSession();
                } else {
                    const session = await globalScope.WebviewApi.persistence.loadSession(sessionId);
                    if (!session) {
                        sessionId = await createAndPersistSession();
                    } else {
                        chatState.currentSession = session;
                    }
                }
            } else {
                sessionId = await createAndPersistSession();
            }

            chatState.currentSessionId = sessionId;

            if (sessionId) {
                await loadAndDisplayMessages(sessionId);
                // Update session title in header
                updateSessionTitle(chatState.currentSession?.title);
                // Update button state after loading session
                updateShowCodeVisualsButton();
            }
        } catch (error) {
            console.error('Chat: Failed to initialize session', error);
        }
    }

    async function loadAndDisplayMessages(sessionId, retryCount = 0) {
        try {
            console.log(`Chat: Loading messages for session ${sessionId} (attempt ${retryCount + 1})`);
            if (!globalScope?.WebviewApi?.persistence?.loadChatMessagesForSession) {
                console.warn('[Chat] WebviewApi.persistence.loadChatMessagesForSession not available');
                return;
            }
            const messages = await globalScope.WebviewApi.persistence.loadChatMessagesForSession(sessionId);
            
            if (Array.isArray(messages)) {
                console.log(`Chat: Loaded ${messages.length} messages from database`);
                
                // Clear existing messages and tracking Sets before loading new ones
                const chatMessages = safeGetDocumentElement('chatMessages');
                if (chatMessages) {
                    chatMessages.innerHTML = '';
                }
                
                // Clear tracking Sets to start fresh
                chatState.displayedMessageIds.clear();
                chatState.savedMessageIds.clear();
                // Reset duplicate detection state
                chatState.lastAssistantMessageContent = null;
                chatState.lastAssistantMessageTimestamp = 0;
                
                // Populate savedMessageIds with all loaded message IDs to prevent re-saving history
                messages.forEach(msg => {
                    if (msg.id) {
                        chatState.savedMessageIds.add(msg.id);
                    }
                });
                
                // Display all messages
                messages.forEach(displayMessage);
                
                if (chatMessages) {
                    chatMessages.scrollTop = chatMessages.scrollHeight;
                }
                
                // If we have messages, we're done
                if (messages.length > 0) {
                    console.log('Chat: Messages loaded successfully');
                    chatState.messagesLoaded = true;
                    return;
                } else {
                    // No messages loaded - show welcome message
                    showWelcomeMessage();
                }
            }
            
            // If no messages found and this is the first attempt, retry after a short delay
            // This handles cases where the database write hasn't been flushed yet
            if (retryCount === 0) {
                console.log('Chat: No messages found on first attempt, retrying after delay...');
                setTimeout(() => {
                    void loadAndDisplayMessages(sessionId, 1);
                }, 1000); // Wait 1 second before retry
            } else {
                console.log('Chat: No messages found after retry, session may be empty');
                // Show welcome message when no messages are found
                showWelcomeMessage();
            }
        } catch (error) {
            console.error('Chat: Failed to load messages:', error);
            
            // Retry once on error
            if (retryCount === 0) {
                console.log('Chat: Error loading messages, retrying after delay...');
                setTimeout(() => {
                    void loadAndDisplayMessages(sessionId, 1);
                }, 1000);
            }
        }
    }

    async function createAndPersistSession(title = 'New Conversation') {
        if (!globalScope?.WebviewApi || !chatState.projectSettings) {
            return null;
        }

        const modeSelect = safeGetDocumentElement('mode-select');
        const currentMode = modeSelect?.value || chatState.projectSettings.defaultMode || 'debugging';

        const request = {
            title,
            projectId: chatState.projectSettings.projectId,
            model: chatState.projectSettings.primaryLLMModel || undefined,
            mode: currentMode
        };

        if (!globalScope?.WebviewApi?.persistence?.createSession) {
            console.warn('[Chat] WebviewApi.persistence.createSession not available');
            return null;
        }
        const session = await globalScope.WebviewApi.persistence.createSession(request);
        if (session?.id) {
            chatState.projectSettings = {
                ...chatState.projectSettings,
                currentSessionId: session.id
            };
            chatState.currentSessionId = session.id;
            chatState.currentSession = session;
            updateSessionTitle(session.title);
            if (!globalScope?.WebviewApi?.persistence?.saveProjectSettings) {
                console.warn('[Chat] WebviewApi.persistence.saveProjectSettings not available');
            } else {
                await globalScope.WebviewApi.persistence.saveProjectSettings(chatState.projectSettings);
            }
            return session.id;
        }

        return null;
    }

    // ============ Session Switching ============

    function updateSessionTitle(title) {
        const titleEl = safeGetDocumentElement('session-title-text');
        if (titleEl) {
            titleEl.textContent = title || 'New Conversation';
        }
    }

    async function switchToSession(sessionId) {
        if (!sessionId || !globalScope?.WebviewApi) {
            return;
        }
        if (sessionId === chatState.currentSessionId) {
            closeSessionDropdown();
            return;
        }
        if (chatState.isBusy) {
            const confirmed = confirm('The agent is currently running. Switching sessions will not stop it. Continue?');
            if (!confirmed) {
                return;
            }
        }

        console.log('Chat: Switching to session', sessionId);
        closeSessionDropdown();

        // Load target session
        const session = await globalScope.WebviewApi.persistence.loadSession(sessionId);
        if (!session) {
            console.warn('Chat: Session not found', sessionId);
            return;
        }

        // Clear UI
        const chatMessages = safeGetDocumentElement('chatMessages');
        if (chatMessages) {
            chatMessages.innerHTML = '';
        }
        chatState.displayedMessageIds.clear();
        chatState.savedMessageIds.clear();
        chatState.messagesLoaded = false;
        chatState.lastAssistantMessageContent = null;
        chatState.lastAssistantMessageTimestamp = 0;

        // Update state
        chatState.currentSessionId = session.id;
        chatState.currentSession = session;
        chatState.pinnedFilePaths = session.pinnedFilePaths || [];
        renderPinnedFiles();

        // Update project settings
        chatState.projectSettings = {
            ...chatState.projectSettings,
            currentSessionId: session.id
        };
        if (globalScope?.WebviewApi?.persistence?.saveProjectSettings) {
            await globalScope.WebviewApi.persistence.saveProjectSettings(chatState.projectSettings);
        }

        // Update header
        updateSessionTitle(session.title);

        // Load messages
        await loadAndDisplayMessages(session.id);

        // Show welcome if no messages
        if (chatState.displayedMessageIds.size === 0) {
            showWelcomeMessage();
        }

        // Focus input
        const chatInput = safeGetDocumentElement('chatInput');
        if (chatInput) {
            chatInput.value = '';
            chatInput.focus();
        }
    }

    function toggleSessionDropdown() {
        const dropdown = safeGetDocumentElement('session-dropdown');
        if (!dropdown) { return; }
        const isOpen = dropdown.style.display !== 'none';
        if (isOpen) {
            closeSessionDropdown();
        } else {
            openSessionDropdown();
        }
    }

    function closeSessionDropdown() {
        const dropdown = safeGetDocumentElement('session-dropdown');
        if (dropdown) {
            dropdown.style.display = 'none';
        }
    }

    async function openSessionDropdown() {
        const dropdown = safeGetDocumentElement('session-dropdown');
        if (!dropdown) { return; }
        dropdown.style.display = 'block';
        await renderSessionList();
    }

    async function renderSessionList() {
        const listEl = safeGetDocumentElement('session-dropdown-list');
        if (!listEl || !globalScope?.WebviewApi?.persistence?.loadAllSessions) {
            return;
        }

        listEl.innerHTML = '<div style="padding: 8px 12px; opacity: 0.6;">Loading...</div>';

        try {
            const sessions = await globalScope.WebviewApi.persistence.loadAllSessions();
            if (!Array.isArray(sessions) || sessions.length === 0) {
                listEl.innerHTML = '<div style="padding: 8px 12px; opacity: 0.6;">No sessions</div>';
                return;
            }

            // Sort by lastMessageAt desc
            sessions.sort((a, b) => {
                const aTime = a.lastMessageAt ? new Date(a.lastMessageAt).getTime() : 0;
                const bTime = b.lastMessageAt ? new Date(b.lastMessageAt).getTime() : 0;
                return bTime - aTime;
            });

            listEl.innerHTML = '';
            for (const session of sessions) {
                const item = document.createElement('div');
                item.className = 'session-dropdown-item' + (session.id === chatState.currentSessionId ? ' active' : '');

                const titleRow = document.createElement('div');
                titleRow.className = 'session-dropdown-item-title';
                titleRow.textContent = session.title || 'Untitled';

                if (session.type === 'code-review') {
                    const badge = document.createElement('span');
                    badge.className = 'session-dropdown-item-badge';
                    badge.textContent = 'review';
                    titleRow.appendChild(badge);
                }

                const meta = document.createElement('div');
                meta.className = 'session-dropdown-item-meta';
                const date = session.lastMessageAt ? new Date(session.lastMessageAt) : new Date(session.createdAt);
                meta.textContent = date.toLocaleString();

                item.appendChild(titleRow);
                item.appendChild(meta);
                item.addEventListener('click', () => switchToSession(session.id));
                listEl.appendChild(item);
            }
        } catch (error) {
            console.error('Chat: Failed to load sessions for dropdown', error);
            listEl.innerHTML = '<div style="padding: 8px 12px; color: var(--vscode-errorForeground);">Failed to load sessions</div>';
        }
    }

    async function createCodeReviewSession(content, pinnedFiles) {
        if (!globalScope?.WebviewApi || !chatState.projectSettings) {
            // Queue for replay after initialSettings arrives
            pendingCodeReviewSession = { content, pinnedFiles };
            console.log('Chat: Queued createCodeReviewSession (settings not ready)');
            return;
        }
        pendingCodeReviewSession = null;

        const timestamp = new Date().toLocaleString();
        const title = `Code Review - ${timestamp}`;
        const sessionId = await createAndPersistSession(title);
        if (!sessionId) {
            return;
        }

        // Set session type to code-review
        if (globalScope?.WebviewApi?.persistence?.updateSession) {
            await globalScope.WebviewApi.persistence.updateSession(sessionId, { type: 'code-review' });
        }

        // Update header title
        updateSessionTitle(title);

        // Clear UI for new session
        const chatMessages = safeGetDocumentElement('chatMessages');
        if (chatMessages) {
            chatMessages.innerHTML = '';
        }
        chatState.displayedMessageIds.clear();
        chatState.savedMessageIds.clear();
        chatState.messagesLoaded = false;
        showWelcomeMessage();

        // Pin files
        chatState.pinnedFilePaths = [];
        if (Array.isArray(pinnedFiles)) {
            for (const fp of pinnedFiles) {
                addPinnedFile(fp);
            }
        }

        // Prefill input
        const chatInput = safeGetDocumentElement('chatInput');
        if (chatInput && content) {
            chatInput.value = content;
            chatInput.style.height = 'auto';
            chatInput.style.height = Math.min(chatInput.scrollHeight, 300) + 'px';
        }

        // Guard: prevent initializeChatSession from overwriting this session
        chatState._codeReviewJustCreated = true;
    }

    // ============ End Session Switching ============

    async function sendMessage(messageText) {
        if (!messageText || !globalScope?.WebviewApi || !chatState.projectSettings) {
            return;
        }
        if (chatState.isBusy) {
            return;
        }

        // DISABLED: Pinned file warning check (too disturbing - can be re-enabled in future)
        /*
        // Check for pinned files warning (block sending on first attempt)
        if (chatState.pinnedFilePaths.length === 0) {
            // Check if warning is permanently dismissed
            if (!isPinnedFileWarningDismissed() && !chatState.pinnedFileWarningShown) {
                // Show warning and block message sending
                showPinnedFileWarning();
                chatState.pinnedFileWarningShown = true;
                return; // STOP execution - do NOT send the message (input stays filled)
            } else {
                // Warning already shown or dismissed - allow sending
                hidePinnedFileWarning();
            }
        } else {
            // Has pinned files - hide warning if visible
            hidePinnedFileWarning();
        }
        */

        // Clear chat input now that we've passed the blocking check
        const chatInput = safeGetDocumentElement('chatInput');
        if (chatInput) {
            chatInput.value = '';
        }

        // Clear status log for new debugging session
        if (chatState.statusLog) {
            chatState.statusLog.clear();
            // Remove status log element from DOM if it exists
            if (chatState.statusLogElement && chatState.statusLogElement.parentNode) {
                chatState.statusLogElement.parentNode.removeChild(chatState.statusLogElement);
            }
            chatState.statusLog = null;
            chatState.statusLogElement = null;
        }

        setBusyState(true);

        try {
            if (!chatState.currentSessionId) {
                await initializeChatSession();
            }

            const sessionId = chatState.currentSessionId;
            if (!sessionId) {
                throw new Error('Chat session is not initialized');
            }

            let currentSession = chatState.currentSession;
            if (!currentSession) {
                if (!globalScope?.WebviewApi?.persistence?.loadSession) {
                    console.warn('[Chat] WebviewApi.persistence.loadSession not available');
                    throw new Error('WebviewApi.persistence.loadSession is not available');
                }
                currentSession = await globalScope.WebviewApi.persistence.loadSession(sessionId);
                chatState.currentSession = currentSession;
            }

            // Update session mode from dropdown before sending message
            const modeSelect = safeGetDocumentElement('mode-select');
            // Force mode to 'debugging' for beta release
            const currentMode = 'debugging';
            
            // Ensure metadata exists
            if (!currentSession.metadata) {
                currentSession.metadata = {};
            }
            
            // Update session metadata if mode has changed or is not set
            if (currentSession.metadata.mode !== currentMode) {
                console.log(`Chat: Updating session mode from ${currentSession.metadata.mode || 'not set'} to ${currentMode}`);
                currentSession.metadata = {
                    ...currentSession.metadata,
                    mode: currentMode
                };
                
                // Persist the mode update to the session
                try {
                    if (!globalScope?.WebviewApi?.persistence?.updateSession) {
                        console.warn('[Chat] WebviewApi.persistence.updateSession not available');
                    } else {
                        await globalScope.WebviewApi.persistence.updateSession(sessionId, {
                            metadata: currentSession.metadata
                        });
                    }
                    chatState.currentSession = currentSession;
                    
                    // Update Show Current Spec button visibility based on mode
                    updateShowCodeVisualsButton();
                } catch (error) {
                    console.error('Chat: Failed to update session mode:', error);
                }
            }

            const chatMessages = safeGetDocumentElement('chatMessages');
            
            const userMessage = {
                id: `user-${Date.now()}`,
                sessionId,
                projectId: chatState.projectSettings.projectId,
                type: globalScope?.MessageType?.USER || 'user',
                role: 'user',
                content: messageText,
                metadata: {
                    ...(chatState.logContent ? { log: chatState.logContent } : {}),
                    ...(chatState.documentationUrl ? { documentationUrl: chatState.documentationUrl } : {})
                }
            };

            // Store last user message for refocus feature
            chatState.lastUserMessage = userMessage;

            displayMessage(userMessage);

            if (chatState.currentSessionId && chatState.projectSettings?.projectId) {
                // Check if message was already saved to prevent duplicate saves
                if (userMessage.id && chatState.savedMessageIds.has(userMessage.id)) {
                    console.log('[Chat] User message already saved, skipping duplicate save:', userMessage.id);
                } else {
                    if (!globalScope?.WebviewApi?.persistence?.saveChatMessage) {
                        console.warn('[Chat] WebviewApi.persistence.saveChatMessage not available');
                    } else {
                        // 1. LOCK: Add Temp ID immediately (optimistic lock)
                        if (userMessage.id) {
                            chatState.savedMessageIds.add(userMessage.id);
                        }
                        
                        // 2. ACTION: Save
                        const saveResponse = await globalScope.WebviewApi.persistence.saveChatMessage({
                            sessionId: chatState.currentSessionId,
                            projectId: chatState.projectSettings.projectId,
                            type: userMessage.type,
                            content: userMessage.content,
                            role: userMessage.role,
                            metadata: userMessage.metadata
                        });
                        
                        // 3. UPDATE: Add Real ID (Keep Temp ID as Tombstone)
                        const savedMessageId = saveResponse?.payload?.id;
                        if (savedMessageId && savedMessageId !== userMessage.id) {
                            chatState.savedMessageIds.add(savedMessageId);
                        }
                    }
                }
            }

            // Auto-title session from first user message
            if (chatState.currentSession && chatState.currentSession.title === 'New Conversation') {
                const truncated = messageText.replace(/\n/g, ' ').slice(0, 50) + (messageText.length > 50 ? '…' : '');
                try {
                    if (globalScope?.WebviewApi?.persistence?.updateSession) {
                        await globalScope.WebviewApi.persistence.updateSession(sessionId, { title: truncated });
                    }
                    chatState.currentSession.title = truncated;
                    updateSessionTitle(truncated);
                } catch (e) {
                    console.warn('Chat: Failed to auto-title session', e);
                }
            }

            const chatMessagesElement = safeGetDocumentElement('chatMessages');
            if (chatMessagesElement) {
                chatMessagesElement.scrollTop = chatMessagesElement.scrollHeight;
            }

            // Use agent.execute for consistent execution path
            if (globalScope.WebviewApi?.agent?.execute) {
                try {
                    // The agent.execute will handle everything and broadcast the response
                    // The message listener will automatically display it
                    await globalScope.WebviewApi.agent.execute({
                        userMessage: userMessage,
                        session: currentSession,
                        message: messageText,
                        pinnedFilePaths: chatState.pinnedFilePaths,
                        documentationUrl: chatState.documentationUrl || undefined
                    });
                } catch (error) {
                    console.error('Chat: Failed to execute agent command', error);
                    setBusyState(false);
                    // Display error message
                    displayMessage({
                        id: `error-${Date.now()}`,
                        sessionId: chatState.currentSessionId,
                        projectId: chatState.projectSettings.projectId,
                        type: globalScope?.MessageType?.ERROR || 'error',
                        role: 'assistant',
                        content: `Error: ${error instanceof Error ? error.message : 'Unknown error'}`,
                        metadata: { error }
                    });
                }
                return;
            }
            
            // Fallback error if agent not available
            setBusyState(false);
            displayMessage({
                id: `error-${Date.now()}`,
                sessionId: chatState.currentSessionId,
                projectId: chatState.projectSettings.projectId,
                type: globalScope?.MessageType?.ERROR || 'error',
                role: 'assistant',
                content: 'Agent not available. Please reload the extension.',
                metadata: {}
            });
        } catch (error) {
            console.error('Chat: Failed to send message', error);
            setBusyState(false);
            displayMessage({
                id: `error-${Date.now()}`,
                sessionId: chatState.currentSessionId,
                projectId: chatState.projectSettings.projectId,
                type: globalScope?.MessageType?.ERROR || 'error',
                role: 'assistant',
                content: `Error sending message: ${error instanceof Error ? error.message : 'Unknown error'}`,
                metadata: { error }
            });
        }
    }

    function handleAgentExecuteResponse(result) {
        if (!result || typeof result !== 'object') {
            console.warn('Chat: Agent execute returned unexpected result', result);
            return null;
        }

        const { message, metadata } = result;
        const assistantMessage = buildAssistantMessageFromAgentResponse(message || 'No response', metadata || {});
        return assistantMessage;
    }

    function buildAssistantMessageFromAgentResponse(rawResponse) {
        if (!rawResponse || typeof rawResponse !== 'object') {
            return null;
        }

        const content = rawResponse.message ?? rawResponse.content ?? '';
        const metadata = rawResponse.metadata ?? {};
        const specClarificationData = rawResponse.specClarificationData
            ?? metadata.specClarificationData
            ?? rawResponse.payload?.specClarificationData;
        const interactiveQuestions = rawResponse.interactiveQuestions
            ?? metadata.interactiveQuestions
            ?? rawResponse.payload?.interactiveQuestions;
        const interactiveConfirmationQuestions = rawResponse.interactiveConfirmationQuestions
            ?? metadata.interactiveConfirmationQuestions
            ?? rawResponse.payload?.interactiveConfirmationQuestions;

        // Extract and update API cost if available
        const cost = rawResponse.cost ?? metadata.cost ?? rawResponse.payload?.cost;
        console.log('[COST DEBUG] buildAssistantMessageFromAgentResponse - cost extraction:', {
            rawResponseCost: rawResponse.cost,
            metadataCost: metadata.cost,
            payloadCost: rawResponse.payload?.cost,
            finalCost: cost,
            costType: typeof cost,
            rawResponse: rawResponse
        });
        
        if (cost && typeof cost === 'number') {
            console.log('[COST DEBUG] Calling updateApiCostDisplay with cost:', cost);
            updateApiCostDisplay(cost);
        } else {
            console.log('[COST DEBUG] Not updating cost display - cost is:', cost, 'type:', typeof cost);
        }

        // Prioritize sessionId and projectId from the raw response metadata
        // If not present, then fallback to chatState (which may not be initialized yet)
        const sessionId = metadata.sessionId ?? chatState.currentSessionId;
        const projectId = metadata.projectId ?? chatState.projectSettings?.projectId;

        const enrichedMetadata = {
            ...metadata,
            ...(specClarificationData ? { specClarificationData } : {}),
            ...(interactiveQuestions ? { interactiveQuestions } : {}),
            ...(interactiveConfirmationQuestions ? { interactiveConfirmationQuestions } : {}),
            samuraiAgentResponse: Boolean(metadata.samuraiAgentResponse || rawResponse.samuraiAgentResponse)
        };

        // Preserve existing ID if provided (from database or metadata), otherwise generate new one
        // This prevents duplicate saves when messages are reprocessed
        const existingId = rawResponse.id ?? metadata.id ?? rawResponse.payload?.id;
        const messageId = existingId || `assistant-${Date.now()}`;

        return {
            id: messageId,
            sessionId: sessionId || 'unknown-session',
            projectId: projectId || 'unknown-project',
            type: globalScope?.MessageType?.ASSISTANT || 'assistant',
            role: 'assistant',
            content,
            metadata: enrichedMetadata,
            specClarificationData,
            interactiveQuestions,
            interactiveConfirmationQuestions
        };
    }

    async function persistAssistantMessage(message) {
        if (!message || !message.sessionId || !message.projectId) {
            console.warn('Chat: Cannot persist assistant message without session/project context');
            return;
        }

        // Note: Messages with samuraiAgentResponse flag are part of the user's chat history
        // and should be persisted. This flag indicates the message came from the agent system,
        // but it's still a visible response that should be saved for chat history restoration.
        if (message.metadata?.samuraiAgentResponse) {
            console.log('Chat: Persisting agent response with samuraiAgentResponse flag (part of chat history)');
        }

        if (!globalScope?.WebviewApi?.persistence?.saveChatMessage) {
            console.warn('[Chat] WebviewApi.persistence.saveChatMessage not available');
            return;
        }
        await globalScope.WebviewApi.persistence.saveChatMessage({
            sessionId: message.sessionId,
            projectId: message.projectId,
            type: message.type,
            content: message.content,
            role: message.role,
            metadata: message.metadata,
            specClarificationData: message.specClarificationData,
            interactiveQuestions: message.interactiveQuestions,
            interactiveConfirmationQuestions: message.interactiveConfirmationQuestions
        });
    }

    /**
     * Checks if a message is a debugging analysis that should show feedback buttons
     */
    function isDebuggingMessage(message) {
        // Check for debugging-related metadata
        const hasDebuggingMetadata = 
            message.metadata?.debuggingMode ||
            message.metadata?.rootCauseReport ||
            message.metadata?.visualization ||
            message.metadata?.samuraiAgentResponse;

        // Check for debugging keywords in content
        const content = message.content || '';
        const hasDebuggingKeywords = 
            content.includes('Root Cause Analysis') ||
            content.includes('likely root cause') ||
            content.includes('recommended fix') ||
            content.includes('debugging') ||
            content.includes('hypothesis') ||
            content.includes('evidence');

        return hasDebuggingMetadata || hasDebuggingKeywords;
    }


    /**
     * Adds a copy-to-clipboard button for assistant messages (idempotent)
     * Ensures the control appears before feedback buttons when present.
     * @param {HTMLElement} messageElement
     * @param {Object} message
     */
    function addMessageCopyButton(messageElement, message) {
        if (!messageElement || !message || message.role !== 'assistant') {
            return;
        }

        if (messageElement.dataset.copyButtonAttached === '1') {
            return;
        }

        const copyContainer = document.createElement('div');
        copyContainer.className = 'message-copy-container';

        // Stage marker: Apply the fix
        const applyFixLabel = document.createElement('div');
        applyFixLabel.className = 'stage-marker';
        applyFixLabel.textContent = 'Apply the fix';

        // Create a group for copy buttons (Apply the fix phase)
        const copyButtonsGroup = document.createElement('div');
        copyButtonsGroup.className = 'copy-buttons-group';

        const copyBtn = document.createElement('button');
        copyBtn.type = 'button';
        copyBtn.className = 'message-copy-btn';
        copyBtn.setAttribute('aria-label', 'Copy response');
        copyBtn.textContent = '📋 Copy response';

        const resolveCopyText = () => {
            const rawContent = (message.content || '').trim();
            if (rawContent) {
                return rawContent;
            }

            const markdownBody = messageElement.querySelector('.md-body');
            if (markdownBody && typeof markdownBody.innerText === 'string') {
                return markdownBody.innerText.trim();
            }

            if (typeof messageElement.innerText === 'string') {
                return messageElement.innerText.trim();
            }

            return '';
        };

        copyBtn.addEventListener('click', async () => {
            const textToCopy = resolveCopyText();
            if (!textToCopy) {
                if (globalScope.showToast) {
                    globalScope.showToast('Nothing to copy from this response', 'warning');
                }
                return;
            }

            if (!navigator?.clipboard?.writeText) {
                console.warn('Chat: Clipboard API not available for message copy');
                if (globalScope.showToast) {
                    globalScope.showToast('Clipboard not available in this environment', 'error');
                }
                return;
            }

            const originalText = copyBtn.textContent;

            try {
                await navigator.clipboard.writeText(textToCopy);
                copyBtn.textContent = '✓ Copied';
                copyBtn.dataset.state = 'copied';

                setTimeout(() => {
                    copyBtn.textContent = originalText;
                    delete copyBtn.dataset.state;
                }, 2000);
            } catch (error) {
                console.error('Chat: Failed to copy message response:', error);
                if (globalScope.showToast) {
                    globalScope.showToast('Failed to copy response', 'error');
                }
            }
        });

        // Add "Copy prompt" button for AI coding tools (first in group)
        const copyPromptBtn = document.createElement('button');
        copyPromptBtn.type = 'button';
        copyPromptBtn.className = 'message-copy-btn message-copy-prompt-btn';
        copyPromptBtn.setAttribute('aria-label', 'Copy prompt for AI coding tools');
        copyPromptBtn.setAttribute('title', 'for Cursor/Claude/Copilot');
        copyPromptBtn.textContent = '📋 Copy prompt';
        
        // Disable button if sessionId is not available
        if (!message.sessionId || message.sessionId === 'unknown-session') {
            copyPromptBtn.disabled = true;
            copyPromptBtn.setAttribute('title', 'Session ID not available');
        }

        copyPromptBtn.addEventListener('click', async () => {
            // Disable button and show loading state
            copyPromptBtn.disabled = true;
            const originalText = copyPromptBtn.textContent;
            copyPromptBtn.textContent = '⏳ Loading...';
            copyPromptBtn.dataset.state = 'loading';

            try {
                // Get sessionId from message
                const sessionId = message.sessionId;
                if (!sessionId || sessionId === 'unknown-session') {
                    throw new Error('Session ID not available');
                }

                // Load all messages from persistence
                let allMessages = [];
                let currentMessageInSession = null;

                if (globalScope?.WebviewApi?.persistence?.loadChatMessagesForSession) {
                    try {
                        allMessages = await globalScope.WebviewApi.persistence.loadChatMessagesForSession(sessionId);
                        
                        if (!Array.isArray(allMessages)) {
                            throw new Error('Failed to load messages: invalid response');
                        }

                        // Find current message in loaded messages
                        currentMessageInSession = allMessages.find(msg => msg.id === message.id);
                        
                        // If message not found, fallback to DOM
                        if (!currentMessageInSession) {
                            console.warn('Chat: Current message not found in loaded session, falling back to DOM');
                            const priorMessages = getPriorMessagesFromDOM(messageElement);
                            const currentContent = message.content || 
                                (messageElement.querySelector('.md-body')?.innerText || 
                                 messageElement.innerText || '').trim();
                            
                            if (currentContent) {
                                const formattedPrompt = formatConversationForAITools(
                                    { id: message.id, content: currentContent, createdAt: null },
                                    priorMessages
                                );
                                
                                await copyToClipboard(formattedPrompt);
                                copyPromptBtn.textContent = '✓ Copied';
                                copyPromptBtn.dataset.state = 'copied';
                                
                                setTimeout(() => {
                                    copyPromptBtn.textContent = originalText;
                                    delete copyPromptBtn.dataset.state;
                                    copyPromptBtn.disabled = false;
                                }, 2000);
                                return;
                            } else {
                                throw new Error('No content available to copy');
                            }
                        }
                    } catch (error) {
                        console.error('Chat: Failed to load messages from persistence:', error);
                        // Fallback to DOM
                        const priorMessages = getPriorMessagesFromDOM(messageElement);
                        const currentContent = message.content || 
                            (messageElement.querySelector('.md-body')?.innerText || 
                             messageElement.innerText || '').trim();
                        
                        if (currentContent && priorMessages.length > 0) {
                            const formattedPrompt = formatConversationForAITools(
                                { id: message.id, content: currentContent, createdAt: null },
                                priorMessages
                            );
                            
                            await copyToClipboard(formattedPrompt);
                            copyPromptBtn.textContent = '✓ Copied';
                            copyPromptBtn.dataset.state = 'copied';
                            
                            setTimeout(() => {
                                copyPromptBtn.textContent = originalText;
                                delete copyPromptBtn.dataset.state;
                                copyPromptBtn.disabled = false;
                            }, 2000);
                            return;
                        }
                        throw error;
                    }
                } else {
                    throw new Error('Persistence API not available');
                }

                // Format and copy
                const formattedPrompt = formatConversationForAITools(currentMessageInSession, allMessages);
                
                if (!formattedPrompt || !formattedPrompt.trim()) {
                    throw new Error('No content available to copy');
                }

                await copyToClipboard(formattedPrompt);
                
                copyPromptBtn.textContent = '✓ Copied';
                copyPromptBtn.dataset.state = 'copied';
                
                if (globalScope.showToast) {
                    globalScope.showToast('Copied prompt for AI coding tools', 'success');
                }

                setTimeout(() => {
                    copyPromptBtn.textContent = originalText;
                    delete copyPromptBtn.dataset.state;
                    copyPromptBtn.disabled = false;
                }, 2000);

            } catch (error) {
                console.error('Chat: Failed to copy prompt:', error);
                copyPromptBtn.textContent = originalText;
                delete copyPromptBtn.dataset.state;
                copyPromptBtn.disabled = false;
                
                if (globalScope.showToast) {
                    const errorMsg = error.message || 'Failed to copy prompt';
                    globalScope.showToast(errorMsg, 'error');
                }
            }
        });

        // Add buttons to copy group in order: Copy prompt, then Copy response
        copyButtonsGroup.appendChild(copyPromptBtn);
        copyButtonsGroup.appendChild(copyBtn);
        
        // Add Apply the fix section to container
        copyContainer.appendChild(applyFixLabel);
        copyContainer.appendChild(copyButtonsGroup);

        // Stage marker: Verify the fix
        const verifyFixLabel = document.createElement('div');
        verifyFixLabel.className = 'stage-marker';
        verifyFixLabel.textContent = 'Verify the fix';

        // Add "Review Fix" button with subtext (Verify the fix phase)
        const reviewFixContainer = document.createElement('div');
        reviewFixContainer.className = 'review-fix-container';
        
        const reviewFixBtn = document.createElement('button');
        reviewFixBtn.type = 'button';
        reviewFixBtn.className = 'message-copy-btn review-fix-btn';
        reviewFixBtn.setAttribute('aria-label', 'Review fix');
        reviewFixBtn.textContent = '🔍 Review Fix';

        const reviewFixSubtext = document.createElement('div');
        reviewFixSubtext.className = 'review-fix-subtext';
        reviewFixSubtext.textContent = 'Check if the root cause is resolved and no regressions were introduced';

        reviewFixBtn.addEventListener('click', () => {
            const sendReviewFixMessage = () => {
                void sendMessage("I've applied the fix. Does it actually resolve the root cause without introducing regressions?");
            };
            
            // Show modal unless user has dismissed it
            if (isReviewFixModalDismissed()) {
                sendReviewFixMessage();
            } else {
                showReviewFixModal(sendReviewFixMessage);
            }
        });

        reviewFixContainer.appendChild(reviewFixBtn);
        reviewFixContainer.appendChild(reviewFixSubtext);
        
        // Add Verify the fix section to container
        copyContainer.appendChild(verifyFixLabel);
        copyContainer.appendChild(reviewFixContainer);

        const feedbackContainer = messageElement.querySelector('.feedback-container');
        if (feedbackContainer && feedbackContainer.parentNode === messageElement) {
            messageElement.insertBefore(copyContainer, feedbackContainer);
        } else {
            messageElement.appendChild(copyContainer);
        }

        messageElement.dataset.copyButtonAttached = '1';
    }

    /**
     * Shows a modal warning before sending the review fix message
     * @param {Function} onConfirm - Callback when user confirms
     */
    function showReviewFixModal(onConfirm) {
        // Create overlay
        const overlay = document.createElement('div');
        overlay.className = 'review-fix-modal-overlay';
        
        // Create modal
        const modal = document.createElement('div');
        modal.className = 'review-fix-modal';
        
        // Title
        const title = document.createElement('h3');
        title.className = 'review-fix-modal-title';
        title.textContent = 'Review fix & check for regressions';
        
        // Body
        const body = document.createElement('p');
        body.className = 'review-fix-modal-body';
        body.textContent = "This will re-analyze your project to check whether the root cause is actually resolved and whether the fix introduced any regressions.\n\nMake sure you've already applied the code changes before continuing.";
        
        // Footer container
        const footer = document.createElement('div');
        footer.className = 'review-fix-modal-footer';
        
        // Checkbox
        const checkboxContainer = document.createElement('label');
        checkboxContainer.className = 'review-fix-modal-checkbox-label';
        const checkbox = document.createElement('input');
        checkbox.type = 'checkbox';
        checkbox.className = 'review-fix-modal-checkbox';
        const checkboxText = document.createElement('span');
        checkboxText.textContent = "Don't show this again";
        checkboxContainer.appendChild(checkbox);
        checkboxContainer.appendChild(checkboxText);
        
        // Confirm button
        const confirmBtn = document.createElement('button');
        confirmBtn.type = 'button';
        confirmBtn.className = 'review-fix-modal-confirm-btn';
        confirmBtn.textContent = '✅ Review fix';
        
        // Close handler
        const closeModal = () => {
            if (overlay.parentNode) {
                overlay.parentNode.removeChild(overlay);
            }
            document.removeEventListener('keydown', escapeHandler);
        };
        
        // Escape key handler
        const escapeHandler = (e) => {
            if (e.key === 'Escape') {
                closeModal();
            }
        };
        
        // Confirm handler
        confirmBtn.addEventListener('click', () => {
            if (checkbox.checked) {
                setReviewFixModalDismissed();
            }
            closeModal();
            onConfirm();
        });
        
        // Close on overlay click (outside modal)
        overlay.addEventListener('click', (e) => {
            if (e.target === overlay) {
                closeModal();
            }
        });
        
        // Close on Escape key
        document.addEventListener('keydown', escapeHandler);
        
        // Assemble modal
        footer.appendChild(confirmBtn);
        footer.appendChild(checkboxContainer);
        
        modal.appendChild(title);
        modal.appendChild(body);
        modal.appendChild(footer);
        overlay.appendChild(modal);
        
        // Append to body
        document.body.appendChild(overlay);
    }

    /**
     * Helper function to copy to clipboard with fallback
     * @param {string} text - Text to copy
     */
    async function copyToClipboard(text) {
        if (!text || !text.trim()) {
            throw new Error('Nothing to copy');
        }

        // Try modern clipboard API first
        if (navigator?.clipboard?.writeText) {
            try {
                await navigator.clipboard.writeText(text);
                return;
            } catch (error) {
                console.warn('Chat: Clipboard API failed, trying fallback:', error);
            }
        }

        // Fallback to execCommand
        const textarea = document.createElement('textarea');
        textarea.value = text;
        textarea.style.position = 'fixed';
        textarea.style.opacity = '0';
        textarea.style.left = '-9999px';
        document.body.appendChild(textarea);
        
        try {
            textarea.select();
            const success = document.execCommand('copy');
            document.body.removeChild(textarea);
            
            if (!success) {
                throw new Error('execCommand copy failed');
            }
        } catch (error) {
            document.body.removeChild(textarea);
            throw new Error('Clipboard not available in this environment');
        }
    }

    /**
     * Normalizes file paths to workspace-relative format
     * @param {string} filePath - The file path to normalize
     * @param {string} workspaceRoot - The workspace root path (optional)
     * @returns {string} Workspace-relative path
     */
    function normalizeToWorkspacePath(filePath, workspaceRoot) {
        if (!filePath || typeof filePath !== 'string') {
            return '';
        }
        
        // If already relative (doesn't start with / or drive letter), return as is
        if (!filePath.startsWith('/') && !/^[A-Za-z]:/.test(filePath)) {
            return filePath;
        }
        
        // If workspace root is provided, try to make it relative
        if (workspaceRoot && typeof workspaceRoot === 'string') {
            const normalizedWorkspace = workspaceRoot.replace(/\\/g, '/');
            const normalizedPath = filePath.replace(/\\/g, '/');
            
            if (normalizedPath.startsWith(normalizedWorkspace)) {
                const relativePath = normalizedPath.substring(normalizedWorkspace.length);
                return relativePath.startsWith('/') ? relativePath.substring(1) : relativePath;
            }
        }
        
        // Fallback: return path as is if we can't normalize
        return filePath;
    }

    /**
     * Renders analyzed files section as HTML for UI display
     * @param {Object} epilogue - Epilogue object with files array
     * @returns {string} HTML string for collapsible section, or empty string if no files
     */
    function renderAnalyzedFilesSection(epilogue) {
        if (!epilogue || !Array.isArray(epilogue.files) || epilogue.files.length === 0) {
            return '';
        }
        
        const files = epilogue.files
            .map(file => normalizeToWorkspacePath(file))
            .filter(file => file && file.trim().length > 0)
            .sort((a, b) => a.localeCompare(b));
        
        if (files.length === 0) {
            return '';
        }
        
        const fileList = files.map(file => {
            const escapedFile = file.replace(/</g, '&lt;').replace(/>/g, '&gt;');
            return `    <li class="analyzed-file-item"><code>${escapedFile}</code></li>`;
        }).join('\n');
        
        return `
<details class="analyzed-files-details">
    <summary class="analyzed-files-summary">
        <span class="analyzed-files-chevron">▶</span>
        <span class="analyzed-files-label">Advanced: analyzed files</span>
    </summary>
    <ul class="analyzed-files-list">
${fileList}
    </ul>
</details>`;
    }

    /**
     * Formats files for copy prompt
     * @param {Object} epilogue - Epilogue object with files array
     * @returns {string} Formatted markdown string, or empty string if no files
     */
    function formatFilesForCopyPrompt(epilogue) {
        if (!epilogue || !Array.isArray(epilogue.files) || epilogue.files.length === 0) {
            return '';
        }
        
        const files = epilogue.files
            .map(file => normalizeToWorkspacePath(file))
            .filter(file => file && file.trim().length > 0)
            .sort((a, b) => a.localeCompare(b));
        
        if (files.length === 0) {
            return '';
        }
        
        const fileList = files.map(file => `    - ${file}`).join('\n');
        
        return `## Files analyzed (${files.length})

${fileList}

Instruction to Cursor:
- Start by investigating the files listed above, as they were identified during the debugging session.
- **IMPORTANT:** Verify the root cause hypothesis first. If the root cause seems incorrect or incomplete, investigate additional files beyond this list as needed.
- Do not be narrowly focused on only these files - explore other files if necessary to find the true root cause.
- Once you've confirmed the root cause, prioritize edits in the relevant files (which may include files not in this list).
- Minimize changes to avoid regressions, but don't hesitate to investigate files outside this list if the analysis seems wrong.

`;
    }

    /**
     * Formats conversation history for AI coding tools
     * @param {Object} currentAssistantMessage - The current assistant message
     * @param {Array} allMessages - All messages from the session
     * @returns {string} Formatted markdown string
     */
    function formatConversationForAITools(currentAssistantMessage, allMessages) {
        if (!currentAssistantMessage || !Array.isArray(allMessages)) {
            return '';
        }

        // Filter messages to get prior messages (before current assistant message)
        const currentId = currentAssistantMessage.id;
        const currentCreatedAt = currentAssistantMessage.createdAt 
            ? (currentAssistantMessage.createdAt instanceof Date 
                ? currentAssistantMessage.createdAt.getTime() 
                : new Date(currentAssistantMessage.createdAt).getTime())
            : null;

        // Filter prior messages
        let priorMessages = allMessages.filter(msg => {
            // Skip the current message itself
            if (msg.id === currentId) {
                return false;
            }

            // Filter by createdAt if available
            if (currentCreatedAt && msg.createdAt) {
                const msgCreatedAt = msg.createdAt instanceof Date 
                    ? msg.createdAt.getTime() 
                    : new Date(msg.createdAt).getTime();
                if (msgCreatedAt > currentCreatedAt) {
                    return false;
                }
            }

            // Skip noise: system/internal/tool messages
            if (msg.role === 'system' || (msg.type && msg.type !== 'user' && msg.type !== 'assistant')) {
                return false;
            }

            // Skip empty messages
            if (!msg.content || !msg.content.trim()) {
                return false;
            }

            // Skip UI action messages (check for common patterns)
            const contentLower = msg.content.toLowerCase().trim();
            if (contentLower === 'copy' || contentLower.startsWith('copy ') || 
                contentLower.includes('[copy]') || contentLower.includes('copied')) {
                return false;
            }

            // Only include user and assistant messages
            return msg.role === 'user' || msg.role === 'assistant';
        });

        // Sort by createdAt if available
        priorMessages.sort((a, b) => {
            const aTime = a.createdAt 
                ? (a.createdAt instanceof Date ? a.createdAt.getTime() : new Date(a.createdAt).getTime())
                : 0;
            const bTime = b.createdAt 
                ? (b.createdAt instanceof Date ? b.createdAt.getTime() : new Date(b.createdAt).getTime())
                : 0;
            return aTime - bTime;
        });

        // Cap length if too long (>10k chars in context section)
        const MAX_CONTEXT_LENGTH = 10000;
        let contextLength = priorMessages.reduce((sum, msg) => sum + (msg.content || '').length, 0);
        
        if (contextLength > MAX_CONTEXT_LENGTH && priorMessages.length > 2) {
            // Keep first message (initial problem) and last N messages
            const firstMessage = priorMessages[0];
            const lastMessages = priorMessages.slice(-10); // Keep last 10 messages
            priorMessages = [firstMessage, ...lastMessages];
        }

        // Build markdown
        const header = 'Verify the hypothesis below using the context. If wrong, propose the correct root cause. Then propose a minimal fix + regression tests.';
        
        // Add files section if available in message metadata
        let filesSection = '';
        if (currentAssistantMessage.metadata?.epilogue) {
            filesSection = formatFilesForCopyPrompt(currentAssistantMessage.metadata.epilogue);
        }
        
        let contextSection = '## Context / Repro / Evidence\n\n';
        if (priorMessages.length === 0) {
            contextSection += '*No prior conversation context.*\n';
        } else {
            priorMessages.forEach(msg => {
                const role = msg.role === 'user' ? 'User' : 'Assistant';
                const content = (msg.content || '').trim();
                contextSection += `**${role}:** ${content}\n\n`;
            });
        }

        const hypothesisSection = `## Hypothesis\n\n${(currentAssistantMessage.content || '').trim()}\n\n`;

        const wantsSection = `## What I want from you\n\n- Verify the hypothesis\n- Propose fix if hypothesis is wrong\n- List regression tests\n- Avoid regressions\n`;

        // Build full prompt with files section at the top (after header, before context)
        const fullPrompt = `${header}\n\n${filesSection}${contextSection}${hypothesisSection}${wantsSection}`;

        // Warn if prompt is very long
        if (fullPrompt.length > 15000) {
            console.warn('Chat: Generated prompt is very long (>15k chars), consider trimming');
        }

        return fullPrompt;
    }

    /**
     * Gets prior messages from DOM as fallback when persistence is unavailable
     * @param {HTMLElement} currentMessageElement - The current message element
     * @returns {Array} Array of message objects
     */
    function getPriorMessagesFromDOM(currentMessageElement) {
        if (!currentMessageElement) {
            return [];
        }

        const chatMessages = safeGetDocumentElement('chatMessages');
        if (!chatMessages) {
            return [];
        }

        const allElements = Array.from(chatMessages.querySelectorAll('.chat-message'));
        const currentIndex = allElements.indexOf(currentMessageElement);
        
        if (currentIndex === -1) {
            return [];
        }

        const priorElements = allElements.slice(0, currentIndex);
        const priorMessages = [];

        priorElements.forEach(element => {
            // Get role from dataset first, then fallback to class list
            let role = element.dataset.role;
            if (!role) {
                if (element.classList.contains('user-message')) {
                    role = 'user';
                } else if (element.classList.contains('assistant-message')) {
                    role = 'assistant';
                }
            }
            
            if (!role || role === 'system') {
                return;
            }

            const content = element.dataset.content || 
                          (element.querySelector('.message-content')?.textContent || '').trim();
            
            if (!content) {
                return;
            }

            priorMessages.push({
                role: role,
                content: content,
                id: element.dataset.messageId || null
            });
        });

        return priorMessages;
    }

    /**
     * Renders feedback buttons for debugging messages
     */
    function renderFeedbackButtons(messageElement, message) {
        // Create feedback container
        const feedbackContainer = document.createElement('div');
        feedbackContainer.className = 'feedback-container';
        feedbackContainer.style.display = 'none'; // Initially hidden

        // Create feedback buttons
        const buttonsContainer = document.createElement('div');
        buttonsContainer.className = 'feedback-buttons';

        // Positive button
        const positiveBtn = document.createElement('button');
        positiveBtn.className = 'feedback-btn feedback-btn-positive';
        positiveBtn.innerHTML = '✅ Fixed it';
        positiveBtn.addEventListener('click', () => handleFeedbackClick('positive', message, feedbackContainer));

        // Partial button
        const partialBtn = document.createElement('button');
        partialBtn.className = 'feedback-btn feedback-btn-partial';
        partialBtn.innerHTML = '🤏 Partially helped';
        partialBtn.addEventListener('click', () => handleFeedbackClick('partial', message, feedbackContainer));

        // Negative button
        const negativeBtn = document.createElement('button');
        negativeBtn.className = 'feedback-btn feedback-btn-negative';
        negativeBtn.innerHTML = '❌ Didn\'t work';
        negativeBtn.addEventListener('click', () => handleFeedbackClick('negative', message, feedbackContainer));

        buttonsContainer.appendChild(positiveBtn);
        buttonsContainer.appendChild(partialBtn);
        buttonsContainer.appendChild(negativeBtn);
        buttonsContainer.style.display = 'none'; // Hide feedback buttons for beta testing

        // Create note input (collapsible)
        const noteContainer = document.createElement('div');
        noteContainer.className = 'feedback-note-container';
        noteContainer.style.display = 'none';

        const noteLabel = document.createElement('label');
        noteLabel.textContent = 'Optional note (max 180 chars):';
        noteLabel.className = 'feedback-note-label';

        const noteInput = document.createElement('textarea');
        noteInput.className = 'feedback-note-input';
        noteInput.placeholder = 'What specifically helped or didn\'t help?';
        noteInput.maxLength = 180;

        const noteCharCount = document.createElement('div');
        noteCharCount.className = 'feedback-note-char-count';
        noteCharCount.textContent = '0/180';

        noteInput.addEventListener('input', () => {
            noteCharCount.textContent = `${noteInput.value.length}/180`;
        });

        noteContainer.appendChild(noteLabel);
        noteContainer.appendChild(noteInput);
        noteContainer.appendChild(noteCharCount);

        // Create repro tag input
        const tagContainer = document.createElement('div');
        tagContainer.className = 'feedback-tag-container';
        tagContainer.style.display = 'none';

        const tagLabel = document.createElement('label');
        tagLabel.textContent = 'Tag this issue (optional):';
        tagLabel.className = 'feedback-tag-label';

        const tagInput = document.createElement('input');
        tagInput.className = 'feedback-tag-input';
        tagInput.placeholder = 'e.g., profile-save, orders-empty';
        tagInput.maxLength = 50;

        tagContainer.appendChild(tagLabel);
        tagContainer.appendChild(tagInput);

        // Create submit/cancel buttons
        const actionContainer = document.createElement('div');
        actionContainer.className = 'feedback-actions';
        actionContainer.style.display = 'none';

        const submitBtn = document.createElement('button');
        submitBtn.className = 'feedback-submit-btn';
        submitBtn.textContent = 'Submit Feedback';
        submitBtn.addEventListener('click', () => submitFeedback(message, feedbackContainer, noteInput.value, tagInput.value));

        const cancelBtn = document.createElement('button');
        cancelBtn.className = 'feedback-cancel-btn';
        cancelBtn.textContent = 'Cancel';
        cancelBtn.addEventListener('click', () => hideFeedbackForm(feedbackContainer));

        actionContainer.appendChild(submitBtn);
        actionContainer.appendChild(cancelBtn);

        // Create toggle button for advanced options
        const toggleBtn = document.createElement('button');
        toggleBtn.className = 'feedback-toggle-btn';
        toggleBtn.textContent = 'More options';
        toggleBtn.addEventListener('click', () => toggleAdvancedOptions(feedbackContainer));
        toggleBtn.style.display = 'none'; // Hide toggle button for beta testing

        // Create Tally feedback form container
        const tallyContainer = document.createElement('div');
        tallyContainer.className = 'tally-feedback-container';
        
        // Create Tally iframe
        const tallyIframe = document.createElement('iframe');
        const tallyUrl = 'https://tally.so/embed/xXXq2o?alignLeft=1&hideTitle=1&dynamicHeight=1';
        tallyIframe.setAttribute('data-tally-src', tallyUrl);
        tallyIframe.setAttribute('loading', 'lazy');
        tallyIframe.setAttribute('width', '100%');
        tallyIframe.setAttribute('height', '200');
        tallyIframe.setAttribute('frameborder', '0');
        tallyIframe.setAttribute('marginheight', '0');
        tallyIframe.setAttribute('marginwidth', '0');
        tallyIframe.setAttribute('title', 'Feedback');
        // Set src directly as fallback (will be overridden by Tally script if it loads)
        tallyIframe.src = tallyUrl;
        
        tallyContainer.appendChild(tallyIframe);

        // Assemble the feedback container
        feedbackContainer.appendChild(buttonsContainer);
        feedbackContainer.appendChild(toggleBtn);
        feedbackContainer.appendChild(tallyContainer);
        feedbackContainer.appendChild(noteContainer);
        feedbackContainer.appendChild(tagContainer);
        feedbackContainer.appendChild(actionContainer);

        // Add to message element
        messageElement.appendChild(feedbackContainer);

        // Initialize Tally embed script after container is in DOM
        const initTallyEmbed = function() {
            if (typeof Tally !== 'undefined') {
                Tally.loadEmbeds();
            } else {
                // Fallback: manually set iframe src if Tally script is not available
                const iframes = document.querySelectorAll('iframe[data-tally-src]:not([src])');
                iframes.forEach((iframe) => {
                    if (iframe.dataset.tallySrc) {
                        iframe.src = iframe.dataset.tallySrc;
                    }
                });
            }
        };
        
        // Use setTimeout to ensure DOM is ready and initialize Tally
        setTimeout(() => {
            // Load Tally embed script if not already loaded
            if (typeof Tally !== 'undefined') {
                initTallyEmbed();
            } else {
                const existingScript = document.querySelector('script[src="https://tally.so/widgets/embed.js"]');
                if (!existingScript) {
                    const script = document.createElement('script');
                    script.src = 'https://tally.so/widgets/embed.js';
                    script.onload = initTallyEmbed;
                    script.onerror = function() {
                        // If script fails to load, manually set iframe src as fallback
                        console.warn('Tally script failed to load, using fallback');
                        initTallyEmbed();
                    };
                    document.body.appendChild(script);
                } else {
                    // Script already exists, wait a bit then initialize
                    setTimeout(initTallyEmbed, 100);
                }
            }
        }, 100);

        // Show feedback container after a short delay
        setTimeout(() => {
            feedbackContainer.style.display = 'block';
        }, 1000);
    }

    /**
     * Handles feedback button clicks
     */
    function handleFeedbackClick(result, message, feedbackContainer) {
        // Hide main buttons
        const buttonsContainer = feedbackContainer.querySelector('.feedback-buttons');
        const toggleBtn = feedbackContainer.querySelector('.feedback-toggle-btn');
        const tallyContainer = feedbackContainer.querySelector('.tally-feedback-container');
        
        if (buttonsContainer) buttonsContainer.style.display = 'none';
        if (toggleBtn) toggleBtn.style.display = 'none';
        if (tallyContainer) tallyContainer.style.display = 'none';

        // Show advanced options
        const noteContainer = feedbackContainer.querySelector('.feedback-note-container');
        const tagContainer = feedbackContainer.querySelector('.feedback-tag-container');
        const actionContainer = feedbackContainer.querySelector('.feedback-actions');

        if (noteContainer) noteContainer.style.display = 'block';
        if (tagContainer) tagContainer.style.display = 'block';
        if (actionContainer) actionContainer.style.display = 'block';

        // Store the selected result
        feedbackContainer.dataset.selectedResult = result;
    }

    /**
     * Toggles advanced feedback options
     */
    function toggleAdvancedOptions(feedbackContainer) {
        const noteContainer = feedbackContainer.querySelector('.feedback-note-container');
        const tagContainer = feedbackContainer.querySelector('.feedback-tag-container');
        const actionContainer = feedbackContainer.querySelector('.feedback-actions');
        const toggleBtn = feedbackContainer.querySelector('.feedback-toggle-btn');

        const isVisible = noteContainer.style.display === 'block';
        
        if (noteContainer) noteContainer.style.display = isVisible ? 'none' : 'block';
        if (tagContainer) tagContainer.style.display = isVisible ? 'none' : 'block';
        if (actionContainer) actionContainer.style.display = isVisible ? 'none' : 'block';
        if (toggleBtn) toggleBtn.textContent = isVisible ? 'More options' : 'Less options';
    }

    /**
     * Hides the feedback form
     */
    function hideFeedbackForm(feedbackContainer) {
        const buttonsContainer = feedbackContainer.querySelector('.feedback-buttons');
        const noteContainer = feedbackContainer.querySelector('.feedback-note-container');
        const tagContainer = feedbackContainer.querySelector('.feedback-tag-container');
        const actionContainer = feedbackContainer.querySelector('.feedback-actions');
        const toggleBtn = feedbackContainer.querySelector('.feedback-toggle-btn');
        const tallyContainer = feedbackContainer.querySelector('.tally-feedback-container');

        if (buttonsContainer) buttonsContainer.style.display = 'block';
        if (noteContainer) noteContainer.style.display = 'none';
        if (tallyContainer) tallyContainer.style.display = 'block';
        if (tagContainer) tagContainer.style.display = 'none';
        if (actionContainer) actionContainer.style.display = 'none';
        if (toggleBtn) {
            toggleBtn.style.display = 'block';
            toggleBtn.textContent = 'More options';
        }

        // Clear inputs
        const noteInput = feedbackContainer.querySelector('.feedback-note-input');
        const tagInput = feedbackContainer.querySelector('.feedback-tag-input');
        if (noteInput) noteInput.value = '';
        if (tagInput) tagInput.value = '';

        // Clear selected result
        delete feedbackContainer.dataset.selectedResult;
    }

    /**
     * Submits feedback to the backend
     */
    async function submitFeedback(message, feedbackContainer, note, reproTag) {
        const selectedResult = feedbackContainer.dataset.selectedResult;
        if (!selectedResult) {
            console.error('No feedback result selected');
            return;
        }

        // Extract debugging information from message
        const feedbackPayload = {
            reportId: message.id || `report-${Date.now()}`,
            result: selectedResult,
            summary: extractSummary(message),
            likelyRootCause: extractRootCause(message),
            relatedFiles: extractRelatedFiles(message),
            mode: extractMode(message),
            confidence: extractConfidence(message),
            bugDescription: extractBugDescription(message),
            note: note.trim() || undefined,
            reproTag: reproTag.trim() || undefined,
        };

        try {
            // Show loading state
            const actionContainer = feedbackContainer.querySelector('.feedback-actions');
            if (actionContainer) {
                actionContainer.innerHTML = '<div class="feedback-loading">Submitting feedback...</div>';
            }

            // Send feedback to backend
            if (!globalScope?.WebviewApi?.postCommand) {
                console.warn('[Chat] WebviewApi.postCommand not available');
            } else {
                await globalScope.WebviewApi.postCommand('debugFeedback', feedbackPayload);
            }

            // Show success state
            feedbackContainer.innerHTML = `
                <div class="feedback-submitted">
                    <div class="feedback-success">✅ Thank you for your feedback!</div>
                    <div class="feedback-message">This helps improve future debugging analyses.</div>
                </div>
            `;

        } catch (error) {
            console.error('Failed to submit feedback:', error);
            
            // Show error state
            feedbackContainer.innerHTML = `
                <div class="feedback-submitted">
                    <div class="feedback-error">❌ Failed to submit feedback</div>
                    <div class="feedback-message">Please try again later.</div>
                </div>
            `;
        }
    }

    /**
     * Extracts summary from debugging message
     */
    function extractSummary(message) {
        const content = message.content || '';
        const summaryMatch = content.match(/## 🧩 Root Cause Analysis Report\n\n(.*?)(?:\n\n|$)/s);
        return summaryMatch ? summaryMatch[1].substring(0, 500) : content.substring(0, 500);
    }

    /**
     * Extracts root cause from debugging message
     */
    function extractRootCause(message) {
        const content = message.content || '';
        const rootCauseMatch = content.match(/\*\*Root Cause:\*\*\s*(.*?)(?:\n|$)/);
        return rootCauseMatch ? rootCauseMatch[1].substring(0, 500) : 'Unknown';
    }

    /**
     * Extracts related files from debugging message
     */
    function extractRelatedFiles(message) {
        const content = message.content || '';
        const fileMatches = content.match(/`([^`]+\.(?:ts|js|tsx|jsx|py|java|cpp|c|h|go|rs|php|rb|swift|kt|scala|clj|hs|ml|fs|vb|cs|dart|r|m|mm|cc|cxx|hpp|hxx))`/g);
        return fileMatches ? fileMatches.map(match => match.replace(/`/g, '')) : [];
    }

    /**
     * Extracts mode from debugging message
     */
    function extractMode(message) {
        const metadata = message.metadata || {};
        if (metadata.visualizationMeta?.mode) {
            return metadata.visualizationMeta.mode;
        }
        return 'behavior-first'; // Default mode
    }

    /**
     * Extracts confidence from debugging message
     */
    function extractConfidence(message) {
        const metadata = message.metadata || {};
        return metadata.confidence || 0.5; // Default confidence
    }

    /**
     * Extracts bug description from debugging message
     */
    function extractBugDescription(message) {
        // Try to get from metadata first
        const metadata = message.metadata || {};
        if (metadata.bugDescription) {
            return metadata.bugDescription;
        }

        // Fallback to extracting from content
        const content = message.content || '';
        const bugMatch = content.match(/\*\*Bug Description:\*\*\s*(.*?)(?:\n|$)/);
        return bugMatch ? bugMatch[1] : content.substring(0, 200);
    }

    /**
     * Global function to trigger image generation
     * @param {string} sessionId - The session ID
     * @param {string} messageId - The unique message ID for container identification
     */
    window.triggerImageGen = function(sessionId, messageId) {
        const btn = document.querySelector(`#concept-container-${messageId} button`);
        if (btn) {
            btn.textContent = "Generating...";
            btn.disabled = true;
        }
        
        // Get root cause text from the message content if available
        const messageElement = document.querySelector(`#concept-container-${messageId}`)?.closest('.chat-message');
        let rootCauseText = null;
        if (messageElement) {
            // Try to extract text content from the message content area (more precise)
            // Prefer .md-body or .message-content to avoid getting text from buttons, headers, etc.
            const contentElement = messageElement.querySelector('.md-body') || 
                                   messageElement.querySelector('.message-content') ||
                                   messageElement;
            
            const textContent = contentElement.textContent || contentElement.innerText;
            if (textContent && textContent.trim().length > 0) {
                // Remove excessive whitespace and limit length
                rootCauseText = textContent.trim().substring(0, 2000);
                console.log('[Chat] Extracted rootCauseText for image generation', {
                    sessionId,
                    messageId,
                    textLength: rootCauseText.length,
                    preview: rootCauseText.substring(0, 100)
                });
            } else {
                console.warn('[Chat] No valid text content found in message element', { sessionId, messageId });
            }
        } else {
            console.warn('[Chat] Message element not found for concept container', { sessionId, messageId });
        }

        // Validate extracted text before sending
        // Ensure we have a reasonable amount of text (at least 10 characters) to generate a meaningful image
        const MIN_TEXT_LENGTH = 10;
        if (rootCauseText && rootCauseText.trim().length < MIN_TEXT_LENGTH) {
            console.warn('[Chat] Extracted rootCauseText is too short, will rely on backend fallback', {
                sessionId,
                messageId,
                textLength: rootCauseText.trim().length
            });
            // Still send it, but backend will use fallback if it's too short
        }

        // Send message to extension using WebviewApi
        const sendMessage = () => {
            if (globalScope?.WebviewApi?.postCommand) {
                console.log('[Chat] Sending generateConceptImage command', {
                    sessionId,
                    messageId,
                    hasRootCauseText: !!rootCauseText,
                    rootCauseTextLength: rootCauseText?.length || 0
                });
                
                globalScope.WebviewApi.postCommand('generateConceptImage', {
                    sessionId: sessionId,
                    messageId: messageId,
                    rootCauseText: rootCauseText
                }).catch(error => {
                    console.error('[Chat] Failed to generate concept image:', error);
                    if (btn) {
                        btn.textContent = '✨ Generate Concept Diagram ($0.13)';
                        btn.disabled = false;
                        btn.style.opacity = '1';
                        btn.style.cursor = 'pointer';
                    }
                });
            } else {
                console.error('[Chat] WebviewApi.postCommand not available. globalScope:', !!globalScope, 'WebviewApi:', !!globalScope?.WebviewApi);
                if (btn) {
                    btn.textContent = '✨ Generate Concept Diagram ($0.13)';
                    btn.disabled = false;
                    btn.style.opacity = '1';
                    btn.style.cursor = 'pointer';
                }
            }
        };

        // Try immediately, or wait a bit for WebviewApi to initialize
        if (globalScope?.WebviewApi?.postCommand) {
            sendMessage();
        } else {
            // Wait up to 2 seconds for WebviewApi to be available
            let attempts = 0;
            const maxAttempts = 20;
            const checkInterval = setInterval(() => {
                attempts++;
                if (globalScope?.WebviewApi?.postCommand) {
                    clearInterval(checkInterval);
                    sendMessage();
                } else if (attempts >= maxAttempts) {
                    clearInterval(checkInterval);
                    console.error('[Chat] WebviewApi.postCommand not available after waiting');
                    if (btn) {
                        btn.textContent = '✨ Generate Concept Diagram ($0.13)';
                        btn.disabled = false;
                        btn.style.opacity = '1';
                        btn.style.cursor = 'pointer';
                    }
                }
            }, 100);
        }
    };

    /**
     * Creates a concept button wrapper for image generation
     * @param {string} sessionId - The session ID
     * @param {string} messageId - The unique message ID for container identification
     * @returns {HTMLElement} The concept wrapper element with button
     */
    function createConceptButton(sessionId, messageId) {
        // Create concept wrapper container
        const conceptWrapper = document.createElement('div');
        conceptWrapper.id = `concept-container-${messageId}`;
        conceptWrapper.className = 'concept-wrapper-top';
        
        // Create button element
        const generateBtn = document.createElement('button');
        generateBtn.className = 'generate-btn';
        generateBtn.textContent = '✨ Generate Concept Diagram ($0.13)';
        generateBtn.style.cssText = 'padding: 8px 16px; background: var(--vscode-button-background, #007acc); color: var(--vscode-button-foreground, white); border: none; border-radius: 4px; cursor: pointer; font-size: 13px;';
        
        // Bind click event listener directly (CSP-compliant)
        generateBtn.addEventListener('click', () => {
            // Update UI state immediately
            generateBtn.textContent = 'Generating...';
            generateBtn.disabled = true;
            generateBtn.style.opacity = '0.7';
            generateBtn.style.cursor = 'wait';
            
            // Call the global trigger function (which uses WebviewApi)
            if (window.triggerImageGen) {
                window.triggerImageGen(sessionId, messageId);
            } else {
                console.error('[Chat] window.triggerImageGen not available');
                generateBtn.textContent = '✨ Generate Concept Diagram ($0.13)';
                generateBtn.disabled = false;
                generateBtn.style.opacity = '1';
                generateBtn.style.cursor = 'pointer';
            }
        });
        
        conceptWrapper.appendChild(generateBtn);
        return conceptWrapper;
    }

    function renderAssistantResponse(messageElement, assistantMessage) {
        if (!assistantMessage) {
            return;
        }

        if (assistantMessage.specClarificationData) {
            const scoreValue = assistantMessage.specClarificationData.score;
            let scoreClass = 'score-red';
            if (scoreValue >= 90) {
                scoreClass = 'score-green';
            } else if (scoreValue >= 70) {
                scoreClass = 'score-yellow';
            }

            const scoreElement = document.createElement('div');
            scoreElement.className = 'spec-score-container';
            scoreElement.innerHTML = `<span class="spec-score ${scoreClass}">Spec Readiness Score: ${scoreValue}/100</span>`;
            messageElement.appendChild(scoreElement);
        }

        if (assistantMessage.interactiveQuestions && Array.isArray(assistantMessage.interactiveQuestions)) {
            assistantMessage.interactiveQuestions.forEach((question) => {
                if (question.type === 'button') {
                    const buttonElement = document.createElement('button');
                    buttonElement.className = 'interactive-question-button';
                    buttonElement.textContent = question.label;
                    buttonElement.addEventListener('click', async () => {
                        console.log('Chat: Interactive button clicked, sending message:', question.messageToSend);
                        
                        // Display user message first
                        const userMsg = {
                            id: `user-${Date.now()}`,
                            sessionId: chatState.currentSessionId,
                            projectId: chatState.projectSettings?.projectId,
                            type: globalScope?.MessageType?.USER || 'user',
                            role: 'user',
                            content: question.messageToSend,
                            metadata: {}
                        };
                        displayMessage(userMsg);
                        
                        // Save user message to persistence
                        if (chatState.currentSessionId && chatState.projectSettings?.projectId) {
                            try {
                                if (!globalScope?.WebviewApi?.persistence?.saveChatMessage) {
                                    console.warn('[Chat] WebviewApi.persistence.saveChatMessage not available');
                                } else {
                                    await globalScope.WebviewApi.persistence.saveChatMessage({
                                        sessionId: chatState.currentSessionId,
                                        projectId: chatState.projectSettings.projectId,
                                        type: userMsg.type,
                                        content: userMsg.content,
                                        role: userMsg.role,
                                        metadata: userMsg.metadata
                                    });
                                }
                                console.log('Chat: User message persisted successfully');
                            } catch (saveError) {
                                console.warn('Chat: Failed to save message to persistence:', saveError);
                            }
                        }
                        
                        if (globalScope.WebviewApi?.agent?.execute) {
                            try {
                                // Call agent.execute - backend will persist and broadcast the response
                                await globalScope.WebviewApi.agent.execute({
                                    userMessage: userMsg,
                                    session: chatState.currentSession,
                                    message: question.messageToSend
                                });
                                return;
                            } catch (error) {
                                console.error('Chat: Failed to execute agent command', error);
                                
                                // Display the error directly
                                displayMessage({
                                    id: `error-${Date.now()}`,
                                    sessionId: chatState.currentSessionId,
                                    projectId: chatState.projectSettings?.projectId,
                                    type: globalScope?.MessageType?.ERROR || 'error',
                                    role: 'assistant',
                                    content: `Error: ${error instanceof Error ? error.message : 'Unknown error'}`,
                                    metadata: { error }
                                });
                                return;
                            }
                        } else {
                            await sendMessage(question.messageToSend);
                            return;
                        }
                    });
                    messageElement.appendChild(buttonElement);
                }
            });
        }
    }

    // ============ Pinned File Management Functions ============
    
    let pinFileSearchDebounceTimer = null;
    
    function initializePinFileInput() {
        const pinInput = safeGetDocumentElement('pin-file-input');
        const autocompleteDropdown = safeGetDocumentElement('file-autocomplete');
        
        if (!pinInput || !autocompleteDropdown) {
            console.warn('Chat: Pin file input or autocomplete dropdown not found');
            return;
        }
        
        pinInput.addEventListener('input', async (event) => {
            const value = event.target.value;
            
            // Clear previous debounce timer
            if (pinFileSearchDebounceTimer) {
                clearTimeout(pinFileSearchDebounceTimer);
                pinFileSearchDebounceTimer = null;
            }
            
            // Check if user typed @
            if (value.startsWith('@')) {
                const searchTerm = value.substring(1).toLowerCase();
                
                if (!searchTerm) {
                    hideAutocomplete();
                    return;
                }
                
                // Debounce search (250ms delay)
                pinFileSearchDebounceTimer = setTimeout(async () => {
                    try {
                        if (!globalScope?.WebviewApi?.postCommand) {
                            console.warn('[Chat] WebviewApi.postCommand not available');
                            return;
                        }
                        
                        // Phase 1: Instant results from opened files
                        const openFiles = await globalScope.WebviewApi.postCommand('getOpenFiles');
                        const instantResults = (openFiles || []).filter(filePath => {
                            return filePath.toLowerCase().includes(searchTerm);
                        });
                        
                        // Show instant results immediately
                        if (instantResults.length > 0) {
                            displayAutocomplete(instantResults, searchTerm, true); // true = isPartial
                        }
                        
                        // Phase 2: Fetch workspace files in parallel
                        const workspaceResults = await globalScope.WebviewApi.postCommand('searchWorkspaceFiles', {
                            query: searchTerm,
                            pinnedFiles: chatState.pinnedFilePaths
                        });
                        
                        // Merge and deduplicate results
                        const allResults = new Map();
                        
                        // Add workspace results (already ranked)
                        if (Array.isArray(workspaceResults)) {
                            workspaceResults.forEach(filePath => {
                                allResults.set(filePath, filePath);
                            });
                        }
                        
                        // Add instant results if not already present
                        instantResults.forEach(filePath => {
                            if (!allResults.has(filePath)) {
                                allResults.set(filePath, filePath);
                            }
                        });
                        
                        // Convert to array and display
                        const mergedResults = Array.from(allResults.values());
                        displayAutocomplete(mergedResults, searchTerm, false); // false = complete
                        
                    } catch (error) {
                        console.error('Chat: Error searching files:', error);
                        hideAutocomplete();
                    }
                }, 250); // 250ms debounce
            } else {
                hideAutocomplete();
            }
        });
        
        // Hide autocomplete when clicking outside
        document.addEventListener('click', (event) => {
            if (!pinInput.contains(event.target) && !autocompleteDropdown.contains(event.target)) {
                hideAutocomplete();
            }
        });
    }

    function displayAutocomplete(files, searchTerm, isPartial = false) {
        const dropdown = safeGetDocumentElement('file-autocomplete');
        if (!dropdown) return;
        
        if (files.length === 0 && !isPartial) {
            hideAutocomplete();
            return;
        }
        
        dropdown.innerHTML = '';
        
        // Show files
        files.slice(0, 20).forEach(filePath => {
            const item = document.createElement('div');
            item.className = 'autocomplete-item';
            
            const fileName = filePath.split('/').pop();
            const fileDir = filePath.substring(0, filePath.lastIndexOf('/'));
            
            item.innerHTML = `
                <span class="file-name">${escapeHtml(fileName)}</span>
                <span class="file-path">${escapeHtml(fileDir)}</span>
            `;
            
            item.addEventListener('click', () => addPinnedFile(filePath));
            dropdown.appendChild(item);
        });
        
        // Show loading indicator if results are partial
        if (isPartial && files.length > 0) {
            const loadingItem = document.createElement('div');
            loadingItem.className = 'autocomplete-item';
            loadingItem.style.fontStyle = 'italic';
            loadingItem.style.color = 'var(--vscode-descriptionForeground)';
            loadingItem.textContent = 'Searching workspace...';
            dropdown.appendChild(loadingItem);
        }
        
        dropdown.style.display = 'block';
    }

    function hideAutocomplete() {
        const dropdown = safeGetDocumentElement('file-autocomplete');
        if (dropdown) dropdown.style.display = 'none';
    }

    function addPinnedFile(filePath) {
        // Enforce 5-file limit
        if (chatState.pinnedFilePaths.length >= 5) {
            console.warn('Chat: Maximum 5 files can be pinned');
            // TODO: Could show a toast notification here
            return;
        }
        
        // Avoid duplicates
        if (chatState.pinnedFilePaths.includes(filePath)) {
            console.warn('Chat: File already pinned:', filePath);
            return;
        }
        
        chatState.pinnedFilePaths.push(filePath);
        console.log('Chat: Pinned file:', filePath);
        renderPinnedFiles();

        // Persist pinned files to session
        const sessionId = chatState.currentSessionId;
        if (sessionId && globalScope?.WebviewApi?.persistence?.updateSession) {
            globalScope.WebviewApi.persistence.updateSession(sessionId, {
                pinnedFilePaths: chatState.pinnedFilePaths
            }).catch(err => {
                console.error('Chat: Failed to persist pinned file:', err);
            });
        }

        // Clear input
        const pinInput = safeGetDocumentElement('pin-file-input');
        if (pinInput) pinInput.value = '';
        hideAutocomplete();
    }

    function removePinnedFile(filePath) {
        const index = chatState.pinnedFilePaths.indexOf(filePath);
        if (index > -1) {
            chatState.pinnedFilePaths.splice(index, 1);
            console.log('Chat: Unpinned file:', filePath);
            
            // Reset warning flag when pinned files transition from >0 to 0
            if (chatState.pinnedFilePaths.length === 0) {
                chatState.pinnedFileWarningShown = false;
            }

            renderPinnedFiles();

            // Persist pinned files removal to session
            const sessionId = chatState.currentSessionId;
            if (sessionId && globalScope?.WebviewApi?.persistence?.updateSession) {
                globalScope.WebviewApi.persistence.updateSession(sessionId, {
                    pinnedFilePaths: chatState.pinnedFilePaths
                }).catch(err => {
                    console.error('Chat: Failed to persist pinned file removal:', err);
                });
            }
        }
    }

    // Pinned file warning management functions
    function showPinnedFileWarning() {
        const pinnedFilesList = safeGetDocumentElement('pinned-files-list');
        if (!pinnedFilesList) {
            console.warn('Chat: pinned-files-list element not found');
            return;
        }

        // Check if warning already exists
        let warningElement = safeGetDocumentElement('pinned-file-warning');
        if (warningElement) {
            warningElement.style.display = 'block';
            return;
        }

        // Create warning element
        warningElement = document.createElement('div');
        warningElement.id = 'pinned-file-warning';
        warningElement.className = 'pinned-file-warning';
        
        warningElement.innerHTML = `
            <span class="warning-icon">💡</span>
            <span class="warning-text">Tip: Pin relevant files (use @filename) so Samurai can reproduce and find the root cause faster. Your message was not sent.</span>
            <div class="warning-actions">
                <button class="warning-action-btn" id="pin-file-action-btn">Pin a file</button>
                <button class="warning-dismiss-btn" id="dont-remind-btn">Don't remind me</button>
            </div>
        `;

        // Attach event listeners
        const pinFileBtn = warningElement.querySelector('#pin-file-action-btn');
        if (pinFileBtn) {
            pinFileBtn.addEventListener('click', () => {
                const pinInput = safeGetDocumentElement('pin-file-input');
                if (pinInput) {
                    pinInput.value = '@';
                    pinInput.focus();
                    // Trigger input event to show autocomplete
                    const event = new Event('input', { bubbles: true });
                    pinInput.dispatchEvent(event);
                }
            });
        }

        const dontRemindBtn = warningElement.querySelector('#dont-remind-btn');
        if (dontRemindBtn) {
            dontRemindBtn.addEventListener('click', () => {
                dismissPinnedFileWarning();
                hidePinnedFileWarning();
                chatState.pinnedFileWarningShown = true;
            });
        }

        // Insert after pinned-files-list
        if (pinnedFilesList.parentNode) {
            pinnedFilesList.parentNode.insertBefore(warningElement, pinnedFilesList.nextSibling);
        } else {
            pinnedFilesList.appendChild(warningElement);
        }
    }

    function hidePinnedFileWarning() {
        const warningElement = safeGetDocumentElement('pinned-file-warning');
        if (warningElement) {
            warningElement.style.display = 'none';
        }
    }

    function renderPinnedFileWarning() {
        // DISABLED: Pinned file warning rendering (too disturbing - can be re-enabled in future)
        return;
        
        const shouldShow = 
            chatState.pinnedFilePaths.length === 0 &&
            !isPinnedFileWarningDismissed() &&
            !chatState.pinnedFileWarningShown;

        if (shouldShow) {
            showPinnedFileWarning();
        } else {
            hidePinnedFileWarning();
        }
    }

    function renderPinnedFiles() {
        const container = safeGetDocumentElement('pinned-files-list');
        const countDisplay = safeGetDocumentElement('pinned-files-count');
        
        if (!container) {
            console.warn('Chat: Pinned files list container not found');
            return;
        }
        
        container.innerHTML = '';
        
        chatState.pinnedFilePaths.forEach(filePath => {
            const chip = document.createElement('div');
            chip.className = 'pinned-file-chip';
            
            const fileName = filePath.split('/').pop();
            chip.innerHTML = `
                <span class="chip-name">${escapeHtml(fileName)}</span>
                <button class="chip-remove" data-path="${escapeHtml(filePath)}">&times;</button>
            `;
            
            const removeButton = chip.querySelector('.chip-remove');
            if (removeButton) {
                removeButton.addEventListener('click', (e) => {
                    const path = e.target.getAttribute('data-path');
                    if (path) removePinnedFile(path);
                });
            }
            
            container.appendChild(chip);
        });
        
        // Update count display
        if (countDisplay) {
            countDisplay.textContent = `${chatState.pinnedFilePaths.length}/5`;
        }
        
        // Render warning based on current state
        renderPinnedFileWarning();
    }

    // Documentation URL functions
    let documentationUrlDebounceTimer = null;

    function initializeDocumentationUrlInput() {
        const urlInput = safeGetDocumentElement('documentation-url-input');
        const refreshBtn = safeGetDocumentElement('documentation-refresh-btn');
        const removeBtn = safeGetDocumentElement('documentation-remove-btn');
        
        if (!urlInput) {
            console.warn('Chat: Documentation URL input not found');
            return;
        }

        // Restore URL from state if available
        if (chatState.documentationUrl) {
            urlInput.value = chatState.documentationUrl;
            renderDocumentationPreview();
        }

        // Debounced input handler (500ms delay)
        urlInput.addEventListener('input', () => {
            const url = urlInput.value.trim();
            chatState.documentationUrl = url;
            chatState.documentationError = null;
            
            // Clear previous debounce timer
            if (documentationUrlDebounceTimer) {
                clearTimeout(documentationUrlDebounceTimer);
            }
            
            // Hide preview and error when URL changes
            hideDocumentationPreview();
            hideDocumentationError();
            
            // Only fetch if URL is valid and user stops typing
            if (url && isValidUrl(url)) {
                documentationUrlDebounceTimer = setTimeout(() => {
                    void fetchDocumentationUrl(url, false);
                }, 500);
            }
        });

        // Refresh button handler
        if (refreshBtn) {
            refreshBtn.addEventListener('click', () => {
                const url = urlInput.value.trim();
                if (url && isValidUrl(url)) {
                    void fetchDocumentationUrl(url, true);
                }
            });
        }

        // Remove button handler
        if (removeBtn) {
            removeBtn.addEventListener('click', () => {
                removeDocumentationUrl();
            });
        }
    }

    function isValidUrl(urlString) {
        try {
            const url = new URL(urlString);
            return url.protocol === 'http:' || url.protocol === 'https:';
        } catch {
            return false;
        }
    }

    function extractDomain(urlString) {
        try {
            const url = new URL(urlString);
            return url.hostname;
        } catch {
            return '';
        }
    }

    async function fetchDocumentationUrl(url, forceRefresh = false) {
        if (!url || !url.trim()) {
            return;
        }

        chatState.documentationLoading = true;
        chatState.documentationError = null;
        showDocumentationLoading();
        hideDocumentationError();
        hideDocumentationPreview();

        try {
            if (!globalScope?.WebviewApi?.postCommand) {
                throw new Error('WebviewApi.postCommand not available');
            }

            // Send fetch request to extension
            const response = await globalScope.WebviewApi.postCommand('fetchDocumentationUrl', {
                url: url,
                forceRefresh: forceRefresh,
                sessionId: chatState.currentSessionId
            });

            if (response && response.success !== false && !response.error) {
                const payload = response.payload || response;
                chatState.documentationCache = {
                    title: payload.title || 'Untitled',
                    preview: payload.preview || '',
                    fetchedAt: payload.fetchedAt 
                        ? new Date(payload.fetchedAt) 
                        : new Date()
                };
                renderDocumentationPreview();
            } else {
                throw new Error(response?.error || 'Failed to fetch documentation');
            }
        } catch (error) {
            console.error('Chat: Error fetching documentation:', error);
            const errorMessage = error.message || error.error || 'Failed to fetch documentation';
            chatState.documentationError = errorMessage;
            showDocumentationError(errorMessage);
        } finally {
            chatState.documentationLoading = false;
            hideDocumentationLoading();
        }
    }

    function removeDocumentationUrl() {
        chatState.documentationUrl = '';
        chatState.documentationCache = { title: '', preview: '', fetchedAt: null };
        chatState.documentationError = null;
        
        const urlInput = safeGetDocumentElement('documentation-url-input');
        if (urlInput) {
            urlInput.value = '';
        }
        
        hideDocumentationPreview();
        hideDocumentationError();
        hideDocumentationLoading();
        
        const refreshBtn = safeGetDocumentElement('documentation-refresh-btn');
        if (refreshBtn) {
            refreshBtn.style.display = 'none';
        }
    }

    function renderDocumentationPreview() {
        const preview = safeGetDocumentElement('documentation-preview');
        const domainBadge = safeGetDocumentElement('documentation-domain-badge');
        const title = safeGetDocumentElement('documentation-title');
        const previewText = safeGetDocumentElement('documentation-preview-text');
        const meta = safeGetDocumentElement('documentation-meta');
        const refreshBtn = safeGetDocumentElement('documentation-refresh-btn');

        if (!preview || !chatState.documentationCache.title) {
            return;
        }

        const url = chatState.documentationUrl;
        const domain = extractDomain(url);
        const cache = chatState.documentationCache;

        if (domainBadge) {
            domainBadge.textContent = domain;
        }
        if (title) {
            title.textContent = cache.title;
        }
        if (previewText) {
            const previewContent = cache.preview || '';
            previewText.textContent = previewContent.length > 300 
                ? previewContent.substring(0, 300) + '...' 
                : previewContent;
        }
        if (meta && cache.fetchedAt) {
            const fetchedDate = new Date(cache.fetchedAt);
            meta.textContent = `Last fetched: ${fetchedDate.toLocaleString()}`;
        }
        if (refreshBtn) {
            refreshBtn.style.display = 'block';
        }

        preview.style.display = 'block';
    }

    function hideDocumentationPreview() {
        const preview = safeGetDocumentElement('documentation-preview');
        if (preview) {
            preview.style.display = 'none';
        }
    }

    function showDocumentationLoading() {
        const loading = safeGetDocumentElement('documentation-loading');
        if (loading) {
            loading.style.display = 'block';
        }
    }

    function hideDocumentationLoading() {
        const loading = safeGetDocumentElement('documentation-loading');
        if (loading) {
            loading.style.display = 'none';
        }
    }

    function showDocumentationError(message) {
        const error = safeGetDocumentElement('documentation-error');
        if (error) {
            error.textContent = message;
            error.style.display = 'block';
        }
    }

    function hideDocumentationError() {
        const error = safeGetDocumentElement('documentation-error');
        if (error) {
            error.style.display = 'none';
        }
    }

    function initializeChat() {
        console.log('Chat: Initializing chat functionality...');

        if (typeof document === 'undefined') {
            return;
        }

        // Global Click Handler for "Click-to-Open" file paths in inline code
        document.addEventListener('click', async (e) => {
            const target = e.target;
            
            // Check if the user clicked on an inline code block (<code>...</code>)
            // that is NOT inside a big preformatted block (<pre><code>...</code>)
            if (target.tagName === 'CODE' && target.parentElement.tagName !== 'PRE') {
                const text = target.textContent.trim();
                
                // Simple heuristic: Does it look like a file path?
                // Checks for: extension (.ts, .js, .json) OR forward slashes (src/...)
                const isFilePath = /\.[a-zA-Z0-9]+$/.test(text) || text.includes('/');
                
                // Filter out common noise like "git-history" or "npm install"
                const isNoise = text.includes(' ') || text.startsWith('-');

                // Variable name heuristic: valid identifier, no spaces or path chars
                const isIdentifier = /^[A-Za-z_$][\w$]*$/.test(text);

                const addClickFeedback = () => {
                    // Visual feedback
                    target.style.opacity = '0.5';
                    setTimeout(() => target.style.opacity = '1', 200);
                };

                if (isFilePath && !isNoise) {
                    addClickFeedback();

                    // Send message to Backend
                    if (globalScope?.WebviewApi?.postCommand) {
                        try {
                            await globalScope.WebviewApi.postCommand('openFile', { filePath: text });
                            return; // File navigation succeeded; don't fall back
                        } catch (error) {
                            console.warn('[Chat] Failed to open file, falling back to variable search if applicable:', error);
                            // Fall through to variable handling
                        }
                    } else {
                        console.warn('[Chat] WebviewApi.postCommand not available for opening file');
                    }
                }

                // Fallback: variable navigation in active file
                if (!isNoise && isIdentifier) {
                    addClickFeedback();
                    if (globalScope?.WebviewApi?.postCommand) {
                        try {
                            await globalScope.WebviewApi.postCommand('findVariableInActiveFile', { variableName: text });
                        } catch (error) {
                            console.warn('[Chat] Failed to navigate to variable:', error);
                        }
                    } else {
                        console.warn('[Chat] WebviewApi.postCommand not available for variable navigation');
                    }
                }
            }
        });

        const start = () => {
            let chatInput = safeGetDocumentElement('chatInput');
            const chatMessages = safeGetDocumentElement('chatMessages');
            const startNewConversationBtn = safeGetDocumentElement('start-new-conversation-btn');
            const settingsBtn = safeGetDocumentElement('settings-btn');
            const llmModelSelect = safeGetDocumentElement('llm-model-select');

            initializeMessageListener(chatMessages);

            // Initialize session switcher
            const sessionTitleBtn = safeGetDocumentElement('session-title-btn');
            if (sessionTitleBtn) {
                sessionTitleBtn.addEventListener('click', (e) => {
                    e.stopPropagation();
                    toggleSessionDropdown();
                });
            }
            // Close dropdown on outside click
            document.addEventListener('click', (e) => {
                const dropdown = safeGetDocumentElement('session-dropdown');
                const titleBtn = safeGetDocumentElement('session-title-btn');
                if (dropdown && dropdown.style.display !== 'none') {
                    if (!dropdown.contains(e.target) && e.target !== titleBtn && !titleBtn?.contains(e.target)) {
                        closeSessionDropdown();
                    }
                }
            });

            // Initialize pinned file input
            initializePinFileInput();
            
            // Initialize documentation URL input
            initializeDocumentationUrlInput();
            
            // Initialize cost display with monthly cost
            updateApiCostDisplay(0);

            if (chatInput && chatInput.tagName?.toLowerCase() === 'input') {
                const textArea = document.createElement('textarea');
                textArea.id = chatInput.id;
                textArea.className = chatInput.className || '';
                textArea.placeholder = getRandomPlaceholder();
                textArea.value = chatInput.value || '';
                textArea.rows = 3;
                textArea.style.resize = 'vertical';
                chatInput.replaceWith(textArea);
                chatInput = textArea;

                injectChatInputStyles();
            }

            if (chatInput) {
                // Set random placeholder if not already set (e.g., if element was already a textarea)
                if (!chatInput.placeholder || chatInput.placeholder === 'Type your message here...') {
                    chatInput.placeholder = getRandomPlaceholder();
                }
                chatInput.addEventListener('keydown', event => {
                    if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
                        // Only prevent default and send on Enter without Shift
                        event.preventDefault();
                        const message = chatInput.value.trim();
                        if (message) {
                            // Don't hide context panel - keep it open for user convenience
                            void sendMessage(message);
                        }
                    }
                    // Shift+Enter: do nothing, let the browser insert a newline naturally
                });
                chatInput.focus();
            }

            // Add Run Analysis button event listener
            const runAnalysisBtn = safeGetDocumentElement('run-analysis-btn');
            if (runAnalysisBtn) {
                runAnalysisBtn.addEventListener('click', () => {
                    const chatInput = safeGetDocumentElement('chatInput');
                    if (chatInput) {
                        const message = chatInput.value.trim();
                        if (message) {
                            // Don't hide context panel - keep it open for user convenience
                            void sendMessage(message);
                        }
                    }
                });
            }

            // Add log input event listeners
            const addContextBtn = safeGetDocumentElement('addContextBtn');
            const hideContextBtn = safeGetDocumentElement('hideContextBtn');
            const contextPanel = safeGetDocumentElement('contextPanel');
            const clearLogBtn = safeGetDocumentElement('clearLogBtn');
            const logInput = safeGetDocumentElement('logInput');

            console.log('Chat: Context button elements found:', {
                addContextBtn: !!addContextBtn,
                hideContextBtn: !!hideContextBtn,
                contextPanel: !!contextPanel,
                clearLogBtn: !!clearLogBtn,
                logInput: !!logInput
            });

            if (addContextBtn) {
                console.log('Chat: Adding click listener to Add Context button');
                addContextBtn.addEventListener('click', () => {
                    console.log('Chat: Add Context button clicked');
                    showContextPanel();
                });
            } else {
                console.warn('Chat: Add Context button not found!');
            }

            if (hideContextBtn) {
                hideContextBtn.addEventListener('click', () => {
                    console.log('Chat: Hide Context button clicked');
                    hideContextPanel();
                });
            }

            if (clearLogBtn) {
                clearLogBtn.addEventListener('click', () => {
                    clearLogInput();
                });
            }

            if (logInput) {
                logInput.addEventListener('input', () => {
                    updateLogContent();
                });
            }
            
            // Show context panel if there's existing content (log or documentation URL)
            if (contextPanel) {
                const hasLogContent = logInput && logInput.value.trim();
                const hasDocUrl = chatState.documentationUrl && chatState.documentationUrl.trim();
                if (hasLogContent || hasDocUrl) {
                    contextPanel.style.display = 'flex';
                }
            }

            if (startNewConversationBtn) {
                 startNewConversationBtn.addEventListener('click', async () => {
                    console.log('Chat: Start New Conversation button clicked');
                    if (!globalScope?.WebviewApi || !chatState.projectSettings) {
                        console.warn('Chat: Missing WebviewApi or projectSettings - cannot start new conversation');
                        return;
                    }

                    // Bug fix: If analysis is running, confirm before discarding
                    if (chatState.isBusy) {
                        const confirmed = confirm('The agent is currently running. Starting a new conversation will stop the current analysis. Continue?');
                        if (!confirmed) {
                            return;
                        }
                    }

                    // Bug fix: Reset busy state so input is re-enabled for the new conversation
                    setBusyState(false);

                    // Bug fix: Abort the running agent for the old session to stop wasting LLM tokens
                    if (chatState.currentSessionId && globalScope?.WebviewApi?.postCommand) {
                        try {
                            await globalScope.WebviewApi.postCommand('samurai-agent.abortSession', {
                                sessionId: chatState.currentSessionId
                            });
                            console.log('Chat: Aborted old session', { sessionId: chatState.currentSessionId });
                        } catch (e) {
                            console.warn('Chat: Failed to abort old session (non-blocking)', e);
                        }
                    }

                    if (chatMessages) {
                        console.log('Chat: Clearing chat messages for new conversation');
                        chatMessages.innerHTML = '';
                        chatState.messagesLoaded = false; // Reset the flag since we cleared messages
                        // Clear tracking Sets when starting new conversation
                        chatState.displayedMessageIds.clear();
                        chatState.savedMessageIds.clear();
                    }
                    if (chatInput) {
                        chatInput.value = '';
                        console.log('Chat: Chat input cleared and focus requested');
                        chatInput.focus();
                    }

                    // Clear pinned files for new conversation
                    chatState.pinnedFilePaths = [];
                    // Reset warning flag for new conversation
                    chatState.pinnedFileWarningShown = false;
                    renderPinnedFiles();
                    console.log('Chat: Pinned files cleared for new conversation');

                    try {
                        // Clean sandbox before starting a fresh conversation
                        if (globalScope?.WebviewApi?.postCommand) {
                            try {
                                await globalScope.WebviewApi.postCommand('samurai-agent.cleanSandbox');
                                console.log('Chat: Sandbox cleaned for new conversation');
                            } catch (cleanupError) {
                                console.warn('Chat: Sandbox cleanup failed (non-blocking)', cleanupError);
                            }
                        } else {
                            console.warn('[Chat] WebviewApi.postCommand not available for sandbox cleanup');
                        }

                        console.log('Chat: Loading previous messages for context build', {
                            currentSessionId: chatState.currentSessionId,
                        });
                        // Load current chat messages before creating new session
                        let previousMessages = [];
                        if (chatState.currentSessionId) {
                            try {
                                if (!globalScope?.WebviewApi?.persistence?.loadChatMessagesForSession) {
                                    console.warn('[Chat] WebviewApi.persistence.loadChatMessagesForSession not available');
                                    previousMessages = [];
                                } else {
                                    previousMessages = await globalScope.WebviewApi.persistence.loadChatMessagesForSession(chatState.currentSessionId);
                                }
                                console.log('Chat: Loaded previous messages', {
                                    count: Array.isArray(previousMessages) ? previousMessages.length : 0,
                                });
                            } catch (error) {
                                console.warn('Chat: Could not load previous session messages', error);
                            }
                        }

                        // Create new session
                        console.log('Chat: Creating new session for conversation');
                        const newSessionId = await createAndPersistSession('New Conversation');
                        console.log('Chat: New session created', { newSessionId });
                        if (newSessionId) {
                            if (!globalScope?.WebviewApi?.persistence?.loadChatMessagesForSession) {
                                console.warn('[Chat] WebviewApi.persistence.loadChatMessagesForSession not available');
                            } else {
                                const messages = await globalScope.WebviewApi.persistence.loadChatMessagesForSession(newSessionId);
                                if (Array.isArray(messages)) {
                                    console.log('Chat: Rendering messages from new session', {
                                        count: messages.length,
                                    });
                                    messages.forEach(displayMessage);
                                    // Show welcome message if no messages were loaded
                                    if (messages.length === 0) {
                                        showWelcomeMessage();
                                    }
                                } else {
                                    // No messages - show welcome message
                                    showWelcomeMessage();
                                }
                            }
                        } else {
                            // No session created - show welcome message
                            showWelcomeMessage();
                        }

                        // Build conversation context from previous messages
                        let conversationContext = '';
                        if (Array.isArray(previousMessages) && previousMessages.length > 0) {
                            console.log('Chat: Building conversation context from previous messages');
                            conversationContext = previousMessages
                                .map(msg => `${msg.role === 'user' ? 'User' : 'Assistant'}: ${msg.content}`)
                                .join('\n\n');
                        }

                        // Get project details
                        const settingsState = globalScope?.SettingsManager?.getSettings?.();
                        let rawProjectDetailContent = settingsState?.projectSettings?.rawProjectDetailContent || chatState.projectSettings?.rawProjectDetailContent || '';
                        console.log('Chat: Retrieved project detail content', {
                            hasSettingsState: !!settingsState,
                            rawProjectDetailLength: rawProjectDetailContent?.length || 0,
                        });
                        
                        // If no explicit project detail, use a default description
                        if (!rawProjectDetailContent.trim()) {
                            console.log('Chat: No explicit project detail found. Using default context.');
                            rawProjectDetailContent = 'A software development project with an AI coding assistant.';
                        }

                        // Combine project details with conversation context
                        let ingestContent = rawProjectDetailContent;
                        if (conversationContext) {
                            console.log('Chat: Appending conversation context to project detail');
                            ingestContent = `${rawProjectDetailContent}\n\n## Previous Conversation Context:\n${conversationContext}`;
                        }

                        // Gate ingestion to avoid unnecessary LLM costs during debugging
                        const ENABLE_INGEST_ON_NEW_CONVERSATION = false;
                        if (ENABLE_INGEST_ON_NEW_CONVERSATION) {
                            // Always ingest - either project details, conversation history, or both
                            console.log('Chat: Ingesting project context and conversation history');
                            if (!globalScope?.WebviewApi?.projectDetail?.ingest) {
                                console.warn('[Chat] WebviewApi.projectDetail.ingest not available');
                            } else {
                                globalScope.WebviewApi.projectDetail.ingest({
                                    projectId: chatState.projectSettings.projectId,
                                    rawText: ingestContent,
                                    mode: 'merge'
                                }).then(() => {
                                    console.log('Chat: Successfully ingested project context');
                                    // Refresh cost display after project detail ingestion
                                    updateApiCostDisplay(0);
                                }).catch(error => {
                                    console.error('Chat: Failed to merge project detail memory', error);
                                });
                            }
                        }
                    } catch (error) {
                        console.error('Chat: Failed to start new conversation', error);
                    }
                });
            }

            if (settingsBtn) {
                settingsBtn.addEventListener('click', () => {
                    console.log('Chat: Settings button clicked');
                    // Switch to settings tab using the agentPanel function
                    if (window.SamuraiAgentPanel && typeof window.SamuraiAgentPanel.switchTab === 'function') {
                        window.SamuraiAgentPanel.switchTab('setting');
                    } else if (window.WebviewApi && typeof window.WebviewApi.switchTab === 'function') {
                        window.WebviewApi.switchTab('setting');
                    } else {
                        // Fallback: manually switch tabs
                        const settingContent = document.getElementById('setting-content');
                        const chatContent = document.getElementById('chat-content');
                        if (settingContent && chatContent) {
                            chatContent.style.display = 'none';
                            settingContent.style.display = 'flex';
                            // Initialize settings if needed
                            if (window.SettingsManager && typeof window.SettingsManager.renderSettings === 'function') {
                                setTimeout(() => window.SettingsManager.renderSettings(), 100);
                            }
                        }
                    }
                });
            }

            if (llmModelSelect) {
                llmModelSelect.addEventListener('change', function onChange() {
                    handleLLMModelChange(this.value);
                });
            }

            const modeSelect = safeGetDocumentElement('mode-select');
            if (modeSelect) {
                modeSelect.addEventListener('change', function onChange() {
                    handleModeChange(this.value);
                });
            }

            const chatTab = safeGetDocumentElement('chat-tab');
            if (chatTab) {
                chatTab.addEventListener('click', async () => {
                    await refreshLLMModelDropdown();
                });
            }

            setTimeout(async () => {
                if (!chatState.availableModels || chatState.availableModels.length === 0) {
                    console.log('Chat: Fallback - refreshing LLM model dropdown after timeout');
                    await refreshLLMModelDropdown();
                }
            }, 2000);

            // Additional fallback: Check if we need to refresh state periodically
            // This helps in case the visibility change handler doesn't fire
            setInterval(() => {
                if (chatState.projectSettings && (!chatState.availableModels || chatState.availableModels.length === 0)) {
                    console.log('Chat: Periodic check - refreshing LLM model dropdown');
                    void refreshLLMModelDropdown();
                }
            }, 10000); // Check every 10 seconds
        };

        // Check if document is already loaded to avoid race condition
        if (document.readyState === 'loading') {
            document.addEventListener('DOMContentLoaded', start);
        } else {
            // Document already ready, run immediately
            start();
        }
    }

    function handleInitialSettings(payload) {
        if (!payload) {
            return;
        }

        console.log('Chat: handleInitialSettings called with payload:', {
            hasGlobalSettings: !!payload.globalSettings,
            hasProjectSettings: !!payload.projectSettings,
            availableModelsCount: payload.availableModels?.length || 0
        });

        chatState.globalSettings = payload.globalSettings;
        window._globalSettings = payload.globalSettings;
        chatState.projectSettings = payload.projectSettings;
        chatState.availableModels = payload.availableModels || [];

        populateLLMModelDropdown();

        const primaryModel = chatState.projectSettings?.primaryLLMModel;
        const llmModelSelect = safeGetDocumentElement('llm-model-select');
        if (primaryModel && llmModelSelect) {
            llmModelSelect.value = primaryModel;
        }

        const defaultMode = chatState.projectSettings?.defaultMode;
        const modeSelect = safeGetDocumentElement('mode-select');
        if (defaultMode && modeSelect) {
            modeSelect.value = defaultMode;
        }

        // Update Show Current Spec button visibility based on mode
        updateShowCodeVisualsButton();

        void initializeChatSession().then(() => {
            // Replay any queued createCodeReviewSession that arrived before settings
            if (pendingCodeReviewSession) {
                const { content, pinnedFiles } = pendingCodeReviewSession;
                pendingCodeReviewSession = null;
                createCodeReviewSession(content, pinnedFiles);
            }
        });

        // Show welcome message if no workspace (projectSettings is null)
        // This ensures the welcome message appears even when initializeChatSession() returns early
        if (!chatState.projectSettings) {
            showWelcomeMessage();
        }

        // Restore busy state after tab switch (backend reported session still running)
        if (payload.isBusy === true) {
            setBusyState(true);
            showProgressIndicator({ stage: 'Resuming analysis...' });
        }
    }

    function populateLLMModelDropdown() {
        const llmModelSelect = safeGetDocumentElement('llm-model-select');
        if (!llmModelSelect || !Array.isArray(chatState.availableModels)) {
            return;
        }

        llmModelSelect.innerHTML = '';

        chatState.availableModels.forEach(model => {
            const option = document.createElement('option');
            option.value = model.id;
            option.textContent = model.name;
            llmModelSelect.appendChild(option);
        });

        if (chatState.availableModels.length === 0) {
            const option = document.createElement('option');
            option.value = '';
            option.textContent = 'No models yet - add a model and API key in Settings';
            option.disabled = true;
            llmModelSelect.appendChild(option);
        }
    }

    async function handleLLMModelChange(selectedModelId) {
        if (!selectedModelId || !chatState.projectSettings || !globalScope?.WebviewApi) {
            return;
        }

        try {
            const updatedProjectSettings = {
                ...chatState.projectSettings,
                primaryLLMModel: selectedModelId
            };

            if (!globalScope?.WebviewApi?.persistence?.saveProjectSettings) {
                console.warn('[Chat] WebviewApi.persistence.saveProjectSettings not available');
            } else {
                await globalScope.WebviewApi.persistence.saveProjectSettings(updatedProjectSettings);
            }
            chatState.projectSettings = updatedProjectSettings;
            await syncSessionModelSelection(selectedModelId);
            console.log('LLM model changed to:', selectedModelId);
        } catch (error) {
            console.error('Error saving LLM model selection:', error);
        }
    }

    async function syncSessionModelSelection(selectedModelId) {
        if (!selectedModelId) {
            return;
        }

        const sessionId = chatState.currentSessionId;
        if (!sessionId) {
            return;
        }

        const currentMetadata = chatState.currentSession?.metadata || {};
        const updatedMetadata = {
            ...currentMetadata,
            model: selectedModelId
        };

        if (!globalScope?.WebviewApi?.persistence?.updateSession) {
            console.warn('[Chat] WebviewApi.persistence.updateSession not available - recreating session with updated model');
            await recreateSessionWithUpdatedModel();
            return;
        }

        try {
            await globalScope.WebviewApi.persistence.updateSession(sessionId, {
                metadata: updatedMetadata
            });
            if (chatState.currentSession) {
                chatState.currentSession = {
                    ...chatState.currentSession,
                    metadata: updatedMetadata
                };
            }
        } catch (error) {
            console.error('Error updating session with new LLM model:', error);
            await recreateSessionWithUpdatedModel();
        }
    }

    async function recreateSessionWithUpdatedModel() {
        if (!globalScope?.WebviewApi) {
            return;
        }

        // Clear cached session state so initializeChatSession creates a new session
        chatState.currentSessionId = null;
        chatState.currentSession = null;

        try {
            await initializeChatSession();
        } catch (error) {
            console.error('Error recreating session after LLM model change:', error);
        }
    }

    async function handleModeChange(selectedMode) {
        if (!selectedMode || !chatState.projectSettings || !globalScope?.WebviewApi) {
            return;
        }

        try {
            const updatedProjectSettings = {
                ...chatState.projectSettings,
                defaultMode: selectedMode
            };

            if (!globalScope?.WebviewApi?.persistence?.saveProjectSettings) {
                console.warn('[Chat] WebviewApi.persistence.saveProjectSettings not available');
            } else {
                await globalScope.WebviewApi.persistence.saveProjectSettings(updatedProjectSettings);
            }
            chatState.projectSettings = updatedProjectSettings;
            console.log('Mode changed to:', selectedMode);
            
            // Update button visibility based on new mode
            updateShowCodeVisualsButton();
        } catch (error) {
            console.error('Error saving mode selection:', error);
        }
    }

    async function refreshLLMModelDropdown() {
        if (!globalScope?.WebviewApi) {
            return;
        }

        try {
            // Load both global and project settings to ensure we have latest data
            if (!globalScope?.WebviewApi?.persistence?.loadGlobalSettings || !globalScope?.WebviewApi?.persistence?.loadProjectSettings) {
                console.warn('[Chat] WebviewApi.persistence not available for loading settings');
                return;
            }
            const globalSettings = await globalScope.WebviewApi.persistence.loadGlobalSettings();
            const projectSettings = await globalScope.WebviewApi.persistence.loadProjectSettings();
            
            if (!globalSettings) {
                return;
            }

            chatState.globalSettings = globalSettings;
            
            // Update project settings if we got fresh data
            if (projectSettings) {
                chatState.projectSettings = projectSettings;
            }

            // Available models are the user's BYOK entries only (no built-in catalog)
            chatState.availableModels = (globalSettings.llmEntries || []).map(entry => ({
                id: entry.id,
                name: entry.label || entry.modelName,
                provider: entry.provider
            }));

            populateLLMModelDropdown();

            const llmModelSelect = safeGetDocumentElement('llm-model-select');
            const currentSelection = chatState.projectSettings?.primaryLLMModel;
            
            if (currentSelection && !chatState.availableModels.some(model => model.id === currentSelection)) {
                // Current selection is no longer available, select first available model
                if (chatState.availableModels.length > 0) {
                    const newSelection = chatState.availableModels[0].id;
                    if (llmModelSelect) {
                        llmModelSelect.value = newSelection;
                    }
                    chatState.projectSettings = {
                        ...(chatState.projectSettings || {}),
                        primaryLLMModel: newSelection
                    };
                    if (!globalScope?.WebviewApi?.persistence?.saveProjectSettings) {
                        console.warn('[Chat] WebviewApi.persistence.saveProjectSettings not available');
                    } else {
                        await globalScope.WebviewApi.persistence.saveProjectSettings(chatState.projectSettings);
                    }
                }
            } else if (currentSelection && llmModelSelect) {
                // Current selection is still available, restore it in the dropdown
                llmModelSelect.value = currentSelection;
            } else if (!currentSelection && chatState.availableModels.length > 0 && llmModelSelect) {
                // No current selection, select first available model
                llmModelSelect.value = chatState.availableModels[0].id;
            }
        } catch (error) {
            console.error('Error refreshing LLM model dropdown:', error);
        }
    }

    function initializeMessageListener(chatMessagesElement) {
        if (chatState.listenersInitialized) {
            console.log('Chat: Message listeners already initialized, skipping');
            return;
        }
        chatState.listenersInitialized = true;

        const listeners = new Set();

        const dispatchNotification = async (type, payload) => {
            if (type === 'initialSettings' && payload) {
                console.log('Chat: Received initialSettings notification, re-initializing state');
                handleInitialSettings(payload);
                
                // Handle workspace state from initial settings
                if (payload.hasWorkspace === false) {
                    // No workspace, show banner
                    // showWorkspaceBanner() will create welcome message if it doesn't exist
                    showWorkspaceBanner();
                } else {
                    // Workspace is available, hide banner
                    hideWorkspaceBanner();
                }
                
                chatMessagesElement?.dispatchEvent(new CustomEvent('chat-initialized'));
                return;
            }

            if (type === 'globalSettingsUpdated') {
                console.log('Chat: Received globalSettingsUpdated notification, updating LLM models');
                
                // If backend provided updated availableModels, use them directly
                if (payload?.availableModels) {
                    console.log('Chat: Using availableModels from backend:', {
                        modelCount: payload.availableModels.length,
                        modelIds: payload.availableModels.map(m => m.id)
                    });
                    
                    // Update chat state with new settings and models
                    if (payload.globalSettings) {
                        chatState.globalSettings = payload.globalSettings;
                    }
                    chatState.availableModels = payload.availableModels;
                    
                    // Repopulate dropdown
                    populateLLMModelDropdown();
                    
                    // Ensure current selection is still valid
                    const llmModelSelect = safeGetDocumentElement('llm-model-select');
                    const currentSelection = chatState.projectSettings?.primaryLLMModel;
                    
                    if (currentSelection && !chatState.availableModels.some(model => model.id === currentSelection)) {
                        // Current selection is no longer available, select first available model
                        if (chatState.availableModels.length > 0 && llmModelSelect) {
                            const newSelection = chatState.availableModels[0].id;
                            llmModelSelect.value = newSelection;
                            chatState.projectSettings = {
                                ...(chatState.projectSettings || {}),
                                primaryLLMModel: newSelection
                            };
                            if (globalScope?.WebviewApi?.persistence?.saveProjectSettings) {
                                await globalScope.WebviewApi.persistence.saveProjectSettings(chatState.projectSettings);
                            } else {
                                console.warn('[Chat] WebviewApi.persistence.saveProjectSettings not available');
                            }
                        }
                    } else if (currentSelection && llmModelSelect) {
                        // Restore current selection
                        llmModelSelect.value = currentSelection;
                    }

                } else {
                    // Fallback to refreshing if backend didn't provide availableModels
                    await refreshLLMModelDropdown();
                }
                
                chatMessagesElement?.dispatchEvent(new CustomEvent('chat-settings-updated'));
            }

            if (type === 'webviewRefresh') {
                console.log('Chat: Received webviewRefresh notification, refreshing webview state');
                // Call the refresh function if it's available
                if (globalScope.ChatManager?.refreshWebviewState) {
                    globalScope.ChatManager.refreshWebviewState();
                }
                chatMessagesElement?.dispatchEvent(new CustomEvent('webview-refreshed'));
            }

            if (type === 'workspaceStateChanged' && payload) {
                console.log('Chat: Received workspaceStateChanged notification, hasWorkspace:', payload.hasWorkspace);
                if (payload.hasWorkspace) {
                    // Workspace is now available, hide the banner
                    hideWorkspaceBanner();
                } else {
                    // Workspace was removed, show the banner
                    // showWorkspaceBanner() will create welcome message if it doesn't exist
                    showWorkspaceBanner();
                }
            }
        };

        const onMessage = async message => {
            if (!message || typeof message !== 'object') {
                return;
            }

            // Handle pinFile message from extension
            if (message.type === 'pinFile' && message.filePath) {
                console.log('Chat: Received pinFile message:', message.filePath);
                addPinnedFile(message.filePath);
                return;
            }

            // Handle createCodeReviewSession message from extension
            if (message.type === 'createCodeReviewSession') {
                console.log('Chat: Received createCodeReviewSession message');
                createCodeReviewSession(message.content, message.pinnedFiles);
                return;
            }

            // Handle prefilled regression review message
            if (message.type === 'prefillRegressionReview' && message.content) {
                console.log('Chat: Received regression review prefill');
                const chatInput = safeGetDocumentElement('chatInput');
                if (chatInput) {
                    chatInput.value = message.content;
                    chatInput.style.height = 'auto';
                    chatInput.style.height = Math.min(chatInput.scrollHeight, 300) + 'px';
                }
                return;
            }

            if (message.type === 'success' && message.requestId) {
                // Clear any active loading dots animation
                if (loadingDotsIntervalId !== null) {
                    clearInterval(loadingDotsIntervalId);
                    loadingDotsIntervalId = null;
                }
                
                // Hide progress banner if it exists
                const banner = document.getElementById('agent-progress-banner');
                if (banner && banner.parentNode) {
                    banner.parentNode.removeChild(banner);
                }
                
                const payload = message.payload || {};

                // THE FIX: Do NOT call displayMessage or saveChatMessage here.
                // The 'success' message is just an acknowledgment from the backend.
                // Agent responses are delivered via 'debugSessionFinished' event.
                // Only update UI state (like cost) here.

                // If this is a workspace-related success (e.g., folder opened), hide the workspace banner
                if (payload.workspaceOpened === true) {
                    hideWorkspaceBanner();
                }

                // Update cost display if cost is present in the payload
                if (payload?.cost !== undefined && typeof payload.cost === 'number') {
                    console.log('[COST DEBUG] Updating cost display from success message:', payload.cost);
                    updateApiCostDisplay(payload.cost);
                } else if (payload?.metadata?.cost !== undefined && typeof payload.metadata.cost === 'number') {
                    console.log('[COST DEBUG] Updating cost display from success message metadata:', payload.metadata.cost);
                    updateApiCostDisplay(payload.metadata.cost);
                }

                return;
            }

            if (message.type === 'error' && message.requestId) {
                // Clear any active loading dots animation
                if (loadingDotsIntervalId !== null) {
                    clearInterval(loadingDotsIntervalId);
                    loadingDotsIntervalId = null;
                }
                
                // Hide progress banner if it exists
                const banner = document.getElementById('agent-progress-banner');
                if (banner && banner.parentNode) {
                    banner.parentNode.removeChild(banner);
                }
                setBusyState(false);
                
                // Check if this is a workspace-related error
                const errorText = message.error || '';
                const isWorkspaceError = errorText.includes('Please open a workspace folder') || 
                                       errorText.includes('workspace folder');
                
                if (isWorkspaceError) {
                    // Show workspace banner instead of error message
                    // This keeps the welcome message visible and provides actionable guidance
                    // Ensure welcome message exists before showing banner
                    const chatMessages = safeGetDocumentElement('chatMessages');
                    if (chatMessages && !chatMessages.querySelector('#welcomeMessage')) {
                        showWelcomeMessage();
                    }
                    showWorkspaceBanner();
                    return;
                }
                
                // Use a toast notification instead of displaying a chat message for system-level errors
                // This prevents automatic scrolling and keeps errors non-intrusive
                if (globalScope.showToast) {
                    globalScope.showToast(message.error || 'Unknown error from agent', 'error');
                } else {
                    // Fallback to displaying a chat message if toast is not available
                    const errorMessage = {
                        id: `assistant-error-${Date.now()}`,
                        sessionId: chatState.currentSessionId,
                        projectId: chatState.projectSettings?.projectId,
                        type: globalScope?.MessageType?.ERROR || 'error',
                        role: 'assistant',
                        content: `Error: ${message.error || 'Unknown error from agent'}`,
                        metadata: { error: message.error }
                    };

                    displayMessage(errorMessage);
                    chatState.lastAssistantMessageContent = errorMessage.content;
                    chatState.lastAssistantMessageTimestamp = Date.now();
                }
                return;
            }

            if (message.type === 'agentProgress') {
                // Extract stage from payload - it may be a string directly or in payload.stage
                const payload = message.payload || {};
                const stage = typeof payload === 'string' ? payload : payload.stage;
                showProgressIndicator({ stage });
                return;
            }


            // Handle debug log update (real-time terminal output)
            if (message.type === 'debugLogUpdate') {
                console.log('[StatusLog] Received debugLogUpdate:', message);
                
                const payload = message.payload || {};
                if (!payload.sessionId || !payload.log || !payload.stream) {
                    console.warn('[StatusLog] Invalid debugLogUpdate payload:', payload);
                    return;
                }

                // Initialize status log if needed
                if (!chatState.statusLog && globalScope?.StatusLog) {
                    chatState.statusLog = globalScope.StatusLog.create();
                    
                    // Render and insert status log container
                    const statusLogElement = chatState.statusLog.render();
                    chatState.statusLogElement = statusLogElement;
                    
                    // Insert right after the latest user message
                    const chatMessages = safeGetDocumentElement('chatMessages');
                    if (chatMessages) {
                        // Find the latest user message
                        const messages = chatMessages.querySelectorAll('.chat-message.user-message');
                        let latestUserMessage = null;
                        if (messages.length > 0) {
                            // Get the last user message (most recent)
                            latestUserMessage = messages[messages.length - 1];
                        }
                        
                        // If status log already exists in DOM, remove it first
                        if (statusLogElement.parentNode) {
                            statusLogElement.parentNode.removeChild(statusLogElement);
                        }
                        
                        // Insert after latest user message if found, otherwise append to end
                        if (latestUserMessage && latestUserMessage.nextSibling) {
                            chatMessages.insertBefore(statusLogElement, latestUserMessage.nextSibling);
                        } else if (latestUserMessage) {
                            chatMessages.appendChild(statusLogElement);
                        } else {
                            chatMessages.appendChild(statusLogElement);
                        }
                    }
                }

                // Append log to terminal
                if (chatState.statusLog && typeof chatState.statusLog.appendLogToTerminal === 'function') {
                    chatState.statusLog.appendLogToTerminal(payload.log, payload.stream);
                }
                return;
            }

            // Handle debug status update (real-time status stream)
            if (message.type === 'debugStatusUpdate') {
                console.log('[StatusLog] Received debugStatusUpdate:', message);
                
                const payload = message.payload || {};
                if (!payload.sessionId || !payload.stepId || !payload.category || !payload.message) {
                    console.warn('[StatusLog] Invalid debugStatusUpdate payload:', payload);
                    return;
                }

                // Initialize status log if needed
                if (!chatState.statusLog && globalScope?.StatusLog) {
                    chatState.statusLog = globalScope.StatusLog.create();
                    
                    // Render and insert status log container
                    const statusLogElement = chatState.statusLog.render();
                    chatState.statusLogElement = statusLogElement;
                    
                    // Insert right after the latest user message
                    const chatMessages = safeGetDocumentElement('chatMessages');
                    if (chatMessages) {
                        // Find the latest user message
                        const messages = chatMessages.querySelectorAll('.chat-message.user-message');
                        let latestUserMessage = null;
                        if (messages.length > 0) {
                            // Get the last user message (most recent)
                            latestUserMessage = messages[messages.length - 1];
                        }
                        
                        // If status log already exists in DOM, remove it first
                        if (statusLogElement.parentNode) {
                            statusLogElement.parentNode.removeChild(statusLogElement);
                        }
                        
                        // Insert after latest user message if found, otherwise append to end
                        if (latestUserMessage && latestUserMessage.nextSibling) {
                            chatMessages.insertBefore(statusLogElement, latestUserMessage.nextSibling);
                        } else if (latestUserMessage) {
                            chatMessages.appendChild(statusLogElement);
                        } else {
                            // No user message found, append to end
                            chatMessages.appendChild(statusLogElement);
                        }
                    }
                } else if (chatState.statusLogElement && chatState.statusLogElement.parentNode) {
                    // Status log already exists - ensure it's in the correct position
                    const chatMessages = safeGetDocumentElement('chatMessages');
                    if (chatMessages) {
                        const messages = chatMessages.querySelectorAll('.chat-message.user-message');
                        let latestUserMessage = null;
                        if (messages.length > 0) {
                            latestUserMessage = messages[messages.length - 1];
                        }
                        
                        // Only move if we have a user message and status log is not already after it
                        if (latestUserMessage) {
                            const statusLogParent = chatState.statusLogElement.parentNode;
                            const isAfterUserMessage = latestUserMessage.nextSibling === chatState.statusLogElement;
                            
                            if (!isAfterUserMessage && statusLogParent === chatMessages) {
                                // Remove from current position
                                statusLogParent.removeChild(chatState.statusLogElement);
                                
                                // Insert after latest user message
                                if (latestUserMessage.nextSibling) {
                                    chatMessages.insertBefore(chatState.statusLogElement, latestUserMessage.nextSibling);
                                } else {
                                    chatMessages.appendChild(chatState.statusLogElement);
                                }
                            }
                        }
                    }
                }

                // Add step to status log
                if (chatState.statusLog) {
                    chatState.statusLog.addStep({
                        id: payload.stepId,
                        category: payload.category,
                        message: payload.message
                    });
                }

                return;
            }

            /**
             * Converts graphNodes array to nodeLocationMap and nodeInfoMap formats
             * required for clickable Mermaid graph nodes
             * @param {Array} graphNodes - Array of node objects with { id, label, file, line, ... }
             * @returns {Object} Object with nodeLocationMap and nodeInfoMap
             */
            function convertGraphNodesToMaps(graphNodes) {
                const nodeLocationMap = {};
                const nodeInfoMap = {};
                
                if (!Array.isArray(graphNodes)) {
                    return { nodeLocationMap: {}, nodeInfoMap: {} };
                }
                
                for (const node of graphNodes) {
                    if (node.id && node.file) {
                        // Convert to nodeLocationMap format
                        nodeLocationMap[node.id] = {
                            filePath: node.file,
                            line: node.line || 1  // Default to line 1 if missing
                        };
                        
                        // Optionally build nodeInfoMap for tooltips
                        if (node.label || node.analysis || node.importance !== undefined) {
                            nodeInfoMap[node.id] = {
                                ...(node.label ? { label: node.label } : {}),
                                ...(node.analysis ? { analysis: node.analysis } : {}),
                                ...(node.importance !== undefined ? { importance: node.importance } : {})
                            };
                        }
                    }
                }
                
                return { nodeLocationMap, nodeInfoMap };
            }

            // Handle debug graph update (initial graph from fast path)
            if (message.type === 'debugGraphUpdate') {
                console.log('[DEBUG GRAPH UPDATE] Received debugGraphUpdate message');
                
                const payload = message.payload || {};
                const { visualization, sessionId, status, epicenter, graphNodes, nodeLocationMap: providedNodeLocationMap } = payload;
                
                console.log('[DEBUG GRAPH UPDATE] Message details:', {
                    hasVisualization: !!visualization,
                    visualizationLength: visualization?.length || 0,
                    sessionId: sessionId,
                    status: status,
                    epicenter: epicenter,
                    graphNodesCount: Array.isArray(graphNodes) ? graphNodes.length : 0,
                    hasProvidedNodeLocationMap: !!providedNodeLocationMap
                });
                
                // Use provided nodeLocationMap if available (with normalized IDs matching Mermaid), otherwise convert from graphNodes
                let nodeLocationMap, nodeInfoMap;
                if (providedNodeLocationMap && Object.keys(providedNodeLocationMap).length > 0) {
                    // Use pre-built nodeLocationMap from backend (has normalized IDs matching Mermaid diagram)
                    nodeLocationMap = providedNodeLocationMap;
                    // Still build nodeInfoMap from graphNodes for tooltips
                    const converted = convertGraphNodesToMaps(graphNodes);
                    nodeInfoMap = converted.nodeInfoMap;
                } else {
                    // Fallback: convert graphNodes array to nodeLocationMap and nodeInfoMap formats
                    const converted = convertGraphNodesToMaps(graphNodes);
                    nodeLocationMap = converted.nodeLocationMap;
                    nodeInfoMap = converted.nodeInfoMap;
                }
                
                // Store maps in chatState for persistence across graph updates
                if (Object.keys(nodeLocationMap).length > 0) {
                    chatState.currentNodeLocationMap = nodeLocationMap;
                    console.log('[DEBUG GRAPH UPDATE] Stored nodeLocationMap with', Object.keys(nodeLocationMap).length, 'entries');
                }
                if (Object.keys(nodeInfoMap).length > 0) {
                    chatState.currentNodeInfoMap = nodeInfoMap;
                    console.log('[DEBUG GRAPH UPDATE] Stored nodeInfoMap with', Object.keys(nodeInfoMap).length, 'entries');
                }
                
                // HIDDEN: Visualization saving disabled but preserved for future use
                /*
                // Save debugging mermaid graph to session
                if (visualization && chatState.currentSessionId && globalScope?.WebviewApi?.persistence?.updateSession) {
                    try {
                        // Update session with initial debugging mermaid graph
                        await globalScope.WebviewApi.persistence.updateSession(chatState.currentSessionId, {
                            currentArtifact: {
                                mermaidData: visualization,
                                timestamp: Date.now(),
                                generationStatus: 'analyzing'
                            }
                        });
                        
                        // Reload session to get updated artifact
                        if (globalScope?.WebviewApi?.persistence?.loadSession) {
                            const updatedSession = await globalScope.WebviewApi.persistence.loadSession(chatState.currentSessionId);
                            if (updatedSession) {
                                chatState.currentSession = updatedSession;
                                updateShowCodeVisualsButton();
                            }
                        }
                    } catch (error) {
                        console.error('[DEBUG GRAPH UPDATE] Failed to save debugging mermaid to session:', error);
                    }
                }
                */
                
                // Auto-open modal only when explicitly requested (default false)
                const autoOpen = message.autoOpen === true || payload.autoOpen === true;
                if (autoOpen && visualization) {
                    queueMicrotask(() => {
                        console.log('[DEBUG GRAPH UPDATE] Auto-opening code visuals modal with analyzing state');
                        // State is 'analyzing' to indicate graph is being updated during analysis
                        // Pass converted nodeLocationMap and nodeInfoMap for clickable nodes
                        renderCodeVisualsModal(visualization, 'analyzing', nodeLocationMap, nodeInfoMap);
                    });
                }
                
                return;
            }

            // Handle debug session finished
            if (message.type === 'debugSessionFinished') {
                console.log('[StatusLog] Received debugSessionFinished');

                const payload = message.payload || {};

                // Bug fix: Ignore responses from old/aborted sessions that arrive after
                // the user started a new conversation.
                if (payload.sessionId && payload.sessionId !== chatState.currentSessionId) {
                    console.log('[Chat] Ignoring debugSessionFinished from old session', {
                        payloadSessionId: payload.sessionId,
                        currentSessionId: chatState.currentSessionId
                    });
                    return;
                }

                // Stop animation on status log
                if (chatState.statusLog) {
                    chatState.statusLog.setFinished();
                }
                setBusyState(false);
                const { content, visualization, epilogue, id: payloadId, sessionId: payloadSessionId, alreadyPersisted } = payload;

                // STRICT IDEMPOTENCY: Backend-provided ID is the source of truth. Prevents duplicate
                // display/save when the same debugSessionFinished is delivered twice or when history
                // is reloaded (savedMessageIds is repopulated from loaded message IDs).
                const messageId = payloadId || `assistant-${Date.now()}`; // Fallback if ID missing
                if (chatState.savedMessageIds.has(messageId)) {
                    console.log('[Chat] Skipping duplicate save for debugSessionFinished message:', messageId);
                    return; // Exit early, don't even attempt save or display
                }

                // Use sessionId from payload (backend-provided) - this ensures correct session for multi-session scenarios
                const sessionId = payloadSessionId || chatState.currentSessionId;

                // HIDDEN: Visualization saving disabled but preserved for future use
                /*
                // 1. Render Final Graph (Priority - Race Condition Fix)
                // Update visualization to final state to ensure graph matches text solution
                if (visualization && sessionId && globalScope?.WebviewApi?.persistence?.updateSession) {
                    try {
                        // Update session with final debugging mermaid graph
                        await globalScope.WebviewApi.persistence.updateSession(sessionId, {
                            currentArtifact: {
                                mermaidData: visualization,
                                timestamp: Date.now(),
                                generationStatus: 'completed'
                            }
                        });
                        
                        // Reload session to get updated artifact
                        if (globalScope?.WebviewApi?.persistence?.loadSession) {
                            const updatedSession = await globalScope.WebviewApi.persistence.loadSession(sessionId);
                            if (updatedSession) {
                                chatState.currentSession = updatedSession;
                                updateShowCodeVisualsButton();
                            }
                        }
                    } catch (error) {
                        console.error('[DebugSessionFinished] Failed to save final visualization to session:', error);
                    }
                }
                */

                // 2. Render Final Message with Stats Footer
                if (content) {
                    // Build stats footer from epilogue
                    let statsFooter = '';
                    if (epilogue) {
                        const steps = epilogue.steps || 0;
                        const filesCount = Array.isArray(epilogue.files) ? epilogue.files.length : 0;
                        const cost = epilogue.cost || 0;
                        statsFooter = `\n\n*Analysis complete: ${steps} step${steps !== 1 ? 's' : ''}, ${filesCount} file${filesCount !== 1 ? 's' : ''} analyzed. Cost: $${cost.toFixed(4)}*`;
                    }

                    // Build assistant message using the same pattern as success messages
                    // Pass the backend-generated ID to ensure consistency
                    // Use sessionId from payload (backend-provided) to ensure correct session for concept button
                    const assistantMessage = buildAssistantMessageFromAgentResponse({
                        id: messageId, // Use backend-provided ID (source of truth)
                        message: content + statsFooter,
                        metadata: {
                            samuraiAgentResponse: true,
                            debugSessionFinished: true,
                            sessionId: sessionId, // Use payload sessionId to ensure correct session for concept button
                            ...(epilogue ? { epilogue } : {})
                        },
                        cost: epilogue?.cost
                    });

                    if (assistantMessage) {
                        // Mark as saved BEFORE async operation to prevent race conditions
                        // The idempotency check above already verified it's not a duplicate
                        chatState.savedMessageIds.add(messageId);
                        
                        // Display the final message
                        // Note: Concept button is now automatically added at the top by displayMessage
                        // when it detects metadata.debugSessionFinished === true
                        displayMessage(assistantMessage);
                        chatState.lastAssistantMessageContent = assistantMessage.content;
                        chatState.lastAssistantMessageTimestamp = Date.now();

                        // Persist the assistant message to storage only if backend did not already save it.
                        // When alreadyPersisted is true, the backend saved before postMessage (webview may have been closed).
                        if (!alreadyPersisted && assistantMessage.sessionId && assistantMessage.projectId) {
                            try {
                                if (!globalScope?.WebviewApi?.persistence?.saveChatMessage) {
                                    console.warn('[Chat] WebviewApi.persistence.saveChatMessage not available');
                                } else {
                                    const saveResponse = await globalScope.WebviewApi.persistence.saveChatMessage({
                                        sessionId: assistantMessage.sessionId,
                                        projectId: assistantMessage.projectId,
                                        type: assistantMessage.type,
                                        content: assistantMessage.content,
                                        role: assistantMessage.role,
                                        metadata: assistantMessage.metadata,
                                        specClarificationData: assistantMessage.specClarificationData,
                                        interactiveQuestions: assistantMessage.interactiveQuestions,
                                        interactiveConfirmationQuestions: assistantMessage.interactiveConfirmationQuestions,
                                        id: messageId // Use backend-provided ID
                                    });
                                    
                                    // Update saved message ID from response if different (shouldn't happen, but safety net)
                                    // Line 3528 already locked messageId (LOCK step)
                                    // Now UPDATE: Add Real ID if different (Temp ID already locked as tombstone)
                                    const savedMessageId = saveResponse?.payload?.id || messageId;
                                    if (savedMessageId && savedMessageId !== messageId) {
                                        chatState.savedMessageIds.add(savedMessageId);
                                    }
                                    
                                    console.log('[Chat] Debug session finished message persisted successfully', {
                                        sessionId: assistantMessage.sessionId,
                                        messageId: savedMessageId,
                                        contentLength: assistantMessage.content?.length || 0
                                    });
                                }
                            } catch (saveError) {
                                // Don't delete messageId - keep it as tombstone to prevent duplicate saves
                                // The optimistic lock (line 3528) already prevents re-processing
                                console.error('[Chat] Failed to save debug session finished message to persistence:', saveError);
                            }
                        } else if (alreadyPersisted) {
                            console.log('[Chat] Debug session finished message already persisted by backend, skipping save');
                        } else {
                            // Don't delete messageId - keep it as tombstone to prevent duplicate saves
                            // The optimistic lock (line 3528) already prevents re-processing
                            console.error('[Chat] FATAL: Cannot persist debug session finished message - missing session/project ID', {
                                sessionId: assistantMessage.sessionId,
                                projectId: assistantMessage.projectId
                            });
                        }
                    }

                    // 3. Update Global Cost Display
                    if (epilogue?.cost && typeof epilogue.cost === 'number') {
                        updateApiCostDisplay(epilogue.cost);
                    }
                }

                return;
            }

            // Handle debug visualization
            if (message.type === 'debugVisualization') {
                console.log('[DEBUG VIZ] ===== Received debugVisualization message =====');
                const nodeInfoMapPayload = message.nodeInfoMap || message.nodeMetadataMap || {};
                console.log('[DEBUG VIZ] Message details:', {
                    hasVisualization: !!message.visualization,
                    visualizationLength: message.visualization?.length || 0,
                    hasMeta: !!message.meta,
                    mode: message.meta?.mode,
                    nodeCount: message.meta?.nodeCount,
                    hasNodeLocationMap: !!message.nodeLocationMap,
                    mapSize: message.nodeLocationMap ? Object.keys(message.nodeLocationMap).length : 0,
                    hasNodeInfoMap: Object.keys(nodeInfoMapPayload).length > 0,
                    infoSize: Object.keys(nodeInfoMapPayload).length,
                    hasPipelineSteps: !!message.pipelineSteps,
                    pipelineStepsCount: message.pipelineSteps?.length || 0,
                    hasCandidates: !!message.graphCandidates,
                    candidatesCount: message.graphCandidates?.length || 0,
                    debugMetaVersion: message.debugMetaVersion,
                    hasLLMDebugInfo: !!message.llmDebugInfo,
                    llmDebugInfoCount: message.llmDebugInfo?.length || 0,
                    llmDebugInfoVersion: message.llmDebugInfoVersion,
                    timestamp: message.timestamp
                });
                console.log('[DEBUG VIZ] DebugVisualizationManager status:', {
                    hasGlobalScope: !!globalScope,
                    hasManager: !!globalScope?.DebugVisualizationManager,
                    hasRenderMethod: !!globalScope?.DebugVisualizationManager?.renderDebugVisualizationModal
                });
                
                // Store candidates for refocus feature
                chatState.lastDebugCandidates = message.graphCandidates || [];
                chatState.lastSelectedCandidateIds = message.selectedCandidateIds || [];
                chatState.lastUserMessage = chatState.lastUserMessage || null;
                
                // Store nodeLocationMap for clickable nodes
                chatState.currentNodeLocationMap = message.nodeLocationMap || {};
                chatState.currentNodeInfoMap = nodeInfoMapPayload;
                
                // Save debugging mermaid graph to session
                if (message.visualization && chatState.currentSessionId && globalScope?.WebviewApi?.persistence?.updateSession) {
                    try {
                        // Update session with debugging mermaid graph
                        await globalScope.WebviewApi.persistence.updateSession(chatState.currentSessionId, {
                            currentArtifact: {
                                mermaidData: message.visualization,
                                timestamp: Date.now(),
                                generationStatus: 'completed'
                            }
                        });
                        
                        // Reload session to get updated artifact
                        if (globalScope?.WebviewApi?.persistence?.loadSession) {
                            const updatedSession = await globalScope.WebviewApi.persistence.loadSession(chatState.currentSessionId);
                            if (updatedSession) {
                                chatState.currentSession = updatedSession;
                                updateShowCodeVisualsButton();
                            }
                        }
                    } catch (error) {
                        console.error('[DEBUG VIZ] Failed to save debugging mermaid to session:', error);
                    }
                }
                
                // Auto-open modal only when explicitly requested (default false)
                if (message.autoOpen === true) {
                    queueMicrotask(() => {
                        console.log('[DEBUG VIZ] Auto-opening code visuals modal');
                        renderCodeVisualsModal(message.visualization, 'completed', message.nodeLocationMap, nodeInfoMapPayload);
                    });
                }
                
                return;
            }

            // Handle concept image ready event
            if (message.type === 'conceptImageReady') {
                const { sessionId, messageId, imageUrl } = message.payload || {};
                // Ensure messageId is present and valid
                if (messageId && imageUrl) {
                    const container = document.getElementById(`concept-container-${messageId}`);
                    if (container) {
                        // Swap Button for Image
                        container.innerHTML = `
                            <div class="concept-image-frame" style="margin-top: 8px;">
                                <img src="${imageUrl}" alt="Concept Diagram" loading="lazy" style="max-width: 100%; height: auto; border-radius: 4px; box-shadow: 0 2px 8px rgba(0,0,0,0.1);" />
                            </div>
                        `;
                    } else {
                        console.warn(`[Chat] Concept container not found for messageId: ${messageId}`);
                    }
                } else {
                    console.warn('[Chat] Invalid conceptImageReady payload:', message.payload);
                }
                return;
            }

            // Handle agent error (background agent failed; clear busy state and show error)
            if (message.type === 'agentError') {
                if (loadingDotsIntervalId !== null) {
                    clearInterval(loadingDotsIntervalId);
                    loadingDotsIntervalId = null;
                }
                const banner = document.getElementById('agent-progress-banner');
                if (banner && banner.parentNode) {
                    banner.parentNode.removeChild(banner);
                }
                setBusyState(false);
                const errorText = message.payload?.error || 'Agent error';
                if (globalScope.showToast) {
                    globalScope.showToast(errorText, 'error');
                } else {
                    const errorMessage = {
                        id: `assistant-error-${Date.now()}`,
                        sessionId: chatState.currentSessionId,
                        projectId: chatState.projectSettings?.projectId,
                        type: globalScope?.MessageType?.ERROR || 'error',
                        role: 'assistant',
                        content: `Error: ${errorText}`,
                        metadata: { error: errorText }
                    };
                    displayMessage(errorMessage);
                    chatState.lastAssistantMessageContent = errorMessage.content;
                    chatState.lastAssistantMessageTimestamp = Date.now();
                }
                return;
            }

            // Refresh cost display when cost-related operations complete
            if (message.type === 'success' && message.requestId && 
                (message.requestId.includes('projectDetail.ingest') || 
                 message.requestId.includes('samurai-agent.execute'))) {
                // Small delay to ensure cost records are saved
                setTimeout(() => {
                    updateApiCostDisplay(0);
                }, 500);
            }

            // Handle notifications (messages without requestId that are not responses)
            // Special case: globalSettingsUpdated should always be processed even if it has requestId
            if (message.type === 'globalSettingsUpdated' && message.payload) {
                console.log('[Chat] Received globalSettingsUpdated, processing...', {
                    hasRequestId: !!message.requestId,
                    payloadKeys: Object.keys(message.payload),
                    availableModelsCount: message.payload.availableModels?.length
                });
                await dispatchNotification(message.type, message.payload);
            } else if (!message.requestId && message.type) {
                console.log('[Chat] Dispatching notification:', message.type);
                await dispatchNotification(message.type, message.payload);
            }
        };

        // Use WebviewApi.subscribe if available (modern approach)
        // Otherwise fall back to window message listener
        if (globalScope.WebviewApi?.subscribe) {
            const unsubscribe = globalScope.WebviewApi.subscribe(async message => {
                await onMessage(message);
            });
            listeners.add(unsubscribe);
        } else {
            globalScope.addEventListener('message', async event => {
                await onMessage(event.data);
            });
        }

        // Send webviewReady signal to extension host after message listener is set up
        // This ensures the backend knows the webview is ready to receive initialSettings
        try {
            if (globalScope.WebviewApi?.postCommand) {
                globalScope.WebviewApi.postCommand('webviewReady', null).catch(error => {
                    console.warn('Chat: Failed to send webviewReady signal:', error);
                });
            } else if (typeof globalScope.acquireVsCodeApi === 'function') {
                const vscodeApi = globalScope.acquireVsCodeApi();
                if (vscodeApi && typeof vscodeApi.postMessage === 'function') {
                    vscodeApi.postMessage({
                        command: 'webviewReady'
                    });
                }
            } else if (globalScope.parent) {
                globalScope.parent.postMessage({
                    command: 'webviewReady'
                }, '*');
            }
            console.log('Chat: Sent webviewReady signal to extension host');
        } catch (error) {
            console.warn('Chat: Error sending webviewReady signal:', error);
        }

        return () => {
            listeners.forEach(unsubscribe => unsubscribe());
            listeners.clear();
        };
    }

    function injectChatInputStyles() {
        if (document.getElementById('chat-input-style')) {
            return;
        }

        const style = document.createElement('style');
        style.id = 'chat-input-style';
        style.textContent = `
            .chat-input-container {
                padding: 10px;
                background-color: var(--vscode-panel-background);
                border-top: 1px solid var(--vscode-panel-border);
                display: flex;
                flex-direction: column;
                gap: 8px;
                flex-shrink: 0;
            }

            .chat-input-hint {
                font-size: 11px;
                color: var(--vscode-descriptionForeground);
                user-select: none;
            }
        `;

        document.head.appendChild(style);
    }

    // Bootstrapping
    if (globalScope) {
        if (!globalScope.WebviewApi) {
            console.warn('Chat: WebviewApi not ready yet; deferring init...');
            if (typeof document !== 'undefined') {
                document.addEventListener('readystatechange', function onReady() {
                    if (globalScope.WebviewApi) {
                        document.removeEventListener('readystatechange', onReady);
                        initializeChat();
                    }
                });
            }
        } else {
            initializeChat();
        }

        // Function to refresh webview state when it becomes visible
        function refreshWebviewState() {
            const now = Date.now();
            
            // Prevent rapid successive refreshes (within 2 seconds)
            if (now - chatState.lastRefreshTime < 2000) {
                console.log('Chat: Skipping refresh - too soon since last refresh');
                return;
            }
            
            chatState.lastRefreshTime = now;
            console.log('Chat: refreshWebviewState called - refreshing all state');
            
            // Refresh LLM model dropdown
            void refreshLLMModelDropdown();
            
            // Only re-initialize chat session if we don't have messages loaded
            // This prevents clearing messages that were just saved
            if (chatState.projectSettings) {
                const chatMessages = safeGetDocumentElement('chatMessages');
                
                // More robust message detection - check for actual message elements
                const messageElements = chatMessages ? chatMessages.querySelectorAll('.chat-message') : [];
                const hasMessages = messageElements.length > 0;
                
                console.log('Chat: Message detection:', {
                    hasElement: !!chatMessages,
                    childrenCount: chatMessages ? chatMessages.children.length : 0,
                    messageElements: messageElements.length,
                    hasMessages: hasMessages,
                    messagesLoaded: chatState.messagesLoaded
                });
                
                // If DOM is empty but messagesLoaded flag is true, reset and reload
                if (!hasMessages && chatState.messagesLoaded) {
                    console.log('Chat: DOM is empty but messagesLoaded is true - resetting state and reloading');
                    chatState.messagesLoaded = false;
                    chatState.displayedMessageIds.clear();
                    chatState.savedMessageIds.clear();
                    // Reset duplicate detection state
                    chatState.lastAssistantMessageContent = null;
                    chatState.lastAssistantMessageTimestamp = 0;
                    void initializeChatSession();
                } else if (chatState.messagesLoaded && hasMessages) {
                    // Messages are loaded and present in DOM - no action needed
                    console.log('Chat: Messages already loaded and present, skipping session initialization');
                    // Just ensure we have the current session ID
                    if (!chatState.currentSessionId && chatState.projectSettings.currentSessionId) {
                        chatState.currentSessionId = chatState.projectSettings.currentSessionId;
                    }
                } else if (!hasMessages) {
                    // No messages in DOM and not loaded - initialize session
                    console.log('Chat: No messages found, initializing chat session');
                    void initializeChatSession();
                    // Show welcome message
                    showWelcomeMessage();
                } else {
                    // Messages present but not marked as loaded - mark as loaded and ensure session ID
                    console.log('Chat: Messages present but not marked as loaded, ensuring session ID');
                    chatState.messagesLoaded = true;
                    if (!chatState.currentSessionId && chatState.projectSettings.currentSessionId) {
                        chatState.currentSessionId = chatState.projectSettings.currentSessionId;
                    }
                }
            }
            
            // Refresh cost display
            updateApiCostDisplay(0);
            
            console.log('Chat: Webview state refresh completed');
        }

        globalScope.ChatManager = {
            handleInitialSettings,
            populateLLMModelDropdown,
            handleLLMModelChange,
            refreshLLMModelDropdown,
            initializeMessageListener,
            displayMessage,
            MessageType,
            getChatState: () => chatState,
            refreshCostDisplay: () => updateApiCostDisplay(0),
            refreshWebviewState
        };
    }

    // ============ Spec Artifact Functionality ============

    function updateShowCodeVisualsButton() {
        const button = safeGetDocumentElement('show-code-visuals-btn');
        
        if (!button) return;
        
        // HIDDEN: Always hide button - feature disabled but preserved for future use
        button.style.display = 'none';
    }

    async function handleShowCodeVisualsClick() {
        // HIDDEN: Feature disabled but preserved for future use
        return;
        
        // ... rest of function preserved
        const artifact = chatState.currentSession?.currentArtifact;
        const mermaidData = artifact?.mermaidData;
        
        if (!mermaidData) {
            // No mermaid data available
            renderCodeVisualsModal(null, 'not_started');
            return;
        }
        
        // Get nodeLocationMap and nodeInfoMap from multiple sources (prioritize current state, fallback to message dataset)
        let nodeLocationMap = chatState.currentNodeLocationMap || {};
        let nodeInfoMap = chatState.currentNodeInfoMap || {};
        
        // If nodeLocationMap is empty, try to find it from message dataset (for historical messages)
        const shouldLoadFromDataset = (map) => !map || Object.keys(map).length === 0;
        if (shouldLoadFromDataset(nodeLocationMap) || shouldLoadFromDataset(nodeInfoMap)) {
            // Find the assistant message element that has visualization data
            const chatMessages = safeGetDocumentElement('chatMessages');
            if (chatMessages) {
                const messageElements = chatMessages.querySelectorAll('[data-has-visualization="true"]');
                // Get the most recent message with visualization data
                if (messageElements.length > 0) {
                    const lastMessage = messageElements[messageElements.length - 1];
                    const parseDatasetJson = (value, label) => {
                        if (!value) {
                            return {};
                        }
                        try {
                            const parsed = JSON.parse(value);
                            console.log(`[Code Visuals] Retrieved ${label} from message dataset:`, Object.keys(parsed).length, 'entries');
                            return parsed;
                        } catch (error) {
                            console.warn(`[Code Visuals] Failed to parse ${label} from message dataset:`, error);
                            return {};
                        }
                    };

                    if (shouldLoadFromDataset(nodeLocationMap)) {
                        nodeLocationMap = parseDatasetJson(lastMessage.dataset.nodeLocationMap, 'nodeLocationMap');
                    }
                    if (shouldLoadFromDataset(nodeInfoMap)) {
                        const datasetNodeInfo = lastMessage.dataset.nodeInfoMap || lastMessage.dataset.nodeMetadataMap;
                        nodeInfoMap = parseDatasetJson(datasetNodeInfo, datasetNodeInfo ? 'nodeInfoMap' : 'nodeMetadataMap');
                    }
                }
            }
        }
        
        // Show the mermaid graph (use stored nodeLocationMap if available)
        renderCodeVisualsModal(mermaidData, 'completed', nodeLocationMap, nodeInfoMap);
    }

    /**
     * Validates and repairs Mermaid syntax
     */
    function repairMermaidSyntax(mermaidCode) {
        if (!mermaidCode || typeof mermaidCode !== 'string') {
            return {
                repaired: 'graph TD\n    A[Invalid Diagram] --> B[Please regenerate]',
                wasRepaired: true,
                errors: ['Input was empty or invalid']
            };
        }
        
        let repaired = mermaidCode;
        let changesApplied = 0;
        const errors = [];
        
        // Remove markdown code fences if present
        if (repaired.includes('```mermaid') || repaired.includes('```')) {
            repaired = repaired.replace(/^```mermaid\n?/i, '').replace(/\n?```$/i, '');
            changesApplied++;
        }
        
        // Fix escaped newlines
        if (repaired.includes('\\n')) {
            repaired = repaired.replace(/\\n/g, '\n');
            changesApplied++;
        }
        
        // Remove trailing semicolons from connections and node definitions
        if (repaired.includes(';')) {
            repaired = repaired.split('\n').map(line => {
                // Remove semicolons at end of lines (common mistake)
                return line.replace(/;(\s*)$/g, '$1');
            }).join('\n');
            changesApplied++;
            errors.push('Removed trailing semicolons');
        }
        
        // Collapse multiple consecutive empty lines
        if (repaired.includes('\n\n\n')) {
            repaired = repaired.replace(/\n{3,}/g, '\n\n');
            changesApplied++;
            errors.push('Collapsed multiple empty lines');
        }
        
        // Fix linkStyle with spaces in property values (stroke-dasharray: 5 5 -> stroke-dasharray:5,5)
        if (repaired.includes('linkStyle')) {
            const originalRepaired = repaired;
            // Fix spaces after colons in style properties
            repaired = repaired.replace(/(\w+):\s+/g, '$1:');
            // Fix stroke-dasharray with spaces (5 5 -> 5,5)
            repaired = repaired.replace(/stroke-dasharray:(\d+)\s+(\d+)/g, 'stroke-dasharray:$1,$2');
            if (repaired !== originalRepaired) {
                changesApplied++;
                errors.push('Fixed linkStyle syntax');
            }
        }
        
        // Fix colons in node labels (replace with space or remove)
        // Mermaid doesn't allow colons in node labels without escaping
        const labelColonRegex = /(\[|\()([^\]\)]*?):([^\]\)]*?)(\]|\))/g;
        if (labelColonRegex.test(repaired)) {
            repaired = repaired.replace(/(\[|\()([^\]\)]*?):([^\]\)]*?)(\]|\))/g, '$1$2 $3$4');
            changesApplied++;
            errors.push('Fixed colons in node labels');
        }
        
        // Remove trailing incomplete style definitions
        const lines = repaired.split('\n');
        const lastNonEmptyLine = lines.filter(line => line.trim().length > 0).pop();
        if (lastNonEmptyLine && lastNonEmptyLine.trim().startsWith('style ')) {
            // Check if style definition is incomplete (no fill: or stroke:)
            if (!lastNonEmptyLine.includes('fill:') && !lastNonEmptyLine.includes('stroke:')) {
                repaired = lines.filter(line => line !== lastNonEmptyLine).join('\n');
                changesApplied++;
                errors.push('Removed incomplete style definition');
            }
        }
        
        // Ensure it starts with a valid diagram type
        const trimmed = repaired.trim();
        if (!trimmed.startsWith('graph') && !trimmed.startsWith('flowchart') && 
            !trimmed.startsWith('sequenceDiagram') && !trimmed.startsWith('classDiagram')) {
            if (trimmed.includes('-->') || trimmed.includes('---')) {
                repaired = `graph TD\n${trimmed}`;
                changesApplied++;
            }
        }
        
        console.log('[Mermaid Validator] Repair completed:', {
            wasRepaired: changesApplied > 0,
            changesApplied,
            errors
        });
        
        return {
            repaired,
            wasRepaired: changesApplied > 0,
            errors
        };
    }
    
    /**
     * Converts markdown to HTML (simple version for specs)
     */
    function renderSpecMarkdown(markdown) {
        if (!markdown || typeof markdown !== 'string') {
            return '<p>No specification available</p>';
        }
        
        let html = markdown;
        
        // Headers
        html = html.replace(/^### (.*$)/gim, '<h3>$1</h3>');
        html = html.replace(/^## (.*$)/gim, '<h2>$1</h2>');
        html = html.replace(/^# (.*$)/gim, '<h1>$1</h1>');
        
        // Bold
        html = html.replace(/\*\*(.*?)\*\*/gim, '<strong>$1</strong>');
        
        // Italic
        html = html.replace(/\*(.*?)\*/gim, '<em>$1</em>');
        
        // Inline code
        html = html.replace(/`([^`]+)`/gim, '<code>$1</code>');
        
        // Code blocks
        html = html.replace(/```(\w*)\n([\s\S]*?)```/gim, '<pre><code>$2</code></pre>');
        
        // Lists (bullet points starting with * or -)
        html = html.replace(/^\s*[\*\-]\s+(.*)$/gim, '<li>$1</li>');
        
        // Wrap consecutive <li> items in <ul>
        html = html.replace(/(<li>.*<\/li>\n?)+/gim, '<ul>$&</ul>');
        
        // Numbered lists
        html = html.replace(/^\s*\d+\.\s+(.*)$/gim, '<li>$1</li>');
        html = html.replace(/(<li>.*<\/li>\n?)+/gim, function(match) {
            // Check if already wrapped in ul
            if (match.includes('<ul>')) {
                return match;
            }
            return '<ol>' + match + '</ol>';
        });
        
        // Blockquotes
        html = html.replace(/^\> (.*)$/gim, '<blockquote>$1</blockquote>');
        
        // Line breaks (double newline = paragraph)
        html = html.replace(/\n\n/gim, '</p><p>');
        
        // Wrap in paragraph if not already in a block element
        if (!html.startsWith('<h') && !html.startsWith('<ul') && !html.startsWith('<ol') && !html.startsWith('<p')) {
            html = '<p>' + html + '</p>';
        }
        
        return html;
    }

    /**
     * Renders the color legend for code visuals
     */
    function renderCodeVisualsLegend() {
        const legendContainer = safeGetDocumentElement('code-visuals-legend');
        if (!legendContainer) return;
        
        const legendItems = [
            { label: 'UI/Frontend', fill: '#FDE68A', stroke: '#F59E0B' },
            { label: 'API', fill: '#DBEAFE', stroke: '#3B82F6' },
            { label: 'Data', fill: '#DCFCE7', stroke: '#22C55E' },
            { label: 'Auth', fill: '#FEE2E2', stroke: '#EF4444' },
            { label: 'Infrastructure', fill: '#E0F2FE', stroke: '#38BDF8' }
        ];
        
        const legendHTML = legendItems.map(item => `
            <div class="code-visuals-legend-item">
                <div class="code-visuals-legend-swatch" style="background-color: ${item.fill}; border-color: ${item.stroke};"></div>
                <span class="code-visuals-legend-label">${item.label}</span>
            </div>
        `).join('');
        
        legendContainer.innerHTML = legendHTML;
    }

    let mermaidTooltipElement = null;

    function ensureMermaidTooltipElement() {
        if (!mermaidTooltipElement) {
            mermaidTooltipElement = document.createElement('div');
            mermaidTooltipElement.className = 'code-visuals-tooltip code-visuals-tooltip-hidden';
            document.body.appendChild(mermaidTooltipElement);
        }
        return mermaidTooltipElement;
    }

    function hideMermaidTooltip() {
        if (mermaidTooltipElement) {
            mermaidTooltipElement.classList.add('code-visuals-tooltip-hidden');
        }
    }

    function updateMermaidTooltipPosition(clientX, clientY) {
        const tooltip = ensureMermaidTooltipElement();
        const offset = 16;
        const viewportPadding = 12;
        let left = clientX + offset;
        let top = clientY + offset;

        // Ensure tooltip stays within viewport bounds
        const tooltipRect = tooltip.getBoundingClientRect();
        const maxLeft = window.innerWidth - tooltipRect.width - viewportPadding;
        const maxTop = window.innerHeight - tooltipRect.height - viewportPadding;

        left = Math.min(Math.max(viewportPadding, left), Math.max(viewportPadding, maxLeft));
        top = Math.min(Math.max(viewportPadding, top), Math.max(viewportPadding, maxTop));

        tooltip.style.left = `${left}px`;
        tooltip.style.top = `${top}px`;
    }

    function showMermaidTooltip(html, clientX, clientY) {
        const tooltip = ensureMermaidTooltipElement();
        tooltip.innerHTML = html;
        tooltip.classList.remove('code-visuals-tooltip-hidden');
        // Position after content updates to account for new size
        requestAnimationFrame(() => updateMermaidTooltipPosition(clientX, clientY));
    }

    function buildMermaidTooltipHtml(metadata) {
        if (!metadata) {
            return '';
        }

        const sections = [];
        if (metadata.label) {
            sections.push(`<div class="code-visuals-tooltip-label">${escapeHtml(metadata.label)}</div>`);
        }

        if (metadata.analysis) {
            const analysisHtml = escapeHtml(metadata.analysis).replace(/\n/g, '<br>');
            sections.push(`<div class="code-visuals-tooltip-analysis">${analysisHtml}</div>`);
        }

        if (typeof metadata.importance === 'number' && Number.isFinite(metadata.importance)) {
            const percent = Math.round(metadata.importance * 100);
            sections.push(`<div class="code-visuals-tooltip-importance">Importance: ${percent}%</div>`);
        }

        return sections.join('');
    }
    
    function renderCodeVisualsModal(mermaidData, state = 'completed', nodeLocationMap = null, nodeInfoMap = null) {
        const modal = safeGetDocumentElement('code-visuals-modal');
        const mermaidContainer = safeGetDocumentElement('code-visuals-mermaid');
        
        if (!modal || !mermaidContainer) return;

        hideMermaidTooltip();
        
        // Clear previous content
        mermaidContainer.innerHTML = '';
        if (!mermaidContainer.dataset.tooltipListenerAttached) {
            mermaidContainer.addEventListener('mouseleave', hideMermaidTooltip);
            mermaidContainer.dataset.tooltipListenerAttached = 'true';
        }
        
        // Use provided nodeLocationMap or fall back to chatState
        const locationMap = nodeLocationMap || chatState.currentNodeLocationMap || {};
        const metadataMap = nodeInfoMap || chatState.currentNodeInfoMap || {};
        
        // Handle different states
        if (state === 'not_started') {
            mermaidContainer.innerHTML = `
                <div style="text-align: center; padding: 40px 20px; color: var(--vscode-descriptionForeground);">
                    <p style="font-size: 16px; margin-bottom: 12px;">📊 No Code Visuals Available</p>
                    <p style="font-size: 13px;">Code visuals will appear here when generated during debugging or spec generation.</p>
                </div>
            `;
            // Render legend even when no diagram is available
            renderCodeVisualsLegend();
            modal.style.display = 'flex';
            applyChatOverlapOffset(modal);
            return;
        }
        
        // State is 'completed' - render the actual mermaid diagram
        // Validate and repair Mermaid diagram
        if (typeof mermaid !== 'undefined' && mermaidData) {
            const repairResult = repairMermaidSyntax(mermaidData);
            const diagramToRender = repairResult.repaired;
            
            if (repairResult.wasRepaired) {
                console.log('[Code Visuals Modal] Mermaid syntax was repaired:', repairResult.errors);
            }
            
            // Create wrapper div for zoom transform
            mermaidContainer.innerHTML = `<div class="code-visuals-zoom-wrapper" style="transform-origin: top left;"><div class="mermaid">${diagramToRender}</div></div>`;
            
            try {
                const mermaidElement = mermaidContainer.querySelector('.mermaid');
                mermaid.init(undefined, mermaidElement);
                
                // Set initial zoom to 150% when new diagram is rendered
                currentZoomLevel = 150;
                panX = 0;
                panY = 0;
                applyZoom();
                
                // Attach click handlers after mermaid renders
                // Mermaid renders asynchronously, so we need to wait for the SVG to be created
                // Use a retry mechanism to wait for SVG to be available
                let retryCount = 0;
                const maxRetries = 20; // Try for up to 1 second (20 * 50ms)
                const attachHandlers = () => {
                    const svg = mermaidContainer.querySelector('svg');
                    if (svg) {
                        attachMermaidNodeClickHandlers(mermaidContainer, locationMap, metadataMap);
                        // Apply zoom after SVG is rendered
                        applyZoom();
                    } else if (retryCount < maxRetries) {
                        // Retry after a short delay if SVG not yet available
                        retryCount++;
                        setTimeout(attachHandlers, 50);
                    } else {
                        console.warn('[Code Visuals Modal] SVG not found after max retries, click handlers may not be attached');
                        // Still try to attach handlers even if SVG is not found (might be timing issue)
                        setTimeout(() => {
                            const svg = mermaidContainer.querySelector('svg');
                            if (svg) {
                                attachMermaidNodeClickHandlers(mermaidContainer, locationMap, metadataMap);
                            }
                        }, 200);
                    }
                };
                
                // Start trying to attach handlers after initial delay
                setTimeout(attachHandlers, 100);
            } catch (error) {
                console.error('Mermaid rendering error:', error);
                mermaidContainer.innerHTML = `
                    <p style="color: var(--vscode-errorForeground);">Failed to render diagram</p>
                    <p style="color: var(--vscode-descriptionForeground); font-size: 12px; margin-top: 8px;">
                        ${error.message || 'Unknown syntax error'}
                    </p>
                `;
            }
        } else {
            mermaidContainer.innerHTML = '<p>No diagram available</p>';
        }
        
        // Render legend at the bottom
        renderCodeVisualsLegend();
        
        // Show modal
        modal.style.display = 'flex';
        applyChatOverlapOffset(modal);
    }
    
    /**
     * Attaches click handlers to mermaid-rendered nodes
     * @param {HTMLElement} container - The container element where mermaid is rendered
     * @param {Object} nodeLocationMap - Map from node ID to {filePath, line} location
     */
    function attachMermaidNodeClickHandlers(container, nodeLocationMap, nodeInfoMap = {}) {
        if (!container) {
            console.warn('[Code Visuals Modal] Container not found for attaching click handlers');
            return;
        }
        
        if (!nodeLocationMap || Object.keys(nodeLocationMap).length === 0) {
            console.warn('[Code Visuals Modal] nodeLocationMap is empty, cannot attach click handlers');
            return;
        }
        
        // Find the rendered SVG element
        const svg = container.querySelector('svg');
        if (!svg) {
            console.warn('[Code Visuals Modal] SVG not found for attaching click handlers');
            return;
        }
        
        // Log what we're working with
        const nodeIdsInMap = Object.keys(nodeLocationMap);
        console.log(`[Code Visuals Modal] Attaching click handlers to ${nodeIdsInMap.length} nodes`);
        if (nodeInfoMap) {
            console.log('[Code Visuals Modal] Tooltip metadata entries:', Object.keys(nodeInfoMap).length);
        }
        
        // Get all group elements in the SVG to find nodes
        const allGroups = svg.querySelectorAll('g[class*="node"], g[id*="flowchart"], g[id*="graph"]');
        const allGroupIds = Array.from(allGroups).map(g => ({
            element: g,
            id: g.getAttribute('id') || '',
            class: g.getAttribute('class') || ''
        }));
        
        console.log(`[Code Visuals Modal] Found ${allGroups.length} group elements in SVG`);
        
        let handlersAttached = 0;
        const unmatchedNodes = [];
        
        // Iterate through all node IDs in the location map
        // and try to find corresponding SVG elements
        for (const nodeId in nodeLocationMap) {
            if (!nodeLocationMap.hasOwnProperty(nodeId)) {
                continue;
            }
            
            const location = nodeLocationMap[nodeId];
            if (!location || !location.filePath) {
                continue;
            }
            
            let nodeElement = null;
            
            // Method 1: Direct ID match (most common)
            nodeElement = svg.querySelector(`#${nodeId}`);
            
            // Method 2: With flowchart prefix (Mermaid v10+)
            if (!nodeElement) {
                nodeElement = svg.querySelector(`#flowchart-${nodeId}`);
            }
            
            // Method 3: With flowchart-node prefix
            if (!nodeElement) {
                nodeElement = svg.querySelector(`#flowchart-node-${nodeId}`);
            }
            
            // Method 4: With graph prefix (older Mermaid versions)
            if (!nodeElement) {
                nodeElement = svg.querySelector(`#graph-${nodeId}`);
            }
            
            // Method 5: Search through all groups for ID containing the nodeId
            if (!nodeElement) {
                for (const groupInfo of allGroupIds) {
                    const id = groupInfo.id;
                    const baseId = id.replace(/^(flowchart-|graph-|flowchart-node-)/, '');
                    if (baseId === nodeId || baseId === `node-${nodeId}` || id === nodeId || id.includes(nodeId)) {
                        nodeElement = groupInfo.element;
                        break;
                    }
                }
            }
            
            // Method 6: Try finding by class name containing the nodeId
            if (!nodeElement) {
                for (const groupInfo of allGroupIds) {
                    if (groupInfo.class.includes(nodeId)) {
                        nodeElement = groupInfo.element;
                        break;
                    }
                }
            }
            
            if (!nodeElement) {
                unmatchedNodes.push(nodeId);
                continue;
            }
            
            // Attach click handler to the found element
            // Make it and its children clickable
            nodeElement.style.cursor = 'pointer';
            // Mark node as clickable with data attribute for easier detection
            nodeElement.setAttribute('data-clickable-node', 'true');
            
            // Find all child elements that should be clickable (rect, circle, ellipse, polygon, path)
            const clickableElements = nodeElement.querySelectorAll('rect, circle, ellipse, polygon, path');
            
            // Add click handler to the main element and all clickable children
            // Capture nodeId and location in closure for the handler
            const capturedNodeId = nodeId;
            const capturedLocation = location;
            const clickHandler = async (event) => {
                // Prevent default and stop propagation to avoid conflicts with pan handler
                event.preventDefault();
                event.stopPropagation();
                event.stopImmediatePropagation();
                hideMermaidTooltip();
                
                console.log('[Code Visuals Modal] Node clicked:', { 
                    nodeId: capturedNodeId, 
                    location: capturedLocation,
                    target: event.target,
                    timestamp: new Date().toISOString()
                });
                
                // Reset pan handler state to ensure it doesn't interfere
                clickedOnNode = false;
                
                try {
                    // Check if WebviewApi is available
                    if (!globalScope?.WebviewApi?.postCommand) {
                        console.warn('[Code Visuals Modal] WebviewApi.postCommand not available');
                        console.warn('[Code Visuals Modal] Available WebviewApi:', globalScope?.WebviewApi);
                        alert('Cannot open file: WebviewApi is not available. Please refresh the extension.');
                        return;
                    }
                    
                    // Validate location data
                    if (!capturedLocation || !capturedLocation.filePath) {
                        console.error('[Code Visuals Modal] Missing location data for node:', {
                            nodeId: capturedNodeId,
                            location: capturedLocation
                        });
                        alert('Code info is missing');
                        return;
                    }
                    
                    console.log('[Code Visuals Modal] Calling postCommand to open file:', {
                        command: 'samurai-agent.openFileAtLine',
                        file: capturedLocation.filePath,
                        line: capturedLocation.line
                    });
                    
                    // Call VS Code API to open file at line
                    await globalScope.WebviewApi.postCommand('samurai-agent.openFileAtLine', {
                        file: capturedLocation.filePath,
                        line: capturedLocation.line
                    });
                    
                    console.log('[Code Visuals Modal] Successfully opened file:', capturedLocation.filePath, 'at line', capturedLocation.line);
                } catch (error) {
                    console.error('[Code Visuals Modal] Failed to open file:', error);
                    console.error('[Code Visuals Modal] Error details:', {
                        message: error.message,
                        stack: error.stack,
                        nodeId: capturedNodeId,
                        location: capturedLocation
                    });
                    alert(`Failed to open file: ${error.message || 'Unknown error'}`);
                }
            };
            
            // Add mousedown handler to stop propagation to pan handler
            // This ensures the pan handler knows we're on a clickable node
            const mousedownHandler = (event) => {
                // Stop propagation to prevent pan handler from interfering
                event.stopPropagation();
                event.stopImmediatePropagation();
                
                // Mark that we're on a clickable node
                clickedOnNode = true;
                
                console.log('[Code Visuals Modal] Node mousedown:', { 
                    nodeId: capturedNodeId,
                    target: event.target
                });
            };

            const nodeMetadata = nodeInfoMap[capturedNodeId];
            const hasTooltipAnalysis = typeof nodeMetadata?.analysis === 'string' && nodeMetadata.analysis.trim().length > 0;
            const tooltipHtml = hasTooltipAnalysis ? buildMermaidTooltipHtml(nodeMetadata) : '';

            const mouseEnterHandler = (event) => {
                if (!hasTooltipAnalysis || !tooltipHtml) {
                    return;
                }
                showMermaidTooltip(tooltipHtml, event.clientX, event.clientY);
            };

            const mouseMoveHandler = (event) => {
                if (!hasTooltipAnalysis || !tooltipHtml) {
                    return;
                }
                updateMermaidTooltipPosition(event.clientX, event.clientY);
            };

            const mouseLeaveHandler = () => {
                if (!hasTooltipAnalysis) {
                    return;
                }
                hideMermaidTooltip();
            };
            
            nodeElement.addEventListener('click', clickHandler);
            nodeElement.addEventListener('mousedown', mousedownHandler);
            if (hasTooltipAnalysis) {
                nodeElement.addEventListener('mouseenter', mouseEnterHandler);
                nodeElement.addEventListener('mouseleave', mouseLeaveHandler);
                nodeElement.addEventListener('mousemove', mouseMoveHandler);
            }
            
            // Also attach to clickable child shapes for better click target
            clickableElements.forEach((shape) => {
                shape.style.cursor = 'pointer';
                shape.setAttribute('data-clickable-node', 'true');
                shape.addEventListener('click', clickHandler);
                shape.addEventListener('mousedown', mousedownHandler);
                if (hasTooltipAnalysis) {
                    shape.addEventListener('mouseenter', mouseEnterHandler);
                    shape.addEventListener('mouseleave', mouseLeaveHandler);
                    shape.addEventListener('mousemove', mouseMoveHandler);
                }
            });
            
            handlersAttached++;
        }
        
        // Log results
        if (handlersAttached > 0) {
            console.log(`[Code Visuals Modal] Successfully attached click handlers to ${handlersAttached} nodes`);
            if (unmatchedNodes.length > 0) {
                console.warn(`[Code Visuals Modal] Could not find ${unmatchedNodes.length} nodes in SVG:`, unmatchedNodes.slice(0, 5));
                if (unmatchedNodes.length > 5) {
                    console.warn(`[Code Visuals Modal] ... and ${unmatchedNodes.length - 5} more`);
                }
            }
        } else {
            console.error('[Code Visuals Modal] No click handlers attached!');
            console.error('[Code Visuals Modal] nodeLocationMap has', nodeIdsInMap.length, 'entries');
            console.error('[Code Visuals Modal] Sample node IDs in map:', nodeIdsInMap.slice(0, 3));
            if (allGroupIds.length > 0) {
                console.error('[Code Visuals Modal] Sample group IDs in SVG:', allGroupIds.slice(0, 3).map(g => g.id || g.class));
            }
        }
    }

    function closeCodeVisualsModal() {
        const modal = safeGetDocumentElement('code-visuals-modal');
        if (modal) {
            modal.style.display = 'none';
            clearChatOverlapOffset();
            // Reset zoom when modal is closed
            resetZoom();
            hideMermaidTooltip();
        }
    }

    /**
     * Checks if an element is a clickable node or within a clickable node
     * @param {HTMLElement} element - The element to check
     * @returns {boolean} True if the element is a clickable node
     */
    function isClickableNode(element) {
        if (!element) return false;
        
        // Check for data-clickable-node attribute (most reliable method)
        let current = element;
        while (current && current !== document.body) {
            if (current.getAttribute && current.getAttribute('data-clickable-node') === 'true') {
                return true;
            }
            current = current.parentElement;
        }
        
        // Fallback: Check if element has pointer cursor (set by attachMermaidNodeClickHandlers)
        if (element.style && element.style.cursor === 'pointer') {
            return true;
        }
        
        // Fallback: Check if element is within a node group (g element with node class or id)
        current = element;
        while (current && current !== document.body) {
            // Check if it's a node group element
            if (current.tagName === 'g') {
                const id = current.getAttribute('id') || '';
                const className = current.getAttribute('class') || '';
                if (id.includes('flowchart') || id.includes('graph') || 
                    className.includes('node') || (current.style && current.style.cursor === 'pointer')) {
                    return true;
                }
            }
            // Check if it's a clickable shape within a node
            if (['rect', 'circle', 'ellipse', 'polygon', 'path'].includes(current.tagName.toLowerCase())) {
                if (current.style && current.style.cursor === 'pointer') {
                    return true;
                }
            }
            current = current.parentElement;
        }
        
        return false;
    }

    // Zoom state management
    let currentZoomLevel = 250; // Default zoom level (initially zoomed in)
    const MIN_ZOOM = 50;
    const MAX_ZOOM = 1000;
    const ZOOM_STEP = 50;
    
    // Pan state management
    let panX = 0;
    let panY = 0;
    let isDragging = false;
    let dragStartX = 0;
    let dragStartY = 0;
    let startPanX = 0;
    let startPanY = 0;
    let clickedOnNode = false; // Track if mousedown started on a clickable node

    /**
     * Applies zoom and pan transforms to the mermaid diagram
     */
    function applyZoom() {
        const mermaidContainer = safeGetDocumentElement('code-visuals-mermaid');
        if (!mermaidContainer) return;

        const zoomWrapper = mermaidContainer.querySelector('.code-visuals-zoom-wrapper');
        if (!zoomWrapper) return;

        const scale = currentZoomLevel / 100;
        zoomWrapper.style.transform = `translate(${panX}px, ${panY}px) scale(${scale})`;
        
        // Disable transition during active dragging for smooth panning
        if (isDragging) {
            zoomWrapper.style.transition = 'none';
        } else {
            zoomWrapper.style.transition = 'transform 0.2s ease';
        }
        
        // Update button states
        updateZoomButtonStates();
    }

    /**
     * Updates zoom button enabled/disabled states
     */
    function updateZoomButtonStates() {
        const zoomInBtn = safeGetDocumentElement('code-visuals-zoom-in');
        const zoomOutBtn = safeGetDocumentElement('code-visuals-zoom-out');
        const zoomResetBtn = safeGetDocumentElement('code-visuals-zoom-reset');

        if (zoomInBtn) {
            zoomInBtn.disabled = currentZoomLevel >= MAX_ZOOM;
        }
        if (zoomOutBtn) {
            zoomOutBtn.disabled = currentZoomLevel <= MIN_ZOOM;
        }
        if (zoomResetBtn) {
            zoomResetBtn.disabled = currentZoomLevel === 100;
        }
    }

    /**
     * Zooms in the diagram
     */
    function zoomIn() {
        if (currentZoomLevel < MAX_ZOOM) {
            currentZoomLevel = Math.min(currentZoomLevel + ZOOM_STEP, MAX_ZOOM);
            applyZoom();
        }
    }

    /**
     * Zooms out the diagram
     */
    function zoomOut() {
        if (currentZoomLevel > MIN_ZOOM) {
            currentZoomLevel = Math.max(currentZoomLevel - ZOOM_STEP, MIN_ZOOM);
            applyZoom();
        }
    }

    /**
     * Resets zoom to 100% and pan position to origin
     */
    function resetZoom() {
        currentZoomLevel = 100;
        panX = 0;
        panY = 0;
        applyZoom();
    }

    // Initialize code visuals button handlers and resize functionality
    if (typeof document !== 'undefined') {
        document.addEventListener('DOMContentLoaded', function() {
            const showButton = safeGetDocumentElement('show-code-visuals-btn');
            const closeButton = safeGetDocumentElement('code-visuals-close');
            const modal = safeGetDocumentElement('code-visuals-modal');
            const resizeHandle = safeGetDocumentElement('code-visuals-resize-handle');
            const zoomInBtn = safeGetDocumentElement('code-visuals-zoom-in');
            const zoomOutBtn = safeGetDocumentElement('code-visuals-zoom-out');
            const zoomResetBtn = safeGetDocumentElement('code-visuals-zoom-reset');
            initializeModalHeight(modal);
            window.addEventListener('resize', () => applyChatOverlapOffset(modal));
            
            if (showButton) {
                showButton.addEventListener('click', handleShowCodeVisualsClick);
            }
            
            if (closeButton) {
                closeButton.addEventListener('click', closeCodeVisualsModal);
            }
            
            // Zoom button handlers
            if (zoomInBtn) {
                zoomInBtn.addEventListener('click', function(e) {
                    e.preventDefault();
                    e.stopPropagation();
                    zoomIn();
                });
            }
            
            if (zoomOutBtn) {
                zoomOutBtn.addEventListener('click', function(e) {
                    e.preventDefault();
                    e.stopPropagation();
                    zoomOut();
                });
            }
            
            if (zoomResetBtn) {
                zoomResetBtn.addEventListener('click', function(e) {
                    e.preventDefault();
                    e.stopPropagation();
                    resetZoom();
                });
            }
            
            // Keyboard shortcuts for zoom (only when modal is open)
            document.addEventListener('keydown', function(e) {
                const modal = safeGetDocumentElement('code-visuals-modal');
                if (!modal || modal.style.display === 'none') {
                    return; // Modal is not open
                }
                
                // Check for Ctrl (Windows/Linux) or Cmd (Mac)
                const isModifierPressed = e.ctrlKey || e.metaKey;
                
                if (isModifierPressed) {
                    // Zoom in: Ctrl/Cmd + Plus or Ctrl/Cmd + =
                    // Handle both '=' (equals key) and '+' (plus key)
                    if (e.key === '+' || e.key === '=') {
                        e.preventDefault();
                        zoomIn();
                    }
                    // Zoom out: Ctrl/Cmd + Minus
                    else if (e.key === '-' || e.key === '_') {
                        e.preventDefault();
                        zoomOut();
                    }
                    // Reset zoom: Ctrl/Cmd + 0
                    else if (e.key === '0' && !e.shiftKey) {
                        e.preventDefault();
                        resetZoom();
                    }
                }
            });
            
            // Height-only resizing functionality
            if (resizeHandle && modal) {
                let isResizing = false;
                let startY = 0;
                let startHeight = 0;
                
                resizeHandle.addEventListener('mousedown', function(e) {
                    isResizing = true;
                    startY = e.clientY;
                    startHeight = clampModalHeight(getModalCurrentHeight(modal), getDefaultModalHeight());
                    document.body.style.cursor = 'ns-resize';
                    e.preventDefault();
                });
                
                document.addEventListener('mousemove', function(e) {
                    if (!isResizing) return;
                    
                    const deltaY = e.clientY - startY;
                    applyModalHeight(modal, startHeight + deltaY);
                });
                
                document.addEventListener('mouseup', function() {
                    if (isResizing) {
                        isResizing = false;
                        document.body.style.cursor = '';
                        applyModalHeight(modal, getModalCurrentHeight(modal));
                    }
                });
            }
            
            // Initialize zoom button states
            updateZoomButtonStates();
            
            // Drag-to-pan functionality for mermaid diagram
            const mermaidContainer = safeGetDocumentElement('code-visuals-mermaid');
            if (mermaidContainer) {
                const DRAG_THRESHOLD = 5; // pixels - minimum movement to start panning
                let isMouseDown = false;
                let mousedownTarget = null; // Track the original mousedown target
                
                mermaidContainer.addEventListener('mousedown', function(e) {
                    // Check if this mousedown started on a clickable node
                    // We need to check the actual target, not just if propagation was stopped
                    const target = e.target;
                    const isOnClickableNode = isClickableNode(target);
                    
                    // Always track initial position for movement calculation
                    dragStartX = e.clientX;
                    dragStartY = e.clientY;
                    startPanX = panX;
                    startPanY = panY;
                    mousedownTarget = target;
                    
                    if (isOnClickableNode) {
                        // Don't start pan detection if clicking on a node
                        // The node's click handler will handle it
                        // But track position in case user drags instead of clicks
                        clickedOnNode = true;
                        isMouseDown = false; // Don't start pan detection yet
                        return;
                    }
                    
                    // Not on a clickable node - start pan detection
                    clickedOnNode = false;
                    isMouseDown = true;
                    mermaidContainer.style.userSelect = 'none';
                });
                
                document.addEventListener('mousemove', function(e) {
                    if (!isMouseDown && !clickedOnNode) return;
                    
                    // If we started on a clickable node, check if user is actually dragging
                    if (clickedOnNode && mousedownTarget) {
                        const deltaX = Math.abs(e.clientX - dragStartX);
                        const deltaY = Math.abs(e.clientY - dragStartY);
                        
                        // Only start dragging if movement exceeds threshold
                        // This allows clicks even with slight movement
                        if (deltaX > DRAG_THRESHOLD || deltaY > DRAG_THRESHOLD) {
                            // User is dragging, not clicking - start pan
                            clickedOnNode = false;
                            isDragging = true;
                            isMouseDown = true;
                            mermaidContainer.style.cursor = 'grabbing';
                            mermaidContainer.style.userSelect = 'none';
                        } else {
                            // Movement is below threshold - still a click, don't interfere
                            return;
                        }
                    }
                    
                    // Normal pan detection for non-clickable areas
                    if (!isDragging && isMouseDown) {
                        const deltaX = Math.abs(e.clientX - dragStartX);
                        const deltaY = Math.abs(e.clientY - dragStartY);
                        
                        // Start panning if movement exceeds threshold
                        if (deltaX > DRAG_THRESHOLD || deltaY > DRAG_THRESHOLD) {
                            isDragging = true;
                            mermaidContainer.style.cursor = 'grabbing';
                            mermaidContainer.style.userSelect = 'none';
                        }
                    }
                    
                    if (isDragging) {
                        const moveDeltaX = e.clientX - dragStartX;
                        const moveDeltaY = e.clientY - dragStartY;
                        
                        panX = startPanX + moveDeltaX;
                        panY = startPanY + moveDeltaY;
                        
                        applyZoom();
                        e.preventDefault();
                    }
                });
                
                document.addEventListener('mouseup', function(e) {
                    // If we clicked on a node and didn't drag, let the click handler fire
                    if (clickedOnNode && !isDragging) {
                        // Reset state but don't interfere with click event
                        clickedOnNode = false;
                        mousedownTarget = null;
                        isMouseDown = false;
                        dragStartX = 0;
                        dragStartY = 0;
                        return;
                    }
                    
                    if (isDragging) {
                        isDragging = false;
                        mermaidContainer.style.cursor = 'grab';
                        mermaidContainer.style.userSelect = '';
                    }
                    
                    // Reset drag tracking
                    clickedOnNode = false;
                    mousedownTarget = null;
                    isMouseDown = false;
                    dragStartX = 0;
                    dragStartY = 0;
                });
                
                // Set initial cursor style
                mermaidContainer.style.cursor = 'grab';
            }
        });
    }


    function renderLLMDebugInfo(container, debugInfo, version) {
        if (!container) return;
        
        // Check version compatibility
        if (version && version !== 1) {
            console.warn('[LLM DEBUG] Unknown version:', version);
        }
        
        if (!debugInfo || debugInfo.length === 0) {
            container.innerHTML = '';
            container.style.display = 'none';
            return;
        }
        
        const section = document.createElement('div');
        section.className = 'llm-debug-section';
        
        // Header with toggle
        let isExpanded = false;
        const header = document.createElement('div');
        header.className = 'llm-debug-header';
        header.innerHTML = `
            <button class="llm-debug-toggle">
                <span class="llm-debug-toggle-icon">▶</span>
                <span class="llm-debug-title">🔍 LLM Debug Info (${debugInfo.length} call${debugInfo.length !== 1 ? 's' : ''})</span>
            </button>
        `;
        
        const content = document.createElement('div');
        content.className = 'llm-debug-content';
        content.style.display = 'none';
        
        // Toggle handler
        const toggleBtn = header.querySelector('.llm-debug-toggle');
        toggleBtn.addEventListener('click', () => {
            isExpanded = !isExpanded;
            content.style.display = isExpanded ? 'block' : 'none';
            const icon = header.querySelector('.llm-debug-toggle-icon');
            icon.textContent = isExpanded ? '▼' : '▶';
        });
        
        // Render each LLM call
        debugInfo.forEach((call, index) => {
            const callCard = document.createElement('div');
            callCard.className = 'llm-debug-call';
            
            // Stage badge
            const stageColors = {
                'hypothesis-generation': '#4285f4',
                'hypothesis-testing': '#34a853',
                'feedback-refinement': '#9c27b0',
                'other': '#666'
            };
            const stageColor = stageColors[call.stage] || '#666';
            
            callCard.innerHTML = `
                <div class="llm-debug-call-header">
                    <span class="llm-debug-stage-badge" style="background-color: ${stageColor}">
                        ${call.stage.replace(/-/g, ' ')}
                    </span>
                    <span class="llm-debug-time">
                        ${new Date(call.timestamp).toLocaleTimeString()}
                        ${call.response ? ` (${call.response.duration}ms)` : ''}
                    </span>
                </div>
            `;
            
            // Error-only rendering
            if (call.error) {
                const errorContent = document.createElement('div');
                errorContent.className = 'llm-debug-error';
                errorContent.innerHTML = `
                    <div class="llm-debug-error-message">
                        <strong>Error:</strong> ${escapeHtml(call.error)}
                    </div>
                    ${call.request.prompt ? `
                        <div class="llm-debug-error-prompt-preview">
                            <strong>Prompt preview:</strong><br>
                            <code>${escapeHtml(call.request.prompt.substring(0, 100))}...</code>
                        </div>
                    ` : ''}
                `;
                callCard.appendChild(errorContent);
                content.appendChild(callCard);
                return;
            }
            
            // Normal call rendering
            const callBody = document.createElement('div');
            callBody.className = 'llm-debug-call-body';
            
            // Request details
            const requestSection = document.createElement('div');
            requestSection.className = 'llm-debug-request';
            requestSection.innerHTML = `
                <strong>Request:</strong>
                <div class="llm-debug-params">
                    Model: ${call.request.model}, Temp: ${call.request.temperature}, MaxTokens: ${call.request.maxTokens}
                </div>
            `;
            callBody.appendChild(requestSection);
            
            // Prompt (expandable)
            const promptSection = document.createElement('details');
            promptSection.className = 'llm-debug-expandable';
            promptSection.innerHTML = `
                <summary>Prompt (${call.request.prompt.length} chars)</summary>
                <textarea readonly class="llm-debug-code-snippet">${escapeHtml(call.request.prompt)}</textarea>
                ${call.request.prompt.includes('[truncated]') ? '<div class="llm-debug-truncated">⚠ Truncated (8000 char limit)</div>' : ''}
            `;
            callBody.appendChild(promptSection);
            
            // Code snippets
            if (call.request.codeSnippets && call.request.codeSnippets.length > 0) {
                const snippetsSection = document.createElement('details');
                snippetsSection.className = 'llm-debug-expandable';
                snippetsSection.innerHTML = `<summary>Code Snippets (${call.request.codeSnippets.length})</summary>`;
                
                const snippetsList = document.createElement('div');
                call.request.codeSnippets.forEach((snippet, idx) => {
                    const snippetDiv = document.createElement('div');
                    snippetDiv.className = 'llm-debug-code-snippet-wrapper';
                    const fileName = snippet.file || 'unknown file';
                    const truncated = snippet.code.includes('[truncated]');
                    snippetDiv.innerHTML = `
                        <div class="llm-debug-code-snippet-header">
                            <strong>${escapeHtml(fileName)}</strong>
                            ${snippet.reason ? `<span class="llm-debug-snippet-reason">${escapeHtml(snippet.reason)}</span>` : ''}
                        </div>
                        <textarea readonly class="llm-debug-code-snippet">${escapeHtml(snippet.code)}</textarea>
                        ${truncated ? '<div class="llm-debug-truncated">⚠ Truncated</div>' : ''}
                    `;
                    snippetsList.appendChild(snippetDiv);
                });
                snippetsSection.appendChild(snippetsList);
                callBody.appendChild(snippetsSection);
            }
            
            // Graph snippet
            if (call.request.graphSnippet) {
                const graphSection = document.createElement('details');
                graphSection.className = 'llm-debug-expandable';
                graphSection.innerHTML = `
                    <summary>Graph Snippet</summary>
                    <pre class="llm-debug-code-snippet">${escapeHtml(call.request.graphSnippet)}</pre>
                    ${call.request.graphSnippet.includes('[truncated]') ? '<div class="llm-debug-truncated">⚠ Truncated</div>' : ''}
                `;
                callBody.appendChild(graphSection);
            }
            
            // Response
            if (call.response) {
                const responseSection = document.createElement('details');
                responseSection.className = 'llm-debug-expandable';
                const tokensInfo = call.response.tokensUsed ? `, ${call.response.tokensUsed} tokens` : '';
                responseSection.innerHTML = `
                    <summary>Response (${call.response.content.length} chars${tokensInfo})</summary>
                    <textarea readonly class="llm-debug-code-snippet">${escapeHtml(call.response.content)}</textarea>
                    ${call.response.content.includes('[truncated]') ? '<div class="llm-debug-truncated">⚠ Truncated</div>' : ''}
                `;
                callBody.appendChild(responseSection);
            }
            
            callCard.appendChild(callBody);
            content.appendChild(callCard);
        });
        
        section.appendChild(header);
        section.appendChild(content);
        
        container.innerHTML = '';
        container.appendChild(section);
        container.style.display = 'block';
    }


    // Export code visuals manager
    if (globalScope) {
        globalScope.CodeVisualsManager = {
            updateShowCodeVisualsButton,
            handleShowCodeVisualsClick,
            renderCodeVisualsModal,
            closeCodeVisualsModal
        };
        
        // Export renderMarkdown for testing
        globalScope.renderMarkdown = renderMarkdown;
    }

    // Add visibility observer to refresh dropdown when chat tab becomes visible
    if (typeof document !== 'undefined' && typeof globalScope.ChatManager !== 'undefined') {
        const setupVisibilityObserver = () => {
            const chatContent = document.getElementById('chat-content');
            if (chatContent) {
                const observer = new MutationObserver(() => {
                    if (chatContent.style.display !== 'none' && globalScope.ChatManager) {
                        console.log('[Chat] Chat tab became visible, refreshing dropdown');
                        setTimeout(() => {
                            if (globalScope.ChatManager.refreshLLMModelDropdown) {
                                globalScope.ChatManager.refreshLLMModelDropdown();
                            }
                        }, 100);
                    }
                });
                
                observer.observe(chatContent, { attributes: true, attributeFilter: ['style'] });
                console.log('[Chat] Visibility observer set up for chat tab');
            }
        };
        
        if (document.readyState === 'loading') {
            document.addEventListener('DOMContentLoaded', setupVisibilityObserver);
        } else {
            setupVisibilityObserver();
        }
    }

})(typeof window !== 'undefined' ? window : undefined);

if (typeof module !== 'undefined') {
    const exportsForTests = require('./chat.js');
    module.exports = exportsForTests;
}
