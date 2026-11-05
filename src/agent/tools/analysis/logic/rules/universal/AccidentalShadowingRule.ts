/**
 * AccidentalShadowingRule - Detects variable shadowing
 * 
 * Identifies variable declarations that shadow outer-scope variables,
 * which can cause "wrong variable" bugs where the user expects to update
 * an outer variable but is actually updating a local one.
 */

import { Node, TypeChecker } from 'ts-morph';
import { AnalysisRule, AnalysisIssue } from '../../../AnalysisRule';

export class AccidentalShadowingRule implements AnalysisRule {
    id = "accidental-shadowing";

    inspect(node: Node, checker: TypeChecker): AnalysisIssue | null {
        // Look for Variable Declarations
        if (!Node.isVariableDeclaration(node)) return null;

        const name = node.getName();
        const startLine = node.getStartLineNumber();

        // Walk up the scope to find if this name exists above
        let parent: Node | undefined = node.getParent();
        while (parent) {
            // Stop if we hit the source file root
            if (Node.isSourceFile(parent)) break;

            // Check if parent scope has a variable with the same name
            // (Simplified check - robust version uses Symbols, but this is fast/heuristic)
            if (Node.isBlock(parent) || Node.isFunctionLikeDeclaration(parent)) {
                // In a real implementation, you'd iterate locals or check symbols.
                // For a lightweight rule, we check if the checker sees another symbol with the same name in the parent scope.
                try {
                    // Use TypeChecker to find symbols in scope
                    const compilerChecker = (checker as any).compilerObject;
                    if (compilerChecker && compilerChecker.getSymbolsInScope) {
                        const compilerNode = (parent as any).compilerNode;
                        if (compilerNode) {
                            const sourceFile = parent.getSourceFile().compilerNode;
                            const symbolsInScope = compilerChecker.getSymbolsInScope(
                                compilerNode,
                                1 // SymbolFlags.Value (variables, functions, etc.)
                            );
                            
                            const conflictingSymbol = symbolsInScope?.find(
                                (s: any) => s.getName() === name
                            );
                            
                            if (conflictingSymbol) {
                                const decls = conflictingSymbol.getDeclarations();
                                if (decls && decls.length > 0) {
                                    const outerDecl = decls[0];
                                    try {
                                        const outerNode = parent.getSourceFile().getDescendantAtPos(outerDecl.getStart());
                                        
                                        if (outerNode && Node.isVariableDeclaration(outerNode)) {
                                            const outerLine = outerNode.getStartLineNumber();
                                            if (outerLine < startLine && outerNode !== node) {
                                                return {
                                                    ruleId: this.id,
                                                    severity: 'info',
                                                    line: startLine,
                                                    message: `Shadowing Detected: Variable '${name}' hides a variable with the same name declared on line ${outerLine}. This often causes "Silent Bugs" where you update the wrong variable.`,
                                                    snippet: node.getText()
                                                };
                                            }
                                        }
                                    } catch (e) {
                                        // If descendant lookup fails, continue
                                    }
                                }
                            }
                        }
                    }
                } catch (e) {
                    // If symbol lookup fails, silently continue (heuristic-based detection)
                }
            }

            const nextParent = parent.getParent();
            if (!nextParent) break;
            parent = nextParent;
        }

        return null;
    }
}
