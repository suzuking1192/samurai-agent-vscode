import * as fs from 'fs';
import * as path from 'path';

/**
 * Load a prompt file from the debugging prompts directory.
 * Tries multiple candidate paths to handle both development and packaged extension scenarios.
 * 
 * @param fileName - The name of the prompt file (e.g., 'search_plan.md')
 * @returns The content of the prompt file
 * @throws Error if the file cannot be found in any candidate location
 */
export function loadDebuggingPrompt(fileName: string): string {
  const candidates = [
    // In packaged extensions, __dirname points to the dist directory
    // Check the extension's dist/prompts directory first (for packaged extensions)
    path.join(__dirname, 'prompts', 'debugging', fileName),
    
    // Check extension's out/prompts directory (for development)
    path.join(__dirname, '..', '..', '..', 'out', 'prompts', 'debugging', fileName),
    
    // Check extension's src/agent/prompts directory (for development)
    path.join(__dirname, '..', '..', '..', 'src', 'agent', 'prompts', 'debugging', fileName),
    
    // Legacy fallback paths
    path.join(__dirname, '..', '..', 'prompts', 'debugging', fileName),
    path.join(__dirname, '..', 'prompts', 'debugging', fileName),
  ];

  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) {
      console.log(`PromptLoader: Found prompt file at: ${candidate}`);
      return fs.readFileSync(candidate, 'utf-8');
    }
  }

  console.error(`PromptLoader: Prompt file not found for ${fileName}`);
  console.error(`__dirname: ${__dirname}`);
  console.error(`Checked paths:`, candidates);
  throw new Error(
    `Prompt file not found for ${fileName}. Checked paths: ${candidates.join(', ')}`
  );
}

export function loadFrameworkPrompt(frameworkId: string): string | undefined {
  const relativePath = path.join('frameworks', `${frameworkId}.md`);
  try {
    return loadDebuggingPrompt(relativePath);
  } catch (error) {
    console.warn(
      `[PromptLoader] Framework prompt not found for ${frameworkId}:`,
      error instanceof Error ? error.message : error,
    );
    return undefined;
  }
}













