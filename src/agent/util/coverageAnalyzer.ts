/**
 * Coverage Analyzer for Debugging Flow
 * 
 * Analyzes code coverage and symbol gaps to determine if more context is needed
 */

import { SnippetRecord } from '../tools/debugging/rootCauseTypes';
import { CandidateFile } from '../tools/debugging/types';

export interface CoverageAnalysis {
  coverageScore: number; // 0-1, percentage of hypothesis references covered
  hasSymbolGaps: boolean;
  missingFiles: string[];
  missingSymbols: string[];
  recommendations: string[];
}

/**
 * Analyze coverage of hypothesis references against available snippets
 */
export function analyzeCoverage(
  snippets: SnippetRecord[],
  hypothesisRefs: string[],
  candidates: CandidateFile[]
): CoverageAnalysis {
  const snippetFiles = new Set(snippets.map(s => s.file));
  const snippetSymbols = extractSymbolsFromSnippets(snippets);
  const candidateSymbols = extractSymbolsFromCandidates(candidates);
  
  // Calculate coverage score
  const coverageScore = calculateCoverageScore(hypothesisRefs, snippetFiles, snippetSymbols);
  
  // Check for symbol gaps
  const symbolGaps = findSymbolGaps(hypothesisRefs, snippetSymbols, candidateSymbols);
  
  // Find missing files
  const missingFiles = findMissingFiles(hypothesisRefs, snippetFiles, candidates);
  
  // Generate recommendations
  const recommendations = generateRecommendations(coverageScore, symbolGaps, missingFiles);
  
  return {
    coverageScore,
    hasSymbolGaps: symbolGaps.length > 0,
    missingFiles,
    missingSymbols: symbolGaps,
    recommendations,
  };
}

/**
 * Calculate coverage score (0-1) based on how many hypothesis references are covered
 */
function calculateCoverageScore(
  hypothesisRefs: string[],
  snippetFiles: Set<string>,
  snippetSymbols: Set<string>
): number {
  if (hypothesisRefs.length === 0) {
    return 1.0; // No references to cover
  }
  
  let coveredCount = 0;
  
  for (const ref of hypothesisRefs) {
    // Check if reference is a file path
    if (isFilePath(ref)) {
      if (snippetFiles.has(ref) || snippetFiles.has(normalizePath(ref))) {
        coveredCount++;
        continue;
      }
    }
    
    // Check if reference is a symbol
    if (isSymbol(ref)) {
      if (snippetSymbols.has(ref) || snippetSymbols.has(ref.toLowerCase())) {
        coveredCount++;
        continue;
      }
    }
    
    // Check for partial matches (e.g., "UserService" matches "userService")
    const partialMatch = Array.from(snippetSymbols).some(symbol => 
      symbol.toLowerCase().includes(ref.toLowerCase()) ||
      ref.toLowerCase().includes(symbol.toLowerCase())
    );
    
    if (partialMatch) {
      coveredCount++;
    }
  }
  
  return coveredCount / hypothesisRefs.length;
}

/**
 * Find symbols mentioned in hypothesis but not in snippets
 */
function findSymbolGaps(
  hypothesisRefs: string[],
  snippetSymbols: Set<string>,
  candidateSymbols: Set<string>
): string[] {
  const gaps: string[] = [];
  
  for (const ref of hypothesisRefs) {
    if (isSymbol(ref)) {
      const hasInSnippets = snippetSymbols.has(ref) || 
                           snippetSymbols.has(ref.toLowerCase()) ||
                           Array.from(snippetSymbols).some(s => 
                             s.toLowerCase().includes(ref.toLowerCase())
                           );
      
      const hasInCandidates = candidateSymbols.has(ref) ||
                             candidateSymbols.has(ref.toLowerCase()) ||
                             Array.from(candidateSymbols).some(s => 
                               s.toLowerCase().includes(ref.toLowerCase())
                             );
      
      if (!hasInSnippets && hasInCandidates) {
        gaps.push(ref);
      }
    }
  }
  
  return gaps;
}

/**
 * Find files mentioned in hypothesis but not in snippets
 */
function findMissingFiles(
  hypothesisRefs: string[],
  snippetFiles: Set<string>,
  candidates: CandidateFile[]
): string[] {
  const missing: string[] = [];
  const candidateFiles = new Set(candidates.map(c => c.file));
  
  for (const ref of hypothesisRefs) {
    if (isFilePath(ref)) {
      const normalizedRef = normalizePath(ref);
      const hasInSnippets = snippetFiles.has(ref) || snippetFiles.has(normalizedRef);
      const hasInCandidates = candidateFiles.has(ref) || candidateFiles.has(normalizedRef);
      
      if (!hasInSnippets && hasInCandidates) {
        missing.push(ref);
      }
    }
  }
  
  return missing;
}

