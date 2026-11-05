/**
 * Tests for StaticSlicer
 */

import { StaticSlicer } from '../../../src/agent/tools/debugging/StaticSlicer';
import { RootSpec, ImportExportRelation, CallRelation } from '../../../src/agent/tools/debugging/types';

describe('StaticSlicer', () => {
  let staticSlicer: StaticSlicer;

  beforeEach(() => {
    staticSlicer = new StaticSlicer();
  });

  describe('buildSlice', () => {
    it('should build slice from error frames', () => {
      const roots: RootSpec = {
        errorFrames: [
          { file: '/test/src/api/user.ts', line: 15, fn: 'getUser' }
        ],
        topSymbols: [],
        userMentions: []
      };

      const importRelations: ImportExportRelation[] = [
        { from: '/test/src/api/user.ts', to: '/test/src/models/User.ts', kind: 'import', line: 1 }
      ];

      const callRelations: CallRelation[] = [
        { caller: 'getUser', callee: 'validateUser', file: '/test/src/api/user.ts', line: 15, confidence: 0.8 }
      ];

      const slice = staticSlicer.buildSlice(roots, importRelations, callRelations);

      expect(slice.nodes.length).toBeGreaterThan(0);
      expect(slice.edges.length).toBeGreaterThan(0);
      
      // Should have error node
      const errorNodes = slice.nodes.filter(node => node.badges?.includes('error'));
      expect(errorNodes.length).toBeGreaterThan(0);
    });

    it('should respect node limits', () => {
      const roots: RootSpec = {
        errorFrames: [
          { file: '/test/src/api/user.ts', line: 15, fn: 'getUser' }
        ],
        topSymbols: [],
        userMentions: []
      };

      const importRelations: ImportExportRelation[] = [];
      const callRelations: CallRelation[] = [];

      const slice = staticSlicer.buildSlice(roots, importRelations, callRelations, {
        maxNodes: 5,
        maxDepth: 2,
        confidenceThreshold: 0.1
      });

      expect(slice.nodes.length).toBeLessThanOrEqual(5);
    });

    it('should tag suspicious patterns', () => {
      const roots: RootSpec = {
        errorFrames: [
          { file: '/test/src/api/user.ts', line: 15, fn: 'getUser' }
        ],
        topSymbols: [],
        userMentions: []
      };

      const importRelations: ImportExportRelation[] = [
        { from: '/test/src/api/user.ts', to: '/test/src/models/User.ts', kind: 'export', line: 1 }
      ];

      const callRelations: CallRelation[] = [];

      const slice = staticSlicer.buildSlice(roots, importRelations, callRelations);

      // Should have suspicious nodes (export without matching import)
      const suspiciousNodes = slice.nodes.filter(node => node.badges?.includes('suspicious'));
      expect(suspiciousNodes.length).toBeGreaterThan(0);
    });

    it('should tag low confidence nodes', () => {
      const roots: RootSpec = {
        errorFrames: [
          { file: '/test/src/api/user.ts', line: 15, fn: 'getUser' }
        ],
        topSymbols: [],
        userMentions: []
      };

      const importRelations: ImportExportRelation[] = [];
      const callRelations: CallRelation[] = [
        { caller: 'getUser', callee: 'dynamicFunction', file: '/test/src/api/user.ts', line: 15, confidence: 0.1 }
      ];

      const slice = staticSlicer.buildSlice(roots, importRelations, callRelations, {
        maxNodes: 50,
        maxDepth: 5,
        confidenceThreshold: 0.2
      });

      // Should have low confidence nodes
      const lowConfidenceNodes = slice.nodes.filter(node => node.badges?.includes('lowConfidence'));
      expect(lowConfidenceNodes.length).toBeGreaterThan(0);
    });
  });

  describe('sortNodesByImportance', () => {
    it('should sort nodes by importance score', () => {
      const nodes = [
        {
          id: 'node1',
          kind: 'file' as const,
          label: 'user.ts',
          file: '/test/src/api/user.ts',
          badges: ['error']
        },
        {
          id: 'node2',
          kind: 'symbol' as const,
          label: 'getUser',
          file: '/test/src/api/user.ts',
          badges: []
        },
        {
          id: 'node3',
          kind: 'file' as const,
          label: 'helper.ts',
          file: '/test/src/utils/helper.ts',
          badges: ['suspicious']
        }
      ];

      const edges = [
        { from: 'node1', to: 'node2', kind: 'calls' as const, confidence: 0.8 },
        { from: 'node2', to: 'node3', kind: 'imports' as const, confidence: 0.6 }
      ];

      const sortedNodes = staticSlicer.sortNodesByImportance(nodes, edges);

      // Error nodes should be first
      expect(sortedNodes[0].badges).toContain('error');
      // Suspicious nodes should be second
      expect(sortedNodes[1].badges).toContain('suspicious');
    });
  });
});
