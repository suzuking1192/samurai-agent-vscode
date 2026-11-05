import { GraphCodeSnippet, GraphEdge, GraphNode } from './types';

export interface SerializedTraceNode {
  node: GraphNode;
  snippet?: GraphCodeSnippet;
  index: number;
  action: string;
}

export interface SerializedTraceResult {
  markdown: string;
  orderedNodeIds: string[];
  nodes: SerializedTraceNode[];
  omittedNodeLabels: string[];
}

interface TracePath {
  ids: string[];
  score: number;
}

const DEFAULT_MAX_TRACE_LENGTH = 10;

export class GraphToPromptSerializer {
  constructor(private readonly maxTraceLength: number = DEFAULT_MAX_TRACE_LENGTH) {}

  serialize(
    graph: { nodes: GraphNode[]; edges: GraphEdge[] },
    epicenterNodeId?: string,
    snippets?: Map<string, GraphCodeSnippet>
  ): SerializedTraceResult {
    if (!graph.nodes.length || !epicenterNodeId) {
      return {
        markdown: this.renderEmptyTrace(),
        orderedNodeIds: [],
        nodes: [],
        omittedNodeLabels: []
      };
    }

    const nodeMap = this.createNodeMap(graph.nodes);
    if (!nodeMap.has(epicenterNodeId)) {
      return {
        markdown: this.renderEmptyTrace(),
        orderedNodeIds: [],
        nodes: [],
        omittedNodeLabels: []
      };
    }

    const incoming = this.buildIncomingEdgeMap(graph.edges);
    const outgoing = this.buildOutgoingEdgeMap(graph.edges);

    const orderedTrace = this.buildOrderedTrace(epicenterNodeId, nodeMap, incoming);
    const { trace: prunedTrace, omittedNodeIds } = this.pruneTrace(orderedTrace);
    const serializedNodes = this.buildSerializedNodes(prunedTrace, nodeMap, outgoing, snippets);

    const markdown = this.renderMarkdown(serializedNodes, omittedNodeIds, nodeMap);

    return {
      markdown,
      orderedNodeIds: orderedTrace,
      nodes: serializedNodes,
      omittedNodeLabels: omittedNodeIds.map(id => nodeMap.get(id)?.label || id)
    };
  }

  private createNodeMap(nodes: GraphNode[]): Map<string, GraphNode> {
    return new Map(nodes.map(node => [node.id, node]));
  }

  private buildIncomingEdgeMap(edges: GraphEdge[]): Map<string, GraphEdge[]> {
    const incoming = new Map<string, GraphEdge[]>();
    for (const edge of edges) {
      if (!incoming.has(edge.to)) {
        incoming.set(edge.to, []);
      }
      incoming.get(edge.to)!.push(edge);
    }
    return incoming;
  }

  private buildOutgoingEdgeMap(edges: GraphEdge[]): Map<string, GraphEdge[]> {
    const outgoing = new Map<string, GraphEdge[]>();
    for (const edge of edges) {
      if (!outgoing.has(edge.from)) {
        outgoing.set(edge.from, []);
      }
      outgoing.get(edge.from)!.push(edge);
    }
    return outgoing;
  }

  private buildOrderedTrace(
    epicenterNodeId: string,
    nodeMap: Map<string, GraphNode>,
    incoming: Map<string, GraphEdge[]>
  ): string[] {
    const memo = new Map<string, TracePath>();
    const stack = new Set<string>();

    const dfs = (nodeId: string): TracePath => {
      if (memo.has(nodeId)) {
        return memo.get(nodeId)!;
      }
      if (stack.has(nodeId)) {
        // Cycle detected, stop here
        const cyclePath = { ids: [nodeId], score: this.nodeScore(nodeMap.get(nodeId)) };
        memo.set(nodeId, cyclePath);
        return cyclePath;
      }

      stack.add(nodeId);
      const predecessors = (incoming.get(nodeId) || []).filter(edge => nodeMap.has(edge.from));

      if (!predecessors.length) {
        const basePath = { ids: [nodeId], score: this.nodeScore(nodeMap.get(nodeId)) };
        memo.set(nodeId, basePath);
        stack.delete(nodeId);
        return basePath;
      }

      let bestPath: TracePath | undefined;

      for (const edge of predecessors) {
        const candidatePath = dfs(edge.from);
        const extendedPath = {
          ids: [...candidatePath.ids, nodeId],
          score: candidatePath.score + this.nodeScore(nodeMap.get(nodeId))
        };

        if (!bestPath || this.comparePaths(extendedPath, bestPath) > 0) {
          bestPath = extendedPath;
        }
      }

      stack.delete(nodeId);
      const finalPath = bestPath || { ids: [nodeId], score: this.nodeScore(nodeMap.get(nodeId)) };
      memo.set(nodeId, finalPath);
      return finalPath;
    };

    const longestPath = dfs(epicenterNodeId);
    return longestPath.ids;
  }

  private nodeScore(node: GraphNode | undefined): number {
    if (!node) {
      return 1;
    }
    const importance = typeof node.importance === 'number' ? node.importance : 0;
    return 1 + importance;
  }

  private comparePaths(a: TracePath, b: TracePath): number {
    if (a.ids.length !== b.ids.length) {
      return a.ids.length - b.ids.length;
    }
    if (a.score !== b.score) {
      return a.score - b.score;
    }
    return 0;
  }

