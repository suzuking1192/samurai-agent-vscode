/**
 * Mermaid Sanitizer for Debugging Flow
 * 
 * Applies deterministic fixes to common Mermaid syntax issues without LLM
 */

export interface SanitizationResult {
  mermaid: string;
  fixes: string[];
  diff: string;
}

/**
 * Sanitize Mermaid diagram with deterministic fixes
 */
export function sanitizeMermaid(mermaid: string): SanitizationResult {
  const fixes: string[] = [];
  let result = mermaid.trim();
  
  // Track original for diff
  const original = result;
  
  // Fix 0: Handle empty graph
  if (!result || result.trim() === '' || result.trim() === 'flowchart TD' || result.trim() === 'graph TD') {
    result = 'flowchart TD\nA["No execution data"]';
    fixes.push('Generated minimal stub for empty graph');
    return {
      mermaid: result,
      fixes,
      diff: generateDiff(original, result),
    };
  }
  
  // Fix 1: Fix node IDs starting with numbers
  result = fixNodeIdsStartingWithNumbers(result, fixes);
  
  // Fix 2: Add missing graph direction
  if (!result.trim().startsWith('flowchart') && !result.trim().startsWith('graph')) {
    result = 'flowchart TD\n' + result;
    fixes.push('Added missing graph direction');
  }
  
  // Fix 3: Fix unquoted text with colons and labels with | or :
  result = fixUnquotedColons(result, fixes);
  result = fixLabelsWithSpecialChars(result, fixes);
  
  // Fix 4: Fix duplicate node IDs
  result = fixDuplicateIds(result, fixes);
  
  // Fix 5: Fix mismatched quotes in edge labels
  result = fixMismatchedQuotes(result, fixes);
  
  // Fix 6: Fix invalid node syntax
  result = fixInvalidNodeSyntax(result, fixes);
  
  // Fix 7: Fix edge syntax issues
  result = fixEdgeSyntax(result, fixes);
  
  // Fix 8: Fix self-loops (keep if valid, else drop)
  result = fixSelfLoops(result, fixes);
  
  // Fix 9: Clean up extra whitespace
  result = cleanupWhitespace(result, fixes);
  
  // Generate diff
  const diff = generateDiff(original, result);
  
  return {
    mermaid: result,
    fixes,
    diff,
  };
}

/**
 * Fix node IDs starting with numbers (prefix with _)
 */
function fixNodeIdsStartingWithNumbers(mermaid: string, fixes: string[]): string {
  const lines = mermaid.split('\n');
  const fixed: string[] = [];
  const idMap = new Map<string, string>();
  
  for (const line of lines) {
    // Look for node definitions with IDs starting with numbers
    const nodeMatch = line.match(/^(\s*)(\w+)\[/);
    if (nodeMatch) {
      const [, indent, nodeId] = nodeMatch;
      
      if (/^\d/.test(nodeId)) {
        const newId = '_' + nodeId;
        idMap.set(nodeId, newId);
        const fixedLine = line.replace(new RegExp(`^${indent}${nodeId}\\[`), `${indent}${newId}[`);
        fixed.push(fixedLine);
        fixes.push(`Fixed node ID starting with number: ${nodeId} → ${newId}`);
      } else {
        fixed.push(line);
      }
    } else {
      fixed.push(line);
    }
  }
  
  // Update all references to renamed node IDs (in edges)
  if (idMap.size > 0) {
    for (let i = 0; i < fixed.length; i++) {
      let line = fixed[i];
      for (const [oldId, newId] of idMap.entries()) {
        // Replace in edge definitions: nodeId --> or nodeId |label| etc.
        line = line.replace(new RegExp(`\\b${oldId}\\b`, 'g'), newId);
      }
      fixed[i] = line;
    }
  }
  
  return fixed.join('\n');
}

/**
 * Fix labels containing | or : by escaping/quoting
 */
function fixLabelsWithSpecialChars(mermaid: string, fixes: string[]): string {
  const lines = mermaid.split('\n');
  const fixed: string[] = [];
  
  for (const line of lines) {
    // Look for node definitions with labels containing | or :
    const nodeMatch = line.match(/^(\s*)(\w+)\[([^\]]*)\]/);
    if (nodeMatch) {
      const [, indent, nodeId, content] = nodeMatch;
      
      // Check if content has | or : and is not already quoted
      if ((content.includes('|') || content.includes(':')) && !content.startsWith('"') && !content.endsWith('"')) {
        const fixedContent = `"${content.replace(/"/g, '\\"')}"`;
        fixed.push(`${indent}${nodeId}[${fixedContent}]`);
        fixes.push(`Fixed label with special chars in node ${nodeId}`);
      } else {
        fixed.push(line);
      }
    } else {
      fixed.push(line);
    }
  }
  
  return fixed.join('\n');
}

