/**
 * NoSyncIoRule - Detects synchronous I/O in hot paths
 * 
 * Identifies blocking synchronous I/O operations (fs.*Sync, crypto.*Sync) in request handlers
 * or loops, which can kill server performance by blocking the Event Loop.
 */

import { Node, TypeChecker } from 'ts-morph';
import { AnalysisRule, AnalysisIssue } from '../../../AnalysisRule';

export class NoSyncIoRule implements AnalysisRule {
    id = "node-sync-io";

    inspect(node: Node, checker: TypeChecker): AnalysisIssue | null {
        if (!Node.isCallExpression(node)) return null;

        const expr = node.getExpression();
        const text = expr.getText();

        // 1. Check for *Sync calls
        if (!text.endsWith('Sync')) return null;

        // 2. Check if it's likely FS or Crypto (Node built-ins)
        // Heuristic: fs.read..., crypto.pbkdf2Sync..., execSync, readFileSync, etc.
        const isNodeBuiltIn = text.includes('fs.') || 
                             text.includes('crypto.') || 
                             text.includes('child_process.') ||
                             text.includes('readFileSync') ||
                             text.includes('writeFileSync') ||
                             text.includes('execSync') ||
                             text.includes('pbkdf2Sync');
        if (!isNodeBuiltIn) {
            return null;
        }

        // 3. Context Check: Are we in a "Hot Path"?
        // Check if inside loop first (works at any level)
        const insideLoop = node.getFirstAncestor(n => 
            Node.isForStatement(n) || Node.isWhileStatement(n) || Node.isForInStatement(n) || Node.isForOfStatement(n)
        );

        // Check if inside a function that looks like a Request Handler
        const parentFunction = node.getFirstAncestor(n => 
            Node.isFunctionDeclaration(n) || Node.isArrowFunction(n) || Node.isMethodDeclaration(n)
        );

        let isRequestHandler = false;
        if (parentFunction) {
            // Check params for (req, res) pattern
            const params = (parentFunction as any).getParameters().map((p: any) => p.getName());
            isRequestHandler = params.includes('req') || params.includes('res') || params.includes('next');
        }

        if (isRequestHandler || insideLoop) {
            return {
                ruleId: this.id,
                severity: 'critical',
                line: node.getStartLineNumber(),
                message: `Performance Killer: Synchronous I/O ('${text}') detected in a ${insideLoop ? 'loop' : 'request handler'}. This blocks the Event Loop. Use the async version.`,
                snippet: node.getText()
            };
        }
        return null;
    }
}















