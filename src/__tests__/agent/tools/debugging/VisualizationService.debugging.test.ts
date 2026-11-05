/**
 * Test for VisualizationService.generateVisualization
 * 
 * Tests visualization generation with a debugging process scenario,
 * both with and without actual LLM, and saves the mermaid graph.
 */

import * as fs from 'fs';
import * as path from 'path';
import { VisualizationService } from '../../../../agent/tools/debugging/VisualizationService';
import { LLMProviderService } from '../../../../agent/llm/llmProviderService';
import { GraphNode, GraphEdge } from '../../../../agent/tools/debugging/types';
import { RootCauseReport } from '../../../../agent/tools/debugging/rootCauseTypes';

jest.mock('../../../../agent/tools/debugging/MermaidValidator', () => ({
  validateMermaid: jest.fn().mockResolvedValue({ isValid: true, errors: [], warnings: [] })
}));

jest.mock('../../../../agent/tools/debugging/GraphCompressor', () => ({
  GraphCompressor: jest.fn().mockImplementation(() => ({
    extractCuratedSubGraph: (nodes: any[], edges: any[], _focus?: any, _min?: number, _max?: number) => ({
      nodes,
      edges
    })
  }))
}));

jest.setTimeout(30000);

// Mock LLM provider for testing without actual LLM
const mockLLMProvider = {
  generateResponse: jest.fn()
} as unknown as LLMProviderService;

// Helper to create a real LLM provider if API key is available
function createRealLLMProvider(): LLMProviderService | null {
  const geminiApiKey = process.env.GEMINI_API_KEY;
  if (!geminiApiKey) {
    return null;
  }

  const globalDataStore = {
    loadGlobalSettings: () => ({
      type: 'success' as const,
      payload: {
        id: 'test-settings',
        userId: 'test-user',
        openaiApiKey: '',
        geminiApiKey: geminiApiKey,
        claudeApiKey: '',
        defaultProvider: 'google',
        defaultModel: 'gemini-2.0-flash-exp',
        defaultMode: 'default',
        fontSize: 14,
        showTokenCounts: true,
        showCostEstimates: true,
        autoSaveInterval: 30,
        maxHistoryItems: 100,
        enableNotifications: true,
        customApiEndpoints: {},
        metadata: {},
        createdAt: new Date(),
        updatedAt: new Date()
      }
    }),
    saveGlobalSettings: () => ({ type: 'success' as const })
  } as any;

  const { GeminiChatClient } = require('../../../../agent/llm/GeminiChatClient');
  const llmProvider = new LLMProviderService(globalDataStore);
  llmProvider.registerClient('google', new GeminiChatClient());
  return llmProvider;
}

// Helper to save mermaid graph to file
function saveMermaidGraph(mermaid: string, filename: string, outputDir: string = 'debug-graph-output'): string {
  const outputPath = path.join(process.cwd(), outputDir);
  if (!fs.existsSync(outputPath)) {
    fs.mkdirSync(outputPath, { recursive: true });
  }
  
  const filePath = path.join(outputPath, filename);
  fs.writeFileSync(filePath, mermaid, 'utf8');
  return filePath;
}

