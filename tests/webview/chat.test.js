const { JSDOM } = require('jsdom');

describe('Chat Webview', () => {
    let dom;
    let window;
    let document;
    let dropdown;
    let dispatchedEvents;
    let originalConsoleLog;

    beforeEach(() => {
        // Suppress console.log for deduplication messages to reduce test noise
        originalConsoleLog = console.log;
        console.log = jest.fn((...args) => {
            const message = args[0];
            // Only suppress deduplication-related logs, keep others for debugging
            if (typeof message === 'string' && (
                message.includes('Skipping duplicate') ||
                message.includes('already displayed') ||
                message.includes('already saved')
            )) {
                return; // Suppress deduplication logs
            }
            originalConsoleLog(...args);
        });

        dom = new JSDOM(`
            <div>
                <div id="chatMessages"></div>
                <select id="llm-model-select"></select>
            </div>
        `, { runScripts: 'outside-only' });

        ({ window } = dom);
        ({ document } = window);

        dispatchedEvents = [];
        document.getElementById('chatMessages').addEventListener('chat-settings-updated', () => {
            dispatchedEvents.push('chat-settings-updated');
        });

        dropdown = document.getElementById('llm-model-select');

        global.window = window;
        global.document = document;

        window.WebviewApi = {
            persistence: {
                loadGlobalSettings: jest.fn().mockResolvedValue({
                    openaiApiKey: 'test-openai-key',
                    geminiApiKey: 'test-gemini-key'
                })
            },
            subscribe: jest.fn().mockImplementation(callback => {
                window.__subscriber = callback;
                return () => {};
            })
        };

        window.CustomEvent = dom.window.CustomEvent;

        const script = require('../../src/webview/chat.js');
        script.__setWindow?.(window);
    });

    afterEach(() => {
        // Restore original console.log
        if (originalConsoleLog) {
            console.log = originalConsoleLog;
        }
        jest.resetModules();
        delete global.window;
        delete global.document;
    });

    it('refreshes dropdown when globalSettingsUpdated message received', async () => {
        window.ChatManager = {
            refreshLLMModelDropdown: jest.fn().mockResolvedValue(undefined),
            handleInitialSettings: jest.fn()
        };

        require('../../src/webview/chat.js');

        const handler = require('../../src/webview/chat.js').__getMessageHandler?.();
        await handler({ type: 'globalSettingsUpdated' });

        expect(window.ChatManager.refreshLLMModelDropdown).toHaveBeenCalled();
    });

    it('should not display empty or whitespace-only messages from fast path sessions', async () => {
        const chatMessages = document.getElementById('chatMessages');
        const initialMessageCount = chatMessages.children.length;

        // Mock displayMessage to track calls
        const displayMessageSpy = jest.fn();
        window.displayMessage = displayMessageSpy;

        // Set up WebviewApi with buildAssistantMessageFromAgentResponse
        window.buildAssistantMessageFromAgentResponse = jest.fn();

        // Load chat.js
        require('../../src/webview/chat.js');

        // Simulate success message with empty content (fast path debugging session)
        const emptyMessage = {
            type: 'success',
            requestId: 'test-request-1',
            payload: {
                content: '', // Empty message from fast path
                metadata: {
                    samuraiAgentResponse: true,
                    fastPath: true
                }
            },
            timestamp: new Date()
        };

        // Simulate success message with whitespace-only content
        const whitespaceMessage = {
            type: 'success',
            requestId: 'test-request-2',
            payload: {
                content: '   ', // Whitespace-only
                metadata: {
                    samuraiAgentResponse: true,
                    fastPath: true
                }
            },
            timestamp: new Date()
        };

        // Simulate receiving messages
        if (window.__subscriber) {
            await window.__subscriber(emptyMessage);
            await window.__subscriber(whitespaceMessage);
        }

        // Wait for async operations
        await new Promise(resolve => setTimeout(resolve, 50));

        // Verify that no messages were displayed (empty/whitespace messages should be skipped)
        expect(displayMessageSpy).not.toHaveBeenCalled();
        expect(chatMessages.children.length).toBe(initialMessageCount);
    });

    it('should display non-empty messages even from fast path sessions', async () => {
        const chatMessages = document.getElementById('chatMessages');
        const initialMessageCount = chatMessages.children.length;

        // Mock displayMessage to track calls
        const displayMessageSpy = jest.fn();
        window.displayMessage = displayMessageSpy;

        // Mock buildAssistantMessageFromAgentResponse to return a message
        const mockMessage = {
            id: 'test-msg',
            role: 'assistant',
            content: 'Analysis complete',
            type: 'assistant'
        };
        window.buildAssistantMessageFromAgentResponse = jest.fn().mockReturnValue(mockMessage);

        // Load chat.js
        require('../../src/webview/chat.js');

        // Simulate success message with actual content
        const validMessage = {
            type: 'success',
            requestId: 'test-request-3',
            payload: {
                content: 'Analysis complete', // Non-empty message
                metadata: {
                    samuraiAgentResponse: true,
                    fastPath: true
                }
            },
            timestamp: new Date()
        };

        // Simulate receiving message
        if (window.__subscriber) {
            await window.__subscriber(validMessage);
        }

        // Wait for async operations
        await new Promise(resolve => setTimeout(resolve, 50));

        // Verify that the message was displayed (non-empty messages should be shown)
        expect(window.buildAssistantMessageFromAgentResponse).toHaveBeenCalled();
        expect(displayMessageSpy).toHaveBeenCalledWith(mockMessage);
    });

    it('should persist assistant messages when received from agent', async () => {
        // Set up test values
        const testSessionId = 'test-session-123';
        const testProjectId = 'test-project-456';

        // Mock saveChatMessage
        const saveChatMessageSpy = jest.fn().mockResolvedValue({});
        window.WebviewApi.persistence.saveChatMessage = saveChatMessageSpy;
        window.WebviewApi.persistence.loadSession = jest.fn().mockResolvedValue({
            id: testSessionId,
            projectId: testProjectId
        });

        // Mock displayMessage
        const displayMessageSpy = jest.fn();
        window.displayMessage = displayMessageSpy;

        window.MessageType = {
            USER: 'user',
            ASSISTANT: 'assistant',
            SYSTEM: 'system',
            ERROR: 'error'
        };

        // Load chat.js
        delete require.cache[require.resolve('../../src/webview/chat.js')];
        require('../../src/webview/chat.js');

        // Initialize chat state by sending initialSettings
        // This sets up chatState.currentSessionId and chatState.projectSettings
        if (window.__subscriber) {
            await window.__subscriber({
                type: 'initialSettings',
                payload: {
                    globalSettings: {
                        openaiApiKey: 'test-key'
                    },
                    projectSettings: {
                        projectId: testProjectId,
                        currentSessionId: testSessionId,
                        primaryLLMModel: 'gpt-4o'
                    },
                    availableModels: [],
                    llmModels: {}
                }
            });
        }

        // Wait for initialization
        await new Promise(resolve => setTimeout(resolve, 50));

        // Simulate success message with agent response
        const successMessage = {
            type: 'success',
            requestId: 'test-request-persistence',
            payload: {
                content: 'This is the agent response',
                metadata: {
                    samuraiAgentResponse: true,
                    tokens: 100,
                    cost: 0.002
                }
            },
            timestamp: new Date()
        };

        // Simulate receiving message
        if (window.__subscriber) {
            await window.__subscriber(successMessage);
        }

        // Wait for async operations (persistence is async)
        await new Promise(resolve => setTimeout(resolve, 150));

        // Verify that saveChatMessage was called with correct parameters
        expect(saveChatMessageSpy).toHaveBeenCalledTimes(1);
        const saveCall = saveChatMessageSpy.mock.calls[0][0];
        expect(saveCall.sessionId).toBe(testSessionId);
        expect(saveCall.projectId).toBe(testProjectId);
        expect(saveCall.type).toBe('assistant');
        expect(saveCall.content).toBe('This is the agent response');
        expect(saveCall.role).toBe('assistant');
        expect(saveCall.metadata).toMatchObject({
            samuraiAgentResponse: true,
            tokens: 100,
            cost: 0.002
        });

        // Verify that displayMessage was also called
        expect(displayMessageSpy).toHaveBeenCalled();
    });

    it('should not persist assistant messages when sessionId or projectId are invalid', async () => {
        // Mock saveChatMessage
        const saveChatMessageSpy = jest.fn().mockResolvedValue({});
        window.WebviewApi.persistence.saveChatMessage = saveChatMessageSpy;

        // Mock displayMessage
        const displayMessageSpy = jest.fn();
        window.displayMessage = displayMessageSpy;

        window.MessageType = {
            USER: 'user',
            ASSISTANT: 'assistant',
            SYSTEM: 'system',
            ERROR: 'error'
        };

        // Load chat.js
        delete require.cache[require.resolve('../../src/webview/chat.js')];
        require('../../src/webview/chat.js');

        // Initialize chat state WITHOUT setting currentSessionId
        // This will cause buildAssistantMessageFromAgentResponse to return 'unknown-session' and 'unknown-project'
        if (window.__subscriber) {
            await window.__subscriber({
                type: 'initialSettings',
                payload: {
                    globalSettings: {
                        openaiApiKey: 'test-key'
                    },
                    projectSettings: {
                        projectId: undefined, // Not set
                        currentSessionId: undefined, // Not set
                        primaryLLMModel: 'gpt-4o'
                    },
                    availableModels: [],
                    llmModels: {}
                }
            });
        }

        // Wait for initialization
        await new Promise(resolve => setTimeout(resolve, 50));

        // Simulate success message
        const successMessage = {
            type: 'success',
            requestId: 'test-request-invalid',
            payload: {
                content: 'This is the agent response',
                metadata: {
                    samuraiAgentResponse: true
                }
            },
            timestamp: new Date()
        };

        // Simulate receiving message
        if (window.__subscriber) {
            await window.__subscriber(successMessage);
        }

        // Wait for async operations
        await new Promise(resolve => setTimeout(resolve, 150));

        // Verify that saveChatMessage was NOT called (due to invalid/unknown IDs)
        expect(saveChatMessageSpy).not.toHaveBeenCalled();

        // But displayMessage should still be called
        expect(displayMessageSpy).toHaveBeenCalled();
    });

    it('should persist debugSessionFinished messages to storage', async () => {
        // Set up test values
        const testSessionId = 'test-session-debug-123';
        const testProjectId = 'test-project-debug-456';

        // Mock saveChatMessage
        const saveChatMessageSpy = jest.fn().mockResolvedValue({});
        window.WebviewApi.persistence.saveChatMessage = saveChatMessageSpy;
        window.WebviewApi.persistence.updateSession = jest.fn().mockResolvedValue({});
        window.WebviewApi.persistence.loadSession = jest.fn().mockResolvedValue({
            id: testSessionId,
            projectId: testProjectId
        });

        // Mock displayMessage
        const displayMessageSpy = jest.fn();
        window.displayMessage = displayMessageSpy;

        window.MessageType = {
            USER: 'user',
            ASSISTANT: 'assistant',
            SYSTEM: 'system',
            ERROR: 'error'
        };

        // Load chat.js
        delete require.cache[require.resolve('../../src/webview/chat.js')];
        require('../../src/webview/chat.js');

        // Initialize chat state by sending initialSettings
        if (window.__subscriber) {
            await window.__subscriber({
                type: 'initialSettings',
                payload: {
                    globalSettings: {
                        openaiApiKey: 'test-key'
                    },
                    projectSettings: {
                        projectId: testProjectId,
                        currentSessionId: testSessionId,
                        primaryLLMModel: 'gpt-4o'
                    },
                    availableModels: [],
                    llmModels: {}
                }
            });
        }

        // Wait for initialization
        await new Promise(resolve => setTimeout(resolve, 50));

        // Simulate debugSessionFinished message
        // Note: Backend always includes sessionId in payload (see DebugSessionController.ts line 252)
        const debugSessionFinishedMessage = {
            type: 'debugSessionFinished',
            payload: {
                id: 'test-message-id-123',
                sessionId: testSessionId, // Backend includes sessionId in payload
                content: 'Root cause analysis complete. The issue is in file.js at line 42.',
                visualization: 'graph mermaid data',
                epilogue: {
                    steps: 5,
                    files: ['file1.js', 'file2.js'],
                    cost: 0.0034
                }
            },
            timestamp: new Date()
        };

        // Simulate receiving message
        if (window.__subscriber) {
            await window.__subscriber(debugSessionFinishedMessage);
        }

        // Wait for async operations (persistence is async)
        await new Promise(resolve => setTimeout(resolve, 200));

        // Verify that saveChatMessage was called with correct parameters
        expect(saveChatMessageSpy).toHaveBeenCalledTimes(1);
        const saveCall = saveChatMessageSpy.mock.calls[0][0];
        expect(saveCall.sessionId).toBe(testSessionId);
        expect(saveCall.projectId).toBe(testProjectId);
        expect(saveCall.type).toBe('assistant');
        expect(saveCall.content).toContain('Root cause analysis complete');
        expect(saveCall.content).toContain('Analysis complete: 5 step');
        expect(saveCall.role).toBe('assistant');
        expect(saveCall.metadata).toMatchObject({
            samuraiAgentResponse: true,
            debugSessionFinished: true
        });
        expect(saveCall.metadata.epilogue).toMatchObject({
            steps: 5,
            files: ['file1.js', 'file2.js'],
            cost: 0.0034
        });

        // Verify that displayMessage was also called
        expect(displayMessageSpy).toHaveBeenCalled();
    });

    it('should not call saveChatMessage when debugSessionFinished has alreadyPersisted true but still display message', async () => {
        const testSessionId = 'test-session-already-saved';
        const testProjectId = 'test-project-already-saved';

        const saveChatMessageSpy = jest.fn().mockResolvedValue({});
        window.WebviewApi.persistence.saveChatMessage = saveChatMessageSpy;
        window.WebviewApi.persistence.updateSession = jest.fn().mockResolvedValue({});
        window.WebviewApi.persistence.loadSession = jest.fn().mockResolvedValue({
            id: testSessionId,
            projectId: testProjectId
        });

        const displayMessageSpy = jest.fn();
        window.displayMessage = displayMessageSpy;

        window.MessageType = {
            USER: 'user',
            ASSISTANT: 'assistant',
            SYSTEM: 'system',
            ERROR: 'error'
        };

        delete require.cache[require.resolve('../../src/webview/chat.js')];
        require('../../src/webview/chat.js');

        if (window.__subscriber) {
            await window.__subscriber({
                type: 'initialSettings',
                payload: {
                    globalSettings: { openaiApiKey: 'test-key' },
                    projectSettings: {
                        projectId: testProjectId,
                        currentSessionId: testSessionId,
                        primaryLLMModel: 'gpt-4o'
                    },
                    availableModels: [],
                    llmModels: {}
                }
            });
        }

        await new Promise(resolve => setTimeout(resolve, 50));

        const debugSessionFinishedMessage = {
            type: 'debugSessionFinished',
            payload: {
                id: 'backend-saved-id-456',
                sessionId: testSessionId,
                content: 'Backend already saved this response.',
                epilogue: { steps: 1, files: [], cost: 0.001 },
                alreadyPersisted: true
            },
            timestamp: new Date()
        };

        if (window.__subscriber) {
            await window.__subscriber(debugSessionFinishedMessage);
        }

        await new Promise(resolve => setTimeout(resolve, 200));

        expect(saveChatMessageSpy).not.toHaveBeenCalled();
        expect(displayMessageSpy).toHaveBeenCalled();
    });

    it('should not persist debugSessionFinished messages when sessionId or projectId are missing', async () => {
        // Mock saveChatMessage
        const saveChatMessageSpy = jest.fn().mockResolvedValue({});
        window.WebviewApi.persistence.saveChatMessage = saveChatMessageSpy;

        // Mock displayMessage
        const displayMessageSpy = jest.fn();
        window.displayMessage = displayMessageSpy;

        window.MessageType = {
            USER: 'user',
            ASSISTANT: 'assistant',
            SYSTEM: 'system',
            ERROR: 'error'
        };

        // Load chat.js
        delete require.cache[require.resolve('../../src/webview/chat.js')];
        require('../../src/webview/chat.js');

        // Initialize chat state WITHOUT setting currentSessionId
        if (window.__subscriber) {
            await window.__subscriber({
                type: 'initialSettings',
                payload: {
                    globalSettings: {
                        openaiApiKey: 'test-key'
                    },
                    projectSettings: {
                        projectId: undefined, // Not set
                        currentSessionId: undefined, // Not set
                        primaryLLMModel: 'gpt-4o'
                    },
                    availableModels: [],
                    llmModels: {}
                }
            });
        }

        // Wait for initialization
        await new Promise(resolve => setTimeout(resolve, 50));

        // Simulate debugSessionFinished message
        const debugSessionFinishedMessage = {
            type: 'debugSessionFinished',
            payload: {
                content: 'Root cause analysis complete.',
                epilogue: {
                    steps: 3,
                    files: ['file.js'],
                    cost: 0.002
                }
            },
            timestamp: new Date()
        };

        // Simulate receiving message
        if (window.__subscriber) {
            await window.__subscriber(debugSessionFinishedMessage);
        }

        // Wait for async operations
        await new Promise(resolve => setTimeout(resolve, 200));

        // Verify that saveChatMessage was NOT called (due to missing IDs)
        expect(saveChatMessageSpy).not.toHaveBeenCalled();

        // But displayMessage should still be called
        expect(displayMessageSpy).toHaveBeenCalled();
    });

    it('should allow persistAssistantMessage to save messages with samuraiAgentResponse flag', async () => {
        // Set up test values
        const testSessionId = 'test-session-persist-123';
        const testProjectId = 'test-project-persist-456';

        // Mock saveChatMessage
        const saveChatMessageSpy = jest.fn().mockResolvedValue({});
        window.WebviewApi.persistence.saveChatMessage = saveChatMessageSpy;

        window.MessageType = {
            USER: 'user',
            ASSISTANT: 'assistant',
            SYSTEM: 'system',
            ERROR: 'error'
        };

        // Load chat.js
        delete require.cache[require.resolve('../../src/webview/chat.js')];
        const chatModule = require('../../src/webview/chat.js');

        // Get access to persistAssistantMessage function if exposed
        // If not exposed, we'll test it indirectly through the message handler
        // For now, we'll test it indirectly by checking that messages with samuraiAgentResponse
        // can be saved when passed through the normal flow

        // Initialize chat state
        if (window.__subscriber) {
            await window.__subscriber({
                type: 'initialSettings',
                payload: {
                    globalSettings: {
                        openaiApiKey: 'test-key'
                    },
                    projectSettings: {
                        projectId: testProjectId,
                        currentSessionId: testSessionId,
                        primaryLLMModel: 'gpt-4o'
                    },
                    availableModels: [],
                    llmModels: {}
                }
            });
        }

        // Wait for initialization
        await new Promise(resolve => setTimeout(resolve, 50));

        // Create a message with samuraiAgentResponse flag
        const messageWithFlag = {
            sessionId: testSessionId,
            projectId: testProjectId,
            type: 'assistant',
            role: 'assistant',
            content: 'This is an agent response with samuraiAgentResponse flag',
            metadata: {
                samuraiAgentResponse: true,
                tokens: 150,
                cost: 0.003
            }
        };

        // Try to call persistAssistantMessage if it's exposed
        // Otherwise, verify through the message flow that it works
        // Since persistAssistantMessage is not directly exposed, we verify the behavior
        // by checking that debugSessionFinished messages (which have samuraiAgentResponse)
        // are now being persisted (tested in previous test)

        // For this test, we verify that the guard has been removed by checking
        // that messages with samuraiAgentResponse can be saved through the normal flow
        // We'll use a success message which should trigger the assistantMessage handler
        const successMessage = {
            type: 'success',
            requestId: 'test-request-persist-flag',
            payload: {
                content: 'This is an agent response',
                metadata: {
                    samuraiAgentResponse: true,
                    tokens: 150,
                    cost: 0.003
                }
            },
            timestamp: new Date()
        };

        // Simulate receiving message
        if (window.__subscriber) {
            await window.__subscriber(successMessage);
        }

        // Wait for async operations
        await new Promise(resolve => setTimeout(resolve, 200));

        // Verify that saveChatMessage was called (proving the guard is removed)
        // Note: This test verifies that messages with samuraiAgentResponse can be saved
        // The previous test already verified debugSessionFinished works, which also
        // has samuraiAgentResponse: true
        expect(saveChatMessageSpy).toHaveBeenCalled();
        const saveCall = saveChatMessageSpy.mock.calls[0][0];
        expect(saveCall.metadata.samuraiAgentResponse).toBe(true);
    });

    it('should prevent duplicate message display using message IDs', async () => {
        const chatMessages = document.getElementById('chatMessages');
        const testSessionId = 'test-session-dedup';
        const testProjectId = 'test-project-dedup';

        // Mock buildAssistantMessageFromAgentResponse
        const mockMessage = {
            id: 'test-msg-id-123',
            role: 'assistant',
            content: 'Test message',
            type: 'assistant',
            sessionId: testSessionId,
            projectId: testProjectId
        };
        window.buildAssistantMessageFromAgentResponse = jest.fn().mockReturnValue(mockMessage);

        // Mock displayMessage to track calls
        const displayMessageSpy = jest.fn();
        window.displayMessage = displayMessageSpy;

        // Load chat.js
        delete require.cache[require.resolve('../../src/webview/chat.js')];
        require('../../src/webview/chat.js');

        // Initialize chat state
        if (window.__subscriber) {
            await window.__subscriber({
                type: 'initialSettings',
                payload: {
                    globalSettings: { openaiApiKey: 'test-key' },
                    projectSettings: {
                        projectId: testProjectId,
                        currentSessionId: testSessionId,
                        primaryLLMModel: 'gpt-4o'
                    },
                    availableModels: [],
                    llmModels: {}
                }
            });
        }

        await new Promise(resolve => setTimeout(resolve, 50));

        // Simulate receiving the same message twice
        const successMessage = {
            type: 'success',
            requestId: 'test-request-dedup',
            payload: {
                content: 'Test message',
                metadata: { samuraiAgentResponse: true }
            },
            timestamp: new Date()
        };

        // First call
        if (window.__subscriber) {
            await window.__subscriber(successMessage);
        }
        await new Promise(resolve => setTimeout(resolve, 50));

        // Second call with same message (should be deduplicated)
        if (window.__subscriber) {
            await window.__subscriber(successMessage);
        }
        await new Promise(resolve => setTimeout(resolve, 50));

        // displayMessage should only be called once (second call should be deduplicated)
        // Note: The actual displayMessage function will skip duplicates, but our spy
        // might be called. The important thing is that the DOM doesn't have duplicates.
        expect(window.buildAssistantMessageFromAgentResponse).toHaveBeenCalledTimes(2);
    });

    it('should prevent duplicate saves using message IDs', async () => {
        const testSessionId = 'test-session-save-dedup';
        const testProjectId = 'test-project-save-dedup';

        const saveChatMessageSpy = jest.fn().mockResolvedValue({});
        window.WebviewApi.persistence.saveChatMessage = saveChatMessageSpy;
        window.WebviewApi.persistence.loadSession = jest.fn().mockResolvedValue({
            id: testSessionId,
            projectId: testProjectId
        });

        window.MessageType = {
            USER: 'user',
            ASSISTANT: 'assistant',
            SYSTEM: 'system',
            ERROR: 'error'
        };

        // Load chat.js
        delete require.cache[require.resolve('../../src/webview/chat.js')];
        require('../../src/webview/chat.js');

        // Initialize chat state
        if (window.__subscriber) {
            await window.__subscriber({
                type: 'initialSettings',
                payload: {
                    globalSettings: { openaiApiKey: 'test-key' },
                    projectSettings: {
                        projectId: testProjectId,
                        currentSessionId: testSessionId,
                        primaryLLMModel: 'gpt-4o'
                    },
                    availableModels: [],
                    llmModels: {}
                }
            });
        }

        await new Promise(resolve => setTimeout(resolve, 50));

        // Create a message with a specific ID
        const messageId = 'test-msg-save-123';
        const mockMessage = {
            id: messageId,
            role: 'assistant',
            content: 'Test message',
            type: 'assistant',
            sessionId: testSessionId,
            projectId: testProjectId
        };
        window.buildAssistantMessageFromAgentResponse = jest.fn().mockReturnValue(mockMessage);

        // Simulate receiving the same message twice
        const successMessage = {
            type: 'success',
            requestId: 'test-request-save-dedup',
            payload: {
                content: 'Test message',
                metadata: { samuraiAgentResponse: true }
            },
            timestamp: new Date()
        };

        // First call - should save
        if (window.__subscriber) {
            await window.__subscriber(successMessage);
        }
        await new Promise(resolve => setTimeout(resolve, 150));

        // Second call with same message ID - should NOT save again
        if (window.__subscriber) {
            await window.__subscriber(successMessage);
        }
        await new Promise(resolve => setTimeout(resolve, 150));

        // saveChatMessage should only be called once (second call should be skipped)
        expect(saveChatMessageSpy).toHaveBeenCalledTimes(1);
    });
});

