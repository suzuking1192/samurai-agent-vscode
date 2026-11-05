import { z } from 'zod';

/**
 * Schema for CodeSearchTool inputs
 * STRATEGY: The "Google" of the codebase. Use this to orient yourself when you don't know file paths.
 */
export const CodeSearchToolSchema = z.object({
  query: z.string().describe(
    "The search query. Keep it specific (e.g., 'AuthService', 'error_code_500'). Avoid generic terms like 'function'."
  ),
  mode: z.enum(['file', 'symbol', 'text']).describe(
    "file: Finds file paths by name. Use when you know the approximate filename.\n" +
    "symbol: Finds Class/Function definitions. BEST for finding where logic is defined.\n" +
    "text: Grep search. Use for finding error strings, variable usages, or comments."
  ),
  pattern: z.string().optional().describe(
    "Glob pattern to filter results. MUST include wildcards (* or **) for recursive search.\n" +
    "Examples: '**/*Tool.ts' (finds Tool.ts anywhere), 'src/**/*.ts' (finds .ts files in src), '**/Tool.ts' (finds Tool.ts recursively).\n" +
    "WARNING: Simple filenames like 'Tool.ts' will NOT work. Use '**/Tool.ts' or '**/*Tool.ts' instead.\n" +
    "Use this to reduce noise if you know the directory structure."
  )
}).describe(
  "Strategy: The 'Google' of the codebase. Use when you need to locate files/symbols quickly. Returns file paths and a 5-line teaser around the match (not full implementations). After locating the file, call `static-analysis` (mode: 'source', target: '<symbol>') to read the complete code.\n" +
  "\n" +
  "EXAMPLE:\n" +
  "{\n" +
  "  \"query\": \"AuthService\",\n" +
  "  \"mode\": \"symbol\",\n" +
  "  \"pattern\": \"src/**/*.ts\"\n" +
  "}"
);

export type CodeSearchParams = z.infer<typeof CodeSearchToolSchema>;

/**
 * Schema for GraphContextTool inputs
 * STRATEGY: The "Map Maker". Use this to understand dependencies and visualize the architecture.
 */
export const GraphContextToolSchema = z.object({
  filePath: z.string().describe(
    "The epicenter file. The graph will be built around this file's imports and usages."
  ),
  focusSymbol: z.string().optional().describe(
    "Optional: Focus the graph on a specific function/class within the file for higher precision."
  ),
  depth: z.number().optional().default(1).describe(
    "Traversal depth (1=Immediate neighbors, 2=Deeper). Keep at 1 usually to avoid overwhelming the visualization."
  ),
  visualizationMode: z.enum(['hard-error', 'soft-error', 'behavior-first'])
    .optional()
    .default('hard-error')
    .describe(
      "hard-error: Highlights crash paths (Use for exceptions).\n" +
      "soft-error: Highlights potential logical gaps.\n" +
      "behavior-first: Highlights data flow (Use for wrong output bugs)."
    )
}).transform((data) => ({
  ...data,
  depth: data.depth ?? 1,
  visualizationMode: data.visualizationMode ?? 'hard-error' as const,
})).describe(
  "Strategy: The 'Map Maker'. Build dependency graph around an epicenter file.\n" +
  "\n" +
  "EXAMPLE:\n" +
  "{\n" +
  "  \"filePath\": \"src/api/server.ts\",\n" +
  "  \"focusSymbol\": \"startServer\",\n" +
  "  \"depth\": 1,\n" +
  "  \"visualizationMode\": \"hard-error\"\n" +
  "}"
);

export type GraphContextParams = z.infer<typeof GraphContextToolSchema>;

/**
 * Schema for StaticAnalysisTool inputs
 * STRATEGY: The "Detective". Use this to READ code and PROVE bugs.
 */
export const StaticAnalysisToolSchema = z.object({
  filePath: z.string().describe(
    "Path to any workspace file to analyze (relative to workspace root). Use this tool to READ any file, including sandbox files inside `.samurai/sandbox/`."
  ),
  
  mode: z.enum(['metrics', 'source', 'flow']).describe(
    "metrics: Returns complexity scores. Use to find 'Hotspots' or messy code.\n" +
    "source: Extracts source code. USE THIS TO READ CODE. Provide 'target' to extract a specific function/class; omit to return the full file.\n" +
    "flow: Runs Data Flow Analysis. Use to detect race conditions, unawaited promises, and safety issues."
  ),

  // Optional: For 'source' mode
  target: z.string().optional().describe(
    "Name of the function/class to extract. If omitted, returns the file skeleton (imports/signatures)."
  ),

  // Optional: For 'flow' mode customization
  flowConfig: z.object({
    rules: z.array(z.string()).optional().describe(
      "Specific rules to run (e.g. ['async-race', 'unsafe-mutation']). Defaults to running all relevant rules."
    )
  }).optional()
}).describe(
  "Strategy: The 'Detective'. Read code or run flow analysis without guessing.\n" +
  "\n" +
  "EXAMPLE:\n" +
  "{\n" +
  "  \"filePath\": \"src/utils/math.ts\",\n" +
  "  \"mode\": \"metrics\"\n" +
  "}"
);

