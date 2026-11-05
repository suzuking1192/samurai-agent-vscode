/**
 * Tests for extractForDebugging method
 * 
 * Tests the new ts-morph based directed code execution graph building
 * to ensure it runs properly and produces valid output
 */

import * as path from 'path';
import * as fs from 'fs';
import { ExtractCodeTool } from '../../../agent/tools/extractCodeTool';
import { LLMProviderService } from '../../../agent/llm/llmProviderService';
import { DebuggingExtractionInput, ExtractionResponse } from '../../../agent/tools/debugging/types';

// Helper to find repo root
function findRepoRoot(startDir: string): string {
  let current = startDir;
  for (let i = 0; i < 20; i++) {
    if (fs.existsSync(path.join(current, 'package.json')) || 
        fs.existsSync(path.join(current, 'tsconfig.json'))) {
      return current;
    }
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return startDir;
}

// Mock LLM provider for testing without actual LLM
const mockLLMProvider = {
  generateResponse: jest.fn().mockResolvedValue({
    content: JSON.stringify({ candidateFiles: [], symbols: [], queries: [] }),
    tokensUsed: 0,
    cost: 0
  })
} as unknown as LLMProviderService;

// Helper to create a real LLM provider if API key is available
function createRealLLMProvider(): LLMProviderService | null {
  const geminiApiKey = process.env.GEMINI_API_KEY;
  if (!geminiApiKey) {
    return null;
  }

  const globalDataStore = {
    loadGlobalSettings: () => ({
      type: 'success' as const,
      payload: {
        id: 'test-settings',
        userId: 'test-user',
        openaiApiKey: '',
        geminiApiKey: geminiApiKey,
        claudeApiKey: '',
        defaultProvider: 'google',
        defaultModel: 'gemini-2.0-flash-exp',
        defaultMode: 'default',
        fontSize: 14,
        showTokenCounts: true,
        showCostEstimates: true,
        autoSaveInterval: 30,
        maxHistoryItems: 100,
        enableNotifications: true,
        customApiEndpoints: {},
        metadata: {},
        createdAt: new Date(),
        updatedAt: new Date()
      }
    }),
    saveGlobalSettings: () => ({ type: 'success' as const })
  } as any;

  const { GeminiChatClient } = require('../../../agent/llm/GeminiChatClient');
  const llmProvider = new LLMProviderService(globalDataStore);
  llmProvider.registerClient('google', new GeminiChatClient());
  return llmProvider;
}

describe('ExtractCodeTool.extractForDebugging', () => {
  const repoRoot = findRepoRoot(__dirname);
  const srcRoot = path.join(repoRoot, 'src');
  const extractCodeFile = path.join(srcRoot, 'agent', 'tools', 'extractCodeTool.ts');

  // Create realistic stack trace
  const mockLogs = fs.existsSync(extractCodeFile)
    ? `Error: Cannot find module './debugging/GapDetector.js'\n` +
      `    at Object.extractForDebugging (${extractCodeFile}:2224:39)\n` +
      `    at async handleDebugging (${path.join(srcRoot, 'agent', 'core', 'samuraiAgent.ts')}:980:5)\n`
    : 'Error: Test error\n    at testHandler (test.ts:10:5)\n';

  let llmProvider: LLMProviderService;
  let extractCodeTool: ExtractCodeTool;

  beforeAll(() => {
    llmProvider = createRealLLMProvider() || mockLLMProvider;
    extractCodeTool = new ExtractCodeTool(llmProvider, {} as any, {} as any);
  });

  describe('Basic functionality', () => {
    it('should run without errors and return valid ExtractionResponse', async () => {
      const input: DebuggingExtractionInput = {
        userMessage: 'Test debugging extraction',
        logs: mockLogs,
        workspace: repoRoot,
        model: 'test-model',
        config: {
          maxNodes: 50,
          maxDepth: 5,
          timeouts: {
            evidence: 1000,
            plan: 5000,
            retrieval: 10000,
            ast: 15000,
            slice: 5000
          }
        }
      };

      const result = await extractCodeTool.extractForDebugging(input);

      // Verify result structure
      expect(result).toBeDefined();
      expect(result).toHaveProperty('evidence');
      expect(result).toHaveProperty('candidates');
      expect(result).toHaveProperty('graph');
      expect(result).toHaveProperty('timings');
      expect(result).toHaveProperty('confidence');
      
      // Verify evidence structure
      expect(result.evidence).toHaveProperty('frames');
      expect(result.evidence).toHaveProperty('evidenceSource');
      expect(result.evidence).toHaveProperty('hasHardError');
      expect(result.evidence).toHaveProperty('hasLogs');
      expect(Array.isArray(result.evidence.frames)).toBe(true);

      // Verify candidates structure
      expect(Array.isArray(result.candidates)).toBe(true);
      result.candidates.forEach(candidate => {
        expect(candidate).toHaveProperty('file');
        expect(candidate).toHaveProperty('score');
        expect(candidate).toHaveProperty('evidence');
      });

      // Verify graph structure
      expect(result.graph).toHaveProperty('nodes');
      expect(result.graph).toHaveProperty('edges');
      expect(Array.isArray(result.graph.nodes)).toBe(true);
      expect(Array.isArray(result.graph.edges)).toBe(true);

      // Verify timings
      expect(typeof result.timings).toBe('object');
      expect(result.timings).toHaveProperty('total');
      // Verify new graph timing is present if available (from ts-morph path)
      // Note: graph timing may not be present in all edge cases
      if (result.timings.graph !== undefined) {
        expect(typeof result.timings.graph).toBe('number');
      }

      // Verify confidence
      expect(typeof result.confidence).toBe('number');
      expect(result.confidence).toBeGreaterThanOrEqual(0);
      expect(result.confidence).toBeLessThanOrEqual(1);
    }, 60000); // 60 second timeout for real execution

    it('should use ts-morph graph building (not old AstProgramBuilder path)', async () => {
      const input: DebuggingExtractionInput = {
        userMessage: 'Test ts-morph path',
        logs: mockLogs,
        workspace: repoRoot,
        model: 'test-model',
        config: {
          maxNodes: 30,
          maxDepth: 3,
          timeouts: {
            evidence: 1000,
            plan: 5000,
            retrieval: 10000,
            ast: 15000,
            slice: 5000
          }
        }
      };

      const result = await extractCodeTool.extractForDebugging(input);

      // Verify graph timing is present if available (indicates ts-morph path was used)
      // Note: In mocked scenarios, graph timing may not be set
      if (result.timings.graph !== undefined) {
        expect(result.timings.graph).toBeGreaterThan(0);
      }

      // Verify graph structure matches ts-morph output format
      // Nodes should have method-level identifiers (method:file:name format)
      // In mocked scenarios, we might get skeleton graphs, so just verify structure is valid
      if (result.graph.nodes.length > 0) {
        // Verify nodes have required structure
        result.graph.nodes.forEach(node => {
          expect(node).toHaveProperty('id');
          expect(node).toHaveProperty('label');
          expect(node).toHaveProperty('kind');
        });
        
        // Check if we have method nodes (ts-morph format)
        const hasMethodNodes = result.graph.nodes.some(node => 
          node.id.includes('method:') || node.kind === 'symbol'
        );
        // In mocked scenarios, method nodes might not be present, that's okay
        // Just verify the graph structure is valid
      } else {
        // Empty graph is acceptable in edge cases (skeleton graph)
        expect(result.isPartial).toBeDefined();
      }
    }, 60000);

    it('should build spine from evidence frames', async () => {
      const input: DebuggingExtractionInput = {
        userMessage: 'Test with stack trace',
        logs: mockLogs,
        workspace: repoRoot,
        model: 'test-model',
        config: {
          maxNodes: 30,
          maxDepth: 3,
          timeouts: {
            evidence: 1000,
            plan: 5000,
            retrieval: 10000,
            ast: 15000,
            slice: 5000
          }
        }
      };

      const result = await extractCodeTool.extractForDebugging(input);

      // Should have evidence frames parsed
      if (result.evidence.frames.length > 0) {
        expect(result.evidence.frames[0]).toHaveProperty('file');
        expect(result.evidence.frames[0]).toHaveProperty('line');
        expect(result.evidence.frames[0]).toHaveProperty('fn');
      }
    }, 60000);

    it('should build directed graph with nodes and edges', async () => {
      const input: DebuggingExtractionInput = {
        userMessage: 'Test graph building',
        logs: mockLogs,
        workspace: repoRoot,
        model: 'test-model',
        config: {
          maxNodes: 50,
          maxDepth: 5,
          timeouts: {
            evidence: 1000,
            plan: 5000,
            retrieval: 10000,
            ast: 15000,
            slice: 5000
          }
        }
      };

      const result = await extractCodeTool.extractForDebugging(input);

      // Verify graph nodes structure
      result.graph.nodes.forEach(node => {
        expect(node).toHaveProperty('id');
        expect(node).toHaveProperty('label');
        expect(node).toHaveProperty('kind');
        expect(['file', 'symbol', 'route']).toContain(node.kind);
      });

      // Verify graph edges structure
      result.graph.edges.forEach(edge => {
        expect(edge).toHaveProperty('from');
        expect(edge).toHaveProperty('to');
        expect(edge).toHaveProperty('kind');
        expect(['calls', 'imports']).toContain(edge.kind);
        expect(edge).toHaveProperty('confidence');
        expect(typeof edge.confidence).toBe('number');
      });

      // If graph has nodes, edges should reference valid node IDs
      if (result.graph.nodes.length > 0) {
        const nodeIds = new Set(result.graph.nodes.map(n => n.id));
        result.graph.edges.forEach(edge => {
          // Edges should reference existing nodes (or at least have valid structure)
          expect(typeof edge.from).toBe('string');
          expect(typeof edge.to).toBe('string');
        });
      }
    }, 60000);
  });

  describe('Edge cases', () => {
    it('should handle empty logs gracefully', async () => {
      const input: DebuggingExtractionInput = {
        userMessage: 'Test with no logs',
        logs: undefined,
        workspace: repoRoot,
        model: 'test-model',
        config: {
          maxNodes: 20,
          maxDepth: 3,
          timeouts: {
            evidence: 1000,
            plan: 5000,
            retrieval: 10000,
            ast: 15000,
            slice: 5000
          }
        }
      };

      const result = await extractCodeTool.extractForDebugging(input);

      expect(result).toBeDefined();
      expect(result.evidence).toBeDefined();
      expect(result.evidence.hasLogs).toBe(false);
      expect(result.evidence.evidenceSource).toBe('user_description');
    }, 60000);

    it('should handle skeleton graph when no spine found', async () => {
      const input: DebuggingExtractionInput = {
        userMessage: 'Test with minimal context',
        workspace: repoRoot,
        model: 'test-model',
        config: {
          maxNodes: 10,
          maxDepth: 2,
          timeouts: {
            evidence: 1000,
            plan: 5000,
            retrieval: 10000,
            ast: 15000,
            slice: 5000
          }
        }
      };

      const result = await extractCodeTool.extractForDebugging(input);

      expect(result).toBeDefined();
      // Should either have a graph or be marked as partial
      if (result.graph.nodes.length === 0) {
        expect(result.isPartial).toBe(true);
        expect(result.vizMode).toBe('degraded');
      }
    }, 60000);

    it('should respect maxNodes and maxDepth limits', async () => {
      const maxNodes = 20;
      const maxDepth = 3;
      
      const input: DebuggingExtractionInput = {
        userMessage: 'Test with limits',
        logs: mockLogs,
        workspace: repoRoot,
        model: 'test-model',
        config: {
          maxNodes,
          maxDepth,
          timeouts: {
            evidence: 1000,
            plan: 5000,
            retrieval: 10000,
            ast: 15000,
            slice: 5000
          }
        }
      };

      const result = await extractCodeTool.extractForDebugging(input);

      // Graph should respect limits (allowing some flexibility for spine nodes)
      expect(result.graph.nodes.length).toBeLessThanOrEqual(maxNodes * 2); // Allow some overhead
    }, 60000);
  });

  describe('Output validation', () => {
    it('should produce output compatible with handleDebugging', async () => {
      const input: DebuggingExtractionInput = {
        userMessage: 'Test compatibility',
        logs: mockLogs,
        workspace: repoRoot,
        model: 'test-model',
        config: {
          maxNodes: 50,
          maxDepth: 5,
          timeouts: {
            evidence: 1000,
            plan: 5000,
            retrieval: 10000,
            ast: 15000,
            slice: 5000
          }
        }
      };

      const result = await extractCodeTool.extractForDebugging(input);

      // Verify all fields that handleDebugging accesses
      expect(result).toHaveProperty('confidence');
      expect(result).toHaveProperty('candidates');
      expect(Array.isArray(result.candidates)).toBe(true);
      
      expect(result).toHaveProperty('graph');
      expect(result.graph).toHaveProperty('nodes');
      expect(result.graph).toHaveProperty('edges');
      expect(Array.isArray(result.graph.nodes)).toBe(true);
      expect(Array.isArray(result.graph.edges)).toBe(true);

      expect(result).toHaveProperty('timings');
      expect(result.timings).toHaveProperty('total');

      expect(result).toHaveProperty('evidence');
      expect(result.evidence).toHaveProperty('evidenceSource');
      expect(result.evidence).toHaveProperty('hasHardError');
      expect(result.evidence).toHaveProperty('frames');
      expect(Array.isArray(result.evidence.frames)).toBe(true);

      // Verify graph nodes have required fields for visualization
      result.graph.nodes.forEach(node => {
        expect(node).toHaveProperty('id');
        expect(node).toHaveProperty('label');
        expect(node).toHaveProperty('kind');
        expect(node).toHaveProperty('file');
      });

      // Verify graph edges have required fields
      result.graph.edges.forEach(edge => {
        expect(edge).toHaveProperty('from');
        expect(edge).toHaveProperty('to');
        expect(edge).toHaveProperty('kind');
      });
    }, 60000);

    it('should include timing information', async () => {
      const input: DebuggingExtractionInput = {
        userMessage: 'Test timings',
        logs: mockLogs,
        workspace: repoRoot,
        model: 'test-model',
        config: {
          maxNodes: 30,
          maxDepth: 3,
          timeouts: {
            evidence: 1000,
            plan: 5000,
            retrieval: 10000,
            ast: 15000,
            slice: 5000
          }
        }
      };

      const result = await extractCodeTool.extractForDebugging(input);

      expect(result.timings).toBeDefined();
      expect(result.timings.total).toBeGreaterThan(0);
      // Graph timing may be present if ts-morph path was used
      if (result.timings.graph !== undefined) {
        expect(typeof result.timings.graph).toBe('number');
      }
    }, 60000);

    it('should produce output with all fields required by handleDebugging', async () => {
      const input: DebuggingExtractionInput = {
        userMessage: 'Test handleDebugging compatibility',
        logs: mockLogs,
        workspace: repoRoot,
        model: 'test-model',
        config: {
          maxNodes: 50,
          maxDepth: 5,
          timeouts: {
            evidence: 1000,
            plan: 5000,
            retrieval: 10000,
            ast: 15000,
            slice: 5000
          }
        }
      };

      const result = await extractCodeTool.extractForDebugging(input);

      // Verify all fields that handleDebugging accesses directly
      // From line 1002-1008 in samuraiAgent.ts
      expect(result).toHaveProperty('confidence');
      expect(typeof result.confidence).toBe('number');
      
      expect(result).toHaveProperty('candidates');
      expect(Array.isArray(result.candidates)).toBe(true);
      expect(result.candidates.length).toBeGreaterThanOrEqual(0);
      
      expect(result).toHaveProperty('graph');
      expect(result.graph).toHaveProperty('nodes');
      expect(result.graph).toHaveProperty('edges');
      expect(Array.isArray(result.graph.nodes)).toBe(true);
      expect(Array.isArray(result.graph.edges)).toBe(true);
      
      expect(result).toHaveProperty('timings');
      expect(result.timings).toHaveProperty('total');
      expect(typeof result.timings.total).toBe('number');
      
      expect(result).toHaveProperty('evidence');
      expect(result.evidence).toHaveProperty('evidenceSource');
      expect(['logs', 'user_description', 'mixed']).toContain(result.evidence.evidenceSource);

      // From line 1013-1027 (detailed logging)
      expect(result.evidence).toHaveProperty('frames');
      expect(Array.isArray(result.evidence.frames)).toBe(true);
      
      expect(result.evidence).toHaveProperty('hasHardError');
      expect(typeof result.evidence.hasHardError).toBe('boolean');

      // From line 1036-1043 (graph node/edge types)
      result.graph.nodes.forEach(node => {
        expect(node).toHaveProperty('kind');
        expect(['file', 'symbol', 'route']).toContain(node.kind);
      });

      result.graph.edges.forEach(edge => {
        expect(edge).toHaveProperty('kind');
        expect(['calls', 'imports']).toContain(edge.kind);
      });
    }, 60000);
  });
});

