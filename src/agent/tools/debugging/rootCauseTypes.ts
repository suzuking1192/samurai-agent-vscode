/**
 * Type definitions for root cause analysis
 * 
 * Defines interfaces for debugging context, hypotheses, and iterative reasoning
 */

import { GraphNode, GraphEdge, Evidence, CandidateFile, InfoRequestItem } from './types';

/**
 * Git file change information
 */
export interface GitFileChange {
  path: string;
  oldPath?: string;      // for renames/copies
  status: "A"|"M"|"D"|"R"|"C";
  additions?: number;
  deletions?: number;
  isBinary?: boolean;
}

/**
 * Git change information
 */
export interface GitChange {
  hash: string;
  message: string;
  author: string;
  date: Date;
  files: GitFileChange[];
  diff?: string;
  relevanceScore?: number; // Ranked by proximity to bug
  parents?: string[];
  isMerge?: boolean;
}

/**
 * JavaScript/TypeScript heuristic finding
 */
export interface JsHeuristicFinding {
  file: string;
  line: number;
  pattern: string; // e.g., "missing_await", "null_access"
  severity: "low" | "medium" | "high";
  rationale: string;
  codeSnippet?: string;
}

/**
 * Snippet record from snippet store
 */
export interface SnippetRecord {
  id: string;
  file: string;
  start: number;
  end: number;
  text: string;
  reasons: string[];
}

/**
 * Complete debugging context for root cause analysis
 */
export interface DebugContext {
  projectId: string;
  commitHash: string;
  bugDescription: string;
  logs: string; // Stack traces, error logs
  userMessage: string; // Natural language description
  gitChanges: GitChange[];
  graph: { nodes: GraphNode[]; edges: GraphEdge[] };
  snippets: any[]; // SnippetRecord[] - will be defined when SnippetStore is available
  evidence: Evidence;
  candidates: CandidateFile[];
  heuristicFindings: JsHeuristicFinding[];
}

/**
 * Root cause hypothesis with confidence and evidence
 */
export interface Hypothesis {
  id: string;
  summary: string;
  evidence: string[];
  relatedNodes: string[];
  confidence: number; // LLM-provided confidence
  normalizedConfidence?: number; // Calibrated confidence (0.3*heuristic + 0.7*llm)
  rationale: string;
  relatedFiles: string[];
  verifiedNodes?: string[]; // Validated graph node IDs
  verifiedSnippets?: string[]; // Validated snippet IDs
  checks?: string[]; // Concrete verification checks the tester can run
  assumptions?: string[]; // Unknowns the hypothesis depends on
  parentId?: string; // ID of the hypothesis this was refined from
  changeReason?: string; // Reason for the change (action + rationale)
}

/**
 * Feedback from hypothesis testing
 */
export interface FindingFeedback {
  hypothesisId: string;
  verdict: "confirmed" | "refuted" | "uncertain";
  newClues: string[];
  revisedConfidence: number;
  verifiedEvidence: string[];
}

/**
 * Memory of previous iterations for context
 */
export interface IterationMemory {
  testedHypotheses: Hypothesis[];
  feedback: FindingFeedback[];
  iteration: number;
  reasoningSummary: string;
}

/**
 * Visualization metadata for debugging graphs
 */
export interface VisualizationMeta {
  nodeCount: number;
  edgeCount: number;
  truncated: boolean;
  clusters?: Array<{ id: string; size: number; label: string }>;
  mode: 'hard-error'|'soft-error'|'behavior-first';
  source: 'deterministic';  // Only deterministic after LLM removal
}

/**
 * Pipeline step for debugging flow tracking
 */
export interface DebugPipelineStep {
  id: "input" | "retrieval" | "graph" | "hypothesis" | "testing" | "report" | "visualization";
  label: string;
  status: "success" | "warning" | "error" | "skipped";
  detail?: string;
  timestamp: number; // Always required, use Date.now()
}

/**
 * Graph candidate for focus analysis
 */
export interface GraphCandidateInfo {
  id: string;
  reason: string;
  score: number;
  nodeCount: number;
  nodeLabels: string[];
}

/**
 * Final root cause analysis report
 */
export interface RootCauseReport {
  summary: string;
  likelyRootCause: string;
  reasoningSteps: string[];
  recommendedFix: string;
  evidence: string[];
  confidence: number;
  hypotheses: Hypothesis[]; // All hypotheses with verdicts
  confidenceSummaryTable: string; // Markdown table
  timings: Record<string, number>;
  clarifyingQuestions?: string[]; // New
  recommendedQuickActions?: Array<{ // New
    id: string;
    title: string;
    description?: string;
  }>;
  failPath?: Array<{ nodeId: string; label: string; file: string; line?: number }>;
  anchors?: Array<{ file: string; start: number; end?: number; symbol?: string }>;
  diffHunks?: Array<{ file: string; commit: string; hunk: string }>;
  tests?: Array<{ name: string; kind: 'unit'|'integration'; code: string }>;
  patches?: Array<{ file: string; diff: string }>;
  redactions?: Array<{ kind: 'secret'|'pii'|'token'; placeholder: string; original: string }>;
  visualization?: string; // Mermaid markdown
  visualizationMeta?: VisualizationMeta;
  visualizationDiagnostics?: string[];
  infoRequests?: InfoRequestItem[]; // Requests for additional information
  pipelineSteps?: DebugPipelineStep[]; // Pipeline status tracking
  graphCandidates?: GraphCandidateInfo[]; // For refocus feature: available focus candidates
  selectedCandidateIds?: string[]; // IDs that were selected for analysis
  debugMetaVersion?: number; // Version for backwards compatibility (1 = refocus feature)
  llmDebugInfo?: LLMCallDebugInfo[]; // LLM call debug information
  llmDebugInfoVersion?: 1; // Version for LLM debug info compatibility
}

/**
 * LLM cache entry
 */
export interface LLMCacheEntry {
  response: any;
  timestamp: number;
  ttl: number; // Time to live in milliseconds
}

/**
 * Stop condition for iteration
 */
export interface StopCondition {
  maxIterations: number;
  confidenceThreshold: number;
  maxTimeMs: number;
  startTime: number;
}

/**
 * LLM call debug information for transparency
 */
export interface LLMCallDebugInfo {
  id: string;
  stage: 'hypothesis-generation' | 'hypothesis-testing' | 'feedback-refinement' | 'other';
  timestamp: number;
  request: {
    prompt: string;
    systemPrompt?: string;
    codeSnippets?: Array<{ file?: string; code: string; reason?: string }>;
    graphSnippet?: string;
    model: string;
    temperature: number;
    maxTokens: number;
  };
  response?: {
    content: string;
    tokensUsed?: number;
    duration: number;
  };
  error?: string;
}

/**
 * Truncate debug text to prevent UI lag
 */
const MAX_DEBUG_TEXT = 8000;

export function truncateDebugText(text: string): string {
  return text.length > MAX_DEBUG_TEXT
    ? text.slice(0, MAX_DEBUG_TEXT) + "\n...[truncated]"
    : text;
}
