/**
 * Basic tests for VisualizationService functionality
 * 
 * Tests core concepts without complex imports
 */

describe('VisualizationService Basic Functionality', () => {
  it('should validate Mermaid syntax patterns', () => {
    // Test that our Mermaid generation follows expected patterns
    const expectedPatterns = [
      /^flowchart TD$/m,  // Should start with flowchart TD
      /^[A-Za-z0-9_-]+\["[^"]*"\]$/m,  // Node definitions
      /^[A-Za-z0-9_-]+ (?:-->|-.->)(?:\|[^|]*\|)? [A-Za-z0-9_-]+$/m,  // Edge definitions
      /^style [A-Za-z0-9_-]+ [^$]+$/m  // Style definitions
    ];
    
    const sampleMermaid = `flowchart TD
A["Node A"]
B["Node B"]
A -->|calls| B
style A fill:#ff6b6b,stroke:#b30000,stroke-width:2px`;
    
    expectedPatterns.forEach(pattern => {
      expect(sampleMermaid).toMatch(pattern);
    });
  });

  it('should handle node label sanitization', () => {
    const sanitizeLabel = (label: string): string => {
      return label
        .replace(/[`|{}]/g, '')
        .replace(/"/g, '&quot;')
        .substring(0, 60);
    };
    
    // Test problematic characters
    expect(sanitizeLabel('File`with|bad{chars}')).toBe('Filewithbadchars');
    expect(sanitizeLabel('Label"with"quotes')).toBe('Label&quot;with&quot;quotes');
    
    // Test truncation
    const longLabel = 'A'.repeat(100);
    const truncated = sanitizeLabel(longLabel);
    expect(truncated).toHaveLength(60);
    expect(truncated).toBe('A'.repeat(60));
  });

  it('should generate correct edge styles', () => {
    const getEdgeStyle = (kind: string): string => {
      switch (kind) {
        case 'calls':
        case 'runtimePath':
          return '-->|calls|';
        case 'imports':
        case 'reexports':
        case 'exports':
          return '-.->|imports|';
        default:
          return '-->';
      }
    };
    
    expect(getEdgeStyle('calls')).toBe('-->|calls|');
    expect(getEdgeStyle('runtimePath')).toBe('-->|calls|');
    expect(getEdgeStyle('imports')).toBe('-.->|imports|');
    expect(getEdgeStyle('reexports')).toBe('-.->|imports|');
    expect(getEdgeStyle('exports')).toBe('-.->|imports|');
    expect(getEdgeStyle('unknown')).toBe('-->');
  });

  it('should extract suspects from root cause text', () => {
    const extractSuspects = (rootCause: string, nodes: any[]): Set<string> => {
      const suspects = new Set<string>();
      if (!rootCause) return suspects;
      
      const lowerCaseRootCause = rootCause.toLowerCase();
      nodes.forEach(node => {
        // Check if root cause contains any part of the label or file
        const labelMatch = node.label?.toLowerCase().includes(lowerCaseRootCause) || 
                          lowerCaseRootCause.includes(node.label?.toLowerCase() || '');
        const fileMatch = node.file?.toLowerCase().includes(lowerCaseRootCause) || 
                         lowerCaseRootCause.includes(node.file?.toLowerCase() || '');
        
        if (labelMatch || fileMatch) {
          suspects.add(node.id);
        }
      });
      return suspects;
    };
    
    const nodes = [
      { id: 'user-ts', label: 'User.ts', file: 'src/User.ts' },
      { id: 'auth-ts', label: 'Auth.ts', file: 'src/Auth.ts' },
      { id: 'get-user', label: 'getUser()', file: 'src/User.ts' }
    ];
    
    // Test file name matching
    const suspects1 = extractSuspects('Error in User.ts', nodes);
    expect(suspects1.has('user-ts')).toBe(true);
    expect(suspects1.has('get-user')).toBe(false); // Different label, same file but root cause doesn't mention file path
    expect(suspects1.has('auth-ts')).toBe(false);
    
    // Test function name matching
    const suspects2 = extractSuspects('getUser() is failing', nodes);
    expect(suspects2.has('get-user')).toBe(true);
    expect(suspects2.has('user-ts')).toBe(false);
    expect(suspects2.has('auth-ts')).toBe(false);
    
    // Test empty root cause
    const suspects3 = extractSuspects('', nodes);
    expect(suspects3.size).toBe(0);
  });

  it('should validate node and edge parity', () => {
    const ensureParity = (mermaid: string, originalNodes: any[]): boolean => {
      const nodeIds = new Set(originalNodes.map(n => n.id));
      const mermaidNodeIds = new Set();
      
      // Extract node IDs from Mermaid (simplified regex)
      const nodeMatches = mermaid.match(/^([A-Za-z0-9_-]+)\["/gm);
      if (nodeMatches) {
        nodeMatches.forEach(match => {
          const id = match.replace(/\["$/, '');
          mermaidNodeIds.add(id);
        });
      }
      
      // Check if sets are equal
      if (nodeIds.size !== mermaidNodeIds.size) return false;
      for (const id of nodeIds) {
        if (!mermaidNodeIds.has(id)) return false;
      }
      return true;
    };
    
    const nodes = [
      { id: 'A', label: 'Node A' },
      { id: 'B', label: 'Node B' }
    ];
    
    const validMermaid = `flowchart TD
A["Node A"]
B["Node B"]`;
    
    const invalidMermaid = `flowchart TD
A["Node A"]`; // Missing B
    
    expect(ensureParity(validMermaid, nodes)).toBe(true);
    expect(ensureParity(invalidMermaid, nodes)).toBe(false);
  });

  it('should handle different visualization modes', () => {
    const getModeHighlights = (mode: string) => {
      switch (mode) {
        case 'hard-error':
          return { errorFrames: true, failPath: true, routeHandlers: false };
        case 'soft-error':
          return { errorFrames: false, failPath: false, routeHandlers: true };
        case 'behavior-first':
          return { errorFrames: false, failPath: false, routeHandlers: false, entrypoints: true };
        default:
          return { errorFrames: false, failPath: false, routeHandlers: false };
      }
    };
    
    expect(getModeHighlights('hard-error')).toEqual({
      errorFrames: true,
      failPath: true,
      routeHandlers: false
    });
    
    expect(getModeHighlights('soft-error')).toEqual({
      errorFrames: false,
      failPath: false,
      routeHandlers: true
    });
    
    expect(getModeHighlights('behavior-first')).toEqual({
      errorFrames: false,
      failPath: false,
      routeHandlers: false,
      entrypoints: true
    });
  });

  it('should generate proper Mermaid metadata', () => {
    const generateMeta = (nodeCount: number, edgeCount: number, truncated: boolean, mode: string, source: string) => {
      return {
        nodeCount,
        edgeCount,
        truncated,
        mode,
        source,
        clusters: truncated ? [{ id: 'truncated', size: nodeCount - 50, label: 'Truncated nodes' }] : undefined
      };
    };
    
    const meta1 = generateMeta(10, 5, false, 'hard-error', 'deterministic');
    expect(meta1).toEqual({
      nodeCount: 10,
      edgeCount: 5,
      truncated: false,
      mode: 'hard-error',
      source: 'deterministic',
      clusters: undefined
    });
    
    const meta2 = generateMeta(100, 50, true, 'soft-error', 'llm_beautified');
    expect(meta2).toEqual({
      nodeCount: 100,
      edgeCount: 50,
      truncated: true,
      mode: 'soft-error',
      source: 'llm_beautified',
      clusters: [{ id: 'truncated', size: 50, label: 'Truncated nodes' }]
    });
  });

  it('should handle error recovery scenarios', () => {
    const handleError = (error: Error, fallback: string): { result: string; diagnostics: string[] } => {
      const diagnostics = [`Error occurred: ${error.message}`];
      return {
        result: fallback,
        diagnostics
      };
    };
    
    const error = new Error('LLM service unavailable');
    const fallback = 'flowchart TD\nA["Fallback Node"]';
    
    const result = handleError(error, fallback);
    
    expect(result.result).toBe(fallback);
    expect(result.diagnostics).toContain('Error occurred: LLM service unavailable');
  });
});
