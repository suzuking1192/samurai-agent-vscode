/**
 * Type definitions for debugging code extraction and execution graph
 * 
 * Implements the interfaces from the Samurai Agent Code Extraction & Execution Graph spec v0.2
 */

/**
 * Evidence frame from stack trace
 */
export interface EvidenceFrame {
  file: string;
  line: number;
  fn?: string;
  column?: number;
}

/**
 * Soft failure signal from logs
 */
export interface SoftSignal {
  kind: 'http' | 'warn' | 'timeout' | 'empty' | 'rejection' | 'custom';
  text: string;
  at?: string;
  code?: number;
  ms?: number;
}

/**
 * HTTP span from logs
 */
export interface HttpSpan {
  method: string;
  url: string;
  status: number;
  ms?: number;
  requestId?: string;
}

/**
 * Behavior specification extracted from user message
 */
export interface BehaviorSpec {
  entryPoints: Array<{
    kind: 'route' | 'component' | 'api' | 'command';
    value: string;
  }>;
  expected?: string;
  actual?: string;
  reproSteps?: string[];
  env?: {
    runtime?: string;
    browser?: string;
    os?: string;
    featureFlags?: string[];
  };
  confidence: number;
}

/**
 * Evidence extracted from logs and stack traces
 */
export interface Evidence {
  frames: EvidenceFrame[];
  error?: string;               // e.g., "TypeError: x is not a function"
  requestId?: string;
  route?: string;               // e.g., "/api/user"
  logSignatures?: string[];     // normalized messages
  tsconfigPaths?: Record<string, string[]>; // {"@/*":["./src/*"]}
  evidenceSource: 'logs' | 'user_description' | 'mixed';
  hasHardError: boolean;        // true if Error: found in logs
  hasLogs: boolean;             // true if logs were provided (regardless of error content)
  softSignals?: SoftSignal[];   // non-exception failures
  httpSpans?: HttpSpan[];       // HTTP requests from logs
  logLevels?: Record<'debug' | 'info' | 'warn' | 'error', number>; // log level counts
  behaviorHints?: Array<{
    kind: 'route' | 'label' | 'component' | 'api';
    value: string;
  }>;
  warnings?: string[];          // parser warnings
  confidence?: number;          // evidence confidence score (0-1)
  chatSummary?: string;         // rolling chat summary for context
}

/**
 * Candidate symbol reference with scoring and evidence
 */
export interface CandidateSymbolRef {
  file: string;
  symbol: string;
  startLine: number;
  endLine: number;
  score: number;
  evidence: string[];
}

/**
 * Candidate file with scoring and evidence
 */
export interface CandidateFile {
  file: string;
  score: number;
  evidence: string[];
  symbols?: CandidateSymbolRef[];
  debug?: {
    bm25?: number;
    dense?: number;
    symbol?: number;
    evidence?: Record<string, number>;
    fused?: number;
    ranks?: Record<string, number>;
  };
}

/**
 * Graph node for execution graph
 */
export interface GraphNode {
  id: string;
  kind: "file" | "symbol" | "route";
  label: string;
  file?: string;
  loc?: number;
  line?: number;
  span?: { start: number; end: number };
  badges?: ("error" | "suspicious" | "lowConfidence" | "routeHandler" | "spine")[];
  /**
   * Running analysis notes from the agent. Used to persist its current hypothesis for this node.
   */
  analysis?: string;
  /**
   * Normalized importance score in the range [0, 1]. Higher means higher priority to inspect.
   */
  importance?: number;
}

/**
 * Node location information for opening files in VS Code
 */
export interface NodeLocation {
  filePath: string;
  /** 1-based line number (matches what users see in editors) */
  line?: number;
}

/**
 * Map from node ID to location information
 */
export type NodeLocationMap = Record<string, NodeLocation>;

/**
 * Additional visualization metadata for nodes used by the webview
 */
export interface NodeVisualizationInfo {
  label?: string;
  analysis?: string;
  importance?: number;
}

/**
 * Map from node ID to visualization metadata
 */
export type NodeVisualizationInfoMap = Record<string, NodeVisualizationInfo>;

/**
 * Metadata used for visualization tooltips
 */
export interface NodeVisualizationMetadata {
  analysis?: string;
  importance?: number;
  label?: string;
}

export type NodeVisualizationMetadataMap = Record<string, NodeVisualizationMetadata>;

/**
 * Graph edge for execution graph
 */
export interface GraphEdge {
  from: string;
  to: string;
  kind: "imports" | "exports" | "calls" | "reexports" | "alias" | "logs" | "dynamicImport" | "logFlow" | "runtimePath" | "importedBy";
  label?: string;
  confidence: number;
  runtimeWeight?: number;
  evidence?: string[];
}

/**
 * Main extraction response
 */
