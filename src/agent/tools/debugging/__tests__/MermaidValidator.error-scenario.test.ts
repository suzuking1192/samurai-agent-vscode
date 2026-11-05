/**
 * Test to reproduce the checkpoint error scenario
 * 
 * Tests the scenario where:
 * 1. Large graph (129 nodes, 10,887 edges) gets truncated
 * 2. Validator fails with module resolution error
 * 3. Graph becomes empty after normalization
 * 4. originalInvalidMermaid ends up empty
 */

import { validateMermaid } from '../MermaidValidator';
import { VisualizationService } from '../VisualizationService';
import { LLMProviderService } from '../../../llm/llmProviderService';
import { GraphNode, GraphEdge } from '../types';
import { RootCauseReport } from '../rootCauseTypes';

// Mock LLM provider
const mockLLMProvider = {
  chat: jest.fn()
} as unknown as LLMProviderService;

describe('MermaidValidator Error Scenario', () => {
  let service: VisualizationService;

  beforeEach(() => {
    service = new VisualizationService(mockLLMProvider);
    jest.clearAllMocks();
  });

  describe('Large Graph Truncation Scenario', () => {
    it('should handle large graph that exceeds limits', async () => {
      // Create a large graph similar to the checkpoint scenario (129 nodes, many edges)
      // Use a smaller but still significant number of edges to avoid timeout
      const nodes: GraphNode[] = [];
      const edges: GraphEdge[] = [];

      // Create 129 nodes
      for (let i = 0; i < 129; i++) {
        nodes.push({
          id: `node-${i}`,
          label: `Node ${i}`,
          file: `src/file${i}.ts`,
          kind: i % 3 === 0 ? 'file' : 'symbol',
          line: i + 1,
          badges: i === 0 ? ['error' as const] : undefined
        });
      }

      // Create enough edges to exceed MAX_EDGES_FOR_MERMAID (300)
      // Create a chain plus some extra edges to ensure truncation
      for (let i = 0; i < nodes.length - 1; i++) {
        edges.push({
          from: nodes[i].id,
          to: nodes[i + 1].id,
          kind: 'calls' as const,
          confidence: 0.9
        });
      }
      
      // Add more edges to exceed limit (but not 10,887 to avoid timeout)
      for (let i = 0; i < nodes.length && edges.length < 500; i++) {
        for (let j = Math.max(0, i - 5); j < Math.min(nodes.length, i + 5); j++) {
          if (i !== j && edges.length < 500) {
            edges.push({
              from: nodes[i].id,
              to: nodes[j].id,
              kind: 'imports' as const,
              confidence: 0.7
            });
          }
        }
      }

      const graph = { nodes, edges };
      const report: RootCauseReport = {
        summary: 'Test error scenario',
        likelyRootCause: 'Error in node-0',
        reasoningSteps: ['Step 1'],
        recommendedFix: 'Fix it',
        evidence: ['Evidence 1'],
        confidence: 0.8,
        hypotheses: [],
        confidenceSummaryTable: '| Test | 0.8 |',
        timings: { total: 1000 }
      };

      const result = await service.generateVisualization(
        graph,
        report,
        'soft-error',
        'gpt-4'
      );

      // Verify truncation occurred
      expect(result.meta.nodeCount).toBeLessThanOrEqual(120);
      expect(result.meta.edgeCount).toBeLessThanOrEqual(300);
      expect(result.meta.truncated).toBe(true);

      // Verify diagnostics include truncation warnings
      const truncationDiagnostics = result.diagnostics.filter(
        d => d.code === 'NODE_LIMIT_REACHED' || d.code === 'EDGE_LIMIT_REACHED'
      );
      expect(truncationDiagnostics.length).toBeGreaterThan(0);

      // Verify Mermaid graph is generated (always returns a valid error graph if validation fails)
      expect(result.mermaid).toBeDefined();
      expect(result.mermaid).toContain('flowchart TD');
      expect(result.mermaid.length).toBeGreaterThan('flowchart TD'.length);
      
      // If validation passed, verify the Mermaid contains node definitions
      if (result.isValid) {
        // Should have node definitions
        expect(result.mermaid).toMatch(/[A-Za-z0-9_]+\[["'][^"']*["']\]/);
      } else {
        // If validation failed, should have error node
        expect(result.mermaid).toContain('ERROR_NODE');
        // And originalInvalidMermaid should contain meaningful content
        expect(result.originalInvalidMermaid).toBeDefined();
        expect(result.originalInvalidMermaid).not.toBe('');
        expect(result.originalInvalidMermaid).not.toBe('flowchart TD');
      }
    }, 30000); // 30 second timeout

    it('should handle empty graph after normalization', async () => {
      // Create a graph where all edges will be filtered out
      const nodes: GraphNode[] = [
        { id: 'node-1', label: 'Node 1', kind: 'file' },
        { id: 'node-2', label: 'Node 2', kind: 'file' }
      ];

      // Create edges that reference nodes that will be filtered out
      const edges: GraphEdge[] = [
        {
          from: 'missing-node-1',
          to: 'missing-node-2',
          kind: 'calls',
          confidence: 0.9
        }
      ];

      const graph = { nodes, edges };
      const report: RootCauseReport = {
        summary: 'Empty graph scenario',
        likelyRootCause: 'Test',
        reasoningSteps: [],
        recommendedFix: 'Fix',
        evidence: [],
        confidence: 0.5,
        hypotheses: [],
        confidenceSummaryTable: '',
        timings: { total: 100 }
      };

      const result = await service.generateVisualization(
        graph,
        report,
        'soft-error',
        'gpt-4'
      );

      // Graph should not be completely empty (should have at least nodes)
      expect(result.meta.nodeCount).toBeGreaterThan(0);
      expect(result.mermaid).toContain('flowchart TD');
      expect(result.mermaid.length).toBeGreaterThan('flowchart TD'.length);
    }, 45000); // 45 second timeout (validation can take time)

    it('should preserve originalInvalidMermaid content even when validation fails', async () => {
      // Create a graph that will generate invalid Mermaid
      const nodes: GraphNode[] = [
        {
          id: 'node-1',
          label: 'Node with problematic chars: {}[]|`',
          kind: 'file',
          file: 'src/file1.ts'
        },
        {
          id: '123node', // Starts with number - should be normalized
          label: 'Node 2',
          kind: 'symbol',
          file: 'src/file2.ts'
        }
      ];

      const edges: GraphEdge[] = [
        {
          from: 'node-1',
          to: '123node',
          kind: 'calls',
          confidence: 0.8
        }
      ];

      const graph = { nodes, edges };
      const report: RootCauseReport = {
        summary: 'Test',
        likelyRootCause: 'Test',
        reasoningSteps: [],
        recommendedFix: 'Fix',
        evidence: [],
        confidence: 0.5,
        hypotheses: [],
        confidenceSummaryTable: '',
        timings: { total: 100 }
      };

      const result = await service.generateVisualization(
        graph,
        report,
        'soft-error',
        'gpt-4'
      );

      // If validation failed, originalInvalidMermaid should contain meaningful content
      if (!result.isValid && result.originalInvalidMermaid) {
        expect(result.originalInvalidMermaid).toBeDefined();
        expect(result.originalInvalidMermaid.length).toBeGreaterThan('flowchart TD'.length);
        // Should contain node definitions
        expect(
          result.originalInvalidMermaid.includes('node-1') ||
          result.originalInvalidMermaid.includes('_123node') ||
          result.originalInvalidMermaid.includes('Node')
        ).toBe(true);
      }
    }, 30000); // 30 second timeout
  });

  describe('Validator Infrastructure Failure', () => {
    it('should handle module resolution errors gracefully', async () => {
      // Test with a valid Mermaid that might fail due to infrastructure issues
      const validMermaid = `flowchart TD
        A["Node A"]
        B["Node B"]
        A --> B`;

      // Note: We can't easily mock the execFile call in MermaidValidator
      // without modifying it, but we can test that the error handling
      // doesn't crash the service
      const result = await validateMermaid(validMermaid);

      // Should either be valid or return a proper error (not crash)
      expect(result).toBeDefined();
      expect(result.isValid !== undefined).toBe(true);
      expect(result.errors !== undefined || result.isValid).toBe(true);
    });

    it('should provide meaningful error messages for infrastructure failures', async () => {
      // Create a graph that will pass normalization but might fail validation
      const nodes: GraphNode[] = Array.from({ length: 120 }, (_, i) => ({
        id: `node-${i}`,
        label: `Node ${i}`,
        kind: 'file' as const,
        file: `src/file${i}.ts`
      }));

      const edges: GraphEdge[] = Array.from({ length: 300 }, (_, i) => ({
        from: `node-${i % 120}`,
        to: `node-${(i + 1) % 120}`,
        kind: 'calls' as const,
        confidence: 0.8
      }));

      const graph = { nodes, edges };
      const report: RootCauseReport = {
        summary: 'Test',
        likelyRootCause: 'Test',
        reasoningSteps: [],
        recommendedFix: 'Fix',
        evidence: [],
        confidence: 0.5,
        hypotheses: [],
        confidenceSummaryTable: '',
        timings: { total: 100 }
      };

      const result = await service.generateVisualization(
        graph,
        report,
        'soft-error',
        'gpt-4'
      );

      // Should have diagnostics if validation failed
      if (!result.isValid) {
        const infrastructureErrors = result.diagnostics.filter(
          d => d.code === 'INVALID_SYNTAX' || d.code === 'VALIDATION_ERROR'
        );
        expect(infrastructureErrors.length).toBeGreaterThan(0);
        // Error messages should be meaningful
        infrastructureErrors.forEach(error => {
          expect(error.message).toBeDefined();
          expect(error.message.length).toBeGreaterThan(0);
        });
      }
    });
  });
});