export type StaticAnalysisParams = z.infer<typeof StaticAnalysisToolSchema>;

/**
 * Schema for LspDiagnosticsTool inputs
 * STRATEGY: The "Doctor". Run this FIRST to check for syntax errors or type mismatches.
 */
export const LspDiagnosticsToolSchema = z.object({
  filePath: z.string().describe("The file to inspect for compiler errors."),
  severity: z.enum(['Error', 'Warning']).optional().describe(
    "Filter. 'Error' finds blockers/crashes. 'Warning' finds unused variables or implicit any."
  )
}).describe(
  "Strategy: The 'Doctor'. Run first to surface syntax/type issues.\n" +
  "\n" +
  "EXAMPLE:\n" +
  "{\n" +
  "  \"filePath\": \"src/index.ts\",\n" +
  "  \"severity\": \"Error\"\n" +
  "}"
);

export type LspDiagnosticsParams = z.infer<typeof LspDiagnosticsToolSchema>;

/**
 * Schema for GitHistoryTool inputs
 * STRATEGY: The "Time Machine". Use this to check for Regressions (it worked yesterday, broke today).
 */
export const GitHistoryToolSchema = z.object({
  filePath: z.string().describe("The file to check history for."),
  
  mode: z.enum(['diff', 'log', 'blame']).describe(
    "diff: Shows what changed recently. BEST for finding regressions.\n" +
    "log: Shows recent commit messages. Good for understanding 'Why' a change happened.\n" +
    "blame: Shows who wrote specific lines. Use to check code age (old code is usually stable)."
  ),
  
  since: z.string().optional().describe(
    "Timeframe. Defaults to 'HEAD~1' (last commit). Can be '2 days ago', 'origin/main', etc."
  ),
  
  lineRange: z.tuple([z.number(), z.number()]).optional().describe(
    "For 'blame' mode only. Restrict analysis to specific lines [start, end]."
  )
}).describe(
  "Strategy: The 'Time Machine'. Inspect file changes to spot regressions.\n" +
  "\n" +
  "EXAMPLE:\n" +
  "{\n" +
  "  \"filePath\": \"src/utils/math.ts\",\n" +
  "  \"mode\": \"diff\",\n" +
  "  \"since\": \"HEAD~3\",\n" +
  "  \"lineRange\": [10, 40]\n" +
  "}"
);

export type GitHistoryParams = z.infer<typeof GitHistoryToolSchema>;

/**
 * Schema for RuntimeDebugTool inputs
 * STRATEGY: Autonomous runtime debugger for backend code. Writes reproduction scripts, runs them, and captures variable states.
 */
const RuntimeDebugTargetSchema = z.object({
  file: z.string().optional().describe("Relative path to the file containing the logic to test."),
  filePath: z.string().optional().describe("Alias for `file` often emitted by LLMs."),
  line: z.number().optional().describe("The specific line number where the variable exists (1-based)."),
  lineNumber: z.number().optional().describe("Alias for `line` often emitted by LLMs."),
  expression: z.string().describe("The variable name or expression to capture (e.g. 'user.id', 'calculatedTax').")
}).transform(target => {
  return {
    file: target.file ?? target.filePath,
    line: target.line ?? target.lineNumber,
    expression: target.expression
  };
}).refine(
  (target) => typeof target.file === 'string' && typeof target.line === 'number',
  { message: "Each target must include a valid file (or filePath) and line (or lineNumber)." }
);

