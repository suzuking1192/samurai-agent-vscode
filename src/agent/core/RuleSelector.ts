/**
 * RuleSelector - Dynamic Rule Injection System
 * 
 * Solves "Context Window Saturation" by selecting only relevant strategic rules
 * (3-7 max) based on keyword matching from user queries and recent thoughts.
 * 
 * This implements a "RAG-Lite" approach without vector databases - using
 * fast, deterministic keyword matching to inject context-aware rules.
 */

export interface StrategicRule {
  id: string;
  content: string;
  keywords: string[]; // Word stems for matching variations
}

export interface RuleSelectionResult {
  formattedRules: string;
  selectedRuleIds: string[];
}

export class RuleSelector {
  private rules: StrategicRule[] = [
    {
      id: 'negative-inference',
      keywords: ['missing', 'not found', 'not visible', 'assum', 'constructor', 'parent class', 'factory', 'definition'],
      content: `### 1. The "Negative Inference" Trap (CRITICAL)
**Do not assume code is missing just because it is not explicitly visible in the current file.**
* **Scenario:** You see \`const registry = new ToolRegistry();\` but no \`registry.register()\` calls.
* **Mistake:** You assume tools are not registered.
* **Correction:** The registration likely happens **inside the constructor** of \`ToolRegistry\`.
* **Rule:** Before declaring something "missing" or "not configured," you MUST check the **definition** (Constructor, Parent Class, or Factory method) of the object.`
    },
    {
      id: 'silent-bug-checklist',
      keywords: ['silent', 'no error', 'behave wrong', 'floating promise', 'await', 'async', 'mutat', 'sort', 'splice', 'reverse', 'swallow', 'catch', 'type', 'json.parse', 'as any'],
      content: `### 2. The "Silent Bug" Checklist
If the code runs but behaves wrongly (no error thrown), check these specific patterns:
* **Floating Promises:** Look for async function calls that are not \`await\`ed or returned. This causes race conditions where code finishes out of order.
* **Unsafe Mutation:** Look for \`.sort()\`, \`.splice()\`, or \`.reverse()\` called on arrays passed as arguments. This corrupts state elsewhere in the app.
* **Swallowed Errors:** Look for \`try { ... } catch (e) {}\` (empty catch blocks). This hides the root cause.
* **Type Lies:** Do not trust TypeScript types blindly if the data comes from \`JSON.parse()\`, API responses, or \`as any\` casts. Trace the *source* of the data.`
    },
    {
      id: 'dependency',
      keywords: ['depend', 'reference', 'file a', 'file b', 'graph-context', 'connection', 'bad data', 'return'],
      content: `### 3. The "Dependency" Rule
* If you see an error in \`File A\` that references \`File B\`, do not just fix \`File A\`.
* You must check \`File B\` to understand *why* it is returning bad data. Use \`graph-context\` to see the connection.`
    },
    {
      id: 'handshake',
      keywords: ['send', 'receiv', 'message', 'postMessage', 'event', 'emit', 'api call', 'protocol', 'mismatch', 'handler', 'listen'],
      content: `### 4. The "Handshake" Rule (Cross-Boundary)
**Never assume sending means receiving.**
If you see code sending a message (API call, \`postMessage\`, Event emit), you **MUST** verify the receiving side exists.
* **Action:** Search for the *exact event name string* (e.g., \`'debugGraphUpdate'\`) in the codebase.
* **Failure Condition:** If the string exists in the Backend but not the Frontend, it is a **Protocol Mismatch**.`
    },
    {
      id: 'frontend-backend-gap',
      keywords: ['ui', 'frontend', 'backend', 'graph not show', 'component', 'react', 'vue', 'html', 'controller'],
      content: `### 5. The "Frontend/Backend" Gap
If the user complains about a UI issue (e.g., "Graph not showing"), do not stop at the Backend Controller.
* You must find the corresponding Frontend Component (React/Vue/HTML).
* Use \`code-search\` to find the UI code that handles the data.`
    },
    {
      id: 'caller-verification',
      keywords: ['call', 'invok', 'function', 'helper', 'event handler', 'not run', 'not execut', 'missing call'],
      content: `### 6. The "Caller Verification" Rule
**Do not debug code that doesn't run.**
Before analyzing logic inside a helper function (e.g., \`persistAssistantMessage\`), verify that it is actually **called** by the active event handler (\`debugSessionFinished\`).
* If the call is missing, the root cause is "Missing Function Call," not "Bad Logic."`
    },
    {
      id: 'sibling-comparison',
      keywords: ['compar', 'work', 'broken', 'fail', 'feature a', 'feature b', 'similar', 'same', 'different'],
      content: `### 7. The "Sibling Comparison" Rule
**Compare Broken vs. Working.**
If \`Feature A\` works and \`Feature B\` fails, find the code for both.
* Compare them line-by-line.
* Often, the bug is simply a line present in A but missing in B.`
    },
    {
      id: 'string-literal-illusion',
      keywords: ['string', 'literal', 'backslash', 'escape', 'regex', 'runtime', 'compile', 'length', '\\n', '\\t'],
      content: `### 8. The "String Literal" Illusion Rule
**Do not confuse source code representation with runtime value.**
* **Scenario:** You see \`if (char === '\\\\')\` in the source code.
* **Mistake:** You think "This checks for *two* backslashes because there are two characters inside the quotes."
* **Correction:** In JavaScript/TypeScript source code, backslashes inside strings must be escaped. The literal \`\\\\\` compiles to a **single backslash character** at runtime.
* **Rule:** When analyzing string logic or regex, mentally "compile" the string first. \`"\\n"\` is length 1 (newline), not length 2. \`"\\t"\` is length 1 (tab).`
    },
    {
      id: 'dont-reinvent-wheel',
      keywords: ['util', 'helper', 'function', 'custom', 'shared', 'common', 'duplicat', 'parser', 'format', 'extract'],
      content: `### 9. The "Don't Reinvent the Wheel" Rule
**If a custom utility function seems buggy, check if a standard/shared one already exists.**
* **Action:** Use \`code-search\` to look for similar function names (e.g., \`parseJSON\`, \`extractJSON\`, \`formatDate\`) in the codebase.
* **Red Flag:** If you find \`src/common/utils/parser.ts\` (Shared) and \`src/feature/localParser.ts\` (Custom), the bug is likely in the fragile custom implementation.
* **Fix:** The solution is often to **delete the custom code** and import the robust shared utility, rather than trying to debug the custom implementation.`
    },
    {
      id: 'doppelganger',
      keywords: ['shadow', 'overwrit', 'duplicat', 'reset', 'doesn\'t update', 'variable', 'let', 'const', 'function', 'twice', 'defin'],
      content: `### 10. The "Doppelgänger" Rule (Shadowing & Overwriting)
**If a value "resets" or "doesn't update," suspect a duplicate variable.**
* **Symptom:** The user says "I set \`status\` to 'active', but it's still 'pending'."
* **Cause:** They likely declared \`let status\` inside an \`if\` block or function, shadowing the outer \`status\`.
* **Cause:** They might have defined \`function init()\` twice, and the second one (which is empty) is overwriting the first one.
* **Action:** Do not just read the line where the variable is used. Search for **ALL definitions** of that variable name in the file to ensure there isn't a hidden duplicate.`
    },
    {
      id: 'highlander',
      keywords: ['function', 'overwrit', 'duplicat', 'defin', 'twice', 'skip', 'not execut', 'part of logic'],
      content: `### 11. The "Highlander" Rule (Function Overwriting)
**There can be only one implementation.**
* **Symptom:** A function isn't doing what it should, or part of the logic seems skipped.
* **Cause:** The user might have defined \`function process()\` twice. The second definition silently overwrites the first.
* **Action:** Search for the function name (Symbol Search). If you see multiple definitions in the same file, check if they are *Overloads* (no body) or *Duplicates* (both have bodies).`
    },
    {
      id: 'echo-chamber-double',
      keywords: ['echo', 'redund', 'duplicat', 'race condition', 'optimist', 'ui glitch', 'frontend', 'backend', 'save', 'mutat'],
      content: `### 12. The "Echo Chamber" Rule (Double Handling)
**Check for redundancy across the Frontend/Backend boundary.**
* **Symptom:** Race conditions, duplicate entries, or optimistic UI glitches.
* **Cause:** The Backend performs an action (e.g., \`save()\`), AND it sends a success message to the Frontend, which *also* performs the action (\`save()\`).
* **Action:** If you see a data mutation (Save/Update/Delete), check **BOTH** the Sender (Extension) and the Receiver (Webview/Frontend). Who owns the responsibility? If both do it, it is a bug.`
    },
    {
      id: 'type-hallucination',
      keywords: ['async', 'promise', 'void', 'return type', 'static-analysis', 'type', 'assum', 'database', 'sync'],
      content: `### 13. The "Type Hallucination" Rule
**Do not assume a function is Async just because it looks important.**
* **Mistake:** You see \`database.handleMessage()\` and assume it is a "Floating Promise" because database calls are usually async.
* **Correction:** It might be a synchronous wrapper or a void function.
* **Action:** You MUST use \`static-analysis\` to verify the **Return Type**.
    * If it returns \`void\` or \`Response\`, it is NOT a floating promise.
    * If it returns \`Promise<T>\`, it IS a floating promise.`
    },
    {
      id: 'widen-net',
      keywords: ['search', 'fail', '0 result', 'not found', 'pattern', 'directory', 'folder', 'monorepo', 'packages', 'apps', 'client', 'server', 'global', 'yielded no results', 'no matches', 'empty result', 'restrict', 'scope'],
      content: `### 14. The "Widen the Net" Rule (Search Failure)
**If a specific search fails, you are likely in the wrong directory.**
* **Symptom:** You ran \`code-search\` with \`pattern='src'\` or \`pattern='app'\` and got 0 results.
* **Mistake:** You assumed the code exists where *you* are currently looking.
* **Correction:** In Monorepos or Full-Stack apps, code might be in \`packages/\`, \`apps/\`, \`client/\`, or \`server/\`.
* **Action:** **IMMEDIATELY** run the search again with **\`pattern=undefined\`** (Global Search) to find where that concept actually lives.`
    },
    {
      id: 'full-stack-separation',
      keywords: ['ui', 'frontend', 'backend', 'react', 'component', 'css', 'hook', 'api', 'database', 'server', 'controller', 'service', 'tsx', 'jsx'],
      content: `### 15. The "Full Stack" Separation Rule
**Do not look for UI code in the Database layer, and vice versa.**
* **Frontend Hints:** If debugging a UI issue (CSS, Components, Hooks), look for:
    * Folders: \`components\`, \`pages\`, \`app\`, \`views\`, \`client\`, \`web\`.
    * Extensions: \`.tsx\`, \`.jsx\`, \`.css\`.
* **Backend Hints:** If debugging an API or Database issue, look for:
    * Folders: \`api\`, \`server\`, \`controllers\`, \`services\`, \`backend\`, \`lib\`.
    * Extensions: \`.ts\` (without 'x'), \`.sql\`.
* **Rule:** If you are debugging a React Button, do not waste time searching inside \`src/server/\`. Search globally for \`.tsx\` files instead.`
    },
    {
      id: 'echo-chamber-circular',
      keywords: ['circular', 'infinite loop', 'duplicat', 'spam', 'log', 'success', 'notif', 'trigger', 'event handler', 'save', 'mutat'],
      content: `### 16. The "Echo Chamber" Rule (Circular Events)
**Never let a "Success" notification trigger the action that caused it.**
* **The Pattern:** System A sends "Data Saved". System B receives "Data Saved" and triggers a function that calls \`saveData()\` again.
* **Symptom:** Infinite loops, duplicate database entries, or logs spamming the same action.
* **Action:** Trace the Event Handler.
    * Does \`onMessage('success')\` call a function that emits \`postMessage('save')\`?
    * **Fix:** The handler for a "Success" event should only **Update UI** (Read), never **Trigger Mutation** (Write).`
    },
    {
      id: 'id-stability',
      keywords: ['id', 'uuid', 'regenerat', 'temp', 'duplicat', 'race condition', 'not found', 'update', 'payload'],
      content: `### 17. The "ID Stability" Rule (Identity Crisis)
**Do not regenerate IDs for data that already exists.**
* **The Pattern:** Backend sends an object with \`id: "123"\`. Frontend receives it but ignores the ID, calls \`uuid()\` to generate \`temp-999\`, and saves it.
* **Symptom:** Race conditions where the system thinks an item is "new" every time it loads, leading to duplicates or "Item not found" errors on update.
* **Action:** Check the variable assignment.
    * Look for: \`const id = payload.id || uuid();\` (Correct).
    * Look for: \`const id = uuid();\` (Bug - ignores source truth).`
    },
    {
      id: 'state-amnesia',
      keywords: ['reload', 'persist', 'localStorage', 'getState', 'in-memory', 'set', 'map', 'array', 'clear', 'duplicat', 'reopen', 'window'],
      content: `### 18. The "State Amnesia" Rule (Reload Persistence)
**In-memory state (\`Set\`, \`Map\`, \`Array\`) dies on reload. Persistence does not.**
* **The Pattern:** You use a \`seenMessageIds\` Set to prevent duplicates. It works fine until the user reloads the page/webview. The Set clears, but the backend resends the message.
* **Symptom:** "It works on the first try, but duplicates appear after I close and reopen the window."
* **Action:** Verify Initialization.
    * Does the code load existing IDs from \`localStorage\`, \`vscode.getState()\`, or a Database *before* listening for new events?
    * If the Set starts empty every time, it is a bug.`
    },
    {
      id: 'tombstone',
      keywords: ['delete', 'remov', 'id', 'temp-id', 'real-id', 'pending', 'tracker', 'replay', 'deduplicat', 're-render'],
      content: `### 19. The "Tombstone" Rule (Identity Preservation)
**Never delete a 'Pending' ID from a tracker until the session is over.**
* **The Pattern:** Code adds \`temp-id\` to a "Processed" list. When the Backend returns \`real-id\`, the code *deletes* \`temp-id\` and adds \`real-id\`.
* **The Bug:** If the original event (carrying \`temp-id\`) fires again due to a UI re-render or reload, the deduplication check fails because \`temp-id\` is missing.
* **Rule:** When an ID changes, **ADD** the new ID, but **KEEP** the old ID in the set as a "Tombstone." This blocks future replays of the original event.`
    },
    {
      id: 'source-of-truth',
      keywords: ['id', 'uuid', 'generat', 'frontend', 'backend', 'mismatch', 'race condition', 'duplicat', 'save', 'temporary'],
      content: `### 20. The "Source of Truth" Rule (ID Generation)
**Do not let two systems generate IDs for the same entity.**
* **Symptom:** Mismatched IDs causing race conditions or duplicate saves.
* **Mistake:** The Frontend generates a UUID (\`msg-123\`) for a new item, but the Backend ignores it and generates its own ID (\`db-999\`).
* **Action:** Check the data flow.
    * Does the Backend accept the Frontend's ID?
    * Or does the Frontend update its ID to match the Backend?
    * **Fix:** Ensure the Backend returns the *original* temporary ID in the response so the Frontend knows which item to update.`
    },
    {
      id: 'replay-attack',
      keywords: ['replay', 'event', 'handler', 'onMessage', 'guard', 'seen', 'has', 'twice', 'clear', 'modif', 'vulnerable'],
      content: `### 21. The "Replay Attack" Simulator
**Assume every event will fire twice.**
* **Strategy:** When analyzing an Event Handler (e.g., \`onMessage\`), mentally simulate what happens if the **exact same message** arrives 100ms later.
* **Check:** Is there a guard clause (\`if (seen.has(id)) return\`)?
* **Check:** Is the \`seen\` set persistent or does it get cleared/modified mid-process?
* **Failure Mode:** If the code modifies the \`seen\` set (deletes keys), it is vulnerable to Replay Loops.`
    },
    {
      id: 'end-to-end',
      keywords: ['frontend', 'backend', 'api', 'send', 'receiv', 'message', 'communicat', 'race condition', 'postMessage', 'event', 'emit', 'handler'],
      content: `### 22. The "End-to-End" Verification Rule
**A bug in a communication channel is rarely just on one side.**
* **Mistake:** Checking only the Backend (\`Controller.ts\`) and assuming the Frontend (\`chat.js\`) works because the backend logs say "Sent".
* **Rule:** If you analyze a message being **Sent**, you MUST find and analyze the code where it is **Received**.
* **Action:** Use \`code-search\` for the message type string (e.g., \`'debugSessionFinished'\`) to find the frontend handler.`
    },
    {
      id: 'state-persistence',
      keywords: ['save', 'load', 'persist', 'database', 'storag', 'id', 'race condition', 'duplicat', 'delet', 'remov', 'state', 'concurrent'],
      content: `### 23. The "State Persistence" Check
**When fixing a Race Condition, verify the State Machine logic.**
* **Question:** Does the receiver **Delete** state? (e.g., \`savedIds.delete(id)\`).
* **Rule:** In concurrent systems, **Deleting** state/IDs is almost always the cause of race conditions (replays bypass the check). **Adding** is safe. **Deleting** is dangerous.
* **Action:** Flag any code that removes IDs from a tracking set as a critical race condition risk.`
    },
    {
      id: 'infinite-recursion',
      keywords: ['loop', 'infinite', 'recurs', 'stack overflow', 'freeze', 'hang', 'circular', 'repeat', 'trigger', 'event', 'guard', 'terminat'],
      content: `### 24. The "Infinite Recursion" Audit
**Detect loops before they crash the system.**
* **Symptom:** You see repetitive logs or the same function called multiple times in a short period.
* **Logic Check:** Does \`Action A\` trigger \`Event B\`, which triggers \`Action A\` again?
* **Action:** Trace the call chain of the event handler. Ensure it terminates (e.g., has a \`if (processed) return\` guard).`
    },
    {
      id: 'build-artifact-blindness',
      keywords: ['path', 'file not found', 'fs', 'exist', 'resolve', 'join', 'dirname', 'dist', 'build', 'webpack', 'bundled', 'runtime', 'structure', 'cannot find module', 'enoent', 'relative path'],
      content: `### 25. The "Build Artifact" Rule (Environment Blindness)
**The code you read is not the code that runs.**
* **Context:** In VS Code extensions (or Webpack apps), the file structure changes after build (\`src/\` -> \`dist/\`).
* **Symptom:** \`fs.existsSync()\` fails for a file that definitely exists in \`src/\`.
* **Mistake:** Assuming \`__dirname\` points to \`src/agent/controllers/\`.
* **Correction:** In production, \`__dirname\` likely points to \`dist/\`.
* **Action:** When debugging path errors, calculate the path relative to **dist/**, not **src/**.`
    },
    {
      id: 'verification-principle',
      keywords: ['missing', 'not implemented', 'add logic', 'doesn\'t exist', 'verify', 'check existence', 'assumption', 'hallucination'],
      content: `### 26. The "Verification" Rule (Missing Code)
**Before claiming code is "missing," you must prove it.**
* **Scenario:** You suspect a backend handler doesn't resolve paths correctly.
* **Mistake:** Assuming the logic is absent without reading the handler first.
* **Action:** Use \`static-analysis (mode='source')\` on the specific function (e.g., \`openFile\` command) to see *exactly* what it does.
* **Logic Check:** Does it try to resolve the path? If yes, the bug is in *how* it resolves it (e.g., buggy logic), not that it *doesn't* exist.`
    },
    {
      id: 'comparative-debugging',
      keywords: ['compare', 'similar', 'feature a', 'feature b', 'working', 'broken', 'implementation', 'difference', 'vs'],
      content: `### 27. The "Working Example" Rule
**If Feature A is broken but Feature B works, compare their implementations.**
* **Context:** \`openFileAtLine\` works, but \`openFile\` fails.
* **Action:** Read both functions side-by-side.
* **Discovery:** "Feature A uses \`Uri.joinPath\`. Feature B uses \`path.join\`. Feature B is likely wrong because it ignores URI normalization."
* **Strategy:** Copy the pattern from the working feature to the broken feature.`
    },
    {
      id: 'dead-parameter',
      keywords: ['parameter', 'argument', 'unused', 'ignored', 'pass', 'passed', 'function call', 'helper', 'default', 'override', 'config', 'options'],
      content: `### 28. The "Dead Parameter" Rule
**If a feature isn't working, check if the parameters are actually passed down.**
* **Symptom:** You see a variable \`focusSymbol\` in the top-level function, but the result acts like it's ignored (e.g. full file graph instead of focused graph).
* **Mistake:** Assuming that because a variable exists in the parent function, it is automatically used by the child function.
* **Action:** Trace the variable. Is it passed to the helper class constructor or method? If not, the helper is running in "default mode."`
    },
    {
      id: 'nextjs-middleware-cookie-stale',
      keywords: [
        'next.js', 'nextjs', 'middleware', 'route handler', 'api route', 'app router', 'pages router',
        'cookies', 'set-cookie', 'request cookies', 'response cookies', 'stale', 'not updated',
        'auth session missing', 'session missing', 'supabase', 'ssr', 'refresh session', 'refresh_token',
        '/api/me', 'getSession', 'getServerSession', 'createServerClient'
      ],
      content: `### The "Middleware Cookie Staleness" Rule (Next.js)
**If auth works in middleware but fails in an API route, suspect request/response cookie desync.**
* **Symptom:** Middleware refreshes auth and sets cookies, but API routes still see old cookies (e.g. Supabase error "Auth session missing!").
* **Mistake:** Assuming cookies updated in **middleware response** are immediately visible to **route handler request** in the same lifecycle.
* **Why:** In Next.js, middleware and route handlers run in separate contexts: middleware writes cookies to the **response**, while route handlers read cookies from the **request** (stale).
* **Action:** Make the API route **self-sufficient**:
  1) In \`getSession()\`, if session is missing, parse the cookie for \`refresh_token\`
  2) Call \`supabase.auth.refreshSession()\`
  3) Return the refreshed session (and optionally set updated cookies from the route context).`
    },
    {
      id: 'request-vs-response-state',
      keywords: [
        'request', 'response', 'cookie', 'header', 'set-cookie', 'propagation', 'lifecycle',
        'middleware', 'edge', 'server', 'context', 'stale state', 'not reflected', 'not available',
        'next.js', 'cloudflare', 'vercel', 'serverless', 'ssr'
      ],
      content: `### The "Request vs Response State" Rule
**If state is written to the response, don't assume reads from the request will reflect it.**
* **Symptom:** Code "updates state" (cookies/headers) but later code reads "old state" and behaves as if the update never happened.
* **Mistake:** Treating response mutations as if they mutate the in-memory request context.
* **Action:** Locate the boundary:
  - **READ**: request headers/cookies
  - **WRITE**: response headers/cookies
  If you need updated state, either (a) refresh inside the later context, or (b) pass data explicitly (e.g. via headers/rewrites) rather than relying on implicit cookie sync.`
    },
    {
      id: 'supabase-ssr-refresh-fallback',
      keywords: [
        'supabase', 'ssr', 'auth', 'session', 'refresh', 'refresh_token', 'access token', 'expired',
        'getSession', 'getUser', 'createServerClient', 'createMiddlewareClient', 'Auth session missing'
      ],
      content: `### The "SSR Refresh Fallback" Rule (Supabase)
**If \`getSession()\` returns null but a refresh token exists, refresh the session in-place.**
* **Symptom:** \`getSession()\` fails intermittently on server routes even though users are logged in.
* **Mistake:** Assuming session absence means no valid auth state. Often only the access token is stale.
* **Action:** In server-side auth utilities:
  1) Detect missing session
  2) Extract \`refresh_token\` from auth cookie
  3) Run \`supabase.auth.refreshSession({ refresh_token })\`
  4) Use refreshed session for downstream calls
* **Note:** This avoids relying on middleware cookie updates being visible in route handlers.`
    },
    {
      id: 'cross-context-timing-bug',
      keywords: [
        'timing', 'race', 'context', 'boundary', 'middleware', 'route handler', 'edge', 'server',
        'stale', 'inconsistent', 'works sometimes', 'intermittent', 'flaky', 'next.js', 'ssr'
      ],
      content: `### The "Cross-Context Timing Bug" Rule
**If behavior differs between middleware and handlers, treat it as a boundary bug—not a logic bug.**
* **Symptom:** Values look correct when inspected locally, but the overall system behaves inconsistently (often intermittent).
* **Mistake:** Debugging only inside one context (middleware OR handler) and assuming it represents the whole request lifecycle.
* **Action:** Compare across contexts:
  - What state was written in middleware (response)?
  - What state is read in handlers (request)?
  - Are they the same? If not, fix by making the handler independent (refresh/recompute) or by passing state explicitly.`
    },
    {
      id: 'applicability-gate',
      keywords: ['ignore', 'parameter', 'branch', 'scope'],
      content: `### Applicability (Code Review)
For code review: before claiming a parameter or option is "ignored" in a branch, verify applicability — when does this branch run, and can that input be present? If unsure, downgrade and list missing evidence.`
    }

  ];