export interface ExtractionResponse {
  evidence: Evidence;
  candidates: CandidateFile[];      // ranked
  graph: { nodes: GraphNode[]; edges: GraphEdge[] };
  timings: Record<string, number>;  // ms per stage
  confidence: number;                // overall
  infoRequests?: InfoRequestItem[]; // requests for additional information
  isPartial?: boolean;               // true if caps hit or budget exceeded
  vizMode?: 'normal' | 'degraded';  // visualization mode
}

/**
 * Input for debugging extraction
 */
export interface DebuggingExtractionInput {
  userMessage: string;
  logs?: string; // Now optional
  workspace: string;
  model?: string; // User's selected LLM model
  projectId?: string;
  commitHash?: string;
  behaviorSpec?: BehaviorSpec; // New
  noLogMode?: boolean; // New
  chatSummary?: string; // New: rolling chat summary
  llmConfig?: {
    model: string;
    temperature: number;
    maxTokens: number;
  };
  config?: {
    tsconfigPaths?: Record<string, string>;
    maxNodes?: number;
    maxDepth?: number;
    timeouts?: Record<string, number>;
  };
}

/**
 * Search plan from LLM
 */
export interface SearchPlan {
  candidateFiles: string[];
  symbols: string[];
  queries: string[];
  reasoning: string;
  mode: 'hard-error' | 'soft-error' | 'behavior-first'; // New
}

/**
 * Repository metadata for search planning
 */
export interface RepoMeta {
  fileList: string[];
  paths: string[];
  projectRoot: string;
  commitHash?: string;
}

/**
 * Scoring components for hybrid retrieval
 */
export interface ScoreComponents {
  bm25: number;
  dense: number;
  symbol: number;
  evidence: number;
}

/**
 * Root specification for static slicing
 */
export interface RootSpec {
  errorFrames: EvidenceFrame[];
  topSymbols: CandidateSymbolRef[];
  userMentions: string[];
  fallbackFiles?: string[];
}

/**
 * Slice limits for static slicing
 */
export interface SliceLimits {
  maxNodes: number;
  maxDepth: number;
  confidenceThreshold: number;
}

/**
 * Epicenter result for debugging flow
 */
export interface EpicenterResult {
  files: string[];
  methods: Array<{ file: string; method: string }>;
  source: 'logs' | 'execute' | 'llm_suggestion';
  confidence?: number;
  reason?: string; // For LLM-suggested epicenters
}

export interface EpicenterCandidateSnippet {
  file: string;
  method?: string;
  snippet: string;
  startLine?: number;
  endLine?: number;
  source: 'execute';
  score?: number;
}

export interface EpicenterCandidateCollection {
  createdAt: string;
  source: 'execute';
  items: EpicenterCandidateSnippet[];
}

/**
 * Graph result with code snippets
 */
export interface GraphCodeSnippet {
  nodeId: string;
  file: string;
  method: string;
  code: string;
  startLine?: number;
  endLine?: number;
}

export interface GraphResult {
  nodes: GraphNode[];
  edges: GraphEdge[];
  codeSnippets: GraphCodeSnippet[];
  epicenterNodeId?: string;
  orderedTraceNodeIds?: string[];
  executionTraceMarkdown?: string;
  prunedTraceNodeLabels?: string[];
}

/**
 * TypeScript program wrapper
 */
export interface TsProgram {
  program: any; // TypeScript Program
  sourceFiles: Map<string, any>; // TypeScript SourceFile
  checker: any; // TypeScript TypeChecker
  projectRoot: string;
  tsconfigPaths: Record<string, string>;
}

/**
 * Import/export relationship
 */
export interface ImportExportRelation {
  from: string;
  to: string;
  kind: "import" | "export" | "reexport" | "dynamicImport";
  symbol?: string;
  line?: number;
  confidence?: number;
}

/**
 * Call relationship
 */
export interface CallRelation {
  caller: string;
  callee: string;
  file: string;
  line: number;
  confidence: number;
}

/**
 * Symbol definition (function, method, class, variable)
 */
export interface SymbolDef {
  id: string;             // e.g. "symbol:src/agent/core/samuraiAgent.ts:SamuraiAgent.handleDebugging"
  name: string;           // "handleDebugging"
  file: string;
  kind: "function" | "method" | "class" | "variable" | "namespace";
  receiverType?: string;  // for class/instance methods
  exportName?: string;    // if exported
  startLine?: number;
  endLine?: number;
}

/**
 * Symbol-to-symbol call relationship
 */
export interface SymbolCall {
  callerId: string;       // SymbolDef.id
  calleeId: string;       // SymbolDef.id
  file: string;
  line?: number;
  confidence: number;
  via?: "ts-checker" | "import-resolution" | "property-access" | "heuristic" | "unresolved" | "llm-polish";
}

/**
 * Method-level execution graph with dual layers
 */
export interface MethodExecutionGraph {
  symbols: SymbolDef[];
  symbolEdges: SymbolCall[];
  files: string[];
  fileEdges: ImportExportRelation[];
}

/**
 * Agent prompt kind for instrumentation requests
 */
