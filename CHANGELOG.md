# Change Log

All notable changes to the "samurai-agent" extension will be documented in this file.

## [0.4.1] - 2026-11-04

### Changed
- README: lead with the demo video thumbnail and feature visuals for Open VSX / Marketplace pages

## [0.4.0] - 2026-11-04

### Changed
- Open-source release: MIT, bring-your-own-key only (provider + model name + API key in Secret Storage)
- Removed beta proxy, free-tier keys, sponsored models, and PostHog telemetry
- Empty built-in model catalog; users define models themselves
- Landing page moved to GitHub Pages (`docs/`)

## [0.3.45] - 2026-02-22

### Fixed
- **Telemetry: Remove broken `first_time_user_local` flag**: Removed client-side first-time user detection that was always `true` for new sessions; tracking is handled server-side by the beta proxy
- **Telemetry: Add `error_message` to PostHog events**: LLM failure events now include the actual error text (truncated to 200 chars) so failures can be diagnosed from PostHog alone
- **Telemetry: Record PlanningAgent cost**: PlanningAgent's LLM cost is now recorded to telemetry context before finalization, fixing missing `llm_estimated_cost_usd` in PostHog events

## [0.3.44] - 2026-02-21

### Added
- **Hunk-Aware Regression Risk Detection**: Upgraded risk scoring to parse unified diffs into discrete hunks for smarter pattern matching
  - 10 new specialist patterns across Async/Concurrency (e.g. `forEach(async …)` without `Promise.all`), Silent Error Handling (empty `catch` blocks, swallowed `.catch()`), and React State/Effects (`key={index}`, removed `useEffect` cleanup)
  - Same-hunk suppression: risky pattern is suppressed when a mitigation appears in the same code change, reducing false positives
  - Confidence levels (`high` / `medium`) on every pattern; medium-confidence patterns weighted at 0.6×
  - Per-category score caps (diff 40, path 30, scope 25) prevent any single category from dominating
- **Enhanced Regression Review Protocol**: Review prompt now includes a "Validate Implementation Against Plan" step and dynamically injects detected heuristic signals with confidence levels

### Fixed
- **"Start New Conversation" During Running Analysis**: Fixed user getting permanently stuck with disabled input after clicking "Start New Conversation" while analysis was running
  - Confirmation dialog warns that the current analysis will be stopped
  - Busy state resets immediately in the frontend
  - Orphaned `PlanningAgent` executions are aborted via `AbortController` / `AbortSignal`
  - Stale responses from old sessions are filtered by session ID so they don't leak into new conversations

## [0.3.43] - 2026-02-19

### Added
- **VS Code Native Settings for Beta Code**: Beta code, debug logging, and API keys now appear in VS Code's native Settings UI
  - New `samurai-agent.betaCode` setting for sponsored LLM access ($3/month free credits)
  - New `samurai-agent.enableDebugLogging` setting for diagnostic output
  - `samurai-agent.apiKeys` entry directs users to the panel Settings tab
  - Settings changes from the panel sync to VS Code config; changes from VS Code Settings sync back to the panel
- **"Enter Beta Code" Command**: New command to quickly enter beta code from the Command Palette or welcome flow
- **Antigravity IDE Plan Discovery**: Support for Google Antigravity workflow files in AI tool plan discovery
  - Searches `.agent/workflows/` (per-project) and `~/.gemini/antigravity/global_workflows/` (global) for regression review context
  - Plan context from Antigravity is used alongside Cursor, Windsurf, and Claude Code plans
- **Regression Risk Telemetry**: Lines/chars changed metrics added to regression risk PostHog events for better product insights

### Fixed
- **Edit Burst Diff Capture**: Fixed edit burst not properly capturing code diff for regression review
  - Seeded file content cache with already-open documents so first edits have a baseline
  - Track newly opened documents to seed cache before first edit
  - Store pre-edit content for both editor and FS sources (not just editor)
  - Capture `endText` from open documents so burst summaries include full before/after state for accurate diff calculation

## [0.3.42] - 2026-02-17

### Fixed
- **Cursor Plan Discovery in Cursor IDE**: Fixed plan discovery never finding Cursor plans stored at the global `~/.cursor/plans/` path
  - Cursor IDE stores plans globally at `~/.cursor/plans/` (not per-project), so our per-project-only search missed all Cursor plans
  - Added global `~/.cursor/plans/` as a search directory in `getCursorPlanDirs()`
  - Existing safeguards (24h max age, 30 candidate cap, file-mention scoring) keep performance safe even with many global plans

## [0.3.41] - 2026-02-16

### Fixed
- **Empty Webview on Regression Review**: Fixed blank webview when clicking "Review Regression Risk" notification
  - Queued `createCodeReviewSession` messages that arrive before `initialSettings` is processed
  - Guarded `initializeChatSession` from overwriting a just-created code-review session
  - Resolves race condition where the webview opens blank because settings aren't ready yet

## [0.3.40] - 2026-02-16

### Added
- **Robust Regression Risk File Detection**: Improved file-level detection for regression risk scoring with more reliable identification of changed files
- **PostHog Tracking for Regression Risk**: Added telemetry events for regression risk analysis to track detection accuracy and user engagement

## [0.3.38] - 2026-02-16

### Added
- **PostHog Tracking**: Track `regression_notification_shown` and user response (review/ignore/dismissed) events for regression notifications

### Improved
- **Qualitative Risk Labels**: Replace numeric risk scores (e.g. "6/100") with action-oriented labels ("Review Recommended", "Potential Risk Detected", "Elevated Risk", "High Risk") in regression notifications

## [0.3.37] - 2026-02-12

### Added
- **AI Tool Plan Discovery**: Automatically discovers recent plan files from AI tools (e.g. Cursor) and includes them as context during regression review
  - Helps distinguish intentional changes from accidental regressions by cross-referencing the AI tool's plan with the diff
  - Supports `.cursor/plans/`, `.windsurf/plans/`, and other common AI tool plan directories
  - Includes confidence scoring based on whether plan mentions changed files
- **12 New JS/TS Risk Patterns**: Expanded regression risk scoring with JS/TS-specific diff pattern detection
  - `as any` type assertions, removed optional chaining (`?.`) or nullish coalescing (`??`)
  - Strict-to-loose equality changes (`===` to `==`), removed `finally` blocks
  - Security risks: `eval()`/`Function()`, `innerHTML`/`dangerouslySetInnerHTML`
  - Removed event listener cleanup, changed import styles, non-null assertions (`!`)
  - Regex pattern changes, inverted conditionals, removed type guards

### Improved
- **Review Protocol**: Restructured regression review prompt into a clearer step-by-step protocol
  - Structured as: Understand Change → Infer Intent → Find Regressions → Check JS/TS Pitfalls → Verify → Output
  - When AI tool plan context is available, it is used as primary signal for developer intent
- **README**: Rewritten for clearer value proposition focused on in-IDE code review of AI edits
- **Marketplace Metadata**: Updated display name, description, categories (added "AI"), and keywords

### Fixed
- **DebugSessionController Tests**: Fixed 26 failing tests caused by missing mocks, disabled features, and call signature mismatches

## [0.3.36] - 2026-02-10

### Improved
- **README**: Updated documentation for clearer value proposition and onboarding
  - Refined TL;DR, problem/solution, and "How to Use" (Code Review Mode) with step-by-step flow and demo links
  - Clearer messaging around preventing regression bugs and reviewing AI-generated fixes before shipping
  - Updated setup, quick start, and supported environments sections
- **Regression Risk Detection**: Made regression risk detection more robust
  - More reliable edit-burst detection and risk scoring for AI-generated code changes
  - Improved handling of edge cases and cross-platform paths in risk scoring
- **LLM Cost Data Migration**: Cost data is now migrated from workspace state to global state on upgrade for backward compatibility
  - Ensures users don't lose cost history when upgrading; migration runs once on activation and is idempotent
  - Invalid or corrupted workspace data is repaired before migration when possible
  - Migration failures are non-blocking so extension activation is not affected

## [0.3.35] - 2026-02-10

