/**
 * UnsafeMutationRule - Detects unsafe in-place mutations
 * 
 * Identifies array/object mutations (sort, reverse, splice, etc.) on function parameters
 * or imported values, which can cause silent bugs due to shared state.
 */

import { Node, TypeChecker } from 'ts-morph';
import { AnalysisRule, AnalysisIssue } from '../../../AnalysisRule';

export class UnsafeMutationRule implements AnalysisRule {
    id = "unsafe-mutation";
    // Methods that mutate in-place
    private mutators = new Set(['sort', 'reverse', 'splice', 'push', 'pop', 'shift', 'unshift', 'fill']);

    inspect(node: Node, checker: TypeChecker): AnalysisIssue | null {
        if (!Node.isCallExpression(node)) return null;

        const expr = node.getExpression();
        if (!Node.isPropertyAccessExpression(expr)) return null;

        const methodName = expr.getName();
        if (!this.mutators.has(methodName)) return null;

        // Check if the object being mutated is a Parameter or Import (Shared State)
        const objectNode = expr.getExpression();
        const symbol = checker.getSymbolAtLocation(objectNode);
        
        if (symbol) {
            const declarations = symbol.getDeclarations();
            const isParam = declarations.some(d => Node.isParameterDeclaration(d));
            const isImport = declarations.some(d => Node.isImportSpecifier(d));

            if (isParam || isImport) {
                return {
                    ruleId: this.id,
                    severity: 'warning',
                    line: node.getStartLineNumber(),
                    message: `Unsafe Mutation: '${methodName}' modifies the array in-place. Since '${objectNode.getText()}' is a ${isParam ? 'function parameter' : 'imported value'}, this causes side effects. Use '[...arr].${methodName}()' or 'to${methodName.charAt(0).toUpperCase() + methodName.slice(1)}()'.`,
                    snippet: node.getText()
                };
            }
        }
        return null;
    }
}