export type AgentPromptKind = "generic" | "node_express" | "next_route" | "react_component" | "serverless" | "jest";

/**
 * Agent prompt for AI coding agents (to add logs/instrumentation)
 */
export interface AgentPrompt {
  kind: AgentPromptKind;
  text: string;                             // ready-to-copy prompt
  variables?: Record<string, string>;       // placeholders filled by UI
}

/**
 * Gap detection signals
 */
export interface GapSignals {
  lowConfidence: boolean;
  recallMiss: boolean;
  coverageScore: number;   // 0..1
  hasSymbolGaps: boolean;
  ambiguousStack: boolean;
  timedOutStages: string[]; // names of stages that timed out
}

/**
 * Info request item for gathering additional information
 */
export interface InfoRequestItem {
  id: string;                              // e.g. "need_full_stack"
  title: string;                           // UI title
  reason: string;                          // short explanation for the user
  command?: string;                        // shell command to copy and run
  fileHint?: string;                       // e.g., "tsconfig.json"
  fields?: string[];                       // names of fields to paste (e.g., ["compilerOptions.paths","baseUrl"])
  priority: "high" | "medium" | "low";
  docsHint?: string;                       // optional link text or doc id (internal help)
  agentPrompt?: AgentPrompt;               // copyable prompt for AI coding agents (only for instrumentation)
}

/**
 * Local context for AST-first, LLM-guided tracing
 */
export interface LocalContext {
  entry: string;
  error?: string;
  files: Array<{
    path: string;
    imports: string[];
    exports: string[];
    methods: Array<{
      name: string;
      start: number;
      end: number;
      code: string;
    }>;
  }>;
}

/**
 * Local call index mapping methods to their forward and backward calls
 * Key format: "filePath::methodName"
 */
export interface LocalCallIndex {
  forward: Record<string, Array<{ 
    name: string; 
    file?: string; 
    crossFile?: boolean;
    depth?: number;  // Depth from spine (0 = spine, 1 = direct call, etc.)
    fullPath?: string;  // Fully qualified method path
    line?: number;  // Line number where call occurs (for execution order)
    order?: number;  // Execution order within method (1, 2, 3, ...)
    label?: string;
  }>>;
  backward: Record<string, Array<{ 
    name: string; 
    file?: string; 
    crossFile?: boolean;
    depth?: number;  // Depth from entry (how many levels back)
    fullPath?: string;  // Fully qualified method path
    line?: number;  // Line number where call occurs (for execution order)
    order?: number;  // Execution order within method (1, 2, 3, ...)
    label?: string;
  }>>;
}

/**
 * Input for GraphCompressor.compress()
 */
export interface GraphCompressorInput {
  methodGraph: MethodExecutionGraph;
  focus: {
    entrySymbols?: Array<{ id?: string; name?: string }>;
    errorFrames?: Array<{ file: string; line?: number }>;
    userMentions?: string[];
  };
  llm?: {
    enabled: boolean;
    model: string;
    maxTokens?: number;
    temperature?: number;
    maxCalls?: number; // default 3
  };
  limits?: {
    maxNodes?: number;
    maxDepth?: number;
    minConfidence?: number;
    targetNodeCount?: number;
    simpleGraphSize?: number; // default 15, range 10-20
  };
}

/**
 * Output from GraphCompressor.compress()
 */
export interface GraphCompressorOutput {
  nodes: Array<{
    id: string;
    label: string;
    file?: string;
    kind: "symbol" | "file" | "group" | "route";
    line?: number;
    badges?: string[];
    originalIds?: string[];
  }>;
  edges: Array<{
    from: string;
    to: string;
    kind: "calls" | "imports" | "logical" | "grouped";
    confidence: number;
    evidence?: string[];
    originalKind?: GraphEdge["kind"];
    label?: string;
  }>;
  meta: {
    prunedCount: number;
    unresolvedEdges?: SymbolCall[];
    source: "static-only" | "static+llm" | "coarse-path+llm-local-trace";
    llm?: {
      usedCalls: number;
      maxCalls: number;
      condensation: boolean;
      selectedUnresolved?: number;
      unresolvedRatio?: number;
    };
  };
  simpleGraph?: {
    nodes: Array<{
      id: string;
      label: string;
      file?: string;
      kind: "symbol" | "file" | "group" | "route";
      line?: number;
      badges?: string[];
      originalIds?: string[];
    }>;
    edges: Array<{
      from: string;
      to: string;
      kind: "calls" | "imports" | "logical" | "grouped";
      confidence: number;
      evidence?: string[];
      originalKind?: GraphEdge["kind"];
    }>;
    meta?: {
      source: "auto-pruned";
      totalOriginalNodes: number;
      filteredCount?: number;  // Total filtered out
      noiseFilteredCount?: number;  // Filtered by noise names
      infraFilteredCount?: number;  // Filtered by infra paths
      shortNameFilteredCount?: number;  // Filtered by short names
    };
  };
}
