/**
 * Test for VisualizationService.generateVisualization
 * 
 * Tests visualization generation with a debugging process scenario,
 * both with and without actual LLM, and saves the mermaid graph.
 */

import * as fs from 'fs';
import * as path from 'path';
import { VisualizationService } from '../../../agent/tools/debugging/VisualizationService';
import { LLMProviderService } from '../../../agent/llm/llmProviderService';
import { GraphNode, GraphEdge } from '../../../agent/tools/debugging/types';
import { RootCauseReport } from '../../../agent/tools/debugging/rootCauseTypes';

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

  const { GeminiChatClient } = require('../../../agent/llm/GeminiChatClient');
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
      expect(result.meta.nodeCount).toBe(11);
      expect(result.meta.edgeCount).toBe(11);
      expect(result.meta.truncated).toBe(false);

      // Verify key nodes are present
      expect(result.mermaid).toContain('extract-debugging["extractForDebugging"]');
      expect(result.mermaid).toContain('graph-compressor["GraphCompressor"]');
      expect(result.mermaid).toContain('generate-visualization["generateVisualization"]');

      // Verify suspect highlighting (extract-debugging should be highlighted)
      expect(result.mermaid).toContain('style extract-debugging fill:#ff6b6b,stroke:#b30000,stroke-width:2px');

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
      console.log(`   Diagnostics: ${result.diagnostics.length > 0 ? result.diagnostics.join(', ') : 'none'}`);
    });
  });

  describe('with actual LLM (if API key available)', () => {
    const realLLMProvider = createRealLLMProvider();
    const testSuffix = realLLMProvider ? '' : ' (skipped - no GEMINI_API_KEY)';

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

      // Source could be either deterministic or llm_beautified depending on validation
      expect(['deterministic', 'llm_beautified']).toContain(result.meta.source);

      // Verify key nodes are present
      expect(result.mermaid).toContain('extract-debugging');
      expect(result.mermaid).toContain('graph-compressor');
      expect(result.mermaid).toContain('generate-visualization');

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
      console.log(`   Diagnostics: ${result.diagnostics.length > 0 ? result.diagnostics.join(', ') : 'none'}`);
    });
  });
});

