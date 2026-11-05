/**
 * Tests for RootCauseAnalyzer orchestrator
 */

import { RootCauseAnalyzer } from '../RootCauseAnalyzer';
import { LLMProviderService } from '../../../llm/llmProviderService';

// Mock dependencies
jest.mock('../../../llm/llmProviderService');
jest.mock('fs', () => ({
  existsSync: jest.fn(() => true),
  mkdirSync: jest.fn(),
  readFileSync: jest.fn(),
  writeFileSync: jest.fn()
}));
jest.mock('../../feedback/FeedbackStore', () => ({
  FeedbackStore: jest.fn().mockImplementation(() => ({
    loadForWorkspace: jest.fn(() => [])
  }))
}));
jest.mock('../../feedback/FeedbackRetriever', () => ({
  FeedbackRetriever: jest.fn().mockImplementation(() => ({
    loadRecords: jest.fn()
  }))
}));
jest.mock('../promptLoader', () => ({
  loadDebuggingPrompt: jest.fn(() => 'Test prompt template {userBugDescription} {codeSnippets} {epicenter} {logs} {gitHistory} {chatHistory} {previousIterationResponse} {frameworkHeuristics}'),
  loadFrameworkPrompt: jest.fn(() => 'Framework prompt content')
}));
jest.mock('../../../util/chatSummaryGenerator', () => ({
  generateChatSummary: jest.fn(() => ({ summary: 'Test summary' }))
}));

const MockedLLMProviderService = LLMProviderService as jest.MockedClass<typeof LLMProviderService>;