### Fixed
- **Activity Bar Icon**: Fixed custom SVG icon not rendering (VS Code showed generic puzzle piece fallback)
  - Root cause: `package.json` used the wrong contribution key `viewContainers` (missing 's') — VS Code expects `viewsContainers`
  - With the wrong key, VS Code ignored the container definition but still created the activity bar entry from the `views` contribution, resulting in a default icon
  - Fixed by renaming `viewContainers` → `viewsContainers` in `package.json`
  - Updated regression tests to assert the correct key name
  - **Note for affected users**: If the Samurai Agent view appears in the Explorer panel instead of the Activity Bar, right-click the view tab and select "Move to Activity Bar", or run `View: Reset View Locations` from the Command Palette. This can happen because VS Code caches view locations from the previous broken version.
- **Activity Bar Hover Text**: Fixed tooltip showing "Agent Panel" instead of "Samurai Agent" when hovering the activity bar icon
  - Renamed view `name` from "Agent Panel" to "Samurai Agent" in package.json
  - VS Code uses the view name as hover text when a container has exactly one view
  - Added regression tests to prevent hover text drift (icon exists, SVG format, name matches container title)

## [0.3.34] - 2026-02-10

### Added
- **Error Sanitizer**: New `errorSanitizer` utility maps raw LLM errors to user-friendly messages
  - Categorizes errors into network, rate_limit, server, auth, timeout, empty_response, and unknown
  - Users see actionable messages (e.g. "network issue — check your connection") instead of raw stack traces
  - "Free tier limit reached" messages pass through unchanged
  - `isRetryableFromErrorString` helper determines if an error is worth retrying based on category
  - Comprehensive test coverage (144 new test cases)

### Fixed
- **Regression Detection Timing**: Fixed premature burst emission caused by async delays in EditBurstTracker
  - Added optimistic idle-timer reset before async repo resolution and FS debounce, preventing the idle timer from expiring during processing delays
  - Rapid consecutive file changes now correctly extend the idle window instead of triggering early emission
- **Edit Burst Path Filtering**: Stopped ignoring `lib/` and `esm/` directories in change detection
  - Removed `lib/` and `esm/` from ignored path segments so user source files in these folders are tracked
- **LLM Error Display**: Raw technical errors (e.g. `TypeError: fetch failed`, `ECONNREFUSED`) no longer leak to users
  - `DebugSessionController` now sanitizes both PlanningAgent error results and caught exceptions before displaying

### Improved
- **Agent Retry Logic**: PlanningAgent and RuntimeAnalysisAgent now retry once on transient LLM failures
  - Retries on network errors, timeouts, server errors, rate limits, and empty responses (3s delay)
  - Uses `LLMError.retryable` flag with `isRetryableFromErrorString` fallback
  - Auth and unknown errors are not retried

## [0.3.33] - 2026-02-09

### Added
- **Regression Banner Demo Link**: Added "Watch 30s demo" link to the regression detection welcome banner
  - Small `▶ Watch 30s demo` text link placed under the banner subtext for easy discovery
  - Opens a short YouTube demo in the user's default browser
  - Styled as a subtle link so it doesn't compete with the primary "Enable" CTA
  - New `openExternalUrl` webview command handler for safely opening external URLs

## [0.3.32] - 2026-02-09

### Added
- **In-IDE Regression Code Review (Beta)**: One-click regression review when AI edits your code
  - New "Start Regression Review" command to analyze AI-generated changes for potential regression bugs
  - Auto regression detection with configurable risk threshold (always / moderate / high)
  - EditBurstTracker detects AI edit bursts and triggers risk scoring via RegressionRiskScorer
  - RegressionNotificationService shows warnings when regression risk exceeds threshold
  - New settings: `regressionDetection.enabled`, `riskThreshold`, `cooldownSeconds`, `idleSeconds`, `maxBurstDurationSeconds`
  - Welcome banner promotes the feature; can be enabled or dismissed from settings
- **Git Diff Tool**: Agent can now fetch git diffs (working tree, branch comparisons, or between commits)
  - New `git-diff` tool with modes: `working-tree`, `branch`, `commits`
  - Token/size caps to prevent token explosion; supports file filtering

### Fixed
- **Regression Detection Setting Lost on Save**: `enableRegressionDetection` is now persisted correctly when saving global settings
  - `updateGlobalSettingsFromUI()` was missing this field; editBurstTracker syncs when setting changes
- **Gemini Proxy Retry Logic**: Fixed proxy model not retrying on transient failures
  - Extended retry time budget from 60s to 5 minutes to allow retries after timeout
  - Retry on parse errors and proxy server errors (5xx); no retry on client errors (4xx)
  - Proper HTTP status handling before JSON parse to avoid treating HTML error pages as JSON
- **Activity Bar "View container does not exist"**: Fixed typo `viewsContainers` → `viewContainers` in package.json

### Improved
- **Agent Telemetry**: Expanded PostHog metrics for better product insights
  - New fields: `num_parse_retries`, `num_empty_llm_responses`, `reached_max_steps`, `used_fallback_response`
  - Added `empty_response` error type for clearer failure categorization
- **Codebase Cleanup**: Removed ~3,700 lines of dead SamuraiAgent code
  - Active flow uses DebugSessionController; removed legacy SamuraiAgent class and fallback paths
  - Activity bar icon now uses `resources/icon.svg` instead of generic `$(debug-alt)`

## [0.3.31] - 2026-01-31

### Fixed
- **Claude (Anthropic) Model**: Resolved issues when using Claude models for analysis
  - Switched from `messages.create` to streaming API (`messages.stream` + `finalMessage`) for compatibility and reliability
  - Correct handling of system vs chat messages: system content is sent in `system` and only user/assistant messages in `messages`, so Anthropic API requirements are met
  - Validation now requires at least one user or assistant message (in addition to optional system messages)
  - Token handling: input is truncated when exceeding model limits; `max_tokens` is capped per model (e.g. 32000 for Opus 4.1, 8192 for Sonnet/Haiku) to avoid API errors
- **Error Path Telemetry**: Analysis failure telemetry is now sent reliably to PostHog
  - `executionSuccess` is set to `false` in the catch block so outcome is recorded correctly
  - Telemetry is finalized and sent immediately in the error path so error events are not lost if the process exits before the `finally` block
  - Shared `finalizeTelemetryForSession` used for both success and error paths; `finalizeAndTrackOnce` keeps emission idempotent

### Improved
- **DebugSessionController**: Telemetry finalization refactored into a single helper for clarity and consistent behavior on success and failure

## [0.3.30] - 2026-01-29

### Fixed
- **Empty LLM Response Handling**: Agent responses are now persisted even when the LLM returns empty content
  - Backend saves fallback error message to storage before notifying the webview, so messages are not lost if the webview is closed or tab is switched
  - Empty-response path uses same persistence flow as successful responses for consistent chat history
  - GeminiBetaProxyClient retries on "empty content" errors and respects a 60s retry time budget (aligned with GeminiChatClient)
- **Message Not Saved on Tab Switch**: Fixed messages disappearing when users switch away and back during analysis
  - Backend persists agent responses to the DataStore before posting to the webview, so messages are saved even when the webview is not visible
  - Webview receives `alreadyPersisted` and skips duplicate save when the backend has already stored the message
  - Idempotency via backend-generated message IDs and `savedMessageIds` prevents duplicate saves when the same event is processed multiple times
- **Mermaid Graph Auto-Open**: Code visuals modal now opens only when explicitly requested instead of by default
  - Reduces unexpected popups; graph can still be viewed when needed

### Improved
- **Chat Input During Analysis**: Chat input and "Run Analysis" button are disabled while the agent is running
  - Button label changes to "Running..." during analysis to indicate progress
  - Prevents duplicate submissions and clarifies that analysis is in progress
- **Tab Switch State Restoration**: When returning to the Samurai Agent tab during analysis, the UI correctly shows the waiting state
  - Backend exposes `isSessionBusy(sessionId)`; webview receives `isBusy` in `initialSettings` and restores disabled input and "Resuming analysis..." progress indicator
  - Ensures consistent UX when switching between VS Code panels or tabs
- **Agent Error Handling**: New `agentError` message type clears busy state and shows an error when the background agent fails
  - Prevents the chatbox from staying disabled if the agent errors out
- **Welcome Message**: Updated welcome copy (root cause/fix review steps, ~1–3 minutes, @ file pinning) for clarity and consistency with README