export const RuntimeDebugSchema = z.object({
  description: z.string().describe(
    "High-level description of what to test. The tool AUTONOMOUSLY generates test scenarios — you only specify what variables to capture. DO NOT provide test data (method, args, setup)."
  ),
  targets: z.array(RuntimeDebugTargetSchema).describe(
    "Array of {file, line, expression} objects to capture at runtime. Each target must include file (or filePath), line (or lineNumber), and expression."
  )
}).describe(
  "Strategy: Autonomous runtime debugger for backend code. Captures variable state at specific lines. Provide file/line/expression only; the tool handles repro scripts.\n" +
  "\n" +
  "EXAMPLE:\n" +
  "{\n" +
  "  \"description\": \"Verify tax calculation logic\",\n" +
  "  \"targets\": [\n" +
  "    {\"file\": \"src/utils/tax.ts\", \"line\": 42, \"expression\": \"calculatedTax\"},\n" +
  "    {\"file\": \"src/utils/tax.ts\", \"line\": 45, \"expression\": \"user.discount\"}\n" +
  "  ]\n" +
  "}"
);

// Use the schema's input type so optional aliases (file/filePath, line/lineNumber)
// remain assignable to the ITool contract before normalization.
export type RuntimeDebugParams = z.input<typeof RuntimeDebugSchema>;

/**
 * Schema for SandboxFileSystemTool inputs
 * STRATEGY: The "Sandbox". File operations strictly within .samurai/sandbox/ directory.
 */
export const SandboxFileSystemSchema = z.object({
  action: z.enum(['write', 'delete', 'list', 'cleanup']).describe(
    "All actions are restricted to the `.samurai/sandbox/` directory ONLY.\n" +
    "write: Create or overwrite a sandbox file.\n" +
    "delete: Remove a sandbox file.\n" +
    "list: List all files in the sandbox.\n" +
    "cleanup: Delete all sandbox files (keeps the folder)."
  ),
  filename: z.string().optional().describe(
    "Relative path INSIDE `.samurai/sandbox/` (e.g., 'repro.ts', 'nested/fixture.js'). Required for write/delete.\n" +
    "Must NOT be absolute or escape the sandbox (e.g., '../src/app.ts' or '/Users/.../file.ts' are rejected)."
  ),
  content: z.string().optional().describe("Content to write. Required for 'write' action.")
}).describe(
  "Strategy: The 'Sandbox'. Safe file operations inside `.samurai/sandbox/` only.\n" +
  "\n" +
  "EXAMPLE:\n" +
  "{\n" +
  "  \"action\": \"write\",\n" +
  "  \"filename\": \"repro.ts\",\n" +
  "  \"content\": \"console.log('hi')\"\n" +
  "}"
);

export type SandboxFileSystemParams = z.infer<typeof SandboxFileSystemSchema>;

/**
 * Schema for NodeProcessTool inputs
 * STRATEGY: Atomic debug runner. Always returns logs; manages lifecycle end-to-end.
 */
export const NodeProcessSchema = z.object({
  action: z.enum(['debug', 'kill', 'kill_all']).describe(
    "debug: Atomically spawn, attach, capture breakpoints/variables, and clean up.\n" +
    "kill: Terminate a specific process (requires pid).\n" +
    "kill_all: Kill all tracked processes and free ports (use when encountering EADDRINUSE errors)."
  ),
  path: z.string().optional().describe("Absolute or workspace-relative path to the script (required for debug)."),
  breakpoints: z.array(z.object({
    file: z.string().describe("Absolute path or relative to workspace"),
    content: z.string().describe(
      "Code snippet to match. The tool finds the line containing this text (required). \n" +
      "SURVIVOR RULES (choose lines that compile 1:1 to JS):\n" +
      "  ✅ GOOD: Simple assignments (e.g., \"x = y + 1\"), function calls (\"doSomething(x)\"), guards (\"if (!x) return\"), or the exact increment you want (\"wordCounts[token] = ...\").\n" +
      "  ❌ BAD: Types/interfaces/decorators, complex iterators (\"for (const [k,v] of ...\") or high-level helpers like Object.entries/values, arrow-heavy piping, or sugary syntax that transpiles differently.\n" +
      "Include the watch variable in the snippet when possible so the breakpoint binds where the data actually changes."
    )
  })).optional().describe(
    "Breakpoints are specified by code content only (no line numbers). The tool resolves the snippet to an executable line."
  ),
  watch_variables: z.array(z.string()).optional().describe("Variables/expressions to capture when paused."),
  timeout: z.number().default(10000).describe("Timeout in milliseconds for debug runs (default: 10000)."),
  gracePeriodMs: z.number().optional().describe("Grace period (ms) to wait for natural process exit after inspection before force-killing (default: 2000)."),
  scriptPath: z.string().optional().describe("LEGACY: Relative path inside .samurai/sandbox (use 'path' instead)."),
  debugPort: z.number().optional().describe("Starting port for V8 Inspector search (default 9229)."),
  pid: z.number().optional().describe("Process ID to kill.")
}).describe(
  "Strategy: Atomic debug runner. Spawns/attaches, captures breakpoints/variables, then cleans up.\n" +
  "\n" +
  "PREFERRED: Use 'content' for robust breakpoints (line numbers are not accepted):\n" +
  "{\n" +
  "  \"action\": \"debug\",\n" +
  "  \"path\": \"sandbox/repro.ts\",\n" +
  "  \"breakpoints\": [{\"file\": \"src/utils.ts\", \"content\": \"const result = calculate(input)\"}],\n" +
  "  \"watch_variables\": [\"result\", \"input\"]\n" +
  "}\n" +
  "\n" +
  "Line-number-only breakpoints are not supported; provide a snippet instead."
);

