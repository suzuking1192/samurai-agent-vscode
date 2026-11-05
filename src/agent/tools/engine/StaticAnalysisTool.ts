/**
 * StaticAnalysisTool - "Read it."
 * 
 * Analyzes code structure, complexity, and detects logical bugs (Data Flow).
 * Uses the Visitor Pattern to separate traversal from rule logic.
 */

import { z } from 'zod';
import { Project } from 'ts-morph';
import * as path from 'path';
import * as vscode from 'vscode';
import { ITool, ToolResult } from '../definitions/ITool';
import { StaticAnalysisToolSchema, StaticAnalysisParams } from '../definitions/ToolSchemas';
import { DataFlowWalker } from '../analysis/logic/DataFlowWalker';
import { ComplexityScanner } from '../analysis/complexity/ComplexityScanner';

export class StaticAnalysisTool implements ITool<StaticAnalysisParams> {
    name = "static-analysis";
    description = "Analyzes code structure, complexity, and detects logical bugs (Data Flow).";
    inputSchema = StaticAnalysisToolSchema;

    private project: Project;

    constructor() {
        // Initialize lightweight project
        this.project = new Project({
            useInMemoryFileSystem: true,
            skipAddingFilesFromTsConfig: true, // CRITICAL: Prevents hanging on large repos
            compilerOptions: { allowJs: true }
        });
    }

    async execute(params: StaticAnalysisParams): Promise<ToolResult> {
        const { filePath, mode, target, flowConfig } = params;

        // 1. Resolve Path
        const workspaceFolders = vscode.workspace.workspaceFolders;
        if (!workspaceFolders) return { success: false, summary: "No workspace open." };
        const absPath = path.resolve(workspaceFolders[0].uri.fsPath, filePath);

        // 2. Load File (Optimized: Overwrite if exists to ensure freshness)
        // In production, you might read from VS Code's dirty buffer here
        let sourceFile = this.project.getSourceFile(absPath);
        if (!sourceFile) {
            try {
                // For in-memory file system, we need to read the file content manually
                const fs = require('fs');
                if (fs.existsSync(absPath)) {
                    const fileContent = fs.readFileSync(absPath, 'utf-8');
                    sourceFile = this.project.createSourceFile(absPath, fileContent, { overwrite: true });
                } else {
                    sourceFile = this.project.addSourceFileAtPath(absPath);
                }
            } catch (e: any) {
                return { success: false, summary: `Failed to load file: ${e.message}` };
            }
        } else {
            // Refresh from file system if using real FS, otherwise update content
            try {
                const fs = require('fs');
                if (fs.existsSync(absPath)) {
                    const fileContent = fs.readFileSync(absPath, 'utf-8');
                    sourceFile.replaceWithText(fileContent);
                } else {
                    sourceFile.refreshFromFileSystemSync();
                }
            } catch (e) {
                // Fallback to refresh if read fails
                sourceFile.refreshFromFileSystemSync();
            }
        }

        try {
            // --- MODE A: METRICS ---
            if (mode === 'metrics') {
                const scanner = new ComplexityScanner();
                const result = scanner.analyze(sourceFile);
                return {
                    success: true,
                    summary: `Analyzed ${filePath}. Max Complexity: ${result.maxComplexity}.`,
                    structuredData: result
                };
            }

            // --- MODE B: SOURCE (Smart Read) ---
            if (mode === 'source') {
                if (target) {
                    const functionNode = sourceFile.getFunction(target);
                    const classNode = sourceFile.getClass(target);
                    const variableNode = sourceFile.getVariableDeclaration(target);
                    
                    const node = functionNode || classNode || variableNode;

                    if (!node) {
                        return { 
                            success: false, 
                            summary: `Symbol '${target}' not found in ${filePath}.` 
                        };
                    }

                    return {
                        success: true,
                        summary: `Extracted source for '${target}'`,
                        evidence: [{
                            file: filePath,
                            line: node.getStartLineNumber(),
                            text: node.getText(),
                            description: "Source Code"
                        }]
                    };
                } else {
                    // Return FULL TEXT instead of structure
                    // The Agent needs to read the logic, not just the signatures.
                    return {
                        success: true,
                        summary: `Full source code of ${path.basename(filePath)}`,
                        evidence: [{
                            file: filePath,
                            line: 1,
                            text: sourceFile.getFullText(),
                            description: "Full File Content"
                        }]
                    };
                }
            }

            // --- MODE C: FLOW (The Logic Checker) ---
            if (mode === 'flow') {
                const walker = new DataFlowWalker(this.project.getTypeChecker());

                // Filter rules if flowConfig specifies which ones to run
                if (flowConfig?.rules) {
                    walker.filterRules(flowConfig.rules);
                }

                const issues = walker.scan(sourceFile);

                if (issues.length === 0) {
                    return { 
                        success: true, 
                        summary: "No logic issues detected by static analysis rules." 
                    };
                }

                return {
                    success: true,
                    summary: `Found ${issues.length} logic issues.`,
                    evidence: issues.map(i => ({
                        file: filePath,
                        line: i.line,
                        text: i.snippet,
                        description: `[${i.severity.toUpperCase()}] ${i.ruleId}: ${i.message}`
                    }))
                };
            }

            return { success: false, summary: "Invalid mode." };

        } catch (error: any) {
            return { success: false, summary: `Analysis failed: ${error.message}` };
        }
    }
}