## [0.3.28] - 2026-01-28

### Improved
- **README & Onboarding**: Overhauled README and documentation for clearer value proposition and faster onboarding
  - Restructured README with TL;DR, problem/solution, and step-by-step "How to Use" (add files → run analysis → apply fix → review fix)
  - Added new demo GIFs: pinned files + bug description, copy-prompt workflow, and review-fix flow
  - Updated extension description and keywords (regression bugs, bug fix review, ai code review, runtime analysis)
  - Clearer messaging around preventing regression bugs and reviewing AI-generated fixes before shipping

## [0.3.27] - 2026-01-26

### Fixed
- **Empty LLM Response Handling**: Enhanced retry logic for empty LLM responses to improve session reliability
  - Added automatic retry mechanism in GeminiChatClient when API returns empty content
  - Implemented retry logic in LLMProviderService to handle empty responses from all providers
  - Empty responses are now automatically retried up to 2 additional attempts (3 total attempts)
  - Improved error handling converts persistent empty responses to proper error messages
  - Enhanced reliability of debugging sessions by catching and retrying transient API issues
  - Better error messages when all retry attempts return empty responses
  - Comprehensive test coverage for retry scenarios and edge cases
  - Prevents session failures due to temporary API glitches or rate limiting that return empty content

## [0.3.23] - 2026-01-26

### Improved
- **Chat UI Reorganization**: Enhanced chat interface layout for better context visibility
  - Moved pinned files section above chat input for immediate visibility and easier access
  - Moved tech documentation input above chat input to prioritize context gathering
  - Improved visual hierarchy with context inputs (pinned files, tech docs) positioned before message input
  - Better workflow flow: context setup → message input → analysis execution
  - More intuitive layout that guides users through the debugging workflow
- **UI Cleanup**: Streamlined interface by hiding unused and experimental features
  - Hidden "Show Code Visuals" button and code visuals modal (preserved for future use)
  - Removed chat input hint tips to reduce visual clutter
  - Cleaner interface focuses attention on core debugging workflow
  - Experimental features preserved in codebase but hidden from UI for cleaner experience

## [0.3.22] - 2026-01-25

### Fixed
- **Workspace Error Handling**: Fixed issue where error messages were shown when no workspace folder is opened
  - Replaced error messages with helpful workspace banner that guides users to open a folder
  - Banner appears in welcome message area with clear instructions and "Open Folder" button
  - Improved user experience by providing actionable guidance instead of error messages
  - Banner automatically hides when workspace is opened and shows when workspace is closed
  - Real-time workspace state tracking notifies webview when workspace state changes

### Improved
- **Workspace State Management**: Enhanced workspace detection and state handling
  - Added workspace change listener to notify webview when workspace folders are added or removed
  - Settings now load properly even when no workspace is open, preventing initialization errors
  - Added support for opening folders directly from webview via "Open Folder" command
  - Improved error handling to gracefully handle workspace-related operations when no workspace is available
  - Better integration between extension backend and webview frontend for workspace state synchronization
  - Comprehensive test coverage for workspace banner functionality and state management

## [0.3.21] - 2026-01-21

### Improved
- **Pinned File Search**: Enhanced file search experience with two-phase search and better ranking
  - Two-phase search provides instant results from opened files while workspace search runs in parallel
  - Improved file ranking prioritizes pinned files and files in the same folder as the active file
  - Better autocomplete with debounced search (250ms) for smoother typing experience
  - Enhanced file matching with case-insensitive search and intelligent deduplication
  - Faster file discovery by showing opened files immediately before workspace search completes
  - Improved user experience when pinning files with `@filename` syntax
- **LLM Response Reliability**: Added retry logic for empty LLM responses to improve session reliability
  - Automatic retry when LLM returns empty content in successful responses
  - Enhanced error handling converts empty responses to proper error messages
  - Improved reliability of debugging sessions by catching and retrying transient API issues
  - Better error messages when retry attempts also fail
  - Comprehensive test coverage for retry scenarios and edge cases
  - Prevents session failures due to temporary API glitches or rate limiting

## [0.3.20] - 2026-01-17

### Added
- **Welcome Message**: Introduced welcome message for empty chat sessions to guide first-time users
  - Displays when chat is empty with clear step-by-step instructions
  - Shows quick start guide with 3 simple steps to begin debugging
  - Highlights key features (root cause analysis, fix prompt generation)
  - Indicates time expectations (~1–5 minutes) for better user expectations
  - Reminds users about free trial availability with no setup required
  - Automatically hides when first message is sent to keep interface clean
- **Run Analysis Button**: Added prominent "Run Analysis" button next to model selection
  - Primary action button styled to draw attention for better conversion
  - Positioned prominently in model selection area for easy access
  - Provides clear call-to-action to start debugging analysis
  - Improves discoverability of core functionality for new users

### Changed
- **Chat Header Simplification**: Streamlined chat header for better focus
  - Removed API cost display from chat header to reduce visual clutter
  - Renamed "Start New Conversation" to "Clear Chat" for clearer action intent
  - Updated button styling to use secondary button style for "Clear Chat"
  - Improved visual hierarchy with primary "Run Analysis" button taking focus

### Improved
- **Onboarding UX**: Enhanced first-time user experience to improve conversion
  - Welcome message provides immediate guidance without requiring user research
  - Clear visual hierarchy guides users from welcome → model selection → run analysis
  - Reduced friction by disabling pinned file warning (too interruptive for first-time users)
  - Better button styling creates clear primary vs secondary action distinction
  - Improved discoverability of core workflow through welcome message and prominent CTA

## [0.3.19] - 2026-01-16

### Added
- **Samurai Pro Free Trial**: Introduced free trial model for immediate access without API key setup
  - New "Samurai Pro (Free Trial · Daily Limit)" model available to all users without configuration
  - No API key or beta code required to get started with the extension
  - Uses proxy-based authentication with secure access token for seamless onboarding
  - Set as default model for new installations to lower barrier to entry
  - Appears first in model selection list for easy discovery
  - Shares daily free-trial limit with Samurai Lite for shared usage management
  - Enables instant testing and evaluation of the extension before committing to API costs
  - Perfect for trying out root cause analysis capabilities with zero setup friction
  - Users can upgrade to full access by adding their own API key when ready

### Improved
- **Onboarding Experience**: Enhanced first-time user experience with zero-configuration access
  - New users can immediately start debugging without any setup steps
  - Default model selection prioritizes free trial option for instant usability
  - Clear model naming distinguishes free trial from beta and paid options
  - Seamless transition path from free trial to full access with API key
  - Updated README with free trial instructions for easier onboarding

## [0.3.18] - 2026-01-15

### Added
- **Search & File Ledger**: Introduced intelligent duplicate detection system to prevent redundant tool calls and accelerate debugging sessions
  - Tracks all code-search queries and static-analysis file operations per session
  - Prevents duplicate searches by normalizing queries and detecting exact, widening, and variant duplicates
  - Detects when files have already been analyzed to avoid redundant static-analysis calls
  - Provides compact ledger summary (<1200 chars) injected into agent prompts for context awareness
  - Automatically suggests best candidate files from recent searches to guide next actions
  - Reduces iteration loops and token usage by preventing repeated tool executions
  - Comprehensive test coverage (439 new tests) for duplicate detection logic
  - Significantly improves debugging session efficiency and reduces unnecessary LLM calls

### Fixed
- **ESM Dynamic Import Errors**: Fixed ESM dynamic import errors in PlanningAgent
  - Consolidated multiple dynamic imports into single import at method start
  - Resolved circular dependency issues with telemetry module imports
  - Improved reliability of agent execution by ensuring proper module loading
  - Enhanced test coverage for PlanningAgent execution scenarios

### Improved
- **Code Search Performance**: Enhanced code search efficiency through duplicate prevention
  - Agent now receives ledger context showing recent searches and opened files
  - Automatic pattern normalization for better duplicate detection (handles API paths, wildcards, etc.)
  - Smart superset detection for file patterns to prevent redundant searches
  - Reduced token consumption by avoiding repeated tool calls with same parameters
  - Better agent decision-making through ledger-based context awareness

## [0.3.17] - 2026-01-08

