/**
 * Snippet Store for debugging code extraction
 * 
 * Stores and manages code snippets with provenance for root-cause analysis
 * Provides versioned code spans with context and metadata
 */

import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { GraphNode, GraphEdge } from './types';

// Core interfaces
export type SnippetKey = {
  projectId: string;
  commitHash: string;
  filePath: string;
  startLine: number;
  endLine: number;
};

export interface SnippetRecord extends SnippetKey {
  snippetId: string;
  lang: 'ts' | 'tsx' | 'js' | 'jsx' | 'json' | 'md' | 'html' | 'css' | 'scss' | 'less' | string;
  fileHash: string;
  contentHash: string;
  source: ('bm25' | 'llm' | 'symbolDef' | 'frame' | 'route' | 'astImport' | 'astCall' | 'llmPatch')[];
  scores?: Record<string, number>;
  evidence?: string[];
  frameworkHints?: string[];
  code?: string;
  preContext?: string;
  postContext?: string;
  charStart?: number;
  charEnd?: number;
  createdAt: number;
}

export interface SnippetStore {
  upsert(rec: SnippetRecord): Promise<void>;
  getByKey(key: SnippetKey): Promise<SnippetRecord | null>;
  listByProject(params: {
    projectId: string;
    commitHash: string;
    files?: string[];
    limit?: number;
  }): Promise<SnippetRecord[]>;
  listByGraphNode(nodeId: string): Promise<SnippetRecord[]>;
  listBySource(source: string): Promise<SnippetRecord[]>;
  gc(params: {
    projectId: string;
    keepCommits: number;
    maxBytes?: number;
  }): Promise<void>;
  getStats(): Promise<{
    totalSnippets: number;
    totalBytes: number;
    bySource: Record<string, number>;
    byProject: Record<string, number>;
  }>;
}

export interface RootCauseInput {
  incident: {
    userMessage: string;
    logs: string;
    evidenceIds: string[];
  };
  slice: {
    nodes: GraphNode[];
    edges: GraphEdge[];
    failNodeId?: string;
  };
  snippets: SnippetRecord[];
}

// In-memory implementation with optional persistence
export class InMemorySnippetStore implements SnippetStore {
  private snippets = new Map<string, SnippetRecord>();
  private nodeToSnippets = new Map<string, Set<string>>();
  private projectIndex = new Map<string, Set<string>>();
  private sourceIndex = new Map<string, Set<string>>();
  private totalBytes = 0;
  private readonly maxBytes: number;
  private readonly maxSnippets: number;

  constructor(maxBytes = 50 * 1024 * 1024, maxSnippets = 1000) {
    this.maxBytes = maxBytes;
    this.maxSnippets = maxSnippets;
  }

  async upsert(rec: SnippetRecord): Promise<void> {
    const existing = this.snippets.get(rec.snippetId);
    
    // Calculate size impact
    const sizeDelta = this.calculateRecordSize(rec) - (existing ? this.calculateRecordSize(existing) : 0);
    
    // Check limits
    if (this.totalBytes + sizeDelta > this.maxBytes || this.snippets.size >= this.maxSnippets) {
      await this.gc({
        projectId: rec.projectId,
        keepCommits: 1,
        maxBytes: this.maxBytes * 0.8
      });
    }

    // Store the record
    this.snippets.set(rec.snippetId, rec);
    this.totalBytes += sizeDelta;

    // Update indexes
    this.updateIndexes(rec, existing);
  }

  async getByKey(key: SnippetKey): Promise<SnippetRecord | null> {
    const snippetId = this.makeSnippetId(key);
    return this.snippets.get(snippetId) || null;
  }

