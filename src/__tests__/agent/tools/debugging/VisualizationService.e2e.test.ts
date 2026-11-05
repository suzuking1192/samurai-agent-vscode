/**
 * End-to-end tests for VisualizationService
 * 
 * Tests the complete flow from execution graph to final Mermaid output
 */

import { VisualizationService } from '../../../agent/tools/debugging/VisualizationService.js';
import { LLMProviderService } from '../../../agent/llm/llmProviderService.js';
import { GraphNode, GraphEdge } from '../../../agent/tools/debugging/types.js';
import { RootCauseReport } from '../../../agent/tools/debugging/rootCauseTypes.js';

// Mock LLM provider that simulates real behavior
const mockLLMProvider = {
  chat: jest.fn()
} as unknown as LLMProviderService;

describe('VisualizationService E2E Tests', () => {
  let service: VisualizationService;
  
  beforeEach(() => {
    service = new VisualizationService(mockLLMProvider);
    jest.clearAllMocks();
  });

  describe('Complete Debugging Scenario', () => {
    it('should handle a realistic debugging scenario end-to-end', async () => {
      // Simulate a real debugging scenario: User login failing
      const graph = {
        nodes: [
          // Entry point
          { 
            id: 'login-route', 
            label: 'loginRoute.ts', 
            file: 'src/routes/auth/loginRoute.ts', 
            kind: 'file' as const,
            badges: ['routeHandler']
          },
          { 
            id: 'handle-login', 
            label: 'handleLogin()', 
            file: 'src/routes/auth/loginRoute.ts', 
            line: 25, 
            kind: 'symbol' as const 
          },
          
          // Service layer
          { 
            id: 'auth-service', 
            label: 'AuthService.ts', 
            file: 'src/services/AuthService.ts', 
            kind: 'file' as const 
          },
          { 
            id: 'authenticate', 
            label: 'authenticate()', 
            file: 'src/services/AuthService.ts', 
            line: 42, 
            kind: 'symbol' as const 
          },
          
          // Data layer
          { 
            id: 'user-repo', 
            label: 'UserRepository.ts', 
            file: 'src/repositories/UserRepository.ts', 
            kind: 'file' as const 
          },
          { 
            id: 'find-by-email', 
            label: 'findByEmail()', 
            file: 'src/repositories/UserRepository.ts', 
            line: 15, 
            kind: 'symbol' as const 
          },
          
          // Database
          { 
            id: 'database', 
            label: 'Database.ts', 
            file: 'src/database/Database.ts', 
            kind: 'file' as const 
          },
          { 
            id: 'query', 
            label: 'query()', 
            file: 'src/database/Database.ts', 
            line: 8, 
            kind: 'symbol' as const 
          },
          
          // Error handling
          { 
            id: 'error-handler', 
            label: 'ErrorHandler.ts', 
            file: 'src/utils/ErrorHandler.ts', 
            kind: 'file' as const,
            badges: ['error']
          }
        ],
        edges: [
          // Call chain
          { from: 'login-route', to: 'handle-login', kind: 'calls' as const, confidence: 0.95 },
          { from: 'handle-login', to: 'auth-service', kind: 'calls' as const, confidence: 0.9 },
          { from: 'auth-service', to: 'authenticate', kind: 'calls' as const, confidence: 0.9 },
          { from: 'authenticate', to: 'user-repo', kind: 'calls' as const, confidence: 0.85 },
          { from: 'user-repo', to: 'find-by-email', kind: 'calls' as const, confidence: 0.8 },
          { from: 'find-by-email', to: 'database', kind: 'calls' as const, confidence: 0.75 },
          { from: 'database', to: 'query', kind: 'calls' as const, confidence: 0.7 },
          
          // Error path
          { from: 'query', to: 'error-handler', kind: 'calls' as const, confidence: 0.6 },
          
          // Imports
          { from: 'login-route', to: 'auth-service', kind: 'imports' as const, confidence: 0.5 },
          { from: 'auth-service', to: 'user-repo', kind: 'imports' as const, confidence: 0.5 },
          { from: 'user-repo', to: 'database', kind: 'imports' as const, confidence: 0.5 }
        ]
      };
      
      const report: RootCauseReport = {
        summary: 'User login is failing with database connection error',
        likelyRootCause: 'Database query in UserRepository.ts at line 15 is timing out',
        reasoningSteps: [
          'User submits login form',
          'handleLogin() calls AuthService.authenticate()',
          'authenticate() calls UserRepository.findByEmail()',
          'findByEmail() calls Database.query()',
          'Database.query() times out after 30 seconds'
        ],
        recommendedFix: 'Check database connection pool and query timeout settings',
        evidence: [
          'Stack trace shows timeout in Database.query()',
          'Database logs show connection pool exhaustion',
          'Error occurs consistently after 30 seconds'
        ],
        confidence: 0.9,
        hypotheses: [
          'Database connection pool is too small',
          'Query timeout is set too low',
          'Database server is overloaded'
        ],
        confidenceSummaryTable: '| Component | Confidence |\n|-----------|------------|\n| Database | 0.9 |\n| UserRepository | 0.8 |\n| AuthService | 0.7 |',
        timings: { total: 2500, evidence: 300, hypothesis: 500, testing: 1700 }
      };
      
      // Test hard-error mode (most appropriate for this scenario)
      const result = await service.generateVisualization(graph, report, 'hard-error', 'gpt-4');
      
      // Verify basic structure
      expect(result.mermaid).toContain('flowchart TD');
      expect(result.meta.mode).toBe('hard-error');
      expect(result.meta.source).toBe('deterministic');
      expect(result.meta.nodeCount).toBe(9);
      expect(result.meta.edgeCount).toBe(10);
      expect(result.meta.truncated).toBe(false);
      
      // Verify all nodes are present
      expect(result.mermaid).toContain('login-route["loginRoute.ts"]');
      expect(result.mermaid).toContain('handle-login["handleLogin()"]');
      expect(result.mermaid).toContain('auth-service["AuthService.ts"]');
      expect(result.mermaid).toContain('authenticate["authenticate()"]');
      expect(result.mermaid).toContain('user-repo["UserRepository.ts"]');
      expect(result.mermaid).toContain('find-by-email["findByEmail()"]');
      expect(result.mermaid).toContain('database["Database.ts"]');
      expect(result.mermaid).toContain('query["query()"]');
      expect(result.mermaid).toContain('error-handler["ErrorHandler.ts"]');
      
      // Verify call chain edges
      expect(result.mermaid).toContain('login-route -->|calls| handle-login');
      expect(result.mermaid).toContain('handle-login -->|calls| auth-service');
      expect(result.mermaid).toContain('auth-service -->|calls| authenticate');
      expect(result.mermaid).toContain('authenticate -->|calls| user-repo');
      expect(result.mermaid).toContain('user-repo -->|calls| find-by-email');
      expect(result.mermaid).toContain('find-by-email -->|calls| database');
      expect(result.mermaid).toContain('database -->|calls| query');
      
      // Verify import edges (dashed)
      expect(result.mermaid).toContain('login-route -.->|imports| auth-service');
      expect(result.mermaid).toContain('auth-service -.->|imports| user-repo');
      expect(result.mermaid).toContain('user-repo -.->|imports| database');
      
      // Verify suspect highlighting (find-by-email should be highlighted)
      expect(result.mermaid).toContain('style find-by-email fill:#ff6b6b,stroke:#b30000,stroke-width:2px');
      
      // Verify error badge styling
      expect(result.mermaid).toContain('style error-handler fill:#ff8c42,stroke:#cc5200,stroke-width:2px');
      
      // Verify normal node styling
      expect(result.mermaid).toContain('style login-route fill:#4a9eff,stroke:#0056b3,stroke-width:1px');
      expect(result.mermaid).toContain('style auth-service fill:#4a9eff,stroke:#0056b3,stroke-width:1px');
      
      // Verify diagnostics
      expect(result.diagnostics).toContain('Deterministic Mermaid generated.');
      expect(result.diagnostics).toContain('Deterministic Mermaid validated successfully.');
    });

    it('should handle soft-error mode for API issues', async () => {
      const graph = {
        nodes: [
          { 
            id: 'api-route', 
            label: 'apiRoute.ts', 
            file: 'src/routes/api/users.ts', 
            kind: 'file' as const,
            badges: ['routeHandler']
          },
          { 
            id: 'get-users', 
            label: 'getUsers()', 
            file: 'src/routes/api/users.ts', 
            line: 20, 
            kind: 'symbol' as const 
          },
          { 
            id: 'serializer', 
            label: 'UserSerializer.ts', 
            file: 'src/serializers/UserSerializer.ts', 
            kind: 'file' as const 
          }
        ],
        edges: [
          { from: 'api-route', to: 'get-users', kind: 'calls' as const, confidence: 0.9 },
          { from: 'get-users', to: 'serializer', kind: 'calls' as const, confidence: 0.8 }
        ]
      };
      
      const report: RootCauseReport = {
        summary: 'API returning malformed JSON',
        likelyRootCause: 'UserSerializer.ts is not handling null values correctly',
        reasoningSteps: [],
        recommendedFix: 'Add null checks in serializer',
        evidence: [],
        confidence: 0.8,
        hypotheses: [],
        confidenceSummaryTable: '',
        timings: {}
      };
      
      const result = await service.generateVisualization(graph, report, 'soft-error', 'gpt-4');
      
      expect(result.meta.mode).toBe('soft-error');
      expect(result.mermaid).toContain('style api-route fill:#4a9eff'); // Route handler highlighted
      expect(result.mermaid).toContain('style serializer fill:#ff6b6b'); // Suspect highlighted
    });

    it('should handle behavior-first mode for feature issues', async () => {
      const graph = {
        nodes: [
          { 
            id: 'main-app', 
            label: 'App.tsx', 
            file: 'src/App.tsx', 
            kind: 'file' as const 
          },
          { 
            id: 'user-component', 
            label: 'UserComponent.tsx', 
            file: 'src/components/UserComponent.tsx', 
            kind: 'file' as const 
          },
          { 
            id: 'user-hook', 
            label: 'useUser.ts', 
            file: 'src/hooks/useUser.ts', 
            kind: 'file' as const 
          }
        ],
        edges: [
          { from: 'main-app', to: 'user-component', kind: 'calls' as const, confidence: 0.9 },
          { from: 'user-component', to: 'user-hook', kind: 'calls' as const, confidence: 0.8 }
        ]
      };
      
      const report: RootCauseReport = {
        summary: 'User profile not updating in UI',
        likelyRootCause: 'useUser hook is not triggering re-renders',
        reasoningSteps: [],
        recommendedFix: 'Add dependency array to useEffect',
        evidence: [],
        confidence: 0.8,
        hypotheses: [],
        confidenceSummaryTable: '',
        timings: {}
      };
      
      const result = await service.generateVisualization(graph, report, 'behavior-first', 'gpt-4');
      
      expect(result.meta.mode).toBe('behavior-first');
      expect(result.mermaid).toContain('style main-app fill:#4a9eff'); // Entrypoint highlighted
      expect(result.mermaid).toContain('style user-hook fill:#ff6b6b'); // Suspect highlighted
    });
  });

  describe('Error Recovery', () => {
    it('should recover from LLM beautification failure', async () => {
      const graph = {
        nodes: [{ id: 'test', label: 'Test', kind: 'file' as const }],
        edges: []
      };
      
      const report: RootCauseReport = {
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
      
      // Mock LLM to fail
      (mockLLMProvider.chat as jest.Mock).mockRejectedValue(new Error('LLM service down'));
      
      const result = await service.generateVisualization(graph, report, 'hard-error', 'gpt-4');
      
      expect(result.meta.source).toBe('deterministic');
      expect(result.diagnostics).toContain('LLM beautification failed: LLM service down');
      expect(result.mermaid).toContain('flowchart TD');
    });

    it('should handle validation failure gracefully', async () => {
      const graph = {
        nodes: [{ id: 'test', label: 'Test', kind: 'file' as const }],
        edges: []
      };
      
      const report: RootCauseReport = {
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
      
      // Mock validation to fail
      const originalValidate = require('../../../src/agent/tools/debugging/MermaidValidator').validateMermaid;
      jest.spyOn(require('../../../src/agent/tools/debugging/MermaidValidator'), 'validateMermaid')
        .mockResolvedValue({ isValid: false, errors: ['Invalid syntax'] });
      
      const result = await service.generateVisualization(graph, report, 'hard-error', 'gpt-4');
      
      expect(result.diagnostics).toContain('Validation failed: Invalid syntax');
      expect(result.mermaid).toBe(''); // Should return empty on validation failure
      
      // Restore original function
      require('../../../src/agent/tools/debugging/MermaidValidator').validateMermaid = originalValidate;
    });
  });

  describe('Performance', () => {
    it('should complete within reasonable time for large graphs', async () => {
      const nodes: GraphNode[] = [];
      const edges: GraphEdge[] = [];
      
      // Create a graph with 50 nodes (the limit)
      for (let i = 0; i < 50; i++) {
        nodes.push({
          id: `node${i}`,
          label: `Node ${i}`,
          file: `src/file${i}.ts`,
          kind: 'file' as const
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
        summary: 'Performance test',
        likelyRootCause: 'Error in node0',
        reasoningSteps: [],
        recommendedFix: 'Fix the error',
        evidence: [],
        confidence: 0.8,
        hypotheses: [],
        confidenceSummaryTable: '',
        timings: {}
      };
      
      const startTime = Date.now();
      const result = await service.generateVisualization(graph, report, 'hard-error', 'gpt-4');
      const duration = Date.now() - startTime;
      
      expect(duration).toBeLessThan(5000); // Should complete within 5 seconds
      expect(result.meta.nodeCount).toBe(50);
      expect(result.meta.edgeCount).toBe(49);
      expect(result.meta.truncated).toBe(false);
    });
  });
});
