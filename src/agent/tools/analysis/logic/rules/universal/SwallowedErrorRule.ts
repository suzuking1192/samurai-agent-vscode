/**
 * SwallowedErrorRule - Detects swallowed errors
 * 
 * Identifies empty catch blocks or catch blocks that don't use the error variable,
 * which causes silent failures and makes debugging impossible.
 */

import { Node, TypeChecker } from 'ts-morph';
import { AnalysisRule, AnalysisIssue } from '../../../AnalysisRule';

export class SwallowedErrorRule implements AnalysisRule {
    id = "swallowed-error";

    inspect(node: Node, checker: TypeChecker): AnalysisIssue | null {
        // Look for catch(e) { ... }
        if (!Node.isCatchClause(node)) return null;

        const block = node.getBlock();
        const statements = block.getStatements();
        const errorVar = node.getVariableDeclaration()?.getName();
        const blockText = block.getText().trim();

        // 1. Completely Empty (no statements at all)?
        // Check if block is truly empty (just {} or has only whitespace/braces)
        if (statements.length === 0) {
            // Check if block has any non-whitespace content (like comments)
            // Block text typically looks like "{ ... }" - if it's just "{}" or "{ }", it's empty
            const contentBetweenBraces = blockText.replace(/^\s*\{\s*/, '').replace(/\s*\}\s*$/, '').trim();
            
            // If there's content (like comments), it's not completely empty - treat as unused error variable
            if (contentBetweenBraces.length > 0 && errorVar) {
                // Has content (comments) but no statements - error variable is unused
                return {
                    ruleId: this.id,
                    severity: 'warning',
                    line: node.getStartLineNumber(),
                    message: `Silent Failure Risk: The error variable '${errorVar}' is declared but never used in the catch block.`,
                    snippet: block.getText()
                };
            }
            
            // Truly empty (no content at all)
            return {
                ruleId: this.id,
                severity: 'critical',
                line: node.getStartLineNumber(),
                message: "Silent Failure Detected: Empty catch block. Errors are being ignored completely, making debugging impossible.",
                snippet: node.getText()
            };
        }

        // 2. Contains statements but error variable is unused?
        // We check if the block actually DOES anything with the error variable.
        if (errorVar) {
            // Check if error variable is actually used in any statement
            let errorVarUsed = false;
            
            for (const stmt of statements) {
                // Get all identifiers in the statement
                const identifiers: string[] = [];
                stmt.forEachDescendant((desc) => {
                    if (Node.isIdentifier(desc)) {
                        identifiers.push(desc.getText());
                    }
                });
                
                // Check if the error variable is referenced
                if (identifiers.includes(errorVar)) {
                    errorVarUsed = true;
                    break;
                }
            }

            if (!errorVarUsed) {
                return {
                    ruleId: this.id,
                    severity: 'warning',
                    line: node.getStartLineNumber(),
                    message: `Silent Failure Risk: The error variable '${errorVar}' is declared but never used in the catch block.`,
                    snippet: block.getText()
                };
            }
        }

        return null;
    }
}
