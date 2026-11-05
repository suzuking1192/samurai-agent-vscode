/**
 * NoAwaitInLoopRule - Detects await inside loops
 * 
 * Identifies await expressions inside loops (for, for-of, while, do-while),
 * which causes serial execution instead of parallel execution, leading to
 * significant performance degradation.
 */

import { Node, TypeChecker } from 'ts-morph';
import { AnalysisRule, AnalysisIssue } from '../../../AnalysisRule';

export class NoAwaitInLoopRule implements AnalysisRule {
    id = "no-await-in-loop";

    inspect(node: Node, checker: TypeChecker): AnalysisIssue | null {
        // Look for 'await' keyword
        if (!Node.isAwaitExpression(node)) return null;

        // Traverse up to find if we are inside a Loop
        let parent = node.getParent();

        while (parent) {
            // Stop if we hit a function boundary (await inside a function DEFINED in a loop is fine usually)
            if (Node.isFunctionLikeDeclaration(parent)) break;

            if (Node.isForStatement(parent) || 
                Node.isForOfStatement(parent) || 
                Node.isWhileStatement(parent) ||
                Node.isDoStatement(parent)) {
                
                return {
                    ruleId: this.id,
                    severity: 'warning',
                    line: node.getStartLineNumber(),
                    message: "Performance Alert: 'await' inside a loop causes serial execution (one by one). This is 10x slower than parallel execution. Use 'Promise.all()' or 'map' instead.",
                    snippet: node.getText()
                };
            }
            const nextParent = parent.getParent();
            if (!nextParent) break;
            parent = nextParent;
        }

        return null;
    }
}