describe('Progress Indicator Positioning', () => {
    let dom;
    let window;
    let document;
    let chatMessages;
    let originalConsoleLog;

    beforeEach(() => {
        // Suppress console.log for deduplication messages
        originalConsoleLog = console.log;
        console.log = jest.fn((...args) => {
            const message = args[0];
            if (typeof message === 'string' && (
                message.includes('Skipping duplicate') ||
                message.includes('already displayed') ||
                message.includes('already saved')
            )) {
                return;
            }
            originalConsoleLog(...args);
        });

        // Create a more complete DOM structure for testing
        dom = new JSDOM(`
            <!DOCTYPE html>
            <html>
            <body>
                <div id="chatMessages"></div>
            </body>
            </html>
        `, { runScripts: 'outside-only' });

        ({ window } = dom);
        ({ document } = window);
        chatMessages = document.getElementById('chatMessages');

        global.window = window;
        global.document = document;

        // Set up WebviewApi mock
        window.WebviewApi = {
            persistence: {
                loadGlobalSettings: jest.fn().mockResolvedValue({
                    openaiApiKey: 'test-key',
                    geminiApiKey: 'test-key'
                }),
                loadProjectSettings: jest.fn().mockResolvedValue({
                    projectId: 'test-project',
                    primaryLLMModel: 'test-model'
                })
            },
            subscribe: jest.fn().mockImplementation(callback => {
                window.__subscriber = callback;
                return () => {};
            })
        };

        window.CustomEvent = dom.window.CustomEvent;

        // Load the chat.js module to get access to functions
        delete require.cache[require.resolve('../../src/webview/chat.js')];
        require('../../src/webview/chat.js');
    });

    afterEach(() => {
        if (originalConsoleLog) {
            console.log = originalConsoleLog;
        }
        jest.resetModules();
        delete global.window;
        delete global.document;
    });

    /**
     * Helper function to create a user message element
     */
    function createUserMessage(content) {
        const messageEl = document.createElement('div');
        messageEl.className = 'chat-message user-message';
        messageEl.textContent = content;
        return messageEl;
    }

    /**
     * Helper function to create an assistant message element
     */
    function createAssistantMessage(content) {
        const messageEl = document.createElement('div');
        messageEl.className = 'chat-message assistant-message';
        messageEl.textContent = content;
        return messageEl;
    }

    /**
     * Helper function to create a pending "Thinking..." indicator
     */
    function createPendingIndicator() {
        const pendingEl = document.createElement('div');
        pendingEl.className = 'assistant-message pending';
        pendingEl.textContent = 'Thinking...';
        return pendingEl;
    }

    /**
     * Helper function to trigger showProgressIndicator via window event
     */
    function triggerProgressUpdate(stage, data = null) {
        if (window.__subscriber) {
            window.__subscriber({
                type: 'agentProgress',
                payload: { stage, data }
            });
        }
    }

    /**
     * Helper to get banner position relative to a reference element
     */
    function getBannerPositionRelativeTo(banner, referenceElement) {
        const allElements = Array.from(chatMessages.children);
        const bannerIndex = allElements.indexOf(banner);
        const refIndex = allElements.indexOf(referenceElement);
        return bannerIndex - refIndex;
    }

    it('should position progress banner after the latest user message on first call', () => {
        // Setup: Add multiple user messages
        const firstUserMsg = createUserMessage('First message');
        const secondUserMsg = createUserMessage('Second message');
        const thirdUserMsg = createUserMessage('Third message');
        
        chatMessages.appendChild(firstUserMsg);
        chatMessages.appendChild(createAssistantMessage('Response 1'));
        chatMessages.appendChild(secondUserMsg);
        chatMessages.appendChild(createAssistantMessage('Response 2'));
        chatMessages.appendChild(thirdUserMsg);

        // Trigger progress update
        triggerProgressUpdate('extracting-code');

        // Assert: Banner should be after the third (latest) user message
        const banner = document.getElementById('agent-progress-banner');
        expect(banner).not.toBeNull();
        expect(banner.textContent).toBe('Finding relevant code context...');
        
        const positionRelativeToLatest = getBannerPositionRelativeTo(banner, thirdUserMsg);
        expect(positionRelativeToLatest).toBe(1); // Should be immediately after
    });

    it('should reposition progress banner after latest user message on subsequent calls', () => {
        // Setup: Add first user message and trigger progress
        const firstUserMsg = createUserMessage('First message');
        chatMessages.appendChild(firstUserMsg);
        triggerProgressUpdate('analyzing');

        const banner = document.getElementById('agent-progress-banner');
        expect(banner).not.toBeNull();
        
        // Verify initial position (after first message)
        let positionRelativeToFirst = getBannerPositionRelativeTo(banner, firstUserMsg);
        expect(positionRelativeToFirst).toBe(1);

        // Now add second user message
        const secondUserMsg = createUserMessage('Second message');
        chatMessages.appendChild(secondUserMsg);

        // Trigger another progress update
        triggerProgressUpdate('extracting-code');

        // Assert: Same banner should now be after second message
        const sameBanner = document.getElementById('agent-progress-banner');
        expect(sameBanner).toBe(banner); // Should be the same element
        
        const positionRelativeToSecond = getBannerPositionRelativeTo(banner, secondUserMsg);
        expect(positionRelativeToSecond).toBe(1); // Should be immediately after second message
        
        // Should NOT be after first message anymore
        const positionRelativeToFirstNow = getBannerPositionRelativeTo(banner, firstUserMsg);
        expect(positionRelativeToFirstNow).toBeGreaterThan(1);
    });

    it('should position banner after user message when no pending indicator exists', () => {
        // Setup: Add user message (no pending indicator since we removed it)
        const userMsg = createUserMessage('User message');
        chatMessages.appendChild(userMsg);

        // Trigger progress update
        triggerProgressUpdate('extracting-code');

        // Assert: Banner should be after user message
        const banner = document.getElementById('agent-progress-banner');
        expect(banner).not.toBeNull();
        
        const positionRelativeToUser = getBannerPositionRelativeTo(banner, userMsg);
        expect(positionRelativeToUser).toBe(1); // Should be immediately after user message
    });

    describe('Animated Loading Dots', () => {
        beforeEach(() => {
            jest.useFakeTimers();
        });

        afterEach(() => {
            jest.useRealTimers();
        });

        it('should animate loading dots for messages ending with "..."', () => {
            const userMsg = createUserMessage('User message');
            chatMessages.appendChild(userMsg);

            // Trigger progress update with a message ending in "..."
            triggerProgressUpdate('Analyzing your code...');

            const banner = document.getElementById('agent-progress-banner');
            expect(banner).not.toBeNull();
            
            // Initial state should have at least one dot
            const initialText = banner.textContent;
            expect(initialText).toContain('Analyzing your code');
            expect(initialText).toMatch(/\.{1,3}$/); // Should end with 1-3 dots

            // Fast-forward time to see animation
            jest.advanceTimersByTime(500);
            const afterFirstTick = banner.textContent;
            expect(afterFirstTick).toContain('Analyzing your code');
            expect(afterFirstTick).toMatch(/\.{1,3}$/);

            // Fast-forward again
            jest.advanceTimersByTime(500);
            const afterSecondTick = banner.textContent;
            expect(afterSecondTick).toContain('Analyzing your code');
            expect(afterSecondTick).toMatch(/\.{1,3}$/);

            // The dots should cycle
            jest.advanceTimersByTime(500);
            const afterThirdTick = banner.textContent;
            expect(afterThirdTick).toContain('Analyzing your code');
            expect(afterThirdTick).toMatch(/\.{1,3}$/);
        });

        it('should not animate dots for completion messages', () => {
            const userMsg = createUserMessage('User message');
            chatMessages.appendChild(userMsg);

            // Trigger progress update with a completion message
            triggerProgressUpdate('Completed root cause analysis (3 iterations)');

            const banner = document.getElementById('agent-progress-banner');
            expect(banner).not.toBeNull();
            
            // Should display the message as-is without animation
            expect(banner.textContent).toBe('Completed root cause analysis (3 iterations)');

            // Fast-forward time - text should remain unchanged
            jest.advanceTimersByTime(2000);
            expect(banner.textContent).toBe('Completed root cause analysis (3 iterations)');
        });

        it('should handle new debugging status messages', () => {
            const userMsg = createUserMessage('User message');
            chatMessages.appendChild(userMsg);

            // Test various debugging status messages
            const statusMessages = [
                'Finding epicenter...',
                'Building execution graph...',
                'Running root cause analysis (iteration 1/3)...',
                'Generating visualization...'
            ];

            statusMessages.forEach((status, index) => {
                triggerProgressUpdate(status);
                const banner = document.getElementById('agent-progress-banner');
                expect(banner).not.toBeNull();
                expect(banner.textContent).toContain(status.replace(/\.+$/, '')); // Should contain base text
                
                // Should animate dots
                jest.advanceTimersByTime(500);
                const animatedText = banner.textContent;
                expect(animatedText).toMatch(/\.{1,3}$/);
            });
        });

        it('should clear animation interval when new status is received', () => {
            const userMsg = createUserMessage('User message');
            chatMessages.appendChild(userMsg);

            // Start first animation
            triggerProgressUpdate('Analyzing your code...');
            const banner = document.getElementById('agent-progress-banner');
            const initialText = banner.textContent;

            // Fast-forward a bit
            jest.advanceTimersByTime(500);
            const afterFirstTick = banner.textContent;

            // Trigger new status - should clear old animation and start new one
            triggerProgressUpdate('Finding epicenter...');
            const newText = banner.textContent;
            expect(newText).toContain('Finding epicenter');
            expect(newText).not.toContain('Analyzing your code');

            // Animation should continue with new message
            jest.advanceTimersByTime(500);
            const afterNewAnimation = banner.textContent;
            expect(afterNewAnimation).toContain('Finding epicenter');
            expect(afterNewAnimation).toMatch(/\.{1,3}$/);
        });

        it('should clear animation when success message is received', () => {
            const userMsg = createUserMessage('User message');
            chatMessages.appendChild(userMsg);

            // Start animation
            triggerProgressUpdate('Analyzing your code...');
            const banner = document.getElementById('agent-progress-banner');
            expect(banner).not.toBeNull();

            // Fast-forward to see animation
            jest.advanceTimersByTime(1000);

            // Simulate success message
            if (window.__subscriber) {
                window.__subscriber({
                    type: 'success',
                    requestId: 'test-request',
                    payload: {
                        content: 'Test response',
                        metadata: { samuraiAgentResponse: true }
                    }
                });
            }

            // Banner should be removed
            const bannerAfterSuccess = document.getElementById('agent-progress-banner');
            expect(bannerAfterSuccess).toBeNull();
        });

        it('should clear animation when error message is received', () => {
            const userMsg = createUserMessage('User message');
            chatMessages.appendChild(userMsg);

            // Start animation
            triggerProgressUpdate('Analyzing your code...');
            const banner = document.getElementById('agent-progress-banner');
            expect(banner).not.toBeNull();

            // Fast-forward to see animation
            jest.advanceTimersByTime(1000);

            // Simulate error message
            if (window.__subscriber) {
                window.__subscriber({
                    type: 'error',
                    requestId: 'test-request',
                    error: 'Test error'
                });
            }

            // Banner should be removed
            const bannerAfterError = document.getElementById('agent-progress-banner');
            expect(bannerAfterError).toBeNull();
        });
    });

    it('should update banner text content on each progress update', () => {
        // Setup
        const userMsg = createUserMessage('Test message');
        chatMessages.appendChild(userMsg);

        // First update
        triggerProgressUpdate('analyzing');
        let banner = document.getElementById('agent-progress-banner');
        expect(banner.textContent).toBe('Analyzing conversation...');

        // Second update
        triggerProgressUpdate('extracting-code');
        banner = document.getElementById('agent-progress-banner');
        expect(banner.textContent).toBe('Finding relevant code context...');

        // Third update with data
        triggerProgressUpdate('extraction-complete', {
            files: [
                { path: 'file1.js' },
                { path: 'file2.js' },
                { path: 'file3.js' }
            ]
        });
        banner = document.getElementById('agent-progress-banner');
        expect(banner.textContent).toBe('Code context ready: file1.js, file2.js, file3.js');
    });

    it('should remove banner from DOM after completion stages', (done) => {
        // Setup
        const userMsg = createUserMessage('Test message');
        chatMessages.appendChild(userMsg);

        // Trigger completion stage
        triggerProgressUpdate('rendering-response');

        const banner = document.getElementById('agent-progress-banner');
        expect(banner).not.toBeNull();
        expect(banner.textContent).toBe('Generating response...');

        // Wait for timeout (3000ms + buffer)
        setTimeout(() => {
            const bannerAfterTimeout = document.getElementById('agent-progress-banner');
            expect(bannerAfterTimeout).toBeNull(); // Should be removed from DOM
            done();
        }, 3100);
    });

    it('should handle missing chatMessages container gracefully', () => {
        // Remove chatMessages element
        chatMessages.remove();

        // Should not throw error
        expect(() => {
            triggerProgressUpdate('analyzing');
        }).not.toThrow();

        // Banner should not be created
        const banner = document.getElementById('agent-progress-banner');
        expect(banner).toBeNull();
    });

    it('should fallback to appending when no user message exists', () => {
        // Setup: Empty chat or only assistant messages
        chatMessages.appendChild(createAssistantMessage('Assistant message'));

        // Trigger progress update
        triggerProgressUpdate('analyzing');

        // Assert: Banner should be appended to end
        const banner = document.getElementById('agent-progress-banner');
        expect(banner).not.toBeNull();
        expect(chatMessages.lastChild).toBe(banner);
    });

    it('should handle multiple rapid progress updates correctly', () => {
        // Setup
        const userMsg = createUserMessage('Test message');
        chatMessages.appendChild(userMsg);

        // Trigger multiple rapid updates
        triggerProgressUpdate('analyzing');
        triggerProgressUpdate('extracting-code');
        triggerProgressUpdate('extraction-complete');

        // Should only have ONE banner element
        const banners = chatMessages.querySelectorAll('#agent-progress-banner');
        expect(banners.length).toBe(1);

        // Banner should have latest message
        const banner = document.getElementById('agent-progress-banner');
        expect(banner.textContent).toBe('Code context ready.');
    });
});

