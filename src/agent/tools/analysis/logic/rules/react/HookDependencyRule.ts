/**
 * HookDependencyRule - Detects missing React hook dependencies
 * 
 * Identifies variables used inside useEffect/useCallback/useMemo that are missing
 * from the dependency array, causing stale closures.
 */

import { Node, TypeChecker } from 'ts-morph';
import { AnalysisRule, AnalysisIssue } from '../../../AnalysisRule';

export class HookDependencyRule implements AnalysisRule {
    id = "react-missing-dep";

    inspect(node: Node, checker: TypeChecker): AnalysisIssue | null {
        // Look for useEffect / useCallback / useMemo
        if (!Node.isCallExpression(node)) return null;
        const expr = node.getExpression();
        const name = expr.getText();
        if (!['useEffect', 'useCallback', 'useMemo'].includes(name)) return null;

        const args = node.getArguments();
        if (args.length < 2) return null;

        // 1. Get the Dependency Array
        const depArray = args[1];
        if (!Node.isArrayLiteralExpression(depArray)) return null;
        
        const declaredDeps = new Set(depArray.getElements().map(e => e.getText()));

        // 2. Scan the Effect Body for usages
        const callback = args[0];
        const usedVariables = new Set<string>();

        try {
            callback.forEachDescendant(descendant => {
                if (Node.isIdentifier(descendant)) {
                    const varName = descendant.getText();
                    
                    // Skip console and other globals
                    if (varName === 'console' || varName === 'window' || varName === 'document' || varName === 'undefined' || varName === 'null') {
                        return;
                    }
                    
                    // Ignore property access property names (user.id -> we care about 'user', not 'id')
                    const parent = descendant.getParent();
                    if (Node.isPropertyAccessExpression(parent)) {
                        // Only track the object part, not the property name
                        if (parent.getExpression() === descendant) {
                            usedVariables.add(varName);
                        }
                    } else if (!Node.isPropertyAccessExpression(parent)) {
                        // Regular identifier usage - add it
                        usedVariables.add(varName);
                    }
                }
            });
        } catch (e) {
            // If symbol resolution fails, continue with what we have
        }

        // 3. Find missing deps
        const missing = Array.from(usedVariables).filter(v => !declaredDeps.has(v) && v !== 'console');

        if (missing.length > 0) {
            return {
                ruleId: this.id,
                severity: 'warning',
                line: node.getStartLineNumber(),
                message: `React Hook missing dependencies: [${missing.join(', ')}]. This causes stale closures.`,
                snippet: node.getText()
            };
        }
        return null;
    }
}