  /**
   * Selects relevant rules based on the context.
   * Always returns a "Base Set" of critical rules + Context-specific ones.
   * 
   * @param query - User's original query
   * @param thoughts - Recent thoughts from agent (last 2 steps)
   * @returns RuleSelectionResult with formatted markdown and selected rule IDs
   */
  selectRules(query: string, thoughts: string = ''): RuleSelectionResult {
    const combinedContext = (query + ' ' + thoughts).toLowerCase();
    const selectedRules: StrategicRule[] = [];
    const seenIds = new Set<string>();

    // 1. ADD BASE SET (Always active)
    // Rule #1: Negative Inference (CRITICAL)
    // Rule #15: Full Stack Separation (almost always relevant for VS Code extensions)
    // Rule #3: Dependency Rule (critical for obedience)
    const baseRuleIds = ['negative-inference', 'full-stack-separation', 'dependency'];
    
    for (const id of baseRuleIds) {
      const rule = this.rules.find(r => r.id === id);
      if (rule) {
        selectedRules.push(rule);
        seenIds.add(id);
      }
    }

    // 2. CANDIDATE SCORING
    // Instead of just picking the first matches, we score them.
    const candidates = this.rules
      .filter(r => !seenIds.has(r.id))
      .map(rule => {
        // Count how many unique keywords appear in the context
        const matchCount = rule.keywords.reduce((count, k) => {
            return count + (combinedContext.includes(k.toLowerCase()) ? 1 : 0);
        }, 0);
        
        return { rule, score: matchCount };
      })
      .filter(c => c.score > 0) // Filter out non-matches
      .sort((a, b) => b.score - a.score); // Sort highest score first

    // 3. SELECTION (Top N)
    // We increased limit to 10 total (3 base + 7 dynamic) to reduce "False Negatives"
    const DYNAMIC_LIMIT = 7; 
    
    for (const candidate of candidates.slice(0, DYNAMIC_LIMIT)) {
      selectedRules.push(candidate.rule);
    }

    // 4. FORMATTING
    const formattedRules = selectedRules.map(r => r.content).join('\n\n');
    const selectedRuleIds = selectedRules.map(r => r.id);

    // Optional: Log for debugging
    console.log(`[RuleSelector] Selected: ${selectedRuleIds.join(', ')} (Context length: ${combinedContext.length})`);

    return {
      formattedRules,
      selectedRuleIds
    };
  }
}


