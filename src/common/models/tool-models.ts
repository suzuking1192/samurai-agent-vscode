/**
 * Tool definition / execution models shared by agent tools.
 */

import { BaseModel, Metadata } from './base-models';
import type { CodeElement } from './context-models';

export interface ToolParameterSchema {
    type: string;
    properties: Record<string, any>;
    required?: string[];
    additionalProperties?: boolean;
}

export interface ToolDefinition extends BaseModel {
    name: string;
    description: string;
    parameters: ToolParameterSchema;
    required: string[];
    category: string;
    enabled: boolean;
    metadata: Metadata;
}

export interface ToolExecutionResult<T = any> {
    success: boolean;
    result?: T;
    error?: string;
    executionTime?: number;
    metadata?: Metadata;
    elements?: Array<{
        name: string;
        type: string;
        lineStart: number;
        filePath: string;
        signature?: string;
    }>;
}

export interface ExtractCodeToolResultPayload {
    relevantCodeElements: Array<{
        path: string;
        elements: CodeElement[];
        snippet: string;
    }>;
    files?: Array<{
        path: string;
        snippet: string;
    }>;
}
