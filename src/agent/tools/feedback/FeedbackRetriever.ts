/**
 * Field-weighted BM25 similarity search for feedback retrieval
 * 
 * Implements smart retrieval with recency decay, diversity enforcement,
 * and pre-indexing for fast similarity search.
 */

import { 
  FeedbackRecord, 
  FeedbackRetrievalInput, 
  ScoredFeedbackRecord,
  FeedbackFieldWeights,
  DEFAULT_FIELD_WEIGHTS,
  OUTCOME_WEIGHTS 
} from './FeedbackTypes';

interface TokenIndex {
  [token: string]: Set<number>; // token -> set of record indices
}

interface FileIndex {
  [file: string]: Set<number>; // file -> set of record indices
}

interface ModeIndex {
  [mode: string]: Set<number>; // mode -> set of record indices
}

export class FeedbackRetriever {
  private records: FeedbackRecord[] = [];
  private tokenIndex: TokenIndex = {};
  private fileIndex: FileIndex = {};
  private modeIndex: ModeIndex = {};
  private queryCache: Map<string, ScoredFeedbackRecord[]> = new Map();
  private readonly maxCacheSize = 5;

  constructor(
    private readonly weights: FeedbackFieldWeights = DEFAULT_FIELD_WEIGHTS
  ) {}

  /**
   * Loads and indexes feedback records
   */
  loadRecords(records: FeedbackRecord[]): void {
    this.records = records;
    this.buildIndexes();
    this.queryCache.clear();
  }

  /**
   * Builds search indexes for fast retrieval
   */
  private buildIndexes(): void {
    this.tokenIndex = {};
    this.fileIndex = {};
    this.modeIndex = {};

    this.records.forEach((record, index) => {
      // Index tokens from bug description and root cause
      const text = `${record.bugDescription} ${record.likelyRootCause}`.toLowerCase();
      const tokens = this.tokenize(text);
      
      tokens.forEach(token => {
        if (!this.tokenIndex[token]) {
          this.tokenIndex[token] = new Set();
        }
        this.tokenIndex[token].add(index);
      });

      // Index files
      record.relatedFiles.forEach(file => {
        if (!this.fileIndex[file]) {
          this.fileIndex[file] = new Set();
        }
        this.fileIndex[file].add(index);
      });

      // Index mode
      if (!this.modeIndex[record.mode]) {
        this.modeIndex[record.mode] = new Set();
      }
      this.modeIndex[record.mode].add(index);
    });
  }

  /**
   * Tokenizes text for BM25-style search
   */
  private tokenize(text: string): string[] {
    return text
      .toLowerCase()
      .replace(/[^\w\s]/g, ' ') // Remove punctuation
      .split(/\s+/)
      .filter(token => token.length > 2) // Filter short tokens
      .filter(token => !this.isStopWord(token));
  }

  /**
   * Checks if a token is a stop word
   */
  private isStopWord(token: string): boolean {
    const stopWords = new Set([
      'the', 'and', 'or', 'but', 'in', 'on', 'at', 'to', 'for', 'of', 'with',
      'by', 'from', 'up', 'about', 'into', 'through', 'during', 'before',
      'after', 'above', 'below', 'between', 'among', 'is', 'are', 'was',
      'were', 'be', 'been', 'being', 'have', 'has', 'had', 'do', 'does',
      'did', 'will', 'would', 'could', 'should', 'may', 'might', 'must',
      'can', 'this', 'that', 'these', 'those', 'a', 'an', 'as', 'if',
      'then', 'else', 'when', 'where', 'why', 'how', 'all', 'any', 'both',
      'each', 'few', 'more', 'most', 'other', 'some', 'such', 'no', 'nor',
      'not', 'only', 'own', 'same', 'so', 'than', 'too', 'very', 'just',
      'now', 'here', 'there', 'where', 'why', 'how'
    ]);
    return stopWords.has(token);
  }

  /**
   * Calculates BM25 score for text similarity
   */
  private calculateBM25Score(
    queryTokens: string[],
    documentTokens: string[],
    k1: number = 1.2,
    b: number = 0.75
  ): number {
    if (queryTokens.length === 0 || documentTokens.length === 0) {
      return 0;
    }

    const docLength = documentTokens.length;
    const avgDocLength = 100; // Approximate average document length
    const docFreq = new Map<string, number>();
    
    // Count term frequencies in document
    documentTokens.forEach(token => {
      docFreq.set(token, (docFreq.get(token) || 0) + 1);
    });

    let score = 0;
    const uniqueQueryTokens = new Set(queryTokens);

    uniqueQueryTokens.forEach(term => {
      const tf = docFreq.get(term) || 0;
      if (tf === 0) return;

      // Calculate IDF (simplified - using document frequency)
      const docCount = this.records.length;
      const termDocCount = this.tokenIndex[term]?.size || 0;
      const idf = Math.log((docCount - termDocCount + 0.5) / (termDocCount + 0.5));

      // Calculate BM25 score component
      const numerator = tf * (k1 + 1);
      const denominator = tf + k1 * (1 - b + b * (docLength / avgDocLength));
      score += idf * (numerator / denominator);
    });

    return score;
  }

