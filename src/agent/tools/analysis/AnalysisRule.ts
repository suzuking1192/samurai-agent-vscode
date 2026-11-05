/**
 * AnalysisRule - Interface for all static analysis rules
 * 
 * Defines the contract that all analysis rules must follow.
 * Uses the Visitor Pattern to separate rule logic from AST traversal.
 */

import { Node, TypeChecker } from 'ts-morph';

/**
 * Represents a code issue found by an analysis rule
 */
export interface AnalysisIssue {
    ruleId: string;
    severity: 'critical' | 'warning' | 'info';
    line: number;
    message: string;
    snippet: string;
}

/**
 * Base interface for all static analysis rules
 */
export interface AnalysisRule {
    id: string;

    /**
     * Inspects a single AST node.
     * Returns an issue if a bug is found, otherwise null.
     * 
     * @param node - The AST node to inspect
     * @param checker - The TypeScript type checker for type queries
     * @returns An AnalysisIssue if a problem is found, null otherwise
     */
    inspect(node: Node, checker: TypeChecker): AnalysisIssue | null;
}















