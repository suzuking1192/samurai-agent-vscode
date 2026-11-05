/**
 * Tests for ImageGenerationService (BYOK: uses the user's Google key from SecretStorage)
 */

import { ImageGenerationService } from '../ImageGenerationService';
import { GlobalDataStore } from '../../../persistence/globalDataStore';
import { ResponseType } from '../../../common/models/response-models';
import { getKey } from '../../../common/utils/llmSecretStore';

jest.mock('fs', () => ({
  existsSync: jest.fn().mockReturnValue(true),
  mkdirSync: jest.fn(),
  writeFileSync: jest.fn()
}));

jest.mock('@google/genai', () => ({
  GoogleGenAI: jest.fn()
}));

jest.mock('../../../common/utils/llmSecretStore', () => ({
  getKey: jest.fn()
}));

const imageResponse = (data = 'base64-image-data') => ({
  candidates: [{ content: { parts: [{ inlineData: { mimeType: 'image/png', data } }] } }]
});

describe('ImageGenerationService', () => {
  const workspaceRoot = '/test/workspace';
  const googleEntry = { id: 'g1', provider: 'google', modelName: 'my-gemini' };
  const otherGoogleEntry = { id: 'g2', provider: 'google', modelName: 'other-gemini' };
  const openaiEntry = { id: 'o1', provider: 'openai', modelName: 'my-gpt' };

  let generateContent: jest.Mock;
  let settings: any;
  let service: ImageGenerationService;
  const mockGetKey = getKey as jest.Mock;
  const mockFs = require('fs');
  const { GoogleGenAI } = require('@google/genai');

  beforeEach(() => {
    jest.clearAllMocks();
    generateContent = jest.fn().mockResolvedValue(imageResponse());
    GoogleGenAI.mockImplementation(() => ({ models: { generateContent } }));
    settings = { llmEntries: [openaiEntry, googleEntry], activeLlmEntryId: 'o1' };
    mockGetKey.mockImplementation(async (id: string) => (id === 'g1' ? 'google-key' : undefined));
    const store = {
      loadGlobalSettings: jest.fn(() => ({ type: ResponseType.SUCCESS, payload: settings }))
    } as unknown as GlobalDataStore;
    service = new ImageGenerationService(store, workspaceRoot);
  });

  it('generates and saves an image using the stored Google key', async () => {
    const result = await service.generateAndSave('session-1', 'a diagram');

    expect(result).toBe('debug-output/active-session/concept-session-1.png');
    expect(GoogleGenAI).toHaveBeenCalledWith({ apiKey: 'google-key' });
    expect(generateContent).toHaveBeenCalledWith(expect.objectContaining({
      model: 'gemini-3-pro-image-preview',
      contents: 'a diagram'
    }));
    expect(mockFs.writeFileSync).toHaveBeenCalledWith(
      expect.stringContaining('concept-session-1.png'),
      'base64-image-data',
      'base64'
    );
  });

  it('prefers the active Google entry over other Google entries', async () => {
    settings = { llmEntries: [googleEntry, otherGoogleEntry], activeLlmEntryId: 'g2' };
    mockGetKey.mockImplementation(async (id: string) => `key-${id}`);

    await service.generateAndSave('session-1', 'a diagram');

    expect(GoogleGenAI).toHaveBeenCalledWith({ apiKey: 'key-g2' });
  });

  it('returns null when no Google entry has a key', async () => {
    mockGetKey.mockResolvedValue(undefined);

    expect(await service.generateAndSave('session-1', 'a diagram')).toBeNull();
    expect(GoogleGenAI).not.toHaveBeenCalled();
  });

  it('returns null when there are no Google entries', async () => {
    settings = { llmEntries: [openaiEntry], activeLlmEntryId: 'o1' };

    expect(await service.generateAndSave('session-1', 'a diagram')).toBeNull();
  });

  it('returns null when global settings cannot be loaded', async () => {
    const failing = { loadGlobalSettings: jest.fn(() => ({ type: ResponseType.ERROR })) } as unknown as GlobalDataStore;

    expect(await new ImageGenerationService(failing, workspaceRoot).generateAndSave('s', 'p')).toBeNull();
  });

  it('returns null when the API call fails', async () => {
    generateContent.mockRejectedValue(new Error('API error'));

    expect(await service.generateAndSave('session-1', 'a diagram')).toBeNull();
  });

  it('returns null when the response has no candidates or no inline data', async () => {
    generateContent.mockResolvedValueOnce({ candidates: [] });
    expect(await service.generateAndSave('session-1', 'p')).toBeNull();

    generateContent.mockResolvedValueOnce({ candidates: [{ content: { parts: [{ text: 'no image' }] } }] });
    expect(await service.generateAndSave('session-1', 'p')).toBeNull();
  });
});