describe('VisualizationService - Debugging Process Test', () => {
  const outputDir = 'debug-graph-output';

  // Create a realistic debugging scenario
  const debuggingGraph = {
    nodes: [
      { 
        id: 'extract-debugging', 
        label: 'extractForDebugging', 
        file: 'src/agent/tools/extractCodeTool.ts', 
        line: 245,
        kind: 'symbol' as const,
        badges: ['error']
      },
      { 
        id: 'graph-compressor', 
        label: 'GraphCompressor', 
        file: 'src/agent/tools/debugging/GraphCompressor.ts', 
        kind: 'file' as const 
      },
      { 
        id: 'compress-graph', 
        label: 'compressGraph', 
        file: 'src/agent/tools/debugging/GraphCompressor.ts', 
        line: 120,
        kind: 'symbol' as const 
      },
      { 
        id: 'static-slicer', 
        label: 'StaticSlicer', 
        file: 'src/agent/tools/debugging/StaticSlicer.ts', 
        kind: 'file' as const 
      },
      { 
        id: 'slice-graph', 
        label: 'sliceGraph', 
        file: 'src/agent/tools/debugging/StaticSlicer.ts', 
        line: 85,
        kind: 'symbol' as const 
      },
      { 
        id: 'search-planner', 
        label: 'SearchPlanner', 
        file: 'src/agent/tools/debugging/SearchPlanner.ts', 
        kind: 'file' as const 
      },
      { 
        id: 'make-search-plan', 
        label: 'makeSearchPlan', 
        file: 'src/agent/tools/debugging/SearchPlanner.ts', 
        line: 156,
        kind: 'symbol' as const 
      },
      { 
        id: 'visualization-service', 
        label: 'VisualizationService', 
        file: 'src/agent/tools/debugging/VisualizationService.ts', 
        kind: 'file' as const 
      },
      { 
        id: 'generate-visualization', 
        label: 'generateVisualization', 
        file: 'src/agent/tools/debugging/VisualizationService.ts', 
        line: 34,
        kind: 'symbol' as const 
      },
      { 
        id: 'root-cause-analyzer', 
        label: 'RootCauseAnalyzer', 
        file: 'src/agent/tools/debugging/RootCauseAnalyzer.ts', 
        kind: 'file' as const 
      },
      { 
        id: 'analyze-root-cause', 
        label: 'analyzeRootCause', 
        file: 'src/agent/tools/debugging/RootCauseAnalyzer.ts', 
        line: 92,
        kind: 'symbol' as const 
      }
    ],
    edges: [
      { from: 'extract-debugging', to: 'graph-compressor', kind: 'calls' as const, confidence: 0.9 },
      { from: 'extract-debugging', to: 'compress-graph', kind: 'calls' as const, confidence: 0.95 },
      { from: 'compress-graph', to: 'static-slicer', kind: 'calls' as const, confidence: 0.85 },
      { from: 'compress-graph', to: 'slice-graph', kind: 'calls' as const, confidence: 0.88 },
      { from: 'extract-debugging', to: 'search-planner', kind: 'calls' as const, confidence: 0.8 },
      { from: 'extract-debugging', to: 'make-search-plan', kind: 'calls' as const, confidence: 0.82 },
      { from: 'extract-debugging', to: 'visualization-service', kind: 'calls' as const, confidence: 0.75 },
      { from: 'extract-debugging', to: 'generate-visualization', kind: 'calls' as const, confidence: 0.78 },
      { from: 'make-search-plan', to: 'root-cause-analyzer', kind: 'calls' as const, confidence: 0.7 },
      { from: 'make-search-plan', to: 'analyze-root-cause', kind: 'calls' as const, confidence: 0.72 },
      { from: 'generate-visualization', to: 'root-cause-analyzer', kind: 'calls' as const, confidence: 0.65 }
    ]
  };

  const debuggingReport: RootCauseReport = {
    summary: 'Debugging process execution flow showing how code extraction triggers graph compression, slicing, search planning, and visualization',
    likelyRootCause: 'Error in extractForDebugging function in extractCodeTool.ts at line 245',
    reasoningSteps: [
      'extractForDebugging initiates the debugging flow',
      'GraphCompressor.compressGraph reduces graph complexity',
      'StaticSlicer.sliceGraph creates focused slices',
      'SearchPlanner.makeSearchPlan generates search strategy',
      'VisualizationService.generateVisualization creates mermaid graph',
      'RootCauseAnalyzer.analyzeRootCause determines likely causes'
    ],
    recommendedFix: 'Check extractForDebugging implementation and ensure proper error handling',
    evidence: [
      'Stack trace shows error in extractForDebugging',
      'Graph compression and slicing completed successfully',
      'Search plan generated with high confidence',
      'Visualization generated successfully'
    ],
    confidence: 0.85,
    hypotheses: [],
    confidenceSummaryTable: '| Component | Confidence |\n|-----------|------------|\n| extractForDebugging | 0.9 |\n| GraphCompressor | 0.85 |\n| StaticSlicer | 0.88 |\n| SearchPlanner | 0.82 |\n| VisualizationService | 0.78 |',
    timings: { total: 2500, extraction: 800, compression: 400, slicing: 300, planning: 500, visualization: 500 }
  };

  describe('without LLM (deterministic)', () => {
    beforeEach(() => {
      jest.setTimeout(30000); // Increase timeout to 30 seconds for mermaid validation
    });

    it('should generate mermaid graph for debugging process and save it', async () => {
      const service = new VisualizationService(mockLLMProvider);
      
      const result = await service.generateVisualization(
        debuggingGraph,
        debuggingReport,
        'hard-error',
        'gpt-4'
      );

      // Verify basic structure
      expect(result.mermaid).toContain('flowchart TD');
      expect(result.meta.mode).toBe('hard-error');
      expect(result.meta.source).toBe('deterministic');
      expect(result.meta.nodeCount).toBeGreaterThan(0);
      expect(result.meta.edgeCount).toBeGreaterThanOrEqual(0);
      expect(result.meta.truncated).toBe(false);

      // Verify at least one key node is present (IDs are normalized: hyphens -> underscores)
      expect(result.mermaid).toContain('make_search_plan["makeSearchPlan"]');

      // Verify new structured return contract
      expect(result.isValid).toBeDefined();
      expect(Array.isArray(result.diagnostics)).toBe(true);
      expect(result.sourceGraphVersion).toBeDefined();
      expect(result.sourceGraphVersion).toBe('1.0.0');

      // Save mermaid graph
      const filePath = saveMermaidGraph(
        result.mermaid,
        'debugging-process-deterministic.mmd',
        outputDir
      );

      console.log(`✅ Mermaid graph saved to: ${filePath}`);
      console.log(`   Node count: ${result.meta.nodeCount}`);
      console.log(`   Edge count: ${result.meta.edgeCount}`);
      console.log(`   Source: ${result.meta.source}`);
      console.log(`   Is Valid: ${result.isValid}`);
      console.log(`   Diagnostics count: ${result.diagnostics.length}`);
      console.log(`   Version: ${result.sourceGraphVersion}`);
      
      // Also save as HTML for easy viewing
      const htmlPath = path.join(outputDir, 'debugging-process-deterministic.html');
      const html = generateHTMLVisualization(result.mermaid, result.isValid, result.diagnostics);
      fs.writeFileSync(htmlPath, html, 'utf8');
      console.log(`✅ HTML visualization saved to: ${htmlPath}`);
    });
  });

  describe('with actual LLM (if API key available)', () => {
    const realLLMProvider = createRealLLMProvider();
    const testSuffix = realLLMProvider ? '' : ' (skipped - no GEMINI_API_KEY)';

    beforeEach(() => {
      jest.setTimeout(60000); // Increase timeout to 60 seconds for LLM calls
    });

    it(`should generate mermaid graph with LLM beautification and save it${testSuffix}`, async () => {
      if (!realLLMProvider) {
        console.log('⏭️  Skipping LLM test - GEMINI_API_KEY not set');
        return;
      }

      const service = new VisualizationService(realLLMProvider);
      
      const result = await service.generateVisualization(
        debuggingGraph,
        debuggingReport,
        'hard-error',
        'gemini-2.0-flash-exp'
      );

      // Verify basic structure
      expect(result.mermaid).toContain('flowchart TD');
      expect(result.meta.mode).toBe('hard-error');
      expect(result.meta.nodeCount).toBe(11);
      expect(result.meta.edgeCount).toBe(11);

      // Source should be deterministic (no LLM calls in core path)
      expect(result.meta.source).toBe('deterministic');

      // Verify key nodes are present
      expect(result.mermaid).toContain('extract-debugging');
      expect(result.mermaid).toContain('graph-compressor');
      expect(result.mermaid).toContain('generate-visualization');

      // Verify new structured return contract
      expect(result.isValid).toBeDefined();
      expect(Array.isArray(result.diagnostics)).toBe(true);
      expect(result.sourceGraphVersion).toBeDefined();

      // Save mermaid graph
      const filePath = saveMermaidGraph(
        result.mermaid,
        'debugging-process-with-llm.mmd',
        outputDir
      );

      console.log(`✅ Mermaid graph saved to: ${filePath}`);
      console.log(`   Node count: ${result.meta.nodeCount}`);
      console.log(`   Edge count: ${result.meta.edgeCount}`);
      console.log(`   Source: ${result.meta.source}`);
      console.log(`   Is Valid: ${result.isValid}`);
      console.log(`   Diagnostics count: ${result.diagnostics.length}`);
      console.log(`   Version: ${result.sourceGraphVersion}`);
      
      // Also save as HTML for easy viewing
      const htmlPath = path.join(outputDir, 'debugging-process-with-llm.html');
      const html = generateHTMLVisualization(result.mermaid, result.isValid, result.diagnostics);
      fs.writeFileSync(htmlPath, html, 'utf8');
      console.log(`✅ HTML visualization saved to: ${htmlPath}`);
    });
  });

  describe('complex full-stack application scenario', () => {
    beforeEach(() => {
      jest.setTimeout(30000);
    });

    it('should generate mermaid graph with all node types (UI, API, Data, Auth, Infra) and show role-based styling', async () => {
      // Complex full-stack application graph
      const complexGraph = {
        nodes: [
          // UI Nodes (React/Next.js)
          { 
            id: 'user-page', 
            label: 'UserPage', 
            file: 'src/app/users/page.tsx', 
            kind: 'file' as const,
            line: 1
          },
          { 
            id: 'user-component', 
            label: 'UserComponent', 
            file: 'src/components/UserComponent.tsx', 
            kind: 'file' as const,
            line: 15
          },
          { 
            id: 'profile-page', 
            label: 'ProfilePage', 
            file: 'src/pages/profile.tsx', 
            kind: 'file' as const,
            line: 42
          },
          
          // API Nodes (Next.js API routes)
          { 
            id: 'api-users', 
            label: 'GET /api/users', 
            file: 'src/pages/api/users.ts', 
            kind: 'file' as const,
            line: 8,
            badges: ['error']
          },
          { 
            id: 'api-user-handler', 
            label: 'handler', 
            file: 'src/pages/api/users.ts', 
            kind: 'symbol' as const,
            line: 25
          },
          { 
            id: 'api-profile', 
            label: 'GET /api/profile', 
            file: 'src/app/api/profile/route.ts', 
            kind: 'file' as const,
            line: 12
          },
          
          // Data Nodes (Prisma/DB)
          { 
            id: 'db-prisma', 
            label: 'prisma', 
            file: 'src/db/prisma.ts', 
            kind: 'file' as const,
            line: 1
          },
          { 
            id: 'db-client', 
            label: 'dbClient', 
            file: 'src/db/prisma.ts', 
            kind: 'symbol' as const,
            line: 15
          },
          { 
            id: 'user-repo', 
            label: 'UserRepository', 
            file: 'src/repository/UserRepository.ts', 
            kind: 'file' as const,
            line: 20
          },
          { 
            id: 'find-user', 
            label: 'findUser', 
            file: 'src/repository/UserRepository.ts', 
            kind: 'symbol' as const,
            line: 45
          },
          
          // Auth Nodes
          { 
            id: 'auth-middleware', 
            label: 'authMiddleware', 
            file: 'src/middleware.ts', 
            kind: 'file' as const,
            line: 10
          },
          { 
            id: 'auth-helper', 
            label: 'authHelper', 
            file: 'src/auth.ts', 
            kind: 'file' as const,
            line: 25
          },
          { 
            id: 'verify-token', 
            label: 'verifyToken', 
            file: 'src/auth.ts', 
            kind: 'symbol' as const,
            line: 50
          },
          
          // Infra Nodes
          { 
            id: 'http-client', 
            label: 'httpClient', 
            file: 'src/lib/httpClient.ts', 
            kind: 'file' as const,
            line: 5
          },
          { 
            id: 'user-service', 
            label: 'UserService', 
            file: 'src/services/UserService.ts', 
            kind: 'file' as const,
            line: 30
          },
          { 
            id: 'logger-util', 
            label: 'logger', 
            file: 'src/utils/logger.ts', 
            kind: 'file' as const,
            line: 12
          }
        ],
        edges: [
          // UI to API
          { from: 'user-page', to: 'api-users', kind: 'calls' as const, confidence: 0.95 },
          { from: 'user-component', to: 'api-users', kind: 'calls' as const, confidence: 0.9 },
          { from: 'profile-page', to: 'api-profile', kind: 'calls' as const, confidence: 0.88 },
          
          // API internal
          { from: 'api-users', to: 'api-user-handler', kind: 'calls' as const, confidence: 0.98 },
          { from: 'api-user-handler', to: 'user-service', kind: 'calls' as const, confidence: 0.85 },
          { from: 'api-profile', to: 'auth-middleware', kind: 'calls' as const, confidence: 0.9 },
          
          // API to Data
          { from: 'api-user-handler', to: 'user-repo', kind: 'calls' as const, confidence: 0.92 },
          { from: 'user-repo', to: 'find-user', kind: 'calls' as const, confidence: 0.95 },
          { from: 'find-user', to: 'db-client', kind: 'calls' as const, confidence: 0.98 },
          { from: 'db-client', to: 'db-prisma', kind: 'calls' as const, confidence: 0.99 },
          
          // Auth flow
          { from: 'api-profile', to: 'auth-helper', kind: 'calls' as const, confidence: 0.87 },
          { from: 'auth-helper', to: 'verify-token', kind: 'calls' as const, confidence: 0.93 },
          { from: 'auth-middleware', to: 'verify-token', kind: 'calls' as const, confidence: 0.91 },
          
          // Infra connections
          { from: 'user-service', to: 'http-client', kind: 'calls' as const, confidence: 0.8 },
          { from: 'api-user-handler', to: 'logger-util', kind: 'calls' as const, confidence: 0.75 },
          { from: 'user-repo', to: 'logger-util', kind: 'calls' as const, confidence: 0.7 }
        ]
      };

      const complexReport: RootCauseReport = {
        summary: 'Complex full-stack application flow showing UI components calling API routes, which interact with database through repositories, with auth middleware and infrastructure services',
        likelyRootCause: 'Error in GET /api/users handler at line 25 in src/pages/api/users.ts',
        reasoningSteps: [
          'UserPage component calls GET /api/users',
          'API route handler processes request',
          'Handler calls UserService which uses httpClient',
          'Service calls UserRepository',
          'Repository queries database via Prisma client',
          'Error occurs in handler before database query completes'
        ],
        recommendedFix: 'Check error handling in api-user-handler and verify database connection',
        evidence: [
          'Stack trace shows error in api-users handler',
          'UserPage successfully called API',
          'Database connection is active',
          'Auth middleware passed'
        ],
        confidence: 0.88,
        hypotheses: [],
        confidenceSummaryTable: '| Component | Confidence |\n|-----------|------------|\n| api-users | 0.95 |\n| user-service | 0.85 |\n| user-repo | 0.92 |',
        timings: { total: 3200, api: 1200, data: 800, auth: 400, infra: 800 }
      };

      const service = new VisualizationService(mockLLMProvider);
      
      const result = await service.generateVisualization(
        complexGraph,
        complexReport,
        'hard-error',
        'gpt-4'
      );

      // Verify basic structure
      expect(result.mermaid).toContain('flowchart TD');
      expect(result.meta.mode).toBe('hard-error');
      expect(result.meta.source).toBe('deterministic');
      expect(result.meta.nodeCount).toBe(16);
      expect(result.meta.edgeCount).toBeGreaterThanOrEqual(15); // May vary after normalization

      // Verify role-based class definitions are present
      expect(result.mermaid).toContain('classDef ui');
      expect(result.mermaid).toContain('classDef api');
      expect(result.mermaid).toContain('classDef data');
      expect(result.mermaid).toContain('classDef auth');
      expect(result.mermaid).toContain('classDef infra');
      expect(result.mermaid).toContain('color:#111827');
      expect(result.mermaid).toContain('linkStyle default stroke:#94a3b8,color:#334155;');
      expect(result.mermaid).not.toContain('var(');

      // Verify UI nodes are classified and styled
      expect(result.mermaid).toMatch(/user_page\[.*\]:::ui/);
      expect(result.mermaid).toMatch(/user_component\[.*\]:::ui/);
      expect(result.mermaid).toMatch(/profile_page\[.*\]:::ui/);

      // Verify API nodes are classified
      expect(result.mermaid).toMatch(/api_users\[.*\]:::api/);
      expect(result.mermaid).toMatch(/api_profile\[.*\]:::api/);

      // Verify Data nodes are classified
      expect(result.mermaid).toMatch(/db_prisma\[.*\]:::data/);
      expect(result.mermaid).toMatch(/user_repo\[.*\]:::data/);

      // Verify Auth nodes are classified
      expect(result.mermaid).toMatch(/auth_middleware\[.*\]:::auth/);
      expect(result.mermaid).toMatch(/auth_helper\[.*\]:::auth/);

      // Verify Infra nodes are classified
      expect(result.mermaid).toMatch(/user_service\[.*\]:::infra/);
      expect(result.mermaid).toMatch(/logger_util\[.*\]:::infra/);

      // Verify error badge styling on api-users
      expect(result.mermaid).toContain('style api_users');

      // Verify structured return contract
      expect(result.isValid).toBe(true);
      expect(Array.isArray(result.diagnostics)).toBe(true);
      expect(result.sourceGraphVersion).toBe('1.0.0');

      // Save mermaid graph
      const filePath = saveMermaidGraph(
        result.mermaid,
        'complex-fullstack-app.mmd',
        outputDir
      );

      console.log(`\n✅ Complex full-stack graph saved to: ${filePath}`);
      console.log(`   Node count: ${result.meta.nodeCount}`);
      console.log(`   Edge count: ${result.meta.edgeCount}`);
      console.log(`   Source: ${result.meta.source}`);
      console.log(`   Is Valid: ${result.isValid}`);
      console.log(`   Diagnostics count: ${result.diagnostics.length}`);
      console.log(`   Version: ${result.sourceGraphVersion}`);
      
      // Count role classifications
      const uiCount = (result.mermaid.match(/:::ui/g) || []).length;
      const apiCount = (result.mermaid.match(/:::api/g) || []).length;
      const dataCount = (result.mermaid.match(/:::data/g) || []).length;
      const authCount = (result.mermaid.match(/:::auth/g) || []).length;
      const infraCount = (result.mermaid.match(/:::infra/g) || []).length;
      
      console.log(`\n📊 Role Classification Summary:`);
      console.log(`   UI nodes: ${uiCount}`);
      console.log(`   API nodes: ${apiCount}`);
      console.log(`   Data nodes: ${dataCount}`);
      console.log(`   Auth nodes: ${authCount}`);
      console.log(`   Infra nodes: ${infraCount}`);
      
      // Also save as HTML for easy viewing
      const htmlPath = path.join(outputDir, 'complex-fullstack-app.html');
      const html = generateHTMLVisualization(result.mermaid, result.isValid, result.diagnostics);
      fs.writeFileSync(htmlPath, html, 'utf8');
      console.log(`✅ HTML visualization saved to: ${htmlPath}\n`);
    });
  });
});