  private pruneTrace(trace: string[]): { trace: string[]; omittedNodeIds: string[] } {
    if (trace.length <= this.maxTraceLength) {
      return { trace, omittedNodeIds: [] };
    }

    const halfWindow = Math.floor(this.maxTraceLength / 2);
    const keepStart = trace.slice(0, halfWindow);
    const keepEnd = trace.slice(-halfWindow);
    const omitted = trace.slice(halfWindow, trace.length - halfWindow);

    return {
      trace: [...keepStart, ...keepEnd],
      omittedNodeIds: omitted
    };
  }

  private buildSerializedNodes(
    trace: string[],
    nodeMap: Map<string, GraphNode>,
    outgoing: Map<string, GraphEdge[]>,
    snippets?: Map<string, GraphCodeSnippet>
  ): SerializedTraceNode[] {
    const result: SerializedTraceNode[] = [];

    trace.forEach((nodeId, index) => {
      const node = nodeMap.get(nodeId);
      if (!node) {
        return;
      }

      const nextNodeId = trace[index + 1];
      const action = this.describeAction(nodeId, nextNodeId, outgoing, nodeMap);

      result.push({
        node,
        snippet: snippets?.get(nodeId),
        index: index + 1,
        action
      });
    });

    return result;
  }

  private describeAction(
    nodeId: string,
    nextNodeId: string | undefined,
    outgoing: Map<string, GraphEdge[]>,
    nodeMap: Map<string, GraphNode>
  ): string {
    if (!nextNodeId) {
      return 'This is the last known step.';
    }

    const edges = outgoing.get(nodeId) || [];
    const matchingEdge = edges.find(edge => edge.to === nextNodeId);
    const nextNodeLabel = nodeMap.get(nextNodeId)?.label || nextNodeId;

    if (!matchingEdge) {
      return `Likely continues to ${nextNodeLabel}.`;
    }

    const actionVerb = this.edgeKindToAction(matchingEdge.kind);
    const labelSuffix = matchingEdge.label ? ` (“${matchingEdge.label}”)` : '';
    return `It ${actionVerb}${labelSuffix} ${nextNodeLabel}.`;
  }

  private edgeKindToAction(kind: GraphEdge['kind']): string {
    switch (kind) {
      case 'imports':
        return 'imports';
      case 'exports':
        return 'exports';
      case 'reexports':
        return 're-exports';
      case 'alias':
        return 'aliases';
      case 'dynamicImport':
        return 'dynamically imports';
      case 'logFlow':
        return 'logs to';
      case 'runtimePath':
        return 'continues through';
      case 'importedBy':
        return 'is imported by';
      case 'calls':
      default:
        return 'calls';
    }
  }

  private renderMarkdown(
    nodes: SerializedTraceNode[],
    omittedNodeIds: string[],
    nodeMap: Map<string, GraphNode>
  ): string {
    let markdown = '## Execution Trace Analysis\n\n';

    if (!nodes.length) {
      markdown += 'Execution trace is unavailable for this graph.\n';
      return markdown;
    }

    markdown += 'Here is the critical execution path that led to the epicenter.\n\n';

    if (omittedNodeIds.length) {
      const omittedLabels = omittedNodeIds.map(id => nodeMap.get(id)?.label || id);
      markdown += `> Note: ${omittedNodeIds.length} intermediate step(s) omitted for brevity: ${omittedLabels.join(', ')}\n\n`;
    }

    nodes.forEach(traceNode => {
      const fileLine = this.renderFileLine(traceNode);
      const analysis = traceNode.node.analysis?.trim()
        ? traceNode.node.analysis.trim()
        : 'No existing analysis notes for this step.';
      const importanceText = typeof traceNode.node.importance === 'number'
        ? traceNode.node.importance.toFixed(2)
        : 'N/A';

      markdown += '---\n\n';
      markdown += `### ${traceNode.index}. ${this.buildNodeTitle(traceNode.node, traceNode.index, nodes.length)}\n\n`;
      if (fileLine) {
        markdown += `* ${fileLine}\n`;
      }
      markdown += `* **Importance:** ${importanceText}\n`;
      markdown += `* **Analysis:** ${analysis}\n`;
      markdown += `* **Action:** ${traceNode.action}\n\n`;

      const snippet = traceNode.snippet;
      if (snippet?.code) {
        markdown += '* **Code:**\n\n';
        markdown += '```typescript\n';
        markdown += snippet.code.trim() || '// code unavailable';
        markdown += '\n```\n\n';
      }
    });

    markdown += '---\n';
    return markdown;
  }

  private buildNodeTitle(node: GraphNode, index: number, total: number): string {
    const prefix = index === total ? 'Epicenter' : 'Execution';
    return `${prefix}: \`${node.label}\``;
  }

  private renderFileLine(node: SerializedTraceNode): string | null {
    const filePath = node.snippet?.file || node.node.file;
    if (!filePath) {
      return null;
    }

    const range =
      node.snippet?.startLine && node.snippet?.endLine
        ? `(Lines ${node.snippet.startLine}-${node.snippet.endLine})`
        : node.node.line
        ? `(Line ${node.node.line})`
        : '';

    return `**File:** \`${filePath}\` ${range}`.trim();
  }

  private renderEmptyTrace(): string {
    return '## Execution Trace Analysis\n\nExecution trace is unavailable for this graph.\n';
  }
}

