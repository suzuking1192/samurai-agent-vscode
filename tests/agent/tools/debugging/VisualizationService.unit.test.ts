/**
 * Unit tests for VisualizationService core functionality
 * 
 * Tests individual methods and edge cases
 */

import { VisualizationService } from '../../../src/agent/tools/debugging/VisualizationService';
import { LLMProviderService } from '../../../src/agent/llm/llmProviderService';
import { GraphNode, GraphEdge } from '../../../src/agent/tools/debugging/types';
import { RootCauseReport } from '../../../src/agent/tools/debugging/rootCauseTypes';

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
      
      const result = service['toMermaidDeterministic'](graph, report, 'hard-error');
      
      expect(result.mermaid).toContain('flowchart TD');
      expect(result.mermaid).toContain('A["Node A"]');
      expect(result.mermaid).toContain('B["Node B"]');
      expect(result.mermaid).toContain('A -->|calls| B');
      expect(result.meta.nodeCount).toBe(2);
      expect(result.meta.edgeCount).toBe(1);
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
      
      const result = service['toMermaidDeterministic'](graph, report, 'hard-error');
      
      expect(result.mermaid).toContain('style suspect fill:#ff6b6b,stroke:#b30000,stroke-width:2px');
      expect(result.mermaid).toContain('style normal fill:#4a9eff,stroke:#0056b3,stroke-width:1px');
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
      
      const result = service['toMermaidDeterministic'](graph, report, 'hard-error');
      
      expect(result.mermaid).toContain('style error fill:#ff8c42,stroke:#cc5200,stroke-width:2px');
      expect(result.mermaid).toContain('style normal fill:#4a9eff,stroke:#0056b3,stroke-width:1px');
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
      
      const result = service['toMermaidDeterministic'](graph, report, 'hard-error');
      
      expect(result.meta.nodeCount).toBe(60); // Original count
      expect(result.meta.truncated).toBe(true);
      
      // Should contain exactly 50 node definitions
      const nodeLines = result.mermaid.split('\n').filter(line => line.includes('['));
      expect(nodeLines).toHaveLength(50);
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
      
      const result = service['toMermaidDeterministic'](graph, report, 'hard-error');
      
      expect(result.mermaid).toContain('bad["Badlabelwithchars"]');
      expect(result.mermaid).toContain('long["' + 'A'.repeat(60) + '"]');
      expect(result.mermaid).not.toContain('`');
      expect(result.mermaid).not.toContain('|');
      expect(result.mermaid).not.toContain('{');
      expect(result.mermaid).not.toContain('}');
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
      
      const suspects = service['extractSuspects'](graph, report);
      
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
      
      const suspects = service['extractSuspects'](graph, report);
      
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
      
      const suspects = service['extractSuspects'](graph, report);
      
      expect(suspects.size).toBe(0);
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
      
      const suspects = service['extractSuspects'](graph, report);
      
      expect(suspects.size).toBe(0);
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




















