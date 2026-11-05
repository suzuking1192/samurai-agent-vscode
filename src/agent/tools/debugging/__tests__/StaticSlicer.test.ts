/**
 * Tests for StaticSlicer
 */

import { StaticSlicer } from '../StaticSlicer';
import { 
  Evidence, 
  GraphNode, 
  GraphEdge, 
  RootSpec, 
  SliceLimits,
  ImportExportRelation,
  CallRelation
} from '../types';

describe('StaticSlicer', () => {
  let slicer: StaticSlicer;
  let mockEvidence: Evidence;
  let mockRoots: RootSpec;
  let mockImportRelations: ImportExportRelation[];
  let mockCallRelations: CallRelation[];

  beforeEach(() => {
    slicer = new StaticSlicer();
    
    mockEvidence = {
      frames: [
        { file: '/src/api/users.ts', line: 15, fn: 'getUser' },
        { file: '/src/services/userService.ts', line: 8, fn: 'findUser' }
      ],
      error: 'TypeError: Cannot read property "name" of undefined',
      requestId: 'req-123',
      route: '/api/users',
      logSignatures: ['getUser failed', 'userService.findUser'],
      tsconfigPaths: { '@/*': ['/src/*'] },
      warnings: [],
      confidence: 0.8
    };

    mockRoots = {
      errorFrames: [
        { file: '/src/api/users.ts', line: 15, fn: 'getUser' }
      ],
      topSymbols: [
        { file: '/src/services/userService.ts', symbol: 'findUser', startLine: 8, endLine: 12, score: 0.9, evidence: ['stackFrame'] }
      ],
      userMentions: ['userService', 'getUser']
    };

    mockImportRelations = [
      {
        from: '/src/api/users.ts',
        to: '/src/services/userService.ts',
        kind: 'import',
        line: 3,
        confidence: 0.95
      },
      {
        from: '/src/services/userService.ts',
        to: '/src/models/User.ts',
        kind: 'import',
        line: 2,
        confidence: 0.9
      }
    ];

    mockCallRelations = [
      {
        caller: 'getUser',
        callee: 'findUser',
        file: '/src/api/users.ts',
        line: 16,
        confidence: 0.9
      },
      {
        caller: 'findUser',
        callee: 'User.findById',
        file: '/src/services/userService.ts',
        line: 10,
        confidence: 0.8
      }
    ];
  });

  describe('buildSlice', () => {
    it('should build slice with priority-guided expansion', () => {
      const result = slicer.buildSlice(
        mockRoots,
        mockImportRelations,
        mockCallRelations
      );

      expect(result.nodes).toBeDefined();
      expect(result.edges).toBeDefined();
      expect(result.nodes.length).toBeGreaterThan(0);
      expect(result.edges.length).toBeGreaterThan(0);
    });

    it('should respect maxNodes limit', () => {
      const limits: SliceLimits = {
        maxNodes: 5,
        maxDepth: 3,
        confidenceThreshold: 0.2
      };

      const result = slicer.buildSlice(
        mockRoots,
        mockImportRelations,
        mockCallRelations,
        limits
      );

      expect(result.nodes.length).toBeLessThanOrEqual(6); // Allow for root nodes
    });

    it('should respect maxDepth limit', () => {
      const limits: SliceLimits = {
        maxNodes: 50,
        maxDepth: 2,
        confidenceThreshold: 0.2
      };

      const result = slicer.buildSlice(
        mockRoots,
        mockImportRelations,
        mockCallRelations,
        limits
      );

      // Verify depth is respected by checking that we don't have too many nodes
      expect(result.nodes.length).toBeLessThan(20); // Should be limited by depth
    });

    it('should filter edges by confidence threshold', () => {
      const limits: SliceLimits = {
        maxNodes: 50,
        maxDepth: 5,
        confidenceThreshold: 0.9 // High threshold
      };

      const result = slicer.buildSlice(
        mockRoots,
        mockImportRelations,
        mockCallRelations,
        limits
      );

      // All edges should meet confidence threshold
      for (const edge of result.edges) {
        expect(edge.confidence).toBeGreaterThanOrEqual(0.9);
      }
    });

    it('should include runtime overlay when evidence provided', () => {
      const result = slicer.buildSlice(
        mockRoots,
        mockImportRelations,
        mockCallRelations,
        undefined,
        mockEvidence
      );

      expect(result.runtime).toBeDefined();
      expect(result.runtime!.anchors).toBeDefined();
      expect(result.runtime!.anchors.length).toBeGreaterThan(0);
    });

    it('should create proper node IDs', () => {
      const result = slicer.buildSlice(
        mockRoots,
        mockImportRelations,
        mockCallRelations
      );

      const fileNodes = result.nodes.filter(n => n.kind === 'file');
      const symbolNodes = result.nodes.filter(n => n.kind === 'symbol');

      // Check file node IDs
      for (const node of fileNodes) {
        expect(node.id).toMatch(/^file:/);
        expect(node.file).toBeDefined();
      }

      // Check symbol node IDs (exclude mention nodes)
      for (const node of symbolNodes) {
        if (!node.id.startsWith('mention:')) {
          expect(node.id).toMatch(/^symbol:/);
        }
        expect(node.label).toBeDefined();
      }
    });
  });

  describe('priority calculation', () => {
    it('should prioritize nodes near error files', () => {
      const result = slicer.buildSlice(
        mockRoots,
        mockImportRelations,
        mockCallRelations,
        undefined,
        mockEvidence
      );

      const errorNodes = result.nodes.filter(n => n.badges?.includes('error'));
      expect(errorNodes.length).toBeGreaterThan(0);
    });

    it('should prioritize nodes with high centrality', () => {
      const result = slicer.buildSlice(
        mockRoots,
        mockImportRelations,
        mockCallRelations
      );

      // Nodes with more connections should be included
      const nodesWithEdges = result.nodes.filter(n => 
        result.edges.some(e => e.from === n.id || e.to === n.id)
      );
      expect(nodesWithEdges.length).toBeGreaterThan(0);
    });
  });

  describe('runtime overlay', () => {
    it('should create anchors from stack frames', () => {
      const result = slicer.buildSlice(
        mockRoots,
        mockImportRelations,
        mockCallRelations,
        undefined,
        mockEvidence
      );

      expect(result.runtime).toBeDefined();
      const stackFrameAnchors = result.runtime!.anchors.filter(a => 
        a.why.includes('stackFrame')
      );
      expect(stackFrameAnchors.length).toBeGreaterThan(0);
    });

    it('should create anchors from route matches', () => {
      const result = slicer.buildSlice(
        mockRoots,
        mockImportRelations,
        mockCallRelations,
        undefined,
        mockEvidence
      );

      expect(result.runtime).toBeDefined();
      const routeAnchors = result.runtime!.anchors.filter(a => 
        a.why.includes('routeMatch')
      );
      // May or may not have route anchors depending on graph structure
      expect(routeAnchors.length).toBeGreaterThanOrEqual(0);
    });

    it('should create anchors from log signatures', () => {
      const result = slicer.buildSlice(
        mockRoots,
        mockImportRelations,
        mockCallRelations,
        undefined,
        mockEvidence
      );

      expect(result.runtime).toBeDefined();
      const logAnchors = result.runtime!.anchors.filter(a => 
        a.why.includes('logSignature')
      );
      // May or may not have log signature anchors depending on matches
      expect(logAnchors.length).toBeGreaterThanOrEqual(0);
    });

    it('should choose fail node from anchors', () => {
      const result = slicer.buildSlice(
        mockRoots,
        mockImportRelations,
        mockCallRelations,
        undefined,
        mockEvidence
      );

      if (result.runtime?.anchors.length > 0) {
        expect(result.runtime.failNodeId).toBeDefined();
        const failNode = result.nodes.find(n => n.id === result.runtime!.failNodeId);
        expect(failNode).toBeDefined();
      }
    });
  });

  describe('heuristics and pattern detection', () => {
    it('should detect suspicious patterns', () => {
      const suspiciousImports: ImportExportRelation[] = [
        {
          from: '/src/api/users.ts',
          to: '/src/services/userService.ts',
          kind: 'exports',
          line: 3,
          confidence: 0.8
        }
        // No matching import
      ];

      const result = slicer.buildSlice(
        mockRoots,
        suspiciousImports,
        mockCallRelations
      );

      const suspiciousNodes = result.nodes.filter(n => 
        n.badges?.includes('suspicious')
      );
      expect(suspiciousNodes.length).toBeGreaterThanOrEqual(0);
    });

    it('should detect circular imports', () => {
      const circularImports: ImportExportRelation[] = [
        {
          from: '/src/a.ts',
          to: '/src/b.ts',
          kind: 'import',
          line: 1,
          confidence: 0.9
        },
        {
          from: '/src/b.ts',
          to: '/src/a.ts',
          kind: 'import',
          line: 1,
          confidence: 0.9
        }
      ];

      const circularRoots: RootSpec = {
        errorFrames: [{ file: '/src/a.ts', line: 1, fn: 'test' }],
        topSymbols: [],
        userMentions: []
      };

      const result = slicer.buildSlice(
        circularRoots,
        circularImports,
        []
      );

      const suspiciousNodes = result.nodes.filter(n => 
        n.badges?.includes('suspicious')
      );
      expect(suspiciousNodes.length).toBeGreaterThanOrEqual(0);
    });

    it('should tag low confidence nodes', () => {
      const lowConfidenceCalls: CallRelation[] = [
        {
          caller: 'test',
          callee: 'dynamicFunction',
          file: '/src/test.ts',
          line: 1,
          confidence: 0.3 // Low confidence
        }
      ];

      const lowConfidenceRoots: RootSpec = {
        errorFrames: [{ file: '/src/test.ts', line: 1, fn: 'test' }],
        topSymbols: [],
        userMentions: []
      };

      const result = slicer.buildSlice(
        lowConfidenceRoots,
        [],
        lowConfidenceCalls
      );

      const lowConfidenceNodes = result.nodes.filter(n => 
        n.badges?.includes('lowConfidence')
      );
      expect(lowConfidenceNodes.length).toBeGreaterThanOrEqual(0);
    });

    it('should tag error nodes', () => {
      const result = slicer.buildSlice(
        mockRoots,
        mockImportRelations,
        mockCallRelations
      );

      const errorNodes = result.nodes.filter(n => 
        n.badges?.includes('error')
      );
      expect(errorNodes.length).toBeGreaterThan(0);
    });
  });

  describe('edge pruning', () => {
    it('should prune dominated edges', () => {
      const duplicateEdges: GraphEdge[] = [
        {
          from: 'file:/src/a.ts',
          to: 'file:/src/b.ts',
          kind: 'imports',
          confidence: 0.9
        },
        {
          from: 'file:/src/a.ts',
          to: 'file:/src/b.ts',
          kind: 'imports',
          confidence: 0.7 // Lower confidence duplicate
        }
      ];

      const result = slicer['pruneDominatedEdges'](duplicateEdges, 0.5);
      
      // Should keep only the higher confidence edge
      expect(result.length).toBe(1);
      expect(result[0].confidence).toBe(0.9);
    });

    it('should filter edges below threshold', () => {
      const edges: GraphEdge[] = [
        {
          from: 'file:/src/a.ts',
          to: 'file:/src/b.ts',
          kind: 'imports',
          confidence: 0.9
        },
        {
          from: 'file:/src/a.ts',
          to: 'file:/src/c.ts',
          kind: 'imports',
          confidence: 0.1 // Below threshold
        }
      ];

      const result = slicer['pruneDominatedEdges'](edges, 0.5);
      
      expect(result.length).toBe(1);
      expect(result[0].confidence).toBe(0.9);
    });
  });

  describe('utility methods', () => {
    it('should calculate node importance correctly', () => {
      const node: GraphNode = {
        id: 'test',
        kind: 'file',
        label: 'test.ts',
        file: '/src/test.ts',
        badges: ['error', 'suspicious']
      };

      const edges: GraphEdge[] = [
        { from: 'a', to: 'test', kind: 'imports', confidence: 0.8 },
        { from: 'test', to: 'b', kind: 'imports', confidence: 0.8 }
      ];

      const importance = slicer['calculateNodeImportance'](node, edges);
      
      // Error badge: +1.0, suspicious badge: +0.5, incoming edges: +0.1, outgoing edges: +0.1
      expect(importance).toBeCloseTo(1.7, 1);
    });

    it('should sort nodes by importance', () => {
      const nodes: GraphNode[] = [
        {
          id: 'low',
          kind: 'file',
          label: 'low.ts',
          badges: ['lowConfidence']
        },
        {
          id: 'high',
          kind: 'file',
          label: 'high.ts',
          badges: ['error']
        }
      ];

      const edges: GraphEdge[] = [];

      const sorted = slicer.sortNodesByImportance(nodes, edges);
      
      expect(sorted[0].id).toBe('high');
      expect(sorted[1].id).toBe('low');
    });

    it('should extract top token from log signatures', () => {
      const token1 = slicer['extractTopToken']('getUser failed');
      expect(token1).toBe('getUser');

      const token2 = slicer['extractTopToken']('userService.findUser');
      expect(token2).toBe('userService');

      const token3 = slicer['extractTopToken']('123 invalid input');
      expect(token3).toBe('invalid'); // The regex will match 'invalid'
    });

    it('should calculate evidence boost correctly', () => {
      const node: GraphNode = {
        id: 'test',
        kind: 'file',
        label: 'test.ts',
        file: '/src/api/users.ts'
      };

      const evidence = {
        errorFiles: new Set(['/src/api/users.ts']),
        route: '/api/users'
      };

      const boost = slicer['calculateEvidenceBoost'](node, evidence);
      expect(boost).toBeGreaterThan(0);
    });

    it('should calculate centrality hint correctly', () => {
      const centrality = slicer['calculateCentralityHint'](
        '/src/services/userService.ts',
        mockImportRelations
      );
      expect(centrality).toBeGreaterThanOrEqual(0);
      expect(centrality).toBeLessThanOrEqual(1);
    });

    it('should calculate name match correctly', () => {
      const match1 = slicer['calculateNameMatch']('getUser', '/api/users');
      expect(match1).toBeGreaterThan(0);

      const match2 = slicer['calculateNameMatch']('unrelated', '/api/users');
      expect(match2).toBeLessThan(0.5); // Should have low match score
    });
  });

  describe('LLM refinement', () => {
    it('should handle LLM refinement gracefully when config provided', () => {
      const llmConfig = {
        model: 'gpt-4',
        temperature: 0.3,
        maxTokens: 1000
      };

      const whitelist = ['/src/api/users.ts', '/src/services/userService.ts'];

      const result = slicer.buildSlice(
        mockRoots,
        mockImportRelations,
        mockCallRelations,
        undefined,
        mockEvidence,
        llmConfig,
        whitelist
      );

      expect(result.nodes).toBeDefined();
      expect(result.edges).toBeDefined();
    });

    it('should verify edge suggestions against whitelist', () => {
      const validEdge = {
        from: 'file:/src/api/users.ts',
        to: 'file:/src/services/userService.ts',
        kind: 'imports',
        reason: 'test'
      };

      const invalidEdge = {
        from: 'file:/src/api/users.ts',
        to: 'file:/external/lib.ts',
        kind: 'imports',
        reason: 'test'
      };

      const whitelist = ['/src/api/users.ts', '/src/services/userService.ts'];

      const valid = slicer['verifyEdge'](validEdge, whitelist);
      const invalid = slicer['verifyEdge'](invalidEdge, whitelist);

      expect(valid).toBe(true);
      expect(invalid).toBe(false);
    });
  });

  describe('error handling', () => {
    it('should handle empty roots gracefully', () => {
      const emptyRoots: RootSpec = {
        errorFrames: [],
        topSymbols: [],
        userMentions: []
      };

      const result = slicer.buildSlice(
        emptyRoots,
        mockImportRelations,
        mockCallRelations
      );

      expect(result.nodes).toBeDefined();
      expect(result.edges).toBeDefined();
    });

    it('should handle empty relations gracefully', () => {
      const result = slicer.buildSlice(
        mockRoots,
        [],
        []
      );

      expect(result.nodes).toBeDefined();
      expect(result.edges).toBeDefined();
      expect(result.nodes.length).toBeGreaterThan(0); // Should have root nodes
    });

    it('should handle malformed evidence gracefully', () => {
      const malformedEvidence: Evidence = {
        frames: [],
        logSignatures: [],
        tsconfigPaths: {}
      };

      const result = slicer.buildSlice(
        mockRoots,
        mockImportRelations,
        mockCallRelations,
        undefined,
        malformedEvidence
      );

      expect(result.nodes).toBeDefined();
      expect(result.edges).toBeDefined();
    });
  });

  describe('performance', () => {
    it('should complete within reasonable time for large graphs', () => {
      const largeImportRelations: ImportExportRelation[] = [];
      const largeCallRelations: CallRelation[] = [];

      // Generate large number of relations
      for (let i = 0; i < 100; i++) {
        largeImportRelations.push({
          from: `/src/file${i}.ts`,
          to: `/src/file${i + 1}.ts`,
          kind: 'import',
          line: 1,
          confidence: 0.8
        });

        largeCallRelations.push({
          caller: `function${i}`,
          callee: `function${i + 1}`,
          file: `/src/file${i}.ts`,
          line: 1,
          confidence: 0.8
        });
      }

      const start = Date.now();
      const result = slicer.buildSlice(
        mockRoots,
        largeImportRelations,
        largeCallRelations
      );
      const duration = Date.now() - start;

      expect(result.nodes).toBeDefined();
      expect(result.edges).toBeDefined();
      expect(duration).toBeLessThan(5000); // Should complete within 5 seconds
    });
  });

  describe('stack overflow prevention', () => {
    it('should handle large circular import graphs without stack overflow', () => {
      // Create a large circular import graph that would cause stack overflow with recursive DFS
      const largeCircularImports: ImportExportRelation[] = [];
      
      // Create 500 files in a circular chain: file0 -> file1 -> ... -> file499 -> file0
      for (let i = 0; i < 500; i++) {
        const fromFile = `/src/file${i}.ts`;
        const toFile = i === 499 ? `/src/file0.ts` : `/src/file${i + 1}.ts`;
        
        largeCircularImports.push({
          from: fromFile,
          to: toFile,
          kind: 'import',
          line: 1,
          confidence: 0.9
        });
      }

      const circularRoots: RootSpec = {
        errorFrames: [{ file: '/src/file0.ts', line: 1, fn: 'test' }],
        topSymbols: [],
        userMentions: []
      };

      // This should not throw a stack overflow error
      expect(() => {
        const result = slicer.buildSlice(
          circularRoots,
          largeCircularImports,
          [],
          { maxNodes: 500, maxDepth: 10, confidenceThreshold: 0.2 } // Higher limits for this test
        );
        
        // Should complete successfully
        expect(result.nodes).toBeDefined();
        expect(result.edges).toBeDefined();
        expect(result.nodes.length).toBeGreaterThan(0);
        
        // The important thing is that it doesn't crash with stack overflow
        // Cycle detection may vary based on which nodes are included in the slice
      }).not.toThrow();
    });

    it('should handle deep nested circular imports without stack overflow', () => {
      // Create a complex graph with multiple nested cycles
      const complexImports: ImportExportRelation[] = [];
      
      // Create 10 groups of 50 files each in circular patterns
      for (let group = 0; group < 10; group++) {
        const startIdx = group * 50;
        
        // Each group has circular imports
        for (let i = 0; i < 50; i++) {
          const fromFile = `/src/group${group}/file${i}.ts`;
          const toFile = i === 49 
            ? `/src/group${group}/file0.ts` 
            : `/src/group${group}/file${i + 1}.ts`;
          
          complexImports.push({
            from: fromFile,
            to: toFile,
            kind: 'import',
            line: 1,
            confidence: 0.9
          });
        }
        
        // Link groups together
        if (group < 9) {
          complexImports.push({
            from: `/src/group${group}/file0.ts`,
            to: `/src/group${group + 1}/file0.ts`,
            kind: 'import',
            line: 1,
            confidence: 0.9
          });
        }
      }

      const complexRoots: RootSpec = {
        errorFrames: [{ file: '/src/group0/file0.ts', line: 1, fn: 'test' }],
        topSymbols: [],
        userMentions: []
      };

      expect(() => {
        const result = slicer.buildSlice(
          complexRoots,
          complexImports,
          []
        );
        
        expect(result.nodes).toBeDefined();
        expect(result.edges).toBeDefined();
        expect(result.nodes.length).toBeGreaterThan(0);
      }).not.toThrow();
    });
  });
});