export type NodeProcessParams = z.input<typeof NodeProcessSchema>;

/**
 * Schema for RuntimeInspectorTool inputs
 * STRATEGY: The "Observer". Connects to Node.js debugger via CDP, sets breakpoints, captures runtime state.
 */
export const RuntimeInspectorSchema = z.object({
  action: z.enum(['attach', 'watch', 'capture_crash', 'disconnect']).describe(
    "attach: Connect to CDP on specified port.\n" +
    "watch: Set breakpoints and extract variables from call frames.\n" +
    "capture_crash: Wait for exception and capture locals.\n" +
    "disconnect: Clean up CDP connection."
  ),
  port: z.number().optional().describe("Debug port (default: 9229)"),
  target: z.object({
    file: z.string().describe("File path/name to probe"),
    line: z.number().optional().describe("Line number (1-based) - legacy mode, use breakpoints for multiple"),
    expression: z.string().optional().describe("Variable or expression to evaluate - legacy mode, use variables for multiple"),
    variables: z.union([z.string(), z.array(z.string())]).optional().describe("Variable name(s) to extract"),
    breakpoints: z.union([z.number(), z.array(z.number())]).optional().describe("Line number(s) to set breakpoints (1-indexed)"),
    extractFromAllFrames: z.boolean().optional().describe("Extract variables from all call frames (default: false)"),
    frameIndices: z.union([z.number(), z.array(z.number())]).optional().describe("Specific frame indices to extract from (default: [0] - top frame only)"),
    finishLines: z.union([z.number(), z.array(z.number())]).optional().describe("Line number(s) where execution should finish (optional)")
  }).optional().describe("Required for 'watch' action")
}).describe(
  "Strategy: The 'Observer'. CDP-based inspection for runtime variables and crashes.\n" +
  "\n" +
  "EXAMPLE:\n" +
  "{\n" +
  "  \"action\": \"watch\",\n" +
  "  \"port\": 9229,\n" +
  "  \"target\": {\n" +
  "    \"file\": \"src/server.ts\",\n" +
  "    \"breakpoints\": [42, 48],\n" +
  "    \"variables\": [\"req.user\", \"result\"],\n" +
  "    \"extractFromAllFrames\": false\n" +
  "  }\n" +
  "}"
);

export type RuntimeInspectorParams = z.infer<typeof RuntimeInspectorSchema>;

/**
 * Schema for GitDiffTool inputs
 * STRATEGY: Get git diffs with safety caps to prevent token explosion.
 */
export const GitDiffToolSchema = z.object({
  mode: z.enum(['working-tree', 'branch', 'commits']).describe(
    "working-tree: Unstaged + staged changes, optionally filtered to specific files.\n" +
    "branch: Diff between current branch and a base branch.\n" +
    "commits: Diff between two refs."
  ),
  files: z.array(z.string()).optional().describe(
    "Filter diff to specific files (relative or absolute paths). Useful for large diffs."
  ),
  baseRef: z.string().optional().describe(
    "Base reference for comparison. Default: 'main' for branch mode, 'HEAD~1' for commits mode."
  ),
  targetRef: z.string().optional().describe(
    "Target reference for comparison. Default: 'HEAD'. Only used in 'commits' mode."
  ),
  workspaceRoot: z.string().optional().describe(
    "Optional workspace root for multi-root workspaces. Falls back to first workspace folder."
  )
}).describe(
  "Strategy: Get git diffs safely. Returns unified diff with 20k char cap. For large diffs, returns per-file summary — use 'files' param to drill into specific files.\n" +
  "\n" +
  "EXAMPLE:\n" +
  "{\n" +
  "  \"mode\": \"working-tree\",\n" +
  "  \"files\": [\"src/utils.ts\"]\n" +
  "}"
);

export type GitDiffParams = z.infer<typeof GitDiffToolSchema>;