/**
 * Generate recommendations based on analysis
 */
function generateRecommendations(
  coverageScore: number,
  symbolGaps: string[],
  missingFiles: string[]
): string[] {
  const recommendations: string[] = [];
  
  if (coverageScore < 0.6) {
    recommendations.push('Low coverage - consider extracting more context');
  }
  
  if (symbolGaps.length > 0) {
    recommendations.push(`Missing symbols: ${symbolGaps.slice(0, 3).join(', ')}`);
  }
  
  if (missingFiles.length > 0) {
    recommendations.push(`Missing files: ${missingFiles.slice(0, 2).join(', ')}`);
  }
  
  if (coverageScore >= 0.8 && symbolGaps.length === 0 && missingFiles.length === 0) {
    recommendations.push('Good coverage - sufficient context available');
  }
  
  return recommendations;
}

/**
 * Extract symbols from snippets
 */
function extractSymbolsFromSnippets(snippets: SnippetRecord[]): Set<string> {
  const symbols = new Set<string>();
  
  for (const snippet of snippets) {
    const text = snippet.text;
    
    // Extract function names
    const functionMatches = text.match(/\b([a-zA-Z_$][a-zA-Z0-9_$]*)\s*\(/g);
    if (functionMatches) {
      functionMatches.forEach(match => {
        const funcName = match.replace(/\s*\($/, '');
        if (funcName.length > 1) {
          symbols.add(funcName);
        }
      });
    }
    
    // Extract class names (capitalized)
    const classMatches = text.match(/\b([A-Z][a-zA-Z0-9_$]*)\b/g);
    if (classMatches) {
      classMatches.forEach(match => {
        if (match.length > 1) {
          symbols.add(match);
        }
      });
    }
    
    // Extract variable names (common patterns)
    const varMatches = text.match(/\b(const|let|var)\s+([a-zA-Z_$][a-zA-Z0-9_$]*)/g);
    if (varMatches) {
      varMatches.forEach(match => {
        const varName = match.split(/\s+/)[1];
        if (varName && varName.length > 1) {
          symbols.add(varName);
        }
      });
    }
  }
  
  return symbols;
}

/**
 * Extract symbols from candidates
 */
function extractSymbolsFromCandidates(candidates: CandidateFile[]): Set<string> {
  const symbols = new Set<string>();
  
  for (const candidate of candidates) {
    if (candidate.symbols) {
      candidate.symbols.forEach(symbol => {
        if (symbol.symbol && symbol.symbol.length > 1) {
          symbols.add(symbol.symbol);
        }
      });
    }
  }
  
  return symbols;
}

/**
 * Check if a string looks like a file path
 */
function isFilePath(str: string): boolean {
  return str.includes('/') || str.includes('\\') || str.includes('.') && 
         (str.endsWith('.ts') || str.endsWith('.js') || str.endsWith('.tsx') || 
          str.endsWith('.jsx') || str.endsWith('.py') || str.endsWith('.java'));
}

/**
 * Check if a string looks like a symbol (function, class, variable)
 */
function isSymbol(str: string): boolean {
  return /^[a-zA-Z_$][a-zA-Z0-9_$]*$/.test(str) && str.length > 1 && str.length < 50;
}

/**
 * Normalize file path for comparison
 */
function normalizePath(path: string): string {
  return path.replace(/\\/g, '/').toLowerCase();
}

/**
 * Check if we need more context based on coverage analysis
 */
export function needsMoreContext(analysis: CoverageAnalysis): boolean {
  return analysis.coverageScore < 0.6 || analysis.hasSymbolGaps;
}

/**
 * Get priority files to extract based on analysis
 */
export function getPriorityFiles(analysis: CoverageAnalysis): string[] {
  const priority: string[] = [];
  
  // Add missing files first
  priority.push(...analysis.missingFiles.slice(0, 3));
  
  // Add files that might contain missing symbols
  // This is a simplified heuristic - in practice, you'd want more sophisticated matching
  const symbolFiles = analysis.missingSymbols.slice(0, 2).map(symbol => 
    `**/${symbol}*.ts` // Simple glob pattern
  );
  
  priority.push(...symbolFiles);
  
  return priority.slice(0, 5); // Limit to 5 files
}