  async listByProject(params: {
    projectId: string;
    commitHash: string;
    files?: string[];
    limit?: number;
  }): Promise<SnippetRecord[]> {
    const projectKey = `${params.projectId}:${params.commitHash}`;
    const snippetIds = this.projectIndex.get(projectKey) || new Set();
    
    let records = Array.from(snippetIds)
      .map(id => this.snippets.get(id))
      .filter((rec): rec is SnippetRecord => rec !== undefined);

    // Filter by files if specified
    if (params.files) {
      const fileSet = new Set(params.files);
      records = records.filter(rec => fileSet.has(rec.filePath));
    }

    // Sort by creation time (newest first)
    records.sort((a, b) => b.createdAt - a.createdAt);

    // Apply limit
    if (params.limit) {
      records = records.slice(0, params.limit);
    }

    return records;
  }

  async listByGraphNode(nodeId: string): Promise<SnippetRecord[]> {
    const snippetIds = this.nodeToSnippets.get(nodeId) || new Set();
    return Array.from(snippetIds)
      .map(id => this.snippets.get(id))
      .filter((rec): rec is SnippetRecord => rec !== undefined);
  }

  async listBySource(source: string): Promise<SnippetRecord[]> {
    const snippetIds = this.sourceIndex.get(source) || new Set();
    return Array.from(snippetIds)
      .map(id => this.snippets.get(id))
      .filter((rec): rec is SnippetRecord => rec !== undefined);
  }

  async gc(params: {
    projectId: string;
    keepCommits: number;
    maxBytes?: number;
  }): Promise<void> {
    const targetBytes = params.maxBytes || this.maxBytes * 0.8;
    
    if (this.totalBytes <= targetBytes) {
      return;
    }

    // Get all records for the project
    const projectRecords = Array.from(this.snippets.values())
      .filter(rec => rec.projectId === params.projectId)
      .sort((a, b) => b.createdAt - a.createdAt);

    // Group by commit hash
    const byCommit = new Map<string, SnippetRecord[]>();
    for (const rec of projectRecords) {
      if (!byCommit.has(rec.commitHash)) {
        byCommit.set(rec.commitHash, []);
      }
      byCommit.get(rec.commitHash)!.push(rec);
    }

    // Keep only the most recent commits
    const commits = Array.from(byCommit.keys()).sort().slice(-params.keepCommits);
    const keepCommits = new Set(commits);

    // Remove old records
    const toRemove: string[] = [];
    for (const rec of projectRecords) {
      if (!keepCommits.has(rec.commitHash)) {
        toRemove.push(rec.snippetId);
      }
    }

    // Remove records until we're under the target
    let removedBytes = 0;
    for (const snippetId of toRemove) {
      const rec = this.snippets.get(snippetId);
      if (rec) {
        removedBytes += this.calculateRecordSize(rec);
        this.removeRecord(snippetId);
        
        if (this.totalBytes - removedBytes <= targetBytes) {
          break;
        }
      }
    }

    this.totalBytes -= removedBytes;
  }

  async getStats(): Promise<{
    totalSnippets: number;
    totalBytes: number;
    bySource: Record<string, number>;
    byProject: Record<string, number>;
  }> {
    const bySource: Record<string, number> = {};
    const byProject: Record<string, number> = {};

    for (const rec of this.snippets.values()) {
      // Count by source
      for (const source of rec.source) {
        bySource[source] = (bySource[source] || 0) + 1;
      }

      // Count by project
      byProject[rec.projectId] = (byProject[rec.projectId] || 0) + 1;
    }

    return {
      totalSnippets: this.snippets.size,
      totalBytes: this.totalBytes,
      bySource,
      byProject
    };
  }

  // Helper methods
  private makeSnippetId(key: SnippetKey): string {
    const content = `${key.projectId}:${key.commitHash}:${key.filePath}:${key.startLine}:${key.endLine}`;
    return crypto.createHash('sha256').update(content).digest('hex').substring(0, 16);
  }

