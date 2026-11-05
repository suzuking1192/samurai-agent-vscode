/**
 * InitialContextService - "Fast Path" for immediate graph visualization
 * 
 * Implements a three-tier funnel strategy to quickly find the epicenter file:
 * 1. User Pinned Files (explicit intent)
 * 2. Stack Traces from logs (hard crashes)
 * 3. LLM Semantic Search (silent bugs / logic issues)
 * 
 * Returns graph visualization in < 3 seconds, then triggers full agent in background.
 */

import * as path from 'path';
import * as fs from 'fs';
import { ToolRegistry } from '../tools/ToolRegistry';
import { LLMProviderService } from '../llm/llmProviderService';
import { EvidenceParser } from '../tools/debugging/EvidenceParser';
import { GraphContextParams, CodeSearchParams, CodeSearchToolSchema } from '../tools/definitions/ToolSchemas';
import { LLMResponse } from '../../common/models/llm-models';
import { loadDebuggingPrompt } from '../tools/debugging/promptLoader';
import { formatSchemaForPrompt, generateJsonFormatFromSchema } from './schemaFormatter';
import { RecentFilesTracker } from '../../services/RecentFilesTracker';

export interface InitialContextResult {
  success: boolean;
  sessionId: string; // Passed through or generated
  epicenterFile?: string;
  graphData?: {
    mermaid: string;
    nodes: any[];
    edges: any[];
  };
  source: 'user-pinned' | 'logs' | 'search' | 'none';
  error?: string;
  cost?: number;
}

export class InitialContextService {
  private totalCost: number = 0;

  constructor(
    private registry: ToolRegistry,
    private llm: LLMProviderService
  ) {}

  /**
   * The "Fast Path" Pipeline.
   * Finds the epicenter and builds the initial graph.
   */
  async getInitialContext(
    sessionId: string,
    userQuery: string,
    workspaceRoot: string,
    logs?: string,
    pinnedFiles?: string[],
    model?: string
  ): Promise<InitialContextResult> {
    // Reset cost tracking for this call
    this.totalCost = 0;
    
    console.time(`[FastPath-${sessionId}]`);
    let epicenterFile: string | null = null;
    let source: InitialContextResult['source'] = 'none';

    // --- STEP 1: CHECK PINNED FILES (Explicit Intent) ---
    if (pinnedFiles && pinnedFiles.length > 0) {
      // Verify the first file exists
      const valid = pinnedFiles.find(f => {
        const abs = path.isAbsolute(f) ? f : path.join(workspaceRoot, f);
        return fs.existsSync(abs);
      });

      if (valid) {
        epicenterFile = path.isAbsolute(valid) ? valid : path.join(workspaceRoot, valid);
        source = 'user-pinned';
        console.log(`[InitialContext] Using pinned file: ${epicenterFile}`);
      }
    }

    // --- STEP 2: CHECK STACK TRACES (Hard Crashes) ---
    // If no pin, checks if logs contain a clear stack trace pointing to source code.
    if (!epicenterFile && logs && logs.trim().length > 0) {
      const parser = new EvidenceParser(workspaceRoot);
      const evidence = parser.parseEvidence({
        userMessage: userQuery,
        logs,
        workspace: workspaceRoot
      });

      // Get top frame that is NOT node_modules
      const validFrame = evidence.frames.find(
        f => f.file && !f.file.includes('node_modules')
      );

      if (validFrame?.file && fs.existsSync(validFrame.file)) {
        epicenterFile = validFrame.file;
        source = 'logs';
        console.log(`[InitialContext] Found epicenter from stack trace: ${epicenterFile}`);
      }
    }

    // --- STEP 3: LLM SEMANTIC SEARCH (Silent Bugs / Logic Issues) ---
    // If we still have no file, ask LLM to drive the CodeSearchTool.
    if (!epicenterFile) {
      epicenterFile = await this.findEpicenterViaLLMSearch(userQuery, logs, workspaceRoot, model);
      if (epicenterFile) {
        source = 'search';
      }
    }

    // --- FAIL FAST ---
    if (!epicenterFile) {
      console.timeEnd(`[FastPath-${sessionId}]`);
      return {
        success: false,
        sessionId,
        source: 'none',
        error:
          "I analyzed the request but couldn't pinpoint a starting file. Please mention a filename or provide logs.",
        cost: this.totalCost
      };
    }

    // --- STEP 4: BUILD GRAPH (The Map) ---
    try {
      const graphTool = this.registry.getTool('graph-context');
      if (!graphTool) {
        throw new Error('GraphContextTool not found');
      }

      // Resolve epicenter file path relative to workspace if needed
      const graphFilePath = path.isAbsolute(epicenterFile)
        ? path.relative(workspaceRoot, epicenterFile)
        : epicenterFile;

      const graphResult = await graphTool.execute({
        filePath: graphFilePath,
        depth: 2, // Use minimal depth for fast path - just for agent context
        visualizationMode: 'hard-error' // Default mode
      } as GraphContextParams);

      console.timeEnd(`[FastPath-${sessionId}]`);

      return {
        success: true,
        sessionId,
        epicenterFile,
        source,
        graphData: {
          mermaid: graphResult.structuredData?.mermaid || '',
          nodes: graphResult.structuredData?.nodes || [],
          edges: graphResult.structuredData?.edges || []
        },
        cost: this.totalCost
      };
    } catch (error: any) {
      console.error(`[InitialContext] Graph build failed:`, error);
      // Fallback: Return success (we found the file) but no graph
      return {
        success: true,
        sessionId,
        epicenterFile,
        source,
        error: `Epicenter found (${path.basename(epicenterFile)}), but graph generation failed: ${error.message}`,
        cost: this.totalCost
      };
    }
  }

