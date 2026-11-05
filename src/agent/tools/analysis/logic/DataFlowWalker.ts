/**
 * DataFlowWalker - The Logic Engine
 * 
 * Walks the AST and applies all registered analysis rules.
 * Implements the Visitor Pattern to separate traversal from rule logic.
 */

import { SourceFile, TypeChecker } from 'ts-morph';
import { AnalysisRule, AnalysisIssue } from '../AnalysisRule';

// Universal
import { AsyncRaceRule } from './rules/universal/AsyncRaceRule';
import { UnsafeMutationRule } from './rules/universal/UnsafeMutationRule';
import { NoAwaitInLoopRule } from './rules/universal/NoAwaitInLoopRule';
import { SwallowedErrorRule } from './rules/universal/SwallowedErrorRule';
import { NoAsyncForEachRule } from './rules/universal/NoAsyncForEachRule';
import { NoUnusedResultRule } from './rules/universal/NoUnusedResultRule';
import { AccidentalShadowingRule } from './rules/universal/AccidentalShadowingRule';
// Frameworks
import { NoSyncIoRule } from './rules/node/NoSyncIoRule';
import { HookDependencyRule } from './rules/react/HookDependencyRule';
import { ClientSecretLeakRule } from './rules/nextjs/ClientSecretLeakRule';

export class DataFlowWalker {
    private checker: TypeChecker;
    private rules: AnalysisRule[];

    constructor(checker: TypeChecker) {
        this.checker = checker;
        
        // The "Rulebook" - This is your Moat
        this.rules = [
            // Universal Core
            new AsyncRaceRule(),
            new UnsafeMutationRule(),
            
            // The "Beta Pack" Additions
            new NoAwaitInLoopRule(),
            new SwallowedErrorRule(),
            new NoAsyncForEachRule(),
            
            // Logic Rules
            new NoUnusedResultRule(),
            new AccidentalShadowingRule(),
            
            // Node.js
            new NoSyncIoRule(),
            
            // React / Next.js (Safe to run on non-React files; they just won't trigger)
            new HookDependencyRule(),
            new ClientSecretLeakRule()
        ];
    }

    /**
     * Scan a source file and return all issues found by the rules
     * 
     * @param sourceFile - The source file to analyze
     * @returns Array of analysis issues found
     */
    scan(sourceFile: SourceFile): AnalysisIssue[] {
        const issues: AnalysisIssue[] = [];

        // Efficiently walk every node in the file
        sourceFile.forEachDescendant(node => {
            for (const rule of this.rules) {
                try {
                    const issue = rule.inspect(node, this.checker);
                    if (issue) {
                        issues.push(issue);
                    }
                } catch (e) {
                    console.error(`Rule ${rule.id} failed on line ${node.getStartLineNumber()}`, e);
                }
            }
        });

        return issues;
    }

    /**
     * Filter rules by IDs (for selective rule execution)
     * 
     * @param ruleIds - Array of rule IDs to enable
     */
    filterRules(ruleIds: string[]): void {
        this.rules = this.rules.filter(rule => ruleIds.includes(rule.id));
    }
}