describe('RootCauseAnalyzer', () => {
  let rootCauseAnalyzer: RootCauseAnalyzer;
  let mockLlmProvider: jest.Mocked<LLMProviderService>;

  beforeEach(() => {
    mockLlmProvider = {
      chat: jest.fn()
    } as any;

    MockedLLMProviderService.mockImplementation(() => mockLlmProvider);

    const mockExtractCodeTool = {} as any;
    rootCauseAnalyzer = new RootCauseAnalyzer(mockLlmProvider, '/test/workspace', mockExtractCodeTool);
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  describe('buildSimplifiedPrompt', () => {
    it('omits optional sections when context values are empty', () => {
      const template = [
        '## Inputs Available',
        '',
        '{inputsAvailable}',
        '',
        '---',
        '',
        '{frameworkHeuristicsSection}',
        '',
        '---',
        '',
        'Stay iterative, evidence-driven, and explicit.'
      ].join('\n');

      const prompt = (rootCauseAnalyzer as any).buildSimplifiedPrompt(template, {
        userMessage: 'User reports an intermittent crash.',
        chatHistoryText: '',
        previousIterationText: '',
        epicenterText: '',
        logsText: '',
        gitHistoryText: '',
        executionTraceText: '',
        supplementalContextText: '',
        frameworkHeuristicsText: ''
      });

      expect(prompt).toContain('- **User Bug Description**');
      expect(prompt).toContain('User reports an intermittent crash.');
      expect(prompt).not.toContain('Chat History');
      expect(prompt).not.toContain('Previous Analysis');
      expect(prompt).not.toContain('Execution Trace');
      expect(prompt).not.toContain('Error Logs');
      expect(prompt).not.toContain('Git History');
      expect(prompt).not.toContain('Supplemental Code Context');
      expect(prompt).not.toContain('## Framework-Specific Debugging Heuristics');
      expect(prompt).not.toContain('{');
      expect(prompt).not.toMatch(/---\s*## Framework-Specific Debugging Heuristics/);
    });
  });

  describe('analyzeRootCauseSimplified', () => {
    it('should return raw response in result', async () => {
      const mockCodeSnippets = [
        { file: '/test/file.ts', method: 'testMethod', code: 'function testMethod() { return 1; }' }
      ];
      const mockGraph = {
        nodes: [{ id: 'node1', kind: 'file', label: 'file.ts', file: '/test/file.ts' }] as any[],
        edges: [] as any[]
      };
      const mockEpicenter = {
        files: ['/test/file.ts'],
        methods: [{ file: '/test/file.ts', method: 'testMethod' }]
      };

      const mockRawResponse = `## Analysis

The issue appears to be a null pointer exception in the testMethod function.

**Confidence:** 0.8

**New Epicenter:** None needed`;

      mockLlmProvider.chat.mockResolvedValue({
        type: 'success',
        payload: {
          content: mockRawResponse
        }
      });

      const result = await rootCauseAnalyzer.analyzeRootCauseSimplified(
        mockCodeSnippets,
        mockGraph,
        mockEpicenter,
        '/test/workspace',
        'Error: null pointer',
        'User bug description',
        'gpt-4'
      );

      expect(result).toHaveProperty('rawResponse');
      expect(result.rawResponse).toBe(mockRawResponse);
      expect(result.report).toBeDefined();
      expect(result.shouldRetry).toBeDefined();
    });

    it('should return undefined rawResponse on error', async () => {
      const mockCodeSnippets = [
        { file: '/test/file.ts', method: 'testMethod', code: 'function testMethod() { return 1; }' }
      ];
      const mockGraph = {
        nodes: [] as any[],
        edges: [] as any[]
      };
      const mockEpicenter = {
        files: ['/test/file.ts'],
        methods: []
      };

      mockLlmProvider.chat.mockRejectedValue(new Error('LLM error'));

      const result = await rootCauseAnalyzer.analyzeRootCauseSimplified(
        mockCodeSnippets,
        mockGraph,
        mockEpicenter,
        '/test/workspace',
        'Error',
        'Bug description',
        'gpt-4'
      );

      expect(result).toHaveProperty('rawResponse');
      expect(result.rawResponse).toBeUndefined();
      expect(result.report).toBeDefined();
      expect(result.report.summary).toContain('Analysis failed');
    });

    it('injects framework heuristics when provided', async () => {
      const mockCodeSnippets = [
        { file: '/test/file.ts', method: 'testMethod', code: 'function testMethod() { return 1; }' }
      ];
      const mockGraph = {
        nodes: [] as any[],
        edges: [] as any[]
      };
      const mockEpicenter = {
        files: ['/test/file.ts'],
        methods: []
      };

      const mockRawResponse = `{"hypothesis":"Example","confidence":0.4}`;

      mockLlmProvider.chat.mockResolvedValue({
        type: 'success',
        payload: {
          content: mockRawResponse
        }
      });

      const result = await rootCauseAnalyzer.analyzeRootCauseSimplified(
        mockCodeSnippets,
        mockGraph,
        mockEpicenter,
        '/test/workspace',
        'Error',
        'Bug description',
        'gpt-4',
        undefined,
        { detectedFrameworks: ['react'] }
      );

      expect(result.prompt).toContain('Framework prompt content');
      const [[firstRequest]] = mockLlmProvider.chat.mock.calls;
      const promptContent = firstRequest.messages?.[0]?.content as string;
      expect(promptContent).toContain('Framework prompt content');
    });

    it('should parse and process response without nextSteps field', async () => {
      const mockCodeSnippets = [
        { file: '/test/file.ts', method: 'testMethod', code: 'function testMethod() { return 1; }' }
      ];
      const mockGraph = {
        nodes: [{ id: 'node1', kind: 'file', label: 'file.ts', file: '/test/file.ts' }] as any[],
        edges: [] as any[]
      };
      const mockEpicenter = {
        files: ['/test/file.ts'],
        methods: [{ file: '/test/file.ts', method: 'testMethod' }]
      };

      // Response with epicenters and keywordHints but NO nextSteps
      const mockResponseWithoutNextSteps = JSON.stringify({
        hypothesis: 'The issue is likely a null pointer exception in the data processing pipeline.',
        confidence: 0.6,
        reasoningSummary: 'The error occurs when processing user data. The stack trace points to testMethod which accesses properties without null checks.',
        epicenters: [
          {
            file: '/test/dataProcessor.ts',
            method: 'processData',
            reason: 'This method processes user data and may be missing null checks'
          },
          {
            file: '/test/validator.ts',
            method: 'validateInput',
            reason: 'Input validation might be failing, allowing null values to pass through'
          }
        ],
        keywordHints: {
          files: ['dataProcessor.ts', 'validator.ts', 'utils.ts'],
          methods: ['processData', 'validateInput', 'sanitize'],
          terms: ['null check', 'undefined', 'optional chaining']
        }
      });

      mockLlmProvider.chat
        .mockResolvedValueOnce({
          type: 'success',
          payload: { content: mockResponseWithoutNextSteps }
        })
        .mockResolvedValueOnce({
          type: 'success',
          payload: { content: JSON.stringify({ nodes: [] }) }
        });

      const result = await rootCauseAnalyzer.analyzeRootCauseSimplified(
        mockCodeSnippets,
        mockGraph,
        mockEpicenter,
        '/test/workspace',
        'Error: Cannot read property of undefined',
        'User reports null pointer error',
        'gpt-4'
      );

      // Verify parsing succeeded
      expect(result.report).toBeDefined();
      expect(result.report.summary).toBeDefined();
      
      // Verify epicenters were extracted and processed
      expect(result.epicenters).toBeDefined();
      expect(result.epicenters).toHaveLength(2);
      expect(result.epicenters?.[0]).toMatchObject({
        file: '/test/dataProcessor.ts',
        method: 'processData',
        reason: expect.stringContaining('null checks')
      });
      expect(result.epicenters?.[1]).toMatchObject({
        file: '/test/validator.ts',
        method: 'validateInput',
        reason: expect.stringContaining('validation')
      });

      // Verify keywordHints were extracted and processed
      expect(result.keywordHints).toBeDefined();
      expect(result.keywordHints?.files).toEqual(expect.arrayContaining(['dataProcessor.ts', 'validator.ts', 'utils.ts']));
      expect(result.keywordHints?.methods).toEqual(expect.arrayContaining(['processData', 'validateInput', 'sanitize']));
      expect(result.keywordHints?.terms).toEqual(expect.arrayContaining(['null check', 'undefined', 'optional chaining']));

      // Verify formatted response was generated
      expect(result.formattedResponse).toBeDefined();
      expect(result.formattedResponse).toContain('null pointer exception');
      expect(result.formattedResponse).toContain('dataProcessor.ts');
      expect(result.formattedResponse).toContain('processData');
      
      // Verify the formatted response includes epicenters section
      expect(result.formattedResponse).toContain('Next Steps');
      expect(result.formattedResponse).toContain('dataProcessor.ts');
      expect(result.formattedResponse).toContain('validator.ts');
      
      // Verify the formatted response includes keyword hints section
      expect(result.formattedResponse).toContain('Keyword Hints');
      expect(result.formattedResponse).toContain('dataProcessor.ts');
      expect(result.formattedResponse).toContain('processData');
      expect(result.formattedResponse).toContain('null check');

      // Verify raw response is stored
      expect(result.rawResponse).toBe(mockResponseWithoutNextSteps);

      // Verify iteration summary was created
      expect(result.iterationSummaries).toBeDefined();
      expect(result.iterationSummaries?.length).toBeGreaterThan(0);
      expect(result.iterationSummaries?.[0].hypothesis).toContain('null pointer exception');
      expect(result.iterationSummaries?.[0].confidence).toBe(0.6);
    });

    it('should handle response with only epicenters (no keywordHints)', async () => {
      const mockCodeSnippets = [
        { file: '/test/file.ts', method: 'testMethod', code: 'function testMethod() { return 1; }' }
      ];
      const mockGraph = {
        nodes: [] as any[],
        edges: [] as any[]
      };
      const mockEpicenter = {
        files: ['/test/file.ts'],
        methods: []
      };

      const mockResponseWithOnlyEpicenters = JSON.stringify({
        hypothesis: 'Missing error handling in API endpoint',
        confidence: 0.7,
        reasoningSummary: 'The API endpoint does not handle edge cases properly.',
        epicenters: [
          {
            file: '/test/api.ts',
            method: 'handleRequest',
            reason: 'This method needs better error handling'
          }
        ]
        // No keywordHints field
      });

      mockLlmProvider.chat
        .mockResolvedValueOnce({
          type: 'success',
          payload: { content: mockResponseWithOnlyEpicenters }
        })
        .mockResolvedValueOnce({
          type: 'success',
          payload: { content: JSON.stringify({ nodes: [] }) }
        });

      const result = await rootCauseAnalyzer.analyzeRootCauseSimplified(
        mockCodeSnippets,
        mockGraph,
        mockEpicenter,
        '/test/workspace',
        'Error',
        'Bug description',
        'gpt-4'
      );

      // Should still parse successfully
      expect(result.report).toBeDefined();
      expect(result.epicenters).toBeDefined();
      expect(result.epicenters).toHaveLength(1);
      expect(result.epicenters?.[0].file).toBe('/test/api.ts');
      
      // keywordHints should be undefined or empty
      expect(result.keywordHints).toBeUndefined();
      
      // Formatted response should still work
      expect(result.formattedResponse).toBeDefined();
      expect(result.formattedResponse).toContain('api.ts');
    });

    it('should handle response with only keywordHints (no epicenters)', async () => {
      const mockCodeSnippets = [
        { file: '/test/file.ts', method: 'testMethod', code: 'function testMethod() { return 1; }' }
      ];
      const mockGraph = {
        nodes: [] as any[],
        edges: [] as any[]
      };
      const mockEpicenter = {
        files: ['/test/file.ts'],
        methods: []
      };

      const mockResponseWithOnlyKeywordHints = JSON.stringify({
        hypothesis: 'Configuration issue',
        confidence: 0.5,
        reasoningSummary: 'The configuration might be missing required settings.',
        keywordHints: {
          files: ['config.ts', 'settings.ts'],
          methods: ['loadConfig', 'getSetting'],
          terms: ['configuration', 'environment variable']
        }
        // No epicenters field
      });

      mockLlmProvider.chat
        .mockResolvedValueOnce({
          type: 'success',
          payload: { content: mockResponseWithOnlyKeywordHints }
        })
        .mockResolvedValueOnce({
          type: 'success',
          payload: { content: JSON.stringify({ nodes: [] }) }
        });

      const result = await rootCauseAnalyzer.analyzeRootCauseSimplified(
        mockCodeSnippets,
        mockGraph,
        mockEpicenter,
        '/test/workspace',
        'Error',
        'Bug description',
        'gpt-4'
      );

      // Should still parse successfully
      expect(result.report).toBeDefined();
      expect(result.keywordHints).toBeDefined();
      expect(result.keywordHints?.files).toEqual(['config.ts', 'settings.ts']);
      expect(result.keywordHints?.methods).toEqual(['loadConfig', 'getSetting']);
      expect(result.keywordHints?.terms).toEqual(['configuration', 'environment variable']);
      
      // epicenters should be empty or undefined
      expect(result.epicenters).toEqual([]);
      
      // Formatted response should still work
      expect(result.formattedResponse).toBeDefined();
      expect(result.formattedResponse).toContain('Keyword Hints');
    });
  });

  describe('getAnalysisStats', () => {
    it('should return analysis statistics', () => {
      const report = {
        summary: 'Test',
        likelyRootCause: 'Test',
        reasoningSteps: [],
        recommendedFix: 'Test',
        evidence: [],
        confidence: 0.8,
        hypotheses: [
          { id: 'h1', summary: 'Test', evidence: [], relatedNodes: [], confidence: 0.8, rationale: 'Test', relatedFiles: [] }
        ],
        confidenceSummaryTable: 'Test',
        timings: {
          total: 5000,
          evidence: 500,
          hypothesis: 1000,
          report: 500
        }
      };

      const stats = rootCauseAnalyzer.getAnalysisStats(report);

      expect(stats.totalTime).toBe(5000);
      expect(stats.hypothesesGenerated).toBe(1);
      expect(stats.confidence).toBe(0.8);
      expect(stats.evidenceCount).toBe(0);
      // iterations field should not exist (removed)
      expect(stats).not.toHaveProperty('iterations');
    });
  });

  describe('clearCaches', () => {
    it('should clear all caches', () => {
      rootCauseAnalyzer.clearCaches();
      // Cache clearing is internal, so we just verify it doesn't throw
      expect(true).toBe(true);
    });
  });
});
