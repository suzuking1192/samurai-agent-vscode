const EXAMPLE_MARKER = 'EXAMPLE:';

function stripCodeFence(text: string): string {
  if (!text.trimStart().startsWith('```')) {
    return text;
  }

  // Remove leading fence with optional language tag
  let cleaned = text.replace(/^```[a-zA-Z0-9_-]*\s*\n?/, '');
  // Remove trailing fence
  cleaned = cleaned.replace(/```[\s]*$/, '').trim();
  return cleaned;
}

/**
 * Extracts a JSON example embedded in a schema description.
 * Looks for the first occurrence of "EXAMPLE:" and attempts to parse
 * the following JSON block. Returns null if no parseable example is found.
 */
export function extractExampleFromDescription(description?: string): any | null {
  if (!description) return null;

  const markerIndex = description.indexOf(EXAMPLE_MARKER);
  if (markerIndex === -1) return null;

  let exampleText = description.slice(markerIndex + EXAMPLE_MARKER.length).trim();
  if (!exampleText) return null;

  exampleText = stripCodeFence(exampleText);

  // If additional prose exists around the JSON, attempt to isolate the first {...} block
  const firstBrace = exampleText.indexOf('{');
  const lastBrace = exampleText.lastIndexOf('}');
  if (firstBrace !== -1 && lastBrace !== -1 && lastBrace > firstBrace) {
    exampleText = exampleText.slice(firstBrace, lastBrace + 1).trim();
  }

  try {
    return JSON.parse(exampleText);
  } catch {
    return null;
  }
}

/**
 * Formats an example object for display in prompts.
 */
export function formatExampleForPrompt(example: any): string {
  return JSON.stringify(example, null, 2);
}