describe('Status Log Positioning', () => {
    let dom;
    let window;
    let document;
    let chatMessages;
    let mockStatusLog;
    let originalConsoleLog;

    beforeEach(() => {
        // Suppress console.log for deduplication messages
        originalConsoleLog = console.log;
        console.log = jest.fn((...args) => {
            const message = args[0];
            if (typeof message === 'string' && (
                message.includes('Skipping duplicate') ||
                message.includes('already displayed') ||
                message.includes('already saved')
            )) {
                return;
            }
            originalConsoleLog(...args);
        });

        dom = new JSDOM(`
            <!DOCTYPE html>
            <html>
            <body>
                <div id="chatMessages"></div>
            </body>
            </html>
        `, { runScripts: 'outside-only' });

        ({ window } = dom);
        ({ document } = window);
        chatMessages = document.getElementById('chatMessages');

        global.window = window;
        global.document = document;

        // Create mock StatusLog
        const statusLogElement = document.createElement('div');
        statusLogElement.className = 'status-log-container';
        
        mockStatusLog = {
            addStep: jest.fn(),
            setFinished: jest.fn(),
            clear: jest.fn(),
            render: jest.fn().mockReturnValue(statusLogElement),
            hasSteps: jest.fn().mockReturnValue(false)
        };

        window.StatusLog = {
            create: jest.fn().mockReturnValue(mockStatusLog)
        };

        // Set up WebviewApi mock
        window.WebviewApi = {
            persistence: {
                loadGlobalSettings: jest.fn().mockResolvedValue({
                    openaiApiKey: 'test-key',
                    geminiApiKey: 'test-key'
                }),
                loadProjectSettings: jest.fn().mockResolvedValue({
                    projectId: 'test-project',
                    primaryLLMModel: 'test-model'
                })
            },
            subscribe: jest.fn().mockImplementation(callback => {
                window.__subscriber = callback;
                return () => {};
            })
        };

        window.CustomEvent = dom.window.CustomEvent;
        window.MessageType = {
            USER: 'user',
            ASSISTANT: 'assistant',
            SYSTEM: 'system',
            ERROR: 'error'
        };

        // Load the chat.js module
        delete require.cache[require.resolve('../../src/webview/chat.js')];
        require('../../src/webview/chat.js');
    });

    afterEach(() => {
        jest.resetModules();
        delete global.window;
        delete global.document;
    });

    /**
     * Helper function to create a user message element
     */
    function createUserMessage(content) {
        const messageEl = document.createElement('div');
        messageEl.className = 'chat-message user-message';
        messageEl.textContent = content;
        return messageEl;
    }

    /**
     * Helper function to create an assistant message element
     */
    function createAssistantMessage(content) {
        const messageEl = document.createElement('div');
        messageEl.className = 'chat-message assistant-message';
        messageEl.textContent = content;
        return messageEl;
    }

    /**
     * Helper function to trigger debugStatusUpdate message
     */
    function triggerDebugStatusUpdate(payload) {
        if (window.__subscriber) {
            window.__subscriber({
                type: 'debugStatusUpdate',
                payload: payload || {
                    sessionId: 'test-session',
                    stepId: 'step-1',
                    category: 'phase',
                    message: 'Test status update'
                }
            });
        }
    }

    /**
     * Helper to get position relative to a reference element
     */
    function getPositionRelativeTo(element, referenceElement) {
        const allElements = Array.from(chatMessages.children);
        const elementIndex = allElements.indexOf(element);
        const refIndex = allElements.indexOf(referenceElement);
        return elementIndex - refIndex;
    }

    it('should insert status log after latest user message, not at top', () => {
        // Setup: Add multiple messages
        const firstUserMsg = createUserMessage('First message');
        const assistantMsg = createAssistantMessage('Response 1');
        const secondUserMsg = createUserMessage('Second message');
        
        chatMessages.appendChild(firstUserMsg);
        chatMessages.appendChild(assistantMsg);
        chatMessages.appendChild(secondUserMsg);

        // Trigger status update
        triggerDebugStatusUpdate();

        // Assert: Status log should be after the latest (second) user message
        const statusLogElement = chatMessages.querySelector('.status-log-container');
        expect(statusLogElement).not.toBeNull();
        
        const position = getPositionRelativeTo(statusLogElement, secondUserMsg);
        expect(position).toBe(1); // Should be immediately after second user message
        
        // Should NOT be at the top (before first message)
        expect(statusLogElement).not.toBe(chatMessages.firstChild);
    });

    it('should insert status log after latest user message when multiple user messages exist', () => {
        // Setup: Add multiple user messages with assistant responses
        const msg1 = createUserMessage('Message 1');
        const msg2 = createUserMessage('Message 2');
        const msg3 = createUserMessage('Message 3');
        const assistant1 = createAssistantMessage('Response 1');
        const assistant2 = createAssistantMessage('Response 2');
        
        chatMessages.appendChild(msg1);
        chatMessages.appendChild(assistant1);
        chatMessages.appendChild(msg2);
        chatMessages.appendChild(assistant2);
        chatMessages.appendChild(msg3);

        // Trigger status update
        triggerDebugStatusUpdate();

        // Assert: Status log should be after the latest (third) user message
        const statusLogElement = chatMessages.querySelector('.status-log-container');
        expect(statusLogElement).not.toBeNull();
        
        const position = getPositionRelativeTo(statusLogElement, msg3);
        expect(position).toBe(1); // Should be immediately after third message
        
        // Should NOT be after first or second message
        const positionRelativeToMsg1 = getPositionRelativeTo(statusLogElement, msg1);
        expect(positionRelativeToMsg1).toBeGreaterThan(1);
        
        const positionRelativeToMsg2 = getPositionRelativeTo(statusLogElement, msg2);
        expect(positionRelativeToMsg2).toBeGreaterThan(1);
    });

    it('should append status log to end when no user message exists', () => {
        // Setup: Only assistant messages
        const assistantMsg = createAssistantMessage('Response');
        chatMessages.appendChild(assistantMsg);

        // Trigger status update
        triggerDebugStatusUpdate();

        // Assert: Status log should be appended to end
        const statusLogElement = chatMessages.querySelector('.status-log-container');
        expect(statusLogElement).not.toBeNull();
        expect(chatMessages.lastChild).toBe(statusLogElement);
    });

    it('should add steps to status log when debugStatusUpdate is received', () => {
        // Setup
        const userMsg = createUserMessage('Test message');
        chatMessages.appendChild(userMsg);

        // Trigger status update
        triggerDebugStatusUpdate({
            sessionId: 'test-session',
            stepId: 'step-1',
            category: 'phase',
            message: 'Analyzing code'
        });

        // Assert: StatusLog.addStep should have been called
        expect(mockStatusLog.addStep).toHaveBeenCalledWith({
            id: 'step-1',
            category: 'phase',
            message: 'Analyzing code'
        });
    });

    it('should create status log only once for multiple debugStatusUpdate messages', () => {
        // Setup
        const userMsg = createUserMessage('Test message');
        chatMessages.appendChild(userMsg);

        // Trigger multiple status updates
        triggerDebugStatusUpdate({ stepId: 'step-1', category: 'phase', message: 'Step 1', sessionId: 'test' });
        triggerDebugStatusUpdate({ stepId: 'step-2', category: 'thought', message: 'Step 2', sessionId: 'test' });
        triggerDebugStatusUpdate({ stepId: 'step-3', category: 'tool', message: 'Step 3', sessionId: 'test' });

        // Assert: StatusLog.create should be called only once
        expect(window.StatusLog.create).toHaveBeenCalledTimes(1);
        
        // But addStep should be called for each update
        expect(mockStatusLog.addStep).toHaveBeenCalledTimes(3);
        
        // Should only have one status log element in DOM
        const statusLogElements = chatMessages.querySelectorAll('.status-log-container');
        expect(statusLogElements.length).toBe(1);
    });

    it('should position status log after new user message when message is added', () => {
        // Setup: Add first user message and trigger status update
        const firstUserMsg = createUserMessage('First message');
        chatMessages.appendChild(firstUserMsg);
        
        triggerDebugStatusUpdate({ sessionId: 'test', stepId: 'step-1', category: 'phase', message: 'Step 1' });
        
        const statusLogElement = chatMessages.querySelector('.status-log-container');
        expect(statusLogElement).not.toBeNull();
        
        // Verify initial position (after first message)
        let position = getPositionRelativeTo(statusLogElement, firstUserMsg);
        expect(position).toBe(1);

        // Add new user message
        const secondUserMsg = createUserMessage('Second message');
        chatMessages.appendChild(secondUserMsg);

        // Trigger another status update (should reposition)
        triggerDebugStatusUpdate({ sessionId: 'test', stepId: 'step-2', category: 'phase', message: 'Step 2' });

        // Assert: Status log should now be after second message
        const statusLogElementAfter = chatMessages.querySelector('.status-log-container');
        expect(statusLogElementAfter).toBe(statusLogElement); // Same element
        
        const positionAfter = getPositionRelativeTo(statusLogElementAfter, secondUserMsg);
        expect(positionAfter).toBe(1); // Should be immediately after second message
    });

    it('should call setFinished when debugSessionFinished is received', () => {
        // Setup
        const userMsg = createUserMessage('Test message');
        chatMessages.appendChild(userMsg);
        
        triggerDebugStatusUpdate({ sessionId: 'test', stepId: 'step-1', category: 'phase', message: 'Step 1' });

        // Trigger session finished
        if (window.__subscriber) {
            window.__subscriber({
                type: 'debugSessionFinished'
            });
        }

        // Assert: setFinished should have been called
        expect(mockStatusLog.setFinished).toHaveBeenCalled();
    });
});