/**
 * Fix self-loops - keep if valid, else drop
 */
function fixSelfLoops(mermaid: string, fixes: string[]): string {
  const lines = mermaid.split('\n');
  const fixed: string[] = [];
  
  for (const line of lines) {
    // Look for self-loops: node --> node or node -->|label| node
    const selfLoopMatch = line.match(/^(\s*)(\w+)\s*([-.]*)\|?([^|]*)\|?\s*\1/);
    if (selfLoopMatch) {
      // Check if it's a valid self-loop syntax (node --> node is valid)
      const fromNode = selfLoopMatch[2];
      // Self-loops are valid in Mermaid, so keep them
      fixed.push(line);
    } else {
      fixed.push(line);
    }
  }
  
  return fixed.join('\n');
}

/**
 * Fix unquoted text that contains colons
 */
function fixUnquotedColons(mermaid: string, fixes: string[]): string {
  const lines = mermaid.split('\n');
  const fixed: string[] = [];
  
  for (const line of lines) {
    // Look for node definitions with unquoted text containing colons
    const nodeMatch = line.match(/^(\s*)(\w+)\[([^\]]*)\]/);
    if (nodeMatch) {
      const [, indent, nodeId, content] = nodeMatch;
      
      // Check if content has colons and is not already quoted
      if (content.includes(':') && !content.startsWith('"') && !content.endsWith('"')) {
        const fixedContent = `"${content}"`;
        fixed.push(`${indent}${nodeId}[${fixedContent}]`);
        fixes.push(`Fixed unquoted colon in node ${nodeId}`);
      } else {
        fixed.push(line);
      }
    } else {
      fixed.push(line);
    }
  }
  
  return fixed.join('\n');
}

/**
 * Fix duplicate node IDs by adding suffixes
 */
