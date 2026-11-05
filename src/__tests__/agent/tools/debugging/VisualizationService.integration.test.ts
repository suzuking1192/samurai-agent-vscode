/**
 * Integration tests for VisualizationService
 * 
 * Tests the complete flow from execution graph to rendered Mermaid
 */

import { VisualizationService } from '../../../agent/tools/debugging/VisualizationService.js';
import { LLMProviderService } from '../../../agent/llm/llmProviderService.js';
import { GraphNode, GraphEdge } from '../../../agent/tools/debugging/types.js';
import { RootCauseReport } from '../../../agent/tools/debugging/rootCauseTypes.js';

// Mock LLM provider with realistic responses
const mockLLMProvider = {
  chat: jest.fn()
} as unknown as LLMProviderService;

describe('VisualizationService Integration Tests', () => {
  let service: VisualizationService;
  
  beforeEach(() => {
    service = new VisualizationService(mockLLMProvider);
    jest.clearAllMocks();
  });

  describe('Complete Visualization Flow', () => {
    it('should generate valid Mermaid for a typical debugging scenario', async () => {
      // Create a realistic debugging scenario
      const graph = {
        nodes: [
          { 
            id: 'user-controller', 
            label: 'UserController.ts', 
            file: 'src/controllers/UserController.ts', 
            kind: 'file' as const,
            badges: ['error']
          },
          { 
            id: 'get-user', 
            label: 'getUser()', 
            file: 'src/controllers/UserController.ts', 
            line: 25, 
            kind: 'symbol' as const 
          },
          { 
            id: 'user-service', 
            label: 'UserService.ts', 
            file: 'src/services/UserService.ts', 
            kind: 'file' as const 
          },
          { 
            id: 'find-user', 
            label: 'findUser()', 
            file: 'src/services/UserService.ts', 
            line: 42, 
            kind: 'symbol' as const 
          },
          { 
            id: 'database', 
            label: 'Database.ts', 
            file: 'src/database/Database.ts', 
            kind: 'file' as const 
          }
        ],
        edges: [
          { from: 'user-controller', to: 'get-user', kind: 'calls' as const, confidence: 0.9 },
          { from: 'get-user', to: 'user-service', kind: 'calls' as const, confidence: 0.8 },
          { from: 'user-service', to: 'find-user', kind: 'calls' as const, confidence: 0.7 },
          { from: 'find-user', to: 'database', kind: 'calls' as const, confidence: 0.6 },
          { from: 'user-controller', to: 'user-service', kind: 'imports' as const, confidence: 0.5 }
        ]
      };
      
      const report: RootCauseReport = {
        summary: 'User authentication is failing',
        likelyRootCause: 'Error in UserController.ts at line 25 in getUser() function',
        reasoningSteps: ['User clicks login', 'getUser() is called', 'Database query fails'],
        recommendedFix: 'Check database connection and query parameters',
        evidence: ['Stack trace shows getUser() error', 'Database timeout in logs'],
        confidence: 0.85,
        hypotheses: [],
        confidenceSummaryTable: '| Component | Confidence |\n|-----------|------------|\n| UserController | 0.9 |',
        timings: { total: 1500, evidence: 200, hypothesis: 300, testing: 1000 }
      };
      
      const result = await service.generateVisualization(graph, report, 'hard-error', 'gpt-4');
      
      // Verify basic structure
      expect(result.mermaid).toContain('flowchart TD');
      expect(result.meta.mode).toBe('hard-error');
      expect(result.meta.source).toBe('deterministic');
      expect(result.meta.nodeCount).toBe(5);
      expect(result.meta.edgeCount).toBe(5);
      expect(result.meta.truncated).toBe(false);
      
      // Verify node definitions
      expect(result.mermaid).toContain('user-controller["UserController.ts"]');
      expect(result.mermaid).toContain('get-user["getUser()"]');
      expect(result.mermaid).toContain('user-service["UserService.ts"]');
      expect(result.mermaid).toContain('find-user["findUser()"]');
      expect(result.mermaid).toContain('database["Database.ts"]');
      
      // Verify edge definitions
      expect(result.mermaid).toContain('user-controller -->|calls| get-user');
      expect(result.mermaid).toContain('get-user -->|calls| user-service');
      expect(result.mermaid).toContain('user-controller -.->|imports| user-service');
      
      // Verify suspect highlighting (getUser should be highlighted)
      expect(result.mermaid).toContain('style get-user fill:#ff6b6b,stroke:#b30000,stroke-width:2px');
      
      // Verify error badge styling
      expect(result.mermaid).toContain('style user-controller stroke:#ff6b6b,stroke-dasharray:4 2');
    });

    it('should handle large graphs by truncating to 50 nodes', async () => {
      // Create a large graph with 60 nodes
      const nodes: GraphNode[] = [];
      const edges: GraphEdge[] = [];
      
      for (let i = 0; i < 60; i++) {
        nodes.push({
          id: `node${i}`,
          label: `Node ${i}`,
          file: `src/file${i}.ts`,
          kind: 'file' as const,
          badges: i < 5 ? ['error'] : undefined
        });
        
        if (i > 0) {
          edges.push({
            from: `node${i-1}`,
            to: `node${i}`,
            kind: 'calls' as const,
            confidence: 0.8
          });
        }
      }
      
      const graph = { nodes, edges };
      const report: RootCauseReport = {
        summary: 'Large graph test',
        likelyRootCause: 'Error in node0',
        reasoningSteps: [],
        recommendedFix: 'Fix the error',
        evidence: [],
        confidence: 0.8,
        hypotheses: [],
        confidenceSummaryTable: '',
        timings: {}
      };
      
      const result = await service.generateVisualization(graph, report, 'hard-error', 'gpt-4');
      
      expect(result.meta.truncated).toBe(true);
      expect(result.meta.nodeCount).toBe(60); // Original count
      
      // Should contain exactly 50 node definitions
      const nodeLines = result.mermaid.split('\n').filter(line => line.includes('['));
      expect(nodeLines).toHaveLength(50);
      
      // Should prioritize error badges (first 5 nodes)
      expect(result.mermaid).toContain('node0["Node 0"]');
      expect(result.mermaid).toContain('node4["Node 4"]');
      expect(result.mermaid).not.toContain('node50["Node 50"]');
    });

    it('should handle different modes with appropriate highlighting', async () => {
      const graph = {
        nodes: [
          { id: 'route', label: 'userRoute.ts', file: 'src/routes/userRoute.ts', kind: 'file' as const, badges: ['routeHandler'] },
          { id: 'handler', label: 'handleRequest()', file: 'src/routes/userRoute.ts', line: 15, kind: 'symbol' as const },
          { id: 'service', label: 'UserService.ts', file: 'src/services/UserService.ts', kind: 'file' as const },
          { id: 'error', label: 'ErrorHandler.ts', file: 'src/utils/ErrorHandler.ts', kind: 'file' as const, badges: ['error'] }
        ],
        edges: [
          { from: 'route', to: 'handler', kind: 'calls' as const, confidence: 0.9 },
          { from: 'handler', to: 'service', kind: 'calls' as const, confidence: 0.8 },
          { from: 'service', to: 'error', kind: 'calls' as const, confidence: 0.7 }
        ]
      };
      
      const report: RootCauseReport = {
        summary: 'Mode test',
        likelyRootCause: 'Error in userRoute.ts',
        reasoningSteps: [],
        recommendedFix: 'Fix the error',
        evidence: [],
        confidence: 0.8,
        hypotheses: [],
        confidenceSummaryTable: '',
        timings: {}
      };
      
      // Test hard-error mode
      const hardErrorResult = await service.generateVisualization(graph, report, 'hard-error', 'gpt-4');
      expect(hardErrorResult.meta.mode).toBe('hard-error');
      expect(hardErrorResult.mermaid).toContain('style error fill:#ff8c42'); // Orange for error frames
      
      // Test soft-error mode
      const softErrorResult = await service.generateVisualization(graph, report, 'soft-error', 'gpt-4');
      expect(softErrorResult.meta.mode).toBe('soft-error');
      expect(softErrorResult.mermaid).toContain('style route fill:#4a9eff'); // Blue for route handlers
      
      // Test behavior-first mode
      const behaviorFirstResult = await service.generateVisualization(graph, report, 'behavior-first', 'gpt-4');
      expect(behaviorFirstResult.meta.mode).toBe('behavior-first');
      expect(behaviorFirstResult.mermaid).toContain('style route fill:#4a9eff'); // Blue for entrypoints
    });

    it('should sanitize problematic characters in labels', async () => {
      const graph = {
        nodes: [
          { id: 'problematic', label: 'File`with|bad{chars}', file: 'src/file.ts', kind: 'file' as const },
          { id: 'long', label: 'A'.repeat(100), file: 'src/long.ts', kind: 'file' as const }
        ],
        edges: []
      };
      
      const report: RootCauseReport = {
        summary: 'Sanitization test',
        likelyRootCause: 'Error in file',
        reasoningSteps: [],
        recommendedFix: 'Fix the error',
        evidence: [],
        confidence: 0.8,
        hypotheses: [],
        confidenceSummaryTable: '',
        timings: {}
      };
      
      const result = await service.generateVisualization(graph, report, 'hard-error', 'gpt-4');
      
      // Should not contain problematic characters
      expect(result.mermaid).not.toContain('`');
      expect(result.mermaid).not.toContain('|');
      expect(result.mermaid).not.toContain('{');
      expect(result.mermaid).not.toContain('}');
      
      // Should be truncated to 60 characters
      expect(result.mermaid).toContain('long["' + 'A'.repeat(60) + '"]');
    });

    it('should handle empty or invalid graphs gracefully', async () => {
      const emptyGraph = { nodes: [], edges: [] };
      const report: RootCauseReport = {
        summary: 'Empty graph test',
        likelyRootCause: 'No specific error',
        reasoningSteps: [],
        recommendedFix: 'No fix needed',
        evidence: [],
        confidence: 0.8,
        hypotheses: [],
        confidenceSummaryTable: '',
        timings: {}
      };
      
      const result = await service.generateVisualization(emptyGraph, report, 'hard-error', 'gpt-4');
      
      expect(result.mermaid).toContain('flowchart TD');
      expect(result.meta.nodeCount).toBe(0);
      expect(result.meta.edgeCount).toBe(0);
      expect(result.meta.truncated).toBe(false);
    });

    it('should handle LLM beautification failure gracefully', async () => {
      const graph = {
        nodes: [
          { id: 'node1', label: 'Test', file: 'src/test.ts', kind: 'file' as const }
        ],
        edges: []
      };
      
      const report: RootCauseReport = {
        summary: 'LLM failure test',
        likelyRootCause: 'Test error',
        reasoningSteps: [],
        recommendedFix: 'Fix it',
        evidence: [],
        confidence: 0.8,
        hypotheses: [],
        confidenceSummaryTable: '',
        timings: {}
      };
      
      // Mock LLM to throw error
      (mockLLMProvider.chat as jest.Mock).mockRejectedValue(new Error('LLM service unavailable'));
      
      const result = await service.generateVisualization(graph, report, 'hard-error', 'gpt-4');
      
      expect(result.meta.source).toBe('deterministic');
      expect(result.diagnostics).toContain('LLM beautification failed: LLM service unavailable');
      expect(result.mermaid).toContain('flowchart TD');
    });
  });

  describe('Suspect Extraction', () => {
    it('should extract suspects by file name matching', async () => {
      const graph = {
        nodes: [
          { id: 'user-ts', label: 'User.ts', file: 'src/User.ts', kind: 'file' as const },
          { id: 'auth-ts', label: 'Auth.ts', file: 'src/Auth.ts', kind: 'file' as const },
          { id: 'utils-ts', label: 'Utils.ts', file: 'src/Utils.ts', kind: 'file' as const }
        ],
        edges: []
      };
      
      const report: RootCauseReport = {
        summary: 'File matching test',
        likelyRootCause: 'Error in User.ts at line 15',
        reasoningSteps: [],
        recommendedFix: 'Fix the error',
        evidence: [],
        confidence: 0.8,
        hypotheses: [],
        confidenceSummaryTable: '',
        timings: {}
      };
      
      const result = await service.generateVisualization(graph, report, 'hard-error', 'gpt-4');
      
      // Should highlight user-ts node as suspect
      expect(result.mermaid).toContain('style user-ts fill:#ff6b6b,stroke:#b30000,stroke-width:2px');
      expect(result.mermaid).not.toContain('style auth-ts fill:#ff6b6b');
    });

    it('should extract suspects by function name matching', async () => {
      const graph = {
        nodes: [
          { id: 'get-user', label: 'getUser()', file: 'src/User.ts', kind: 'symbol' as const },
          { id: 'set-user', label: 'setUser()', file: 'src/User.ts', kind: 'symbol' as const },
          { id: 'validate', label: 'validate()', file: 'src/User.ts', kind: 'symbol' as const }
        ],
        edges: []
      };
      
      const report: RootCauseReport = {
        summary: 'Function matching test',
        likelyRootCause: 'getUser() function is throwing an error',
        reasoningSteps: [],
        recommendedFix: 'Fix the error',
        evidence: [],
        confidence: 0.8,
        hypotheses: [],
        confidenceSummaryTable: '',
        timings: {}
      };
      
      const result = await service.generateVisualization(graph, report, 'hard-error', 'gpt-4');
      
      // Should highlight get-user node as suspect
      expect(result.mermaid).toContain('style get-user fill:#ff6b6b,stroke:#b30000,stroke-width:2px');
      expect(result.mermaid).not.toContain('style set-user fill:#ff6b6b');
    });
  });

  describe('Edge Styling', () => {
    it('should style edges based on type and confidence', async () => {
      const graph = {
        nodes: [
          { id: 'node1', label: 'Node1', kind: 'file' as const },
          { id: 'node2', label: 'Node2', kind: 'file' as const },
          { id: 'node3', label: 'Node3', kind: 'file' as const }
        ],
        edges: [
          { from: 'node1', to: 'node2', kind: 'calls' as const, confidence: 0.9 },
          { from: 'node2', to: 'node3', kind: 'imports' as const, confidence: 0.5 }
        ]
      };
      
      const report: RootCauseReport = {
        summary: 'Edge styling test',
        likelyRootCause: 'Test error',
        reasoningSteps: [],
        recommendedFix: 'Fix the error',
        evidence: [],
        confidence: 0.8,
        hypotheses: [],
        confidenceSummaryTable: '',
        timings: {}
      };
      
      const result = await service.generateVisualization(graph, report, 'hard-error', 'gpt-4');
      
      // Should use solid arrows for calls
      expect(result.mermaid).toContain('node1 -->|calls| node2');
      // Should use dashed arrows for imports
      expect(result.mermaid).toContain('node2 -.->|imports| node3');
    });
  });

  describe('Error Handling', () => {
    it('should handle malformed root cause gracefully', async () => {
      const graph = {
        nodes: [{ id: 'node1', label: 'Test', kind: 'file' as const }],
        edges: []
      };
      
      const report: RootCauseReport = {
        summary: 'Malformed test',
        likelyRootCause: '', // Empty root cause
        reasoningSteps: [],
        recommendedFix: 'Fix the error',
        evidence: [],
        confidence: 0.8,
        hypotheses: [],
        confidenceSummaryTable: '',
        timings: {}
      };
      
      const result = await service.generateVisualization(graph, report, 'hard-error', 'gpt-4');
      
      expect(result.mermaid).toContain('flowchart TD');
      expect(result.meta.source).toBe('deterministic');
      // No suspect highlighting should occur
      expect(result.mermaid).not.toContain('fill:#ff6b6b');
    });

    it('should handle null/undefined root cause', async () => {
      const graph = {
        nodes: [{ id: 'node1', label: 'Test', kind: 'file' as const }],
        edges: []
      };
      
      const report: RootCauseReport = {
        summary: 'Null test',
        likelyRootCause: null as any, // Null root cause
        reasoningSteps: [],
        recommendedFix: 'Fix the error',
        evidence: [],
        confidence: 0.8,
        hypotheses: [],
        confidenceSummaryTable: '',
        timings: {}
      };
      
      const result = await service.generateVisualization(graph, report, 'hard-error', 'gpt-4');
      
      expect(result.mermaid).toContain('flowchart TD');
      expect(result.meta.source).toBe('deterministic');
    });
  });
});
