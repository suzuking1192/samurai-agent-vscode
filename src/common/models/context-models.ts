/**
 * Code-context models produced by the code parser and consumed by extraction tools.
 */

import type { ExportInfo, ModuleBoundary } from '../../agent/code_parser/ExportAnalyzer';

export type CodeElementType =
    | 'function'
    | 'class'
    | 'method'
    | 'interface'
    | 'type_definition'
    | 'enum'
    | 'arrow_function'
    | 'constant'
    | 'annotation'
    | 'namespace'
    | 'struct'
    | 'export'
    | 'trait'
    | 'module'
    | 'impl';

export interface Documentation {
    summary?: string;
    params?: Array<{ name: string; type?: string; description: string }>;
    returns?: { type?: string; description: string };
    throws?: Array<{ type: string; description: string }>;
    examples?: string[];
    deprecated?: boolean;
    inlineComments?: string[];
}

export interface CodeElement {
    name: string;
    type: CodeElementType;
    lineStart: number;
    lineEnd: number;
    filePath: string;
    signature?: string;
    codeSnippet?: string;
    documentation?: Documentation;
    metadata?: { modifiers?: string[]; [key: string]: any };
}

export interface CodeRelationships {
    calls: Array<{ from: string; to: string; lineNumber: number }>;
    extends: Array<{ child: string; parent: string }>;
    implements: Array<{ class: string; interface: string }>;
    typeDependencies: Array<{ type: string; dependsOn: string[] }>;
}

export interface CodePatterns {
    architecturalLayer?: 'controller' | 'service' | 'repository' | 'model' | 'utility';
    frameworkPatterns?: string[];
    isEntryPoint?: boolean;
    dependencyInjection?: boolean;
}

export interface FileInfo {
    path: string;
    name: string;
    extension: string;
    language: string;
    size: number;
    elements: CodeElement[];
    lastModified: Date;
    relationships?: CodeRelationships;
    patterns?: CodePatterns;
    exports?: ExportInfo[];
    moduleBoundary?: ModuleBoundary;
}
