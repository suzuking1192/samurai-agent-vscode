import { randomUUID } from "crypto";
import * as path from "path";
import {
  ToolDefinition,
  ToolExecutionResult,
} from "../../common/models/tool-models";
import {
  LLMMessage,
  LLMRequest,
  LLMResponse,
} from "../../common/models/llm-models";
import { LLMProviderService } from "../llm/llmProviderService";
import { CodeParserService } from "../code_parser/CodeParserService";
import { CodeElement, FileInfo } from "../../common/models/context-models";
import { ResponseType } from "../../common/models/response-models";
import { TextDecoder } from "util";
import * as vscode from "vscode";
import { extractJsonFromLLMResponse } from "../../common/utils/llmResponseParser";
import { RecentFilesTracker } from "../../services/RecentFilesTracker";
import { 
  DebuggingExtractionInput, 
  ExtractionResponse, 
  Evidence, 
  CandidateFile, 
  CandidateSymbolRef,
  RootSpec,
  MethodExecutionGraph,
  SearchPlan,
  GraphNode,
  GraphEdge
} from "./debugging/types";
import { EvidenceParser } from "./debugging/EvidenceParser";
import { SearchPlanner } from "./debugging/SearchPlanner";
import { HybridRetriever } from "./debugging/HybridRetriever";
import { AstProgramBuilder } from "./debugging/AstProgramBuilder";
import { StaticSlicer } from "./debugging/StaticSlicer";
import { GraphCompressor, convertCompressedToMethodGraph } from "./debugging/GraphCompressor";
import { GapDetector } from "./debugging/GapDetector";
import { InfoRequestBuilder } from "./debugging/InfoRequestBuilder";
import { AgentPromptGenerator } from "./debugging/AgentPromptGenerator";
import { SnippetStore, SnippetUtils, createSnippetStore } from "./debugging/SnippetStore";
import { GraphPolisher } from "./debugging/GraphPolisher";

const DEFAULT_MAX_ITERATIONS = 2;
const DEFAULT_MAX_FILES = 5000;
const DEFAULT_MAX_RESULTS = 300;
const GLOBAL_CONTEXT_TOKEN_LIMIT = 300000; // Global limit for all files combined

// Constants for graph building limits
const MAX_CANDIDATE_FILES_FOR_GRAPH = 20;  // Max candidate files to process
const MAX_CANDIDATE_SLICE_FOR_GRAPH = 12;  // Max candidates to take from list

// Constants for global budget circuit breaker
const MAX_GRAPH_NODES = 150;                  // Shared budget for nodes
const MAX_GRAPH_EDGES = 300;                  // Shared budget for edges
const MAX_PHASE_MS = 3000;                    // Per major phase timeout (3 seconds)
const WATCHDOG_MS = 5000;                     // Overall watchdog timeout (5 seconds)

// Custom error for budget exceeded
class BudgetExceededError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BUDGET_EXCEEDED';
  }
}

// Global budget tracker
interface GraphBudget {
  nodes: number;
  edges: number;
  start: number;
  phaseStart: number;
}

function createBudget(): GraphBudget {
  const now = Date.now();
  return {
    nodes: 0,
    edges: 0,
    start: now,
    phaseStart: now
  };
}

function spend(budget: GraphBudget, nInc: number = 0, eInc: number = 0): void {
  budget.nodes += nInc;
  budget.edges += eInc;
  
  const now = Date.now();
  const phaseElapsed = now - budget.phaseStart;
  const totalElapsed = now - budget.start;
  
  if (budget.nodes > MAX_GRAPH_NODES) {
    throw new BudgetExceededError(`Node budget exceeded: ${budget.nodes} > ${MAX_GRAPH_NODES}`);
  }
  
  if (budget.edges > MAX_GRAPH_EDGES) {
    throw new BudgetExceededError(`Edge budget exceeded: ${budget.edges} > ${MAX_GRAPH_EDGES}`);
  }
  
  if (phaseElapsed > MAX_PHASE_MS) {
    throw new BudgetExceededError(`Phase timeout: ${phaseElapsed}ms > ${MAX_PHASE_MS}ms`);
  }
  
  if (totalElapsed > WATCHDOG_MS) {
    throw new BudgetExceededError(`Watchdog timeout: ${totalElapsed}ms > ${WATCHDOG_MS}ms`);
  }
}

function resetPhaseStart(budget: GraphBudget): void {
  budget.phaseStart = Date.now();
}

type NormalizedExtractCodeParameters = ExtractCodeParameters & {
  query: string;
  projectId: string;
  maxIterations: number;
  model: string;
  filenameKeywords: string[];
  methodNameKeywords: string[];
  codeKeywords: string[];
  maxDependencyDepth: number;
  manuallyPinnedFilePaths: string[];
};

export interface ExtractCodeToolResultPayload {
  relevantCodeElements: Array<{
    path: string;
    elements: CodeElement[];
    snippet: string;
  }>;
  files: Array<{
    path: string;
    snippet: string;
  }>;
}

export interface ExtractCodeParameters {
  query: string;
  filePathPattern?: string;
  projectId: string;
  connectedCodebasePath?: string;
  sessionId?: string;
  maxIterations?: number;
  model?: string; // User's selected model
  filenameKeywords?: string[];
  methodNameKeywords?: string[];
  codeKeywords?: string[];
  maxDependencyDepth?: number; // Maximum depth for recursive dependency resolution (default: 3)
  manuallyPinnedFilePaths?: string[]; // Optional array of absolute file paths to unconditionally include
}

