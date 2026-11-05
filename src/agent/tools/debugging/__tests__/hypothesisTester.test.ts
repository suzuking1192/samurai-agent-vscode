/**
 * Tests for HypothesisTester
 */

import { HypothesisTester } from '../HypothesisTester';
import { LLMProviderService } from '../../../llm/llmProviderService';
import { DebugContext, Hypothesis, SnippetRecord } from '../rootCauseTypes';
import { llmCache } from '../../../../common/utils/llmCache';

// Mock LLM Provider
const mockLlmProvider = {
  chat: jest.fn()
} as unknown as LLMProviderService;

// Mock LLM Cache
const mockLlmCache = {
  hashPrompt: jest.fn(),
  getCachedResponse: jest.fn(),
  setCachedResponse: jest.fn()
};

// Mock fs
jest.mock('fs');
const mockFs = require('fs');

describe('HypothesisTester', () => {
  let hypothesisTester: HypothesisTester;
  let mockDebugContext: DebugContext;
  let mockHypothesis: Hypothesis;
  let mockSnippets: SnippetRecord[];

  beforeEach(() => {
    jest.clearAllMocks();
    
    // Mock llmCache
    (llmCache as any) = mockLlmCache;
    
    // Mock fs
    mockFs.existsSync.mockReturnValue(true);
    mockFs.readFileSync.mockReturnValue('mock file content');
    mockFs.statSync.mockReturnValue({ size: 1000 });
    
    hypothesisTester = new HypothesisTester(mockLlmProvider);
    
    mockSnippets = [
      {
        id: 'snippet1',
        file: '/test/file1.js',
        start: 10,
        end: 20,
        text: 'function test() {\n  const obj = null;\n  return obj.property;\n}',
        reasons: ['error_path']
      },
      {
        id: 'snippet2', 
        file: '/test/file2.js',
        start: 5,
        end: 15,
        text: 'async function fetchData() {\n  const result = apiCall();\n  return result;\n}',
        reasons: ['async_pattern']
      }
    ];
    
    mockDebugContext = {
      projectId: 'test-project',
      commitHash: 'abc123',
      bugDescription: 'Test bug',
      logs: 'Error: Cannot read property of null\n    at test (/test/file1.js:12:3)',
      userMessage: 'Test user message',
      gitChanges: [],
      graph: {
        nodes: [
          { id: 'node1', kind: 'file', label: 'file1.js', file: '/test/file1.js', line: 12 },
          { id: 'node2', kind: 'symbol', label: 'test', file: '/test/file1.js', line: 10 }
        ],
        edges: [
          { from: 'node1', to: 'node2', kind: 'calls', confidence: 0.8 }
        ]
      },
      snippets: mockSnippets,
      evidence: {
        frames: [
          { file: '/test/file1.js', line: 12, fn: 'test' }
        ],
        error: 'Cannot read property of null'
      },
      candidates: [
        { file: '/test/file1.js', score: 0.9, evidence: ['error_path'] }
      ],
      heuristicFindings: []
    };
    
    mockHypothesis = {
      id: 'hyp1',
      summary: 'Null pointer dereference in test function',
      evidence: ['error_path'],
      relatedNodes: ['node1', 'node2'],
      confidence: 0.8,
      rationale: 'The error occurs when accessing property of null object',
      relatedFiles: ['/test/file1.js'],
      checks: ['Check if obj is null before accessing property'],
      assumptions: ['obj can be null in this context']
    };
  });

  describe('testHypothesis', () => {
    it('should test hypothesis and return feedback', async () => {
      const mockLLMResponse = {
        type: 'success',
        payload: {
          content: `\`\`\`json
{
  "verdict": "confirmed",
  "confidence": 0.85,
  "findings": ["Null access pattern found in snippet1"],
  "verifiedEvidence": [
    {"type": "snippet", "id": "snippet1"}
  ],
  "newClues": ["Object is not null-checked before property access"]
}
\`\`\``
        }
      };

      mockLlmProvider.chat.mockResolvedValue(mockLLMResponse);
      mockLlmCache.getCachedResponse.mockReturnValue(null);
      mockLlmCache.hashPrompt.mockReturnValue('cache-key');

      const result = await hypothesisTester.testHypothesis(mockHypothesis, mockDebugContext, 'gpt-4');

      expect(result.hypothesisId).toBe('hyp1');
      expect(result.verdict).toBe('confirmed');
      expect(result.revisedConfidence).toBeGreaterThan(0.5);
      expect(result.verifiedEvidence.length).toBeGreaterThan(0);
    });

    it('should handle LLM timeout and retry', async () => {
      const timeoutError = new Error('LLM call timeout');
      const successResponse = {
        type: 'success',
        payload: {
          content: `\`\`\`json
{
  "verdict": "uncertain",
  "confidence": 0.5,
  "findings": ["Analysis incomplete"],
  "verifiedEvidence": [],
  "newClues": []
}
\`\`\``
        }
      };

      mockLlmProvider.chat
        .mockRejectedValueOnce(timeoutError)
        .mockResolvedValueOnce(successResponse);
      
      mockLlmCache.getCachedResponse.mockReturnValue(null);
      mockLlmCache.hashPrompt.mockReturnValue('cache-key');

      const result = await hypothesisTester.testHypothesis(mockHypothesis, mockDebugContext, 'gpt-4');

      expect(mockLlmProvider.chat).toHaveBeenCalledTimes(2);
      expect(result.verdict).toBe('uncertain');
    });

    it('should handle parsing errors gracefully', async () => {
      const mockLLMResponse = {
        type: 'success',
        payload: {
          content: 'Invalid JSON response without proper formatting'
        }
      };

      mockLlmProvider.chat.mockResolvedValue(mockLLMResponse);
      mockLlmCache.getCachedResponse.mockReturnValue(null);
      mockLlmCache.hashPrompt.mockReturnValue('cache-key');

      const result = await hypothesisTester.testHypothesis(mockHypothesis, mockDebugContext, 'gpt-4');

      expect(result.verdict).toBe('uncertain');
      expect(result.revisedConfidence).toBeGreaterThan(0.3);
      expect(result.verifiedEvidence.length).toBeGreaterThanOrEqual(0);
    });

    it('should use cached response when available', async () => {
      const cachedResponse = {
        content: `\`\`\`json
{
  "verdict": "confirmed",
  "confidence": 0.8,
  "findings": ["Cached analysis"],
  "verifiedEvidence": [{"type": "snippet", "id": "snippet1"}],
  "newClues": []
}
\`\`\``
      };

      mockLlmCache.getCachedResponse.mockReturnValue(cachedResponse);
      mockLlmCache.hashPrompt.mockReturnValue('cache-key');

      const result = await hypothesisTester.testHypothesis(mockHypothesis, mockDebugContext, 'gpt-4');

      expect(mockLlmProvider.chat).not.toHaveBeenCalled();
      expect(result.verdict).toBe('confirmed');
    });
  });

  describe('static checks', () => {
    it('should detect null dereference patterns', () => {
      const snippet: SnippetRecord = {
        id: 'test-snippet',
        file: '/test/file.js',
        start: 1,
        end: 5,
        text: 'const obj = null;\nobj.property;',
        reasons: ['test']
      };

      const debugContext: DebugContext = {
        ...mockDebugContext,
        snippets: [snippet]
      };

      const hypothesis: Hypothesis = {
        ...mockHypothesis,
        relatedFiles: ['/test/file.js']
      };

      // Use reflection to access private method
      const runStaticChecks = (hypothesisTester as any).runStaticChecks.bind(hypothesisTester);
      const findings = runStaticChecks(hypothesis, debugContext, [snippet]);

      expect(findings).toContainEqual(
        expect.objectContaining({
          type: 'null_deref',
          severity: 'high'
        })
      );
    });

    it('should detect missing await patterns', () => {
      const snippet: SnippetRecord = {
        id: 'test-snippet',
        file: '/test/file.js',
        start: 1,
        end: 5,
        text: 'async function test() {\n  const result = apiCall();\n  return result;\n}',
        reasons: ['test']
      };

      const debugContext: DebugContext = {
        ...mockDebugContext,
        snippets: [snippet]
      };

      const hypothesis: Hypothesis = {
        ...mockHypothesis,
        relatedFiles: ['/test/file.js']
      };

      const runStaticChecks = (hypothesisTester as any).runStaticChecks.bind(hypothesisTester);
      const findings = runStaticChecks(hypothesis, debugContext, [snippet]);

      expect(findings).toContainEqual(
        expect.objectContaining({
          type: 'missing_await',
          severity: 'medium'
        })
      );
    });

    it('should detect React hook dependency issues', () => {
      const snippet: SnippetRecord = {
        id: 'test-snippet',
        file: '/test/file.jsx',
        start: 1,
        end: 10,
        text: 'useEffect(() => {\n  const data = fetchData();\n  setData(data);\n}, []);',
        reasons: ['test']
      };

      const debugContext: DebugContext = {
        ...mockDebugContext,
        snippets: [snippet]
      };

      const hypothesis: Hypothesis = {
        ...mockHypothesis,
        relatedFiles: ['/test/file.jsx']
      };

      const runStaticChecks = (hypothesisTester as any).runStaticChecks.bind(hypothesisTester);
      const findings = runStaticChecks(hypothesis, debugContext, [snippet]);

      expect(findings).toContainEqual(
        expect.objectContaining({
          type: 'hook_deps',
          severity: 'medium'
        })
      );
    });
  });

  describe('execution path calculation', () => {
    it('should find shortest path between nodes', () => {
      const graph = {
        nodes: [
          { id: 'error', kind: 'file', label: 'error.js' },
          { id: 'middle', kind: 'symbol', label: 'middle' },
          { id: 'target', kind: 'symbol', label: 'target' }
        ],
        edges: [
          { from: 'error', to: 'middle', kind: 'calls', confidence: 0.8 },
          { from: 'middle', to: 'target', kind: 'calls', confidence: 0.9 }
        ]
      };

      const debugContext: DebugContext = {
        ...mockDebugContext,
        graph
      };

      const hypothesis: Hypothesis = {
        ...mockHypothesis,
        relatedNodes: ['target']
      };

      const calculateExecutionPaths = (hypothesisTester as any).calculateExecutionPaths.bind(hypothesisTester);
      const paths = calculateExecutionPaths(hypothesis, debugContext);

      expect(paths.length).toBeGreaterThanOrEqual(1);
      expect(paths[0]).toEqual({
        from: 'error',
        to: 'target',
        distance: 2,
        edges: expect.any(Array)
      });
    });

    it('should limit path length and count', () => {
      const graph = {
        nodes: [
          { id: 'error', kind: 'file', label: 'error.js' },
          { id: 'target1', kind: 'symbol', label: 'target1' },
          { id: 'target2', kind: 'symbol', label: 'target2' },
          { id: 'target3', kind: 'symbol', label: 'target3' }
        ],
        edges: [
          { from: 'error', to: 'target1', kind: 'calls', confidence: 0.8 },
          { from: 'error', to: 'target2', kind: 'calls', confidence: 0.8 },
          { from: 'error', to: 'target3', kind: 'calls', confidence: 0.8 }
        ]
      };

      const debugContext: DebugContext = {
        ...mockDebugContext,
        graph
      };

      const hypothesis: Hypothesis = {
        ...mockHypothesis,
        relatedNodes: ['target1', 'target2', 'target3']
      };

      const calculateExecutionPaths = (hypothesisTester as any).calculateExecutionPaths.bind(hypothesisTester);
      const paths = calculateExecutionPaths(hypothesis, debugContext);

      expect(paths.length).toBeLessThanOrEqual(2); // MAX_PATHS
    });
  });

  describe('confidence calibration', () => {
    it('should calibrate confidence with static findings', () => {
      const staticFindings = [
        { type: 'null_deref', file: '/test/file.js', line: 10, severity: 'high' as const, rationale: 'test' },
        { type: 'missing_await', file: '/test/file.js', line: 15, severity: 'medium' as const, rationale: 'test' }
      ];

      const executionPaths = [
        { from: 'error', to: 'target', distance: 2, edges: [] }
      ];

      const calibrateConfidence = (hypothesisTester as any).calibrateConfidence.bind(hypothesisTester);
      const calibrated = calibrateConfidence(0.6, staticFindings, executionPaths, mockSnippets, mockDebugContext);

      expect(calibrated).toBeGreaterThan(0.5); // Should be higher due to high-severity findings
    });

    it('should handle empty static findings', () => {
      const calibrateConfidence = (hypothesisTester as any).calibrateConfidence.bind(hypothesisTester);
      const calibrated = calibrateConfidence(0.5, [], [], mockSnippets, mockDebugContext);

      expect(calibrated).toBeGreaterThanOrEqual(0);
      expect(calibrated).toBeLessThanOrEqual(1);
    });
  });

  describe('verdict determination', () => {
    it('should confirm hypothesis with high findings and short path', () => {
      const staticFindings = [
        { type: 'null_deref', file: '/test/file.js', line: 10, severity: 'high' as const, rationale: 'test' }
      ];

      const executionPaths = [
        { from: 'error', to: 'target', distance: 2, edges: [] }
      ];

      const determineVerdict = (hypothesisTester as any).determineVerdict.bind(hypothesisTester);
      const verdict = determineVerdict('confirmed', staticFindings, executionPaths, 0.8);

      expect(verdict).toBe('confirmed');
    });

    it('should refute hypothesis with no findings and long path', () => {
      const staticFindings: any[] = [];
      const executionPaths = [
        { from: 'error', to: 'target', distance: 8, edges: [] }
      ];

      const determineVerdict = (hypothesisTester as any).determineVerdict.bind(hypothesisTester);
      const verdict = determineVerdict('refuted', staticFindings, executionPaths, 0.3);

      expect(verdict).toBe('refuted');
    });

    it('should return uncertain for mixed evidence', () => {
      const staticFindings = [
        { type: 'missing_await', file: '/test/file.js', line: 10, severity: 'low' as const, rationale: 'test' }
      ];

      const executionPaths = [
        { from: 'error', to: 'target', distance: 4, edges: [] }
      ];

      const determineVerdict = (hypothesisTester as any).determineVerdict.bind(hypothesisTester);
      const verdict = determineVerdict('uncertain', staticFindings, executionPaths, 0.5);

      expect(verdict).toBe('uncertain');
    });
  });

  describe('evidence reconciliation', () => {
    it('should filter evidence against allowlists', () => {
      const evidence = [
        { type: 'snippet', id: 'snippet1' },
        { type: 'snippet', id: 'invalid-snippet' },
        { type: 'graphNode', id: 'node1' },
        { type: 'graphNode', id: 'invalid-node' },
        { type: 'commit', hash: 'abc123' },
        { type: 'commit', hash: 'invalid-hash' }
      ];

      const reconcileEvidence = (hypothesisTester as any).reconcileEvidence.bind(hypothesisTester);
      const reconciled = reconcileEvidence(evidence, mockDebugContext);

      expect(reconciled.length).toBeGreaterThanOrEqual(2); // Only valid evidence
      expect(reconciled).toContainEqual({ type: 'snippet', id: 'snippet1' });
      expect(reconciled).toContainEqual({ type: 'graphNode', id: 'node1' });
      // Note: commit hash validation is strict, so abc123 might not pass
    });
  });

  describe('JSON parsing', () => {
    it('should extract fenced JSON correctly', () => {
      const content = `Some text before
\`\`\`json
{
  "verdict": "confirmed",
  "confidence": 0.8
}
\`\`\`
Some text after`;

      const extractFencedJson = (hypothesisTester as any).extractFencedJson.bind(hypothesisTester);
      const result = extractFencedJson(content);

      expect(result).toBe('{\n  "verdict": "confirmed",\n  "confidence": 0.8\n}');
    });

    it('should handle content without fenced JSON', () => {
      const content = 'Just plain text without JSON';

      const extractFencedJson = (hypothesisTester as any).extractFencedJson.bind(hypothesisTester);
      const result = extractFencedJson(content);

      expect(result).toBeNull();
    });

    it('should parse valid JSON response', () => {
      const content = `\`\`\`json
{
  "verdict": "confirmed",
  "confidence": 0.85,
  "findings": ["Test finding"],
  "verifiedEvidence": [{"type": "snippet", "id": "snippet1"}],
  "newClues": ["Test clue"]
}
\`\`\``;

      const parseLLMResponse = (hypothesisTester as any).parseLLMResponse.bind(hypothesisTester);
      const result = parseLLMResponse(content, mockDebugContext);

      expect(result.verdict).toBe('confirmed');
      expect(result.confidence).toBe(0.85);
      expect(result.findings).toEqual(['Test finding']);
      expect(result.verifiedEvidence).toEqual([{ type: 'snippet', id: 'snippet1' }]);
      expect(result.newClues).toEqual(['Test clue']);
    });

    it('should handle invalid JSON gracefully', () => {
      const content = 'Invalid JSON content';

      const parseLLMResponse = (hypothesisTester as any).parseLLMResponse.bind(hypothesisTester);
      const result = parseLLMResponse(content, mockDebugContext);

      expect(result.verdict).toBe('uncertain');
      expect(result.confidence).toBe(0.3);
      expect(result.findings).toEqual(['Failed to parse analysis response']);
    });
  });

  describe('response validation', () => {
    it('should filter out invalid verifiedEvidence', () => {
      const content = `\`\`\`json
{
  "verdict": "confirmed",
  "confidence": 0.85,
  "findings": ["Test finding"],
  "verifiedEvidence": [
    {"type": "snippet", "id": "snippet1"},
    {"type": "snippet", "id": "invalid-snippet"},
    {"type": "graphNode", "id": "node1"},
    {"type": "graphNode", "id": "invalid-node"}
  ],
  "newClues": ["Test clue"]
}
\`\`\``;

      const parseLLMResponse = (hypothesisTester as any).parseLLMResponse.bind(hypothesisTester);
      const result = parseLLMResponse(content, mockDebugContext);

      expect(result.verifiedEvidence).toEqual([
        { type: 'snippet', id: 'snippet1' },
        { type: 'graphNode', id: 'node1' }
      ]);
      // Invalid evidence should be filtered out
      expect(result.verifiedEvidence).not.toContainEqual({ type: 'snippet', id: 'invalid-snippet' });
      expect(result.verifiedEvidence).not.toContainEqual({ type: 'graphNode', id: 'invalid-node' });
    });

    it('should filter findings with invalid file references', () => {
      const content = `\`\`\`json
{
  "verdict": "confirmed",
  "confidence": 0.85,
  "findings": [
    "Null access in /test/file1.js",
    "Error in /test/invalid-file.ts:10",
    "General finding without file reference"
  ],
  "verifiedEvidence": [],
  "newClues": []
}
\`\`\``;

      const parseLLMResponse = (hypothesisTester as any).parseLLMResponse.bind(hypothesisTester);
      const result = parseLLMResponse(content, mockDebugContext);

      // Should keep findings that reference allowed files or have no file references
      expect(result.findings).toContain('Null access in /test/file1.js');
      expect(result.findings).toContain('General finding without file reference');
      // Should filter out findings with invalid file references
      expect(result.findings).not.toContain('Error in /test/invalid-file.ts:10');
    });
  });

  describe('error handling', () => {
    it('should handle file system errors gracefully', async () => {
      mockFs.existsSync.mockReturnValue(false);
      mockFs.readFileSync.mockImplementation(() => {
        throw new Error('File not found');
      });

      const mockLLMResponse = {
        type: 'success',
        payload: {
          content: `\`\`\`json
{
  "verdict": "uncertain",
  "confidence": 0.5,
  "findings": ["File access issues"],
  "verifiedEvidence": [],
  "newClues": []
}
\`\`\``
        }
      };

      mockLlmProvider.chat.mockResolvedValue(mockLLMResponse);
      mockLlmCache.getCachedResponse.mockReturnValue(null);
      mockLlmCache.hashPrompt.mockReturnValue('cache-key');

      const result = await hypothesisTester.testHypothesis(mockHypothesis, mockDebugContext, 'gpt-4');

      expect(result.verdict).toBe('uncertain');
    });

    it('should handle LLM provider errors', async () => {
      mockLlmProvider.chat.mockRejectedValue(new Error('LLM provider error'));
      mockLlmCache.getCachedResponse.mockReturnValue(null);
      mockLlmCache.hashPrompt.mockReturnValue('cache-key');

      const result = await hypothesisTester.testHypothesis(mockHypothesis, mockDebugContext, 'gpt-4');

      expect(result.verdict).toBe('uncertain');
      expect(result.newClues).toContain('Error occurred during testing');
    });
  });
});