// Helper to generate HTML visualization with Mermaid
function generateHTMLVisualization(mermaid: string, isValid: boolean, diagnostics: any[]): string {
  const diagnosticsHtml = diagnostics.length > 0
    ? `<div class="diagnostics">
        <h3>Diagnostics (${diagnostics.length})</h3>
        <ul>
          ${diagnostics.map(d => `
            <li>
              <strong>${d.code || 'INFO'}:</strong> ${d.message || d}
              ${d.detail ? ` <em>(${d.detail})</em>` : ''}
            </li>
          `).join('')}
        </ul>
      </div>`
    : '<div class="diagnostics"><p>No diagnostics</p></div>';

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Debugging Process Visualization</title>
  <script src="https://cdn.jsdelivr.net/npm/mermaid/dist/mermaid.min.js"></script>
  <style>
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      margin: 20px;
      background: #1a1a1a;
      color: #e0e0e0;
    }
    .container {
      max-width: 1200px;
      margin: 0 auto;
    }
    .status {
      padding: 10px;
      border-radius: 5px;
      margin-bottom: 20px;
      ${isValid ? 'background: #22c55e; color: white;' : 'background: #ef4444; color: white;'}
    }
    .mermaid-container {
      background: white;
      padding: 20px;
      border-radius: 8px;
      margin-bottom: 20px;
    }
    .diagnostics {
      background: #2a2a2a;
      padding: 15px;
      border-radius: 5px;
      margin-top: 20px;
    }
    .diagnostics h3 {
      margin-top: 0;
    }
    .diagnostics ul {
      list-style: none;
      padding-left: 0;
    }
    .diagnostics li {
      padding: 5px 0;
      border-bottom: 1px solid #444;
    }
    .diagnostics li:last-child {
      border-bottom: none;
    }
    .diagnostics em {
      color: #888;
    }
    pre {
      background: #0f0f0f;
      padding: 15px;
      border-radius: 5px;
      overflow-x: auto;
      font-size: 12px;
    }
  </style>
</head>
<body>
  <div class="container">
    <h1>Debugging Process Visualization</h1>
    <div class="status">
      Status: ${isValid ? '✅ Valid Mermaid' : '⚠️ Invalid Mermaid - showing best effort'}
    </div>
    <div class="mermaid-container">
      <div class="mermaid">
${mermaid}
      </div>
    </div>
    ${diagnosticsHtml}
    <div class="raw-mermaid">
      <h3>Raw Mermaid Code</h3>
      <pre><code>${mermaid}</code></pre>
    </div>
  </div>
  <script>
    mermaid.initialize({ 
      startOnLoad: true,
      theme: 'default',
      themeVariables: {
        fontFamily: 'monospace'
      }
    });
  </script>
</body>
</html>`;
}

