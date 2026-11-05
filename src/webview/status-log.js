/**
 * Status Log Module - Plain JavaScript implementation
 * Displays real-time status updates (phases, thoughts, tool calls) during debugging sessions
 */
(function initStatusLog(globalScope) {
    'use strict';

    console.log('StatusLog: status-log.js script loaded');

    /**
     * Creates a new StatusLog instance
     * @returns {Object} StatusLog API with addStep, setFinished, clear, render methods
     */
    function createStatusLog() {
        const steps = [];
        let isFinished = false;
        let containerElement = null;
        let terminalElement = null;
        let terminalContent = null;

        /**
         * Helper to truncate text to max length
         */
        function truncateText(text, maxLength) {
            if (text.length <= maxLength) return text;
            return text.slice(0, maxLength) + '...';
        }

        /**
         * Get icon for category
         */
        function getCategoryIcon(category) {
            switch (category) {
                case 'phase':
                    return '🚀';
                case 'thought':
                    return '🧠';
                case 'tool':
                    return '🔨';
                default:
                    return '•';
            }
        }

        /**
         * Render a single step
         */
        function renderStep(step, index) {
            const isLast = index === steps.length - 1;
            const isActive = isLast && !isFinished;

            const item = document.createElement('div');
            item.className = `status-item ${step.category}`;
            item.setAttribute('data-step-id', step.id);

            // Icon
            const icon = document.createElement('span');
            icon.className = 'status-icon';
            icon.textContent = getCategoryIcon(step.category);
            item.appendChild(icon);

            // Text content
            const text = document.createElement('span');
            text.className = 'status-text';
            const displayText = step.category === 'thought' 
                ? truncateText(step.message, 120) 
                : step.message;
            text.textContent = displayText;
            text.setAttribute('title', step.message); // Full text on hover
            item.appendChild(text);

            // Loading dots (only for active last step)
            if (isActive) {
                const dotsContainer = document.createElement('span');
                dotsContainer.className = 'loading-dots';
                
                for (let i = 0; i < 3; i++) {
                    const dot = document.createElement('span');
                    dot.textContent = '.';
                    dotsContainer.appendChild(dot);
                }
                
                item.appendChild(dotsContainer);
            }

            return item;
        }

        /**
         * Strip ANSI color codes from text
         */
        function stripAnsiCodes(text) {
            return text.replace(/\x1B\[[0-9;]*[mK]/g, '');
        }

        /**
         * Create terminal element
         */
        function createTerminalElement() {
            if (terminalElement) {
                return terminalElement;
            }

            const terminal = document.createElement('div');
            terminal.className = 'terminal-window';
            terminal.id = 'live-terminal';

            const header = document.createElement('div');
            header.className = 'terminal-header';

            const redDot = document.createElement('span');
            redDot.className = 'dot red';
            header.appendChild(redDot);

            const yellowDot = document.createElement('span');
            yellowDot.className = 'dot yellow';
            header.appendChild(yellowDot);

            const greenDot = document.createElement('span');
            greenDot.className = 'dot green';
            header.appendChild(greenDot);

            const title = document.createElement('span');
            title.className = 'title';
            title.textContent = 'node repro.ts';
            header.appendChild(title);

            terminal.appendChild(header);

            const content = document.createElement('pre');
            content.id = 'terminal-content';
            content.className = 'terminal-content';
            terminal.appendChild(content);

            terminalElement = terminal;
            terminalContent = content;

            return terminal;
        }

        /**
         * Determine whether stderr text is informational (debugger startup/shutdown)
         */
        function isInformationalStderr(cleanText) {
            return (
                cleanText.startsWith('Debugger listening on ws://') ||
                cleanText.startsWith('For help, see: https://nodejs.org/en/docs/inspector') ||
                cleanText.startsWith('Debugger attached.') ||
                cleanText.startsWith('Waiting for the debugger to disconnect')
            );
        }

        /**
         * Append log to terminal
         */
        function appendLogToTerminal(text, stream) {
            if (!terminalElement) {
                createTerminalElement();
            }

            // Show terminal if hidden
            terminalElement.style.display = 'block';

            // Strip ANSI codes
            const cleanText = stripAnsiCodes(text);

            // Create span for this log chunk
            const span = document.createElement('span');
            span.textContent = cleanText;
            const isDebuggerInfo = stream === 'stderr' && isInformationalStderr(cleanText);

            // Only color as error when it's truly an error; debugger startup lines are informational
            if (stream === 'stderr' && !isDebuggerInfo) {
                span.className = 'log-stderr';
            }

            terminalContent.appendChild(span);

            // Auto-scroll to bottom
            requestAnimationFrame(() => {
                terminalContent.scrollTop = terminalContent.scrollHeight;
            });
        }

        /**
         * Scroll container to bottom
         */
        function scrollToBottom() {
            if (containerElement) {
                // Use requestAnimationFrame to ensure DOM is updated
                requestAnimationFrame(() => {
                    containerElement.scrollTop = containerElement.scrollHeight;
                });
            }
        }

        /**
         * Re-render the entire log
         */
        function renderLog() {
            if (!containerElement) return;

            // Clear container (but preserve terminal if it exists)
            const existingTerminal = containerElement.querySelector('.terminal-window');
            containerElement.innerHTML = '';

            // Render all steps
            steps.forEach((step, index) => {
                const stepElement = renderStep(step, index);
                containerElement.appendChild(stepElement);
            });

            // Re-append terminal if it existed
            if (existingTerminal && terminalElement) {
                containerElement.appendChild(terminalElement);
            }

            // Add scroll anchor at bottom
            const scrollAnchor = document.createElement('div');
            scrollAnchor.style.height = '1px';
            containerElement.appendChild(scrollAnchor);

            // Scroll to bottom
            scrollToBottom();
        }

        /**
         * Public API
         */
        return {
            /**
             * Add a step to the log
             * @param {Object} step - Step object with { id, category, message }
             */
            addStep(step) {
                if (!step || !step.id || !step.category || !step.message) {
                    console.warn('[StatusLog] Invalid step object:', step);
                    return;
                }

                steps.push(step);
                renderLog();
            },

            /**
             * Mark the log as finished (stops animation on last step)
             */
            setFinished() {
                isFinished = true;
                renderLog(); // Re-render to remove dots
            },

            /**
             * Clear all steps
             */
            clear() {
                steps.length = 0;
                isFinished = false;
                if (containerElement) {
                    containerElement.innerHTML = '';
                }
                // Reset terminal
                if (terminalElement) {
                    terminalElement.style.display = 'none';
                    if (terminalContent) {
                        terminalContent.innerHTML = '';
                    }
                }
            },

            /**
             * Render and return the container element
             * Call this once to get the DOM element to insert into the page
             * @returns {HTMLElement} Container element
             */
            render() {
                if (!containerElement) {
                    containerElement = document.createElement('div');
                    containerElement.className = 'status-log-container';
                    // Create terminal element (hidden initially)
                    createTerminalElement();
                    if (terminalElement && containerElement) {
                        containerElement.appendChild(terminalElement);
                    }
                    renderLog();
                }
                return containerElement;
            },

            /**
             * Append log to terminal
             * @param {string} text - Log text to append
             * @param {string} stream - Stream type: 'stdout' or 'stderr'
             */
            appendLogToTerminal(text, stream) {
                appendLogToTerminal(text, stream);
            },

            /**
             * Check if log has any steps
             */
            hasSteps() {
                return steps.length > 0;
            }
        };
    }

    // Export to global scope
    if (typeof globalScope !== 'undefined') {
        globalScope.StatusLog = {
            create: createStatusLog
        };
    } else if (typeof window !== 'undefined') {
        window.StatusLog = {
            create: createStatusLog
        };
    }

    console.log('StatusLog: Module initialized');
})(
    typeof window !== 'undefined' ? window : 
    typeof global !== 'undefined' ? global : 
    this
);