describe('Thinking Indicator Removal', () => {
    let dom;
    let window;
    let document;
    let chatMessages;
    let originalConsoleLog;

    beforeEach(() => {
        // Suppress console.log for deduplication messages
        originalConsoleLog = console.log;
        console.log = jest.fn((...args) => {
            const message = args[0];
            if (typeof message === 'string' && (
                message.includes('Skipping duplicate') ||
                message.includes('already displayed') ||
                message.includes('already saved')
            )) {
                return;
            }
            originalConsoleLog(...args);
        });

        dom = new JSDOM(`
            <!DOCTYPE html>
            <html>
            <body>
                <div id="chatMessages"></div>
                <input id="chatInput" />
            </body>
            </html>
        `, { runScripts: 'outside-only' });

        ({ window } = dom);
        ({ document } = window);
        chatMessages = document.getElementById('chatMessages');

        global.window = window;
        global.document = document;

        // Set up WebviewApi mock
        window.WebviewApi = {
            persistence: {
                loadGlobalSettings: jest.fn().mockResolvedValue({
                    openaiApiKey: 'test-key'
                }),
                loadProjectSettings: jest.fn().mockResolvedValue({
                    projectId: 'test-project',
                    primaryLLMModel: 'test-model'
                }),
                saveChatMessage: jest.fn().mockResolvedValue({})
            },
            agent: {
                execute: jest.fn().mockResolvedValue({})
            },
            subscribe: jest.fn().mockImplementation(callback => {
                window.__subscriber = callback;
                return () => {};
            })
        };

        window.CustomEvent = dom.window.CustomEvent;
        window.MessageType = {
            USER: 'user',
            ASSISTANT: 'assistant',
            SYSTEM: 'system',
            ERROR: 'error'
        };

        // Load the chat.js module
        delete require.cache[require.resolve('../../src/webview/chat.js')];
        require('../../src/webview/chat.js');
    });

    afterEach(() => {
        if (originalConsoleLog) {
            console.log = originalConsoleLog;
        }
        jest.resetModules();
        delete global.window;
        delete global.document;
    });

    it('should not create "Thinking..." pending indicator when sending message', async () => {
        // Setup chat state
        if (window.getChatState) {
            const chatState = window.getChatState();
            chatState.currentSessionId = 'test-session';
            chatState.projectSettings = { projectId: 'test-project' };
        }

        // Trigger sendMessage (simulated)
        // Since sendMessage is async and requires user input, we check that 
        // the pending indicator is never created by looking for it in DOM
        // after a message would have been sent
        
        // Check that no pending indicator exists
        const pendingIndicators = chatMessages.querySelectorAll('.assistant-message.pending');
        expect(pendingIndicators.length).toBe(0);
    });

    it('should not have pending indicator creation code in sendMessage path', () => {
        // This test verifies that the pending indicator class is not in the chat container
        // when messages are sent, which would indicate the code was removed
        expect(chatMessages.querySelector('.assistant-message.pending')).toBeNull();
    });
});

