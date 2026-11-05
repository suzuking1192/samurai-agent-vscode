/**
 * Root Cause Analyzer Orchestrator
 * 
 * Coordinates all components for iterative root cause analysis
 */

import { LLMProviderService } from '../../llm/llmProviderService';
import { ExtractionResponse, GraphNode, GraphEdge, GraphCodeSnippet, EpicenterCandidateSnippet } from './types';
import { RootCauseReport } from './rootCauseTypes';
import { FeedbackRetriever } from '../feedback/FeedbackRetriever';
import { FeedbackStore } from '../feedback/FeedbackStore';
import { ExtractCodeTool } from '../extractCodeTool';
import { LLMMessage } from '../../../common/models/llm-models';
import { generateChatSummary } from '../../util/chatSummaryGenerator';
import * as fs from 'fs';
import * as path from 'path';
import { loadDebuggingPrompt, loadFrameworkPrompt } from './promptLoader';
import { GraphCompressor } from './GraphCompressor';
import { GraphToPromptSerializer } from './GraphToPromptSerializer';
import { FrameworkId, getFrameworkDefinition, isFrameworkId } from '../../memory/techStackDefinitions';
import { extractJsonFromLLMResponse } from '../../../common/utils/llmResponseParser';

interface SimplifiedRootCauseLLMResponse {
  hypothesis?: string;
  confidence?: number | string;
  reasoningSummary?: string;
  epicenters?: Array<{
    file: string;
    method?: string;
    reason: string;
  }>;
  keywordHints?: {
    files?: string[];
    methods?: string[];
    terms?: string[];
  };
}

interface NodeAssessment {
  nodeId: string;
  analysis: string;
  confidence: number;
  importance: number;
}

interface NodeAnalysisLLMResponse {
  nodes?: Array<{
    nodeId: string;
    analysis: string;
    confidence?: number | string;
    importance?: number | string;
  }>;
}

interface KeywordHintAccumulator {
  files: Set<string>;
  methods: Set<string>;
  terms: Set<string>;
}

interface SimplifiedIterationSummary {
  iteration: number;
  hypothesis?: string;
  confidence: number;
  reasoningSummary?: string;
  nodeAssessments?: NodeAssessment[];
}

interface SimplifiedRootCauseResult {
  report: RootCauseReport;
  shouldRetry: boolean;
  epicenters?: Array<{ file: string; method?: string; reason: string }>;
  keywordHints?: { files: string[]; methods: string[]; terms: string[] };
  iterationSummaries?: SimplifiedIterationSummary[];
  iterationPrompts?: Array<{ iteration: number; prompt: string }>;
  nodeAssessments?: NodeAssessment[];
  additionalSnippets?: GraphCodeSnippet[];
  newEpicenter?: {
    files: string[];
    methods: Array<{ file: string; method: string }>;
    reason: string;
  };
  prompt?: string;
  rawResponse?: string;
  formattedResponse?: string;
}

export interface SimplifiedRootCauseOptions {
  forcedFocusNodeId?: string;
  style?: "default" | "samurai";
  executionTrace?: {
    markdown: string;
    omittedNodeLabels?: string[];
  };
  detectedFrameworks?: FrameworkId[];
}

export class RootCauseAnalyzer {
  private feedbackRetriever: FeedbackRetriever;
  private feedbackStore?: FeedbackStore;
  private llmProvider: LLMProviderService;
  private extractCodeTool: ExtractCodeTool;
  private graphCompressor: GraphCompressor;
  private traceSerializer: GraphToPromptSerializer;

  constructor(llmProvider: LLMProviderService, workspacePath: string, extractCodeTool: ExtractCodeTool) {
    this.llmProvider = llmProvider;
    this.extractCodeTool = extractCodeTool;
    this.graphCompressor = new GraphCompressor(llmProvider);
    this.traceSerializer = new GraphToPromptSerializer();
    
    // Initialize feedback components
    this.feedbackRetriever = new FeedbackRetriever();
    
    try {
      this.feedbackStore = new FeedbackStore(workspacePath);
      const existingFeedback = this.feedbackStore.loadForWorkspace(workspacePath);
      this.feedbackRetriever.loadRecords(existingFeedback);
    } catch (error) {
      console.warn('[RootCauseAnalyzer] Failed to initialize feedback store:', error);
      this.feedbackStore = undefined;
    }
  }

