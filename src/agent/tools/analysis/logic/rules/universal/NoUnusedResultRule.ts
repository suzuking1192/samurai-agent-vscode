/**
 * NoUnusedResultRule - Detects unused return values from pure methods
 * 
 * Identifies calls to pure methods (map, filter, slice, etc.) where the result
 * is not used, which often indicates the user expected mutation but got a new value.
 */

import { Node, TypeChecker } from 'ts-morph';
import { AnalysisRule, AnalysisIssue } from '../../../AnalysisRule';

export class NoUnusedResultRule implements AnalysisRule {
    id = "no-unused-result";
    
    // Methods that return a value and are pure (side-effect free-ish), so ignoring the result is usually a bug
    private pureMethods = new Set(['map', 'filter', 'reduce', 'slice', 'concat', 'toUpperCase', 'toLowerCase', 'trim']);

    inspect(node: Node, checker: TypeChecker): AnalysisIssue | null {
        // We look for method calls: arr.map(...)
        if (!Node.isCallExpression(node)) return null;

        const expr = node.getExpression();
        if (!Node.isPropertyAccessExpression(expr)) return null;
        
        const methodName = expr.getName();
        if (!this.pureMethods.has(methodName)) return null;

        // Check context: Is the result used?
        // If the parent is an ExpressionStatement, it means the return value is dropped.
        const parent = node.getParent();
        if (Node.isExpressionStatement(parent)) {
            return {
                ruleId: this.id,
                severity: 'warning',
                line: node.getStartLineNumber(),
                message: `Logic Bug: The result of '${methodName}' is unused. This method returns a new value and does NOT modify the original object. Did you mean to assign it to a variable or use 'forEach'?`,
                snippet: node.getText()
            };
        }

        return null;
    }
}