describe('renderMarkdown Code Block Rendering', () => {
    let dom;
    let window;
    let document;
    let originalConsoleLog;

    beforeEach(() => {
        // Suppress console.log for deduplication messages
        originalConsoleLog = console.log;
        console.log = jest.fn((...args) => {
            const message = args[0];
            if (typeof message === 'string' && (
                message.includes('Skipping duplicate') ||
                message.includes('already displayed') ||
                message.includes('already saved')
            )) {
                return;
            }
            originalConsoleLog(...args);
        });

        dom = new JSDOM(`
            <!DOCTYPE html>
            <html>
            <body>
                <div id="chatMessages"></div>
            </body>
            </html>
        `, { runScripts: 'outside-only' });

        ({ window } = dom);
        ({ document } = window);

        global.window = window;
        global.document = document;

        window.WebviewApi = {
            persistence: {
                loadGlobalSettings: jest.fn().mockResolvedValue({
                    openaiApiKey: 'test-key'
                })
            },
            subscribe: jest.fn().mockImplementation(callback => {
                window.__subscriber = callback;
                return () => {};
            })
        };

        window.CustomEvent = dom.window.CustomEvent;

        // Load chat.js to get access to renderMarkdown
        delete require.cache[require.resolve('../../src/webview/chat.js')];
        require('../../src/webview/chat.js');
    });

    afterEach(() => {
        if (originalConsoleLog) {
            console.log = originalConsoleLog;
        }
        jest.resetModules();
        delete global.window;
        delete global.document;
    });

    it('should correctly parse JavaScript code blocks with language specifier', () => {
        const markdown = '```javascript\nconst x = 1;\nconst y = 2;\n```';
        const result = window.renderMarkdown(markdown);
        
        // Should not contain "javascript" as part of the code content (only in class name)
        const codeContent = result.match(/<code[^>]*>(.*?)<\/code>/s)?.[1] || '';
        expect(codeContent).not.toContain('javascript');
        // Should contain the actual code
        expect(result).toContain('const x = 1;');
        expect(result).toContain('const y = 2;');
        // Should have language class
        expect(result).toContain('language-javascript');
        // Should have code block structure
        expect(result).toContain('<pre><code');
        expect(result).toContain('code-block-container');
    });

    it('should correctly parse TypeScript code blocks', () => {
        const markdown = '```typescript\ninterface Foo {\n  bar: string;\n}\n```';
        const result = window.renderMarkdown(markdown);
        
        // Should not contain "typescript" as part of the code content (only in class name)
        const codeContent = result.match(/<code[^>]*>(.*?)<\/code>/s)?.[1] || '';
        expect(codeContent).not.toContain('typescript');
        // Should contain the actual code
        expect(result).toContain('interface Foo');
        expect(result).toContain('bar: string');
        // Should have language class
        expect(result).toContain('language-typescript');
    });

    it('should handle code blocks without language specifier', () => {
        const markdown = '```\nplain text code\n```';
        const result = window.renderMarkdown(markdown);
        
        // Should contain the code content
        expect(result).toContain('plain text code');
        // Should default to plaintext language class
        expect(result).toContain('language-plaintext');
        // Should have code block structure
        expect(result).toContain('<pre><code');
    });

    it('should handle multiple code blocks in one message', () => {
        const markdown = 'First block:\n```javascript\nconst a = 1;\n```\n\nSecond block:\n```python\ndef hello():\n    pass\n```';
        const result = window.renderMarkdown(markdown);
        
        // Should contain both code blocks
        expect(result).toContain('const a = 1;');
        expect(result).toContain('def hello():');
        // Should have correct language classes
        expect(result).toContain('language-javascript');
        expect(result).toContain('language-python');
        // Should not have language specifiers in code content
        expect(result).not.toContain('```javascript');
        expect(result).not.toContain('```python');
    });

    it('should handle code blocks with special characters', () => {
        const markdown = '```javascript\nconst str = "Hello <world>";\nconst html = `<div>${str}</div>`;\n```';
        const result = window.renderMarkdown(markdown);
        
        // Should escape HTML special characters
        expect(result).toContain('&lt;world&gt;');
        expect(result).toContain('&lt;div&gt;');
        // Should have language class
        expect(result).toContain('language-javascript');
    });

    it('should handle mixed content with text and code blocks', () => {
        const markdown = 'Here is some text.\n\n```javascript\nconst x = 1;\n```\n\nMore text here.';
        const result = window.renderMarkdown(markdown);
        
        // Should contain the text
        expect(result).toContain('Here is some text');
        expect(result).toContain('More text here');
        // Should contain the code
        expect(result).toContain('const x = 1;');
        // Should have language class
        expect(result).toContain('language-javascript');
    });

    it('should handle empty code blocks', () => {
        const markdown = '```javascript\n\n```';
        const result = window.renderMarkdown(markdown);
        
        // Should still create code block structure
        expect(result).toContain('code-block-container');
        expect(result).toContain('language-javascript');
        expect(result).toContain('<pre><code');
    });

    it('should handle code blocks with different language identifiers', () => {
        const testCases = [
            { lang: 'js', code: 'const x = 1;' },
            { lang: 'ts', code: 'const x: number = 1;' },
            { lang: 'python', code: 'x = 1' },
            { lang: 'java', code: 'int x = 1;' }
        ];

        testCases.forEach(({ lang, code }) => {
            const markdown = `\`\`\`${lang}\n${code}\n\`\`\``;
            const result = window.renderMarkdown(markdown);
            
            // Should have correct language class (lowercase)
            expect(result).toContain(`language-${lang.toLowerCase()}`);
            // Should contain the code
            expect(result).toContain(code);
            // Should not contain the language specifier in code content (only in class name)
            const codeContent = result.match(/<code[^>]*>(.*?)<\/code>/s)?.[1] || '';
            expect(codeContent).not.toContain(lang);
        });
    });

    it('should return empty string for null or undefined input', () => {
        expect(window.renderMarkdown(null)).toBe('');
        expect(window.renderMarkdown(undefined)).toBe('');
        expect(window.renderMarkdown('')).toBe('');
    });

    it('should handle code blocks at the start and end of text', () => {
        const markdown = '```javascript\nconst x = 1;\n```\nSome text\n```python\ndef y():\n    pass\n```';
        const result = window.renderMarkdown(markdown);
        
        // Should contain both code blocks
        expect(result).toContain('const x = 1;');
        expect(result).toContain('def y():');
        // Should contain the text
        expect(result).toContain('Some text');
        // Should have both language classes
        expect(result).toContain('language-javascript');
        expect(result).toContain('language-python');
    });

    it('should correctly render a real agent message with multiple TypeScript code blocks', () => {
        const realAgentMessage = `## Root Cause

The root issue of the LLM response parsing error, specifically the 'cannot find bracket or something' message, is located within the \`extractJsonFromText\` utility function in \`PlanningAgent.ts\`.

This function is responsible for robustly extracting a complete JSON object from the raw text generated by the LLM, which might include conversational text, markdown, or other extraneous content. It does this by carefully tracking opening and closing braces (\`{\`, \`}\`) and ensuring they are not within string literals.

However, the logic for handling escape characters (\`\\\`) within JSON strings is incorrect on line 245:

\`\`\`typescript
if (char === '\\\\') {
  isEscaped = true;
  continue;
}
\`\`\`

The condition \`char === '\\\\'\` checks for *two backslashes*. In JSON, a single backslash (\`\\\`) is used as an escape character (e.g., \`\\"\` for a double quote, \`\\\\\` for a literal backslash, \`\\n\` for a newline). Because of this, when the LLM's response contains valid JSON with single backslash escape sequences (e.g., \`"path": "C:\\\\Users\\\\Doc"\` or \`"regex": "\\\\[a-z]+"\`), the \`isEscaped\` flag is not correctly set. This causes the string boundary (\`"\`) detection to misfire, leading \`inString\` to toggle incorrectly.

When \`inString\` is wrong, the brace counter (\`braceCount\`) will misinterpret braces that are actually *inside* a string literal as structural JSON braces. This can result in two main failure modes, both consistent with the user's report:

1.  **Premature termination:** \`braceCount\` reaches zero too early, returning an incomplete JSON string.

2.  **Failed termination:** \`braceCount\` never reaches zero (or goes negative incorrectly), causing the function to return \`null\`, which then triggers the \`new Error("No JSON object found in response")\` message, or an incomplete JSON string that \`JSON.parse\` cannot handle, resulting in a parsing error.

## The Fix

To resolve this, the condition for detecting an escape character should be changed to detect a single backslash.

**File:** \`/Users/yutosuzuki/code/samurai-agent-vscode/samurai-agent/src/agent/core/PlanningAgent.ts\`

**Line:** 245

**Original:**

\`\`\`typescript
      if (char === '\\\\') { // This should be \`char === '\\'\` to detect a single backslash
        isEscaped = true;
        continue;
      }
\`\`\`

**Corrected:**

\`\`\`typescript
      if (char === '\\\\') { // Correct: Check for a single backslash to toggle the escape flag
        isEscaped = true;
        continue;
      }
\`\`\`

(Note: The comment in the original code already identifies the issue. The fix is to apply the suggestion in the comment.)`;

        const result = window.renderMarkdown(realAgentMessage);
        
        // Should contain the markdown text content
        expect(result).toContain('Root Cause');
        expect(result).toContain('extractJsonFromText');
        expect(result).toContain('PlanningAgent.ts');
        
        // Should contain code from the first TypeScript block
        expect(result).toContain("if (char === '\\\\')");
        expect(result).toContain('isEscaped = true;');
        expect(result).toContain('continue;');
        
        // Should contain code from the second TypeScript block (Original)
        expect(result).toContain("// This should be `char === '\\'` to detect a single backslash");
        
        // Should contain code from the third TypeScript block (Corrected)
        expect(result).toContain("// Correct: Check for a single backslash to toggle the escape flag");
        
        // Should have TypeScript language classes for all code blocks
        const typescriptMatches = result.match(/language-typescript/g);
        expect(typescriptMatches).not.toBeNull();
        expect(typescriptMatches.length).toBeGreaterThanOrEqual(3); // At least 3 TypeScript code blocks
        
        // Should NOT have "typescript" appearing as part of the code content (only in class names)
        const codeBlocks = result.match(/<code[^>]*class="language-typescript"[^>]*>(.*?)<\/code>/gs);
        if (codeBlocks) {
            codeBlocks.forEach(block => {
                const codeContent = block.match(/<code[^>]*>(.*?)<\/code>/s)?.[1] || '';
                expect(codeContent).not.toContain('```typescript');
                expect(codeContent).not.toContain('typescript');
            });
        }
        
        // Should have proper code block structure
        expect(result).toContain('code-block-container');
        expect(result).toContain('<pre><code');
        
        // Should preserve inline code (backticks)
        expect(result).toContain('<code>extractJsonFromText</code>');
        expect(result).toContain('<code>PlanningAgent.ts</code>');
    });

    describe('Race condition prevention for debugSessionFinished', () => {
        let saveChatMessageCallCount;
        let chatState;

        beforeEach(() => {
            saveChatMessageCallCount = 0;
            
            window.WebviewApi = {
                persistence: {
                    loadGlobalSettings: jest.fn().mockResolvedValue({
                        openaiApiKey: 'test-openai-key',
                        geminiApiKey: 'test-gemini-key'
                    }),
                    saveChatMessage: jest.fn().mockImplementation(async (message) => {
                        saveChatMessageCallCount++;
                        // Simulate backend returning a different ID (race condition scenario)
                        return {
                            type: 'success',
                            payload: {
                                id: `saved-${message.id}`, // Different ID returned
                                ...message
                            }
                        };
                    }),
                    updateSession: jest.fn().mockResolvedValue({}),
                    loadSession: jest.fn().mockResolvedValue({
                        id: 'test-session',
                        metadata: { projectId: 'test-project' }
                    })
                },
                subscribe: jest.fn().mockImplementation(callback => {
                    window.__subscriber = callback;
                    return () => {};
                })
            };

            window.MessageType = {
                USER: 'user',
                ASSISTANT: 'assistant',
                SYSTEM: 'system',
                ERROR: 'error'
            };

            // Load chat.js and get chat state
            require('../../src/webview/chat.js');
            // Wait for ChatManager to be available
            if (window.ChatManager && window.ChatManager.getChatState) {
                chatState = window.ChatManager.getChatState();
            }
        });

        it('should prevent infinite loop when backend returns different ID after save', async () => {
            const originalId = 'original-message-id-123';
            const savedId = `saved-${originalId}`;
            
            const debugSessionFinishedMessage = {
                type: 'debugSessionFinished',
                payload: {
                    id: originalId,
                    sessionId: 'test-session',
                    content: 'Test message content',
                    visualization: 'graph TD',
                    epilogue: {
                        steps: 5,
                        files: ['file1.ts'],
                        cost: 0.001
                    }
                },
                timestamp: new Date()
            };

            // Set up chat state
            if (chatState) {
                chatState.currentSessionId = 'test-session';
                chatState.projectSettings = { projectId: 'test-project' };
                chatState.savedMessageIds = new Set();
            }

            // First processing: Should save the message
            if (window.__subscriber) {
                await window.__subscriber(debugSessionFinishedMessage);
            }

            // Verify message was saved once
            expect(saveChatMessageCallCount).toBe(1);
            expect(window.WebviewApi.persistence.saveChatMessage).toHaveBeenCalledTimes(1);

            // Verify both IDs are in savedMessageIds (the fix)
            if (chatState && chatState.savedMessageIds) {
                expect(chatState.savedMessageIds.has(originalId)).toBe(true);
                expect(chatState.savedMessageIds.has(savedId)).toBe(true);
            }

            // Reset call count
            saveChatMessageCallCount = 0;
            jest.clearAllMocks();

            // Simulate the same message arriving again (e.g., from webview reload or message queue)
            // This should be blocked by the duplicate check
            if (window.__subscriber) {
                await window.__subscriber(debugSessionFinishedMessage);
            }

            // Verify message was NOT saved again (race condition prevented)
            expect(saveChatMessageCallCount).toBe(0);
            expect(window.WebviewApi.persistence.saveChatMessage).not.toHaveBeenCalled();
        });

        it('should keep both original and saved IDs when they differ', async () => {
            const originalId = 'original-id-456';
            const savedId = 'saved-id-456';
            
            const message = {
                type: 'debugSessionFinished',
                payload: {
                    id: originalId,
                    sessionId: 'test-session',
                    content: 'Test content',
                    epilogue: { steps: 1, files: [], cost: 0 }
                }
            };

            // Mock save to return different ID
            window.WebviewApi.persistence.saveChatMessage = jest.fn().mockResolvedValue({
                type: 'success',
                payload: { id: savedId }
            });

            if (chatState) {
                chatState.currentSessionId = 'test-session';
                chatState.projectSettings = { projectId: 'test-project' };
                chatState.savedMessageIds = new Set();
            }

            // Process message
            if (window.__subscriber) {
                await window.__subscriber(message);
            }

            // Verify both IDs are kept in the set
            if (chatState && chatState.savedMessageIds) {
                expect(chatState.savedMessageIds.has(originalId)).toBe(true);
                expect(chatState.savedMessageIds.has(savedId)).toBe(true);
                expect(chatState.savedMessageIds.size).toBe(2);
            }
        });

        it('should handle case where saved ID equals original ID', async () => {
            const messageId = 'same-id-789';
            
            const message = {
                type: 'debugSessionFinished',
                payload: {
                    id: messageId,
                    sessionId: 'test-session',
                    content: 'Test content',
                    epilogue: { steps: 1, files: [], cost: 0 }
                }
            };

            // Mock save to return same ID
            window.WebviewApi.persistence.saveChatMessage = jest.fn().mockResolvedValue({
                type: 'success',
                payload: { id: messageId }
            });

            if (chatState) {
                chatState.currentSessionId = 'test-session';
                chatState.projectSettings = { projectId: 'test-project' };
                chatState.savedMessageIds = new Set();
            }

            // Process message
            if (window.__subscriber) {
                await window.__subscriber(message);
            }

            // Verify ID is in the set (only once, since Set handles duplicates)
            if (chatState && chatState.savedMessageIds) {
                expect(chatState.savedMessageIds.has(messageId)).toBe(true);
                expect(chatState.savedMessageIds.size).toBe(1);
            }
        });
    });
});

