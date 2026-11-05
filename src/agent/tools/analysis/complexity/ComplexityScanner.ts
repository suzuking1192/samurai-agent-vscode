/**
 * ComplexityScanner - The Metrics Engine
 * 
 * Calculates cyclomatic complexity for functions and class methods.
 * Uses deterministic counting of specific syntax constructs.
 */

import { SourceFile, SyntaxKind, Node } from 'ts-morph';

export interface FunctionComplexity {
    name: string;
    line: number;
    complexity: number;
}

export interface ComplexityResult {
    maxComplexity: number;
    functions: FunctionComplexity[];
}

export class ComplexityScanner {
    analyze(sourceFile: SourceFile): ComplexityResult {
        const functions = [
            ...sourceFile.getFunctions(),
            ...sourceFile.getClasses().flatMap(c => c.getMethods())
        ];

        const metrics = functions.map(func => ({
            name: func.getName() || 'anonymous',
            line: func.getStartLineNumber(),
            complexity: this.calculateCyclomaticComplexity(func)
        }));

        // Sort by most complex first
        return {
            maxComplexity: Math.max(...metrics.map(m => m.complexity), 0),
            functions: metrics.sort((a, b) => b.complexity - a.complexity).slice(0, 10)
        };
    }

    private calculateCyclomaticComplexity(node: Node): number {
        // Start with base complexity of 1
        let complexity = 1;

        node.forEachDescendant(descendant => {
            const kind = descendant.getKind();

            switch (kind) {
                case SyntaxKind.IfStatement:
                case SyntaxKind.ForStatement:
                case SyntaxKind.ForInStatement:
                case SyntaxKind.ForOfStatement:
                case SyntaxKind.WhileStatement:
                case SyntaxKind.DoStatement:
                case SyntaxKind.CaseClause:
                case SyntaxKind.CatchClause:
                case SyntaxKind.ConditionalExpression: // Ternary ? :
                    complexity++;
                    break;

                case SyntaxKind.BinaryExpression:
                    // Count logical operators (&&, ||) as branching constructs
                    const binaryExpr = descendant.asKind(SyntaxKind.BinaryExpression);
                    if (binaryExpr) {
                        const operator = binaryExpr.getOperatorToken().getKind();
                        if (operator === SyntaxKind.AmpersandAmpersandToken || 
                            operator === SyntaxKind.BarBarToken) {
                            complexity++;
                        }
                    }
                    break;
            }
        });

        return complexity;
    }
}















