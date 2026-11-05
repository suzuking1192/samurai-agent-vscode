/**
 * ClientSecretLeakRule - Detects secret leaks to client components
 * 
 * Identifies passing process.env secrets to Next.js client components,
 * which exposes them to the browser.
 */

import { Node, TypeChecker } from 'ts-morph';
import { AnalysisRule, AnalysisIssue } from '../../../AnalysisRule';

export class ClientSecretLeakRule implements AnalysisRule {
    id = "nextjs-secret-leak";

    inspect(node: Node, checker: TypeChecker): AnalysisIssue | null {
        // Look for JSX Attributes: <Component token={process.env.KEY} />
        if (!Node.isJsxAttribute(node)) return null;

        const initializer = node.getInitializer();
        if (!initializer) return null;

        // 1. Is the value sensitive? (Heuristic)
        const valueText = initializer.getText();
        const attrName = node.getNameNode()?.getText() || '';
        if (!valueText.includes('process.env') && !/secret|key|token/i.test(attrName)) return null;

        // 2. Is the Component a Client Component?
        // Check if the current file has "use client" directive
        const sourceFile = node.getSourceFile();
        const fileText = sourceFile.getFullText();
        const isClientComponent = fileText.includes("'use client'") || fileText.includes('"use client"');
        
        if (isClientComponent) {
            return {
                ruleId: this.id,
                severity: 'critical',
                line: node.getStartLineNumber(),
                message: `Security Risk: Passing '${attrName}' (likely a secret) to a Client Component. This will leak to the browser.`,
                snippet: node.getText()
            };
        }
        return null;
    }
}