### Improved
- **PostHog Privacy & Behavioral Analytics**: Enhanced PostHog telemetry configuration with stronger privacy protections
  - Disabled IP geolocation (`disableGeoip: true`) to prevent location tracking
  - Strict allowlist-based property filtering ensures only behavioral metadata is collected
  - **No raw data collection**: We do not collect raw user messages, code content, file contents, or any personally identifiable information
  - **Behavioral data only**: Collects anonymized behavioral metrics to improve user experience:
    - Usage patterns (text length, token counts, file counts, interaction types)
    - Technical metadata (language detection from file extensions, framework detection from package.json dependencies)
    - Performance metrics (latency, LLM calls, success rates)
    - Agent execution metadata (tools used, loop counts, error types)
  - Language detection uses file extensions only - never reads file contents
  - Framework detection uses already-loaded package.json dependencies - no additional file reading
  - All telemetry respects user privacy settings and can be disabled at any time
  - Comprehensive sanitization ensures accidental data leakage is prevented
  - Telemetry data helps us understand usage patterns, identify performance bottlenecks, and improve debugging workflows
  - All collected data is anonymized and aggregated for product improvement purposes only

## [0.3.15] - 2026-01-06

### Added
- **File List in Copy Prompt**: Enhanced copy prompt feature to include analyzed files list for AI coding tools
  - Copy prompts now automatically include a formatted list of all files analyzed during the debugging session
  - Files are sorted alphabetically and displayed in a clear markdown format
  - Includes contextual instructions for AI coding agents (Cursor, Claude, Copilot) on how to use the file list
  - Instructions guide agents to start with listed files but verify root cause hypothesis and explore beyond if needed
  - File list appears in both the copy prompt output and as a collapsible "Advanced: analyzed files" section in chat UI
  - Improves workflow efficiency by providing AI coding agents with immediate context about relevant files
- **Agent Metrics & Telemetry**: Introduced comprehensive privacy-preserving telemetry system for agent interactions
  - New agent metrics tracking system with single-event emission and deduplication
  - Tracks input metadata (text length, token count, files attached, language, framework detection)
  - Tracks agent metadata (agent type, LLM model, provider, tools used, loop count)
  - Tracks cost metadata (prompt tokens, completion tokens, total tokens, estimated cost)
  - Tracks performance metadata (LLM calls, files opened, latency)
  - Tracks outcome metadata (success, error types, response length, runtime errors)
  - Privacy-preserving sanitization with allowlist-based property filtering
  - Automatic framework detection from package.json (React, Next.js, Express, etc.)
  - Automatic language detection from file extensions
  - All telemetry respects user privacy settings and never includes raw user messages or code
  - Comprehensive test coverage for telemetry functionality

### Improved
- **Copy Prompt Quality**: Enhanced copy prompt generation for better AI coding agent integration
  - File list section placed strategically at the top of prompts for immediate context
  - Better instructions for AI coding agents to verify hypotheses and explore beyond initial file list
  - Improved prompt structure with clear sections for files, context, hypothesis, and requirements
  - Enhanced context truncation to keep prompts under 15k characters while preserving important information
- **Agent Observability**: Enhanced logging and telemetry throughout agent execution
  - Added detailed logging at key execution points (agent loops, LLM calls, tool executions)
  - Better error tracking with categorized error types (timeout, tool_error, model_error)
  - Improved debugging capabilities with comprehensive execution metrics
  - Telemetry integration across DebugSessionController, PlanningAgent, and ToolExecutionService
  - Non-blocking telemetry that never interferes with agent execution

## [0.3.14] - 2026-01-05

### Added
- **Pinned File Warning**: Introduced contextual warning system to guide users on file pinning best practices
  - Warning appears when users attempt to send messages without pinning any files
  - Provides helpful tip about using `@filename` syntax to pin relevant files for faster debugging
  - Includes "Pin a file" button that auto-focuses the pin input field with `@` prefix
  - "Don't remind me" option to permanently dismiss the warning per user preference
  - Warning state persists across sessions using localStorage
  - Blocks message sending on first attempt when no files are pinned and warning hasn't been dismissed
  - Improves debugging workflow by encouraging users to provide context through file pinning

### Improved
- **Gemini Model Fallback**: Enhanced fallback mechanism for beta model failures
  - Improved fallback chain: beta proxy → user's Gemini API key → free tier
  - Added content validation to ensure fallback responses contain valid, non-empty content
  - Better error handling when all fallback attempts return empty responses
  - Enhanced logging for fallback attempts and success/failure tracking
  - More reliable debugging sessions when beta models encounter issues or hit rate limits
- **Empty Response Detection**: Enhanced Gemini API response validation
  - Added empty content detection before processing API responses
  - Prevents processing of empty or whitespace-only responses
  - Better error messages when API returns empty content
  - Improved reliability of LLM interactions by catching invalid responses early

## [0.3.12] - 2026-01-03

### Added
- **Copy Prompt Feature**: Introduced ability to copy formatted prompts from analysis results for AI coding agents
  - New "📋 Copy prompt" button in chat interface for each assistant message
  - Generates ready-to-use prompts formatted for AI coding agents like Cursor, Claude, and Copilot
  - Prompts include root cause hypothesis, conversation context, and verification instructions
  - Automatically formats conversation history with context and evidence
  - Includes instructions for AI coding agents to verify hypothesis, propose fixes if incorrect, and suggest regression tests
  - Smart context truncation to keep prompts under 15k characters while preserving important conversation history
  - Fallback to DOM-based message extraction when persistence API is unavailable
  - Loading states and error handling for reliable prompt generation
  - Seamless clipboard integration with modern Clipboard API and fallback support
  - Improves workflow by allowing users to seamlessly transfer Samurai Agent's root cause analysis to their preferred AI coding agent for implementation

### Improved
- **Chat Interface**: Enhanced message actions with copy prompt functionality
  - Copy prompt button appears alongside existing copy button for each assistant response
  - Button tooltip indicates compatibility with Cursor/Claude/Copilot
  - Visual feedback with loading and success states during prompt generation
  - Better integration with message persistence system for reliable context gathering

## [0.3.11] - 2025-12-30

### Improved
- **ASCII Diagram Generation**: Enhanced planning agent to automatically include ASCII diagrams in debugging responses
  - Upgraded ASCII diagram generation from "Optional" to "Strongly Recommended" for better visualization
  - Added comprehensive guidelines for when to include diagrams (multi-step flows, async patterns, state mutations, cross-file interactions)
  - Diagrams are now automatically included for most non-trivial bugs where understanding sequence, async boundaries, or state flow helps
  - Added example patterns for common scenarios like async gap issues
  - Diagrams are placed at the top of responses for immediate visual understanding
  - Improved user comprehension of complex debugging scenarios through visual flow representation
  - Only simple syntax errors are excluded from diagram generation

## [0.3.10] - 2025-12-26

### Added
- **Token Limit Validation**: Implemented comprehensive token limit validation and truncation system
  - Added token estimation utilities for accurate token counting using heuristic (~4 characters per token)
  - Automatic message truncation when requests exceed model token limits
  - Token validation integrated into LLM provider service and Gemini beta proxy client
  - Prevents API failures due to token limit exceeded errors
  - Comprehensive test coverage for token validation and truncation scenarios
- **Documentation URL Support**: Added ability to fetch and include external documentation in debugging sessions
  - New URL content fetcher utility with SSRF protection and security measures
  - Supports fetching documentation from external URLs and including in agent context
  - Automatic content extraction with readability-style text extraction
  - URL input field in chat interface with debounced validation and preview
  - Caching system for fetched documentation to avoid redundant network requests
  - Documentation context automatically included in agent prompts when URL is provided
  - Streaming size limits (10MB) and timeout protection (10 seconds) for safe fetching
  - DNS resolution validation and IP address filtering to prevent SSRF attacks

### Improved
- **Chat UI Enhancement**: Major improvements to chat interface design and functionality
  - Redesigned chat input with cursor-style integrated design for better visual appeal
  - Enhanced chat input wrapper with improved focus states and styling
  - Better spacing and padding throughout the chat interface
  - Improved action button styling and hover states
  - Settings button moved to header actions for better accessibility
  - Streamlined log input section with cleaner UI controls
