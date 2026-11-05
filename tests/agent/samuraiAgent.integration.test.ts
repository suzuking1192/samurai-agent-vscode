/**
 * Integration tests for SamuraiAgent
 * Tests the end-to-end flow of the SamuraiAgent execution
 */

import { SamuraiAgent } from '../../src/agent/core/samuraiAgent';
import { LLMProviderService } from '../../src/agent/llm/llmProviderService';
import { DataStore } from '../../src/persistence/dataStore';
import { ProjectDetailService } from '../../src/agent/memory/projectDetailService';
import { ExtractCodeTool } from '../../src/agent/tools/extractCodeTool';

// Mock dependencies
jest.mock('../../src/agent/llm/llmProviderService');
jest.mock('../../src/persistence/dataStore');
jest.mock('../../src/agent/memory/projectDetailService');
jest.mock('../../src/agent/tools/extractCodeTool');

describe('SamuraiAgent Integration Tests', () => {
  let samuraiAgent: SamuraiAgent;
  let mockLLMProviderService: jest.Mocked<LLMProviderService>;
  let mockDataStore: jest.Mocked<DataStore>;
  let mockProjectDetailService: jest.Mocked<ProjectDetailService>;
  let mockExtractCodeTool: jest.Mocked<ExtractCodeTool>;
  let mockProjectTechStackService: any;

  beforeEach(() => {
    // Create mock instances
    mockLLMProviderService = new LLMProviderService({} as any, {} as any) as jest.Mocked<LLMProviderService>;
    mockDataStore = new DataStore('/test/path') as jest.Mocked<DataStore>;
    mockProjectDetailService = new ProjectDetailService({} as any, {} as any, '') as jest.Mocked<ProjectDetailService>;
    mockExtractCodeTool = new ExtractCodeTool({} as any, {} as any) as jest.Mocked<ExtractCodeTool>;
    mockProjectTechStackService = {
      ensureTechStack: jest.fn(),
      getStoredTechStack: jest.fn(),
    };

    // Create SamuraiAgent instance
    samuraiAgent = new SamuraiAgent(
      mockLLMProviderService,
      mockDataStore,
      mockProjectDetailService,
      mockExtractCodeTool,
      mockProjectTechStackService
    );
  });

  // All planning-related tests have been removed
});