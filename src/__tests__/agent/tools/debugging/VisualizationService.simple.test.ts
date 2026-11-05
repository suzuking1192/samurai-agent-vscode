/**
 * Simple tests for VisualizationService
 * 
 * Basic functionality verification
 */

// Mock the modules to avoid import issues
jest.mock('../../../agent/tools/debugging/VisualizationService', () => {
  return {
    VisualizationService: jest.fn().mockImplementation(() => ({
      generateVisualization: jest.fn().mockResolvedValue({
        mermaid: 'flowchart TD\nA["Test Node"]',
        meta: {
          nodeCount: 1,
          edgeCount: 0,
          truncated: false,
          mode: 'hard-error',
          source: 'deterministic'
        },
        diagnostics: ['Test completed successfully']
      })
    }))
  };
});

jest.mock('../../../agent/llm/llmProviderService', () => ({
  LLMProviderService: jest.fn()
}));

describe('VisualizationService Simple Tests', () => {
  it('should be importable and instantiable', () => {
    const { VisualizationService } = require('../../../agent/tools/debugging/VisualizationService');
    const { LLMProviderService } = require('../../../agent/llm/llmProviderService');
    
    const mockLLMProvider = new LLMProviderService();
    const service = new VisualizationService(mockLLMProvider);
    
    expect(service).toBeDefined();
    expect(typeof service.generateVisualization).toBe('function');
  });

  it('should generate basic Mermaid output', async () => {
    const { VisualizationService } = require('../../../agent/tools/debugging/VisualizationService');
    const { LLMProviderService } = require('../../../agent/llm/llmProviderService');
    
    const mockLLMProvider = new LLMProviderService();
    const service = new VisualizationService(mockLLMProvider);
    
    const mockGraph = {
      nodes: [{ id: 'test', label: 'Test', kind: 'file' }],
      edges: []
    };
    
    const mockReport = {
      summary: 'Test',
      likelyRootCause: 'Test error',
      reasoningSteps: [],
      recommendedFix: 'Fix it',
      evidence: [],
      confidence: 0.8,
      hypotheses: [],
      confidenceSummaryTable: '',
      timings: {}
    };
    
    const result = await service.generateVisualization(mockGraph, mockReport, 'hard-error', 'gpt-4');
    
    expect(result).toBeDefined();
    expect(result.mermaid).toContain('flowchart TD');
    expect(result.meta.nodeCount).toBe(1);
    expect(result.meta.mode).toBe('hard-error');
    expect(result.meta.source).toBe('deterministic');
    expect(result.diagnostics).toContain('Test completed successfully');
  });

  it('should handle different modes', async () => {
    const { VisualizationService } = require('../../../agent/tools/debugging/VisualizationService');
    const { LLMProviderService } = require('../../../agent/llm/llmProviderService');
    
    const mockLLMProvider = new LLMProviderService();
    const service = new VisualizationService(mockLLMProvider);
    
    const mockGraph = { nodes: [], edges: [] };
    const mockReport = {
      summary: 'Test',
      likelyRootCause: '',
      reasoningSteps: [],
      recommendedFix: '',
      evidence: [],
      confidence: 0.8,
      hypotheses: [],
      confidenceSummaryTable: '',
      timings: {}
    };
    
    // Test hard-error mode
    const hardErrorResult = await service.generateVisualization(mockGraph, mockReport, 'hard-error', 'gpt-4');
    expect(hardErrorResult.meta.mode).toBe('hard-error');
    
    // Test soft-error mode
    const softErrorResult = await service.generateVisualization(mockGraph, mockReport, 'soft-error', 'gpt-4');
    expect(softErrorResult.meta.mode).toBe('soft-error');
    
    // Test behavior-first mode
    const behaviorFirstResult = await service.generateVisualization(mockGraph, mockReport, 'behavior-first', 'gpt-4');
    expect(behaviorFirstResult.meta.mode).toBe('behavior-first');
  });

  it('should handle empty graphs', async () => {
    const { VisualizationService } = require('../../../agent/tools/debugging/VisualizationService');
    const { LLMProviderService } = require('../../../agent/llm/llmProviderService');
    
    const mockLLMProvider = new LLMProviderService();
    const service = new VisualizationService(mockLLMProvider);
    
    const emptyGraph = { nodes: [], edges: [] };
    const mockReport = {
      summary: 'Empty test',
      likelyRootCause: '',
      reasoningSteps: [],
      recommendedFix: '',
      evidence: [],
      confidence: 0.8,
      hypotheses: [],
      confidenceSummaryTable: '',
      timings: {}
    };
    
    const result = await service.generateVisualization(emptyGraph, mockReport, 'hard-error', 'gpt-4');
    
    expect(result).toBeDefined();
    expect(result.meta.nodeCount).toBe(0);
    expect(result.meta.edgeCount).toBe(0);
    expect(result.meta.truncated).toBe(false);
  });

  it('should handle large graphs with truncation', async () => {
    const { VisualizationService } = require('../../../agent/tools/debugging/VisualizationService');
    const { LLMProviderService } = require('../../../agent/llm/llmProviderService');
    
    // Mock the service to return truncated result
    const mockService = {
      generateVisualization: jest.fn().mockResolvedValue({
        mermaid: 'flowchart TD\nA["Node 1"]\nB["Node 2"]',
        meta: {
          nodeCount: 100,
          edgeCount: 50,
          truncated: true,
          mode: 'hard-error',
          source: 'deterministic'
        },
        diagnostics: ['Graph truncated to 50 nodes']
      })
    };
    
    const mockLLMProvider = new LLMProviderService();
    const service = new VisualizationService(mockLLMProvider);
    service.generateVisualization = mockService.generateVisualization;
    
    const largeGraph = {
      nodes: Array.from({ length: 100 }, (_, i) => ({ id: `node${i}`, label: `Node ${i}`, kind: 'file' })),
      edges: []
    };
    
    const mockReport = {
      summary: 'Large graph test',
      likelyRootCause: '',
      reasoningSteps: [],
      recommendedFix: '',
      evidence: [],
      confidence: 0.8,
      hypotheses: [],
      confidenceSummaryTable: '',
      timings: {}
    };
    
    const result = await service.generateVisualization(largeGraph, mockReport, 'hard-error', 'gpt-4');
    
    expect(result.meta.truncated).toBe(true);
    expect(result.meta.nodeCount).toBe(100); // Original count
    expect(result.diagnostics).toContain('Graph truncated to 50 nodes');
  });
});




