- **Documentation Integration**: Enhanced debugging workflow with external documentation support
  - Documentation URLs persist across messages within a session
  - Automatic preview of fetched documentation with title and content preview
  - Error handling and user feedback for invalid URLs or fetch failures
  - Integration with DebugSessionController for seamless documentation context passing
  - Token budget management for documentation content to prevent exceeding limits

## [0.3.9] - 2025-12-18

### Added
- **Gemini 3 Flash Beta Model**: Introduced Gemini 3 Flash as a new beta testing model option
  - New `gemini-3-flash-beta` model available for beta users with valid beta codes
  - Significantly expanded context window with 64,000 max tokens (vs 8,192 for Gemini 2.5 Flash)
  - Enhanced capabilities for complex debugging scenarios requiring larger context
  - Integrated with existing beta testing infrastructure and $3 monthly sponsored limit
  - Automatic model mapping to `gemini-3-flash` API endpoint
  - Available alongside existing Gemini 2.5 Flash beta model for beta program participants

### Improved
- **Beta Model Selection**: Enhanced beta model availability and selection logic
  - Gemini 3 Flash beta automatically appears in model selection for valid beta users
  - Improved model sorting to prioritize beta models when available
  - Better integration with beta code validation and monthly limit tracking
  - Enhanced cost tracking for Gemini 3 Flash beta usage

## [0.3.0] - TBD

### Added
- **Runtime Analysis Agent ("The Scientist")**: Introduced specialized autonomous runtime analysis agent for backend Node.js/TypeScript code
  - Creates minimal reproduction scripts and executes them to capture runtime values
  - Autonomous wrapper script generation protocol for safe code execution
  - Integrated with Node.js debugger via Chrome DevTools Protocol (CDP) for runtime inspection
  - Supports variable extraction, breakpoint-based inspection, and crash capture
  - Automatic cleanup of debug ports and processes before execution
  - Thought history tracking for runtime analysis sessions with automatic compression
  - Comprehensive test coverage for runtime analysis workflows
- **Runtime Debug Tool**: New high-level tool for autonomous runtime analysis
  - Delegates to RuntimeAnalysisAgent for intelligent runtime value capture
  - Supports multiple target analysis in single execution
  - Automatic grouping of targets sharing the same execution context
  - Integrated cost tracking for runtime analysis operations
- **Variable Name Clickability**: Enhanced debugging interface with clickable variable names
  - Variable names in runtime analysis results are now clickable for quick navigation
  - Improved user experience for exploring variable values and locations
  - Better integration between runtime analysis results and code navigation

### Changed
- **Planning Agent Tool Filtering**: Optimized tool availability for planning agent
  - Planning agent now only receives planning-specific tools (code-search, graph-context, git-history, static-analysis, lsp-diagnostics, runtime-debug)
  - Runtime analysis agent receives its own specialized tool set (code-search, static-analysis, sandbox-fs, node-process, runtime-inspector)
  - Improved agent specialization and reduced token usage
  - Better separation of concerns between high-level planning and low-level runtime analysis
- **Runtime Debug Call Limits**: Added safeguards to prevent excessive runtime execution
  - Maximum runtime-debug call limit per planning agent session to prevent excessive execution time
  - Automatic filtering of runtime-debug calls when limit is reached
  - System notices to planning agent when runtime-debug calls are filtered
  - Improved cost and time management for debugging sessions

### Fixed
- **LLM Response Parsing**: Enhanced robustness of LLM response parsing
  - Improved handling of malformed or truncated JSON responses
  - Better error recovery and fallback strategies for parsing failures
  - Enhanced validation and error messages for debugging parsing issues
  - More reliable extraction of structured data from LLM responses

### Improved
- **Runtime Analysis Agent Integration**: Enhanced integration of runtime analysis with planning agent
  - Runtime analysis agent now receives past thoughts from planning agent for better context
  - Improved thought history compression and management (keeps last 5 thoughts)
  - Better context passing between planning and runtime analysis agents
  - Enhanced logging and observability for runtime analysis workflows
- **Thought History Management**: Improved thought history tracking across agents
  - Automatic compression of old thoughts into facts when history exceeds limit
  - Better preservation of key learnings from thought history
  - Enhanced thought history integration in runtime analysis agent prompts
  - Improved context awareness through thought history sharing
- **Test Coverage**: Expanded test suite for new runtime analysis features
  - Comprehensive tests for RuntimeAnalysisAgent functionality
  - Enhanced test coverage for planning agent tool filtering
  - Improved test robustness for LLM parsing edge cases

## [0.2.0] - 2025-12-03

### Added
- **Beta v0.2 Debugging Agent**: Major new debugging agent implementation with enhanced investigation workflows
  - Implemented comprehensive debugging agent with multi-step investigation process
  - Added intermediate log saving system for agent transparency and debugging
  - Enhanced root cause analysis with hypothesis generation and testing
  - Improved behavior specification extraction for better bug understanding
  - Added strategic rules engine for common debugging pitfalls
- **New Engine Tools**: Introduced powerful debugging tools for comprehensive code analysis
  - **GraphContextTool** ("Map it"): Builds visualizable dependency and execution graphs around specific files or symbols
    - Creates focused execution graphs using static analysis
    - Supports depth configuration and symbol-level focus for precision
    - Generates Mermaid diagrams for visual code flow representation
  - **StaticAnalysisTool** ("Read it"): Analyzes code structure, complexity, and detects logical bugs
    - Three analysis modes: metrics (complexity analysis), source (code extraction), and flow (data flow analysis)
    - Detects common logical issues through data flow analysis
    - Supports targeted symbol analysis for focused investigations
  - **CodeSearchTool**: Intelligent code search across the codebase
  - **GitHistoryTool**: Analyzes git history for context and change tracking
  - **LspDiagnosticsTool**: Integrates VS Code LSP diagnostics into debugging workflow
- **Image Generation Service**: Added graph visualization image generation using Gemini 3 Pro Image Preview
  - Generate high-quality visual representations of execution graphs
  - Supports 16:9 aspect ratio and 2K image resolution
  - Integrated image generation button in chat interface
  - Beta model support with proxy routing for sponsored users
  - Automatic image saving to session folders
- **Code Snippet Selection**: Users can now select code snippets directly as context
  - Enhanced context gathering with manual code selection
  - Improved precision for targeted debugging scenarios
  - Better integration between user-selected code and agent analysis

### Changed
- **Graph Visualization System**: Major improvements to execution graph visualization
  - Enhanced live graph updates during debugging sessions
  - Improved graph compression and optimization algorithms
  - Better node filtering based on root cause analysis relevance
  - Enhanced Mermaid diagram generation with proper normalization
  - Added curated subgraph extraction for focused visualizations
- **Root Cause Analysis**: Enhanced root cause analysis with more detailed reporting
  - Expanded hypothesis generation with confidence scoring
  - Improved evidence aggregation and reasoning steps
  - Better integration between graph visualization and root cause findings
  - Enhanced suspect node detection and highlighting
- **Planning Agent**: Improved agent decision-making with strategic rules
  - Added comprehensive rule selector for common debugging scenarios
  - Enhanced tool selection logic for more effective investigations
  - Better context management across debugging steps

### Fixed
- **Graph Visualization UX**: Fixed multiple graph display and interaction issues
  - Fixed node unclickable issues in graph visualizations
  - Improved initial graph sending UX to prevent empty responses
  - Fixed race condition issues in graph updates
  - Enhanced graph location tracking and file path clickability
- **Message Handling**: Improved message processing and rendering
  - Fixed issue where intermediate thoughts were being sent as final responses
  - Fixed markdown rendering issues in chat messages
  - Improved JSON parsing robustness for LLM responses
  - Fixed empty response display issues
- **Code Loading**: Enhanced code extraction and loading reliability
  - Improved code loading to ensure proper file context
  - Enhanced code search request handling from LLM
  - Better error messages when workspace is not open

### Improved
- **LLM Response Parsing**: Enhanced parsing with better error handling
  - Improved JSON extraction from LLM responses
  - Better handling of truncated or malformed responses
  - Enhanced error messages for debugging LLM integration issues
- **Debugging Workflow**: Overall improvements to debugging experience
  - Better integration between code extraction and graph building
  - Enhanced visualization service with more robust graph processing
  - Improved error handling throughout the debugging pipeline
  - Better logging and diagnostics for agent execution

