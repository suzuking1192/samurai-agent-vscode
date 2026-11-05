/**
 * AsyncRaceRule - Detects floating promises
 * 
 * Identifies Promise-returning function calls that are not properly handled,
 * which can lead to race conditions and unhandled promise rejections.
 */

import { Node, TypeChecker, SyntaxKind } from 'ts-morph';
import { AnalysisRule, AnalysisIssue } from '../../AnalysisRule';

export class AsyncRaceRule implements AnalysisRule {
    id = "async-race";

    inspect(node: Node, checker: TypeChecker): AnalysisIssue | null {
        // Only check Function Calls
        if (!Node.isCallExpression(node)) return null;

        // 1. Ask Compiler: Does this return a Promise?
        const returnType = checker.getTypeAtLocation(node);
        const typeString = returnType.getText();
        const symbol = returnType.getSymbol();
        
        // Check if the type is a Promise (handles Promise<T>, Promise<void>, etc.)
        // Check symbol name first, then fall back to type string pattern
        const isPromise = symbol?.getName() === "Promise" ||
                         typeString.includes("Promise<") ||
                         /^Promise\s*</.test(typeString.trim());

        if (!isPromise) {
            return null;
        }

        // 2. Ask AST: Is it being handled?
        const parent = node.getParent();

        // Safe usage patterns
        const isAwaited = Node.isAwaitExpression(parent);
        const isReturned = Node.isReturnStatement(parent) || 
                          (Node.isArrowFunction(parent) && parent.getBody() === node);
        const isAssigned = Node.isVariableDeclaration(parent) || 
                          Node.isPropertyAssignment(parent) ||
                          (Node.isBinaryExpression(parent) && parent.getOperatorToken().getKind() === SyntaxKind.EqualsToken);
        
        // Check if it's chained (e.g., db.save().then(...))
        // The CallExpression is the expression of a PropertyAccessExpression
        const isChained = Node.isPropertyAccessExpression(parent) && 
                         parent.getExpression() === node;
        
        // Robust void check: handle both VoidExpression and UnaryExpression with void operator
        let isVoided = Node.isVoidExpression(parent);
        if (!isVoided && Node.isUnaryExpression(parent)) {
            // Access the underlying TypeScript compiler node to check operator
            const compilerNode = (parent as any).compilerNode;
            if (compilerNode && compilerNode.operator === SyntaxKind.VoidKeyword) {
                isVoided = true;
            }
        }

        // If NOT handled, it's a floating promise
        if (!isAwaited && !isReturned && !isAssigned && !isChained && !isVoided) {
            return {
                ruleId: this.id,
                severity: 'critical',
                line: node.getStartLineNumber(),
                message: "Floating Promise detected. This async operation runs without being awaited, causing potential race conditions.",
                snippet: node.getText()
            };
        }

        return null;
    }
}