function fixDuplicateIds(mermaid: string, fixes: string[]): string {
  const lines = mermaid.split('\n');
  const nodeIds = new Map<string, number>();
  const fixed: string[] = [];
  
  for (const line of lines) {
    // Look for node definitions
    const nodeMatch = line.match(/^(\s*)(\w+)\[/);
    if (nodeMatch) {
      const [, indent, nodeId] = nodeMatch;
      
      if (nodeIds.has(nodeId)) {
        const count = nodeIds.get(nodeId)! + 1;
        nodeIds.set(nodeId, count);
        
        const newId = `${nodeId}_${count}`;
        const fixedLine = line.replace(new RegExp(`^${indent}${nodeId}\\[`), `${indent}${newId}[`);
        fixed.push(fixedLine);
        fixes.push(`Fixed duplicate ID: ${nodeId} → ${newId}`);
      } else {
        nodeIds.set(nodeId, 1);
        fixed.push(line);
      }
    } else {
      fixed.push(line);
    }
  }
  
  return fixed.join('\n');
}

/**
 * Fix mismatched quotes in edge labels
 */
function fixMismatchedQuotes(mermaid: string, fixes: string[]): string {
  const lines = mermaid.split('\n');
  const fixed: string[] = [];
  
  for (const line of lines) {
    // Look for edge definitions with labels
    const edgeMatch = line.match(/^(\s*)(\w+)\s*([-.]*)\|([^|]*)\|\s*(\w+)/);
    if (edgeMatch) {
      const [, indent, from, arrows, label, to] = edgeMatch;
      
      // Check for mismatched quotes in label
      if (label && label.includes('"')) {
        const quoteCount = (label.match(/"/g) || []).length;
        if (quoteCount % 2 !== 0) {
          // Odd number of quotes - try to fix
          let fixedLabel = label;
          
          if (label.startsWith('"') && !label.endsWith('"')) {
            fixedLabel = label + '"';
          } else if (!label.startsWith('"') && label.endsWith('"')) {
            fixedLabel = '"' + label;
          } else {
            // Remove all quotes and re-add them
            fixedLabel = '"' + label.replace(/"/g, '') + '"';
          }
          
          const fixedLine = `${indent}${from} ${arrows}|${fixedLabel}| ${to}`;
          fixed.push(fixedLine);
          fixes.push(`Fixed mismatched quotes in edge label`);
        } else {
          fixed.push(line);
        }
      } else {
        fixed.push(line);
      }
    } else {
      fixed.push(line);
    }
  }
  
  return fixed.join('\n');
}

/**
 * Fix invalid node syntax
 */
function fixInvalidNodeSyntax(mermaid: string, fixes: string[]): string {
  const lines = mermaid.split('\n');
  const fixed: string[] = [];
  
  for (const line of lines) {
    // Look for malformed node definitions
    const malformedMatch = line.match(/^(\s*)(\w+)\[([^\]]*)$/);
    if (malformedMatch) {
      const [, indent, nodeId, content] = malformedMatch;
      
      // Add missing closing bracket
      const fixedLine = `${indent}${nodeId}[${content}]`;
      fixed.push(fixedLine);
      fixes.push(`Fixed malformed node syntax for ${nodeId}`);
    } else {
      fixed.push(line);
    }
  }
  
  return fixed.join('\n');
}

/**
 * Fix edge syntax issues
 */
function fixEdgeSyntax(mermaid: string, fixes: string[]): string {
  const lines = mermaid.split('\n');
  const fixed: string[] = [];
  
  for (const line of lines) {
    // Look for malformed edge definitions
    const malformedEdgeMatch = line.match(/^(\s*)(\w+)\s*([-.]*)\s*(\w+)$/);
    if (malformedEdgeMatch) {
      const [, indent, from, arrows, to] = malformedEdgeMatch;
      
      // Ensure proper edge syntax
      const fixedLine = `${indent}${from} ${arrows} ${to}`;
      fixed.push(fixedLine);
      fixes.push(`Fixed malformed edge syntax`);
    } else {
      fixed.push(line);
    }
  }
  
  return fixed.join('\n');
}

/**
 * Clean up extra whitespace
 */
function cleanupWhitespace(mermaid: string, fixes: string[]): string {
  const lines = mermaid.split('\n');
  const fixed: string[] = [];
  
  for (const line of lines) {
    // Remove trailing whitespace
    const trimmed = line.trimEnd();
    
    // Skip empty lines at the beginning
    if (trimmed === '' && fixed.length === 0) {
      continue;
    }
    
    fixed.push(trimmed);
  }
  
  // Remove trailing empty lines
  while (fixed.length > 0 && fixed[fixed.length - 1] === '') {
    fixed.pop();
  }
  
  if (fixed.length !== lines.length) {
    fixes.push('Cleaned up whitespace');
  }
  
  return fixed.join('\n');
}

/**
 * Generate a simple diff between original and fixed mermaid
 */
function generateDiff(original: string, fixed: string): string {
  const originalLines = original.split('\n');
  const fixedLines = fixed.split('\n');
  
  const diff: string[] = [];
  
  // Simple line-by-line diff
  const maxLines = Math.max(originalLines.length, fixedLines.length);
  
  for (let i = 0; i < maxLines; i++) {
    const originalLine = originalLines[i] || '';
    const fixedLine = fixedLines[i] || '';
    
    if (originalLine !== fixedLine) {
      if (originalLine) {
        diff.push(`- ${originalLine}`);
      }
      if (fixedLine) {
        diff.push(`+ ${fixedLine}`);
      }
    }
  }
  
  return diff.join('\n');
}

/**
 * Check if mermaid needs sanitization
 */
export function needsSanitization(mermaid: string): boolean {
  // Quick checks for common issues
  const hasUnquotedColons = /^\s*\w+\[[^"]*:.*[^"]*\]/.test(mermaid);
  const hasDuplicateIds = /(\w+)\[.*\].*\1\[/.test(mermaid);
  const hasMismatchedQuotes = /"[^"]*"[^"]*"/.test(mermaid);
  const hasMalformedNodes = /^\s*\w+\[[^\]]*$/.test(mermaid);
  
  return hasUnquotedColons || hasDuplicateIds || hasMismatchedQuotes || hasMalformedNodes;
}

/**
 * Get a minimal deterministic graph as fallback
 */
export function createMinimalDeterministicGraph(
  nodes: Array<{ id: string; label: string }>,
  edges: Array<{ from: string; to: string }>
): string {
  const lines: string[] = ['flowchart TD'];
  
  // Add nodes with simple labels
  for (const node of nodes.slice(0, 10)) { // Limit to 10 nodes
    const safeLabel = node.label.replace(/[`|{}]/g, '').slice(0, 30);
    lines.push(`${node.id}["${safeLabel}"]`);
  }
  
  // Add edges
  for (const edge of edges.slice(0, 15)) { // Limit to 15 edges
    lines.push(`${edge.from} --> ${edge.to}`);
  }
  
  return lines.join('\n');
}