  /**
   * Convert parsed JSON response to user-friendly markdown format
   */
  private convertJsonResponseToMarkdown(
    parsedResponse: SimplifiedRootCauseLLMResponse,
    confidence: number,
    codeSnippets: Array<{ file: string; method: string; code: string }>
  ): string {
    let markdown = '## Root Cause Analysis Report\n\n';
    
    // Root Cause Hypothesis section
    markdown += '### Root Cause Hypothesis\n\n';
    if (parsedResponse.hypothesis) {
      markdown += `${parsedResponse.hypothesis}\n\n`;
    } else {
      markdown += 'Unable to determine root cause with the available information.\n\n';
    }

    if (parsedResponse.reasoningSummary) {
      markdown += '### Reasoning Summary\n\n';
      markdown += `${parsedResponse.reasoningSummary}\n\n`;
    }
    
    // Confidence score with visual indicator
    markdown += '### Confidence\n\n';
    const confidencePercent = Math.round(confidence * 100);
    let confidenceIcon = '⚠️';
    if (confidence >= 0.8) {
      confidenceIcon = '✅';
    } else if (confidence >= 0.6) {
      confidenceIcon = '🔶';
    } else if (confidence < 0.4) {
      confidenceIcon = '❌';
    }
    markdown += `**Confidence**: ${confidenceIcon} ${confidencePercent}%\n\n`;
    
    // Evidence section
    if (codeSnippets.length > 0) {
      markdown += '### Evidence\n\n';
      markdown += '**Analyzed Code Locations:**\n';
      const uniqueFiles = Array.from(new Set(codeSnippets.map(s => s.file)));
      uniqueFiles.forEach(file => {
        const methods = codeSnippets.filter(s => s.file === file).map(s => s.method);
        markdown += `- **${file}**: ${methods.join(', ')}\n`;
      });
      markdown += '\n';
    }
    
    // Next steps / New epicenter suggestion
    if (parsedResponse.epicenters && parsedResponse.epicenters.length > 0) {
      markdown += '### Next Steps\n\n';
      parsedResponse.epicenters.forEach((epicenter, index) => {
        markdown += `**Focus ${index + 1}:** \`${epicenter.file}\``;
        if (epicenter.method) {
          markdown += ` :: \`${epicenter.method}\``;
        }
        markdown += `\n- Reason: ${epicenter.reason}\n\n`;
      });
    }

    if (parsedResponse.keywordHints) {
      const { files = [], methods = [], terms = [] } = parsedResponse.keywordHints;
      if (files.length || methods.length || terms.length) {
        markdown += '### Keyword Hints\n\n';
        if (files.length) {
          markdown += `- Files: ${files.map(f => `\`${f}\``).join(', ')}\n`;
        }
        if (methods.length) {
          markdown += `- Methods: ${methods.map(m => `\`${m}\``).join(', ')}\n`;
        }
        if (terms.length) {
          markdown += `- Terms: ${terms.map(t => `\`${t}\``).join(', ')}\n`;
        }
        markdown += '\n';
      }
    }
    
    return markdown;
  }

  private formatChatHistoryForPrompt(chatHistory?: LLMMessage[]): string {
    if (!chatHistory || chatHistory.length === 0) {
      return 'No previous conversation history available.';
    }

    const chatSummary = generateChatSummary(chatHistory).summary;
    if (chatSummary) {
      return chatSummary;
    }

    const recentMessages = chatHistory.slice(-10);
    return recentMessages.map(msg => `${msg.role}: ${msg.content}`).join('\n\n');
  }

  private formatEpicenterForPrompt(epicenter: { files: string[]; methods: Array<{ file: string; method: string }> }): string {
    return `Epicenter:\n- Files: ${epicenter.files.join(', ')}\n- Methods: ${epicenter.methods.map(m => `${m.file}::${m.method}`).join(', ')}`;
  }

  private buildSimplifiedPrompt(
    template: string,
    context: {
      userMessage: string;
      chatHistoryText: string;
      previousIterationText: string;
      epicenterText: string;
      logsText: string;
      gitHistoryText: string;
      executionTraceText: string;
      supplementalContextText: string;
      frameworkHeuristicsText: string;
    }
  ): string {
    const replacements: Record<string, string> = {
      inputsAvailable: this.buildInputsAvailableSection(context),
      frameworkHeuristicsSection: this.buildFrameworkHeuristicsSectionBlock(context.frameworkHeuristicsText)
    };

    let prompt = template;
    for (const [placeholder, value] of Object.entries(replacements)) {
      prompt = prompt.split(`{${placeholder}}`).join(value);
    }

    return this.normalizePromptWhitespace(prompt);
  }

  private normalizePromptWhitespace(prompt: string): string {
    return prompt.replace(/\n{3,}/g, '\n\n').trimEnd();
  }

  private buildInputsAvailableSection(context: {
    userMessage: string;
    chatHistoryText: string;
    previousIterationText: string;
    epicenterText: string;
    logsText: string;
    gitHistoryText: string;
    executionTraceText: string;
    supplementalContextText: string;
  }): string {
    const sections = [
      this.buildInputSection('User Bug Description', context.userMessage, 'May contain specific symptoms (expected vs. actual behaviour, error messages) or vague requests (performance questions, "something not working", file-level issues). For vague requests, use exploratory analysis to infer symptoms from code structure and common failure patterns. Classify the request type (performance, functionality, file-level) to guide investigation.', {
        required: true,
        fallback: 'No user bug description provided.'
      }),
      this.buildInputSection('Chat History', context.chatHistoryText, 'Capture prior troubleshooting steps or clarifications so you can build on them without repeating mistakes.'),
      this.buildInputSection('Previous Analysis', context.previousIterationText, 'Reassess earlier hypotheses, citing which evidence supports or contradicts them before accepting or discarding.'),
      this.buildInputSection('Execution Trace', context.executionTraceText, 'Walk the recorded call path to pinpoint where state diverges, guiding what code to inspect next.'),
      this.buildInputSection('Epicenter', context.epicenterText, 'Start with these flagged files or methods; verify whether they truly explain the failure before expanding outward.'),
      this.buildInputSection('Error Logs', context.logsText, context.logsText && context.logsText !== 'No error logs provided.' 
        ? 'These logs contain the concrete, observable symptoms (stack traces, error messages, timestamps). Use them as the PRIMARY source of symptoms for analysis. Extract stack traces, error codes, and timestamps to confirm the exact failure signature and when it manifests.'
        : 'No error logs are available. Rely on the User Bug Description as the primary source of symptoms for this analysis.'),
      this.buildInputSection('Git History', context.gitHistoryText, 'Tie recent commits to the affected areas to spot regressions, risky refactors, or missing migrations.'),
      this.buildInputSection('Supplemental Code Context', context.supplementalContextText, 'Consult supporting snippets to understand control flow, guards, and data contracts around the suspected code paths.')
    ].filter(Boolean);

    return sections.join('\n\n');
  }

  private buildInputSection(
    title: string,
    content: string,
    guidance: string,
    options?: { required?: boolean; fallback?: string }
  ): string {
    const trimmedContent = (content ?? '').trim();
    if (!trimmedContent && !options?.required) {
      return '';
    }

    const effectiveContent = trimmedContent || options?.fallback || 'No information provided.';
    const formattedContent = this.indentMultiline(effectiveContent);
    const lines = [
      `- **${title}**`,
      '',
      formattedContent,
      '',
      `  _Usage:_ ${guidance}`
    ];

    return lines.join('\n');
  }

  private indentMultiline(content: string): string {
    return content
      .split(/\r?\n/)
      .map(line => (line.length > 0 ? `  ${line}` : '  '))
      .join('\n');
  }

  private buildFrameworkHeuristicsSectionBlock(frameworkHeuristicsText: string): string {
    const trimmed = (frameworkHeuristicsText ?? '').trim();
    if (!trimmed) {
      return '';
    }

    return `---\n\n## Framework-Specific Debugging Heuristics\n\n${trimmed}\n`;
  }

  private buildFrameworkHeuristicsSection(frameworkIds?: FrameworkId[]): string {
    if (!frameworkIds || frameworkIds.length === 0) {
      return '';
    }

    const sections: string[] = [];
    const seen = new Set<FrameworkId>();

    for (const id of frameworkIds) {
      if (!isFrameworkId(id) || seen.has(id)) {
        continue;
      }

      seen.add(id);
      const definition = getFrameworkDefinition(id);
      const prompt = loadFrameworkPrompt(id);
      if (!prompt) {
        continue;
      }

      const normalized = prompt.trim();
      if (normalized.length === 0) {
        continue;
      }

      sections.push(`### ${definition.displayName}\n\n${normalized}`);
    }

    if (sections.length === 0) {
      return '';
    }

    return sections.join('\n\n');
  }

  private async invokeSimplifiedAnalysisLLM(
    model: string,
    prompt: string,
    timings: Record<string, number>
  ): Promise<string> {
    const llmStart = Date.now();
    const chatResponse = await this.llmProvider.chat({
      id: `root-cause-analysis-${Date.now()}`,
      provider: 'auto',
      model,
      messages: [
        {
          role: 'system',
          content: 'You are a senior software engineer specializing in debugging and root cause analysis. Analyze the provided code, graph, and epicenter to identify the root cause. Always provide a confidence score and suggest a new epicenter if confidence is below 1.0.'
        },
        {
          role: 'user',
          content: prompt
        }
      ],
      temperature: 0.3,
      maxTokens: 30000,
      metadata: {},
      createdAt: new Date(),
      updatedAt: new Date()
    });
    const elapsed = Date.now() - llmStart;
    timings.llm = (timings.llm || 0) + elapsed;

    if (chatResponse.type !== 'success' || !chatResponse.payload) {
      throw new Error(chatResponse.error || 'LLM request failed');
    }

    const llmResponse = chatResponse.payload;
    if ('error' in llmResponse) {
      throw new Error('LLM request failed: ' + llmResponse.error);
    }

    return llmResponse.content || '';
  }

  private parseSimplifiedResponse(responseText: string): SimplifiedRootCauseLLMResponse {
    const structured = this.tryParseStructuredSimplifiedResponse(responseText);
    if (structured) {
      return structured;
    }

    const fallback: SimplifiedRootCauseLLMResponse = {};
    const confidenceMatch = responseText.match(/confidence[:\s]+([0-9.]+)/i);
    if (confidenceMatch) {
      fallback.confidence = parseFloat(confidenceMatch[1]);
    }

    const trimmed = responseText.trim();
    if (trimmed.length > 0) {
      fallback.hypothesis = trimmed;
    }

    return fallback;
  }

  private tryParseStructuredSimplifiedResponse(
    responseText: string
  ): SimplifiedRootCauseLLMResponse | undefined {
    if (!responseText || typeof responseText !== 'string') {
      return undefined;
    }

    try {
      const parsed = extractJsonFromLLMResponse(responseText);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        return parsed as SimplifiedRootCauseLLMResponse;
      }
    } catch (error) {
      console.warn('[RootCauseAnalyzer] Structured response parsing failed:', error);
    }

    try {
      const jsonMatch = responseText.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        return JSON.parse(jsonMatch[0]) as SimplifiedRootCauseLLMResponse;
      }
    } catch (error) {
      console.warn('[RootCauseAnalyzer] Regex-based parsing failed:', error);
    }

