/**
 * Tests for VisualizationService
 * 
 * Tests deterministic Mermaid generation, suspect extraction, and LLM beautification
 */

import { VisualizationService } from '../../../src/agent/tools/debugging/VisualizationService';
import { LLMProviderService } from '../../../src/agent/llm/llmProviderService';
import { GraphNode, GraphEdge } from '../../../src/agent/tools/debugging/types';
import { RootCauseReport } from '../../../src/agent/tools/debugging/rootCauseTypes';

// Mock LLM provider
const mockLLMProvider = {
  generateResponse: jest.fn()
} as unknown as LLMProviderService;

describe('VisualizationService', () => {
  let service: VisualizationService;
  
  beforeEach(() => {
    service = new VisualizationService(mockLLMProvider);
    jest.clearAllMocks();
  });

  describe('toMermaidDeterministic', () => {
    it('should generate valid Mermaid from simple graph', () => {
      const graph = {
        nodes: [
          { id: 'node1', label: 'User.ts', file: 'src/User.ts', kind: 'file' as const },
          { id: 'node2', label: 'getUser()', file: 'src/User.ts', line: 15, kind: 'symbol' as const }
        ],
        edges: [
          { from: 'node1', to: 'node2', kind: 'calls' as const, confidence: 0.8 }
        ]
      };
      
      const suspects = new Set(['node2']);
      const mode = 'hard-error' as const;
      
      // Access private method for testing
      const mermaid = (service as any).toMermaidDeterministic(graph, suspects, mode);
      
      expect(mermaid).toContain('flowchart TD');
      expect(mermaid).toContain('node1["User.ts"]');
      expect(mermaid).toContain('node2["getUser()"]');
      expect(mermaid).toContain('node1 -->|calls| node2');
      expect(mermaid).toContain('style node2 fill:#ff6b6b,stroke:#b30000,stroke-width:2px');
    });

    it('should sanitize labels with problematic characters', () => {
      const graph = {
        nodes: [
          { id: 'node1', label: 'User.ts:15:getUser()', file: 'src/User.ts', kind: 'file' as const }
        ],
        edges: []
      };
      
      const mermaid = (service as any).toMermaidDeterministic(graph, new Set(), 'hard-error');
      
      expect(mermaid).toContain('node1["User.ts:15:getUser()"]');
      expect(mermaid).not.toContain('`');
      expect(mermaid).not.toContain('|');
      expect(mermaid).not.toContain('{');
      expect(mermaid).not.toContain('}');
    });

    it('should limit to 50 nodes and prioritize by badges', () => {
      const nodes: GraphNode[] = [];
      for (let i = 0; i < 60; i++) {
        nodes.push({
          id: `node${i}`,
          label: `Node ${i}`,
          kind: 'file' as const,
          badges: i < 10 ? ['error'] : undefined
        });
      }
      
      const graph = { nodes, edges: [] };
      const mermaid = (service as any).toMermaidDeterministic(graph, new Set(), 'hard-error');
      
      // Should contain exactly 50 node definitions (excluding flowchart TD line)
      const nodeLines = mermaid.split('\n').filter(line => line.includes('['));
      expect(nodeLines).toHaveLength(50);
      
      // Should prioritize error badges
      expect(mermaid).toContain('node0["Node 0"]');
      expect(mermaid).toContain('node9["Node 9"]');
      expect(mermaid).not.toContain('node50["Node 50"]');
    });
  });

  describe('extractSuspects', () => {
    it('should match suspects by file name', () => {
      const nodes: GraphNode[] = [
        { id: 'node1', label: 'User.ts', file: 'src/User.ts', kind: 'file' as const },
        { id: 'node2', label: 'Auth.ts', file: 'src/Auth.ts', kind: 'file' as const }
      ];
      
      const rootCause = 'Error in User.ts at line 15';
      const suspects = (service as any).extractSuspects(nodes, rootCause);
      
      expect(suspects.has('node1')).toBe(true);
      expect(suspects.has('node2')).toBe(false);
    });

    it('should match suspects by function name', () => {
      const nodes: GraphNode[] = [
        { id: 'node1', label: 'getUser()', file: 'src/User.ts', kind: 'symbol' as const },
        { id: 'node2', label: 'validateUser()', file: 'src/User.ts', kind: 'symbol' as const }
      ];
      
      const rootCause = 'getUser() function is throwing an error';
      const suspects = (service as any).extractSuspects(nodes, rootCause);
      
      expect(suspects.has('node1')).toBe(true);
      expect(suspects.has('node2')).toBe(false);
    });

    it('should handle empty or invalid root cause', () => {
      const nodes: GraphNode[] = [
        { id: 'node1', label: 'User.ts', file: 'src/User.ts', kind: 'file' as const }
      ];
      
      expect((service as any).extractSuspects(nodes, '')).toEqual(new Set());
      expect((service as any).extractSuspects(nodes, null as any)).toEqual(new Set());
      expect((service as any).extractSuspects(nodes, undefined as any)).toEqual(new Set());
    });
  });

  describe('generateVisualization', () => {
    it('should generate deterministic visualization successfully', async () => {
      const graph = {
        nodes: [
          { id: 'node1', label: 'User.ts', file: 'src/User.ts', kind: 'file' as const },
          { id: 'node2', label: 'getUser()', file: 'src/User.ts', line: 15, kind: 'symbol' as const }
        ],
        edges: [
          { from: 'node1', to: 'node2', kind: 'calls' as const, confidence: 0.8 }
        ]
      };
      
      const report: RootCauseReport = {
        summary: 'Test summary',
        likelyRootCause: 'Error in User.ts',
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
      expect(result.meta.mode).toBe('hard-error');
      expect(result.meta.source).toBe('deterministic');
      expect(result.meta.nodeCount).toBe(2);
      expect(result.meta.edgeCount).toBe(1);
      expect(result.meta.truncated).toBe(false);
      expect(result.diagnostics).toEqual([]);
    });

    it('should use curated subgraph when no root cause is found', async () => {
      const graph = {
        nodes: [
          { id: 'entry1', label: 'Entry Point', kind: 'symbol' as const, badges: ['entry'] },
          { id: 'error1', label: 'Error Node', kind: 'file' as const, badges: ['error'], file: 'src/error.ts', line: 10 },
          { id: 'node1', label: 'Node 1', kind: 'file' as const },
          { id: 'node2', label: 'Node 2', kind: 'file' as const },
        ],
        edges: [
          { from: 'entry1', to: 'node1', kind: 'calls' as const, confidence: 0.8 },
          { from: 'node1', to: 'error1', kind: 'calls' as const, confidence: 0.8 },
        ]
      };

      // Report with no hypotheses (triggers curated extraction)
      const report: RootCauseReport = {
        summary: 'Test',
        likelyRootCause: '',
        reasoningSteps: [],
        recommendedFix: '',
        evidence: [],
        confidence: 0.3,
        hypotheses: [], // Empty hypotheses triggers curated extraction
        confidenceSummaryTable: '',
        timings: {}
      };

      const result = await service.generateVisualization(graph, report, 'hard-error', 'gpt-4');

      // Should generate a mermaid graph (not empty)
      expect(result.mermaid).toContain('flowchart TD');
      expect(result.meta.nodeCount).toBeGreaterThan(0);
    });
  });

  describe('sanitizeLabel', () => {
    it('should remove problematic characters and truncate', () => {
      const sanitizeLabel = (service as any).sanitizeLabel;
      
      expect(sanitizeLabel('test`label|with{problems}')).toBe('testlabelwithproblems');
      expect(sanitizeLabel('a'.repeat(100))).toHaveLength(60);
      expect(sanitizeLabel('test\nlabel')).toBe('test label');
    });
  });

  describe('getNodePriority', () => {
    it('should prioritize error badges highest', () => {
      const getNodePriority = (service as any).getNodePriority;
      const suspects = new Set(['node2']);
      
      const errorNode = { id: 'node1', badges: ['error'], kind: 'file' as const };
      const suspectNode = { id: 'node2', kind: 'file' as const };
      const normalNode = { id: 'node3', kind: 'file' as const };
      
      expect(getNodePriority(errorNode, suspects)).toBeGreaterThan(getNodePriority(suspectNode, suspects));
      expect(getNodePriority(suspectNode, suspects)).toBeGreaterThan(getNodePriority(normalNode, suspects));
    });
  });

  describe('getEdgeStyle', () => {
    it('should return correct styles for different edge types', () => {
      const getEdgeStyle = (service as any).getEdgeStyle;
      
      expect(getEdgeStyle({ kind: 'calls' })).toBe('-->');
      expect(getEdgeStyle({ kind: 'imports' })).toBe('-.->');
      expect(getEdgeStyle({ kind: 'exports' })).toBe('-.->');
      expect(getEdgeStyle({ kind: 'reexports' })).toBe('-.->');
      expect(getEdgeStyle({ kind: 'unknown' })).toBe('-->');
    });
  });
});











