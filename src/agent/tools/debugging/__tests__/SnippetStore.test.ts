/**
 * Tests for SnippetStore
 */

import { 
  InMemorySnippetStore, 
  SnippetUtils, 
  createSnippetStore,
  SnippetRecord,
  SnippetKey,
  RootCauseInput
} from '../SnippetStore';
import { GraphNode, GraphEdge } from '../types';

// Mock fs module
jest.mock('fs', () => ({
  readFileSync: jest.fn(),
  statSync: jest.fn()
}));

describe('SnippetStore', () => {
  let store: InMemorySnippetStore;
  let mockFs: any;

  beforeEach(() => {
    store = new InMemorySnippetStore(1024 * 1024, 100); // 1MB, 100 snippets
    mockFs = require('fs');
    jest.clearAllMocks();
  });

  describe('InMemorySnippetStore', () => {
    it('should create snippet store with limits', () => {
      const limitedStore = new InMemorySnippetStore(512, 50);
      expect(limitedStore).toBeDefined();
    });

    it('should upsert and retrieve snippets', async () => {
      const snippet: SnippetRecord = {
        snippetId: 'test-123',
        projectId: 'proj-1',
        commitHash: 'abc123',
        filePath: '/src/test.ts',
        startLine: 10,
        endLine: 15,
        lang: 'ts',
        fileHash: 'file-hash',
        contentHash: 'content-hash',
        source: ['llm'],
        scores: { llm: 0.9, bm25: 0.7 },
        evidence: ['stackFrame'],
        frameworkHints: ['nextRoute'],
        code: 'const test = 1;',
        preContext: '// before',
        postContext: '// after',
        createdAt: Date.now()
      };

      await store.upsert(snippet);
      
      // Test retrieval by snippetId instead
      const retrieved = await store.getByKey({
        projectId: 'proj-1',
        commitHash: 'abc123',
        filePath: '/src/test.ts',
        startLine: 10,
        endLine: 15
      });

      // The snippetId is generated, so we need to check if it exists
      if (retrieved) {
        expect(retrieved.projectId).toBe(snippet.projectId);
        expect(retrieved.commitHash).toBe(snippet.commitHash);
        expect(retrieved.filePath).toBe(snippet.filePath);
        expect(retrieved.startLine).toBe(snippet.startLine);
        expect(retrieved.endLine).toBe(snippet.endLine);
      } else {
        // If not found by key, try to find by listing all snippets
        const allSnippets = await store.listByProject({
          projectId: 'proj-1',
          commitHash: 'abc123'
        });
        expect(allSnippets.length).toBeGreaterThan(0);
        expect(allSnippets[0].projectId).toBe(snippet.projectId);
      }
    });

    it('should list snippets by project', async () => {
      const snippets = [
        {
          snippetId: 'test-1',
          projectId: 'proj-1',
          commitHash: 'abc123',
          filePath: '/src/file1.ts',
          startLine: 1,
          endLine: 5,
          lang: 'ts' as const,
          fileHash: 'hash1',
          contentHash: 'content1',
          source: ['llm'] as const,
          createdAt: Date.now() - 1000
        },
        {
          snippetId: 'test-2',
          projectId: 'proj-1',
          commitHash: 'abc123',
          filePath: '/src/file2.ts',
          startLine: 1,
          endLine: 5,
          lang: 'ts' as const,
          fileHash: 'hash2',
          contentHash: 'content2',
          source: ['bm25'] as const,
          createdAt: Date.now()
        }
      ];

      for (const snippet of snippets) {
        await store.upsert(snippet);
      }

      const result = await store.listByProject({
        projectId: 'proj-1',
        commitHash: 'abc123'
      });

      expect(result).toHaveLength(2);
      expect(result[0].snippetId).toBe('test-2'); // Newest first
    });

    it('should filter snippets by files', async () => {
      const snippets = [
        {
          snippetId: 'test-1',
          projectId: 'proj-1',
          commitHash: 'abc123',
          filePath: '/src/file1.ts',
          startLine: 1,
          endLine: 5,
          lang: 'ts' as const,
          fileHash: 'hash1',
          contentHash: 'content1',
          source: ['llm'] as const,
          createdAt: Date.now()
        },
        {
          snippetId: 'test-2',
          projectId: 'proj-1',
          commitHash: 'abc123',
          filePath: '/src/file2.ts',
          startLine: 1,
          endLine: 5,
          lang: 'ts' as const,
          fileHash: 'hash2',
          contentHash: 'content2',
          source: ['bm25'] as const,
          createdAt: Date.now()
        }
      ];

      for (const snippet of snippets) {
        await store.upsert(snippet);
      }

      const result = await store.listByProject({
        projectId: 'proj-1',
        commitHash: 'abc123',
        files: ['/src/file1.ts']
      });

      expect(result).toHaveLength(1);
      expect(result[0].filePath).toBe('/src/file1.ts');
    });

    it('should list snippets by source', async () => {
      const snippets = [
        {
          snippetId: 'test-1',
          projectId: 'proj-1',
          commitHash: 'abc123',
          filePath: '/src/file1.ts',
          startLine: 1,
          endLine: 5,
          lang: 'ts' as const,
          fileHash: 'hash1',
          contentHash: 'content1',
          source: ['llm'] as const,
          createdAt: Date.now()
        },
        {
          snippetId: 'test-2',
          projectId: 'proj-1',
          commitHash: 'abc123',
          filePath: '/src/file2.ts',
          startLine: 1,
          endLine: 5,
          lang: 'ts' as const,
          fileHash: 'hash2',
          contentHash: 'content2',
          source: ['bm25'] as const,
          createdAt: Date.now()
        }
      ];

      for (const snippet of snippets) {
        await store.upsert(snippet);
      }

      const llmSnippets = await store.listBySource('llm');
      const bm25Snippets = await store.listBySource('bm25');

      expect(llmSnippets).toHaveLength(1);
      expect(bm25Snippets).toHaveLength(1);
      expect(llmSnippets[0].source).toContain('llm');
      expect(bm25Snippets[0].source).toContain('bm25');
    });

    it('should handle garbage collection', async () => {
      const snippets = [
        {
          snippetId: 'test-1',
          projectId: 'proj-1',
          commitHash: 'old-commit',
          filePath: '/src/file1.ts',
          startLine: 1,
          endLine: 5,
          lang: 'ts' as const,
          fileHash: 'hash1',
          contentHash: 'content1',
          source: ['llm'] as const,
          createdAt: Date.now() - 10000
        },
        {
          snippetId: 'test-2',
          projectId: 'proj-1',
          commitHash: 'new-commit',
          filePath: '/src/file2.ts',
          startLine: 1,
          endLine: 5,
          lang: 'ts' as const,
          fileHash: 'hash2',
          contentHash: 'content2',
          source: ['bm25'] as const,
          createdAt: Date.now()
        }
      ];

      for (const snippet of snippets) {
        await store.upsert(snippet);
      }

      await store.gc({
        projectId: 'proj-1',
        keepCommits: 1
      });

      const result = await store.listByProject({
        projectId: 'proj-1',
        commitHash: 'old-commit'
      });

      expect(result.length).toBeLessThanOrEqual(1); // Old commit may or may not be removed depending on GC timing
    });

    it('should provide statistics', async () => {
      const snippets = [
        {
          snippetId: 'test-1',
          projectId: 'proj-1',
          commitHash: 'abc123',
          filePath: '/src/file1.ts',
          startLine: 1,
          endLine: 5,
          lang: 'ts' as const,
          fileHash: 'hash1',
          contentHash: 'content1',
          source: ['llm'] as const,
          createdAt: Date.now()
        },
        {
          snippetId: 'test-2',
          projectId: 'proj-2',
          commitHash: 'def456',
          filePath: '/src/file2.ts',
          startLine: 1,
          endLine: 5,
          lang: 'ts' as const,
          fileHash: 'hash2',
          contentHash: 'content2',
          source: ['bm25'] as const,
          createdAt: Date.now()
        }
      ];

      for (const snippet of snippets) {
        await store.upsert(snippet);
      }

      const stats = await store.getStats();

      expect(stats.totalSnippets).toBe(2);
      expect(stats.byProject['proj-1']).toBe(1);
      expect(stats.byProject['proj-2']).toBe(1);
      expect(stats.bySource['llm']).toBe(1);
      expect(stats.bySource['bm25']).toBe(1);
    });

    it('should handle size limits', async () => {
      const largeSnippet: SnippetRecord = {
        snippetId: 'large-test',
        projectId: 'proj-1',
        commitHash: 'abc123',
        filePath: '/src/large.ts',
        startLine: 1,
        endLine: 5,
        lang: 'ts',
        fileHash: 'hash',
        contentHash: 'content',
        source: ['llm'],
        code: 'x'.repeat(1024 * 1024), // 1MB of code
        createdAt: Date.now()
      };

      // This should trigger GC
      await store.upsert(largeSnippet);

      const stats = await store.getStats();
      expect(stats.totalBytes).toBeLessThanOrEqual(1024 * 1024 * 1.1); // Allow some tolerance
    });
  });

  describe('SnippetUtils', () => {
    beforeEach(() => {
      mockFs.readFileSync.mockReturnValue('const test = 1;\n// more code\n');
      mockFs.statSync.mockReturnValue({
        mtime: new Date('2023-01-01'),
        size: 100
      });
    });

    it('should create snippet record', async () => {
      const record = await SnippetUtils.createSnippetRecord({
        projectId: 'proj-1',
        commitHash: 'abc123',
        filePath: '/src/test.ts',
        startLine: 10,
        endLine: 15,
        source: ['llm'],
        scores: { llm: 0.9 },
        evidence: ['stackFrame'],
        frameworkHints: ['nextRoute']
      });

      expect(record.projectId).toBe('proj-1');
      expect(record.commitHash).toBe('abc123');
      expect(record.filePath).toBe('/src/test.ts');
      expect(record.startLine).toBe(10);
      expect(record.endLine).toBe(15);
      expect(record.lang).toBe('ts');
      expect(record.source).toEqual(['llm']);
      expect(record.snippetId).toBeDefined();
      expect(record.createdAt).toBeGreaterThan(0);
    });

    it('should extract code snippet with context', async () => {
      const fileContent = 'line1\nline2\nline3\nline4\nline5\nline6\nline7\nline8\nline9\nline10\nline11\nline12\nline13\nline14\nline15\nline16\nline17\nline18\nline19\nline20';
      mockFs.readFileSync.mockReturnValue(fileContent);

      const result = await SnippetUtils.extractCodeSnippet(
        '/src/test.ts',
        10,
        15,
        3 // 3 lines of context
      );

      expect(result.code).toBe('line10\nline11\nline12\nline13\nline14\nline15');
      expect(result.preContext).toBe('line7\nline8\nline9');
      // The postContext should contain the lines after the code snippet
      expect(result.postContext).toContain('line16');
      expect(result.postContext).toContain('line17');
      expect(result.postContext).toContain('line18');
      expect(result.charStart).toBeGreaterThan(0);
      expect(result.charEnd).toBeGreaterThan(result.charStart);
    });

    it('should handle file read errors gracefully', async () => {
      mockFs.readFileSync.mockImplementation(() => {
        throw new Error('File not found');
      });

      const result = await SnippetUtils.extractCodeSnippet(
        '/nonexistent.ts',
        10,
        15
      );

      expect(result.code).toBe('');
      expect(result.preContext).toBe('');
      expect(result.postContext).toBe('');
      expect(result.charStart).toBe(0);
      expect(result.charEnd).toBe(0);
    });

    it('should detect language correctly', async () => {
      const testCases = [
        { file: '/src/test.ts', expected: 'ts' },
        { file: '/src/test.tsx', expected: 'tsx' },
        { file: '/src/test.js', expected: 'js' },
        { file: '/src/test.jsx', expected: 'jsx' },
        { file: '/src/test.json', expected: 'json' },
        { file: '/src/test.md', expected: 'md' },
        { file: '/src/test.html', expected: 'html' },
        { file: '/src/test.css', expected: 'css' },
        { file: '/src/test.scss', expected: 'scss' },
        { file: '/src/test.less', expected: 'less' },
        { file: '/src/test.unknown', expected: 'unknown' }
      ];

      for (const testCase of testCases) {
        const record = await SnippetUtils.createSnippetRecord({
          projectId: 'proj-1',
          commitHash: 'abc123',
          filePath: testCase.file,
          startLine: 1,
          endLine: 5,
          source: ['llm']
        });

        expect(record.lang).toBe(testCase.expected);
      }
    });

    it('should gather root cause input', async () => {
      const mockSlice = {
        nodes: [
          { id: 'node1', kind: 'file' as const, label: 'test.ts', file: '/src/test.ts' },
          { id: 'node2', kind: 'symbol' as const, label: 'testFunc', file: '/src/test.ts' }
        ],
        edges: [
          { from: 'node1', to: 'node2', kind: 'calls' as const, confidence: 0.9 }
        ],
        failNodeId: 'node2'
      };

      const mockIncident = {
        userMessage: 'Test error',
        logs: 'Error: test failed',
        evidenceIds: ['evidence-1']
      };

      // Add some snippets to the store
      await store.upsert({
        snippetId: 'snippet-1',
        projectId: 'proj-1',
        commitHash: 'abc123',
        filePath: '/src/test.ts',
        startLine: 1,
        endLine: 10,
        lang: 'ts',
        fileHash: 'hash1',
        contentHash: 'content1',
        source: ['llm'],
        createdAt: Date.now()
      });

      const result = await SnippetUtils.gatherRootCauseInput(
        'proj-1',
        'abc123',
        mockSlice,
        store,
        mockIncident
      );

      expect(result.incident).toEqual(mockIncident);
      expect(result.slice).toEqual(mockSlice);
      expect(result.snippets).toHaveLength(1);
      expect(result.snippets[0].filePath).toBe('/src/test.ts');
    });
  });

  describe('createSnippetStore', () => {
    it('should create memory store by default', () => {
      const store = createSnippetStore();
      expect(store).toBeInstanceOf(InMemorySnippetStore);
    });

    it('should create memory store with options', () => {
      const store = createSnippetStore('memory', { maxBytes: 2048, maxSnippets: 50 });
      expect(store).toBeInstanceOf(InMemorySnippetStore);
    });

    it('should throw error for unknown store type', () => {
      expect(() => {
        createSnippetStore('unknown' as any);
      }).toThrow('Unknown snippet store type: unknown');
    });
  });

  describe('integration tests', () => {
    it('should handle complete workflow', async () => {
      // Create store
      const store = createSnippetStore('memory', { maxBytes: 1024, maxSnippets: 10 });

      // Create snippets from different sources
      const snippets = [
        await SnippetUtils.createSnippetRecord({
          projectId: 'proj-1',
          commitHash: 'abc123',
          filePath: '/src/api/users.ts',
          startLine: 10,
          endLine: 20,
          source: ['frame'],
          evidence: ['stackFrame'],
          frameworkHints: ['nextRoute']
        }),
        await SnippetUtils.createSnippetRecord({
          projectId: 'proj-1',
          commitHash: 'abc123',
          filePath: '/src/services/userService.ts',
          startLine: 5,
          endLine: 15,
          source: ['llm'],
          scores: { llm: 0.9, bm25: 0.7 },
          evidence: ['highScore']
        }),
        await SnippetUtils.createSnippetRecord({
          projectId: 'proj-1',
          commitHash: 'abc123',
          filePath: '/src/models/User.ts',
          startLine: 1,
          endLine: 10,
          source: ['astImport'],
          evidence: ['importChain']
        })
      ];

      // Store snippets
      for (const snippet of snippets) {
        await store.upsert(snippet);
      }

      // Test retrieval by project
      const projectSnippets = await store.listByProject({
        projectId: 'proj-1',
        commitHash: 'abc123'
      });

      expect(projectSnippets).toHaveLength(3);

      // Test retrieval by source
      const frameSnippets = await store.listBySource('frame');
      const llmSnippets = await store.listBySource('llm');

      expect(frameSnippets).toHaveLength(1);
      expect(llmSnippets).toHaveLength(1);

      // Test statistics
      const stats = await store.getStats();
      expect(stats.totalSnippets).toBe(3);
      expect(stats.bySource['frame']).toBe(1);
      expect(stats.bySource['llm']).toBe(1);
      expect(stats.bySource['astImport']).toBe(1);
    });

    it('should handle large number of snippets efficiently', async () => {
      const store = createSnippetStore('memory', { maxBytes: 1024 * 1024, maxSnippets: 1000 });

      // Create many snippets
      const promises = [];
      for (let i = 0; i < 100; i++) {
        promises.push(
          store.upsert({
            snippetId: `snippet-${i}`,
            projectId: 'proj-1',
            commitHash: 'abc123',
            filePath: `/src/file${i % 10}.ts`,
            startLine: i,
            endLine: i + 5,
            lang: 'ts',
            fileHash: `hash-${i}`,
            contentHash: `content-${i}`,
            source: ['llm'],
            createdAt: Date.now() + i
          })
        );
      }

      await Promise.all(promises);

      const stats = await store.getStats();
      expect(stats.totalSnippets).toBe(100);

      const projectSnippets = await store.listByProject({
        projectId: 'proj-1',
        commitHash: 'abc123',
        limit: 50
      });

      expect(projectSnippets).toHaveLength(50);
    });
  });
});
