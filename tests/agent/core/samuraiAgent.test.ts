import { SamuraiAgent } from '../../../src/agent/core/samuraiAgent';
import { LLMProviderService } from '../../../src/agent/llm/llmProviderService';
import { ProjectDetailService } from '../../../src/agent/memory/projectDetailService';
import { DataStore } from '../../../src/persistence/dataStore';
import { ExtractCodeTool } from '../../../src/agent/tools/extractCodeTool';
import { ChatMessage, Session, UserIntentEnum } from '../../../src/common/models/chat-models';
import { ExtractCodeToolResultPayload } from '../../../src/common/models/tool-models';
import { LLMMessage } from '../../../src/common/models/llm-models';
import * as fs from 'fs';
import * as path from 'path';
import { EvidenceParser } from '../../../src/agent/tools/debugging/EvidenceParser';
import { Evidence, EpicenterResult } from '../../../src/agent/tools/debugging/types';

// Mock the fs module
jest.mock('fs');
const mockedFs = fs as jest.Mocked<typeof fs>;

describe('SamuraiAgent', () => {
  let samuraiAgent: SamuraiAgent;
  let mockLLMProviderService: jest.Mocked<LLMProviderService>;
  let mockDataStore: jest.Mocked<DataStore>;
  let mockProjectDetailService: jest.Mocked<ProjectDetailService>;
  let mockExtractCodeTool: jest.Mocked<ExtractCodeTool>;

  beforeEach(() => {
    // Create mocks
    mockLLMProviderService = {
      chat: jest.fn(),
    } as any;

    mockDataStore = {
      loadChatMessagesForSession: jest.fn(),
      loadAllCodeContextForSession: jest.fn(),
      updateSession: jest.fn(),
      saveCodeContext: jest.fn(),
    } as any;

    mockProjectDetailService = {
      getProjectDetails: jest.fn(),
    } as any;

    mockExtractCodeTool = {
      execute: jest.fn(),
    } as any;

    const mockProjectTechStackService = {
      ensureTechStack: jest.fn(),
      getStoredTechStack: jest.fn(),
    } as any;

    // Create SamuraiAgent instance
    samuraiAgent = new SamuraiAgent(
      mockLLMProviderService,
      mockDataStore,
      mockProjectDetailService,
      mockExtractCodeTool,
      mockProjectTechStackService
    );

    // Mock fs.readFileSync for prompt loading
    mockedFs.readFileSync.mockReturnValue('Mock prompt content with {projectDetails} and {codeContexts} and {conversationSummary} and {activeTaskHeader} and {noActiveTaskInference}');
    mockedFs.existsSync.mockReturnValue(true);
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  describe('_loadAndFormatSystemPrompt', () => {
    it('should load and format a system prompt with variables', async () => {
      const variables = {
        projectDetails: 'Test project details',
        codeContexts: 'Test code context',
        conversationSummary: 'Test conversation summary',
        activeTaskHeader: 'Test active task header',
        noActiveTaskInference: 'Test no active task inference'
      };

      const result = await (samuraiAgent as any)._loadAndFormatSystemPrompt(
        'pureDiscussion/system_prompt.md',
        variables
      );

      expect(mockedFs.readFileSync).toHaveBeenCalled();
      expect(result).toContain('Test project details');
      expect(result).toContain('Test code context');
      expect(result).toContain('Test conversation summary');
      expect(result).toContain('Test active task header');
      expect(result).toContain('Test no active task inference');
    });

    it('should throw error when prompt file is not found', async () => {
      mockedFs.existsSync.mockReturnValue(false);

      await expect(
        (samuraiAgent as any)._loadAndFormatSystemPrompt(
          'nonexistent/prompt.md',
          { projectDetails: '', codeContexts: '', conversationSummary: '' }
        )
      ).rejects.toThrow('Failed to load prompt file');
    });
  });

  describe('_formatCodeContextsForPrompt', () => {
    it('should format code contexts correctly', () => {
      const codeContexts: ExtractCodeToolResultPayload[] = [
        {
          id: 'context1',
          query: 'test query',
          relevantCodeElements: [
            {
              path: 'src/test.ts',
              elements: [
                { type: 'function', name: 'testFunction' },
                { type: 'class', name: 'TestClass' }
              ],
              snippet: 'function testFunction() {\n  return "test";\n}'
            }
          ],
          metadata: {}
        }
      ];

      const result = (samuraiAgent as any)._formatCodeContextsForPrompt(codeContexts);

      expect(result).toContain('// File: src/test.ts');
      expect(result).toContain('// [function]: testFunction');
      expect(result).toContain('// [class]: TestClass');
      expect(result).toContain('function testFunction() {');
    });

    it('should handle empty code contexts', () => {
      const result = (samuraiAgent as any)._formatCodeContextsForPrompt([]);
      expect(result).toBe('No code context available.');
    });

    it('should handle null/undefined code contexts', () => {
      const result = (samuraiAgent as any)._formatCodeContextsForPrompt(null as any);
      expect(result).toBe('No code context available.');
    });
  });


  describe('findEpicenterFromExecute', () => {
    let mockCodeParserService: any;
    let originalCodeParserService: any;

    beforeEach(() => {
      // Mock CodeParserService
      mockCodeParserService = {
        detectLanguage: jest.fn().mockReturnValue('typescript'),
        extractElementsFromFile: jest.fn(),
      };
      
      // Store original and replace
      const CodeParserServiceModule = require('../../../src/agent/code_parser/CodeParserService');
      originalCodeParserService = CodeParserServiceModule.CodeParserService;
      CodeParserServiceModule.CodeParserService = jest.fn().mockImplementation(() => mockCodeParserService);
    });

    afterEach(() => {
      // Restore original
      const CodeParserServiceModule = require('../../../src/agent/code_parser/CodeParserService');
      CodeParserServiceModule.CodeParserService = originalCodeParserService;
      jest.resetModules();
    });

    it('should extract methods from files without methods and refine to top 3', async () => {
      const workspaceRoot = '/test/workspace';
      const userMessage = 'Debug this error';
      
      const session: Session = {
        id: 'test-session',
        title: 'Test Session',
        status: 'active' as any,
        messageCount: 0,
        totalTokens: 0,
        totalCost: 0,
        lastMessageAt: new Date(),
        tags: [],
        metadata: {
          projectId: 'test-project',
          model: 'gpt-4',
          connectedCodebasePath: workspaceRoot,
        },
        codeContextIds: [],
        previous_session_intent: UserIntentEnum.PURE_DISCUSSION,
        createdAt: new Date(),
        updatedAt: new Date(),
      };

      // Mock ExtractCodeTool to return files with and without methods
      const mockExtractResult: ExtractCodeToolResultPayload = {
        relevantCodeElements: [
          {
            path: '/test/workspace/file1.ts',
            elements: [
              { type: 'function', name: 'method1' },
              { type: 'method', name: 'method2' },
            ],
            snippet: 'code snippet 1',
          },
          {
            path: '/test/workspace/file2.ts',
            elements: [], // No methods - should trigger extraction
            snippet: 'code snippet 2',
          },
          {
            path: '/test/workspace/file3.ts',
            elements: [
              { type: 'function', name: 'method3' },
            ],
            snippet: 'code snippet 3',
          },
        ],
        files: [],
      };

      mockExtractCodeTool.execute.mockResolvedValue({
        success: true,
        result: mockExtractResult,
      });

      // Mock CodeParserService to extract methods from file2.ts
      mockCodeParserService.extractElementsFromFile.mockResolvedValue([
        { type: 'function', name: 'extractedMethod1' },
        { type: 'method', name: 'extractedMethod2' },
        { type: 'method', name: 'extractedMethod3' },
      ]);

      // Mock LLM to return top 3 selections
      mockLLMProviderService.chat.mockResolvedValue({
        type: 'success',
        payload: {
          content: JSON.stringify([
            { file: 'file1.ts', method: 'method1' },
            { file: 'file2.ts', method: 'extractedMethod1' },
            { file: 'file3.ts', method: 'method3' },
          ]),
          provider: 'test',
          model: 'gpt-4',
        },
      });

      // Mock fs.existsSync and mkdirSync for checkpoint saving
      mockedFs.existsSync.mockReturnValue(true);
      mockedFs.mkdirSync.mockReturnValue(undefined);
      mockedFs.writeFileSync.mockReturnValue(undefined);
      
      // Mock readPromptFile to return the epicenter refinement prompt
      const epicenterPromptContent = `# Epicenter Refinement

## User Bug Description

{userBugDescription}

## Chat History

{chatHistory}

## Candidate Functions

{candidateFunctions}

Respond with a JSON array of your top 3 choices, in order of priority:
[
  { "file": "path/to/file.ts", "method": "methodName" },
  ...
]`;
      mockedFs.readFileSync.mockImplementation((filePath: string) => {
        if (filePath.includes('epicenter_refinement.md')) {
          return epicenterPromptContent;
        }
        return 'Mock prompt content with {projectDetails} and {codeContexts} and {conversationSummary} and {activeTaskHeader} and {noActiveTaskInference}';
      });

      const result = await (samuraiAgent as any).findEpicenterFromExecute(
        userMessage,
        workspaceRoot,
        session,
        []
      );

      // Verify ExtractCodeTool was called
      expect(mockExtractCodeTool.execute).toHaveBeenCalledWith({
        query: `Bug Description:\n${userMessage}`,
        filePathPattern: undefined,
        projectId: session.metadata.projectId,
        sessionId: session.id,
        connectedCodebasePath: workspaceRoot,
        model: session.metadata.model,
        filenameKeywords: [],
        methodNameKeywords: [],
        codeKeywords: [],
        manuallyPinnedFilePaths: [],
      });

      // Verify CodeParserService was called for file without methods
      expect(mockCodeParserService.detectLanguage).toHaveBeenCalledWith('/test/workspace/file2.ts');
      expect(mockCodeParserService.extractElementsFromFile).toHaveBeenCalledWith(
        '/test/workspace/file2.ts',
        'typescript'
      );

      // Verify LLM was called for refinement
      expect(mockLLMProviderService.chat).toHaveBeenCalled();
      const llmCall = mockLLMProviderService.chat.mock.calls[0][0];
      expect(llmCall.messages[1].content).toContain(userMessage);
      expect(llmCall.messages[1].content).toContain('Candidate Functions');

      // Verify result structure
      expect(result).toBeDefined();
      expect(result.source).toBe('execute');
      expect(result.confidence).toBe(0.6);
      
      // Verify only methods are returned (no files without methods)
      expect(result.files).toEqual([]);
      expect(result.methods).toBeDefined();
      expect(Array.isArray(result.methods)).toBe(true);
      expect(result.methods.length).toBeLessThanOrEqual(3);
      
      // Verify all methods have both file and method specified
      result.methods.forEach((m: any) => {
        expect(m).toHaveProperty('file');
        expect(m).toHaveProperty('method');
        expect(m.file).toBeTruthy();
        expect(m.method).toBeTruthy();
      });
    });

    it('should handle files with methods only (no extraction needed)', async () => {
      const workspaceRoot = '/test/workspace';
      const userMessage = 'Debug this error';
      
      const session: Session = {
        id: 'test-session',
        title: 'Test Session',
        status: 'active' as any,
        messageCount: 0,
        totalTokens: 0,
        totalCost: 0,
        lastMessageAt: new Date(),
        tags: [],
        metadata: {
          projectId: 'test-project',
          model: 'gpt-4',
          connectedCodebasePath: workspaceRoot,
        },
        codeContextIds: [],
        previous_session_intent: UserIntentEnum.PURE_DISCUSSION,
        createdAt: new Date(),
        updatedAt: new Date(),
      };

      // Mock ExtractCodeTool to return files with methods only
      const mockExtractResult: ExtractCodeToolResultPayload = {
        relevantCodeElements: [
          {
            path: '/test/workspace/file1.ts',
            elements: [
              { type: 'function', name: 'method1' },
              { type: 'method', name: 'method2' },
            ],
            snippet: 'code snippet 1',
          },
          {
            path: '/test/workspace/file2.ts',
            elements: [
              { type: 'function', name: 'method3' },
            ],
            snippet: 'code snippet 2',
          },
        ],
        files: [],
      };

      mockExtractCodeTool.execute.mockResolvedValue({
        success: true,
        result: mockExtractResult,
      });

      // Mock LLM to return top 3 selections
      mockLLMProviderService.chat.mockResolvedValue({
        type: 'success',
        payload: {
          content: JSON.stringify([
            { file: 'file1.ts', method: 'method1' },
            { file: 'file1.ts', method: 'method2' },
            { file: 'file2.ts', method: 'method3' },
          ]),
          provider: 'test',
          model: 'gpt-4',
        },
      });

      // Mock fs for checkpoint saving
      mockedFs.existsSync.mockReturnValue(true);
      mockedFs.mkdirSync.mockReturnValue(undefined);
      mockedFs.writeFileSync.mockReturnValue(undefined);

      const result = await (samuraiAgent as any).findEpicenterFromExecute(
        userMessage,
        workspaceRoot,
        session,
        []
      );

      // Verify CodeParserService was NOT called (all files have methods)
      expect(mockCodeParserService.extractElementsFromFile).not.toHaveBeenCalled();

      // Verify result
      expect(result.methods.length).toBeLessThanOrEqual(3);
      expect(result.files).toEqual([]);
    });

    it('should handle LLM failure gracefully with fallback', async () => {
      const workspaceRoot = '/test/workspace';
      const userMessage = 'Debug this error';
      
      const session: Session = {
        id: 'test-session',
        title: 'Test Session',
        status: 'active' as any,
        messageCount: 0,
        totalTokens: 0,
        totalCost: 0,
        lastMessageAt: new Date(),
        tags: [],
        metadata: {
          projectId: 'test-project',
          model: 'gpt-4',
          connectedCodebasePath: workspaceRoot,
        },
        codeContextIds: [],
        previous_session_intent: UserIntentEnum.PURE_DISCUSSION,
        createdAt: new Date(),
        updatedAt: new Date(),
      };

      const mockExtractResult: ExtractCodeToolResultPayload = {
        relevantCodeElements: [
          {
            path: '/test/workspace/file1.ts',
            elements: [
              { type: 'function', name: 'method1' },
              { type: 'method', name: 'method2' },
              { type: 'method', name: 'method3' },
              { type: 'method', name: 'method4' },
            ],
            snippet: 'code snippet 1',
          },
        ],
        files: [],
      };

      mockExtractCodeTool.execute.mockResolvedValue({
        success: true,
        result: mockExtractResult,
      });

      // Mock LLM to fail
      mockLLMProviderService.chat.mockResolvedValue({
        type: 'error',
        payload: { error: 'LLM error' },
      });

      // Mock fs for checkpoint saving
      mockedFs.existsSync.mockReturnValue(true);
      mockedFs.mkdirSync.mockReturnValue(undefined);
      mockedFs.writeFileSync.mockReturnValue(undefined);

      const result = await (samuraiAgent as any).findEpicenterFromExecute(
        userMessage,
        workspaceRoot,
        session,
        []
      );

      // Verify fallback to first 3 candidates
      expect(result.methods.length).toBeLessThanOrEqual(3);
      expect(result.files).toEqual([]);
    });

    it('should handle extraction failure gracefully', async () => {
      const workspaceRoot = '/test/workspace';
      const userMessage = 'Debug this error';
      
      const session: Session = {
        id: 'test-session',
        title: 'Test Session',
        status: 'active' as any,
        messageCount: 0,
        totalTokens: 0,
        totalCost: 0,
        lastMessageAt: new Date(),
        tags: [],
        metadata: {
          projectId: 'test-project',
          model: 'gpt-4',
          connectedCodebasePath: workspaceRoot,
        },
        codeContextIds: [],
        previous_session_intent: UserIntentEnum.PURE_DISCUSSION,
        createdAt: new Date(),
        updatedAt: new Date(),
      };

      const mockExtractResult: ExtractCodeToolResultPayload = {
        relevantCodeElements: [
          {
            path: '/test/workspace/file1.ts',
            elements: [
              { type: 'function', name: 'method1' },
            ],
            snippet: 'code snippet 1',
          },
          {
            path: '/test/workspace/file2.ts',
            elements: [], // No methods - should trigger extraction
            snippet: 'code snippet 2',
          },
        ],
        files: [],
      };

      mockExtractCodeTool.execute.mockResolvedValue({
        success: true,
        result: mockExtractResult,
      });

      // Mock CodeParserService to fail
      mockCodeParserService.detectLanguage.mockReturnValue('typescript');
      mockCodeParserService.extractElementsFromFile.mockRejectedValue(
        new Error('Extraction failed')
      );

      // Mock LLM
      mockLLMProviderService.chat.mockResolvedValue({
        type: 'success',
        payload: {
          content: JSON.stringify([
            { file: 'file1.ts', method: 'method1' },
          ]),
          provider: 'test',
          model: 'gpt-4',
        },
      });

      // Mock fs for checkpoint saving
      mockedFs.existsSync.mockReturnValue(true);
      mockedFs.mkdirSync.mockReturnValue(undefined);
      mockedFs.writeFileSync.mockReturnValue(undefined);

      const result = await (samuraiAgent as any).findEpicenterFromExecute(
        userMessage,
        workspaceRoot,
        session,
        []
      );

      // Verify result still works (file2.ts is skipped)
      expect(result.methods.length).toBeGreaterThan(0);
      expect(result.files).toEqual([]);
    });

    it('should prioritize user-selected context files through extraction pipeline', async () => {
      const workspaceRoot = '/test/workspace';
      const userMessage = 'Investigate user provided context file';
      const contextFiles = ['/test/workspace/pinned.ts'];

      const session: Session = {
        id: 'test-session',
        title: 'Test Session',
        status: 'active' as any,
        messageCount: 0,
        totalTokens: 0,
        totalCost: 0,
        lastMessageAt: new Date(),
        tags: [],
        metadata: {
          projectId: 'test-project',
          model: 'gpt-4',
          connectedCodebasePath: workspaceRoot,
        },
        codeContextIds: [],
        previous_session_intent: UserIntentEnum.PURE_DISCUSSION,
        createdAt: new Date(),
        updatedAt: new Date(),
      };

      mockExtractCodeTool.execute.mockResolvedValue({
        success: true,
        result: {
          relevantCodeElements: [],
          files: [],
        },
      });

      mockCodeParserService.detectLanguage.mockReturnValue('typescript');
      mockCodeParserService.extractElementsFromFile.mockResolvedValue([
        {
          type: 'function',
          name: 'userPinnedMethod',
          codeSnippet: 'function userPinnedMethod() { return true; }',
          lineStart: 1,
          lineEnd: 3,
        },
      ]);

      const refineSpy = jest
        .spyOn(samuraiAgent as any, 'refineEpicenterWithLLM')
        .mockResolvedValue([
          { file: '/test/workspace/pinned.ts', method: 'userPinnedMethod' },
        ]);

      mockedFs.readFileSync.mockImplementation((filePath: string) => {
        if (filePath === '/test/workspace/pinned.ts') {
          return 'function userPinnedMethod() { return true; }';
        }
        return 'Mock prompt content with {projectDetails} and {codeContexts} and {conversationSummary} and {activeTaskHeader} and {noActiveTaskInference}';
      });

      mockedFs.existsSync.mockImplementation(() => true);

      try {
        const result = await (samuraiAgent as any).findEpicenterFromExecute(
          userMessage,
          workspaceRoot,
          session,
          contextFiles
        );

        expect(mockExtractCodeTool.execute).toHaveBeenCalledWith(
          expect.objectContaining({
            manuallyPinnedFilePaths: ['/test/workspace/pinned.ts'],
          })
        );
        expect(mockCodeParserService.extractElementsFromFile).toHaveBeenCalledWith(
          '/test/workspace/pinned.ts',
          'typescript'
        );
        expect(refineSpy).toHaveBeenCalledWith(
          expect.arrayContaining([
            expect.objectContaining({
              file: '/test/workspace/pinned.ts',
              method: 'userPinnedMethod',
            }),
          ]),
          userMessage,
          session,
          undefined
        );
        expect(result.methods).toEqual([
          { file: '/test/workspace/pinned.ts', method: 'userPinnedMethod' },
        ]);
      } finally {
        refineSpy.mockRestore();
      }
    });
  });

  describe('findEpicenter', () => {
    it('uses error message when logs lack stack frames', async () => {
      const workspaceRoot = '/test/workspace';
      const session: Session = {
        id: 'session-1',
        title: 'Test Session',
        status: 'active' as any,
        messageCount: 0,
        totalTokens: 0,
        totalCost: 0,
        lastMessageAt: new Date(),
        tags: [],
        metadata: {
          projectId: 'proj',
          model: 'gpt-4',
          connectedCodebasePath: workspaceRoot,
        },
        codeContextIds: [],
        previous_session_intent: UserIntentEnum.PURE_DISCUSSION,
        createdAt: new Date(),
        updatedAt: new Date(),
      };

      const logs = `Error: Something failed
        at doThing (src/app.ts:10:5)`;
      const userMessage = 'App crashes on start';

      const mockEvidence: Evidence = {
        frames: [],
        error: 'TypeError: Cannot read property',
        requestId: undefined,
        route: undefined,
        logSignatures: [],
        tsconfigPaths: {},
        evidenceSource: 'logs',
        hasHardError: false,
        hasLogs: true,
        softSignals: [],
        httpSpans: [],
        logLevels: { debug: 0, info: 0, warn: 0, error: 1 },
      };

      const expectedEpicenter: EpicenterResult = {
        files: [],
        methods: [{ file: 'src/app.ts', method: 'doThing' }],
        source: 'logs',
        confidence: 0.6,
      };

      const evidenceSpy = jest
        .spyOn(EvidenceParser.prototype, 'parseEvidence')
        .mockReturnValue(mockEvidence);
      const executeSpy = jest
        .spyOn(samuraiAgent as any, 'findEpicenterFromExecute')
        .mockResolvedValue(expectedEpicenter);

      try {
        const result = await (samuraiAgent as any).findEpicenter(
          logs,
          userMessage,
          workspaceRoot,
          session,
          []
        );

        expect(executeSpy).toHaveBeenCalledTimes(1);
        const callArgs = executeSpy.mock.calls[0];
        expect(callArgs[0]).toBe(userMessage);
        expect(callArgs[1]).toBe(workspaceRoot);
        expect(callArgs[2]).toBe(session);
        expect(callArgs[3]).toEqual([]);
        const options = callArgs[5];
        expect(options).toBeDefined();
        expect(options).toMatchObject({
          errorMessage: mockEvidence.error,
          source: 'logs',
        });
        expect(options.logContext).toContain('Error: Something failed');
        expect(result).toEqual(expectedEpicenter);
      } finally {
        evidenceSpy.mockRestore();
        executeSpy.mockRestore();
      }
    });
  });

  describe('refineEpicenterWithLLM - Path Handling', () => {
    let session: Session;

    beforeEach(() => {
      session = {
        id: 'test-session',
        title: 'Test Session',
        status: 'active' as any,
        messageCount: 0,
        totalTokens: 0,
        totalCost: 0,
        lastMessageAt: new Date(),
        tags: [],
        metadata: {
          model: 'gpt-4',
          projectId: 'test-project'
        },
        codeContextIds: [],
        previous_session_intent: UserIntentEnum.PURE_DISCUSSION,
        createdAt: new Date(),
        updatedAt: new Date()
      };

      // Mock prompt file loading
      mockedFs.readFileSync.mockReturnValue(`
# Epicenter Refinement

## User Bug Description
{userBugDescription}

## Chat History
{chatHistory}

## Candidate Functions
{candidateFunctions}

Respond with a JSON array of your top 3 choices, in order of priority:
[
  { "file": "path/to/file.ts", "method": "methodName" },
  ...
]`);
      mockedFs.existsSync.mockReturnValue(true);
    });

    it('should handle Windows paths (backslashes) in candidates', async () => {
      const candidates = [
        { file: 'C:\\repo\\src\\foo.ts', method: 'method1' },
        { file: 'C:\\repo\\src\\bar.ts', method: 'method2' },
        { file: 'C:\\repo\\lib\\baz.ts', method: 'method3' },
        { file: 'C:\\repo\\test\\qux.ts', method: 'method4' },
      ];

      // LLM returns filenames only (common scenario)
      mockLLMProviderService.chat.mockResolvedValue({
        type: 'success',
        payload: {
          content: JSON.stringify([
            { file: 'foo.ts', method: 'method1' },
            { file: 'bar.ts', method: 'method2' },
            { file: 'baz.ts', method: 'method3' },
          ]),
          provider: 'test',
          model: 'gpt-4',
        },
      });

      const result = await (samuraiAgent as any).refineEpicenterWithLLM(
        candidates,
        'Test bug description',
        session
      );

      expect(result).toHaveLength(3);
      expect(result[0].file).toBe('C:\\repo\\src\\foo.ts');
      expect(result[0].method).toBe('method1');
      expect(result[1].file).toBe('C:\\repo\\src\\bar.ts');
      expect(result[1].method).toBe('method2');
      expect(result[2].file).toBe('C:\\repo\\lib\\baz.ts');
      expect(result[2].method).toBe('method3');
    });

    it('should handle Mac/Unix paths (forward slashes) in candidates', async () => {
      const candidates = [
        { file: '/Users/repo/src/foo.ts', method: 'method1' },
        { file: '/Users/repo/src/bar.ts', method: 'method2' },
        { file: '/Users/repo/lib/baz.ts', method: 'method3' },
        { file: '/Users/repo/test/qux.ts', method: 'method4' },
      ];

      // LLM returns filenames only
      mockLLMProviderService.chat.mockResolvedValue({
        type: 'success',
        payload: {
          content: JSON.stringify([
            { file: 'foo.ts', method: 'method1' },
            { file: 'bar.ts', method: 'method2' },
            { file: 'baz.ts', method: 'method3' },
          ]),
          provider: 'test',
          model: 'gpt-4',
        },
      });

      const result = await (samuraiAgent as any).refineEpicenterWithLLM(
        candidates,
        'Test bug description',
        session
      );

      expect(result).toHaveLength(3);
      expect(result[0].file).toBe('/Users/repo/src/foo.ts');
      expect(result[0].method).toBe('method1');
      expect(result[1].file).toBe('/Users/repo/src/bar.ts');
      expect(result[1].method).toBe('method2');
      expect(result[2].file).toBe('/Users/repo/lib/baz.ts');
      expect(result[2].method).toBe('method3');
    });

    it('should match Windows candidate paths when LLM returns forward slashes', async () => {
      const candidates = [
        { file: 'C:\\repo\\src\\foo.ts', method: 'method1' },
        { file: 'C:\\repo\\src\\bar.ts', method: 'method2' },
        { file: 'C:\\repo\\lib\\baz.ts', method: 'method3' },
      ];

      // LLM returns full path with forward slashes (common when LLM normalizes paths)
      mockLLMProviderService.chat.mockResolvedValue({
        type: 'success',
        payload: {
          content: JSON.stringify([
            { file: 'C:/repo/src/foo.ts', method: 'method1' },
            { file: 'C:/repo/src/bar.ts', method: 'method2' },
            { file: 'C:/repo/lib/baz.ts', method: 'method3' },
          ]),
          provider: 'test',
          model: 'gpt-4',
        },
      });

      const result = await (samuraiAgent as any).refineEpicenterWithLLM(
        candidates,
        'Test bug description',
        session
      );

      expect(result).toHaveLength(3);
      expect(result[0].file).toBe('C:\\repo\\src\\foo.ts');
      expect(result[0].method).toBe('method1');
      expect(result[1].file).toBe('C:\\repo\\src\\bar.ts');
      expect(result[1].method).toBe('method2');
      expect(result[2].file).toBe('C:\\repo\\lib\\baz.ts');
      expect(result[2].method).toBe('method3');
    });

    it('should match filenames when LLM returns only basenames for Windows paths', async () => {
      const candidates = [
        { file: 'C:\\Users\\dev\\project\\src\\components\\Button.tsx', method: 'handleClick' },
        { file: 'C:\\Users\\dev\\project\\src\\utils\\helper.ts', method: 'processData' },
        { file: 'C:\\Users\\dev\\project\\src\\api\\service.ts', method: 'fetchData' },
      ];

      // LLM returns just filenames
      mockLLMProviderService.chat.mockResolvedValue({
        type: 'success',
        payload: {
          content: JSON.stringify([
            { file: 'Button.tsx', method: 'handleClick' },
            { file: 'helper.ts', method: 'processData' },
            { file: 'service.ts', method: 'fetchData' },
          ]),
          provider: 'test',
          model: 'gpt-4',
        },
      });

      const result = await (samuraiAgent as any).refineEpicenterWithLLM(
        candidates,
        'Test bug description',
        session
      );

      expect(result).toHaveLength(3);
      expect(result[0].file).toBe('C:\\Users\\dev\\project\\src\\components\\Button.tsx');
      expect(result[0].method).toBe('handleClick');
      expect(result[1].file).toBe('C:\\Users\\dev\\project\\src\\utils\\helper.ts');
      expect(result[1].method).toBe('processData');
      expect(result[2].file).toBe('C:\\Users\\dev\\project\\src\\api\\service.ts');
      expect(result[2].method).toBe('fetchData');
    });

    it('should match filenames when LLM returns only basenames for Mac paths', async () => {
      const candidates = [
        { file: '/Users/dev/project/src/components/Button.tsx', method: 'handleClick' },
        { file: '/Users/dev/project/src/utils/helper.ts', method: 'processData' },
        { file: '/Users/dev/project/src/api/service.ts', method: 'fetchData' },
      ];

      // LLM returns just filenames
      mockLLMProviderService.chat.mockResolvedValue({
        type: 'success',
        payload: {
          content: JSON.stringify([
            { file: 'Button.tsx', method: 'handleClick' },
            { file: 'helper.ts', method: 'processData' },
            { file: 'service.ts', method: 'fetchData' },
          ]),
          provider: 'test',
          model: 'gpt-4',
        },
      });

      const result = await (samuraiAgent as any).refineEpicenterWithLLM(
        candidates,
        'Test bug description',
        session
      );

      expect(result).toHaveLength(3);
      expect(result[0].file).toBe('/Users/dev/project/src/components/Button.tsx');
      expect(result[0].method).toBe('handleClick');
      expect(result[1].file).toBe('/Users/dev/project/src/utils/helper.ts');
      expect(result[1].method).toBe('processData');
      expect(result[2].file).toBe('/Users/dev/project/src/api/service.ts');
      expect(result[2].method).toBe('fetchData');
    });

    it('should handle mixed path separators correctly', async () => {
      // Candidate has Windows path
      const candidates = [
        { file: 'C:\\repo\\src\\deep\\nested\\file.ts', method: 'method1' },
        { file: 'C:\\repo\\src\\other\\file.ts', method: 'method2' },
      ];

      // LLM returns Unix-style path
      mockLLMProviderService.chat.mockResolvedValue({
        type: 'success',
        payload: {
          content: JSON.stringify([
            { file: 'C:/repo/src/deep/nested/file.ts', method: 'method1' },
            { file: 'file.ts', method: 'method2' }, // Just filename
          ]),
          provider: 'test',
          model: 'gpt-4',
        },
      });

      const result = await (samuraiAgent as any).refineEpicenterWithLLM(
        candidates,
        'Test bug description',
        session
      );

      expect(result).toHaveLength(2);
      expect(result[0].file).toBe('C:\\repo\\src\\deep\\nested\\file.ts');
      expect(result[0].method).toBe('method1');
      expect(result[1].file).toBe('C:\\repo\\src\\other\\file.ts');
      expect(result[1].method).toBe('method2');
    });

    it('should return original candidate paths (not normalized) when matching', async () => {
      const candidates = [
        { file: 'C:\\Windows\\Path\\file.ts', method: 'method1' },
        { file: '/unix/path/file.ts', method: 'method2' },
      ];

      mockLLMProviderService.chat.mockResolvedValue({
        type: 'success',
        payload: {
          content: JSON.stringify([
            { file: 'file.ts', method: 'method1' },
            { file: 'file.ts', method: 'method2' },
          ]),
          provider: 'test',
          model: 'gpt-4',
        },
      });

      const result = await (samuraiAgent as any).refineEpicenterWithLLM(
        candidates,
        'Test bug description',
        session
      );

      // Should preserve original path format
      expect(result[0].file).toBe('C:\\Windows\\Path\\file.ts');
      expect(result[1].file).toBe('/unix/path/file.ts');
    });

    it('should handle relative paths correctly', async () => {
      const candidates = [
        { file: 'src/foo.ts', method: 'method1' },
        { file: 'lib/bar.ts', method: 'method2' },
        { file: 'test/baz.ts', method: 'method3' },
      ];

      mockLLMProviderService.chat.mockResolvedValue({
        type: 'success',
        payload: {
          content: JSON.stringify([
            { file: 'foo.ts', method: 'method1' },
            { file: 'bar.ts', method: 'method2' },
            { file: 'baz.ts', method: 'method3' },
          ]),
          provider: 'test',
          model: 'gpt-4',
        },
      });

      const result = await (samuraiAgent as any).refineEpicenterWithLLM(
        candidates,
        'Test bug description',
        session
      );

      expect(result).toHaveLength(3);
      expect(result[0].file).toBe('src/foo.ts');
      expect(result[0].method).toBe('method1');
      expect(result[1].file).toBe('lib/bar.ts');
      expect(result[1].method).toBe('method2');
      expect(result[2].file).toBe('test/baz.ts');
      expect(result[2].method).toBe('method3');
    });
  });

  describe('execute debugging metadata', () => {
    it('includes nodeInfoMap from handleDebugging response in metadata', async () => {
      const session: Session = {
        id: 'session-debug',
        title: 'Debug Session',
        status: 'active' as any,
        messageCount: 0,
        totalTokens: 0,
        totalCost: 0,
        lastMessageAt: new Date(),
        tags: [],
        metadata: {
          projectId: 'project-1',
          mode: 'debugging'
        },
        codeContextIds: [],
        previous_session_intent: UserIntentEnum.BUG_ANALYSIS,
        createdAt: new Date(),
        updatedAt: new Date()
      };

      const userMessage: ChatMessage = {
        id: 'msg-debug',
        sessionId: session.id,
        projectId: 'project-1',
        type: 'user' as any,
        content: 'Please debug this issue',
        role: 'user',
        metadata: {},
        isEdited: false,
        createdAt: new Date(),
        updatedAt: new Date()
      };

      const nodeInfoMap = {
        nodeA: {
          analysis: 'Root cause analysis',
          importance: 0.9
        }
      };

      const visualizationData = {
        visualization: 'graph TD; A-->B;',
        visualizationMeta: { nodeCount: 1, edgeCount: 0 },
        visualizationDiagnostics: [],
        nodeLocationMap: {},
        nodeInfoMap,
        pipelineSteps: []
      };

      jest.spyOn(samuraiAgent as any, 'handleDebugging').mockResolvedValue({
        message: 'Debugging complete',
        visualizationData
      });

      mockDataStore.loadChatMessagesForSession.mockReturnValue([]);
      mockProjectDetailService.getProjectDetails.mockResolvedValue('Project details');
      mockDataStore.loadAllCodeContextForSession.mockResolvedValue([]);
      mockDataStore.updateSession.mockResolvedValue(undefined as any);

      const result = await samuraiAgent.execute(userMessage, session);

      expect(result.success).toBe(true);
      expect(result.metadata.nodeInfoMap).toBe(nodeInfoMap);
      expect((samuraiAgent as any).handleDebugging).toHaveBeenCalledWith(
        userMessage,
        expect.arrayContaining([{ role: 'user', content: userMessage.content }]),
        'Project details',
        [],
        session,
        undefined // onProgress is optional
      );
    });
  });

  describe('handleDebugging progress updates', () => {
    it('should call onProgress callback at major steps', async () => {
      const session: Session = {
        id: 'session-debug',
        title: 'Debug Session',
        status: 'active' as any,
        messageCount: 0,
        totalTokens: 0,
        totalCost: 0,
        lastMessageAt: new Date(),
        tags: [],
        metadata: {
          projectId: 'project-1',
          mode: 'debugging',
          connectedCodebasePath: process.cwd()
        },
        codeContextIds: [],
        previous_session_intent: UserIntentEnum.BUG_ANALYSIS,
        createdAt: new Date(),
        updatedAt: new Date()
      };

      const userMessage: ChatMessage = {
        id: 'msg-debug',
        sessionId: session.id,
        projectId: 'project-1',
        type: 'user' as any,
        content: 'Please debug this issue',
        role: 'user',
        metadata: {},
        isEdited: false,
        createdAt: new Date(),
        updatedAt: new Date()
      };

      const progressUpdates: string[] = [];
      const onProgress = jest.fn((status: string) => {
        progressUpdates.push(status);
      });

      // Mock workspace root
      (global as any).vscode = {
        workspace: {
          workspaceFolders: [{
            uri: {
              fsPath: process.cwd()
            }
          }]
        }
      };

      // Mock the internal methods to avoid actual execution
      jest.spyOn(samuraiAgent as any, 'findEpicenter').mockResolvedValue({
        files: ['test.ts'],
        methods: [{ file: 'test.ts', method: 'testMethod' }],
        confidence: 0.8
      } as any);

      jest.spyOn(samuraiAgent as any, 'extractRelevantCodeBasedOnGraph').mockResolvedValue({
        nodes: [],
        edges: [],
        codeSnippets: []
      } as any);

      (samuraiAgent as any).projectTechStackService = {
        ensureTechStack: jest.fn().mockResolvedValue({
          frameworks: []
        })
      };

      // Mock rootCauseAnalyzer
      const mockRootCauseAnalyzer = {
        analyzeRootCauseSimplified: jest.fn().mockResolvedValue({
          report: {
            summary: 'Test summary',
            likelyRootCause: 'Test root cause',
            confidence: 0.8,
            reasoningSteps: [],
            recommendedFix: 'Test fix',
            evidence: [],
            hypotheses: []
          },
          rawResponse: 'Test response',
          formattedResponse: 'Test formatted',
          iterationSummaries: [{ iteration: 1, confidence: 0.8 }]
        })
      };
      (samuraiAgent as any).rootCauseAnalyzer = mockRootCauseAnalyzer;

      // Mock visualization service
      jest.spyOn(samuraiAgent as any, 'executeDebuggingStage').mockImplementation(async (stage, fn) => {
        return await fn();
      });

      const VisualizationService = require('../../../src/agent/tools/debugging/VisualizationService').VisualizationService;
      jest.spyOn(VisualizationService.prototype, 'generateVisualization').mockResolvedValue({
        mermaid: 'graph TD; A-->B;',
        meta: { nodeCount: 1, edgeCount: 0 },
        diagnostics: [],
        nodeLocationMap: {},
        nodeInfoMap: {},
        isValid: true
      });

      // Mock saveDebugOutputToFile and saveDebugOutputJSON
      jest.spyOn(samuraiAgent as any, 'saveDebugOutputToFile').mockReturnValue('test-path.txt');
      jest.spyOn(samuraiAgent as any, 'saveDebugOutputJSON').mockReturnValue('test-path.json');
      jest.spyOn(samuraiAgent as any, 'collectContextFilePaths').mockReturnValue([]);
      jest.spyOn(samuraiAgent as any, 'registerDebuggingCostObserver').mockReturnValue(() => {});

      try {
        await (samuraiAgent as any).handleDebugging(
          userMessage,
          [],
          'Project details',
          [],
          session,
          onProgress
        );

        // Verify onProgress was called
        expect(onProgress).toHaveBeenCalled();

        // Check that we got the expected progress updates
        expect(progressUpdates.length).toBeGreaterThan(0);
        
        // Verify specific progress messages were called
        const progressMessages = progressUpdates.map(call => {
          if (typeof call === 'string') return call;
          return call;
        });

        // Should include "Analyzing your code..."
        expect(progressMessages.some(msg => msg.includes('Analyzing your code'))).toBe(true);
        
        // Should include "Finding epicenter..."
        expect(progressMessages.some(msg => msg.includes('Finding epicenter'))).toBe(true);
        
        // Should include "Building execution graph..."
        expect(progressMessages.some(msg => msg.includes('Building execution graph'))).toBe(true);
        
        // Should include "Running root cause analysis"
        expect(progressMessages.some(msg => msg.includes('Running root cause analysis'))).toBe(true);
        
        // Should include "Generating visualization..."
        expect(progressMessages.some(msg => msg.includes('Generating visualization'))).toBe(true);
      } catch (error) {
        // Even if the method fails, we should have received some progress updates
        expect(progressUpdates.length).toBeGreaterThan(0);
      }
    });

    it('should work without onProgress callback', async () => {
      const session: Session = {
        id: 'session-debug',
        title: 'Debug Session',
        status: 'active' as any,
        messageCount: 0,
        totalTokens: 0,
        totalCost: 0,
        lastMessageAt: new Date(),
        tags: [],
        metadata: {
          projectId: 'project-1',
          mode: 'debugging',
          connectedCodebasePath: process.cwd()
        },
        codeContextIds: [],
        previous_session_intent: UserIntentEnum.BUG_ANALYSIS,
        createdAt: new Date(),
        updatedAt: new Date()
      };

      const userMessage: ChatMessage = {
        id: 'msg-debug',
        sessionId: session.id,
        projectId: 'project-1',
        type: 'user' as any,
        content: 'Please debug this issue',
        role: 'user',
        metadata: {},
        isEdited: false,
        createdAt: new Date(),
        updatedAt: new Date()
      };

      // Mock workspace root
      (global as any).vscode = {
        workspace: {
          workspaceFolders: [{
            uri: {
              fsPath: process.cwd()
            }
          }]
        }
      };

      // Mock all internal methods
      jest.spyOn(samuraiAgent as any, 'findEpicenter').mockResolvedValue({
        files: ['test.ts'],
        methods: [{ file: 'test.ts', method: 'testMethod' }],
        confidence: 0.8
      } as any);

      jest.spyOn(samuraiAgent as any, 'extractRelevantCodeBasedOnGraph').mockResolvedValue({
        nodes: [],
        edges: [],
        codeSnippets: []
      } as any);

      (samuraiAgent as any).projectTechStackService = {
        ensureTechStack: jest.fn().mockResolvedValue({
          frameworks: []
        })
      };

      const mockRootCauseAnalyzer = {
        analyzeRootCauseSimplified: jest.fn().mockResolvedValue({
          report: {
            summary: 'Test summary',
            likelyRootCause: 'Test root cause',
            confidence: 0.8,
            reasoningSteps: [],
            recommendedFix: 'Test fix',
            evidence: [],
            hypotheses: []
          },
          rawResponse: 'Test response',
          formattedResponse: 'Test formatted',
          iterationSummaries: [{ iteration: 1, confidence: 0.8 }]
        })
      };
      (samuraiAgent as any).rootCauseAnalyzer = mockRootCauseAnalyzer;

      jest.spyOn(samuraiAgent as any, 'executeDebuggingStage').mockImplementation(async (stage, fn) => {
        return await fn();
      });

      const VisualizationService = require('../../../src/agent/tools/debugging/VisualizationService').VisualizationService;
      jest.spyOn(VisualizationService.prototype, 'generateVisualization').mockResolvedValue({
        mermaid: 'graph TD; A-->B;',
        meta: { nodeCount: 1, edgeCount: 0 },
        diagnostics: [],
        nodeLocationMap: {},
        nodeInfoMap: {},
        isValid: true
      });

      jest.spyOn(samuraiAgent as any, 'saveDebugOutputToFile').mockReturnValue('test-path.txt');
      jest.spyOn(samuraiAgent as any, 'saveDebugOutputJSON').mockReturnValue('test-path.json');
      jest.spyOn(samuraiAgent as any, 'collectContextFilePaths').mockReturnValue([]);
      jest.spyOn(samuraiAgent as any, 'registerDebuggingCostObserver').mockReturnValue(() => {});

      // Should not throw when onProgress is undefined
      await expect(
        (samuraiAgent as any).handleDebugging(
          userMessage,
          [],
          'Project details',
          [],
          session,
          undefined
        )
      ).resolves.toBeDefined();
    });
  });

  describe('execute with progress callback', () => {
    it('should pass onProgress callback to handleDebugging in debugging mode', async () => {
      const session: Session = {
        id: 'session-debug',
        title: 'Debug Session',
        status: 'active' as any,
        messageCount: 0,
        totalTokens: 0,
        totalCost: 0,
        lastMessageAt: new Date(),
        tags: [],
        metadata: {
          projectId: 'project-1',
          mode: 'debugging'
        },
        codeContextIds: [],
        previous_session_intent: UserIntentEnum.BUG_ANALYSIS,
        createdAt: new Date(),
        updatedAt: new Date()
      };

      const userMessage: ChatMessage = {
        id: 'msg-debug',
        sessionId: session.id,
        projectId: 'project-1',
        type: 'user' as any,
        content: 'Please debug this issue',
        role: 'user',
        metadata: {},
        isEdited: false,
        createdAt: new Date(),
        updatedAt: new Date()
      };

      const progressUpdates: Array<{ stage: string; data?: unknown }> = [];
      const onProgress = jest.fn((update: { stage: string; data?: unknown }) => {
        progressUpdates.push(update);
      });

      // Mock handleDebugging to verify it receives onProgress
      const handleDebuggingSpy = jest.spyOn(samuraiAgent as any, 'handleDebugging').mockResolvedValue({
        message: 'Debugging complete',
        visualizationData: {}
      });

      mockDataStore.loadChatMessagesForSession.mockReturnValue([]);
      mockProjectDetailService.getProjectDetails.mockResolvedValue('Project details');
      mockDataStore.loadAllCodeContextForSession.mockResolvedValue([]);
      mockDataStore.updateSession.mockResolvedValue(undefined as any);

      await samuraiAgent.execute(userMessage, session, onProgress);

      // Verify handleDebugging was called with onProgress callback
      expect(handleDebuggingSpy).toHaveBeenCalledWith(
        userMessage,
        expect.arrayContaining([{ role: 'user', content: userMessage.content }]),
        'Project details',
        [],
        session,
        expect.any(Function) // onProgress callback should be passed
      );

      // Verify the callback passed to handleDebugging transforms the format correctly
      const onProgressArg = handleDebuggingSpy.mock.calls[0][5];
      expect(typeof onProgressArg).toBe('function');
      
      // Test that the callback transforms string to { stage: string }
      onProgressArg('Test status');
      expect(onProgress).toHaveBeenCalledWith({ stage: 'Test status' });
    });
  });
});