  private calculateRecordSize(rec: SnippetRecord): number {
    let size = 0;
    size += rec.snippetId.length;
    size += rec.lang.length;
    size += rec.fileHash.length;
    size += rec.contentHash.length;
    size += rec.source.join(',').length;
    size += rec.evidence?.join(',').length || 0;
    size += rec.frameworkHints?.join(',').length || 0;
    size += rec.code?.length || 0;
    size += rec.preContext?.length || 0;
    size += rec.postContext?.length || 0;
    size += JSON.stringify(rec.scores || {}).length;
    size += 8; // createdAt
    return size;
  }

  private updateIndexes(rec: SnippetRecord, existing?: SnippetRecord): void {
    // Remove from old indexes if updating
    if (existing) {
      this.removeFromIndexes(existing);
    }

    // Add to project index
    const projectKey = `${rec.projectId}:${rec.commitHash}`;
    if (!this.projectIndex.has(projectKey)) {
      this.projectIndex.set(projectKey, new Set());
    }
    this.projectIndex.get(projectKey)!.add(rec.snippetId);

    // Add to source index
    for (const source of rec.source) {
      if (!this.sourceIndex.has(source)) {
        this.sourceIndex.set(source, new Set());
      }
      this.sourceIndex.get(source)!.add(rec.snippetId);
    }
  }

  private removeFromIndexes(rec: SnippetRecord): void {
    // Remove from project index
    const projectKey = `${rec.projectId}:${rec.commitHash}`;
    const projectSet = this.projectIndex.get(projectKey);
    if (projectSet) {
      projectSet.delete(rec.snippetId);
      if (projectSet.size === 0) {
        this.projectIndex.delete(projectKey);
      }
    }

    // Remove from source index
    for (const source of rec.source) {
      const sourceSet = this.sourceIndex.get(source);
      if (sourceSet) {
        sourceSet.delete(rec.snippetId);
        if (sourceSet.size === 0) {
          this.sourceIndex.delete(source);
        }
      }
    }
  }

  private removeRecord(snippetId: string): void {
    const rec = this.snippets.get(snippetId);
    if (rec) {
      this.removeFromIndexes(rec);
      this.snippets.delete(snippetId);
    }
  }
}

// Utility functions for creating and managing snippets
export class SnippetUtils {
  /**
   * Create a snippet record from code span information
   */
  static async createSnippetRecord(params: {
    projectId: string;
    commitHash: string;
    filePath: string;
    startLine: number;
    endLine: number;
    source: SnippetRecord['source'];
    scores?: Record<string, number>;
    evidence?: string[];
    frameworkHints?: string[];
    code?: string;
    preContext?: string;
    postContext?: string;
    charStart?: number;
    charEnd?: number;
  }): Promise<SnippetRecord> {
    const snippetId = this.makeSnippetId({
      projectId: params.projectId,
      commitHash: params.commitHash,
      filePath: params.filePath,
      startLine: params.startLine,
      endLine: params.endLine
    });

    const lang = this.detectLanguage(params.filePath);
    const fileHash = await this.calculateFileHash(params.filePath);
    const contentHash = params.code ? this.calculateContentHash(params.code) : '';

    return {
      snippetId,
      projectId: params.projectId,
      commitHash: params.commitHash,
      filePath: params.filePath,
      startLine: params.startLine,
      endLine: params.endLine,
      lang,
      fileHash,
      contentHash,
      source: params.source,
      scores: params.scores,
      evidence: params.evidence,
      frameworkHints: params.frameworkHints,
      code: params.code,
      preContext: params.preContext,
      postContext: params.postContext,
      charStart: params.charStart,
      charEnd: params.charEnd,
      createdAt: Date.now()
    };
  }