## [0.1.9] - 2025-11-26

### Added
- **Onboarding Welcome Walkthrough**: Introduced VS Code walkthrough for new users
  - Added interactive welcome walkthrough that guides users to open Samurai Agent panel
  - Walkthrough appears in VS Code's Get Started view for discoverability
  - Includes step-by-step instructions with clickable commands to open the extension
  - Improves first-time user experience and reduces onboarding friction

### Changed
- **Activity Bar Icon**: Updated extension icon in Activity Bar for better visual identity
  - Changed from `$(comment-discussion)` to `$(debug-alt)` icon to better represent debugging focus
  - Icon now more clearly communicates the extension's debugging purpose
  - Improved visual consistency with debugging theme

### Improved
- **Extension Activation**: Enhanced extension activation behavior
  - Changed activation event to `onStartupFinished` for better performance
  - Extension now activates after VS Code startup completes
  - Reduces startup time impact and improves overall VS Code performance

## [0.1.8] - 2025-11-25

### Added
- **Enhanced Telemetry Tracking**: Expanded telemetry system with editor detection and user interaction tracking
  - Added editor type detection to distinguish between VS Code, Cursor, and other VS Code forks
  - Added page view tracking for chat, settings, and webview tabs to understand user navigation patterns
  - Added "Start New Conversation" event tracking to monitor conversation initiation patterns
  - All telemetry respects user privacy settings and is anonymized
  - Comprehensive tracking helps improve product insights and user experience optimization

### Improved
- **Global Settings Persistence**: Enhanced global settings initialization to ensure immediate persistence
  - Default global settings (including userId) are now immediately persisted when first created
  - Ensures userId remains consistent across installations and sessions
  - Improved reliability of user identification for telemetry and analytics
- **Telemetry Integration**: Better integration of telemetry tracking across webview components
  - Page view tracking automatically triggers when users switch between chat and settings tabs
  - Telemetry API exposed in webview for seamless tracking integration
  - Improved error handling to ensure telemetry failures don't impact core functionality

## [0.1.7] - 2025-11-24

### Improved
- **Onboarding Experience**: Enhanced chat input with contextual placeholder examples
  - Added dynamic placeholder text that rotates through real-world debugging scenarios
  - Placeholders demonstrate common use cases: race conditions, performance bottlenecks, logic flow breaks, framework detection issues, and parser edge cases
  - Helps new users understand what types of questions Samurai Agent can help debug
  - Randomly selects from 5 example scenarios to provide variety and inspiration
  - Improves discoverability of debugging capabilities for first-time users

## [0.1.6] - 2025-11-23

### Added
- **Tally Form Feedback System**: Integrated Tally.so embedded feedback form for improved user feedback collection
  - Added embedded Tally form iframe in debugging message feedback containers
  - Automatic Tally embed script loading with fallback handling for reliability
  - Lazy loading and proper iframe initialization for better performance
  - Enhanced feedback collection workflow with external form integration

### Improved
- **Feedback UI Management**: Enhanced feedback form visibility controls
  - Added hide/show functionality for feedback forms to improve UI cleanliness
  - Better state management when toggling between Tally form and advanced feedback options
  - Improved user experience with more intuitive feedback form interactions
- **Beta Testing UX**: Optimized feedback interface for beta testing phase
  - Temporarily hidden legacy feedback buttons during beta testing
  - Streamlined feedback collection to focus on Tally form integration
  - Cleaner interface for beta users with simplified feedback workflow

## [0.1.5] - 2025-11-21

### Changed
- **Product Focus Simplification**: Streamlined Samurai Agent to focus exclusively on debugging workflows
  - Removed legacy modes: spec planning, feature exploration, pure discussion, spec clarification, and spec generation
  - All sessions now default to debugging mode for consistent, focused experience
  - Simplified agent architecture by removing ~9,000 lines of legacy code
  - Improved codebase maintainability and reduced complexity

### Improved
- **Onboarding Experience**: Enhanced user onboarding with clearer instructions
  - Added quick start tutorial video link in README
  - Improved installation steps with clearer navigation instructions
  - Better guidance on accessing Samurai Agent panel and settings
  - More intuitive flow for new users getting started with the extension
- **Code Quality**: Major codebase cleanup and refactoring
  - Removed unused prompt files and legacy system prompts
  - Eliminated spec-related UI components (spec.css, spec.js) that are no longer needed
  - Cleaned up obsolete test files and outdated functionality
  - Improved code organization and reduced technical debt

## [0.1.4] - 2025-11-19

### Added
- **Gemini 3 Pro Model Support**: Added support for Gemini 3 Pro model in both beta and preview versions
  - `gemini-3-pro-beta`: Experimental beta testing model with $3 monthly sponsored limit
  - `gemini-3-pro-preview`: Preview model with 1M input / 64k output context window (Knowledge cutoff: Jan 2025)
  - Both models support up to 20,000 max tokens for complex debugging tasks
- **Enhanced Telemetry Tracking**: Comprehensive telemetry system for better product insights
  - Added tracking for LLM API key status changes (added/updated/removed) across all providers
  - Added tracking for beta code status changes to monitor beta program adoption
  - Added tracking for telemetry setting changes to respect user preferences
  - All telemetry respects user privacy settings and is anonymized
  - Comprehensive test coverage for all telemetry features

### Changed
- **Gemini API Migration**: Migrated to latest Gemini LLM API (`@google/genai`)
  - Updated from `@google/generative-ai` to `@google/genai` for improved API compatibility
  - Enhanced system instruction handling with proper separation from message content
  - Improved request/response structure alignment with latest Gemini API specifications
  - Better support for custom API endpoints and configuration options
  - Updated model name mapping to support new Gemini 3 models

### Improved
- **Telemetry Integration**: Enhanced data persistence layer with telemetry tracking
  - DataStore and GlobalDataStore now automatically detect and track API key changes
  - Beta code changes are automatically tracked when users validate or update codes
  - Telemetry service properly initialized and integrated across all data stores
  - Improved error handling to ensure telemetry failures don't impact core functionality
- **Gemini Client Reliability**: Enhanced Gemini chat client with better error handling
  - Improved empty content detection and validation
  - Better handling of API response structures
  - Enhanced logging for debugging API integration issues
  - More robust system instruction processing

## [0.1.3] - 2025-11-16

### Added
- **Beta Code Welcome Popup**: Introduced a welcome popup for v2 beta users that appears on first activation
  - Prompts users to get a beta code for $3 in free credits
  - Includes option to open the beta code registration page or dismiss the popup
  - Popup state is persisted to prevent repeated prompts
- **Beta Code Link in Chat**: Added helpful link under LLM model selection to guide users to get their beta code
  - Displays when beta code is not yet entered
  - Provides direct link to samurai-agent.tech for beta code registration
  - Improves discoverability of the beta testing program

### Fixed
- **Node Analysis Display**: Fixed issue where multiple node analyses were being displayed simultaneously
  - Now correctly shows only one node analysis at a time
  - Improves clarity and reduces visual clutter in the debugging interface

### Improved
- **Debugging Process Steps**: Enhanced root cause analysis with more detailed step-by-step guidance
  - Added comprehensive step descriptions throughout the debugging workflow
  - Improved clarity of the investigation process for users
  - Better integration of detailed steps in both agent execution and root cause analysis

## [0.1.0] - 2025-11-12

### Added
- **AI Debugging Agent**: Introduced a dedicated debugging agent optimized for JavaScript and TypeScript projects with guided investigation flows and context-aware prompts.
- **Runtime Signal Ingestion**: Added support for uploading stack traces, console output, and telemetry snapshots that the agent incorporates into its analysis.
- **Root Cause Explorer**: Launched interactive root cause reports that surface suspected failure nodes, impacted files, and suggested instrumentation.
- **Fix Drafting Toolkit**: Added automated patch proposals with inline reasoning, test scaffolding suggestions, and follow-up verification steps.

### Changed
- **Product Pivot**: Repositioned Samurai Agent from a general code understanding assistant to a focused AI debugging companion for modern JS/TS stacks.
- **Default Workflows**: Updated command palette entries, webview layout, and onboarding to prioritize debugging entry points and recent failure reports.
- **LLM Prompt Library**: Rewrote debugging prompt suite to emphasize stack trace synthesis, async flow diagnosis, and framework-aware heuristics.

