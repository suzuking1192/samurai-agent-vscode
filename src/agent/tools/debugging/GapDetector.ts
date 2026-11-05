/**
 * Gap Detector
 * 
 * Detects missing or ambiguous evidence in debugging extraction results
 */

import { ExtractionResponse, GapSignals, Evidence, CandidateFile } from './types';

export class GapDetector {
  // Thresholds from spec
  private readonly LOW_CONFIDENCE_THRESHOLD = 0.55;
  private readonly COVERAGE_DEFICIT_THRESHOLD = 0.6;
  
  /**
   * Detect gaps in evidence that require additional information
   */
  detectGaps(
    extractionResult: ExtractionResponse,
    evidence: Evidence,
    candidates: CandidateFile[]
  ): GapSignals {
    const { confidence, graph } = extractionResult;
    
    return {
      lowConfidence: this.checkLowConfidence(confidence),
      recallMiss: this.checkRecallMiss(evidence, candidates),
      coverageScore: this.calculateCoverageScore(evidence, graph),
      hasSymbolGaps: this.checkSymbolGaps(evidence, graph, candidates),
      ambiguousStack: this.checkAmbiguousStack(evidence),
      timedOutStages: this.checkTimeouts(extractionResult.timings)
    };
  }
  
  /**
   * Check if confidence is below threshold
   */
  private checkLowConfidence(confidence: number): boolean {
    return confidence < this.LOW_CONFIDENCE_THRESHOLD;
  }
  
  /**
   * Check if culprit file is not in top candidates when stack frame exists
   */
  private checkRecallMiss(evidence: Evidence, candidates: CandidateFile[]): boolean {
    if (!evidence.frames || evidence.frames.length === 0) {
      return false;
    }
    
    const culpritFile = evidence.frames[0].file;
    
    // Check if culprit file is in top 3 candidates
    const topCandidates = candidates.slice(0, 3);
    const inTopCandidates = topCandidates.some(candidate => 
      candidate.file === culpritFile || culpritFile.includes(candidate.file)
    );
    
    return !inTopCandidates;
  }
  
  /**
   * Calculate coverage score (portion of cited lines we actually loaded)
   */
  private calculateCoverageScore(evidence: Evidence, graph: { nodes: any[] }): number {
    if (!evidence.frames || evidence.frames.length === 0) {
      return 1.0; // No frames to cover
    }
    
    const frameNodes = new Set(
      evidence.frames.map(frame => this.getNodeId(frame.file, frame.line))
    );
    
    const loadedNodes = new Set(
      graph.nodes.map(node => node.id)
    );
    
    const coveredNodes = Array.from(frameNodes).filter(id => loadedNodes.has(id));
    
    if (frameNodes.size === 0) {
      return 1.0;
    }
    
    return coveredNodes.length / frameNodes.size;
  }
  
  /**
   * Check for symbol gaps (hypothesis cites symbols/files not in candidates)
   */
  private checkSymbolGaps(
    evidence: Evidence, 
    graph: { nodes: any[] }, 
    candidates: CandidateFile[]
  ): boolean {
    const candidateFiles = new Set(candidates.map(c => c.file));
    const candidateSymbols = new Set(
      candidates.flatMap(c => c.symbols?.map(s => s.symbol) || [])
    );
    
    // Check if graph nodes reference files not in candidates
    const hasUnknownFiles = graph.nodes.some(node => {
      if (node.file && !candidateFiles.has(node.file)) {
        return true;
      }
      return false;
    });
    
    // Check if frames reference files not in candidates
    const hasUnknownFrameFiles = evidence.frames?.some(frame => 
      !candidateFiles.has(frame.file)
    ) || false;
    
    return hasUnknownFiles || hasUnknownFrameFiles;
  }
  
  /**
   * Check if stack is ambiguous (0 resolvable frames, minified/URL paths)
   */
  private checkAmbiguousStack(evidence: Evidence): boolean {
    if (!evidence.frames || evidence.frames.length === 0) {
      return true; // No frames = ambiguous
    }
    
    // Check for minified paths
    const hasMinified = evidence.frames.some(frame => {
      const file = frame.file || '';
      return file.includes('.min.js') || 
             file.includes('.min.ts') ||
             file.includes('node_modules') ||
             file.startsWith('http://') || 
             file.startsWith('https://');
    });
    
    return hasMinified;
  }
  
  /**
   * Check for timed out stages
   */
  private checkTimeouts(timings: Record<string, number>): string[] {
    // Define reasonable timeouts per stage (in ms)
    const timeouts: Record<string, number> = {
      evidence: 5000,
      plan: 10000,
      retrieval: 15000,
      ast: 10000,
      slice: 5000,
      rerank: 3000
    };
    
    const timedOutStages: string[] = [];
    
    for (const [stage, maxTime] of Object.entries(timeouts)) {
      if (timings[stage] && timings[stage] > maxTime) {
        timedOutStages.push(stage);
      }
    }
    
    return timedOutStages;
  }
  
  /**
   * Helper to generate node ID from file and line
   */
  private getNodeId(file: string, line?: number): string {
    return line ? `${file}:${line}` : file;
  }
}

