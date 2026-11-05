/**
 * SearchUtils - Ranking and Teaser Extraction for Code Search
 * 
 * Provides intelligent ranking of search results and code snippet extraction
 * to help the Agent get high-quality signal, not just noise.
 */

import * as vscode from 'vscode';
import * as path from 'path';

export interface SearchMatch {
    uri: vscode.Uri;
    file: string; // Relative path
    line: number; // 0-based
    score: number;
}

export class SearchUtils {
    /**
     * Filters, Scores, and Sorts search results.
     * Returns top 10 matches to save tokens.
     */
    static rankResults(matches: { uri: vscode.Uri, file: string, line: number }[], query: string): SearchMatch[] {
        return matches
            .map(match => ({
                ...match,
                score: this.calculateScore(match, query)
            }))
            .sort((a, b) => b.score - a.score) // Descending
            .slice(0, 10);
    }

    private static calculateScore(match: { file: string }, query: string): number {
        let score = 0;
        const filename = path.basename(match.file).toLowerCase();
        const lowerQuery = query.toLowerCase();

        // 1. Filename Relevance
        if (filename === lowerQuery) score += 20; // Exact
        else if (filename.includes(lowerQuery)) score += 10; // Partial

        // 2. Folder Relevance
        if (match.file.includes('src/')) score += 5;
        
        // 3. Noise Reduction
        if (match.file.includes('node_modules')) score -= 50;
        if (match.file.includes('.vscode-test')) score -= 50;
        if (match.file.includes('.test.') || match.file.includes('.spec.')) score -= 5;
        if (match.file.endsWith('.json') || match.file.endsWith('.lock')) score -= 10;

        return score;
    }

    /**
     * Extracts a 5-line "Teaser" centered on the match line.
     * Uses VS Code's document provider to handle both open and closed files.
     */
    static async extractTeaser(uri: vscode.Uri, line: number): Promise<string> {
        try {
            const document = await vscode.workspace.openTextDocument(uri);
            const startLine = Math.max(0, line - 2);
            const endLine = Math.min(document.lineCount - 1, line + 2);
            
            const range = new vscode.Range(startLine, 0, endLine, 999);
            const text = document.getText(range).trim();
            
            return `(Lines ${startLine+1}-${endLine+1})...\n${text}\n...`;
        } catch (e) {
            return "(Unable to load preview)";
        }
    }
}