### Improved
- **JS/TS Analysis Engine**: Enhanced dependency graph building, async boundary detection, and type-aware reasoning to reduce false positives in failure attribution.
- **Performance & Cost Controls**: Tuned batching, caching, and retry strategies for lower latency and predictable token usage during long debugging sessions.
- **Telemetry & Observability**: Expanded PostHog and internal diagnostics to track debugging workflow success rates and surface agent accuracy metrics.

## [0.0.22] - 2025-10-23

### Fixed
- **CRITICAL**: Fixed beta cost tracking to properly identify beta model usage
  - Enhanced cost tracking logic to only mark as beta usage when both beta code is valid AND model is gemini-2.5-flash-beta
  - Fixed cost record creation in extension.ts, webview provider, and LLM provider service
  - Improved beta user detection accuracy for cost analytics and telemetry
- **Beta Model Reliability**: Enhanced beta model request handling with improved retry logic
  - Added progressive timeout system (120s → 180s → 240s) for beta model requests
  - Implemented comprehensive retry logic with empty content detection and validation
  - Added defensive checks to prevent empty content responses from being processed
  - Enhanced error handling for proxy timeouts and cold start scenarios
- **Code Extraction Analysis**: Improved reliability of code extraction analysis requests
  - Added retry logic with up to 2 additional attempts for failed LLM calls
  - Enhanced JSON parsing validation with better error messages
  - Improved empty content detection and handling in LLM responses
  - Added progressive retry delays to handle temporary API issues

### Improved
- **Beta Model Performance**: Optimized beta model request handling
  - Increased base timeout from 30s to 120s to accommodate Render free tier cold starts
  - Added progressive timeout multipliers for retry attempts
  - Enhanced logging for timeout calculations and retry attempts
  - Improved error categorization for better debugging and monitoring

## [0.0.20] - 2025-10-17

### Added
- **Beta Testing Mode**: Introduced comprehensive beta testing system for new features
  - Added beta model selection feature in settings UI
  - Integrated beta testing framework with LLM provider service
  - Added telemetry tracking for beta feature usage
  - Created comprehensive test coverage for beta models functionality
- **Code Extraction Enhancements**: Major improvements to code parsing and context extraction
  - Implemented CodeParserCache for improved performance and reduced redundant parsing
  - Added DocumentationExtractor for automatic extraction of JSDoc and docstrings
  - Added ExportAnalyzer to track module exports and public APIs
  - Added PatternDetector to identify framework-specific patterns (React, Django, Spring)
  - Implemented RelationshipTracker for better understanding of code dependencies
  - Added SnippetEnricher to provide richer code context with relationships and documentation
- **Recent Files Tracking**: Added system to track and suggest recently opened files
  - Automatically tracks recently viewed files in the workspace
  - Integrated with code extraction to provide better context
  - Added comprehensive test coverage for recent files functionality
- **Context File Pinning**: Implemented file pinning system for persistent context
  - Users can pin important files for continuous context across chat sessions
  - Pinned files are prioritized in code extraction
  - Added UI controls for managing pinned files
  - Created comprehensive test suite for file pinning functionality
- **Spec Relationship Visualization**: Enhanced spec artifact generation with relationship tracking
  - Added Mermaid diagram support for visualizing spec relationships
  - Implemented MermaidValidator for validating diagram syntax
  - Enhanced spec clarification prompts to better capture spec relationships
  - Added "Show Current Spec" button in chat UI for viewing active spec context
- **Code Extraction Keywords**: Improved keyword handling in code extraction
  - Better merging of user-provided and AI-extracted keywords
  - Enhanced duplicate keyword filtering
  - Added contextual keyword suggestions based on recent files

### Fixed
- **CRITICAL**: Fixed spec relationship tracking to ensure all specs are properly connected
  - Enhanced spec artifact generation to validate parent-child relationships
  - Improved spec clarification flow to maintain relationship integrity
  - Added comprehensive test coverage for spec relationship scenarios
- **CRITICAL**: Fixed Japanese input composition issue in chat
  - Chat no longer sends message on Enter key when composing Japanese/CJK characters
  - Added `isComposing` check to prevent premature message submission
  - Improves user experience for non-English speakers using IME
- **Code Extraction Bug**: Fixed keyword merging logic that was causing duplicate keywords
  - Improved deduplication algorithm to handle case-insensitive matching
  - Better integration between user keywords and AI-extracted keywords
- **Language Detection**: Improved language handling in spec generation
  - Changed from "last message" language detection to "main language" detection
  - Better multilingual support for users mixing English technical terms with native language

### Improved
- **Enhanced Code Parser Performance**: Major performance improvements in code parsing
  - Implemented caching layer to avoid re-parsing unchanged files
  - Optimized tree-sitter queries for better performance
  - Added performance benchmarks and optimization tests
- **Better Code Context Quality**: Significantly improved quality of extracted code context
  - Richer code snippets with documentation and relationship information
  - Better detection of framework-specific patterns and idioms
  - Enhanced understanding of module exports and API surfaces
- **Improved Spec Generation Prompts**: Enhanced prompts for better spec quality
  - Added explicit instructions for Mermaid diagram generation
  - Improved spec relationship tracking in prompts
  - Better handling of root cause analysis in bug scenarios
- **Enhanced Test Coverage**: Added extensive test suites for new features
  - Beta testing integration tests (445 new tests)
  - Code parser component tests (1,500+ new assertions)
  - Context file pinning tests (521 new tests)
  - Mermaid validation tests
  - Recent files tracking tests (512 new tests)
  - Webview functionality tests (256 new tests)

## [0.0.19] - 2025-10-15

### Note
- Version 0.0.19 was an intermediate release with incremental improvements that are now fully documented in version 0.0.20

## [0.0.18] - 2025-10-09

### Added
- **Free Tier Launch**: Introduced free tier to lower barrier to entry
  - Users can now use Samurai Agent immediately without API key setup
  - No credit card or LLM provider configuration required to get started
  - Enables instant testing and evaluation of the extension
  - Perfect for trying out the extension before committing to API costs
- **Copy All Spec Feature**: Added ability to copy entire spec hierarchy to clipboard
  - New "Copy All Spec" button on each spec card
  - Copies the selected spec and all its descendant subspecs in hierarchical markdown format
  - Automatically formats specs with proper markdown heading levels based on hierarchy depth
  - Preserves parent-child relationships in the copied content for easy sharing and documentation
- **LLM Model Tracking in Telemetry**: Enhanced telemetry system to track which LLM model is used for each chat interaction
  - Added optional `llmModelUsed` parameter to `TelemetryService.trackChatMessage()` method
  - Telemetry now includes LLM model ID (e.g., gpt-4, claude-3-sonnet, gemini-flash-2.5) in chat interaction events
  - DataStore automatically extracts LLM model from session metadata and passes it to telemetry
  - Only includes model information in telemetry when model ID is present and non-empty
  - Helps track usage patterns and model preferences across the user base

### Improved
- **Enhanced Test Coverage**: Added comprehensive unit tests for LLM model tracking
  - Tests verify model tracking for both user messages and agent responses
  - Tests ensure model information is only included when present and non-empty
  - Tests cover edge cases like undefined, empty string, and whitespace-only model IDs
  - Added integration tests in dataStore.telemetry.test.ts for end-to-end telemetry flow

## [0.0.16] - 2025-10-09

### Fixed
- **README Demo GIF**: Fixed demo gif filename in README to use correct spelling
  - Corrected filename from `samuri-agent-demo.gif` to `samurai-agent-demo.gif`
  - Ensures demo gif displays properly in VS Code marketplace and GitHub

## [0.0.15] - 2025-10-09