    return undefined;
  }

  private normalizeConfidence(value: number | string | undefined): number {
    if (value === undefined || value === null) {
      return 0.5;
    }

    let str = String(value).trim();
    if (str.endsWith('%')) {
      str = str.slice(0, -1).trim();
    }

    const parsed = Number(str);
    if (isNaN(parsed) || !isFinite(parsed)) {
      return 0.5;
    }

    let normalized = parsed;
    if (parsed > 1 && parsed <= 100) {
      normalized = parsed / 100;
    }

    normalized = Math.max(0, Math.min(1, normalized));
    return normalized;
  }

  private buildIterationSummaryForPrompt(
    iteration: number,
    response: SimplifiedRootCauseLLMResponse,
    confidence: number,
    nodeAssessments: NodeAssessment[]
  ): string {
    const lines: string[] = [];
    lines.push(`Iteration ${iteration} Summary:`);
    if (response.hypothesis) {
      lines.push(`Hypothesis: ${response.hypothesis}`);
    }
    lines.push(`Confidence: ${(confidence * 100).toFixed(0)}%`);
    if (response.reasoningSummary) {
      lines.push(`Reasoning: ${response.reasoningSummary}`);
    }
    if (response.epicenters && response.epicenters.length > 0) {
      const epicenterText = response.epicenters
        .map(epi => {
          const methodPart = epi.method ? ` :: ${epi.method}` : '';
          return `- ${epi.file}${methodPart} (reason: ${epi.reason})`;
        })
        .join('\n');
      lines.push('Epicenters:\n' + epicenterText);
    }
    if (response.keywordHints) {
      const { files = [], methods = [], terms = [] } = response.keywordHints;
      const hints: string[] = [];
      if (files.length) {
        hints.push(`files: ${files.join(', ')}`);
      }
      if (methods.length) {
        hints.push(`methods: ${methods.join(', ')}`);
      }
      if (terms.length) {
        hints.push(`terms: ${terms.join(', ')}`);
      }
      if (hints.length) {
        lines.push(`Keyword hints: ${hints.join(' | ')}`);
      }
    }
    if (nodeAssessments && nodeAssessments.length > 0) {
      lines.push('Node analysis highlights:');
      nodeAssessments.slice(0, 5).forEach(assessment => {
        lines.push(
          `- ${assessment.nodeId}: ${(assessment.importance * 100).toFixed(0)}% importance, ${(assessment.confidence * 100).toFixed(0)}% confidence — ${assessment.analysis}`
        );
      });
      if (nodeAssessments.length > 5) {
        lines.push(`- ...and ${nodeAssessments.length - 5} additional node assessments`);
      }
    }
    return lines.join('\n');
  }

  private collectEpicenters(
    accumulator: Array<{ file: string; method?: string; reason: string }>,
    seen: Set<string>,
    epicenters?: Array<{ file: string; method?: string; reason?: string }>
  ): { hasNew: boolean; firstNew?: { file: string; method?: string; reason: string } } {
    let firstNew: { file: string; method?: string; reason: string } | undefined;
    let hasNew = false;

    if (!epicenters) {
      return { hasNew, firstNew };
    }

    for (const epicenter of epicenters) {
      if (!epicenter.method) {
        console.warn('[RootCauseAnalyzer] Ignoring epicenter without method:', epicenter.file);
        continue;
      }

      const key = `${epicenter.file}::${epicenter.method ?? ''}`;
      if (seen.has(key)) {
        continue;
      }

      const normalizedEpicenter = {
        file: epicenter.file,
        method: epicenter.method,
        reason: epicenter.reason || 'LLM suggested epicenter'
      };

      seen.add(key);
      accumulator.push(normalizedEpicenter);
      if (!firstNew) {
        firstNew = normalizedEpicenter;
      }
      hasNew = true;
    }

    return { hasNew, firstNew };
  }

  private collectKeywordHints(
    accumulator: KeywordHintAccumulator,
    keywordHints?: { files?: string[]; methods?: string[]; terms?: string[] }
  ): { hasNew: boolean; newlyAdded: { files: string[]; methods: string[]; terms: string[] } } {
    let hasNew = false;
    const newlyAdded = {
      files: [] as string[],
      methods: [] as string[],
      terms: [] as string[]
    };

    if (!keywordHints) {
      return { hasNew, newlyAdded };
    }

    const process = (items: string[] | undefined, target: Set<string>, bucket: string[]) => {
      if (!items) {
        return;
      }
      for (const item of items) {
        const trimmed = item.trim();
        if (trimmed.length === 0 || target.has(trimmed)) {
          continue;
        }
        target.add(trimmed);
        hasNew = true;
        bucket.push(trimmed);
      }
    };

    process(keywordHints.files, accumulator.files, newlyAdded.files);
    process(keywordHints.methods, accumulator.methods, newlyAdded.methods);
    process(keywordHints.terms, accumulator.terms, newlyAdded.terms);

    return { hasNew, newlyAdded };
  }

  private snapshotKeywordHints(accumulator: KeywordHintAccumulator): { files: string[]; methods: string[]; terms: string[] } {
    return {
      files: Array.from(accumulator.files),
      methods: Array.from(accumulator.methods),
      terms: Array.from(accumulator.terms)
    };
  }

  private updateEpicenterForNextIteration(
    current: { files: string[]; methods: Array<{ file: string; method: string }> },
    suggestion?: { file: string; method?: string }
  ): { files: string[]; methods: Array<{ file: string; method: string }> } {
    if (!suggestion) {
      return current;
    }

    const files = Array.from(new Set([...current.files, suggestion.file]));
    const methods = suggestion.method
      ? [{ file: suggestion.file, method: suggestion.method }]
      : current.methods;

    return {
      files,
      methods
    };
  }

  private async invokeNodeAnalysisLLM(
    model: string,
    prompt: string,
    timings: Record<string, number>
  ): Promise<string> {
    const llmStart = Date.now();
    const chatResponse = await this.llmProvider.chat({
      id: `node-analysis-${Date.now()}`,
      provider: 'auto',
      model,
      messages: [
        {
          role: 'system',
          content: 'You are a senior software engineer reviewing an execution graph. Given reasoning context and code snippets, identify the most critical nodes, summarize their issues, and assign confidence/importance scores between 0 and 1. Respond strictly in JSON.'
        },
        {
          role: 'user',
          content: prompt
        }
      ],
      temperature: 0.2,
      maxTokens: 30000,
      metadata: {},
      createdAt: new Date(),
      updatedAt: new Date()
    });
    const elapsed = Date.now() - llmStart;
    timings.nodeAnalysis = (timings.nodeAnalysis || 0) + elapsed;

    if (chatResponse.type !== 'success' || !chatResponse.payload) {
      throw new Error(chatResponse.error || 'Node analysis LLM request failed');
    }

    const llmResponse = chatResponse.payload;
    if ('error' in llmResponse) {
      throw new Error('Node analysis LLM request failed: ' + llmResponse.error);
    }

    return llmResponse.content || '';
  }

  private parseNodeAnalysisResponse(responseText: string): NodeAnalysisLLMResponse {
    try {
      const jsonMatch = responseText.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        return JSON.parse(jsonMatch[0]) as NodeAnalysisLLMResponse;
      }
    } catch (error) {
      console.warn('[RootCauseAnalyzer] Failed to parse node analysis response as JSON:', error);
    }
    return {};
  }

  private buildNodeRosterForPrompt(nodes: GraphNode[], maxNodes: number = 20): string {
    if (!nodes || nodes.length === 0) {
      return 'No graph nodes available.';
    }

    const lines: string[] = [];
    const limitedNodes = nodes.slice(0, maxNodes);
    for (const node of limitedNodes) {
      const infoParts = [
        `ID: ${node.id}`,
        `Label: ${node.label}`,
        node.file ? `File: ${node.file}` : undefined,
        node.line ? `Line: ${node.line}` : undefined,
        typeof node.importance === 'number' ? `Importance: ${(node.importance * 100).toFixed(0)}%` : undefined,
        node.analysis ? `Notes: ${node.analysis}` : undefined
      ].filter(Boolean);
      lines.push(`- ${infoParts.join(' | ')}`);
    }

    if (nodes.length > maxNodes) {
      lines.push(`- ...and ${nodes.length - maxNodes} more nodes omitted for brevity.`);
    }

    return lines.join('\n');
  }

  private async performNodeAnalysis(
    model: string,
    params: {
      hypothesis: string;
      reasoningSummary?: string;
      executionTrace: string;
      graphNodes: GraphNode[];
      userMessage?: string;
    },
    timings: Record<string, number>
  ): Promise<NodeAssessment[]> {
    try {
      const promptTemplate = loadDebuggingPrompt('node_analysis.md');
      const nodeRoster = this.buildNodeRosterForPrompt(params.graphNodes);
      const userMessage =
        params.userMessage && params.userMessage.trim().length > 0
          ? params.userMessage
          : 'No user message provided.';
      const prompt = promptTemplate
        .replace('{hypothesis}', params.hypothesis || 'No hypothesis available.')
        .replace('{reasoningSummary}', params.reasoningSummary || 'No reasoning summary available.')
        .replace('{executionTrace}', params.executionTrace || 'Execution trace unavailable.')
        .replace('{nodeRoster}', nodeRoster)
        .replace('{userMessage}', userMessage);

      const responseText = await this.invokeNodeAnalysisLLM(model, prompt, timings);
      const parsed = this.parseNodeAnalysisResponse(responseText);

      if (!parsed.nodes || parsed.nodes.length === 0) {
        return [];
      }

      return parsed.nodes
        .filter(node => !!node.nodeId && !!node.analysis)
        .map(node => {
          const confidence = this.normalizeConfidence(node.confidence);
          const importance = this.normalizeConfidence(node.importance ?? confidence);
          return {
            nodeId: node.nodeId,
            analysis: node.analysis,
            confidence,
            importance
          };
        });
    } catch (error) {
      console.warn('[RootCauseAnalyzer] Node analysis failed:', error);
      return [];
    }
  }

  private applyNodeAssessmentsToGraph(
    nodes: GraphNode[],
    assessments: NodeAssessment[]
  ): void {
    if (!assessments.length || !nodes.length) {
      return;
    }

    const nodeMap = new Map(nodes.map(node => [node.id, node]));
    for (const assessment of assessments) {
      const target = nodeMap.get(assessment.nodeId);
      if (!target) {
        continue;
      }

      const confidence = this.normalizeConfidence(assessment.confidence);
      const importance = this.normalizeConfidence(assessment.importance);
      const existingImportance = typeof target.importance === 'number' ? target.importance : 0;
      target.importance = Math.max(existingImportance, importance);

      const header = `Confidence ${(confidence * 100).toFixed(0)}% | Importance ${(importance * 100).toFixed(0)}%`;
      target.analysis = `${header}\n${assessment.analysis}`;
    }
  }

  private async extendGraphWithEpicenter(
    params: {
      graph: { nodes: GraphNode[]; edges: GraphEdge[] };
      codeSnippets: GraphCodeSnippet[];
      epicenter: { files: string[]; methods: Array<{ file: string; method: string }> };
      workspace: string;
      maxHops?: number;
    }
  ): Promise<{
    addedNodes: GraphNode[];
    addedEdges: GraphEdge[];
    newSnippets: GraphCodeSnippet[];
    executionTrace: string;
    epicenterNodeId?: string;
    omittedNodeLabels?: string[];
  }> {
    const { graph, codeSnippets, epicenter, workspace, maxHops = 3 } = params;

    try {
      const segment = await this.buildGraphSegmentFromEpicenter(epicenter, workspace, maxHops);
      if (!segment.nodes.length && !segment.edges.length) {
        const snippetMap = this.buildSnippetMap(codeSnippets);
        const epicenterNodeId = this.resolveEpicenterNodeIdForGraph(epicenter, graph.nodes, workspace);
        const serialized = this.traceSerializer.serialize(graph, epicenterNodeId, snippetMap);
        return {
          addedNodes: [],
          addedEdges: [],
          newSnippets: [],
          executionTrace: serialized.markdown,
          epicenterNodeId,
          omittedNodeLabels: serialized.omittedNodeLabels
        };
      }

      const addedNodes = this.mergeGraphNodes(graph.nodes, segment.nodes);
      const addedEdges = this.mergeGraphEdges(graph.edges, segment.edges);

      const snippetMap = this.buildSnippetMap(codeSnippets);
      const newSnippets: GraphCodeSnippet[] = [];
      for (const node of addedNodes) {
        if (node.kind !== 'symbol') {
          continue;
        }

        if (snippetMap.has(node.id)) {
          continue;
        }

        const snippet = this.buildSnippetForNode(node, workspace);
        if (snippet) {
          snippetMap.set(node.id, snippet);
          newSnippets.push(snippet);
        }
      }

      const epicenterNodeId = this.resolveEpicenterNodeIdForGraph(epicenter, graph.nodes, workspace);
      const serialized = this.traceSerializer.serialize(graph, epicenterNodeId, snippetMap);

      return {
        addedNodes,
        addedEdges,
        newSnippets,
        executionTrace: serialized.markdown,
        epicenterNodeId,
        omittedNodeLabels: serialized.omittedNodeLabels
      };
    } catch (error) {
      console.warn('[RootCauseAnalyzer] Failed to extend graph from epicenter:', error);
      const snippetMap = this.buildSnippetMap(codeSnippets);
      const epicenterNodeId = this.resolveEpicenterNodeIdForGraph(epicenter, graph.nodes, workspace);
      const serialized = this.traceSerializer.serialize(graph, epicenterNodeId, snippetMap);
      return {
        addedNodes: [],
        addedEdges: [],
        newSnippets: [],
        executionTrace: serialized.markdown,
        epicenterNodeId,
        omittedNodeLabels: serialized.omittedNodeLabels
      };
    }
  }

  private async buildGraphSegmentFromEpicenter(
    epicenter: { files: string[]; methods: Array<{ file: string; method: string }> },
    workspace: string,
    maxHops: number
  ): Promise<{ nodes: GraphNode[]; edges: GraphEdge[] }> {
    try {
      const spine = epicenter.methods
        .map(method => ({ file: method.file, method: method.method }))
        .filter(item => item.file && item.method);

      if (!spine.length) {
        return { nodes: [], edges: [] };
      }

      const entryPaths = Array.from(new Set(spine.map(s => s.file))).filter(Boolean) as string[];
      if (entryPaths.length && workspace) {
        this.graphCompressor.getOrCreateTsMorphProject(workspace, entryPaths);
      }

      const deepCallGraph = this.graphCompressor.traverseCallsDeep(spine, workspace, {
        maxHops,
        maxNodes: 50,
        maxFiles: 20
      });

      const edgesForCompressor: Array<{
        from: { file?: string; method: string };
        to: { file?: string; method: string };
        kind: "forward" | "backward" | "loop";
        depth: number;
        evidence: string[];
        line?: number;
        order?: number;
        label?: string;
      }> = [];

      for (const [callerKey, callees] of deepCallGraph.entries()) {
        const [callerFile, callerMethod] = callerKey.includes('::')
          ? callerKey.split('::')
          : [undefined, callerKey];

        for (const callee of callees) {
          edgesForCompressor.push({
            from: { file: callerFile, method: callerMethod || 'unknown' },
            to: { file: callee.file, method: callee.name },
            kind: "forward",
            depth: callee.depth,
            evidence: callee.crossFile ? ["ast-forward", "cross-file"] : ["ast-forward"],
            line: callee.line,
            order: callee.order,
            label: callee.edgeLabel
          });
        }
      }

      const coarsePath = {
        files: Array.from(new Set(spine.map(s => s.file))).slice(0, 4),
        methods: spine.map(s => s.method).slice(0, 10)
      };

      const focus = {
        entrySymbols: spine.map(s => ({
          id: `symbol:${s.file}:${s.method}`,
          name: s.method,
          file: s.file
        })),
        errorFrames: [],
        userMentions: []
      };

      const emptyMethodGraph = {
        symbols: [],
        symbolEdges: [],
        files: [],
        fileEdges: []
      };

      const context = this.graphCompressor.collectLocalContext(coarsePath, focus, emptyMethodGraph);
      const compressed = this.graphCompressor.buildDirectedDebugGraph({
        spine,
        edges: edgesForCompressor,
        ctx: context,
        workspaceRoot: workspace
      });

      const nodes: GraphNode[] = compressed.nodes.map(node => ({
        id: node.id,
        label: node.label || node.id,
        file: node.file,
        kind: node.kind === 'file' ? 'file' : node.kind === 'route' ? 'route' : 'symbol',
        line: node.line,
        loc: node.loc,
        badges: (node.badges || []) as GraphNode['badges'],
        analysis: '',
        importance: 0
      }));

      const edges: GraphEdge[] = compressed.edges.map(edge => {
        let kind: GraphEdge['kind'] = 'calls';
        if (edge.kind === 'imports') {
          kind = 'imports';
        } else if (edge.kind === 'logical') {
          kind = 'calls';
        } else if (edge.kind === 'grouped') {
          kind = 'calls';
        }

        return {
          from: edge.from,
          to: edge.to,
          kind,
          confidence: edge.confidence,
          evidence: edge.evidence,
          label: edge.label,
          runtimeWeight: undefined
        };
      });

      return { nodes, edges };
    } catch (error) {
      console.warn('[RootCauseAnalyzer] buildGraphSegmentFromEpicenter failed:', error);
      return { nodes: [], edges: [] };
    }
  }

  private mergeGraphNodes(existing: GraphNode[], incoming: GraphNode[]): GraphNode[] {
    const existingMap = new Map(existing.map(node => [node.id, node]));
    const added: GraphNode[] = [];

    for (const node of incoming) {
      if (existingMap.has(node.id)) {
        continue;
      }
      existing.push(node);
      existingMap.set(node.id, node);
      added.push(node);
    }

    return added;
  }

  private mergeGraphEdges(existing: GraphEdge[], incoming: GraphEdge[]): GraphEdge[] {
    const key = (edge: GraphEdge) => `${edge.from}->${edge.to}->${edge.kind}`;
    const existingMap = new Map(existing.map(edge => [key(edge), edge]));
    const added: GraphEdge[] = [];

    for (const edge of incoming) {
      const edgeKey = key(edge);
      if (existingMap.has(edgeKey)) {
        continue;
      }
      existing.push(edge);
      existingMap.set(edgeKey, edge);
      added.push(edge);
    }

    return added;
  }

  private buildSnippetMap(snippets: GraphCodeSnippet[]): Map<string, GraphCodeSnippet> {
    const map = new Map<string, GraphCodeSnippet>();
    for (const snippet of snippets) {
      if (!map.has(snippet.nodeId)) {
        map.set(snippet.nodeId, snippet);
      }
    }
    return map;
  }

  private buildSnippetForNode(node: GraphNode, workspace: string): GraphCodeSnippet | undefined {
    const filePath = this.resolveNodeFilePath(node.file, workspace);
    if (!filePath || !fs.existsSync(filePath)) {
      return undefined;
    }

    try {
      const content = fs.readFileSync(filePath, 'utf8');
      const lines = content.split('\n');
      const range = this.calculateSnippetRange(node, lines);
      if (!range) {
        return undefined;
      }

      const code = this.sliceCode(lines, range.startLine, range.endLine);
      if (!code.trim()) {
        return undefined;
      }

      return {
        nodeId: node.id,
        file: this.toWorkspaceRelative(filePath, workspace),
        method: this.deriveMethodName(node),
        code,
        startLine: range.startLine,
        endLine: range.endLine
      };
    } catch (error) {
      console.warn(`[RootCauseAnalyzer] Failed to build snippet for node ${node.id}:`, error);
      return undefined;
    }
  }

  private resolveNodeFilePath(nodeFile: string | undefined, workspace: string): string | undefined {
    if (!nodeFile) {
      return undefined;
    }
    if (path.isAbsolute(nodeFile)) {
      return nodeFile;
    }
    if (!workspace) {
      return nodeFile;
    }
    return path.join(workspace, nodeFile);
  }

  private calculateSnippetRange(
    node: GraphNode,
    lines: string[]
  ): { startLine: number; endLine: number } | undefined {
    if (node.span) {
      return this.calculateRangeFromSpan(node.span.start, node.span.end, lines);
    }

    if (node.line) {
      const contextBefore = 5;
      const contextAfter = 20;
      const startLine = Math.max(1, node.line - contextBefore);
      const endLine = Math.min(lines.length, node.line + contextAfter);
      return { startLine, endLine };
    }

    return undefined;
  }

  private calculateRangeFromSpan(
    start: number,
    end: number,
    lines: string[]
  ): { startLine: number; endLine: number } {
    let startLine = 1;
    let endLine = lines.length;
    let charCount = 0;

    for (let i = 0; i < lines.length; i++) {
      const lineLength = lines[i].length + 1;
      if (charCount + lineLength > start) {
        startLine = i + 1;
        break;
      }
      charCount += lineLength;
    }

    charCount = 0;
    for (let i = 0; i < lines.length; i++) {
      const lineLength = lines[i].length + 1;
      if (charCount + lineLength > end) {
        endLine = i + 1;
        break;
      }
      charCount += lineLength;
    }

    const padding = 2;
    const paddedStart = Math.max(1, startLine - padding);
    const paddedEnd = Math.min(lines.length, endLine + padding);
    return { startLine: paddedStart, endLine: paddedEnd };
  }

  private sliceCode(lines: string[], startLine: number, endLine: number): string {
    const startIndex = Math.max(0, startLine - 1);
    const endIndex = Math.min(lines.length, endLine);
    return lines.slice(startIndex, endIndex).join('\n');
  }

  private deriveMethodName(node: GraphNode): string {
    const label = node.label || '';
    if (!label.includes('.')) {
      return label || node.id;
    }
    return label.split('.').pop() || label;
  }

  private toWorkspaceRelative(filePath: string, workspace: string): string {
    if (!workspace) {
      return filePath;
    }
    const relative = path.relative(workspace, filePath);
    return relative && !relative.startsWith('..') ? relative : filePath;
  }

  private resolveEpicenterNodeIdForGraph(
    epicenter: { files: string[]; methods: Array<{ file: string; method: string }> },
    nodes: GraphNode[],
    workspace: string
  ): string | undefined {
    if (!nodes.length) {
      return undefined;
    }

    const nodeMap = new Map(nodes.map(node => [node.id, node]));
    const candidates: string[] = [];

    for (const method of epicenter.methods || []) {
      const absoluteFile = this.resolveNodeFilePath(method.file, workspace) || method.file;
      const relativeFile = this.toWorkspaceRelative(absoluteFile, workspace);
      candidates.push(`symbol:${method.file}:${method.method}`);
      candidates.push(`symbol:${relativeFile}:${method.method}`);
      candidates.push(`method:${method.file}:${method.method}`);
      candidates.push(`method:${relativeFile}:${method.method}`);
    }

    for (const candidate of candidates) {
      if (nodeMap.has(candidate)) {
        return candidate;
      }
    }

    if (epicenter.methods && epicenter.methods.length) {
      for (const method of epicenter.methods) {
        const normalizedFile = this.toWorkspaceRelative(
          this.resolveNodeFilePath(method.file, workspace) || method.file,
          workspace
        );
        const match = nodes.find(node => {
          const nodeFile = this.toWorkspaceRelative(node.file || '', workspace);
          return nodeFile === normalizedFile && node.label?.includes(method.method);
        });
        if (match) {
          return match.id;
        }
      }
    }

    if (epicenter.files && epicenter.files.length) {
      for (const file of epicenter.files) {
        const normalizedFile = this.toWorkspaceRelative(
          this.resolveNodeFilePath(file, workspace) || file,
          workspace
        );
        const match = nodes.find(node => {
          const nodeFile = this.toWorkspaceRelative(node.file || '', workspace);
          return nodeFile === normalizedFile;
        });
        if (match) {
          return match.id;
        }
      }
    }

    return nodes[0]?.id;
  }

  private async enrichContextWithKeywords(
    params: {
      workspace: string;
      model: string;
      hypothesis?: string;
      newlyAddedKeywords: { files: string[]; methods: string[]; terms: string[] };
      epicenterSuggestion?: { file: string; method?: string; reason: string };
      existingSnippets: GraphCodeSnippet[];
      timings: Record<string, number>;
    }
  ): Promise<GraphCodeSnippet[]> {
    if (!this.extractCodeTool) {
      return [];
    }

    const { files, methods, terms } = params.newlyAddedKeywords;
    const hasKeywordSignals = files.length > 0 || methods.length > 0 || terms.length > 0;
    if (!hasKeywordSignals && !params.epicenterSuggestion) {
      return [];
    }

    const queryParts: string[] = [];
    if (params.epicenterSuggestion) {
      const methodText = params.epicenterSuggestion.method ? ` :: ${params.epicenterSuggestion.method}` : '';
      queryParts.push(`Focus: ${params.epicenterSuggestion.file}${methodText}`);
      if (params.epicenterSuggestion.reason) {
        queryParts.push(`Reason: ${params.epicenterSuggestion.reason}`);
      }
    }
    if (terms.length > 0) {
      queryParts.push(`Keyword terms: ${terms.join(', ')}`);
    }
    if (methods.length > 0) {
      queryParts.push(`Method keywords: ${methods.join(', ')}`);
    }
    if (files.length > 0) {
      queryParts.push(`File keywords: ${files.join(', ')}`);
    }
    if (params.hypothesis) {
      queryParts.push(`Hypothesis: ${params.hypothesis}`);
    }

    const query = queryParts.join('\n') || 'Supplemental root cause context';

    try {
      const extractionResult = await this.extractCodeTool.execute({
        query,
        projectId: 'root-cause-analysis',
        connectedCodebasePath: params.workspace,
        maxIterations: 1,
        model: params.model,
        filenameKeywords: files,
        methodNameKeywords: methods,
        codeKeywords: terms,
        maxDependencyDepth: 0
      });

      params.timings.keywordEnrichment = (params.timings.keywordEnrichment || 0) + (extractionResult.executionTime || 0);

      if (!extractionResult.success || !extractionResult.result) {
        return [];
      }

      const MAX_EXTRA_SNIPPETS = 5;
      const existingKeys = new Set(
        params.existingSnippets.map(snippet => `${snippet.file}::${snippet.method}`)
      );
      const supplementalSnippets: GraphCodeSnippet[] = [];

      for (const context of extractionResult.result.relevantCodeElements) {
        if (!context) {
          continue;
        }

        const path = context.path;
        const snippetText = context.snippet;
        const elements = context.elements || [];

        if (elements.length === 0) {
          const methodName = `snippet_${supplementalSnippets.length + 1}`;
          const key = `${path}::${methodName}`;
          if (!existingKeys.has(key)) {
            supplementalSnippets.push({
              nodeId: `extra:${path}:${methodName}`,
              file: path,
              method: methodName,
              code: snippetText
            });
            existingKeys.add(key);
          }
        } else {
          for (const element of elements) {
            const methodName = element.name || element.signature || `element_${element.type}`;
            const key = `${path}::${methodName}`;
            if (existingKeys.has(key)) {
              continue;
            }
            supplementalSnippets.push({
              nodeId: `extra:${path}:${methodName}`,
              file: path,
              method: methodName,
              code: snippetText,
              startLine: element.lineStart,
              endLine: element.lineStart && element.signature
                ? element.lineStart + element.signature.split('\n').length
                : undefined
            });
            existingKeys.add(key);
            if (supplementalSnippets.length >= MAX_EXTRA_SNIPPETS) {
              break;
            }
          }
        }

        if (supplementalSnippets.length >= MAX_EXTRA_SNIPPETS) {
          break;
        }
      }

      return supplementalSnippets;
    } catch (error) {
      console.warn('[RootCauseAnalyzer] Keyword enrichment failed:', error);
      return [];
    }
  }

  private formatExecutionTrace(
    trace?: { markdown: string; omittedNodeLabels?: string[] }
  ): string {
    if (!trace || !trace.markdown || !trace.markdown.trim()) {
      return 'Execution trace is unavailable for this analysis.';
    }

    return trace.markdown.trim();
  }

  private formatSupplementalCodeContext(snippets: GraphCodeSnippet[], limit: number = 8): string {
    if (!snippets || snippets.length === 0) {
      return 'No supplemental code snippets available.';
    }

    const uniqueSnippets = new Map<string, GraphCodeSnippet>();
    for (const snippet of snippets) {
      const key = `${snippet.file}::${snippet.method}`;
      if (!uniqueSnippets.has(key)) {
        uniqueSnippets.set(key, snippet);
      }
    }

    const selected = Array.from(uniqueSnippets.values()).slice(0, limit);
    const blocks = selected.map(snippet => {
      const header = `### ${snippet.method} (${snippet.file})`;
      const range =
        snippet.startLine !== undefined && snippet.endLine !== undefined
          ? `(Lines ${snippet.startLine}-${snippet.endLine})`
          : '';
      const codeBlock = `\`\`\`typescript\n${snippet.code.trim()}\n\`\`\``;
      return `${header}\n${range}\n\n${codeBlock}`;
    });

    if (uniqueSnippets.size > selected.length) {
      const remaining = uniqueSnippets.size - selected.length;
      blocks.push(`_(${remaining} additional snippet${remaining === 1 ? '' : 's'} omitted for brevity)_`);
    }

    return blocks.join('\n\n');
  }

  private convertEpicenterCandidatesToSnippets(
    candidates: EpicenterCandidateSnippet[] | undefined,
    maxTotalLines: number,
    existingKeys: Set<string>
  ): { snippets: GraphCodeSnippet[]; totalLines: number } {
    if (!candidates || candidates.length === 0 || maxTotalLines <= 0) {
      return { snippets: [], totalLines: 0 };
    }

    const normalizeKey = (filePath: string, method?: string) => {
      const normalizedFile = path.normalize(filePath).replace(/\\/g, '/');
      return `${normalizedFile}::${method ?? '<file>'}`;
    };

    const workingKeys = new Set(existingKeys);
    const snippets: GraphCodeSnippet[] = [];
    let consumedLines = 0;

    for (let index = 0; index < candidates.length; index += 1) {
      if (consumedLines >= maxTotalLines) {
        break;
      }

      const candidate = candidates[index];
      if (!candidate) {
        continue;
      }

      const snippetText = candidate.snippet?.trim();
      if (!snippetText) {
        continue;
      }

      const key = normalizeKey(candidate.file, candidate.method);
      if (workingKeys.has(key)) {
        continue;
      }

      const lineCount = snippetText.split(/\r?\n/).length;
      if (consumedLines + lineCount > maxTotalLines) {
        continue;
      }

      consumedLines += lineCount;
      workingKeys.add(key);

      snippets.push({
        nodeId: `candidate:${index}:${key}`,
        file: candidate.file,
        method: candidate.method || `candidate_snippet_${index + 1}`,
        code: snippetText,
        startLine: candidate.startLine,
        endLine: candidate.endLine
      });
    }

    return { snippets, totalLines: consumedLines };
  }

  /**
   * Simplified root cause analysis with code snippets and LLM-guided iteration
   */
  async analyzeRootCauseSimplified(
    codeSnippets: GraphCodeSnippet[],
    graph: { nodes: GraphNode[]; edges: GraphEdge[] },
    epicenter: { files: string[]; methods: Array<{ file: string; method: string }> },
    workspace: string,
    logs: string,
    userMessage: string,
    model: string,
    gitHistory?: string,
    options?: SimplifiedRootCauseOptions,
    chatHistory?: LLMMessage[],
    iteration?: number,
    previousIterationResponse?: string,
    epicenterCandidateSnippets?: EpicenterCandidateSnippet[],
    onProgress?: (status: string) => void
  ): Promise<SimplifiedRootCauseResult> {
    const startTime = Date.now();
    const timings: Record<string, number> = {};
    const confidenceThreshold = 0.8;

    const maxIterations = Math.max(iteration ?? 2, 1);

    console.log('[RootCauseAnalyzer] Starting simplified root cause analysis', {
      maxIterations,
      hasPreviousResponse: !!previousIterationResponse
    });

    try {
      // Load prompt template
      const promptTemplate = loadDebuggingPrompt('root_cause_analysis_simplified.md');
      const frameworkHeuristicsText = this.buildFrameworkHeuristicsSection(options?.detectedFrameworks);

      let currentEpicenter = epicenter;
      let previousIterationText = previousIterationResponse
        ? previousIterationResponse
        : 'This is the first iteration of analysis. No previous analysis available.';

      const chatHistoryText = this.formatChatHistoryForPrompt(chatHistory);
      const logsText = logs && logs.trim() ? logs : 'No error logs provided.';
      const gitHistoryText = gitHistory && gitHistory.trim() ? gitHistory : 'No git history information available.';
      let executionTraceText = this.formatExecutionTrace(options?.executionTrace);
      let supplementalContextText = this.formatSupplementalCodeContext(codeSnippets);

      const workingCodeSnippets: GraphCodeSnippet[] = [...codeSnippets];
      const supplementalSnippets: GraphCodeSnippet[] = [];

      if (epicenterCandidateSnippets && epicenterCandidateSnippets.length > 0) {
        const normalizeKey = (filePath: string, method?: string) => {
          const normalizedFile = path.normalize(filePath).replace(/\\/g, '/');
          return `${normalizedFile}::${method ?? '<file>'}`;
        };

        const existingKeys = new Set(
          workingCodeSnippets.map(snippet => normalizeKey(snippet.file, snippet.method))
        );

        const { snippets: initialSupplemental, totalLines } = this.convertEpicenterCandidatesToSnippets(
          epicenterCandidateSnippets,
          10_000,
          existingKeys
        );

        if (initialSupplemental.length > 0) {
          supplementalSnippets.push(...initialSupplemental);
          workingCodeSnippets.push(...initialSupplemental);
          supplementalContextText = this.formatSupplementalCodeContext(workingCodeSnippets);

          console.log('[RootCauseAnalyzer] Loaded initial supplemental snippets from epicenter candidates', {
            snippetCount: initialSupplemental.length,
            totalLines
          });
        }
      }

      const epicenterSuggestions: Array<{ file: string; method?: string; reason: string }> = [];
      const seenEpicenterKeys = new Set<string>();
      const keywordAccumulator: KeywordHintAccumulator = {
        files: new Set<string>(),
        methods: new Set<string>(),
        terms: new Set<string>()
      };
      const iterationSummaries: SimplifiedIterationSummary[] = [];
      const iterationPrompts: Array<{ iteration: number; prompt: string }> = [];
      let latestNodeAssessments: NodeAssessment[] = [];

      let finalParsedResponse: SimplifiedRootCauseLLMResponse = {};
      let finalConfidence = 0.5;
      let finalFormattedResponse: string | undefined;
      let finalPrompt = '';
      let finalRawResponse = '';
      let shouldRetry = false;

      for (let iterIndex = 1; iterIndex <= maxIterations; iterIndex++) {
        onProgress?.(`Running root cause analysis (iteration ${iterIndex}/${maxIterations})...`);
        const epicenterText = this.formatEpicenterForPrompt(currentEpicenter);
        const prompt = this.buildSimplifiedPrompt(promptTemplate, {
          userMessage,
          chatHistoryText,
          previousIterationText,
          epicenterText,
          logsText,
          gitHistoryText,
          executionTraceText,
          supplementalContextText,
          frameworkHeuristicsText
        });
        finalPrompt = prompt;
        iterationPrompts.push({ iteration: iterIndex, prompt });

        onProgress?.(`Analyzing hypothesis (iteration ${iterIndex}/${maxIterations})...`);
        const responseText = await this.invokeSimplifiedAnalysisLLM(model, prompt, timings);
        finalRawResponse = responseText;

        const parsedResponse = this.parseSimplifiedResponse(responseText);
        finalParsedResponse = parsedResponse;
        finalConfidence = this.normalizeConfidence(parsedResponse.confidence);

        const epicenterResult = this.collectEpicenters(epicenterSuggestions, seenEpicenterKeys, parsedResponse.epicenters);
        const keywordResult = this.collectKeywordHints(keywordAccumulator, parsedResponse.keywordHints);

        onProgress?.(`Evaluating code nodes (iteration ${iterIndex}/${maxIterations})...`);
        const iterationNodeAssessments = await this.performNodeAnalysis(
          model,
          {
            hypothesis: parsedResponse.hypothesis || 'Analysis in progress',
            reasoningSummary: parsedResponse.reasoningSummary,
            executionTrace: executionTraceText,
            graphNodes: graph.nodes,
            userMessage
          },
          timings
        );
        this.applyNodeAssessmentsToGraph(graph.nodes, iterationNodeAssessments);
        latestNodeAssessments = iterationNodeAssessments.length > 0 ? iterationNodeAssessments : latestNodeAssessments;

        iterationSummaries.push({
          iteration: iterIndex,
          hypothesis: parsedResponse.hypothesis,
          confidence: finalConfidence,
          reasoningSummary: parsedResponse.reasoningSummary,
          nodeAssessments: iterationNodeAssessments
        });

        finalFormattedResponse = this.convertJsonResponseToMarkdown(
          parsedResponse,
          finalConfidence,
          workingCodeSnippets
        );

        const hasMoreIterations = iterIndex < maxIterations;
        const shouldContinue =
          hasMoreIterations &&
          finalConfidence < confidenceThreshold &&
          (epicenterResult.hasNew || keywordResult.hasNew);

        if (!shouldContinue) {
          shouldRetry = finalConfidence < confidenceThreshold && epicenterSuggestions.length > 0;
          break;
        }

        onProgress?.(`Enriching context for next iteration (iteration ${iterIndex}/${maxIterations})...`);
        const enrichmentSnippets = await this.enrichContextWithKeywords({
          workspace,
          model,
          hypothesis: parsedResponse.hypothesis,
          newlyAddedKeywords: keywordResult.newlyAdded,
          epicenterSuggestion: epicenterResult.firstNew,
          existingSnippets: workingCodeSnippets,
          timings
        });
        if (enrichmentSnippets.length > 0) {
          supplementalSnippets.push(...enrichmentSnippets);
          workingCodeSnippets.push(...enrichmentSnippets);
          supplementalContextText = this.formatSupplementalCodeContext(workingCodeSnippets);
        }

        previousIterationText = this.buildIterationSummaryForPrompt(
          iterIndex,
          parsedResponse,
          finalConfidence,
          iterationNodeAssessments
        );
        currentEpicenter = this.updateEpicenterForNextIteration(currentEpicenter, epicenterResult.firstNew);

        if (epicenterResult.firstNew) {
          const extension = await this.extendGraphWithEpicenter({
            graph,
            codeSnippets: workingCodeSnippets,
            epicenter: currentEpicenter,
            workspace
          });

          if (extension.newSnippets.length > 0) {
            supplementalSnippets.push(...extension.newSnippets);
            workingCodeSnippets.push(...extension.newSnippets);
          }

          executionTraceText = extension.executionTrace;
          supplementalContextText = this.formatSupplementalCodeContext(workingCodeSnippets);
        }
      }

      const keywordHintsSnapshot = this.snapshotKeywordHints(keywordAccumulator);
      const primaryEpicenter = epicenterSuggestions[0];
      const newEpicenter = primaryEpicenter
        ? {
            files: [primaryEpicenter.file],
            methods: primaryEpicenter.method ? [{ file: primaryEpicenter.file, method: primaryEpicenter.method }] : [],
            reason: primaryEpicenter.reason
          }
        : undefined;

      const finalHypothesis = finalParsedResponse.hypothesis || 'Analysis completed';
      const nodeAssessments = latestNodeAssessments;
      timings.total = Date.now() - startTime;

      const report: RootCauseReport = {
        summary: `## 🧩 Root Cause Analysis Report\n\n**Hypothesis:** ${finalHypothesis}\n\n**Confidence:** ${(finalConfidence * 100).toFixed(0)}%\n\n`,
        likelyRootCause: finalHypothesis,
        reasoningSteps: [
          finalParsedResponse.reasoningSummary
            ? `Reasoning summary: ${finalParsedResponse.reasoningSummary}`
            : 'Analyzed code snippets from graph',
          `Confidence: ${(finalConfidence * 100).toFixed(0)}%`,
          shouldRetry ? 'Low confidence - suggesting new epicenter for deeper analysis' : 'Analysis complete'
        ],
        recommendedFix: 'Review the hypothesis and suggested epicenters for further investigation',
        evidence: workingCodeSnippets.map(s => `${s.file}::${s.method}`),
        confidence: finalConfidence,
        hypotheses: [{
          id: 'hypothesis-1',
          summary: finalHypothesis,
          evidence: workingCodeSnippets.map(s => `${s.file}::${s.method}`),
          relatedNodes: graph.nodes.slice(0, 5).map(n => n.id),
          confidence: finalConfidence,
          rationale: finalParsedResponse.reasoningSummary || finalHypothesis,
          relatedFiles: Array.from(new Set(workingCodeSnippets.map(s => s.file)))
        }],
        confidenceSummaryTable: `| Hypothesis | Confidence | Verdict |\n|-------------|-------------|----------|\n| Main hypothesis | ${(finalConfidence * 100).toFixed(0)}% | ${finalConfidence >= confidenceThreshold ? '✅' : '⚠️'} ${finalConfidence >= confidenceThreshold ? 'sufficient' : 'needs more context'} |`,
        timings
      };

      console.log('[RootCauseAnalyzer] Simplified analysis completed:', {
        confidence: finalConfidence,
        shouldRetry,
        epicenterCount: epicenterSuggestions.length,
        keywordFiles: keywordHintsSnapshot.files.length,
        keywordTerms: keywordHintsSnapshot.terms.length,
        nodeAssessments: nodeAssessments.length
      });

      return {
        report,
        shouldRetry,
        epicenters: epicenterSuggestions,
        keywordHints: keywordHintsSnapshot,
        iterationSummaries,
        iterationPrompts,
        nodeAssessments,
        additionalSnippets: supplementalSnippets,
        newEpicenter,
        prompt: finalPrompt,
        rawResponse: finalRawResponse,
        formattedResponse: finalFormattedResponse
      };

    } catch (error) {
      console.error('[RootCauseAnalyzer] Error in simplified root cause analysis:', error);
      
      return {
        report: this.createErrorReport(error as Error, timings),
        shouldRetry: false,
        prompt: undefined,
        rawResponse: undefined,
        formattedResponse: undefined
      };
    }
  }

  /**
   * Create error report when analysis fails
   */
  private createErrorReport(error: Error, timings: Record<string, number>): RootCauseReport {
    return {
      summary: '## 🧩 Root Cause Analysis Report\n\n**Error:** Analysis failed due to technical issues\n\n**Status:** Unable to complete analysis\n\n',
      likelyRootCause: 'Analysis could not be completed',
      reasoningSteps: [
        'Root cause analysis encountered an error',
        'Technical issue prevented hypothesis generation',
        'Manual investigation may be required'
      ],
      recommendedFix: 'Please try again or investigate manually using the provided evidence',
      evidence: [`Error: ${error.message}`],
      confidence: 0,
      hypotheses: [],
      confidenceSummaryTable: '| Hypothesis | Confidence | Verdict |\n|-------------|-------------|----------|\n| Analysis failed | 0% | ❌ error |',
      timings: { ...timings, total: Date.now() - (timings.evidence || 0) }
    };
  }

  /**
   * Get analysis statistics
   */
  getAnalysisStats(report: RootCauseReport): {
    totalTime: number;
    hypothesesGenerated: number;
    confidence: number;
    evidenceCount: number;
  } {
    return {
      totalTime: report.timings.total || 0,
      hypothesesGenerated: report.hypotheses.length,
      confidence: report.confidence,
      evidenceCount: report.evidence.length
    };
  }

  /**
   * Clear all caches
   */
  clearCaches(): void {
    // Clear feedback retriever cache
    this.feedbackRetriever.clearCache();
  }
}
