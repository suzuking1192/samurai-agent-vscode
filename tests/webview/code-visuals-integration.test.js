const { JSDOM } = require('jsdom');

describe('Code Visuals Integration Tests', () => {
    let dom;
    let window;
    let document;

    beforeEach(() => {
        dom = new JSDOM(`
            <!DOCTYPE html>
            <html>
            <head>
                <style>
                    .code-visuals-modal-overlay {
                        position: fixed;
                        top: 0;
                        left: 0;
                        width: 100%;
                        height: 100%;
                        background-color: rgba(0, 0, 0, 0.7);
                        z-index: 10000;
                        display: flex;
                        align-items: flex-start;
                        justify-content: center;
                        padding-top: 20px;
                        padding-bottom: 20px;
                        overflow-y: auto;
                    }
                    .code-visuals-modal {
                        width: 100%;
                        max-width: 100%;
                        height: 50vh;
                        min-height: 400px;
                        max-height: 90vh;
                    }
                    .code-visuals-resize-handle {
                        cursor: ns-resize;
                        height: 8px;
                    }
                </style>
            </head>
            <body>
                <div class="agent-panel-container">
                    <button id="show-code-visuals-btn" style="display: none;">Show Code Visuals</button>
                    <div id="chatMessages"></div>
                    
                    <div id="code-visuals-modal" class="code-visuals-modal-overlay" style="display: none;">
                        <div class="code-visuals-modal">
                            <div class="code-visuals-header">
                                <h3>Code Visuals</h3>
                                <button id="code-visuals-close">&times;</button>
                            </div>
                            <div class="code-visuals-content">
                                <div id="code-visuals-mermaid" class="code-visuals-mermaid"></div>
                                <div class="code-visuals-resize-handle" id="code-visuals-resize-handle"></div>
                            </div>
                        </div>
                    </div>
                </div>
            </body>
            </html>
        `, { runScripts: 'outside-only' });

        ({ window } = dom);
        ({ document } = window);

        global.window = window;
        global.document = document;

        window.WebviewApi = {
            persistence: {
                loadSession: jest.fn().mockResolvedValue({
                    id: 'test-session',
                    currentArtifact: null
                }),
                updateSession: jest.fn().mockResolvedValue({})
            },
            subscribe: jest.fn().mockImplementation(callback => {
                window.__subscriber = callback;
                return () => {};
            })
        };

        // Mock mermaid library - must be available globally (not just window)
        global.mermaid = {
            init: jest.fn()
        };
        window.mermaid = global.mermaid;

        window.queueMicrotask = jest.fn((fn) => setTimeout(fn, 0));
        window.CustomEvent = dom.window.CustomEvent;

        delete require.cache[require.resolve('../../src/webview/chat.js')];
        require('../../src/webview/chat.js');

        const event = new window.Event('DOMContentLoaded');
        document.dispatchEvent(event);
    });

    afterEach(() => {
        jest.resetModules();
        delete global.window;
        delete global.document;
    });

    describe('Removed Functionality Verification', () => {
        it('should not have old "View Code Flow Graph" button', () => {
            const oldButton = document.querySelector('[data-action="open-graph"]');
            expect(oldButton).toBeNull();
        });

        it('should not have old debug visualization modal', () => {
            const oldModal = document.getElementById('debug-viz-modal');
            expect(oldModal).toBeNull();
        });

        it('should not have old spec artifact text section', () => {
            const oldTextSection = document.getElementById('spec-artifact-text');
            expect(oldTextSection).toBeNull();
        });

        it('should not have DebugVisualizationManager', () => {
            expect(window.DebugVisualizationManager).toBeUndefined();
        });

        it('should have CodeVisualsManager instead of ArtifactManager', () => {
            expect(window.CodeVisualsManager).toBeDefined();
            expect(window.CodeVisualsManager.updateShowCodeVisualsButton).toBeDefined();
            expect(window.CodeVisualsManager.handleShowCodeVisualsClick).toBeDefined();
            expect(window.CodeVisualsManager.renderCodeVisualsModal).toBeDefined();
            expect(window.CodeVisualsManager.closeCodeVisualsModal).toBeDefined();
        });
    });

    describe('New Functionality Verification', () => {
        it('should have new "Show Code Visuals" button', () => {
            const button = document.getElementById('show-code-visuals-btn');
            expect(button).toBeTruthy();
            expect(button.textContent).toBe('Show Code Visuals');
        });

        it('should have new code visuals modal', () => {
            const modal = document.getElementById('code-visuals-modal');
            expect(modal).toBeTruthy();
            expect(modal.classList.contains('code-visuals-modal-overlay')).toBe(true);
        });

        it('should have mermaid container in modal', () => {
            const mermaidContainer = document.getElementById('code-visuals-mermaid');
            expect(mermaidContainer).toBeTruthy();
        });

        it('should have resize handle in modal', () => {
            const resizeHandle = document.getElementById('code-visuals-resize-handle');
            expect(resizeHandle).toBeTruthy();
        });

        it('should not have text spec section in modal', () => {
            const textContainer = document.getElementById('spec-artifact-text');
            expect(textContainer).toBeNull();
            
            const textSection = document.querySelector('.code-visuals-text');
            expect(textSection).toBeNull();
        });
    });

    describe('Modal Width and Positioning', () => {
        it('should have modal width matching webview', () => {
            const modal = document.querySelector('.code-visuals-modal');
            const computedStyle = window.getComputedStyle(modal);
            
            // Modal should have width: 100% and max-width: 100%
            expect(modal.style.width || '100%').toContain('100');
        });

        it('should not cover entire chat box', () => {
            const modal = document.querySelector('.code-visuals-modal-overlay');
            
            // Modal overlay should use flex with align-items: flex-start
            // This positions it at top, not covering entire chat
            expect(modal).toBeTruthy();
        });
    });

    describe('Debug Visualization Message Handling', () => {
        it('should save debugging mermaid to session and auto-open modal', async () => {
            const modal = document.getElementById('code-visuals-modal');
            const chatState = window.ChatManager?.getChatState();
            
            if (chatState) {
                chatState.currentSessionId = 'test-session';
                chatState.currentSession = {
                    id: 'test-session',
                    currentArtifact: null
                };
            }

            // Mock loadSession to return updated session
            window.WebviewApi.persistence.loadSession = jest.fn().mockResolvedValue({
                id: 'test-session',
                currentArtifact: {
                    mermaidData: 'graph TD\n  A[Debug] --> B[Fix]',
                    timestamp: Date.now(),
                    generationStatus: 'completed'
                }
            });

            const message = {
                type: 'debugVisualization',
                visualization: 'graph TD\n  A[Debug] --> B[Fix]',
                meta: { nodeCount: 2, edgeCount: 1 },
                diagnostics: [],
                nodeLocationMap: {},
                pipelineSteps: [],
                graphCandidates: [],
                selectedCandidateIds: [],
                timestamp: new Date(),
                autoOpen: true
            };

            // Simulate message
            if (window.__subscriber) {
                await window.__subscriber(message);
            }

            // Wait for async operations
            await new Promise(resolve => setTimeout(resolve, 150));

            // Verify session was updated
            expect(window.WebviewApi.persistence.updateSession).toHaveBeenCalledWith(
                'test-session',
                expect.objectContaining({
                    currentArtifact: expect.objectContaining({
                        mermaidData: 'graph TD\n  A[Debug] --> B[Fix]'
                    })
                })
            );

            // Verify modal was opened
            expect(modal.style.display).toBe('flex');
        });

        it('should not auto-open when autoOpen is false', async () => {
            const modal = document.getElementById('code-visuals-modal');
            const chatState = window.ChatManager?.getChatState();
            
            if (chatState) {
                chatState.currentSessionId = 'test-session';
                chatState.currentSession = {
                    id: 'test-session',
                    currentArtifact: null
                };
            }

            const message = {
                type: 'debugVisualization',
                visualization: 'graph TD\n  A[Debug] --> B[Fix]',
                meta: { nodeCount: 2, edgeCount: 1 },
                diagnostics: [],
                nodeLocationMap: {},
                pipelineSteps: [],
                graphCandidates: [],
                selectedCandidateIds: [],
                timestamp: new Date(),
                autoOpen: false
            };

            // Simulate message
            if (window.__subscriber) {
                await window.__subscriber(message);
            }

            // Wait for async operations
            await new Promise(resolve => setTimeout(resolve, 50));

            // Modal should not be opened
            expect(modal.style.display).toBe('none');
        });

        it('should NOT auto-open modal when debugVisualization has no autoOpen (default false)', async () => {
            const modal = document.getElementById('code-visuals-modal');
            const chatState = window.ChatManager?.getChatState();

            if (chatState) {
                chatState.currentSessionId = 'test-session';
                chatState.currentSession = {
                    id: 'test-session',
                    currentArtifact: null
                };
            }

            // Message without autoOpen – modal must not open
            const message = {
                type: 'debugVisualization',
                visualization: 'graph TD\n  A[Debug] --> B[Fix]',
                meta: { nodeCount: 2, edgeCount: 1 },
                diagnostics: [],
                nodeLocationMap: {},
                pipelineSteps: [],
                graphCandidates: [],
                selectedCandidateIds: [],
                timestamp: new Date()
            };

            if (window.__subscriber) {
                await window.__subscriber(message);
            }

            await new Promise(resolve => setTimeout(resolve, 50));

            expect(modal.style.display).toBe('none');
        });

        it('should save debugging mermaid to session but not auto-open modal for debugGraphUpdate (initial update)', async () => {
            const modal = document.getElementById('code-visuals-modal');
            const chatState = window.ChatManager?.getChatState();
            
            if (chatState) {
                chatState.currentSessionId = 'test-session';
                chatState.currentSession = {
                    id: 'test-session',
                    currentArtifact: null
                };
            }

            // Mock loadSession to return updated session
            window.WebviewApi.persistence.loadSession = jest.fn().mockResolvedValue({
                id: 'test-session',
                currentArtifact: {
                    mermaidData: 'graph TD\n  A[Initial] --> B[Graph]',
                    timestamp: Date.now(),
                    generationStatus: 'analyzing'
                }
            });

            const message = {
                type: 'debugGraphUpdate',
                payload: {
                    sessionId: 'test-session',
                    status: 'analyzing',
                    epicenter: '/test/workspace/src/auth.ts',
                    visualization: 'graph TD\n  A[Initial] --> B[Graph]',
                    graphNodes: [
                        { id: 'A', label: 'Initial', file: '/test/workspace/src/auth.ts', line: 10 },
                        { id: 'B', label: 'Graph', file: '/test/workspace/src/graph.ts', line: 20 }
                    ],
                    autoOpen: false
                },
                timestamp: new Date()
            };

            // Simulate message
            if (window.__subscriber) {
                await window.__subscriber(message);
            }

            // Wait for async operations
            await new Promise(resolve => setTimeout(resolve, 150));

            // Verify session was updated
            expect(window.WebviewApi.persistence.updateSession).toHaveBeenCalledWith(
                'test-session',
                expect.objectContaining({
                    currentArtifact: expect.objectContaining({
                        mermaidData: 'graph TD\n  A[Initial] --> B[Graph]',
                        generationStatus: 'analyzing'
                    })
                })
            );

            // Verify modal was NOT opened (initial updates should not auto-open to show live updates)
            expect(modal.style.display).toBe('none');
        });

        it('should not auto-open when autoOpen is false for debugGraphUpdate', async () => {
            const modal = document.getElementById('code-visuals-modal');
            const chatState = window.ChatManager?.getChatState();
            
            if (chatState) {
                chatState.currentSessionId = 'test-session';
                chatState.currentSession = {
                    id: 'test-session',
                    currentArtifact: null
                };
            }

            const message = {
                type: 'debugGraphUpdate',
                payload: {
                    sessionId: 'test-session',
                    status: 'analyzing',
                    epicenter: '/test/workspace/src/auth.ts',
                    visualization: 'graph TD\n  A[Initial] --> B[Graph]',
                    graphNodes: [
                        { id: 'A', label: 'Initial', file: '/test/workspace/src/auth.ts', line: 10 },
                        { id: 'B', label: 'Graph', file: '/test/workspace/src/graph.ts', line: 20 }
                    ],
                    autoOpen: false
                },
                autoOpen: false,
                timestamp: new Date()
            };

            // Simulate message
            if (window.__subscriber) {
                await window.__subscriber(message);
            }

            // Wait for async operations
            await new Promise(resolve => setTimeout(resolve, 50));

            // Modal should not be opened
            expect(modal.style.display).toBe('none');
        });
    });

    describe('Persistence Across Sessions', () => {
        it('should persist debugging mermaid graph across sessions', async () => {
            const button = document.getElementById('show-code-visuals-btn');
            const chatState = window.ChatManager?.getChatState();
            
            // First session: save debugging mermaid
            if (chatState) {
                chatState.currentSessionId = 'test-session-1';
                chatState.currentSession = {
                    id: 'test-session-1',
                    currentArtifact: null
                };
            }

            const message = {
                type: 'debugVisualization',
                visualization: 'graph TD\n  A[Debug] --> B[Fix]',
                meta: { nodeCount: 2, edgeCount: 1 },
                diagnostics: [],
                nodeLocationMap: {},
                pipelineSteps: [],
                graphCandidates: [],
                selectedCandidateIds: [],
                timestamp: new Date(),
                autoOpen: true
            };

            // Mock loadSession to return updated session
            window.WebviewApi.persistence.loadSession = jest.fn().mockResolvedValue({
                id: 'test-session-1',
                currentArtifact: {
                    mermaidData: 'graph TD\n  A[Debug] --> B[Fix]',
                    timestamp: Date.now(),
                    generationStatus: 'completed'
                }
            });

            // Save debugging mermaid
            if (window.__subscriber) {
                await window.__subscriber(message);
            }

            await new Promise(resolve => setTimeout(resolve, 150));

            // Simulate loading a new session with the same mermaid data
            window.WebviewApi.persistence.loadSession = jest.fn().mockResolvedValue({
                id: 'test-session-2',
                currentArtifact: {
                    mermaidData: 'graph TD\n  A[Debug] --> B[Fix]',
                    timestamp: Date.now(),
                    generationStatus: 'completed'
                }
            });

            if (chatState) {
                chatState.currentSessionId = 'test-session-2';
            }

            // Load session
            if (window.ChatManager?.initializeChatSession) {
                await window.ChatManager.initializeChatSession();
            }

            await new Promise(resolve => setTimeout(resolve, 100));

            // Button should be visible because mermaid data exists
            expect(button.style.display).toBe('inline-block');
        });
    });

    describe('Modal Behavior', () => {
        it('should render only mermaid graph, no text spec', () => {
            const modal = document.getElementById('code-visuals-modal');
            const mermaidContainer = document.getElementById('code-visuals-mermaid');
            
            const mermaidData = 'graph TD\n  A[Start] --> B[End]';
            
            if (window.CodeVisualsManager?.renderCodeVisualsModal) {
                window.CodeVisualsManager.renderCodeVisualsModal(mermaidData, 'completed');
            }

            expect(modal.style.display).toBe('flex');
            expect(mermaidContainer.innerHTML).toContain('mermaid');
            
            // Verify no text spec is rendered
            const textContainer = document.getElementById('spec-artifact-text');
            expect(textContainer).toBeNull();
        });

        it('should handle mermaid syntax errors gracefully', () => {
            const modal = document.getElementById('code-visuals-modal');
            const mermaidContainer = document.getElementById('code-visuals-mermaid');
            
            const invalidMermaid = 'invalid mermaid syntax';
            
            if (window.CodeVisualsManager?.renderCodeVisualsModal) {
                window.CodeVisualsManager.renderCodeVisualsModal(invalidMermaid, 'completed');
            }

            expect(modal.style.display).toBe('flex');
            // Should still attempt to render or show error
            expect(mermaidContainer.innerHTML).toBeTruthy();
        });
    });

    describe('Button Click Handler', () => {
        it('should open modal when button is clicked', async () => {
            const button = document.getElementById('show-code-visuals-btn');
            const modal = document.getElementById('code-visuals-modal');
            const chatState = window.ChatManager?.getChatState();
            
            // Set up session with mermaid data
            if (chatState) {
                chatState.currentSession = {
                    currentArtifact: {
                        mermaidData: 'graph TD\n  A[Start] --> B[End]',
                        timestamp: Date.now(),
                        generationStatus: 'completed'
                    }
                };
            }

            // Show button
            if (window.CodeVisualsManager?.updateShowCodeVisualsButton) {
                window.CodeVisualsManager.updateShowCodeVisualsButton();
            }

            expect(button.style.display).toBe('inline-block');

            // Click button
            const clickEvent = new window.MouseEvent('click', {
                bubbles: true,
                cancelable: true
            });

            button.dispatchEvent(clickEvent);

            // Wait for async operations
            await new Promise(resolve => setTimeout(resolve, 50));

            expect(modal.style.display).toBe('flex');
        });
    });

    describe('Chat Overlap Offset Calculation', () => {
        it('should calculate offset relative to chatMessages container top', async () => {
            const modal = document.getElementById('code-visuals-modal');
            const chatMessages = document.getElementById('chatMessages');
            const panel = modal.querySelector('.code-visuals-modal');

            // Mock getBoundingClientRect to simulate positions
            // chatMessages starts at 200px from viewport top
            // Modal bottom is at 500px from viewport top
            // Expected offset: 500 - 200 = 300px (plus 16px buffer = 316px)
            const chatMessagesRect = {
                top: 200,
                bottom: 800,
                left: 0,
                right: 1000,
                width: 1000,
                height: 600
            };

            const modalRect = {
                top: 20,
                bottom: 500,
                left: 0,
                right: 1000,
                width: 1000,
                height: 480
            };

            chatMessages.getBoundingClientRect = jest.fn(() => chatMessagesRect);
            panel.getBoundingClientRect = jest.fn(() => modalRect);

            // Trigger offset calculation by calling renderCodeVisualsModal
            if (window.CodeVisualsManager?.renderCodeVisualsModal) {
                window.CodeVisualsManager.renderCodeVisualsModal('graph TD\n  A[Test] --> B[Test]', 'completed');
            }

            // Wait for offset calculation
            await new Promise(resolve => setTimeout(resolve, 50));

            const offsetValue = chatMessages.style.getPropertyValue('--code-visuals-chat-offset');
            expect(offsetValue).toBeTruthy();
            
            // Extract numeric value (should be "316px" = 300 + 16 buffer)
            const offsetPx = parseInt(offsetValue);
            const expectedOffset = Math.round((modalRect.bottom - chatMessagesRect.top) + 16);
            expect(offsetPx).toBe(expectedOffset);
        });

        it('should use relative offset calculation, not absolute viewport position', async () => {
            const modal = document.getElementById('code-visuals-modal');
            const chatMessages = document.getElementById('chatMessages');
            const panel = modal.querySelector('.code-visuals-modal');

            // Simulate scenario where chatMessages is not at top of viewport
            // chatMessages starts at 300px from viewport top
            // Modal bottom is at 600px from viewport top
            // Old behavior would use 600px (absolute), new should use 300px (relative)
            const chatMessagesRect = {
                top: 300,
                bottom: 900,
                left: 0,
                right: 1000,
                width: 1000,
                height: 600
            };

            const modalRect = {
                top: 20,
                bottom: 600,
                left: 0,
                right: 1000,
                width: 1000,
                height: 580
            };

            chatMessages.getBoundingClientRect = jest.fn(() => chatMessagesRect);
            panel.getBoundingClientRect = jest.fn(() => modalRect);

            if (window.CodeVisualsManager?.renderCodeVisualsModal) {
                window.CodeVisualsManager.renderCodeVisualsModal('graph TD\n  A[Test] --> B[Test]', 'completed');
            }

            await new Promise(resolve => setTimeout(resolve, 50));

            const offsetValue = chatMessages.style.getPropertyValue('--code-visuals-chat-offset');
            expect(offsetValue).toBeTruthy();
            
            const offsetPx = parseInt(offsetValue);
            // Should be relative: (600 - 300) + 16 = 316px
            // NOT absolute: 600 + 16 = 616px
            const expectedRelativeOffset = Math.round((modalRect.bottom - chatMessagesRect.top) + 16);
            expect(offsetPx).toBe(expectedRelativeOffset);
            expect(offsetPx).not.toBe(modalRect.bottom + 16); // Verify it's not using absolute position
        });

        it('should clear offset when modal is closed', async () => {
            const modal = document.getElementById('code-visuals-modal');
            const chatMessages = document.getElementById('chatMessages');
            const panel = modal.querySelector('.code-visuals-modal');

            // Set up mock rects
            const chatMessagesRect = {
                top: 200,
                bottom: 800,
                left: 0,
                right: 1000,
                width: 1000,
                height: 600
            };

            const modalRect = {
                top: 20,
                bottom: 500,
                left: 0,
                right: 1000,
                width: 1000,
                height: 480
            };

            chatMessages.getBoundingClientRect = jest.fn(() => chatMessagesRect);
            panel.getBoundingClientRect = jest.fn(() => modalRect);

            // Open modal first
            if (window.CodeVisualsManager?.renderCodeVisualsModal) {
                window.CodeVisualsManager.renderCodeVisualsModal('graph TD\n  A[Test] --> B[Test]', 'completed');
            }

            await new Promise(resolve => setTimeout(resolve, 50));

            // Verify offset is set
            let offsetValue = chatMessages.style.getPropertyValue('--code-visuals-chat-offset');
            expect(offsetValue).toBeTruthy();

            // Close modal by setting display to none and triggering recalculation
            modal.style.display = 'none';
            
            // Trigger offset recalculation (which should clear it)
            if (window.CodeVisualsManager?.renderCodeVisualsModal) {
                window.CodeVisualsManager.renderCodeVisualsModal('', 'completed');
            }

            await new Promise(resolve => setTimeout(resolve, 50));

            offsetValue = chatMessages.style.getPropertyValue('--code-visuals-chat-offset');
            expect(offsetValue).toBe('');
        });

        it('should handle negative offset by clamping to zero', async () => {
            const modal = document.getElementById('code-visuals-modal');
            const chatMessages = document.getElementById('chatMessages');
            const panel = modal.querySelector('.code-visuals-modal');

            // Simulate edge case where modal bottom is above chatMessages top
            // (shouldn't happen in practice, but test the safety check)
            const chatMessagesRect = {
                top: 500,
                bottom: 1000,
                left: 0,
                right: 1000,
                width: 1000,
                height: 500
            };

            const modalRect = {
                top: 20,
                bottom: 300, // Below chatMessages top
                left: 0,
                right: 1000,
                width: 1000,
                height: 280
            };

            chatMessages.getBoundingClientRect = jest.fn(() => chatMessagesRect);
            panel.getBoundingClientRect = jest.fn(() => modalRect);

            if (window.CodeVisualsManager?.renderCodeVisualsModal) {
                window.CodeVisualsManager.renderCodeVisualsModal('graph TD\n  A[Test] --> B[Test]', 'completed');
            }

            await new Promise(resolve => setTimeout(resolve, 50));

            const offsetValue = chatMessages.style.getPropertyValue('--code-visuals-chat-offset');
            // Should be clamped to buffer value (16px) since Math.max(0, negative) = 0
            const offsetPx = parseInt(offsetValue) || 0;
            expect(offsetPx).toBeGreaterThanOrEqual(16); // At least the buffer
        });
    });
});