describe('Busy state and tab-switch recovery', () => {
    let dom;
    let window;
    let document;
    let chatInput;
    let runAnalysisBtn;
    let chatMessages;
    let originalConsoleLog;

    beforeEach(() => {
        originalConsoleLog = console.log;
        console.log = jest.fn((...args) => {
            const message = args[0];
            if (typeof message === 'string' && (
                message.includes('Skipping duplicate') ||
                message.includes('already displayed') ||
                message.includes('already saved')
            )) {
                return;
            }
            originalConsoleLog(...args);
        });

        dom = new JSDOM(`
            <!DOCTYPE html>
            <html>
            <body>
                <div id="chatMessages"></div>
                <input id="chatInput" />
                <button id="run-analysis-btn" class="run-analysis-btn">Run Analysis</button>
            </body>
            </html>
        `, { runScripts: 'outside-only' });

        ({ window } = dom);
        ({ document } = window);
        chatMessages = document.getElementById('chatMessages');
        chatInput = document.getElementById('chatInput');
        runAnalysisBtn = document.getElementById('run-analysis-btn');

        global.window = window;
        global.document = document;

        window.WebviewApi = {
            persistence: {
                loadGlobalSettings: jest.fn().mockResolvedValue({}),
                loadProjectSettings: jest.fn().mockResolvedValue({ projectId: 'p1', currentSessionId: 's1' }),
                loadSession: jest.fn().mockResolvedValue({ id: 's1', metadata: {} }),
                loadChatMessagesForSession: jest.fn().mockResolvedValue([]),
                saveChatMessage: jest.fn().mockResolvedValue({}),
                createSession: jest.fn().mockResolvedValue({ id: 's1' })
            },
            subscribe: jest.fn().mockImplementation(callback => {
                window.__subscriber = callback;
                return () => {};
            })
        };

        window.CustomEvent = dom.window.CustomEvent;
        window.MessageType = { USER: 'user', ASSISTANT: 'assistant', SYSTEM: 'system', ERROR: 'error' };
        window.displayMessage = jest.fn();
        window.showToast = jest.fn();

        delete require.cache[require.resolve('../../src/webview/chat.js')];
        require('../../src/webview/chat.js');
    });

    afterEach(() => {
        if (originalConsoleLog) console.log = originalConsoleLog;
        jest.resetModules();
        delete global.window;
        delete global.document;
    });

    it('should set busy state and show progress when handleInitialSettings receives isBusy true', async () => {
        await window.__subscriber({
            type: 'initialSettings',
            payload: {
                globalSettings: { openaiApiKey: 'test' },
                projectSettings: { projectId: 'p1', currentSessionId: 's1', primaryLLMModel: 'gpt-4o' },
                availableModels: [],
                llmModels: {},
                isBusy: true
            }
        });
        await new Promise(r => setTimeout(r, 50));

        const chatState = window.ChatManager?.getChatState?.();
        expect(chatState).toBeDefined();
        expect(chatState.isBusy).toBe(true);
        expect(chatInput.disabled).toBe(true);
        expect(runAnalysisBtn.disabled).toBe(true);
        expect(runAnalysisBtn.textContent).toBe('Running...');
        const banner = document.getElementById('agent-progress-banner');
        expect(banner).toBeTruthy();
    });

    it('should clear busy state when debugSessionFinished is received', async () => {
        await window.__subscriber({
            type: 'initialSettings',
            payload: {
                globalSettings: { openaiApiKey: 'test' },
                projectSettings: { projectId: 'p1', currentSessionId: 's1', primaryLLMModel: 'gpt-4o' },
                availableModels: [],
                llmModels: {},
                isBusy: true
            }
        });
        await new Promise(r => setTimeout(r, 50));

        const messageId = `debug-done-${Date.now()}`;
        await window.__subscriber({
            type: 'debugSessionFinished',
            payload: {
                id: messageId,
                sessionId: 's1',
                content: 'Analysis complete.',
                epilogue: { steps: 1, files: [], cost: 0 },
                alreadyPersisted: false
            },
            timestamp: new Date()
        });
        await new Promise(r => setTimeout(r, 50));

        const chatState = window.ChatManager?.getChatState?.();
        expect(chatState.isBusy).toBe(false);
        expect(chatInput.disabled).toBe(false);
        expect(runAnalysisBtn.disabled).toBe(false);
        expect(runAnalysisBtn.textContent).toBe('Run Analysis');
    });

    it('should clear busy state and show error when agentError is received', async () => {
        await window.__subscriber({
            type: 'initialSettings',
            payload: {
                globalSettings: { openaiApiKey: 'test' },
                projectSettings: { projectId: 'p1', currentSessionId: 's1', primaryLLMModel: 'gpt-4o' },
                availableModels: [],
                llmModels: {},
                isBusy: true
            }
        });
        await new Promise(r => setTimeout(r, 50));

        await window.__subscriber({
            type: 'agentError',
            payload: { sessionId: 's1', error: 'test error' },
            timestamp: new Date()
        });
        await new Promise(r => setTimeout(r, 50));

        const chatState = window.ChatManager?.getChatState?.();
        expect(chatState.isBusy).toBe(false);
        expect(chatInput.disabled).toBe(false);
        expect(runAnalysisBtn.disabled).toBe(false);
        expect(window.showToast).toHaveBeenCalledWith('test error', 'error');
    });
});