export class ExtractCodeTool {
  public readonly definition: ToolDefinition = {
    id: randomUUID(),
    createdAt: new Date(),
    updatedAt: new Date(),
    name: "extract_relevant_code",
    description:
      "Extracts code snippets relevant to the provided query. Placeholder implementation.",
      parameters: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description: "Description of the code to extract.",
        },
        filePathPattern: {
          type: "string",
          description: "Optional glob or regex pattern to narrow file search.",
        },
          projectId: {
            type: "string",
            description: "Identifier of the current project for LLM routing and persistence.",
          },
          connectedCodebasePath: {
            type: "string",
            description: "Absolute path to the connected codebase root.",
          },
          sessionId: {
            type: "string",
            description: "Optional session identifier for associating extracted context.",
          },
          maxIterations: {
            type: "number",
            description: "Maximum number of iterative refinement passes to run.",
            default: DEFAULT_MAX_ITERATIONS,
          },
          model: {
            type: "string",
            description: "User's selected LLM model for code extraction.",
          },
          filenameKeywords: {
            type: "array",
            items: { type: "string" },
            description: "Optional array of keywords to match against filenames.",
          },
          methodNameKeywords: {
            type: "array",
            items: { type: "string" },
            description: "Optional array of keywords to match against method/function names.",
          },
          codeKeywords: {
            type: "array",
            items: { type: "string" },
            description: "Optional array of keywords to match against file content.",
          },
          maxDependencyDepth: {
            type: "number",
            description: "Maximum depth for recursive dependency resolution. Higher values find more transitive dependencies but take longer.",
            default: 3,
          },
      },
      required: ["query", "projectId"],
      additionalProperties: false,
    },
    required: ["query", "projectId"],
    category: "code_analysis",
    enabled: true,
    metadata: {},
  };

  constructor(
    private readonly llmProvider: LLMProviderService,
    private readonly codeParser: CodeParserService = new CodeParserService(),
  ) {
    this.snippetStore = createSnippetStore('memory', { maxBytes: 50 * 1024 * 1024, maxSnippets: 1000 });
  }

  private readonly snippetStore: SnippetStore;

  public async execute(
    params: ExtractCodeParameters,
  ): Promise<ToolExecutionResult> {
    const startTime = Date.now();

    try {
      const normalizedParams = this.normalizeParams(params);
      this.logInvocation(normalizedParams);

      const fileInfos = await this.scanCodebase(normalizedParams);
      const filteredFileInfos = this.filterFileInfos(
        fileInfos,
        normalizedParams.filePathPattern,
      );

      if (!filteredFileInfos.size) {
        throw new Error("No code files found that match the provided parameters.");
      }

      // Process pinned files early
      const workspaceRoot = normalizedParams.connectedCodebasePath || vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || '';
      const pinnedFileInfos = await this.processPinnedFiles(
        normalizedParams.manuallyPinnedFilePaths,
        workspaceRoot
      );

      // Merge pinned files into filteredFileInfos
      const mergedFileInfos = new Map([...filteredFileInfos, ...pinnedFileInfos]);
      console.log(`ExtractCodeTool: Total files after pinning: ${mergedFileInfos.size} (pinned: ${pinnedFileInfos.size})`);

      const relevantElementSelections = await this.rankRelevantFileswithLLM(
        mergedFileInfos,
        normalizedParams.query,
        normalizedParams.projectId,
        normalizedParams.model,
      );

      // NEW: Resolve missing dependencies identified by LLM
      const enrichedFileInfos = await this.resolveMissingDependencies(
        relevantElementSelections,
        mergedFileInfos,
        workspaceRoot,
        normalizedParams.maxDependencyDepth
      );

      console.log(`ExtractCodeTool: Enriched file count: ${enrichedFileInfos.size} (original: ${mergedFileInfos.size})`);

      // Use enrichedFileInfos for all subsequent operations
      const keywordSelections = await this.performKeywordBasedSearch(
        enrichedFileInfos,
        normalizedParams,
      );

      const mergedSelections = this.mergeKeywordAndLLMSelections(
        relevantElementSelections,
        keywordSelections,
      );

      let structuredContext = await this.buildStructuredCodeContextSnippets(
        enrichedFileInfos,
        mergedSelections,
        GLOBAL_CONTEXT_TOKEN_LIMIT,
        normalizedParams.manuallyPinnedFilePaths,
      );

      if (structuredContext.length === 0) {
        const fallbackSelections = this.heuristicFallbackSelections(
          enrichedFileInfos,
          normalizedParams.query,
        );

        if (fallbackSelections.size) {
          structuredContext = await this.buildStructuredCodeContextSnippets(
            enrichedFileInfos,
            fallbackSelections,
            GLOBAL_CONTEXT_TOKEN_LIMIT,
            normalizedParams.manuallyPinnedFilePaths,
          );
        }
      }

      if (structuredContext.length === 0) {
        throw new Error("No relevant code elements found for the given query.");
      }

      console.log("ExtractCodeTool: Structured context prepared", structuredContext.map(ctx => ({
        path: ctx.path,
        elementNames: ctx.elements.map(el => `${el.type}:${el.name}`),
        snippetPreview: ctx.snippet.slice(0, 120),
      })));

      const relevantElementSelections_after_step2 = await this.identifyRelevantCodeElementsWithLLM(
        enrichedFileInfos,
        structuredContext,
        normalizedParams,
      );

      let structuredContext_after_step2 = await this.buildStructuredCodeContextSnippets(
        enrichedFileInfos,
        relevantElementSelections_after_step2,
        GLOBAL_CONTEXT_TOKEN_LIMIT,
      );

      const executionTime = Date.now() - startTime;
      
      // Extract identified elements for the result
      const identifiedElements: Array<{
        name: string;
        type: string;
        lineStart: number;
        filePath: string;
        signature?: string;
      }> = [];
      
      for (const context of structuredContext_after_step2) {
        for (const element of context.elements) {
          identifiedElements.push({
            name: element.name,
            type: element.type,
            lineStart: element.lineStart,
            filePath: element.filePath,
            signature: element.signature,
          });
        }
      }

      return {
        success: true,
        result: {
          relevantCodeElements: structuredContext_after_step2,
          files: structuredContext_after_step2.map(context => ({ path: context.path, snippet: context.snippet })),
        } as ExtractCodeToolResultPayload,
        executionTime,
        metadata: {
          projectId: normalizedParams.projectId,
        },
        elements: identifiedElements,
      };
    } catch (error) {
      const executionTime = Date.now() - startTime;
      
      return {
        success: false,
        error: error instanceof Error ? error.message : "Unknown error",
        executionTime,
        metadata: {},
      };
    }
  }

  private logInvocation(params: ExtractCodeParameters): void {
    console.log("ExtractCodeTool invoked with parameters:", {
      query: params.query,
      queryLength: params.query?.length,
      filePathPattern: params.filePathPattern,
      projectId: params.projectId,
      sessionId: params.sessionId,
      connectedCodebasePath: params.connectedCodebasePath,
      maxIterations: params.maxIterations,
      filenameKeywords: params.filenameKeywords,
      methodNameKeywords: params.methodNameKeywords,
      codeKeywords: params.codeKeywords
    });
  }

  private normalizeParams(params: ExtractCodeParameters): NormalizedExtractCodeParameters {
    if (!params.projectId || !params.projectId.trim()) {
      throw new Error("projectId is required for ExtractCodeTool.");
    }

    const query = params.query?.trim();
    if (!query) {
      throw new Error("query must be a non-empty string.");
    }

    const projectId = params.projectId.trim();
    const maxIterations = Math.max(
      1,
      params.maxIterations ?? DEFAULT_MAX_ITERATIONS,
    );
    const model = params.model || "";

    return {
      ...params,
      query,
      projectId,
      maxIterations,
      model,
      filenameKeywords: params.filenameKeywords || [],
      methodNameKeywords: params.methodNameKeywords || [],
      codeKeywords: params.codeKeywords || [],
      maxDependencyDepth: params.maxDependencyDepth ?? 3,
      manuallyPinnedFilePaths: params.manuallyPinnedFilePaths || [],
    };
  }

  private async scanCodebase(
    params: NormalizedExtractCodeParameters,
  ): Promise<Map<string, FileInfo>> {
    const root = params.connectedCodebasePath;
    try {
      return await this.codeParser.scanCodebase(root, DEFAULT_MAX_FILES);
    } catch (error) {
      throw new Error(
        `Failed to scan codebase${root ? ` at ${root}` : ""}: ${error instanceof Error ? error.message : error}`,
      );
    }
  }

  private filterFileInfos(
    fileInfos: Map<string, FileInfo>,
    pattern?: string,
  ): Map<string, FileInfo> {
    if (!pattern || !pattern.trim()) {
      return fileInfos;
    }

    const regex = this.compilePattern(pattern);
    if (!regex) {
      return fileInfos;
    }

    const filtered = new Map<string, FileInfo>();
    for (const [path, info] of fileInfos.entries()) {
      if (regex.test(path) || regex.test(info.name)) {
        filtered.set(path, info);
      }
    }

    return filtered.size ? filtered : fileInfos;
  }

  private compilePattern(pattern: string): RegExp | undefined {
    const trimmed = pattern.trim();
    if (!trimmed) {
      return undefined;
    }

    if (trimmed.startsWith("/") && trimmed.endsWith("/") && trimmed.length > 2) {
      try {
        return new RegExp(trimmed.slice(1, -1), "i");
      } catch {
        return undefined;
      }
    }

    const escaped = trimmed.replace(/[.+^${}()|[\]\\]/g, "\\$&");
    const globConverted = escaped
      .replace(/\\\*/g, ".*")
      .replace(/\\\?/g, ".");

    try {
      return new RegExp(globConverted, "i");
    } catch {
      try {
        return new RegExp(trimmed, "i");
      } catch {
        return undefined;
      }
    }
  }

  private async rankRelevantFileswithLLM(
    fileInfos: Map<string, FileInfo>,
    query: string,
    projectId: string,
    model: string,
  ): Promise<Map<string, Array<{ name: string; type: string; }>>> {
    // Build folder structure context for LLM
    const folderStructure = this.buildFolderStructureContext(fileInfos);

    // Build recently opened files context (workspace-aware)
    const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || '';
    const recentFilesContext = this.buildRecentlyOpenedFilesContext(10, workspaceRoot);

    // Build a summary of all files with their elements for LLM analysis
    const fileElementsSummary = Array.from(fileInfos.entries())
      .map(([filePath, fileInfo]) => {
        const elementsList = fileInfo.elements
          .map(element => `${element.type}: ${element.name}`)
          .join(', ');
        return `${filePath}: [${elementsList}]`;
      })
      .join('\n');

    const promptTemplate = await this.loadPrompt(
      "codeParser/step2_identify_relevant_elements.md"
    );

    const prompt = promptTemplate
      .replace("{{USER_REQUEST}}", query)
      .replace("{{FOLDER_STRUCTURE}}", folderStructure)
      .replace("{{RECENTLY_OPENED_FILES}}", recentFilesContext)
      .replace("{{FILE_ELEMENTS_SUMMARY}}", fileElementsSummary);

    console.log("ExtractCodeTool: Ranking prompt prepared", {
      fileCount: fileInfos.size,
      query,
      projectId,
      promptPreview: prompt.slice(0, 300),
    });

    const messages: LLMMessage[] = [
      { role: "system", content: prompt },
    ];

    const request: LLMRequest = {
      id: `rank-files-${Date.now()}`,
      provider: "auto",
      model: model || "",
      messages,
      metadata: {
        projectId,
        purpose: "rank_relevant_files_and_elements",
      },
      createdAt: new Date(),
      updatedAt: new Date(),
      maxTokens: 20000,
    };

    console.log('[EXTRACT CODE DEBUG] Setting explicit maxTokens for file ranking:', request.maxTokens);

    try {
      console.log("=== LLM RANKING DEBUG START ===");
      console.log("Request details:", {
        requestId: request.id,
        provider: request.provider,
        model: request.model,
        messageCount: request.messages.length,
        messageLengths: request.messages.map(m => m.content.length),
        metadata: request.metadata
      });

      // Log the prompt content for debugging (especially important for Gemini safety issues)
      console.log("=== PROMPT CONTENT DEBUG ===");
      request.messages.forEach((message, index) => {
        console.log(`Message ${index} (${message.role}):`, {
          contentLength: message.content.length,
          contentPreview: message.content.substring(0, 200) + (message.content.length > 200 ? '...' : ''),
          fullContent: message.content
        });
      });
      console.log("=== END PROMPT CONTENT DEBUG ===");

      const response = await this.llmProvider.chat(request);
      
      console.log("Raw LLM response:", {
        responseType: response.type,
        hasPayload: !!response.payload,
        error: response.error || 'none',
        responseKeys: Object.keys(response)
      });

      if (response.type !== ResponseType.SUCCESS || !response.payload) {
        console.warn("LLM ranking failed, falling back to file-level ranking. Response details:", {
          type: response.type,
          error: response.error,
          hasPayload: !!response.payload,
          payload: response.payload
        });
        console.log("=== LLM RANKING DEBUG END (FAILED) ===");
        return this.fallbackToFileRanking(fileInfos, query);
      }

      const payload = response.payload as LLMResponse;
      console.log("LLM payload details:", {
        payloadKeys: Object.keys(payload),
        contentType: typeof payload.content,
        contentLength: payload.content?.length || 0,
        contentPreview: payload.content?.substring(0, 100) + (payload.content && payload.content.length > 100 ? '...' : ''),
        fullContent: payload.content,
        hasUsage: !!payload.usage,
        usage: payload.usage,
        provider: payload.provider,
        model: payload.model,
        hasMetadata: !!payload.metadata,
        metadataKeys: payload.metadata ? Object.keys(payload.metadata) : [],
        rawResponse: payload.metadata?.rawResponse
      });

      // Additional Gemini-specific debugging
      if (payload.provider === 'google' && payload.metadata?.rawResponse) {
        const rawResponse = payload.metadata.rawResponse;
        console.log("=== GEMINI RAW RESPONSE DEBUG ===");
        console.log("Raw response structure:", {
          hasResponse: !!rawResponse.response,
          responseKeys: rawResponse.response ? Object.keys(rawResponse.response) : [],
          hasCandidates: !!rawResponse.response?.candidates,
          candidatesLength: rawResponse.response?.candidates?.length || 0,
          hasPromptFeedback: !!rawResponse.response?.promptFeedback,
          hasUsageMetadata: !!rawResponse.response?.usageMetadata
        });

        // Check for safety-related information
        if (rawResponse.response?.promptFeedback) {
          console.log("Gemini prompt feedback:", rawResponse.response.promptFeedback);
        }

        if (rawResponse.response?.candidates) {
          rawResponse.response.candidates.forEach((candidate: any, index: number) => {
            console.log(`Candidate ${index}:`, {
              hasContent: !!candidate.content,
              hasFinishReason: !!candidate.finishReason,
              finishReason: candidate.finishReason,
              hasSafetyRatings: !!candidate.safetyRatings,
              safetyRatings: candidate.safetyRatings,
              hasCitationMetadata: !!candidate.citationMetadata,
              citationMetadata: candidate.citationMetadata
            });

            if (candidate.safetyRatings) {
              console.log(`Candidate ${index} safety ratings:`, candidate.safetyRatings.map((rating: any) => ({
                category: rating.category,
                probability: rating.probability,
                blocked: rating.blocked
              })));
            }

            if (candidate.finishReason) {
              console.log(`Candidate ${index} finish reason:`, candidate.finishReason);
            }
          });
        }

        console.log("=== END GEMINI RAW RESPONSE DEBUG ===");
      }

      const json = extractJsonFromLLMResponse(
        payload.content,
      );

      console.log("JSON extraction result:", {
        jsonType: typeof json,
        jsonIsNull: json === null,
        jsonKeys: json && typeof json === 'object' ? Object.keys(json) : 'not an object',
        jsonPreview: JSON.stringify(json)?.substring(0, 200) + (JSON.stringify(json) && JSON.stringify(json).length > 200 ? '...' : '')
      });

      // Check if JSON parsing was successful
      if (!json || typeof json !== 'object') {
        console.warn("LLM response parsing failed or returned invalid JSON:", {
          json: json,
          jsonType: typeof json,
          payloadContent: payload.content,
          payloadContentLength: payload.content?.length || 0,
          payloadContentType: typeof payload.content,
          responseType: response.type,
          responseError: response.error
        });
        console.log("=== LLM RANKING DEBUG END (PARSE FAILED) ===");
        return this.fallbackToFileRanking(fileInfos, query);
      }

      const filesObject = json.files || {};

      const result = new Map<string, Array<{ name: string; type: string }>>();

      for (const [filePath, elements] of Object.entries(filesObject)) {
        if (!Array.isArray(elements)) {
          continue;
        }

        const fileInfo = fileInfos.get(filePath);
        console.log(`Processing file ${filePath} with elements:`, elements);
        console.log(`Available elements in file:`, fileInfo?.elements.map(el => `${el.name} (${el.type})`).join(', '));

        const elementSelections = elements.map((elementName) => {
          const element = fileInfo?.elements.find((el) => el.name === elementName);
          const result = {
            name: elementName,
            type: element?.type || "unknown",
          };
          console.log(`Element ${elementName} -> ${result.type} (found: ${!!element})`);
          return result;
        });

        result.set(filePath, elementSelections);
      }

      console.log("=== LLM RANKING DEBUG END (SUCCESS) ===");
      return result;
    } catch (error) {
      console.warn("Error in LLM ranking:", error);
      console.log("=== LLM RANKING DEBUG END (EXCEPTION) ===");
      
      return this.fallbackToFileRanking(fileInfos, query);
    }
  }

  private async identifyRelevantCodeElementsWithLLM(
    fileInfos: Map<string, FileInfo>,
    structuredContext: Array<{ path: string; elements: CodeElement[]; snippet: string; }>,
    params: NormalizedExtractCodeParameters,
  ): Promise<any> {
    // Build folder structure context for LLM
    const folderStructure = this.buildFolderStructureContext(fileInfos);

    // Build recently opened files context (workspace-aware)
    const workspaceRoot = params.connectedCodebasePath || vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || '';
    const recentFilesContext = this.buildRecentlyOpenedFilesContext(10, workspaceRoot);

    const promptTemplate = await this.loadPrompt(
      "codeParser/extract_code_context.md",
    );

    const combinedContent = structuredContext
      .map(context => {
        const elementTypes = context.elements.map(el => `${el.type}: ${el.name}`).join(', ');
        const header = `=== FILE: ${context.path} (${elementTypes}) ===`;
        return `${header}\n${context.snippet}`;
      })
      .join("\n\n");

    const prompt = promptTemplate
      .replace("{{USER_REQUEST}}", params.query)
      .replace("{{FOLDER_STRUCTURE}}", folderStructure)
      .replace("{{RECENTLY_OPENED_FILES}}", recentFilesContext)
      .replace("{{CODE_CONTENT}}", combinedContent);

    const messages: LLMMessage[] = [
      { role: "system", content: prompt },
    ];

    const request: LLMRequest = {
      id: `extract-code-${Date.now()}`,
      provider: "auto",
      model: params.model || "",
      messages,
      metadata: {
        projectId: params.projectId,
        purpose: "extract_code_context",
      },
      createdAt: new Date(),
      updatedAt: new Date(),
      maxTokens: 40000,
    };

    console.log('[EXTRACT CODE DEBUG] Setting explicit maxTokens for code extraction:', request.maxTokens);

    console.log("=== LLM CODE ELEMENT IDENTIFICATION DEBUG START ===");
    console.log("Request details:", {
      requestId: request.id,
      provider: request.provider,
      model: request.model,
      messageCount: request.messages.length,
      messageLengths: request.messages.map(m => m.content.length),
      metadata: request.metadata
    });

    // Log the prompt content for debugging (especially important for Gemini safety issues)
    console.log("=== CODE ELEMENT IDENTIFICATION PROMPT CONTENT DEBUG ===");
    request.messages.forEach((message, index) => {
      console.log(`Message ${index} (${message.role}):`, {
        contentLength: message.content.length,
        contentPreview: message.content.substring(0, 200) + (message.content.length > 200 ? '...' : ''),
        fullContent: message.content
      });
    });
    console.log("=== END CODE ELEMENT IDENTIFICATION PROMPT CONTENT DEBUG ===");

    const response = await this.llmProvider.chat(request);
    
    console.log("Raw LLM response:", {
      responseType: response.type,
      hasPayload: !!response.payload,
      error: response.error || 'none',
      responseKeys: Object.keys(response)
    });

    if (response.type !== ResponseType.SUCCESS || !response.payload) {
      console.warn("LLM extraction failed. Response details:", {
        type: response.type,
        error: response.error,
        hasPayload: !!response.payload,
        payload: response.payload
      });
      console.log("=== LLM CODE ELEMENT IDENTIFICATION DEBUG END (FAILED) ===");
      throw new Error("LLM extraction failed");
    }

    const payload = response.payload as LLMResponse;
    console.log("LLM payload details:", {
      payloadKeys: Object.keys(payload),
      contentType: typeof payload.content,
      contentLength: payload.content?.length || 0,
      contentPreview: payload.content?.substring(0, 100) + (payload.content && payload.content.length > 100 ? '...' : ''),
      fullContent: payload.content,
      hasUsage: !!payload.usage,
      usage: payload.usage,
      provider: payload.provider,
      model: payload.model,
      hasMetadata: !!payload.metadata,
      metadataKeys: payload.metadata ? Object.keys(payload.metadata) : [],
      rawResponse: payload.metadata?.rawResponse
    });

    // Additional Gemini-specific debugging
    if (payload.provider === 'google' && payload.metadata?.rawResponse) {
      const rawResponse = payload.metadata.rawResponse;
      console.log("=== GEMINI CODE ELEMENT IDENTIFICATION RAW RESPONSE DEBUG ===");
      console.log("Raw response structure:", {
        hasResponse: !!rawResponse.response,
        responseKeys: rawResponse.response ? Object.keys(rawResponse.response) : [],
        hasCandidates: !!rawResponse.response?.candidates,
        candidatesLength: rawResponse.response?.candidates?.length || 0,
        hasPromptFeedback: !!rawResponse.response?.promptFeedback,
        hasUsageMetadata: !!rawResponse.response?.usageMetadata
      });

      // Check for safety-related information
      if (rawResponse.response?.promptFeedback) {
        console.log("Gemini prompt feedback:", rawResponse.response.promptFeedback);
      }

      if (rawResponse.response?.candidates) {
        rawResponse.response.candidates.forEach((candidate: any, index: number) => {
          console.log(`Candidate ${index}:`, {
            hasContent: !!candidate.content,
            hasFinishReason: !!candidate.finishReason,
            finishReason: candidate.finishReason,
            hasSafetyRatings: !!candidate.safetyRatings,
            safetyRatings: candidate.safetyRatings,
            hasCitationMetadata: !!candidate.citationMetadata,
            citationMetadata: candidate.citationMetadata
          });

          if (candidate.safetyRatings) {
            console.log(`Candidate ${index} safety ratings:`, candidate.safetyRatings.map((rating: any) => ({
              category: rating.category,
              probability: rating.probability,
              blocked: rating.blocked
            })));
          }

          if (candidate.finishReason) {
            console.log(`Candidate ${index} finish reason:`, candidate.finishReason);
          }
        });
      }

      console.log("=== END GEMINI CODE ELEMENT IDENTIFICATION RAW RESPONSE DEBUG ===");
    }

    const json = extractJsonFromLLMResponse(payload.content);

    console.log("JSON extraction result:", {
      jsonType: typeof json,
      jsonIsNull: json === null,
      jsonKeys: json && typeof json === 'object' ? Object.keys(json) : 'not an object',
      jsonPreview: JSON.stringify(json)?.substring(0, 200) + (JSON.stringify(json) && JSON.stringify(json).length > 200 ? '...' : '')
    });

    // Check if JSON parsing was successful
    if (!json || typeof json !== 'object') {
      console.warn("LLM response parsing failed in identifyRelevantCodeElementsWithLLM:", {
        json: json,
        jsonType: typeof json,
        payloadContent: payload.content,
        payloadContentLength: payload.content?.length || 0,
        payloadContentType: typeof payload.content,
        responseType: response.type,
        responseError: response.error
      });
      console.log("=== LLM CODE ELEMENT IDENTIFICATION DEBUG END (PARSE FAILED) ===");
      throw new Error("Failed to parse LLM response for code element identification");
    }

    const filesObject = json.files || {};

    // ========== DIAGNOSTIC LOGGING: File Path Comparison ==========
    console.log("=== FILE PATH DIAGNOSTICS START ===");
    const llmReturnedPaths = Object.keys(filesObject);
    const fileInfosPaths = Array.from(fileInfos.keys());
    
    console.log(`LLM returned ${llmReturnedPaths.length} file paths:`);
    llmReturnedPaths.forEach((path, index) => {
      console.log(`  ${index + 1}. "${path}" (type: ${typeof path}, length: ${path.length})`);
    });
    
    console.log(`fileInfos Map contains ${fileInfosPaths.length} file paths:`);
    fileInfosPaths.forEach((path, index) => {
      const isMatch = llmReturnedPaths.includes(path);
      console.log(`  ${index + 1}. "${path}" (type: ${typeof path}, length: ${path.length}) ${isMatch ? '✓ MATCHED' : '✗ NOT MATCHED'}`);
    });
    
    // Check for path format differences
    const unmatchedLLMPaths = llmReturnedPaths.filter(llmPath => !fileInfosPaths.includes(llmPath));
    const unmatchedFileInfoPaths = fileInfosPaths.filter(infoPath => !llmReturnedPaths.includes(infoPath));
    
    if (unmatchedLLMPaths.length > 0) {
      console.log(`\n⚠️  LLM returned ${unmatchedLLMPaths.length} paths NOT in fileInfos:`);
      unmatchedLLMPaths.forEach((path, index) => {
        console.log(`  ${index + 1}. "${path}"`);
        // Try to find similar paths (normalization, relative vs absolute)
        const normalizedLLMPath = path.replace(/\\/g, '/');
        const similarPaths = fileInfosPaths.filter(infoPath => {
          const normalizedInfoPath = infoPath.replace(/\\/g, '/');
          return normalizedInfoPath === normalizedLLMPath || 
                 normalizedInfoPath.endsWith(normalizedLLMPath) ||
                 normalizedLLMPath.endsWith(normalizedInfoPath);
        });
        if (similarPaths.length > 0) {
          console.log(`     Possible matches: ${similarPaths.map(p => `"${p}"`).join(', ')}`);
        }
      });
    }
    
    if (unmatchedFileInfoPaths.length > 0 && unmatchedFileInfoPaths.length <= 20) {
      console.log(`\nℹ️  fileInfos contains ${unmatchedFileInfoPaths.length} paths NOT requested by LLM (showing first 20):`);
      unmatchedFileInfoPaths.slice(0, 20).forEach((path, index) => {
        console.log(`  ${index + 1}. "${path}"`);
      });
    }
    console.log("=== FILE PATH DIAGNOSTICS END ===\n");

    const result = new Map<string, Array<{ name: string; type: string }>>();
    
    // Track statistics
    let filesMatched = 0;
    let filesNotFound = 0;
    let totalElementsRequested = 0;
    let totalElementsFound = 0;
    const elementMismatches: Array<{filePath: string; requested: string; available: string[]}> = [];

    for (const [filePath, elements] of Object.entries(filesObject)) {
      if (!Array.isArray(elements)) {
        continue;
      }

      const fileInfo = fileInfos.get(filePath);
      
      // ========== DIAGNOSTIC LOGGING: File Info Lookup ==========
      if (!fileInfo) {
        filesNotFound++;
        console.log(`\n⚠️  FILE NOT FOUND: "${filePath}"`);
        console.log(`   Attempted lookup path format: ${typeof filePath === 'string' ? 'string' : typeof filePath}`);
        console.log(`   Path separators: contains \\: ${filePath.includes('\\')}, contains /: ${filePath.includes('/')}`);
        
        // Show similar paths for debugging
        const normalizedSearchPath = filePath.replace(/\\/g, '/');
        const similarPaths = fileInfosPaths.filter(infoPath => {
          const normalizedInfoPath = infoPath.replace(/\\/g, '/');
          const searchBasename = normalizedSearchPath.split('/').pop() || '';
          const infoBasename = normalizedInfoPath.split('/').pop() || '';
          return normalizedInfoPath.includes(searchBasename) || 
                 searchBasename === infoBasename ||
                 normalizedInfoPath.endsWith(normalizedSearchPath) ||
                 normalizedSearchPath.endsWith(normalizedInfoPath);
        });
        
        if (similarPaths.length > 0) {
          console.log(`   Similar paths in fileInfos (${similarPaths.length}):`);
          similarPaths.slice(0, 5).forEach((similarPath, idx) => {
            console.log(`     ${idx + 1}. "${similarPath}"`);
          });
          if (similarPaths.length > 5) {
            console.log(`     ... and ${similarPaths.length - 5} more`);
          }
        } else {
          console.log(`   No similar paths found in fileInfos`);
        }
        continue;
      }
      
      filesMatched++;
      console.log(`\n✓ Processing file "${filePath}"`);
      console.log(`  File found in fileInfos: ✓`);
      console.log(`  LLM requested ${elements.length} element(s):`, elements);
      
      const availableElementNames = fileInfo.elements.map(el => el.name);
      const availableElementsFormatted = fileInfo.elements.map(el => `${el.name} (${el.type})`);
      console.log(`  Available elements in file (${fileInfo.elements.length} total):`, availableElementsFormatted.join(', ') || '(none)');

      const elementSelections = elements.map((elementName) => {
        totalElementsRequested++;
        
        // ========== DIAGNOSTIC LOGGING: Element Name Matching ==========
        const element = fileInfo.elements.find((el) => el.name === elementName);
        
        if (!element) {
          console.log(`\n  ✗ Element NOT FOUND: "${elementName}"`);
          console.log(`     Requested element name format: type=${typeof elementName}, length=${elementName.length}, has whitespace=${/\s/.test(elementName)}`);
          
          // Check for case sensitivity issues
          const caseInsensitiveMatch = fileInfo.elements.find((el) => 
            el.name.toLowerCase() === elementName.toLowerCase()
          );
          if (caseInsensitiveMatch) {
            console.log(`     ⚠️  Found case-insensitive match: "${caseInsensitiveMatch.name}" (actual case)`);
          }
          
          // Check for partial matches (e.g., "class: SamuraiAgent" vs "SamuraiAgent")
          const normalizedRequested = elementName.trim().toLowerCase();
          const possibleMatches = fileInfo.elements.filter((el) => {
            const normalizedAvailable = el.name.toLowerCase();
            return normalizedAvailable.includes(normalizedRequested) || 
                   normalizedRequested.includes(normalizedAvailable);
          });
          if (possibleMatches.length > 0) {
            console.log(`     ⚠️  Found ${possibleMatches.length} partial/substring match(es):`);
            possibleMatches.slice(0, 3).forEach(match => {
              console.log(`       - "${match.name}" (${match.type})`);
            });
          }
          
          // Check for qualified name issues (e.g., "SamuraiAgent.handleDebugging" vs "handleDebugging")
          const parts = elementName.split('.');
          if (parts.length > 1) {
            const lastPart = parts[parts.length - 1];
            const qualifiedMatch = fileInfo.elements.find((el) => el.name === lastPart);
            if (qualifiedMatch) {
              console.log(`     ⚠️  Found match after removing qualifier: "${lastPart}" (removed "${parts.slice(0, -1).join('.')}.")`);
            }
          }
          
          // Store mismatch for summary
          if (elementMismatches.length < 10) { // Limit to avoid log spam
            elementMismatches.push({
              filePath,
              requested: elementName,
              available: availableElementNames
            });
          }
        } else {
          totalElementsFound++;
          console.log(`  ✓ Element FOUND: "${elementName}" -> type: ${element.type}`);
        }
        
        const result = {
          name: elementName,
          type: element?.type || "unknown",
        };
        return result;
      });

      result.set(filePath, elementSelections);
      }

    // ========== DIAGNOSTIC LOGGING: Summary Statistics ==========
    console.log("\n=== ELEMENT IDENTIFICATION SUMMARY ===");
    console.log(`Files:`);
    console.log(`  ✓ Matched: ${filesMatched}`);
    console.log(`  ✗ Not Found: ${filesNotFound}`);
    console.log(`  Total requested: ${llmReturnedPaths.length}`);
    console.log(`Elements:`);
    console.log(`  ✓ Found: ${totalElementsFound}`);
    console.log(`  ✗ Not Found: ${totalElementsRequested - totalElementsFound}`);
    console.log(`  Total requested: ${totalElementsRequested}`);
    console.log(`  Success rate: ${totalElementsRequested > 0 ? ((totalElementsFound / totalElementsRequested) * 100).toFixed(1) : 0}%`);
    
    if (elementMismatches.length > 0) {
      console.log(`\nSample Element Mismatches (showing ${elementMismatches.length} of potentially more):`);
      elementMismatches.forEach((mismatch, index) => {
        console.log(`\n  ${index + 1}. File: "${mismatch.filePath}"`);
        console.log(`     Requested: "${mismatch.requested}"`);
        console.log(`     Available (${mismatch.available.length}): ${mismatch.available.slice(0, 10).map(n => `"${n}"`).join(', ')}${mismatch.available.length > 10 ? ` ... and ${mismatch.available.length - 10} more` : ''}`);
        
        // Show if it's a format issue (e.g., "class: X" vs "X")
        if (mismatch.requested.includes(':') || mismatch.requested.includes(' ')) {
          console.log(`     ⚠️  Requested name contains ':' or space - might be formatted as "type: name"`);
        }
        
        // Show if it's a qualified name
        if (mismatch.requested.includes('.')) {
          console.log(`     ⚠️  Requested name contains '.' - might be a qualified name like "Class.method"`);
        }
      });
    }
    console.log("=== END SUMMARY ===\n");

    console.log("=== LLM CODE ELEMENT IDENTIFICATION DEBUG END (SUCCESS) ===");
    return result;
    
  }

  private async buildStructuredCodeContextSnippets(
    fileInfos: Map<string, FileInfo>,
    relevantElementSelections: Map<string, Array<{ name: string; type: string; }>>,
    globalTokenLimit: number = GLOBAL_CONTEXT_TOKEN_LIMIT,
    pinnedFilePaths: string[] = [],
  ): Promise<Array<{ path: string; elements: CodeElement[]; snippet: string; }>> {
    const results: Array<{ path: string; elements: CodeElement[]; snippet: string; }> = [];
    let totalTokenCount = 0;

    // First, process pinned files (priority)
    console.log(`[Context File Pinning] Building snippets with ${pinnedFilePaths.length} pinned files`);
    
    for (const pinnedPath of pinnedFilePaths) {
      const fileInfo = fileInfos.get(pinnedPath);
      if (!fileInfo) {
        console.warn(`[Context File Pinning] Pinned file not found in fileInfos: ${pinnedPath}`);
        continue;
      }

      // Include ALL elements from pinned files
      const allElements = fileInfo.elements;
      if (allElements.length === 0) {
        console.warn(`[Context File Pinning] Pinned file has no elements: ${pinnedPath}`);
        continue;
      }
      
      const snippet = this.buildFileSnippet(fileInfo, allElements);
      const tokenCount = snippet.length;

      results.push({
        path: pinnedPath,
        elements: allElements,
        snippet: snippet,
      });
      
      totalTokenCount += tokenCount;
      console.log(`[Context File Pinning] Added pinned file: ${pinnedPath} (${tokenCount} tokens, ${allElements.length} elements)`);
    }
    
    console.log(`[Context File Pinning] Total tokens from pinned files: ${totalTokenCount}`);

    // Then process auto-extracted files (regular priority)
    // Filter out already-pinned files to avoid duplicates
    const orderedFilePaths = Array.from(relevantElementSelections.keys())
      .filter(path => !pinnedFilePaths.includes(path));

    for (const filePath of orderedFilePaths) {
      const fileInfo = fileInfos.get(filePath);
      if (!fileInfo) {
        continue;
      }

      const relevantElements = relevantElementSelections.get(filePath) || [];
      if (relevantElements.length === 0) {
        continue;
      }

      // Find matching elements from the file info
      const selectedElements: CodeElement[] = [];
      for (const relevantElement of relevantElements) {
        // Skip if name is undefined or null
        if (!relevantElement.name) {
          console.warn(`Element with undefined name in file ${filePath}`);
          continue;
        }

        // First try exact match (name and type)
        let matchingElement = fileInfo.elements.find(
          element => element.name === relevantElement.name && element.type === relevantElement.type
        );
        
        // If exact match fails, try name-only match (LLM might return "unknown" type)
        if (!matchingElement) {
          matchingElement = fileInfo.elements.find(
            element => element.name === relevantElement.name
          );
        }
        
        // If still no match, try fuzzy matching for common variations
        if (!matchingElement) {
          const normalizedName = relevantElement.name.toLowerCase().replace(/[^a-z0-9]/g, '');
          matchingElement = fileInfo.elements.find(
            element => {
              if (!element.name) return false;
              const elementNormalizedName = element.name.toLowerCase().replace(/[^a-z0-9]/g, '');
              return elementNormalizedName === normalizedName;
            }
          );
        }
        
        if (matchingElement) {
          selectedElements.push(matchingElement);
        } else {
          console.warn(`Element ${relevantElement.name} (${relevantElement.type}) not found in file ${filePath}. Available elements:`, 
            fileInfo.elements.map(el => `${el.name} (${el.type})`).join(', '));
        }
      }

      if (selectedElements.length === 0) {
        // If no specific elements were found, include all elements from the file as fallback
        console.log(`No specific elements found for ${filePath}, including all elements as fallback`);
        const allElements = fileInfo.elements.slice(0, 5); // Limit to first 10 elements to avoid overwhelming
        if (allElements.length > 0) {
          selectedElements.push(...allElements);
        } else {
          continue;
        }
      }

      // Build the snippet for this file
      const snippetParts: string[] = [];
      let fileTokenCount = 0;
      let includedElements: CodeElement[] = [];

      for (const element of selectedElements) {
        if (!element.codeSnippet) {
          continue;
        }

        const comment = this.getCommentForElementType(element.type);
        const elementSnippet = `${comment} ${element.name}\n${element.codeSnippet}`;
        const elementTokenCount = elementSnippet.length;

        // Check if adding this element would exceed the global limit
        if (totalTokenCount + fileTokenCount + elementTokenCount > globalTokenLimit) {
          // If this is the first element and it would exceed the limit, truncate it
          if (includedElements.length === 0) {
            const remainingTokens = globalTokenLimit - totalTokenCount;
            if (remainingTokens > 50) { // Only include if we have meaningful space
              const truncatedSnippet = this.truncateElementSnippet(elementSnippet, remainingTokens - 20); // -20 for truncation indicator
              snippetParts.push(`${truncatedSnippet}\n... (truncated) ...`);
              includedElements.push(element);
              totalTokenCount = globalTokenLimit; // We've reached the limit
            }
          }
          // Stop processing this file and all subsequent files
          break;
        }

        snippetParts.push(elementSnippet);
        includedElements.push(element);
        fileTokenCount += elementTokenCount;
      }

      if (snippetParts.length === 0) {
        continue;
      }

      const combinedSnippet = snippetParts.join('\n\n');
      totalTokenCount += combinedSnippet.length;

      results.push({
        path: filePath,
        elements: includedElements,
        snippet: combinedSnippet,
      });

      // If we've reached the global limit, stop processing more files
      if (totalTokenCount >= globalTokenLimit) {
        break;
      }
    }

    return results;
  }

  /**
   * Builds a complete file snippet from FileInfo and elements
   * @param fileInfo - File information
   * @param elements - Code elements to include
   * @returns Formatted snippet string
   */
  private buildFileSnippet(fileInfo: FileInfo, elements: CodeElement[]): string {
    const snippetParts: string[] = [];
    
    for (const element of elements) {
      if (!element.codeSnippet) continue;
      const comment = this.getCommentForElementType(element.type);
      snippetParts.push(`${comment} ${element.name}\n${element.codeSnippet}`);
    }
    
    return snippetParts.join('\n\n');
  }

  private truncateElementSnippet(
    elementSnippet: string,
    maxLength: number
  ): string {
    if (elementSnippet.length <= maxLength) {
      return elementSnippet;
    }

    // Truncate the element snippet to fit within the limit
    return elementSnippet.substring(0, maxLength);
  }

  private truncateSnippetToMaxLength(
    snippet: string,
    elements: CodeElement[],
    maxLength: number
  ): { snippet: string; elements: CodeElement[] } {
    if (snippet.length <= maxLength) {
      return { snippet, elements };
    }

    // Try to truncate by removing whole elements from the end
    let truncatedSnippet = snippet;
    let truncatedElements = [...elements];
    
    while (truncatedSnippet.length > maxLength && truncatedElements.length > 1) {
      // Remove the last element and its corresponding snippet part
      const removedElement = truncatedElements.pop();
      if (removedElement) {
        const comment = this.getCommentForElementType(removedElement.type);
        const elementSnippet = `${comment} ${removedElement.name}\n${removedElement.codeSnippet || ''}`;
        
        // Remove the element snippet from the end
        const lastIndex = truncatedSnippet.lastIndexOf(elementSnippet);
        if (lastIndex !== -1) {
          truncatedSnippet = truncatedSnippet.substring(0, lastIndex).replace(/\n\n$/, '');
        }
      }
    }

    // If still too long, truncate the last element's content
    if (truncatedSnippet.length > maxLength && truncatedElements.length > 0) {
      const lastElement = truncatedElements[truncatedElements.length - 1];
      const comment = this.getCommentForElementType(lastElement.type);
      const elementSnippet = `${comment} ${lastElement.name}\n${lastElement.codeSnippet || ''}`;
      
      const lastIndex = truncatedSnippet.lastIndexOf(elementSnippet);
      if (lastIndex !== -1) {
        const beforeElement = truncatedSnippet.substring(0, lastIndex);
        const remainingLength = maxLength - beforeElement.length - comment.length - lastElement.name.length - 2; // -2 for newlines
        
        if (remainingLength > 0 && lastElement.codeSnippet) {
          const truncatedElementSnippet = lastElement.codeSnippet.substring(0, remainingLength - 20); // -20 for truncation indicator
          truncatedSnippet = `${beforeElement}${comment} ${lastElement.name}\n${truncatedElementSnippet}\n... (truncated) ...`;
        } else {
          truncatedSnippet = beforeElement;
        }
      }
    }

    return { snippet: truncatedSnippet, elements: truncatedElements };
  }

  private getCommentForElementType(type: string): string {
    switch (type) {
      case 'function':
      case 'method':
        return '// Function:';
      case 'class':
        return '// Class:';
      case 'interface':
        return '// Interface:';
      case 'variable':
        return '// Variable:';
      case 'arrow_function':
        return '// Arrow Function:';
      case 'struct':
        return '// Struct:';
      case 'enum':
        return '// Enum:';
      case 'import':
        return '// Import:';
      case 'export':
        return '// Export:';
      default:
        return '// Element:';
    }
  }


  private async readFileSafe(filePath: string): Promise<string | undefined> {
    try {
      const uri = filePath.startsWith("file:")
        ? vscode.Uri.parse(filePath)
        : vscode.Uri.file(filePath);
      const data = await vscode.workspace.fs.readFile(uri);
      return new TextDecoder("utf-8").decode(data);
    } catch (error) {
      console.warn(`Failed to read file ${filePath}:`, error);
      
      return undefined;
    }
  }

  /**
   * Resolve import path to absolute file path
   * Returns null for node_modules or unresolvable imports
   */
  private async resolveImportPath(
    importStatement: string,
    currentFilePath: string,
    workspaceRoot: string
  ): Promise<string | null> {
    // Skip external packages (node_modules)
    if (!importStatement.startsWith('.') && !importStatement.startsWith('/')) {
      return null;
    }
    
    const currentDir = path.dirname(currentFilePath);
    let candidatePath: string;
    
    if (importStatement.startsWith('.')) {
      // Relative import: ./utils or ../helpers
      candidatePath = path.resolve(currentDir, importStatement);
    } else {
      // Absolute import from workspace root: /src/utils
      candidatePath = path.join(workspaceRoot, importStatement);
    }
    
    // Try common extensions
    const extensions = ['.ts', '.tsx', '.js', '.jsx', '.py', '.java', '.cpp', '.go'];
    
    for (const ext of extensions) {
      const withExt = candidatePath + ext;
      try {
        await vscode.workspace.fs.stat(vscode.Uri.file(withExt));
        return withExt;
      } catch {
        // File doesn't exist, try next
      }
    }
    
    // Try index files for directory imports
    const indexPatterns = ['index.ts', 'index.tsx', 'index.js', '__init__.py'];
    for (const indexFile of indexPatterns) {
      const indexPath = path.join(candidatePath, indexFile);
      try {
        await vscode.workspace.fs.stat(vscode.Uri.file(indexPath));
        return indexPath;
      } catch {
        // Continue
      }
    }
    
    return null;
  }

  /**
   * Recursively resolve and fetch missing dependencies
   * Protection against infinite recursion:
   * 1. Visited set tracks all processed files
   * 2. Max depth limits recursion levels
   * 3. Only follows local imports (skips node_modules)
   */
  private async resolveMissingDependencies(
    llmSuggestedFiles: Map<string, Array<{name: string; type: string}>>,
    existingFileInfos: Map<string, FileInfo>,
    workspaceRoot: string,
    maxDepth: number = 3
  ): Promise<Map<string, FileInfo>> {
    
    const allFileInfos = new Map(existingFileInfos);
    const visited = new Set<string>(existingFileInfos.keys()); // Track all seen files
    const circularDeps = new Map<string, string[]>(); // Track circular dependencies
    
    console.log('[Dependency Resolver] Starting with', existingFileInfos.size, 'files');
    
    // Find files suggested by LLM but missing from initial scan
    const missingFiles = new Set<string>();
    for (const [filePath] of llmSuggestedFiles.entries()) {
      if (!existingFileInfos.has(filePath)) {
        missingFiles.add(filePath);
        console.log('[Dependency Resolver] LLM suggested missing file:', filePath);
      }
    }
    
    if (missingFiles.size === 0) {
      console.log('[Dependency Resolver] No missing files to resolve');
      return allFileInfos;
    }
    
    // Process files level by level
    let currentLevel = Array.from(missingFiles);
    let currentDepth = 0;
    
    while (currentLevel.length > 0 && currentDepth < maxDepth) {
      console.log(`[Dependency Resolver] Processing level ${currentDepth} with ${currentLevel.length} files`);
      const nextLevel: string[] = [];
      
      for (const filePath of currentLevel) {
        // Skip if already visited (prevents infinite loops)
        if (visited.has(filePath)) {
          console.log('[Dependency Resolver] Skipping already visited:', filePath);
          continue;
        }
        
        visited.add(filePath);
        
        try {
          // Check if file exists
          const uri = vscode.Uri.file(filePath);
          await vscode.workspace.fs.stat(uri);
          
          // Parse the file
          const language = this.codeParser.detectLanguage(filePath);
          if (!language) {
            console.log('[Dependency Resolver] Unknown language for:', filePath);
            continue;
          }
          
          const elements = await this.codeParser.extractElementsFromFile(filePath, language);
          const fileContent = await this.readFileSafe(filePath);
          
          if (!fileContent) {
            console.log('[Dependency Resolver] Could not read file:', filePath);
            continue;
          }
          
          // Extract imports from this file
          const imports = this.codeParser.extractImportsFromContent(fileContent, language);
          console.log(`[Dependency Resolver] Found ${imports.length} imports in ${filePath}`);
          
          // Resolve each import to absolute path
          const resolvedImports: string[] = [];
          for (const importPath of imports) {
            const resolved = await this.resolveImportPath(importPath, filePath, workspaceRoot);
            if (resolved) {
              resolvedImports.push(resolved);
              
              // Check for circular dependency
              if (visited.has(resolved)) {
                if (!circularDeps.has(filePath)) {
                  circularDeps.set(filePath, []);
                }
                circularDeps.get(filePath)!.push(resolved);
                console.log('[Dependency Resolver] Circular dependency detected:', filePath, '->', resolved);
              } else if (!allFileInfos.has(resolved)) {
                // New file to process in next level
                nextLevel.push(resolved);
              }
            }
          }
          
          // Add file to results
          const stat = await vscode.workspace.fs.stat(uri);
          allFileInfos.set(filePath, {
            path: filePath,
            name: path.basename(filePath),
            extension: path.extname(filePath),
            language,
            size: stat.size,
            elements,
            lastModified: new Date(stat.mtime),
          });
          
          console.log(`[Dependency Resolver] Added ${filePath} with ${elements.length} elements`);
          
        } catch (error) {
          console.warn(`[Dependency Resolver] Error processing ${filePath}:`, error);
          // Continue with other files
        }
      }
      
      currentLevel = nextLevel;
      currentDepth++;
    }
    
    if (currentLevel.length > 0) {
      console.log(`[Dependency Resolver] Stopped at max depth ${maxDepth}. Remaining files:`, currentLevel.length);
    }
    
    if (circularDeps.size > 0) {
      console.log('[Dependency Resolver] Circular dependencies found:', 
        Array.from(circularDeps.entries()).map(([file, deps]) => `${file} -> ${deps.join(', ')}`));
    }
    
    console.log(`[Dependency Resolver] Completed. Total files: ${allFileInfos.size} (added ${allFileInfos.size - existingFileInfos.size})`);
    
    return allFileInfos;
  }

  /**
   * Processes manually pinned files to include in code context unconditionally
   * @param pinnedPaths - Array of absolute file paths to pin
   * @param workspaceRoot - Workspace root path
   * @returns Map of file paths to FileInfo objects for pinned files
   */
  private async processPinnedFiles(
    pinnedPaths: string[],
    workspaceRoot: string
  ): Promise<Map<string, FileInfo>> {
    const pinnedFileInfos = new Map<string, FileInfo>();
    
    if (!pinnedPaths || pinnedPaths.length === 0) {
      return pinnedFileInfos;
    }
    
    console.log(`[Context File Pinning] Processing ${pinnedPaths.length} pinned files`);
    
    for (const filePath of pinnedPaths) {
      try {
        const content = await this.readFileSafe(filePath);
        if (!content) {
          console.warn(`[Context File Pinning] Could not read file: ${filePath}`);
          continue;
        }
        
        const language = this.codeParser.detectLanguage(filePath) || 'unknown';
        const elements = await this.codeParser.extractElementsFromFile(filePath, language);
        
        // Get file stats
        const uri = vscode.Uri.file(filePath);
        const stat = await vscode.workspace.fs.stat(uri);
        
        const fileInfo: FileInfo = {
          path: filePath,
          name: filePath.split('/').pop() || filePath,
          extension: filePath.split('.').pop() || '',
          language: language,
          size: stat.size,
          elements: elements,
          lastModified: new Date(stat.mtime),
        };
        
        pinnedFileInfos.set(filePath, fileInfo);
        console.log(`[Context File Pinning] Processed file: ${filePath} (${elements.length} elements)`);
      } catch (error) {
        console.error(`[Context File Pinning] Failed to process pinned file ${filePath}:`, error);
      }
    }
    
    console.log(`[Context File Pinning] Successfully processed ${pinnedFileInfos.size} pinned files`);
    return pinnedFileInfos;
  }

  private async loadPrompt(relativePath: string): Promise<string> {
    return this.codeParser.loadPrompt(relativePath);
  }

  /**
   * Builds recently opened files context (HYBRID APPROACH)
   * Priority: 1) Currently open tabs, 2) Recently closed files
   * Workspace-aware: Only includes files from current workspace
   * 
   * @param maxFiles - Maximum number of files to include
   * @param workspaceRoot - Workspace root to filter files by
   * @returns Formatted markdown string with recently opened files
   */
  private buildRecentlyOpenedFilesContext(maxFiles: number, workspaceRoot: string): string {
    const recentFiles = RecentFilesTracker.getInstance().getRecentlyOpenedFilePaths(maxFiles, workspaceRoot);
    
    if (recentFiles.length === 0) {
      return "## Recently Opened Files\n\nNo recently opened files in current workspace.";
    }

    const fileList = recentFiles.map(filePath => `- ${filePath}`).join('\n');
    return `## Recently Opened Files (top ${recentFiles.length})\n\n${fileList}`;
  }

  /**
   * Builds a high-level folder structure context from file paths (2 levels deep)
   * to help LLM disambiguate between similar code in different project sections
   * @param fileInfos - Map of file paths to FileInfo objects
   * @returns Formatted markdown string with folder structure and auto-generated descriptions
   */
  private buildFolderStructureContext(fileInfos: Map<string, FileInfo>): string {
    // Extract unique 2-level folder paths
    const folderSet = new Set<string>();
    
    for (const filePath of fileInfos.keys()) {
      const parts = filePath.split('/');
      if (parts.length >= 2) {
        // Get first two levels (e.g., "vscode/samurai-agent" from "vscode/samurai-agent/src/...")
        const twoLevelPath = `${parts[0]}/${parts[1]}`;
        folderSet.add(twoLevelPath);
      } else if (parts.length === 1) {
        // Single level folder
        folderSet.add(parts[0]);
      }
    }

    // Sort folders alphabetically for consistent output
    const folders = Array.from(folderSet).sort();

    // Generate descriptions for each folder based on common naming patterns
    const folderDescriptions = folders.map(folder => {
      const description = this.generateFolderDescription(folder);
      return `- ${folder}/ - ${description}`;
    });

    if (folderDescriptions.length === 0) {
      return "## Project Structure\n\nNo folder structure detected.";
    }

    return `## Project Structure (2 levels)\n\n${folderDescriptions.join('\n')}`;
  }

  /**
   * Auto-generates human-readable descriptions for folder paths based on common patterns
   * @param folderPath - 2-level folder path (e.g., "vscode/samurai-agent")
   * @returns Human-readable description
   */
  private generateFolderDescription(folderPath: string): string {
    const lowerPath = folderPath.toLowerCase();
    
    // Check common patterns
    if (lowerPath.includes('vscode') || lowerPath.includes('vs-code')) {
      return 'VS Code Extension implementation';
    }
    if (lowerPath.includes('frontend') || lowerPath.includes('client')) {
      return 'Web Frontend application';
    }
    if (lowerPath.includes('backend') || lowerPath.includes('server')) {
      return 'Backend API/Services';
    }
    if (lowerPath.includes('integration-test') || lowerPath.includes('e2e')) {
      return 'Integration/E2E test suite';
    }
    if (lowerPath.includes('test') || lowerPath.includes('spec')) {
      return 'Test files';
    }
    if (lowerPath.includes('doc') || lowerPath.includes('documentation')) {
      return 'Documentation';
    }
    if (lowerPath.includes('script') || lowerPath.includes('scripts')) {
      return 'Build/utility scripts';
    }
    if (lowerPath.includes('config') || lowerPath.includes('configuration')) {
      return 'Configuration files';
    }
    if (lowerPath.includes('util') || lowerPath.includes('helper')) {
      return 'Utility/helper functions';
    }
    if (lowerPath.includes('component')) {
      return 'UI Components';
    }
    if (lowerPath.includes('service')) {
      return 'Service layer';
    }
    if (lowerPath.includes('model') || lowerPath.includes('entity')) {
      return 'Data models/entities';
    }
    if (lowerPath.includes('api')) {
      return 'API endpoints/routes';
    }
    if (lowerPath.includes('lib') || lowerPath.includes('library')) {
      return 'Shared library code';
    }
    if (lowerPath.includes('core')) {
      return 'Core functionality';
    }
    if (lowerPath.includes('common') || lowerPath.includes('shared')) {
      return 'Shared/common code';
    }
    
    // Default: capitalize and clean up the folder name
    const parts = folderPath.split('/');
    const lastPart = parts[parts.length - 1];
    const cleaned = lastPart.replace(/[-_]/g, ' ');
    return cleaned.charAt(0).toUpperCase() + cleaned.slice(1);
  }

  private fallbackToFileRanking(
    fileInfos: Map<string, FileInfo>,
    query: string,
  ): Map<string, Array<{ name: string; type: string; }>> {
    // Fallback: select first few files and all their elements
    const result = new Map<string, Array<{ name: string; type: string; }>>();
    const filePaths = Array.from(fileInfos.keys()).slice(0, DEFAULT_MAX_RESULTS);
    
    console.log(`Using fallback ranking for query: ${query}`);
    
    for (const filePath of filePaths) {
      const fileInfo = fileInfos.get(filePath);
      if (fileInfo && fileInfo.elements.length > 0) {
        const elements = fileInfo.elements.map(element => ({
          name: element.name,
          type: element.type
        }));
        result.set(filePath, elements);
        console.log(`Fallback: Added ${elements.length} elements from ${filePath}`);
      }
    }
    
    console.log(`Fallback ranking complete: ${result.size} files selected`);
    return result;
  }

  private heuristicFallbackSelections(
    fileInfos: Map<string, FileInfo>,
    query: string,
  ): Map<string, Array<{ name: string; type: string }>> {
    const keywords = query.toLowerCase();
    const matches: Array<{ path: string; elements: Array<{ name: string; type: string }> }> = [];

    const candidatePatterns = [
      /cost/i,
      /llm/i,
      /consumption/i,
      /tracking/i,
      /usage/i,
      /pricing/i,
    ];

    for (const [filePath, info] of fileInfos.entries()) {
      // Skip if name is undefined or null
      if (!info.name) {
        continue;
      }

      const haystack = `${info.name} ${filePath}`.toLowerCase();
      if (
        candidatePatterns.some((pattern) => pattern.test(haystack)) ||
        candidatePatterns.some((pattern) =>
          info.elements.some((el) => el.name && pattern.test(el.name)),
        )
      ) {
        matches.push({
          path: filePath,
          elements: info.elements.slice(0, 5).map((el) => ({
            name: el.name,
            type: el.type,
          })),
        });
      }
    }

    if (!matches.length && keywords.includes("cost")) {
      const largestFiles = Array.from(fileInfos.values())
        .sort((a, b) => b.size - a.size)
        .slice(0, 3);

      for (const file of largestFiles) {
        matches.push({
          path: file.path,
          elements: file.elements.slice(0, 5).map((el) => ({
            name: el.name,
            type: el.type,
          })),
        });
      }
    }

    const result = new Map<string, Array<{ name: string; type: string }>>();
    for (const match of matches) {
      if (match.elements.length) {
        result.set(match.path, match.elements);
      }
    }

    return result;
  }

  /**
   * Performs keyword-based search across filenames, method names, and file contents
   * @param fileInfos - Map of file paths to FileInfo objects
   * @param params - Normalized extract code parameters containing keyword arrays
   * @returns Map of file paths to arrays of matching elements
   */
  private async performKeywordBasedSearch(
    fileInfos: Map<string, FileInfo>,
    params: NormalizedExtractCodeParameters,
  ): Promise<Map<string, Array<{ name: string; type: string; }>>> {
    const result = new Map<string, Array<{ name: string; type: string; }>>();
    
    // Skip if no keywords provided
    if (params.filenameKeywords.length === 0 && 
        params.methodNameKeywords.length === 0 && 
        params.codeKeywords.length === 0) {
      return result;
    }

    console.log("ExtractCodeTool: Performing keyword-based search", {
      filenameKeywords: params.filenameKeywords,
      methodNameKeywords: params.methodNameKeywords,
      codeKeywords: params.codeKeywords,
      fileCount: fileInfos.size
    });

    // Step 1: Filename keyword matching
    const filenameMatches = this.searchByFilenameKeywords(fileInfos, params.filenameKeywords);
    
    // Step 2: Method name keyword matching
    const methodNameMatches = this.searchByMethodNameKeywords(fileInfos, params.methodNameKeywords);
    
    // Step 3: Code content keyword matching
    const codeContentMatches = await this.searchByCodeKeywords(fileInfos, params.codeKeywords);
    
    // Step 4: Consolidate all matches
    this.consolidateKeywordMatches(result, filenameMatches, methodNameMatches, codeContentMatches);
    
    // Step 5: Apply global limit of 20 distinct files/elements
    this.applyGlobalLimit(result);
    
    console.log("ExtractCodeTool: Keyword search completed", {
      totalMatches: result.size,
      matches: Array.from(result.entries()).map(([path, elements]) => ({
        path,
        elementCount: elements.length,
        elements: elements.map(el => `${el.name} (${el.type})`)
      }))
    });
    
    return result;
  }

  /**
   * Batch version of keyword-based search that processes multiple queries/symbols/error tokens at once
   * with per-token attribution for ranking and explainability.
   * 
   * This method eliminates redundant file scans by processing all tokens in a single pass,
   * while preserving the ability to score files based on which specific tokens matched.
   * 
   * @param fileInfos - Map of file paths to FileInfo objects
   * @param batchParams - Object containing arrays of queries, symbols, and error tokens
   * @returns Map of file paths to arrays of matches with token attribution
   */
  public async performKeywordBasedSearchBatch(
    fileInfos: Map<string, FileInfo>,
    batchParams: {
      queries: string[];
      symbols: string[];
      errorTokens: string[];
      filenameKeywords?: string[];
      options?: {
        caseSensitive?: boolean;
        maxResultsPerFile?: number;
      };
    }
  ): Promise<Map<string, Array<{ token: string; kind: 'query' | 'symbol' | 'error'; elements: Array<{ name: string; type: string }> }>>> {
    const result = new Map<string, Array<{ token: string; kind: 'query' | 'symbol' | 'error'; elements: Array<{ name: string; type: string }> }>>();
    
    // Normalize and deduplicate tokens
    const normalizeToken = (token: string): string => {
      return (batchParams.options?.caseSensitive ? token : token.toLowerCase()).trim();
    };
    
    const queryTokens = [...new Set(batchParams.queries.map(normalizeToken))].filter(t => t.length > 0);
    const symbolTokens = [...new Set(batchParams.symbols.map(normalizeToken))].filter(t => t.length > 0);
    const errorTokens = [...new Set(batchParams.errorTokens.map(normalizeToken))].filter(t => t.length > 0);
    const filenameKeywords = batchParams.filenameKeywords ? [...new Set(batchParams.filenameKeywords.map(normalizeToken))].filter(t => t.length > 0) : [];
    
    const totalTokens = queryTokens.length + symbolTokens.length + errorTokens.length + filenameKeywords.length;
    
    // Skip if no keywords provided
    if (totalTokens === 0) {
      return result;
    }

    // Single log instead of multiple logs
    console.log("ExtractCodeTool: Performing batched keyword-based search", {
      queryCount: queryTokens.length,
      symbolCount: symbolTokens.length,
      errorTokenCount: errorTokens.length,
      filenameKeywordCount: filenameKeywords.length,
      totalTokens,
      fileCount: fileInfos.size
    });

    // Build token-to-kind mapping for attribution
    const tokenKindMap = new Map<string, 'query' | 'symbol' | 'error'>();
    queryTokens.forEach(t => tokenKindMap.set(t, 'query'));
    symbolTokens.forEach(t => tokenKindMap.set(t, 'symbol'));
    errorTokens.forEach(t => tokenKindMap.set(t, 'error'));

    // Process filename matches first (these match entire files)
    if (filenameKeywords.length > 0) {
      const filenameMatches = this.searchByFilenameKeywords(fileInfos, filenameKeywords);
      for (const [filePath, elements] of filenameMatches.entries()) {
        // For filename matches, attribute to all filename keywords that matched
        const fileName = fileInfos.get(filePath)?.name?.toLowerCase() || '';
        const matchedTokens: string[] = [];
        for (const keyword of filenameKeywords) {
          const normalizedKeyword = normalizeToken(keyword);
          if (fileName.includes(normalizedKeyword)) {
            matchedTokens.push(keyword);
          }
        }
        
        for (const token of matchedTokens) {
          const existing = result.get(filePath) || [];
          existing.push({
            token,
            kind: 'query', // Treat filename matches as queries for scoring
            elements
          });
          result.set(filePath, existing);
        }
      }
    }

    // Process method name matches (symbols) - track per-token
    if (symbolTokens.length > 0) {
      // We need to track which symbols matched which elements
      for (const [filePath, fileInfo] of fileInfos.entries()) {
        for (const element of fileInfo.elements) {
          if (!element.name) continue;
          
          const elementName = (batchParams.options?.caseSensitive ? element.name : element.name.toLowerCase());
          
          for (const symbol of symbolTokens) {
            const normalizedSymbol = normalizeToken(symbol);
            if (elementName.includes(normalizedSymbol)) {
              const existing = result.get(filePath) || [];
              // Check if we already have this token for this file
              let tokenEntry = existing.find(e => e.token === symbol && e.kind === 'symbol');
              if (tokenEntry) {
                // Add element if not already present
                if (!tokenEntry.elements.some(el => el.name === element.name && el.type === element.type)) {
                  tokenEntry.elements.push({ name: element.name, type: element.type });
                }
              } else {
                existing.push({
                  token: symbol,
                  kind: 'symbol',
                  elements: [{ name: element.name, type: element.type }]
                });
                result.set(filePath, existing);
              }
            }
          }
        }
      }
    }

    // Process code content matches (queries and error tokens) - track per-token
    const allCodeKeywords = [...queryTokens, ...errorTokens];
    if (allCodeKeywords.length > 0) {
      // Chunk handling: if token count exceeds threshold, process in chunks
      const CHUNK_SIZE = 200;
      const chunks: string[][] = [];
      if (allCodeKeywords.length > CHUNK_SIZE) {
        console.log(`ExtractCodeTool: Large token set (${allCodeKeywords.length}), processing in chunks of ${CHUNK_SIZE}`);
        for (let i = 0; i < allCodeKeywords.length; i += CHUNK_SIZE) {
          chunks.push(allCodeKeywords.slice(i, i + CHUNK_SIZE));
        }
      } else {
        chunks.push(allCodeKeywords);
      }

      for (const chunk of chunks) {
        // For each file, check which tokens in this chunk match
        for (const [filePath, fileInfo] of fileInfos.entries()) {
          try {
            const fileContent = await this.readFileSafe(filePath);
            if (!fileContent) continue;
            
            const content = (batchParams.options?.caseSensitive ? fileContent : fileContent.toLowerCase());
            
            for (const token of chunk) {
              const normalizedToken = normalizeToken(token);
              const kind = tokenKindMap.get(token) || 'query';
              
              if (content.includes(normalizedToken)) {
                // Try to find specific elements related to the match
                const matchingElements = this.findElementsRelatedToCodeMatch(fileInfo, [token], fileContent);
                const elementsToAdd = matchingElements.length > 0 
                  ? matchingElements 
                  : fileInfo.elements.slice(0, 10).map(element => ({
                      name: element.name,
                      type: element.type
                    }));
                
                const existing = result.get(filePath) || [];
                // Check if we already have this token for this file
                let tokenEntry = existing.find(e => e.token === token && e.kind === kind);
                if (tokenEntry) {
                  // Merge elements, avoiding duplicates
                  for (const element of elementsToAdd) {
                    if (!tokenEntry.elements.some(el => el.name === element.name && el.type === element.type)) {
                      tokenEntry.elements.push(element);
                    }
                  }
                } else {
                  existing.push({
                    token,
                    kind,
                    elements: elementsToAdd
                  });
                  result.set(filePath, existing);
                }
              }
            }
          } catch (error) {
            console.warn(`Failed to process file ${filePath} in batch search:`, error);
          }
        }
      }
    }

    // Apply max results per file limit if specified
    const maxResultsPerFile = batchParams.options?.maxResultsPerFile || 20;
    for (const [filePath, matches] of result.entries()) {
      if (matches.length > maxResultsPerFile) {
        result.set(filePath, matches.slice(0, maxResultsPerFile));
      }
    }

    console.log("ExtractCodeTool: Batched keyword search completed", {
      totalMatches: result.size,
      totalTokenMatches: Array.from(result.values()).reduce((sum, matches) => sum + matches.length, 0)
    });
    
    return result;
  }

  /**
   * Searches files by filename keywords
   */
  private searchByFilenameKeywords(
    fileInfos: Map<string, FileInfo>,
    filenameKeywords: string[],
  ): Map<string, Array<{ name: string; type: string; }>> {
    const matches = new Map<string, Array<{ name: string; type: string; }>>();
    
    if (filenameKeywords.length === 0) {
      return matches;
    }

    for (const [filePath, fileInfo] of fileInfos.entries()) {
      // Skip if name is undefined or null
      if (!fileInfo.name) {
        console.warn(`File with undefined name at path ${filePath}`);
        continue;
      }

      const fileName = fileInfo.name.toLowerCase();
      
      for (const keyword of filenameKeywords) {
        if (fileName.includes(keyword.toLowerCase())) {
          // Include all elements from this file
          const elements = fileInfo.elements.map(element => ({
            name: element.name,
            type: element.type
          }));
          matches.set(filePath, elements);
          break; // Found a match, no need to check other keywords for this file
        }
      }
    }
    
    return matches;
  }

  /**
   * Searches files by method name keywords
   */
  private searchByMethodNameKeywords(
    fileInfos: Map<string, FileInfo>,
    methodNameKeywords: string[],
  ): Map<string, Array<{ name: string; type: string; }>> {
    const matches = new Map<string, Array<{ name: string; type: string; }>>();
    
    if (methodNameKeywords.length === 0) {
      return matches;
    }

    for (const [filePath, fileInfo] of fileInfos.entries()) {
      const matchingElements: Array<{ name: string; type: string; }> = [];
      
      for (const element of fileInfo.elements) {
        // Skip if name is undefined or null
        if (!element.name) {
          continue;
        }

        const elementName = element.name.toLowerCase();
        
        for (const keyword of methodNameKeywords) {
          if (elementName.includes(keyword.toLowerCase())) {
            matchingElements.push({
              name: element.name,
              type: element.type
            });
            break; // Found a match, no need to check other keywords for this element
          }
        }
      }
      
      if (matchingElements.length > 0) {
        matches.set(filePath, matchingElements);
      }
    }
    
    return matches;
  }

  /**
   * Searches files by code content keywords
   */
  private async searchByCodeKeywords(
    fileInfos: Map<string, FileInfo>,
    codeKeywords: string[],
  ): Promise<Map<string, Array<{ name: string; type: string; }>>> {
    const matches = new Map<string, Array<{ name: string; type: string; }>>();
    
    if (codeKeywords.length === 0) {
      return matches;
    }

    for (const [filePath, fileInfo] of fileInfos.entries()) {
      try {
        const fileContent = await this.readFileSafe(filePath);
        
        if (!fileContent) {
          continue;
        }
        
        const content = fileContent.toLowerCase();
        let hasMatch = false;
        
        for (const keyword of codeKeywords) {
          if (content.includes(keyword.toLowerCase())) {
            hasMatch = true;
            break;
          }
        }
        
        if (hasMatch) {
          // Try to find specific elements related to the match
          const matchingElements = this.findElementsRelatedToCodeMatch(fileInfo, codeKeywords, fileContent);
          
          if (matchingElements.length > 0) {
            matches.set(filePath, matchingElements);
          } else {
            // If no specific elements found, include up to 10 all elements from the file
            const allElements = fileInfo.elements.slice(0, 10).map(element => ({
              name: element.name,
              type: element.type
            }));
            matches.set(filePath, allElements);
          }
        }
      } catch (error) {
        console.warn(`Failed to read file ${filePath} for code keyword search:`, error);
      }
    }
    
    return matches;
  }

  /**
   * Attempts to find specific elements related to code keyword matches
   */
  private findElementsRelatedToCodeMatch(
    fileInfo: FileInfo,
    codeKeywords: string[],
    fileContent: string,
  ): Array<{ name: string; type: string; }> {
    const matchingElements: Array<{ name: string; type: string; }> = [];
    
    for (const element of fileInfo.elements) {
      // Skip if name is undefined or null
      if (!element.name) {
        continue;
      }

      const elementName = element.name.toLowerCase();
      
      // Check if element name contains any of the code keywords
      for (const keyword of codeKeywords) {
        if (elementName.includes(keyword.toLowerCase())) {
          matchingElements.push({
            name: element.name,
            type: element.type
          });
          break;
        }
      }
    }
    
    return matchingElements;
  }

  /**
   * Consolidates keyword matches from different search types
   */
  private consolidateKeywordMatches(
    result: Map<string, Array<{ name: string; type: string; }>>,
    filenameMatches: Map<string, Array<{ name: string; type: string; }>>,
    methodNameMatches: Map<string, Array<{ name: string; type: string; }>>,
    codeContentMatches: Map<string, Array<{ name: string; type: string; }>>,
  ): void {
    // Add filename matches (highest priority)
    for (const [filePath, elements] of filenameMatches.entries()) {
      result.set(filePath, elements);
    }
    
    // Add method name matches (medium priority)
    for (const [filePath, elements] of methodNameMatches.entries()) {
      if (result.has(filePath)) {
        // Merge with existing elements, avoiding duplicates
        const existingElements = result.get(filePath)!;
        const newElements = elements.filter(newEl => 
          !existingElements.some(existingEl => 
            existingEl.name === newEl.name && existingEl.type === newEl.type
          )
        );
        result.set(filePath, [...existingElements, ...newElements]);
      } else {
        result.set(filePath, elements);
      }
    }
    
    // Add code content matches (lowest priority)
    for (const [filePath, elements] of codeContentMatches.entries()) {
      if (result.has(filePath)) {
        // Merge with existing elements, avoiding duplicates
        const existingElements = result.get(filePath)!;
        const newElements = elements.filter(newEl => 
          !existingElements.some(existingEl => 
            existingEl.name === newEl.name && existingEl.type === newEl.type
          )
        );
        result.set(filePath, [...existingElements, ...newElements]);
      } else {
        result.set(filePath, elements);
      }
    }
  }

  /**
   * Applies global limit of 20 distinct files/elements with priority ordering
   */
  private applyGlobalLimit(
    result: Map<string, Array<{ name: string; type: string; }>>,
  ): void {
    const MAX_ELEMENTS = 20;
    
    if (result.size <= MAX_ELEMENTS) {
      return;
    }
    
    // Convert to array and sort by priority (filename > method name > code content)
    const entries = Array.from(result.entries());
    
    // For now, we'll just take the first MAX_ELEMENTS entries
    // In a more sophisticated implementation, we could prioritize based on match type
    const limitedEntries = entries.slice(0, MAX_ELEMENTS);
    
    result.clear();
    for (const [filePath, elements] of limitedEntries) {
      result.set(filePath, elements);
    }
  }

  /**
   * Merges keyword search results with LLM selections
   */
  private mergeKeywordAndLLMSelections(
    llmSelections: Map<string, Array<{ name: string; type: string; }>>,
    keywordSelections: Map<string, Array<{ name: string; type: string; }>>,
  ): Map<string, Array<{ name: string; type: string; }>> {
    const merged = new Map<string, Array<{ name: string; type: string; }>>();
    
    // Start with LLM selections
    for (const [filePath, elements] of llmSelections.entries()) {
      merged.set(filePath, [...elements]);
    }
    
    // Merge keyword selections
    for (const [filePath, elements] of keywordSelections.entries()) {
      if (merged.has(filePath)) {
        const existingElements = merged.get(filePath)!;
        const newElements = elements.filter(newEl => 
          newEl && // Add null check
          !existingElements.some(existingEl => 
            existingEl.name === newEl.name && existingEl.type === newEl.type
          )
        );
        
        // Merge elements, preferring specific types over "unknown"
        const mergedElements = [...existingElements];
        for (const newEl of newElements) {
          const existingIndex = mergedElements.findIndex(existingEl => 
            existingEl.name === newEl.name
          );
          
          if (existingIndex >= 0) {
            // Prefer specific type over "unknown"
            if (mergedElements[existingIndex].type === "unknown" && newEl.type !== "unknown") {
              mergedElements[existingIndex] = newEl;
            }
          } else {
            mergedElements.push(newEl);
          }
        }
        
        merged.set(filePath, mergedElements);
      } else {
        merged.set(filePath, [...elements]);
      }
    }
    
    return merged;
  }

  /**
   * Extract code for debugging scenarios with execution graph
   */
  public async extractForDebugging(input: DebuggingExtractionInput): Promise<ExtractionResponse> {
    const startTime = Date.now();
    const timings: Record<string, number> = {};
    const commitHash = input.commitHash || 'current';
    const projectId = input.projectId || 'debugging';
    const budget = createBudget(); // Create shared budget for the entire extraction
    
    // Declare variables that might be needed in catch block
    let evidence: Evidence | undefined;
    let candidates: CandidateFile[] | undefined;
    let plan: SearchPlan | undefined;
    
    try {
      console.log('[ExtractCodeTool] Starting debugging extraction');
      
      // Stage 1: Parse evidence
      const evidenceStart = Date.now();
      const evidenceParser = new EvidenceParser(input.workspace);
      evidence = evidenceParser.parseEvidence(input);
      
      // Add chatSummary to evidence if provided
      if (input.chatSummary) {
        evidence.chatSummary = input.chatSummary;
      }
      
      timings.evidence = Date.now() - evidenceStart;
      
      // Store evidence frames as snippets
      await this.storeEvidenceSnippets(evidence, projectId, commitHash);
      
      console.log('[ExtractCodeTool] Evidence parsed:', {
        frames: evidence.frames.length,
        error: evidence.error,
        route: evidence.route
      });
      
      // Detailed evidence parsing logging
      console.log('[ExtractCodeTool] Detailed evidence parsing results:', {
        frames: evidence.frames.map(frame => ({
          file: frame.file,
          line: frame.line,
          function: frame.fn,
          column: frame.column
        })),
        error: evidence.error,
        requestId: evidence.requestId,
        route: evidence.route,
        evidenceSource: evidence.evidenceSource,
        hasHardError: evidence.hasHardError,
        softSignals: evidence.softSignals?.length || 0,
        httpSpans: evidence.httpSpans?.length || 0,
        behaviorHints: evidence.behaviorHints?.length || 0,
        warnings: evidence.warnings?.length || 0,
        confidence: evidence.confidence,
        logSignatures: evidence.logSignatures?.length || 0,
        tsconfigPaths: Object.keys(evidence.tsconfigPaths || {}).length
      });
      
      // Stage 2: Generate search plan
      const planStart = Date.now();
      const searchPlanner = new SearchPlanner(this.llmProvider);
      const repoMeta = await this.buildRepoMeta(input.workspace, input.model);
      plan = await searchPlanner.makeSearchPlan(
        evidence,
        repoMeta,
        input.userMessage,
        input.model || 'gpt-4' // Use provided model or fallback
      );
      timings.plan = Date.now() - planStart;
      
      console.log('[ExtractCodeTool] Search plan generated:', {
        candidateFiles: plan.candidateFiles.length,
        symbols: plan.symbols.length,
        queries: plan.queries.length
      });
      
      // Detailed search plan logging
      console.log('[ExtractCodeTool] Detailed search plan results:', {
        candidateFiles: plan.candidateFiles.slice(0, 5),
        symbols: plan.symbols.slice(0, 10),
        queries: plan.queries.slice(0, 5),
        reasoning: plan.reasoning?.substring(0, 200) + (plan.reasoning?.length > 200 ? '...' : ''),
        mode: plan.mode,
        totalCandidateFiles: plan.candidateFiles.length,
        totalSymbols: plan.symbols.length,
        totalQueries: plan.queries.length
      });
      
      // Stage 3: Hybrid retrieval
      const retrievalStart = Date.now();
      const fileInfos = await this.scanCodebase({
        query: input.userMessage,
        projectId: 'debugging',
        connectedCodebasePath: input.workspace,
        model: input.model || 'gpt-4',
        filenameKeywords: plan.candidateFiles,
        methodNameKeywords: plan.symbols,
        codeKeywords: plan.queries,
        maxIterations: 1,
        maxDependencyDepth: 1,
        manuallyPinnedFilePaths: []
      });
      
      const hybridRetriever = new HybridRetriever(this);
      candidates = await hybridRetriever.retrieveHybrid(
        plan,
        evidence,
        fileInfos,
        input.model || 'gpt-4',
        'debugging'
      );
      timings.retrieval = Date.now() - retrievalStart;
      
      console.log('[ExtractCodeTool] Hybrid retrieval completed:', {
        candidates: candidates.length
      });
      
      // Detailed hybrid retrieval logging
      console.log('[ExtractCodeTool] Detailed hybrid retrieval results:', {
        totalCandidates: candidates.length,
        topCandidates: candidates.slice(0, 5).map(candidate => ({
          file: candidate.file,
          score: candidate.score,
          evidence: candidate.evidence,
          symbols: candidate.symbols?.slice(0, 3) || []
        })),
        evidenceTypes: candidates.reduce((acc, candidate) => {
          candidate.evidence?.forEach(evidence => {
            acc[evidence] = (acc[evidence] || 0) + 1;
          });
          return acc;
        }, {} as Record<string, number>),
        fileInfoCount: fileInfos.size,
        retrievalMethod: 'hybrid' // This is always hybrid in this context
      });
      
      // Stage 4-6: Build directed execution graph using ts-morph
      const graphStart = Date.now();
      
      // Step 1: Identify starting points (spine) from evidence and candidates
      const spine = this.buildSpineFromEvidence(evidence, candidates);
      
      console.log('[ExtractCodeTool] Built spine from evidence:', {
        spineLength: spine.length,
        spine: spine.map(s => `${s.file}::${s.method}`)
      });
      
      if (spine.length === 0) {
        console.warn('[ExtractCodeTool] No spine found, generating skeleton graph');
        const skeletonGraph = this.generateSkeletonGraph(evidence, candidates, plan);
        return {
          evidence,
          candidates: candidates.slice(0, 5),
          graph: skeletonGraph,
          timings: { ...timings, graph: Date.now() - graphStart },
          confidence: 0.3,
          isPartial: true,
          vizMode: 'degraded' as const
        };
      }
      
      // Step 2: Build directed execution graph using ts-morph
      const directedGraph = this.buildDirectedGraphWithTsMorph(
        spine,
        input.workspace,
        evidence,
        candidates,
        input.config
      );
      
      timings.graph = Date.now() - graphStart;
      
      console.log('[ExtractCodeTool] Directed execution graph built:', {
        nodes: directedGraph.nodes.length,
        edges: directedGraph.edges.length,
        spineLength: spine.length
      });
      
      // Detailed graph logging
      console.log('[ExtractCodeTool] Detailed graph results:', {
        nodes: directedGraph.nodes.length,
        edges: directedGraph.edges.length,
        nodeTypes: directedGraph.nodes.reduce((acc, node) => {
          acc[node.kind] = (acc[node.kind] || 0) + 1;
          return acc;
        }, {} as Record<string, number>),
        edgeTypes: directedGraph.edges.reduce((acc, edge) => {
          acc[edge.kind] = (acc[edge.kind] || 0) + 1;
          return acc;
        }, {} as Record<string, number>),
        spineLength: spine.length
      });
      
      // Calculate overall confidence based on graph
      const confidence = this.calculateOverallConfidence(evidence, candidates, directedGraph);
      
      // Store snippets from the graph
      await this.storeSliceSnippets(directedGraph, projectId, commitHash, fileInfos);
      
      // Stage: Detect gaps and generate info requests
      let infoRequests: any[] = [];
      try {
        const gapDetector = new GapDetector();
        const gaps = gapDetector.detectGaps({ evidence, candidates, graph: directedGraph, timings, confidence }, evidence, candidates);
        
        // Only generate info requests if gaps detected
        const hasAnyGaps = gaps.lowConfidence || gaps.recallMiss || 
                          gaps.coverageScore < 0.6 || gaps.hasSymbolGaps || 
                          gaps.ambiguousStack || gaps.timedOutStages.length > 0;
        
        if (hasAnyGaps) {
          console.log('[ExtractCodeTool] Gaps detected, generating info requests:', gaps);
          
          const requestBuilder = new InfoRequestBuilder();
          infoRequests = requestBuilder.buildInfoRequests(gaps, evidence);
          
          // Skip agent prompt generation for beta - we're not generating prompts for AI coding agents
          // Agent prompt generation LLM calls removed to simplify the debugging flow
          
          console.log('[ExtractCodeTool] Generated info requests:', infoRequests.length);
        }
      } catch (error) {
        console.error('[ExtractCodeTool] Error generating info requests:', error);
        // Continue without info requests
      }
      
      const totalTime = Date.now() - startTime;
      timings.total = totalTime;
      
      console.log('[ExtractCodeTool] Debugging extraction completed:', {
        totalTime,
        confidence,
        candidates: candidates.length,
        nodes: directedGraph.nodes.length,
        edges: directedGraph.edges.length,
        infoRequestsCount: infoRequests.length
      });
      
      // Use the directed graph built with ts-morph
      const finalGraph = directedGraph;
      
      // Check if graph is empty and generate skeleton if needed
      if (finalGraph.nodes.length === 0) {
        const skeletonGraph = this.generateSkeletonGraph(evidence, candidates, plan);
        return {
          evidence,
          candidates: candidates.slice(0, 5), // Top 5 candidates
          graph: skeletonGraph,
          timings,
          confidence: 0.3, // Low confidence for skeleton
          infoRequests: undefined,
          isPartial: true,
          vizMode: 'degraded' as const
        };
      }
      
      return {
        evidence,
        candidates,
        graph: finalGraph,
        timings,
        confidence,
        infoRequests: infoRequests.length > 0 ? infoRequests : undefined
      };
      
    } catch (error) {
      console.error('[ExtractCodeTool] Error in debugging extraction:', error);
      
      // Check if it's a budget exceeded error
      const isBudgetError = error instanceof BudgetExceededError || (error as Error)?.name === 'BUDGET_EXCEEDED';
      
      // Detailed error logging
      console.error('[ExtractCodeTool] Detailed error information:', {
        errorMessage: (error as Error).message,
        errorStack: (error as Error).stack?.substring(0, 500) + (((error as Error).stack?.length || 0) > 500 ? '...' : ''),
        isBudgetError,
        input: {
          userMessage: input.userMessage?.substring(0, 100) + (input.userMessage?.length > 100 ? '...' : ''),
          hasLogs: !!(input.logs && input.logs.trim()),
          workspace: input.workspace,
          model: input.model,
          noLogMode: input.noLogMode,
          behaviorSpecConfidence: input.behaviorSpec?.confidence
        },
        timings: { total: Date.now() - startTime }
      });
      
      // If budget exceeded, try to return partial graph from whatever we have
      if (isBudgetError) {
        console.warn('[ExtractCodeTool] Budget exceeded, returning partial graph');
        // Try to get whatever partial data we have
        let partialGraph: { nodes: GraphNode[]; edges: GraphEdge[] };
        try {
          // Build minimal skeleton graph
          const safeEvidence: Evidence = evidence || {
            frames: [],
            evidenceSource: 'user_description' as const,
            hasHardError: false,
            hasLogs: false
          };
          const safePlan: SearchPlan = plan || { candidateFiles: [], symbols: [], queries: [], mode: 'hard-error' as const, reasoning: '' };
          partialGraph = this.generateSkeletonGraph(safeEvidence, candidates || [], safePlan);
        } catch (skeletonError) {
          // Fallback to absolute minimum
          partialGraph = {
            nodes: [
              { id: 'error', kind: 'file' as const, label: 'Budget exceeded - partial graph', file: '', badges: ['lowConfidence'] }
            ],
            edges: []
          };
        }
        
        return {
          evidence: evidence || {
            frames: [],
            evidenceSource: 'user_description' as const,
            hasHardError: false,
            hasLogs: false
          },
          candidates: candidates?.slice(0, 5) || [],
          graph: partialGraph,
          timings: { total: Date.now() - startTime },
          confidence: 0.2,
          isPartial: true,
          vizMode: 'degraded' as const
        };
      }
      
      // Return minimal response on other errors
      return {
        evidence: { 
          frames: [],
          evidenceSource: 'user_description' as const,
          hasHardError: false,
          hasLogs: false
        },
        candidates: [],
        graph: { nodes: [], edges: [] },
        timings: { total: Date.now() - startTime },
        confidence: 0,
        isPartial: true,
        vizMode: 'degraded' as const
      };
    }
  }

  /**
   * Build spine (starting points) from evidence and candidates
   * Returns array of { file, method } pairs for ts-morph traversal
   */
  private buildSpineFromEvidence(
    evidence: Evidence,
    candidates: CandidateFile[]
  ): Array<{ file: string; method: string }> {
    const spine: Array<{ file: string; method: string }> = [];
    const seen = new Set<string>();

    // 1. Extract from evidence frames (error stack traces)
    for (const frame of evidence.frames) {
      if (frame.file && frame.fn) {
        const key = `${frame.file}:${frame.fn}`;
        if (!seen.has(key)) {
          seen.add(key);
          spine.push({
            file: frame.file,
            method: frame.fn
          });
        }
      }
    }

    // 2. Extract from top candidate symbols
    for (const candidate of candidates.slice(0, 10)) {
      if (candidate.symbols && candidate.symbols.length > 0) {
        for (const symbol of candidate.symbols.slice(0, 3)) {
          if (symbol.file && symbol.symbol) {
            const key = `${symbol.file}:${symbol.symbol}`;
            if (!seen.has(key)) {
              seen.add(key);
              // Extract method name from symbol (handle class.method format)
              const methodName = symbol.symbol.includes('.') 
                ? symbol.symbol.split('.').pop() || symbol.symbol
                : symbol.symbol;
              spine.push({
                file: symbol.file,
                method: methodName
              });
            }
          }
        }
      }
    }

    // 3. If no spine found, use top candidate files with common entry points
    if (spine.length === 0 && candidates.length > 0) {
      const topCandidate = candidates[0];
      if (topCandidate.file) {
        // Try common entry point names
        const commonMethods = ['main', 'handle', 'execute', 'run', 'process'];
        for (const method of commonMethods) {
          spine.push({
            file: topCandidate.file,
            method: method
          });
          break; // Just use first method
        }
        // If no common method, use the file itself as a fallback
        if (spine.length === 0) {
          spine.push({
            file: topCandidate.file,
            method: path.basename(topCandidate.file, path.extname(topCandidate.file))
          });
        }
      }
    }

    return spine;
  }

  /**
   * Build directed execution graph using ts-morph
   */
  private buildDirectedGraphWithTsMorph(
    spine: Array<{ file: string; method: string }>,
    workspaceRoot: string,
    evidence: Evidence,
    candidates: CandidateFile[],
    config?: DebuggingExtractionInput['config']
  ): { nodes: GraphNode[]; edges: GraphEdge[] } {
    const compressor = new GraphCompressor(this.llmProvider);

    // Extract entry paths from spine
    const entryPaths = spine.map(s => s.file).filter((f): f is string => !!f);

    // Initialize ts-morph project
    try {
      compressor.getOrCreateTsMorphProject(workspaceRoot, entryPaths);
    } catch (error) {
      console.warn('[ExtractCodeTool] Failed to initialize ts-morph project:', error);
      // Return empty graph on failure
      return { nodes: [], edges: [] };
    }

    // Build deep call graph using traverseCallsDeep
    const maxHops = config?.maxDepth || 5;
    const maxNodes = (config?.maxNodes || 50) * 3; // Allow 3x for traversal
    const deepCallGraph = compressor.traverseCallsDeep(spine, workspaceRoot, {
      maxHops,
      maxNodes,
      maxFiles: 50
    });

    console.log(`[ExtractCodeTool] ts-morph traversal returned ${deepCallGraph.size} methods`);

    // Convert deepCallGraph Map to edges format for buildDirectedDebugGraph
    const edges: Array<{
      from: { file?: string; method: string };
      to: { file?: string; method: string };
      kind: "forward" | "backward" | "loop";
      depth: number;
      evidence: string[];
      line?: number;
      order?: number;
      label?: string;
    }> = [];

    // Build a minimal LocalContext for buildDirectedDebugGraph
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
      errorFrames: evidence.frames,
      userMentions: []
    };

    // Create empty method graph for context (not used for traversal, but needed for collectLocalContext)
    const emptyMethodGraph: MethodExecutionGraph = {
      symbols: [],
      symbolEdges: [],
      files: [],
      fileEdges: []
    };

    const localContext = compressor.collectLocalContext(coarsePath, focus, emptyMethodGraph);

    // Convert deepCallGraph to edges
    for (const [callerKey, callees] of deepCallGraph.entries()) {
      // Parse caller key (format: "file::method" with double colon)
      const [callerFile, callerMethod] = callerKey.includes('::')
        ? callerKey.split('::')
        : [undefined, callerKey];

      for (const callee of callees) {
        edges.push({
          from: { file: callerFile, method: callerMethod || 'unknown' },
          to: { file: callee.file, method: callee.name },
          kind: "forward" as const,
          depth: callee.depth,
          evidence: callee.crossFile ? ["ast-forward", "cross-file"] : ["ast-forward"],
          line: callee.line,
          order: callee.order,
          label: callee.edgeLabel
        });
      }
    }

    // Build directed graph using buildDirectedDebugGraph
    const compressedGraph = compressor.buildDirectedDebugGraph({
      spine,
      edges,
      ctx: localContext,
      workspaceRoot
    });

    // Convert CompressedGraph to GraphNode[] and GraphEdge[]
    const nodes: GraphNode[] = compressedGraph.nodes.map(n => ({
      id: n.id,
      label: n.label || n.id,
      file: n.file || '',
      kind: (n.kind === 'symbol' ? 'symbol' : n.kind === 'file' ? 'file' : 'symbol') as 'file' | 'symbol' | 'route',
      line: n.line,
      badges: (n.badges || []) as ('error' | 'suspicious' | 'lowConfidence' | 'routeHandler')[]
    }));

    const graphEdges: GraphEdge[] = compressedGraph.edges.map(e => {
      let edgeKind: GraphEdge['kind'] = 'calls';
      if (e.kind === 'imports') edgeKind = 'imports';
      else if (e.kind === 'calls') edgeKind = 'calls';

      return {
        from: e.from,
        to: e.to,
        kind: edgeKind,
        confidence: e.confidence,
        evidence: e.evidence,
        label: e.label
      };
    });

    return {
      nodes,
      edges: graphEdges
    };
  }

  /**
   * Build repository metadata for search planning
   */
  private async buildRepoMeta(workspace: string, model: string = 'gpt-4'): Promise<any> {
    const fileInfos = await this.scanCodebase({
      query: '',
      projectId: 'debugging',
      connectedCodebasePath: workspace,
      model,
      filenameKeywords: [],
      methodNameKeywords: [],
      codeKeywords: [],
      maxIterations: 1,
      maxDependencyDepth: 1,
      manuallyPinnedFilePaths: []
    });
    
    return {
      fileList: Array.from(fileInfos.keys()),
      paths: Array.from(fileInfos.keys()),
      projectRoot: workspace,
      commitHash: undefined
    };
  }

  /**
   * Build method-level execution graph with focused AST building
   */
  public buildExecutionGraph(
    input: DebuggingExtractionInput,
    plan: SearchPlan,
    candidates: CandidateFile[]
  ): MethodExecutionGraph {
    const astBuilder = new AstProgramBuilder(input.workspace);
    
    // Focus AST building on candidate files
    const candidateFiles = new Set<string>();
    
    // Add files from search plan
    for (const file of plan.candidateFiles) {
      candidateFiles.add(file);
    }
    
    // Add files from candidates (capped at 12 for performance)
    for (const candidate of candidates.slice(0, MAX_CANDIDATE_SLICE_FOR_GRAPH)) {
      candidateFiles.add(candidate.file);
    }
    
    // Add files from evidence (will be passed separately if needed)
    // Evidence frames are handled separately
    
    // Safety check: if candidateFiles.size > 20, trim to top 20
    if (candidateFiles.size > MAX_CANDIDATE_FILES_FOR_GRAPH) {
      const filesArray = Array.from(candidateFiles);
      candidateFiles.clear();
      // Take top 20 files (assuming they're already sorted by importance from plan + candidates)
      for (const file of filesArray.slice(0, MAX_CANDIDATE_FILES_FOR_GRAPH)) {
        candidateFiles.add(file);
      }
      console.log(`[ExtractCodeTool] Trimmed candidateFiles from ${filesArray.length} to ${MAX_CANDIDATE_FILES_FOR_GRAPH} for AST building`);
    }
    
    // Build TypeScript program (will still scan all files, but we'll focus extraction)
    const tsProgram = astBuilder.buildTsProgram(input.workspace, input.config);
    
    // Build symbol index for focused files only if we have candidates
    // Otherwise build full index for fallback
    const allFiles = Array.from(tsProgram.sourceFiles.keys());
    const focusedFiles = candidateFiles.size > 0 && candidateFiles.size < allFiles.length / 2
      ? Array.from(candidateFiles).filter(file => tsProgram.sourceFiles.has(file))
      : allFiles;
    
    // Create focused program subset (still need full program for imports, but filter later)
    const symbolIndex = new Map<string, import('./debugging/types').SymbolDef[]>();
    
    // Build symbol index for focused files (need full program for context)
    const fullSymbolIndex = astBuilder.buildSymbolIndex(tsProgram);
    
    // Filter to focused files
    for (const fileName of focusedFiles) {
      const fileSymbols = fullSymbolIndex.get(fileName) || [];
      if (fileSymbols.length > 0) {
        symbolIndex.set(fileName, fileSymbols);
      }
    }
    
    // Collect all SymbolDefs
    const symbols: import('./debugging/types').SymbolDef[] = [];
    for (const fileSymbols of symbolIndex.values()) {
      symbols.push(...fileSymbols);
    }
    
    // Extract symbol call graph (focused on candidate files and their neighbors)
    const symbolCalls = astBuilder.extractSymbolCallGraph(tsProgram, symbolIndex);
    
    // Get file-level import graph (include imports of focused files)
    const allImportRelations = astBuilder.extractImportGraph(tsProgram);
    const focusedFileSet = new Set(focusedFiles);
    
    // Filter imports to only include focused files and their direct neighbors
    const fileEdges = allImportRelations.filter(rel => 
      focusedFileSet.has(rel.from) || focusedFileSet.has(rel.to)
    );
    
    // Collect unique files from edges and symbols
    const filesSet = new Set<string>();
    for (const rel of fileEdges) {
      filesSet.add(rel.from);
      filesSet.add(rel.to);
    }
    for (const symbol of symbols) {
      filesSet.add(symbol.file);
    }
    
    return {
      symbols,
      symbolEdges: symbolCalls,
      files: Array.from(filesSet),
      fileEdges
    };
  }

  /**
   * Polish unresolved symbol calls using LLM
   */
  private async polishUnresolvedSymbolCalls(
    methodGraph: MethodExecutionGraph,
    unresolvedCalls: import('./debugging/types').SymbolCall[],
    fileInfos: Map<string, any>,
    llmConfig: import('./debugging/types').DebuggingExtractionInput['llmConfig']
  ): Promise<MethodExecutionGraph> {
    if (!llmConfig || unresolvedCalls.length === 0) {
      return methodGraph;
    }
    
    // Convert unresolved symbol calls to GraphNode/GraphEdge format for polishing
    const nodes: import('./debugging/types').GraphNode[] = [];
    const edges: import('./debugging/types').GraphEdge[] = [];
    const symbolById = new Map(methodGraph.symbols.map(s => [s.id, s]));
    
    // Create nodes for unresolved calls
    for (const call of unresolvedCalls.slice(0, 20)) { // Limit to 20 for performance
      const caller = symbolById.get(call.callerId);
      if (caller) {
        nodes.push({
          id: caller.id,
          kind: 'symbol',
          label: caller.name,
          file: caller.file,
          line: caller.startLine,
          badges: []
        });
      }
      
      // Create node for unresolved callee
      if (call.calleeId.includes('<unresolved:')) {
        const unresolvedName = call.calleeId.split('<unresolved:')[1].replace('>', '');
        nodes.push({
          id: call.calleeId,
          kind: 'symbol',
          label: unresolvedName,
          file: call.file,
          line: call.line,
          badges: ['lowConfidence']
        });
      }
      
      edges.push({
        from: call.callerId,
        to: call.calleeId,
        kind: 'calls',
        confidence: call.confidence,
        evidence: ['unresolved']
      });
    }
    
    // Prepare code snippets for context
    const codeSnippets: Array<{ file: string; snippet: string; reason: string }> = [];
    for (const call of unresolvedCalls.slice(0, 10)) {
      const caller = symbolById.get(call.callerId);
      if (caller && fileInfos.has(caller.file)) {
        const fileInfo = fileInfos.get(caller.file);
        if (fileInfo?.elements) {
          // Get code around the call
          const element = fileInfo.elements.find((e: any) => 
            e.line === call.line || (caller.startLine && e.line >= caller.startLine && e.line <= (caller.endLine || caller.startLine + 10))
          );
          if (element) {
            codeSnippets.push({
              file: caller.file,
              snippet: element.code || '',
              reason: `Context for unresolved call from ${caller.name}`
            });
          }
        }
      }
    }
    
    // Create minimal evidence for polishing
    const evidence: import('./debugging/types').Evidence = {
      frames: [],
      evidenceSource: 'user_description' as const,
      hasHardError: false,
      hasLogs: false
    };
    
    // Create whitelist from methodGraph symbols
    const whitelist = methodGraph.symbols.map(s => s.id).slice(0, 100);
    
    // Call GraphPolisher
    const polished = await GraphPolisher.polish(
      { nodes, edges },
      evidence,
      codeSnippets,
      whitelist,
      llmConfig
    );
    
    // Merge polished edges back into symbolEdges
    const resolvedSymbolEdges = [...methodGraph.symbolEdges];
    const existingCallIds = new Set(resolvedSymbolEdges.map(c => `${c.callerId}->${c.calleeId}`));
    
    // Look for new edges that might resolve unresolved calls
    for (const edge of polished.edges) {
      const key = `${edge.from}->${edge.to}`;
      if (!existingCallIds.has(key) && edge.kind === 'calls' && edge.confidence > 0.5) {
        // Check if this resolves an unresolved call
        const unresolvedCall = unresolvedCalls.find(c => 
          c.callerId === edge.from && 
          c.calleeId.includes('<unresolved:') &&
          edge.to !== c.calleeId
        );
        
        if (unresolvedCall || (edge.to && !edge.to.includes('<unresolved:'))) {
          // Create resolved symbol call
          const callerSymbol = symbolById.get(edge.from);
          const calleeSymbol = symbolById.get(edge.to);
          
          if (callerSymbol) {
            resolvedSymbolEdges.push({
              callerId: edge.from,
              calleeId: edge.to,
              file: callerSymbol.file,
              line: edge.from ? undefined : undefined,
              confidence: edge.confidence,
              via: 'llm-polish'
            });
          }
        }
      }
    }
    
    return {
      ...methodGraph,
      symbolEdges: resolvedSymbolEdges
    };
  }


  /**
   * Build root specification for static slicing
   */
  private buildRootSpec(evidence: Evidence, candidates: CandidateFile[]): RootSpec {
    const topSymbols = this.buildTopSymbolsForRootSpec(candidates);
    const userMentions = this.buildUserMentionsForRootSpec(evidence);
    const fallbackFiles = this.buildFallbackFilesForRootSpec(evidence, candidates, topSymbols);
    
    return {
      errorFrames: evidence.frames,
      topSymbols,
      userMentions,
      fallbackFiles: fallbackFiles.length ? fallbackFiles : undefined,
    };
  }

  private buildTopSymbolsForRootSpec(candidates: CandidateFile[]): CandidateSymbolRef[] {
    return candidates
      .slice(0, 10)
      .flatMap((candidate) => candidate.symbols || [])
      .filter((symbol) => symbol && symbol.file && symbol.symbol)
      .slice(0, 15);
  }

  private buildUserMentionsForRootSpec(evidence: Evidence): string[] {
    const mentions = new Set<string>();

    if (evidence.route) {
      mentions.add(evidence.route);
    }

    if (Array.isArray(evidence.behaviorHints)) {
      for (const hint of evidence.behaviorHints) {
        if (hint?.value) {
          mentions.add(hint.value);
        }
      }
    }

    return Array.from(mentions).slice(0, 10);
  }

  private buildFallbackFilesForRootSpec(
    evidence: Evidence,
    candidates: CandidateFile[],
    topSymbols: CandidateSymbolRef[],
  ): string[] {
    const fromFrames = new Set(evidence.frames.map((frame) => frame.file));
    const fromSymbols = new Set(topSymbols.map((symbol) => symbol.file));

    const fallbackFiles: string[] = [];

    // Increase fallback files to ensure larger graphs
    const maxFallbackFiles = 15;
    
    for (const candidate of candidates) {
      const candidateFile = candidate.file;
      if (!candidateFile) {
        continue;
      }

      // Still add fallback files even if they're in frames/symbols to ensure expansion
      // But prioritize files not already covered
      if (fromFrames.has(candidateFile) || fromSymbols.has(candidateFile)) {
        // Only skip if we already have enough fallback files
        if (fallbackFiles.length >= maxFallbackFiles) {
          continue;
        }
      }

      fallbackFiles.push(candidateFile);
      if (fallbackFiles.length >= maxFallbackFiles) {
        break;
      }
    }

    return fallbackFiles;
  }

  /**
   * Calculate overall confidence score
   */
  private calculateOverallConfidence(
    evidence: Evidence,
    candidates: CandidateFile[],
    slice: { nodes: any[]; edges: any[] }
  ): number {
    let confidence = 0;
    
    // Base confidence from evidence
    if (evidence.frames.length > 0) confidence += 0.3;
    if (evidence.error) confidence += 0.2;
    if (evidence.route) confidence += 0.1;
    
    // Confidence from candidates
    if (candidates.length > 0) {
      const avgScore = candidates.reduce((sum, c) => sum + c.score, 0) / candidates.length;
      confidence += avgScore * 0.3;
    }
    
    // Confidence from graph connectivity
    if (slice.nodes.length > 0 && slice.edges.length > 0) {
      const connectivity = slice.edges.length / slice.nodes.length;
      confidence += Math.min(connectivity * 0.2, 0.2);
    }
    
    return Math.min(confidence, 1.0);
  }

  /**
   * Store evidence frames as snippets
   */
  private async storeEvidenceSnippets(evidence: Evidence, projectId: string, commitHash: string): Promise<void> {
    for (const frame of evidence.frames) {
      try {
        const snippet = await SnippetUtils.createSnippetRecord({
          projectId,
          commitHash,
          filePath: frame.file,
          startLine: Math.max(1, frame.line - 5),
          endLine: frame.line + 5,
          source: ['frame'],
          evidence: ['stackFrame'],
          frameworkHints: frame.fn ? ['functionFrame'] : []
        });

        // Extract code snippet with context
        const codeData = await SnippetUtils.extractCodeSnippet(
          frame.file,
          snippet.startLine,
          snippet.endLine,
          10
        );

        snippet.code = codeData.code;
        snippet.preContext = codeData.preContext;
        snippet.postContext = codeData.postContext;
        snippet.charStart = codeData.charStart;
        snippet.charEnd = codeData.charEnd;

        await this.snippetStore.upsert(snippet);
      } catch (error) {
        console.warn(`Failed to store evidence snippet for ${frame.file}:`, error);
      }
    }
  }

  /**
   * Store snippets from the static slice
   */
  private async storeSliceSnippets(
    slice: { nodes: any[]; edges: any[] },
    projectId: string,
    commitHash: string,
    fileInfos: Map<string, FileInfo>
  ): Promise<void> {
    // Store snippets for each node in the slice
    for (const node of slice.nodes) {
      if (node.file && node.line) {
        try {
          const snippet = await SnippetUtils.createSnippetRecord({
            projectId,
            commitHash,
            filePath: node.file,
            startLine: node.line,
            endLine: node.line + 10, // Default 10-line span
            source: ['astCall', 'astImport'],
            evidence: node.badges || [],
            frameworkHints: this.detectFrameworkHints(node)
          });

          // Extract code snippet with context
          const codeData = await SnippetUtils.extractCodeSnippet(
            node.file,
            snippet.startLine,
            snippet.endLine,
            15
          );

          snippet.code = codeData.code;
          snippet.preContext = codeData.preContext;
          snippet.postContext = codeData.postContext;
          snippet.charStart = codeData.charStart;
          snippet.charEnd = codeData.charEnd;

          await this.snippetStore.upsert(snippet);
        } catch (error) {
          console.warn(`Failed to store slice snippet for ${node.file}:`, error);
        }
      }
    }

    // Store snippets for edges (call relationships)
    for (const edge of slice.edges) {
      if (edge.kind === 'calls' && edge.confidence > 0.7) {
        try {
          // Find the target node to get file and line info
          const targetNode = slice.nodes.find(n => n.id === edge.to);
          if (targetNode && targetNode.file && targetNode.line) {
            const snippet = await SnippetUtils.createSnippetRecord({
              projectId,
              commitHash,
              filePath: targetNode.file,
              startLine: targetNode.line,
              endLine: targetNode.line + 5,
              source: ['astCall'],
              evidence: ['callRelation'],
              scores: { callConfidence: edge.confidence }
            });

            await this.snippetStore.upsert(snippet);
          }
        } catch (error) {
          console.warn(`Failed to store edge snippet:`, error);
        }
      }
    }
  }

  /**
   * Get whitelist of files for LLM refinement
   */
  private getWhitelist(fileInfos: Map<string, FileInfo>): string[] {
    return Array.from(fileInfos.keys()).filter(file => 
      !file.includes('node_modules') && 
      !file.includes('dist') && 
      !file.includes('build')
    );
  }

  /**
   * Detect framework hints for a node
   */
  private detectFrameworkHints(node: any): string[] {
    const hints: string[] = [];
    
    if (node.badges?.includes('routeHandler')) {
      hints.push('nextRouteHandler');
    }
    
    if (node.label?.includes('router')) {
      hints.push('expressHandler');
    }
    
    if (node.file?.includes('index.ts') || node.file?.includes('index.js')) {
      hints.push('barrelExport');
    }
    
    if (node.label?.includes('import(')) {
      hints.push('dynamicImport');
    }
    
    return hints;
  }

  /**
   * Extract focused code for hypothesis testing
   * Reuses existing indexes for efficient retrieval
   */
  public async extractFocused(params: {
    query: string;
    allowFiles?: string[];
    topK?: number;
  }): Promise<CandidateFile[]> {
    const { query, allowFiles = [], topK = 3 } = params;
    
    try {
      // Use existing scanCodebase method with focused parameters
      const fileInfos = await this.scanCodebase({
        query,
        projectId: 'debugging',
        connectedCodebasePath: '', // Will be set by caller
        model: 'gpt-4', // Default model
        filenameKeywords: allowFiles,
        methodNameKeywords: [],
        codeKeywords: [],
        maxIterations: 1, // Single iteration for focused extraction
        maxDependencyDepth: 1, // Shallow dependency resolution
        manuallyPinnedFilePaths: []
      });
      
      // Convert FileInfo to CandidateFile format
      const candidates: CandidateFile[] = [];
      
      for (const [filePath, fileInfo] of fileInfos) {
        // Only include files in allowFiles if specified
        if (allowFiles.length > 0 && !allowFiles.some(allowed => 
          filePath.includes(allowed) || allowed.includes(filePath)
        )) {
          continue;
        }
        
        // Calculate relevance score based on query match
        const score = this.calculateRelevanceScore(query, fileInfo);
        
        candidates.push({
          file: filePath,
          score,
          evidence: [`Query match: ${query}`],
          symbols: (fileInfo as any).symbols || []
        });
      }
      
      // Sort by score and return top K
      return candidates
        .sort((a, b) => b.score - a.score)
        .slice(0, topK);
        
    } catch (error) {
      console.error('[ExtractCodeTool] Error in extractFocused:', error);
      return [];
    }
  }

  /**
   * Calculate relevance score for a file based on query
   */
  private calculateRelevanceScore(query: string, fileInfo: FileInfo): number {
    let score = 0;
    const queryLower = query.toLowerCase();
    
    // Score based on filename match
    const fileName = fileInfo.path.split('/').pop()?.toLowerCase() || '';
    if (fileName.includes(queryLower)) {
      score += 0.3;
    }
    
    // Score based on symbol matches
    if ((fileInfo as any).symbols) {
      const symbolMatches = (fileInfo as any).symbols.filter((symbol: any) => 
        symbol.name && symbol.name.toLowerCase().includes(queryLower)
      ).length;
      score += symbolMatches * 0.1;
    }
    
    // Score based on content matches (simplified)
    const contentLower = (fileInfo as any).content?.toLowerCase() || '';
    const contentMatches = (contentLower.match(new RegExp(queryLower, 'g')) || []).length;
    score += Math.min(contentMatches * 0.05, 0.5);
    
    return Math.min(score, 1.0);
  }

  /**
   * Get snippet store for external access
   */
  public getSnippetStore(): SnippetStore {
    return this.snippetStore;
  }

  /**
   * Generate skeleton graph when normal graph is empty or budget exceeded
   * Produces minimal graph: UserReport → SearchPlanner → ExtractCodeTool → TopFile1 → TopSymbol1
   */
  private generateSkeletonGraph(
    evidence: Evidence,
    candidates: CandidateFile[],
    plan: SearchPlan
  ): { nodes: GraphNode[]; edges: GraphEdge[] } {
    const nodes: GraphNode[] = [];
    const edges: GraphEdge[] = [];

    // Add pipeline nodes
    const userReportId = 'node:UserReport';
    const searchPlannerId = 'node:SearchPlanner';
    const extractCodeToolId = 'node:ExtractCodeTool';

    nodes.push({
      id: userReportId,
      kind: 'file',
      label: 'UserReport',
      file: '',
      badges: ['lowConfidence']
    });

    nodes.push({
      id: searchPlannerId,
      kind: 'file',
      label: 'SearchPlanner',
      file: '',
      badges: ['lowConfidence']
    });

    nodes.push({
      id: extractCodeToolId,
      kind: 'file',
      label: 'ExtractCodeTool',
      file: '',
      badges: ['lowConfidence']
    });

    edges.push({
      from: userReportId,
      to: searchPlannerId,
      kind: 'calls',
      confidence: 0.5,
      evidence: ['skeleton']
    });

    edges.push({
      from: searchPlannerId,
      to: extractCodeToolId,
      kind: 'calls',
      confidence: 0.5,
      evidence: ['skeleton']
    });

    // Add top files and symbols
    const topCandidates = candidates.slice(0, 2);
    let fileIndex = 0;

    for (const candidate of topCandidates) {
      const fileId = `file:${candidate.file}`;
      nodes.push({
        id: fileId,
        kind: 'file',
        label: path.basename(candidate.file),
        file: candidate.file,
        badges: ['lowConfidence']
      });

      edges.push({
        from: extractCodeToolId,
        to: fileId,
        kind: 'calls',
        confidence: 0.4,
        evidence: ['skeleton']
      });

      // Add top symbol from this file
      if (candidate.symbols && candidate.symbols.length > 0) {
        const topSymbol = candidate.symbols[0];
        const symbolId = `symbol:${topSymbol.file}:${topSymbol.symbol}`;
        nodes.push({
          id: symbolId,
          kind: 'symbol',
          label: topSymbol.symbol,
          file: topSymbol.file,
          line: topSymbol.startLine,
          badges: ['lowConfidence']
        });

        edges.push({
          from: fileId,
          to: symbolId,
          kind: 'calls',
          confidence: 0.4,
          evidence: ['skeleton']
        });
      }

      fileIndex++;
      if (fileIndex >= 2) break; // Limit to 2 files
    }

    console.log(`[ExtractCodeTool] Generated skeleton graph with ${nodes.length} nodes and ${edges.length} edges (degraded mode)`);

    return { nodes, edges };
  }
}

