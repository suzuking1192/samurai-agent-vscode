import { GraphCompressor } from '../../../../agent/tools/debugging/GraphCompressor';
import { VisualizationService } from '../../../../agent/tools/debugging/VisualizationService';
import { ExecutionGraph } from '../../../../agent/tools/debugging/VisualizationService';
import { GraphNode, GraphEdge } from '../../../../agent/tools/debugging/types';

const mockLLMProvider = {} as any;

describe('GraphCompressor smart parameter labels', () => {
  const compressor = new GraphCompressor(mockLLMProvider);

  const buildLabel = (args: Array<string | undefined>) =>
    (compressor as any)._buildSmartEdgeLabelFromTexts(args);

  it('returns "calls" when there are no arguments', () => {
    expect(buildLabel([])).toBe('calls');
  });

  it('joins up to three argument names', () => {
    expect(buildLabel(['req'])).toBe('req');
    expect(buildLabel(['req', 'res', 'next'])).toBe('req, res, next');
  });

  it('collapses when more than three arguments are present', () => {
    expect(buildLabel(['first', 'second', 'third', 'fourth'])).toBe('first, ...');
  });

  it('truncates long argument names', () => {
    const longName = 'superLongArgumentNameThatShouldBeTrimmed';
    expect(buildLabel([longName])).toBe(`${longName.slice(0, 20)}...`);
  });
});

describe('VisualizationService edge label rendering', () => {
  const service = new VisualizationService(mockLLMProvider);
  const suspects = new Set<string>();

  const makeGraph = (edgeLabel?: string): ExecutionGraph => {
    const nodes: GraphNode[] = [
      { id: 'a', label: 'Alpha', kind: 'symbol', file: undefined },
      { id: 'b', label: 'Beta', kind: 'symbol', file: undefined }
    ];

    const edges: GraphEdge[] = [
      {
        from: 'a',
        to: 'b',
        kind: 'calls',
        confidence: 1,
        label: edgeLabel
      }
    ];

    return { nodes, edges };
  };

  it('includes the smart edge label in Mermaid output', () => {
    const graph = makeGraph('req');
    const mermaid = (service as any).toMermaidDeterministic(graph, suspects, 'hard-error');
    expect(mermaid).toContain('a -->|req| b');
  });

  it('sanitizes unsafe edge label characters', () => {
    const graph = makeGraph('dangerous|label\nvalue');
    const mermaid = (service as any).toMermaidDeterministic(graph, suspects, 'hard-error');
    expect(mermaid).toContain('a -->|dangerouslabel value| b');
  });

  it('falls back to "calls" when label is missing', () => {
    const graph = makeGraph();
    const mermaid = (service as any).toMermaidDeterministic(graph, suspects, 'hard-error');
    expect(mermaid).toContain('a -->|calls| b');
  });
});
