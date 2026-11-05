import * as fs from 'fs';
import * as path from 'path';
import { GlobalDataStore } from '../../persistence/globalDataStore';
import { ResponseType } from '../../common/models/response-models';
import { LlmEntry } from '../../common/models/settings-models';
import { getKey } from '../../common/utils/llmSecretStore';

// Use require for ESM module compatibility with webpack
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { GoogleGenAI } = require('@google/genai');

const IMAGE_MODEL = 'gemini-3-pro-image-preview';

/**
 * Service for generating concept diagrams using the Gemini image API.
 * Uses the user's own Google API key (BYOK) from SecretStorage.
 */
export class ImageGenerationService {
  constructor(
    private globalDataStore: GlobalDataStore,
    private workspaceRoot: string
  ) {}

  /**
   * Generates an image using Gemini and saves it to the active session folder.
   * @param sessionId - The session ID for naming the file
   * @param visualPrompt - The visual description prompt for image generation
   * @param _userSelectedModelId - Unused; kept for caller compatibility (cost tracking is done by the controller)
   * @returns The relative path to the saved image, or null on failure
   */
  async generateAndSave(sessionId: string, visualPrompt: string, _userSelectedModelId?: string): Promise<string | null> {
    try {
      const apiKey = await this.resolveGoogleApiKey();
      if (!apiKey) {
        console.error('[ImageGen] No Google (Gemini) model with an API key is configured');
        return null;
      }

      const base64Data = await this.generateImage(apiKey, visualPrompt);
      return this.saveImage(sessionId, base64Data);
    } catch (e) {
      console.error('[ImageGen] Failed:', e);
      return null;
    }
  }

  /** Prefers the active entry when it is a Google entry, otherwise the first Google entry with a key. */
  private async resolveGoogleApiKey(): Promise<string | undefined> {
    const response = this.globalDataStore.loadGlobalSettings();
    if (response.type !== ResponseType.SUCCESS || !response.payload) {
      console.error('[ImageGen] Failed to load global settings');
      return undefined;
    }
    const { llmEntries = [], activeLlmEntryId } = response.payload;
    const googleEntries = llmEntries.filter((entry: LlmEntry) => entry.provider === 'google');
    googleEntries.sort((a: LlmEntry) => (a.id === activeLlmEntryId ? -1 : 1));
    for (const entry of googleEntries) {
      const key = (await getKey(entry.id))?.trim();
      if (key) {
        return key;
      }
    }
    return undefined;
  }

  private async generateImage(apiKey: string, visualPrompt: string): Promise<string> {
    console.log(`[ImageGen] Calling ${IMAGE_MODEL}...`);
    const genAI = new GoogleGenAI({ apiKey });
    const response = await genAI.models.generateContent({
      model: IMAGE_MODEL,
      contents: visualPrompt,
      config: { imageConfig: { aspectRatio: '16:9', imageSize: '2K' } }
    });
    return this.extractImageData(response);
  }

  /** Saves to the session folder so it gets wiped automatically next time. */
  private saveImage(sessionId: string, base64Data: string): string {
    const relativePath = `debug-output/active-session/concept-${sessionId}.png`;
    const fullPath = path.join(this.workspaceRoot, relativePath);
    fs.mkdirSync(path.dirname(fullPath), { recursive: true });
    fs.writeFileSync(fullPath, base64Data, 'base64');
    console.log('[ImageGen] Image saved to:', fullPath);
    return relativePath;
  }

  /** Extracts base64 image data from response.candidates[0].content.parts[*].inlineData.data */
  private extractImageData(response: any): string {
    const candidates = response?.candidates;
    if (!candidates || candidates.length === 0) {
      throw new Error('No image generated - no candidates in response');
    }

    const parts = candidates[0]?.content?.parts || [];
    const imagePart = parts.find((p: any) => p.inlineData);
    if (!imagePart || !imagePart.inlineData) {
      throw new Error('No inline image data found in response');
    }

    const base64Data = imagePart.inlineData.data;
    if (!base64Data) {
      throw new Error('Image data is empty');
    }

    return base64Data;
  }
}
