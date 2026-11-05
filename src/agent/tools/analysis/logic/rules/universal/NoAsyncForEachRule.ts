/**
 * NoAsyncForEachRule - Detects async callbacks in forEach
 * 
 * Identifies async callbacks used in forEach() calls, which is a common bug
 * because forEach ignores Promise return values, causing race conditions.
 */

import { Node, TypeChecker } from 'ts-morph';
import { AnalysisRule, AnalysisIssue } from '../../../AnalysisRule';

export class NoAsyncForEachRule implements AnalysisRule {
    id = "no-async-foreach";

    inspect(node: Node, checker: TypeChecker): AnalysisIssue | null {
        // Look for CallExpressions (array.forEach(...))
        if (!Node.isCallExpression(node)) return null;

        // Check if method name is 'forEach'
        const expr = node.getExpression();
        if (!Node.isPropertyAccessExpression(expr)) return null;

        if (expr.getName() !== 'forEach') return null;

        // Check argument 0 (the callback)
        const args = node.getArguments();
        if (args.length === 0) return null;

        const callback = args[0];

        // Is the callback Async?
        let isAsync = false;
        if (Node.isArrowFunction(callback) || Node.isFunctionExpression(callback)) {
            isAsync = callback.isAsync();
        }

        if (isAsync) {
            return {
                ruleId: this.id,
                severity: 'critical',
                line: node.getStartLineNumber(),
                message: "Logic Bug: 'forEach' does not wait for async callbacks. The loop will finish before the operations complete. Use 'for...of' loop or 'Promise.all(arr.map(...))'.",
                snippet: node.getText()
            };
        }

        return null;
    }
}