  /**
   * Calculates file similarity score
   */
  private calculateFileScore(queryFiles: string[], recordFiles: string[]): number {
    if (queryFiles.length === 0 || recordFiles.length === 0) {
      return 0;
    }

    let exactMatches = 0;
    let substringMatches = 0;

    queryFiles.forEach(queryFile => {
      recordFiles.forEach(recordFile => {
        if (queryFile === recordFile) {
          exactMatches++;
        } else if (queryFile.includes(recordFile) || recordFile.includes(queryFile)) {
          substringMatches++;
        }
      });
    });

    // Weight exact matches higher than substring matches
    return (exactMatches * 2 + substringMatches) / queryFiles.length;
  }

  /**
   * Calculates recency decay factor
   */
  private calculateRecencyDecay(timestamp: number): number {
    const now = Date.now();
    const daysSince = (now - timestamp) / (1000 * 60 * 60 * 24);
    return 1 + Math.min(0.15, -daysSince / 90); // 15% decay over ~3 months
  }

  /**
   * Enforces diversity in results (avoids multiple records from same file)
   */
  private enforceDiversity(
    scoredRecords: ScoredFeedbackRecord[],
    topK: number
  ): ScoredFeedbackRecord[] {
    const result: ScoredFeedbackRecord[] = [];
    const usedFiles = new Set<string>();
    const minScoreDelta = 0.3;

    // Sort by score descending
    const sorted = scoredRecords.sort((a, b) => b.score - a.score);

    for (const record of sorted) {
      if (result.length >= topK) break;

      const recordFiles = new Set(record.relatedFiles);
      const hasFileOverlap = Array.from(recordFiles).some(file => usedFiles.has(file));

      // Add if no file overlap, or if score delta is significant
      if (!hasFileOverlap || 
          (result.length > 0 && record.score - result[result.length - 1].score > minScoreDelta)) {
        result.push(record);
        recordFiles.forEach(file => usedFiles.add(file));
      }
    }

    return result;
  }

  /**
   * Gets relevant feedback examples for a query
   */
  getRelevantExamples(input: FeedbackRetrievalInput): ScoredFeedbackRecord[] {
    const { bugDescription, relatedFiles, mode, topK = 3 } = input;
    
    // Check cache first
    const cacheKey = JSON.stringify({ bugDescription, relatedFiles, mode, topK });
    if (this.queryCache.has(cacheKey)) {
      return this.queryCache.get(cacheKey)!;
    }

    if (this.records.length === 0) {
      return [];
    }

    const queryTokens = this.tokenize(bugDescription);
    const scoredRecords: ScoredFeedbackRecord[] = [];

    this.records.forEach((record, index) => {
      // Calculate field-weighted scores
      const recordTokens = this.tokenize(`${record.bugDescription} ${record.likelyRootCause}`);
      
      const bugDescriptionScore = this.calculateBM25Score(queryTokens, recordTokens);
      const fileScore = this.calculateFileScore(relatedFiles, record.relatedFiles);
      const modeScore = record.mode === mode ? 1 : 0;
      const reproTagScore = record.reproTag && bugDescription.includes(record.reproTag) ? 1 : 0;

      // Calculate base score with field weights
      let baseScore = 
        bugDescriptionScore * this.weights.bugDescription +
        fileScore * this.weights.relatedFiles +
        modeScore * this.weights.mode +
        reproTagScore * this.weights.reproTag;

      // Apply outcome weighting
      const outcomeWeight = OUTCOME_WEIGHTS[record.result];
      baseScore *= outcomeWeight;

      // Apply recency decay
      const recencyFactor = this.calculateRecencyDecay(record.timestamp);
      const finalScore = baseScore * recencyFactor;

      // Only include records with meaningful scores
      if (finalScore > 0.01) {
        const daysSince = (Date.now() - record.timestamp) / (1000 * 60 * 60 * 24);
        scoredRecords.push({
          ...record,
          score: finalScore,
          daysSince,
        });
      }
    });

    // Enforce diversity and return top-K
    const diverseResults = this.enforceDiversity(scoredRecords, topK);

    // Cache results (with size limit)
    if (this.queryCache.size >= this.maxCacheSize) {
      const firstKey = this.queryCache.keys().next().value;
      if (firstKey) {
        this.queryCache.delete(firstKey);
      }
    }
    this.queryCache.set(cacheKey, diverseResults);

    return diverseResults;
  }

  /**
   * Gets feedback statistics
   */
  getStats(): {
    totalRecords: number;
    indexedTokens: number;
    indexedFiles: number;
    cacheSize: number;
  } {
    return {
      totalRecords: this.records.length,
      indexedTokens: Object.keys(this.tokenIndex).length,
      indexedFiles: Object.keys(this.fileIndex).length,
      cacheSize: this.queryCache.size,
    };
  }

  /**
   * Clears the query cache
   */
  clearCache(): void {
    this.queryCache.clear();
  }
}