### Improved
- **Comprehensive README Overhaul**: Significantly improved documentation for better user onboarding and understanding
  - Added animated demo gif showcasing extension functionality with proper VS Code marketplace path formatting
  - Restructured content with clear sections: Why Samurai Agent, When to Use, How It Works, Setup, Quick Commands, Privacy & Telemetry, and FAQ
  - Enhanced value proposition explaining LLM-based code understanding vs grep-based keyword search
  - Added detailed comparison showing how Samurai Agent references existing code instead of suggesting generic solutions
  - Improved setup instructions with recommended LLM provider configuration (Gemini Flash 2.5)
  - Added comprehensive FAQ section addressing common questions about LLM-based analysis benefits
  - Clarified positioning as a complementary tool for complex features, refactoring, and difficult bugs
  - Enhanced privacy section emphasizing code privacy and telemetry control

## [0.0.14] - 2025-10-07

### Changed
- **Expanded VS Code Compatibility**: Lowered minimum VS Code version requirement from `^1.104.0` to `^1.75.0`
  - Extension now supports VS Code versions from early 2023 onwards
  - Significantly increases potential user base by supporting users who haven't updated to the latest VS Code
  - Maintains compatibility with all modern VS Code features used by the extension

## [0.0.13] - 2025-10-05

### Added
- **LLM Cost Tracking System**: Implemented comprehensive cost tracking with real-time status bar display
  - Real-time cost display in VS Code status bar showing session and total costs
  - Cost details command (`samurai-agent.showCostDetails`) for detailed cost breakdown
  - Persistent cost storage across VS Code sessions with monthly statistics
  - Cost tracking for all LLM provider calls (OpenAI, Gemini, Anthropic)
  - Automatic cost updates after each agent execution
- **Enhanced PostHog Logging**: Added comprehensive logging throughout the extension
  - Detailed cost tracking logs for debugging and monitoring
  - Enhanced error context with request IDs and execution metadata
  - Improved telemetry for better extension performance monitoring

### Fixed
- **CRITICAL**: Fixed webview lifecycle issues that caused model list and chat history to disappear
  - Added visibility change handler to re-initialize webview state when returning to tabs
  - Fixed model name not showing when closing and reopening VS Code plugin
  - Enhanced message persistence with retry mechanisms for database synchronization
  - Fixed tab switching issues that caused message loss during navigation
  - Added robust fallback mechanisms for webview state management
- **CRITICAL**: Fixed message persistence race conditions
  - Enhanced message detection logic to prevent unnecessary reloading
  - Added state tracking to prevent duplicate message loading
  - Implemented refresh throttling to prevent rapid successive refreshes
  - Added comprehensive retry mechanisms for database write operations

### Improved
- **Webview State Management**: Enhanced webview lifecycle handling
  - Centralized `refreshWebviewState()` function for consistent state management
  - Added periodic checks and timeout-based refreshes for edge cases
  - Improved DOM state checking with multiple criteria for message detection
  - Enhanced logging for debugging webview lifecycle issues
- **Cost Display Integration**: Seamless cost tracking integration
  - Status bar shows current session cost and total cost with clickable details
  - Real-time cost updates without requiring webview refresh
  - Persistent cost storage with monthly aggregation and statistics
  - Cost formatting with proper currency display and precision

## [0.0.12] - 2025-10-03

### Added
- **Keyword Trigger Hints**: Added helpful keyword trigger examples to chat input area
  - "please read the latest code" for code extraction tool
  - "create specs" for specification creation tool
- **Keyword Search for Code**: Implemented intelligent keyword-based code search functionality
- Enhanced user experience with discoverable tool triggers in chat interface

### Improved
- Chat input now displays keyword examples to help users discover tool functionality
- Better onboarding experience for new users with visible tool trigger suggestions



### Added
- **PostHog Error Tracking**: Implemented centralized error tracking system with `TelemetryService.captureError` method
- **SamuraiAgent Error Monitoring**: Added PostHog error capture to SamuraiAgent.execute method for critical error tracking
- **ExtractCodeTool Error Monitoring**: Added comprehensive PostHog error tracking to ExtractCodeTool for all error scenarios:
  - Main execution failures with detailed context (query, projectId, execution time)
  - Codebase scanning failures with path and configuration details
  - LLM ranking failures with query and file count information
  - File reading failures with specific file path information
- **Error Context Enrichment**: Enhanced error tracking with rich contextual data including service name, function name, and relevant parameters
- **Comprehensive Test Coverage**: Added unit tests for error tracking functionality in both SamuraiAgent and ExtractCodeTool

### Fixed
- **CRITICAL**: Fixed consistent model selection across all SamuraiAgent methods (handlePureDiscussion, handleFeatureExploration, handleSpecClarification, handleGeneratingSpecs, analyzeUserIntent)
- **CRITICAL**: Enhanced LLM response parser to handle truncated JSON responses from Gemini API due to token limits
- **CRITICAL**: Fixed null reference errors in LLM ranking process when extractJsonFromLLMResponse returns null
- **CRITICAL**: Fixed maxTokens priority - explicit request maxTokens now takes precedence over project-level settings
- **CRITICAL**: Improved maxTokens logic to rely on model defaults instead of project settings for better performance
- Fixed model parameter passing from session metadata to all LLM requests throughout the system
- Improved error handling for empty or malformed LLM responses with comprehensive debugging

### Improved
- Added comprehensive Gemini API debugging with safety filter detection and detailed response analysis
- Enhanced JSON parsing with advanced truncation repair strategies for incomplete responses
- Added detailed logging for LLM request/response flow to diagnose API issues
- Improved ExtractCodeTool to handle truncated responses from Gemini due to safety filters or token limits
- Enhanced LLM response parser with 5 different parsing strategies including truncation repair
- Added prompt content logging for debugging Gemini safety filter issues
- Increased ExtractCodeTool maxTokens from 8192 to 20000 for better response quality
- Enhanced maxTokens logging to show which value is being used (explicit request vs project setting vs model default)
- Updated LLM model maxTokens to use realistic default values (4K for OpenAI/Anthropic, 8K for Gemini)
- Simplified maxTokens logic to use explicit request values for Google/Gemini, model defaults otherwise

### Added
- Advanced JSON repair strategies for handling truncated responses (ellipsis patterns, incomplete strings, etc.)
- Comprehensive Gemini-specific debugging including safety ratings and finish reason analysis
- Detailed logging for model selection consistency across all components
- Enhanced error messages for LLM parsing failures with specific diagnostic information
- Removed unused hello world command from package.json for cleaner extension structure

## [0.0.6] - 2025-10-02

### Fixed
- **CRITICAL**: Fixed LLM JSON parsing failure in production for array format responses
- **CRITICAL**: Fixed empty LLM response handling with better error messages and debugging
- Improved LLM response parser to handle both object `{}` and array `[{},{}]` formats robustly
- Enhanced JSON extraction with multiple fallback strategies for various LLM output formats
- Fixed type system to properly handle arrays in addition to objects
- Added intelligent truncation handling that respects markdown code block boundaries
- Improved balanced extraction logic for nested JSON structures with code blocks
- Added comprehensive test coverage for production array format scenarios
- Enhanced error handling for empty, short, and non-JSON LLM responses with specific diagnostic messages

### Improved
- LLM JSON parsing is now more robust and handles edge cases better
- Better error handling for malformed JSON in markdown code blocks
- Enhanced parsing strategies for different LLM response formats

## [0.0.5] - 2025-10-02

### Fixed
- Fixed PostHog telemetry tracking by properly loading environment variables from .env file
- Added dotenv configuration to load PostHog API key during development
- Created custom build script to inject PostHog API key during webpack build process
- PostHog tracking now works in both development and production environments
- Verified PostHog API key is properly embedded in packaged extension

## [0.0.4] - 2025-10-02

### Fixed
- Fixed code extraction not starting in production by fixing SamuraiAgent prompt file loading
- Updated SamuraiAgent to use the same prompt loading logic as CodeParserService for consistency

## [0.0.3] - 2025-10-02

### Fixed
- Fixed code extraction failure in packaged extension by ensuring workspace path is properly set in session metadata
- Fixed CodeParserService to always use workspace root instead of extension root for code scanning

### Security
- Removed hardcoded PostHog API key from webpack configuration for better security

## [0.0.2] - 2025-10-01

### Fixed
- Fixed code extraction failure in packaged extension due to incorrect prompt file path resolution
- Fixed CSS loading issue in published extension by updating webview resource paths
- Updated asset resolution to prioritize dist directory for packaged extensions

## [0.0.1] - 2025-10-01

- Initial release