  /**
   * Ask LLM for multiple search strategies and run them all.
   * Uses user's selected model to respect their preferences
   */
  private async findEpicenterViaLLMSearch(
    query: string,
    logs: string | undefined,
    workspaceRoot: string,
    model?: string
  ): Promise<string | null> {
    // Truncate logs to avoid token bloat/latency
    const safeLogs = logs ? logs.slice(0, 1000) : 'No logs.';
    
    // Get recent files for context (recency bias heuristic)
    const recentFiles = RecentFilesTracker.getInstance()
      .getRecentlyOpenedFilePaths(5, workspaceRoot);
    
    const formattedFiles = recentFiles.length > 0
      ? recentFiles
          .map(f => path.relative(workspaceRoot, f)) // Convert absolute to relative paths
          .join(', ')
      : 'No recent files tracked.';
    
    // Generate schema description and JSON format dynamically from the actual schema
    const codeSearchSchemaDescription = formatSchemaForPrompt(CodeSearchToolSchema, 'code-search');
    const codeSearchJsonFormat = generateJsonFormatFromSchema(CodeSearchToolSchema);
    
    // Load prompt template from file
    let promptTemplate: string;
    try {
      promptTemplate = loadDebuggingPrompt('epicenter_search.md');
    } catch (error) {
      console.warn('[InitialContext] Failed to load epicenter_search prompt, using fallback:', error);
      // Fallback prompt if file not found
      promptTemplate = `
Task: Generate multiple search strategies to find the epicenter file.

Code Search Tool Schema:
${codeSearchSchemaDescription}

Rules:
1. Generate 2-3 diverse search queries (file, symbol, text modes).
2. Ignore generic logs (e.g. "200 OK") if they contradict the query.
3. Try different angles: file names, class names, unique strings.
4. Consider recent files: {{RECENT_FILES}}. If query is vague, prioritize searching in/near these files.

User Query: "{{USER_QUERY}}"
Context Snippet: "{{CONTEXT_SNIPPET}}"
Recent Files: {{RECENT_FILES}}

Output JSON with queries array:
{
  "queries": [
    { "query": "...", "mode": "file|symbol|text" }
  ]
}
`;
    }
    
    // Replace template variables
    const prompt = promptTemplate
      .replace('{{USER_QUERY}}', query)
      .replace('{{CONTEXT_SNIPPET}}', safeLogs)
      .replace('{{RECENT_FILES}}', formattedFiles)
      .replace('{{CODE_SEARCH_SCHEMA}}', codeSearchSchemaDescription)
      .replace('{{CODE_SEARCH_JSON_FORMAT}}', codeSearchJsonFormat);

    try {
      const response = await this.llm.chat({
        id: 'epicenter-search-strategy',
        provider: 'auto', // Will resolve to user's configured provider
        model: model || '', // Use user's selected model
        messages: [{ role: 'user', content: prompt }],
        maxTokens: 10000, // Increased slightly for array output
        temperature: 0.1,
        metadata: {},
        createdAt: new Date(),
        updatedAt: new Date()
      });

      if (response.type === 'error' || !response.payload) {
        console.error('[InitialContext] LLM search failed:', response.error);
        return null;
      }

      // Type guard: ensure payload is LLMResponse (not LLMError)
      const llmResponse = response.payload as LLMResponse;
      
      // Track cost from LLM call
      if (llmResponse.cost !== undefined) {
        this.totalCost += llmResponse.cost;
      }
      
      if (!llmResponse.content) {
        console.error('[InitialContext] LLM response missing content');
        return null;
      }

      // Parse JSON
      const content = llmResponse.content || '{}';
      const jsonMatch = content.match(/\{[\s\S]*\}/);
      if (!jsonMatch) {
        return null;
      }

      const parsed = JSON.parse(jsonMatch[0]);
      
      // Handle both old format (single query) and new format (queries array)
      let queries: CodeSearchParams[] = [];
      if (parsed.queries && Array.isArray(parsed.queries)) {
        // New format: multiple queries
        queries = parsed.queries.filter((q: any) => 
          q && typeof q.query === 'string' && ['file', 'symbol', 'text'].includes(q.mode)
        );
      } else if (parsed.query && parsed.mode) {
        // Old format: single query (backward compatibility)
        queries = [parsed as CodeSearchParams];
      }

      if (queries.length === 0) {
        console.warn('[InitialContext] No valid queries found in LLM response');
        return null;
      }

      // Limit to 3 queries max
      queries = queries.slice(0, 3);

      // Execute CodeSearchTool
      const searchTool = this.registry.getTool('code-search');
      if (!searchTool) {
        return null;
      }

      console.log(`[InitialContext] Executing ${queries.length} search strategies...`);

      // 1. Run all searches in parallel
      const searchPromises = queries.map((q: CodeSearchParams) => searchTool.execute(q));
      const results = await Promise.all(searchPromises);

      // 2. Aggregate Results
      // Each result.structuredData contains [{ file, score, line }, ...]
      const candidates: { file: string; score: number; mode: string }[] = [];

      results.forEach((res, index) => {
        if (res.success && res.structuredData && Array.isArray(res.structuredData)) {
          // The search tool already returns ranked results.
          // We take the top 3 from each strategy.
          const topMatches = res.structuredData.slice(0, 3);
          const mode = queries[index].mode;
          
          topMatches.forEach((match: any) => {
            // Boost score based on mode priority if needed
            // e.g. Symbols are usually better hits than generic text
            let boost = 0;
            if (mode === 'symbol') boost = 5;
            if (mode === 'text' && match.score > 20) boost = 2; // High confidence text match

            candidates.push({
              file: match.file,
              score: (match.score || 0) + boost,
              mode: mode
            });
          });
        }
      });

      // 3. Deduplicate and Sort by Score
      if (candidates.length === 0) {
        return null;
      }

      // Group by file path and keep highest score
      const fileScores = new Map<string, { score: number; mode: string }>();
      candidates.forEach(candidate => {
        const existing = fileScores.get(candidate.file);
        if (!existing || candidate.score > existing.score) {
          fileScores.set(candidate.file, { score: candidate.score, mode: candidate.mode });
        }
      });

      // Convert to array and sort by score
      const ranked = Array.from(fileScores.entries())
        .map(([file, data]) => ({ file, score: data.score, mode: data.mode }))
        .sort((a, b) => b.score - a.score);

      const winner = ranked[0];
      console.log(`[InitialContext] Winner: ${winner.file} (Score: ${winner.score}, Strategy: ${winner.mode})`);

      return winner.file;
    } catch (e) {
      console.error('[InitialContext] Search failed:', e);
      return null;
    }
  }
}

