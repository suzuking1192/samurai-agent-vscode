/**
 * Visualization LLM Fixer (Optional - Not in Core Path)
 * 
 * For debugging/internal tools only. Do not call from VisualizationService in production.
 * 
 * This module contains LLM-based mermaid beautification and fixing utilities
 * that were removed from the core visualization path for beta readiness.
 * 
 * Usage: Only for CLI tools, debugging utilities, or offline fixing scripts.
 */

import { LLMProviderService } from '../../llm/llmProviderService';
import { ExecutionGraph } from './VisualizationService';
import { GraphNode } from './types';
import { ResponseType } from '../../../common/models/response-models';

/**
 * Optional LLM beautification for layout hints only
 * 
 * NOTE: This is NOT called from VisualizationService.generateVisualization
 * in production. Use only for debugging or offline tools.
 */
export async function beautifyWithLLM(
  llmProvider: LLMProviderService,
  mermaid: string,
  graph: ExecutionGraph,
  suspects: Set<string>,
  mode: string,
  model: string
): Promise<string | null> {
  try {
    const prompt = buildBeautificationPrompt(mermaid, graph, suspects, mode);
    
    const response = await llmProvider.chat({
      id: `viz-beautify-${Date.now()}`,
      provider: '',
      model,
      messages: [
        {
          role: 'system',
          content: 'You are a Mermaid diagram layout expert. Return only JSON with subgraph groupings and classDefs. Never add or remove nodes/edges.'
        },
        {
          role: 'user',
          content: prompt
        }
      ],
      temperature: 0.1,
      maxTokens: 1000,
      metadata: {},
      createdAt: new Date(),
      updatedAt: new Date()
    });
    
    if (response.type !== ResponseType.SUCCESS) {
      throw new Error(`LLM request failed for beautification: ${response.error || 'Unknown error'}`);
    }
    
    if (!response.payload) {
      throw new Error('LLM request failed for beautification: No payload in response');
    }
    
    const content = (response.payload as any).content?.trim() || '';
    if (!content) {
      throw new Error('LLM request failed for beautification: Empty content in response');
    }
    
    const beautification = JSON.parse(content);
    
    if (!beautification.subgraphs && !beautification.classDefs) {
      return null;
    }
    
    return applyBeautification(mermaid, beautification);
    
  } catch (error) {
    console.warn('[VisualizationLLMFixer] LLM beautification failed:', error);
    return null;
  }
}

/**
 * Fix mermaid diagram using LLM based on validation errors
 * 
 * NOTE: This is NOT called from VisualizationService.generateVisualization
 * in production. Use only for debugging or offline tools.
 */
export async function fixMermaidWithLLM(
  llmProvider: LLMProviderService,
  mermaid: string,
  validationErrors: string[],
  iteration: number,
  model: string
): Promise<string> {
  try {
    const prompt = buildMermaidFixPrompt(mermaid, validationErrors, iteration);
    
    const response = await llmProvider.chat({
      id: `mermaid-fix-${Date.now()}`,
      provider: '',
      model,
      messages: [
        {
          role: 'system',
          content: 'You are a Mermaid diagram expert. Fix syntax errors and return only the corrected Mermaid code.'
        },
        {
          role: 'user',
          content: prompt
        }
      ],
      temperature: 0.1,
      maxTokens: 2000,
      metadata: {},
      createdAt: new Date(),
      updatedAt: new Date()
    });
    
    if (response.type !== ResponseType.SUCCESS) {
      throw new Error(`LLM request failed for mermaid fix: ${response.error || 'Unknown error'}`);
    }
    
    if (!response.payload) {
      throw new Error('LLM request failed for mermaid fix: No payload in response');
    }
    
    const fixedMermaid = (response.payload as any).content?.trim() || '';
    
    if (!fixedMermaid) {
      throw new Error('LLM request failed for mermaid fix: Empty content in response');
    }
    
    // Extract mermaid from code blocks if present
    const codeBlockMatch = fixedMermaid.match(/```(?:mermaid)?\s*([\s\S]*?)\s*```/);
    if (codeBlockMatch) {
      return codeBlockMatch[1].trim();
    }
    
    return fixedMermaid;
    
  } catch (error) {
    console.warn('[VisualizationLLMFixer] LLM mermaid fix failed:', error);
    throw error;
  }
}

function buildBeautificationPrompt(
  mermaid: string,
  graph: ExecutionGraph,
  suspects: Set<string>,
  mode: string
): string {
  return `Analyze this Mermaid flowchart and suggest layout improvements.

Current Mermaid:
\`\`\`
${mermaid}
\`\`\`

Graph metadata:
- Nodes: ${graph.nodes.length} total
- Suspects: ${Array.from(suspects).join(', ')}
- Mode: ${mode}

Return JSON with:
{
  "subgraphs": [
    {"id": "api", "nodeIds": ["node1", "node2"], "label": "API Layer"},
    {"id": "data", "nodeIds": ["node3", "node4"], "label": "Data Layer"}
  ],
  "classDefs": [
    {"name": "error", "style": "fill:#ff6b6b,stroke:#b30000"}
  ]
}

Rules:
- Only suggest subgraph groupings and classDefs
- Never add or remove nodes/edges
- Use existing node IDs exactly as they appear
- Group related nodes by directory or function type`;
}

function buildMermaidFixPrompt(mermaid: string, validationErrors: string[], iteration: number): string {
  return `Fix this Mermaid diagram. This is attempt ${iteration + 1} of 3.

Original Mermaid:
\`\`\`
${mermaid}
\`\`\`

Validation Errors:
${validationErrors.map(error => `- ${error}`).join('\n')}

Instructions:
1. Fix the syntax errors listed above
2. Keep the same graph structure and node relationships
3. Only modify what's necessary to fix the errors
4. Return only the corrected Mermaid code
5. Ensure all node IDs are unique and properly quoted
6. Use proper Mermaid syntax for edges and labels

Return the fixed Mermaid code:`;
}

function applyBeautification(mermaid: string, beautification: any): string {
  const lines = mermaid.split('\n');
  const result: string[] = [];
  
  // Add subgraphs if provided
  if (beautification.subgraphs) {
    for (const subgraph of beautification.subgraphs) {
      result.push(`subgraph ${subgraph.id}["${subgraph.label}"]`);
      for (const nodeId of subgraph.nodeIds) {
        const nodeLine = lines.find(line => line.startsWith(`${nodeId}[`));
        if (nodeLine) {
          result.push(`  ${nodeLine}`);
        }
      }
      result.push('end');
    }
  }
  
  // Add classDefs if provided
  if (beautification.classDefs) {
    for (const classDef of beautification.classDefs) {
      result.push(`classDef ${classDef.name} ${classDef.style}`);
    }
  }
  
  // Add remaining lines (nodes, edges, styles)
  for (const line of lines) {
    if (!line.startsWith('flowchart') && !beautification.subgraphs?.some((sg: any) => 
      sg.nodeIds.some((id: string) => line.startsWith(`${id}[`)))) {
      result.push(line);
    }
  }
  
  return result.join('\n');
}

