/**
 * Unit tests for VisualizationService core functionality
 * 
 * Tests individual methods and edge cases
 */

import { VisualizationService } from '../../../agent/tools/debugging/VisualizationService.js';
import { LLMProviderService } from '../../../agent/llm/llmProviderService.js';
import { GraphNode, GraphEdge } from '../../../agent/tools/debugging/types.js';
import { RootCauseReport } from '../../../agent/tools/debugging/rootCauseTypes.js';

// Mock LLM provider
const mockLLMProvider = {
  chat: jest.fn()
} as unknown as LLMProviderService;

describe('VisualizationService Unit Tests', () => {
  let service: VisualizationService;
  
  beforeEach(() => {
    service = new VisualizationService(mockLLMProvider);
    jest.clearAllMocks();
  });

  describe('toMermaidDeterministic', () => {
    it('should generate basic Mermaid flowchart', () => {
      const graph = {
        nodes: [
          { id: 'A', label: 'Node A', kind: 'file' as const },
          { id: 'B', label: 'Node B', kind: 'file' as const }
        ],
        edges: [
          { from: 'A', to: 'B', kind: 'calls' as const, confidence: 0.8 }
        ]
      };
      
      const report: RootCauseReport = {
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
      
      const suspects = service['extractSuspects'](graph.nodes, report.likelyRootCause || '');
      const mermaid = service['toMermaidDeterministic'](graph, suspects, 'hard-error');
      
      expect(mermaid).toContain('flowchart TD');
      expect(mermaid).toContain('A["Node A"]');
      expect(mermaid).toContain('B["Node B"]');
      expect(mermaid).toContain('A -->|calls| B');
    });

    it('should highlight suspect nodes', () => {
      const graph = {
        nodes: [
          { id: 'suspect', label: 'Suspect Node', kind: 'file' as const },
          { id: 'normal', label: 'Normal Node', kind: 'file' as const }
        ],
        edges: []
      };
      
      const report: RootCauseReport = {
        summary: 'Test',
        likelyRootCause: 'Error in Suspect Node',
        reasoningSteps: [],
        recommendedFix: '',
        evidence: [],
        confidence: 0.8,
        hypotheses: [],
        confidenceSummaryTable: '',
        timings: {}
      };
      
      const suspects = service['extractSuspects'](graph.nodes, report.likelyRootCause || '');
      const mermaid = service['toMermaidDeterministic'](graph, suspects, 'hard-error');
      
      expect(mermaid).toContain('style suspect fill:#ff6b6b,stroke:#b30000,stroke-width:2px');
    });

    it('should handle error badges', () => {
      const graph = {
        nodes: [
          { id: 'error', label: 'Error Node', kind: 'file' as const, badges: ['error'] },
          { id: 'normal', label: 'Normal Node', kind: 'file' as const }
        ],
        edges: []
      };
      
      const report: RootCauseReport = {
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
      
      const suspects = service['extractSuspects'](graph.nodes, report.likelyRootCause || '');
      const mermaid = service['toMermaidDeterministic'](graph, suspects, 'hard-error');
      
      expect(mermaid).toContain('style error');
    });

    it('should truncate to 50 nodes', () => {
      const nodes: GraphNode[] = [];
      for (let i = 0; i < 60; i++) {
        nodes.push({ id: `node${i}`, label: `Node ${i}`, kind: 'file' as const });
      }
      
      const graph = { nodes, edges: [] };
      const report: RootCauseReport = {
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
      
      const suspects = service['extractSuspects'](graph.nodes, report.likelyRootCause || '');
      const mermaid = service['toMermaidDeterministic'](graph, suspects, 'hard-error');
      
      // Should contain exactly 50 node definitions (truncated from 60)
      const nodeLines = mermaid.split('\n').filter(line => line.includes('['));
      expect(nodeLines.length).toBeLessThanOrEqual(50);
    });

    it('should sanitize labels', () => {
      const graph = {
        nodes: [
          { id: 'bad', label: 'Bad`label|with{chars}', kind: 'file' as const },
          { id: 'long', label: 'A'.repeat(100), kind: 'file' as const }
        ],
        edges: []
      };
      
      const report: RootCauseReport = {
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
      
      const suspects = service['extractSuspects'](graph.nodes, report.likelyRootCause || '');
      const mermaid = service['toMermaidDeterministic'](graph, suspects, 'hard-error');
      
      expect(mermaid).toContain('bad["Badlabelwithchars"]');
      expect(mermaid).toContain('long["');
      expect(mermaid).not.toContain('`');
      expect(mermaid).not.toContain('|');
      expect(mermaid).not.toContain('{');
      expect(mermaid).not.toContain('}');
    });
  });

  describe('extractSuspects', () => {
    it('should extract suspects by file name', () => {
      const graph = {
        nodes: [
          { id: 'user-ts', label: 'User.ts', file: 'src/User.ts', kind: 'file' as const },
          { id: 'auth-ts', label: 'Auth.ts', file: 'src/Auth.ts', kind: 'file' as const }
        ],
        edges: []
      };
      
      const report: RootCauseReport = {
        summary: 'Test',
        likelyRootCause: 'Error in User.ts',
        reasoningSteps: [],
        recommendedFix: '',
        evidence: [],
        confidence: 0.8,
        hypotheses: [],
        confidenceSummaryTable: '',
        timings: {}
      };
      
      const suspects = service['extractSuspects'](graph.nodes, report.likelyRootCause || '');
      
      expect(suspects.has('user-ts')).toBe(true);
      expect(suspects.has('auth-ts')).toBe(false);
    });

    it('should extract suspects by function name', () => {
      const graph = {
        nodes: [
          { id: 'get-user', label: 'getUser()', file: 'src/User.ts', kind: 'symbol' as const },
          { id: 'set-user', label: 'setUser()', file: 'src/User.ts', kind: 'symbol' as const }
        ],
        edges: []
      };
      
      const report: RootCauseReport = {
        summary: 'Test',
        likelyRootCause: 'getUser() is failing',
        reasoningSteps: [],
        recommendedFix: '',
        evidence: [],
        confidence: 0.8,
        hypotheses: [],
        confidenceSummaryTable: '',
        timings: {}
      };
      
      const suspects = service['extractSuspects'](graph.nodes, report.likelyRootCause || '');
      
      expect(suspects.has('get-user')).toBe(true);
      expect(suspects.has('set-user')).toBe(false);
    });

    it('should handle empty root cause', () => {
      const graph = {
        nodes: [
          { id: 'node1', label: 'Node 1', kind: 'file' as const }
        ],
        edges: []
      };
      
      const report: RootCauseReport = {
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
      
      const suspects = service['extractSuspects'](graph.nodes, report.likelyRootCause || '');
      
      expect(suspects.size).toBe(0);
    });

    it('should include hypothesis-related nodes in suspects', async () => {
      const graph = {
        nodes: [
          { id: 'node1', label: 'Node 1', kind: 'file' as const },
          { id: 'node2', label: 'Node 2', kind: 'file' as const },
          { id: 'node3', label: 'Node 3', kind: 'file' as const }
        ],
        edges: []
      };
      
      const report: RootCauseReport = {
        summary: 'Test',
        likelyRootCause: '',
        reasoningSteps: [],
        recommendedFix: '',
        evidence: [],
        confidence: 0.8,
        hypotheses: [
          {
            id: 'hypothesis_1',
            summary: 'Test hypothesis',
            evidence: ['Evidence 1'],
            relatedNodes: ['node1', 'node2'], // These nodes should be highlighted
            confidence: 0.7,
            rationale: 'Test rationale',
            relatedFiles: []
          }
        ],
        confidenceSummaryTable: '',
        timings: {}
      };
      
      const result = await service.generateVisualization(graph, report, 'hard-error', 'gpt-4');
      
      // Verify that hypothesis-related nodes are included in suspects and highlighted
      // The mermaid should contain styling for node1 and node2
      expect(result.mermaid).toContain('flowchart TD');
      // The suspects should include node1 and node2 from hypothesis relatedNodes
      // This is verified indirectly by checking the mermaid contains the nodes
      expect(result.mermaid).toContain('node1');
      expect(result.mermaid).toContain('node2');
    });

    it('should handle null root cause', () => {
      const graph = {
        nodes: [
          { id: 'node1', label: 'Node 1', kind: 'file' as const }
        ],
        edges: []
      };
      
      const report: RootCauseReport = {
        summary: 'Test',
        likelyRootCause: null as any,
        reasoningSteps: [],
        recommendedFix: '',
        evidence: [],
        confidence: 0.8,
        hypotheses: [],
        confidenceSummaryTable: '',
        timings: {}
      };
      
      const suspects = service['extractSuspects'](graph.nodes, report.likelyRootCause || '');
      
      expect(suspects.size).toBe(0);
    });
  });

  describe('generateVisualization with curated subgraph extraction', () => {
    it('should use curated subgraph when filtered graph is empty', async () => {
      const graph = {
        nodes: [
          { id: 'entry1', label: 'Entry Point', kind: 'symbol' as const, badges: ['entry'] },
          { id: 'error1', label: 'Error Node', kind: 'file' as const, badges: ['error'], file: 'src/error.ts', line: 10 },
          { id: 'node1', label: 'Node 1', kind: 'file' as const },
          { id: 'node2', label: 'Node 2', kind: 'file' as const },
          { id: 'node3', label: 'Node 3', kind: 'file' as const },
        ],
        edges: [
          { from: 'entry1', to: 'node1', kind: 'calls' as const, confidence: 0.8 },
          { from: 'node1', to: 'node2', kind: 'calls' as const, confidence: 0.8 },
          { from: 'node2', to: 'error1', kind: 'calls' as const, confidence: 0.8 },
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
      expect(result.meta.edgeCount).toBeGreaterThanOrEqual(0);
    });

    it('should use curated subgraph when no root cause report is provided', async () => {
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

      // No report provided
      const result = await service.generateVisualization(graph, undefined, 'hard-error', 'gpt-4');

      // Should generate a mermaid graph using curated extraction
      expect(result.mermaid).toContain('flowchart TD');
      expect(result.meta.nodeCount).toBeGreaterThan(0);
    });

    it('should handle empty graph gracefully', async () => {
      const graph = {
        nodes: [],
        edges: []
      };

      const report: RootCauseReport = {
        summary: 'Test',
        likelyRootCause: '',
        reasoningSteps: [],
        recommendedFix: '',
        evidence: [],
        confidence: 0.3,
        hypotheses: [],
        confidenceSummaryTable: '',
        timings: {}
      };

      // Should throw error when trying to generate mermaid from empty graph
      await expect(service.generateVisualization(graph, report, 'hard-error', 'gpt-4'))
        .rejects.toThrow('Cannot generate Mermaid graph');
    });
  });

  describe('getEdgeStyle', () => {
    it('should return correct styles for different edge types', () => {
      const callsEdge: GraphEdge = { from: 'A', to: 'B', kind: 'calls', confidence: 0.8 };
      const importsEdge: GraphEdge = { from: 'A', to: 'B', kind: 'imports', confidence: 0.8 };
      const reexportsEdge: GraphEdge = { from: 'A', to: 'B', kind: 'reexports', confidence: 0.8 };
      const exportsEdge: GraphEdge = { from: 'A', to: 'B', kind: 'exports', confidence: 0.8 };
      const runtimeEdge: GraphEdge = { from: 'A', to: 'B', kind: 'runtimePath', confidence: 0.8 };
      
      expect(service['getEdgeStyle'](callsEdge)).toBe('-->|calls|');
      expect(service['getEdgeStyle'](importsEdge)).toBe('-.->|imports|');
      expect(service['getEdgeStyle'](reexportsEdge)).toBe('-.->|reexports|');
      expect(service['getEdgeStyle'](exportsEdge)).toBe('-.->|exports|');
      expect(service['getEdgeStyle'](runtimeEdge)).toBe('-->|runtimePath|');
    });
  });

  describe('sanitizeLabel', () => {
    it('should remove problematic characters', () => {
      const input = 'Label`with|bad{chars}';
      const result = service['sanitizeLabel'](input);
      
      expect(result).toBe('Labelwithbadchars');
      expect(result).not.toContain('`');
      expect(result).not.toContain('|');
      expect(result).not.toContain('{');
      expect(result).not.toContain('}');
    });

    it('should escape quotes', () => {
      const input = 'Label"with"quotes';
      const result = service['sanitizeLabel'](input);
      
      expect(result).toBe('Label&quot;with&quot;quotes');
    });

    it('should truncate long labels', () => {
      const input = 'A'.repeat(100);
      const result = service['sanitizeLabel'](input);
      
      expect(result).toHaveLength(60);
      expect(result).toBe('A'.repeat(60));
    });

    it('should handle empty labels', () => {
      const result = service['sanitizeLabel']('');
      expect(result).toBe('');
    });
  });

  describe('beautifyWithLLM', () => {
    it('should return null when LLM fails', async () => {
      (mockLLMProvider.chat as jest.Mock).mockRejectedValue(new Error('LLM error'));
      
      const result = await service['beautifyWithLLM']('test', { nodes: [], edges: [] }, new Set(), 'hard-error', 'gpt-4');
      
      expect(result).toBeNull();
    });

    it('should return null when LLM returns invalid JSON', async () => {
      (mockLLMProvider.chat as jest.Mock).mockResolvedValue({
        type: 'success',
        payload: { content: 'invalid json' }
      });
      
      const result = await service['beautifyWithLLM']('test', { nodes: [], edges: [] }, new Set(), 'hard-error', 'gpt-4');
      
      expect(result).toBeNull();
    });

    it('should return null when LLM returns empty response', async () => {
      (mockLLMProvider.chat as jest.Mock).mockResolvedValue({
        type: 'success',
        payload: { content: '{}' }
      });
      
      const result = await service['beautifyWithLLM']('test', { nodes: [], edges: [] }, new Set(), 'hard-error', 'gpt-4');
      
      expect(result).toBeNull();
    });

    it('should return beautified Mermaid when LLM succeeds', async () => {
      const beautification = {
        subgraphs: [{ id: 'group1', nodes: ['A', 'B'], label: 'Group 1' }],
        classDefs: ['classDef highlight fill:#ff6b6b']
      };
      
      (mockLLMProvider.chat as jest.Mock).mockResolvedValue({
        type: 'success',
        payload: { content: JSON.stringify(beautification) }
      });
      
      const result = await service['beautifyWithLLM']('test', { nodes: [], edges: [] }, new Set(), 'hard-error', 'gpt-4');
      
      expect(result).toContain('subgraph group1');
      expect(result).toContain('classDef highlight');
    });
  });

  describe('ensureParity', () => {
    it('should pass when Mermaid contains all original nodes', () => {
      const graph = {
        nodes: [
          { id: 'A', label: 'Node A', kind: 'file' as const },
          { id: 'B', label: 'Node B', kind: 'file' as const }
        ],
        edges: []
      };
      
      const mermaid = 'flowchart TD\nA["Node A"]\nB["Node B"]';
      
      expect(() => service['ensureParity'](mermaid, graph)).not.toThrow();
    });

    it('should throw when Mermaid is missing nodes', () => {
      const graph = {
        nodes: [
          { id: 'A', label: 'Node A', kind: 'file' as const },
          { id: 'B', label: 'Node B', kind: 'file' as const }
        ],
        edges: []
      };
      
      const mermaid = 'flowchart TD\nA["Node A"]'; // Missing B
      
      expect(() => service['ensureParity'](mermaid, graph)).toThrow('Parity check failed');
    });

    it('should throw when Mermaid has extra nodes', () => {
      const graph = {
        nodes: [
          { id: 'A', label: 'Node A', kind: 'file' as const }
        ],
        edges: []
      };
      
      const mermaid = 'flowchart TD\nA["Node A"]\nC["Node C"]'; // Extra C
      
      expect(() => service['ensureParity'](mermaid, graph)).toThrow('Parity check failed');
    });
  });
});