  /**
   * Extract code snippet from file with context
   */
  static async extractCodeSnippet(
    filePath: string,
    startLine: number,
    endLine: number,
    contextLines = 15
  ): Promise<{
    code: string;
    preContext: string;
    postContext: string;
    charStart: number;
    charEnd: number;
  }> {
    try {
      const content = fs.readFileSync(filePath, 'utf8');
      const lines = content.split('\n');
      
      const actualStart = Math.max(0, startLine - 1);
      const actualEnd = Math.min(lines.length, endLine);
      
      const preStart = Math.max(0, actualStart - contextLines);
      const postEnd = Math.min(lines.length, actualEnd + contextLines);
      
      const code = lines.slice(actualStart, actualEnd).join('\n');
      const preContext = lines.slice(preStart, actualStart).join('\n');
      const postContext = lines.slice(actualEnd, postEnd).join('\n');
      
      // Calculate character positions
      const charStart = lines.slice(0, actualStart).join('\n').length + (actualStart > 0 ? 1 : 0);
      const charEnd = charStart + code.length;
      
      return {
        code,
        preContext,
        postContext,
        charStart,
        charEnd
      };
    } catch (error) {
      console.warn(`Failed to extract code snippet from ${filePath}:`, error);
      return {
        code: '',
        preContext: '',
        postContext: '',
        charStart: 0,
        charEnd: 0
      };
    }
  }

  /**
   * Link snippet to graph node
   */
  static linkSnippetToNode(
    store: SnippetStore,
    snippetId: string,
    nodeId: string
  ): Promise<void> {
    // This would be implemented in a persistent store
    // For now, we'll handle this in the in-memory implementation
    return Promise.resolve();
  }

  /**
   * Gather root cause input with snippets
   */
  static async gatherRootCauseInput(
    projectId: string,
    commitHash: string,
    slice: {
      nodes: GraphNode[];
      edges: GraphEdge[];
      failNodeId?: string;
    },
    store: SnippetStore,
    incident: {
      userMessage: string;
      logs: string;
      evidenceIds: string[];
    }
  ): Promise<RootCauseInput> {
    const files = Array.from(
      new Set(
        slice.nodes
          .map(n => n.file)
          .filter(Boolean) as string[]
      )
    );

    const snippets = await store.listByProject({
      projectId,
      commitHash,
      files,
      limit: 500
    });

    return {
      incident,
      slice,
      snippets
    };
  }

  // Private helper methods
  private static makeSnippetId(key: SnippetKey): string {
    const content = `${key.projectId}:${key.commitHash}:${key.filePath}:${key.startLine}:${key.endLine}`;
    return crypto.createHash('sha256').update(content).digest('hex').substring(0, 16);
  }

  private static detectLanguage(filePath: string): SnippetRecord['lang'] {
    const ext = path.extname(filePath).toLowerCase();
    switch (ext) {
      case '.ts': return 'ts';
      case '.tsx': return 'tsx';
      case '.js': return 'js';
      case '.jsx': return 'jsx';
      case '.json': return 'json';
      case '.md': return 'md';
      case '.html': return 'html';
      case '.css': return 'css';
      case '.scss': return 'scss';
      case '.less': return 'less';
      default: return 'unknown';
    }
  }

  private static async calculateFileHash(filePath: string): Promise<string> {
    try {
      const content = fs.readFileSync(filePath, 'utf8');
      return crypto.createHash('sha256').update(content).digest('hex');
    } catch (error) {
      // Fallback to mtime + size
      const stats = fs.statSync(filePath);
      const content = `${stats.mtime.getTime()}:${stats.size}`;
      return crypto.createHash('sha256').update(content).digest('hex');
    }
  }

  private static calculateContentHash(content: string): string {
    return crypto.createHash('sha256').update(content).digest('hex');
  }
}

// Factory function for creating snippet stores
export function createSnippetStore(
  type: 'memory' = 'memory',
  options?: { maxBytes?: number; maxSnippets?: number }
): SnippetStore {
  switch (type) {
    case 'memory':
      return new InMemorySnippetStore(
        options?.maxBytes,
        options?.maxSnippets
      );
    default:
      throw new Error(`Unknown snippet store type: ${type}`);
  }
}
