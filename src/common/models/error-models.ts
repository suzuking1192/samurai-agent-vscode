/**
 * Structured error model used for telemetry and diagnostics.
 */

import { BaseModel } from './base-models';

export enum ErrorSeverity {
    LOW = 'low',
    MEDIUM = 'medium',
    HIGH = 'high',
    CRITICAL = 'critical'
}

export enum ErrorCategory {
    USER = 'user',
    SYSTEM = 'system',
    NETWORK = 'network',
    VALIDATION = 'validation',
    LLM = 'llm',
    PERSISTENCE = 'persistence'
}

export interface ErrorModel extends BaseModel {
    code: string;
    message: string;
    category: ErrorCategory;
    severity: ErrorSeverity;
    context: Record<string, any>;
    stack?: string;
    userId?: string;
    sessionId?: string;
    requestId?: string;
    resolved: boolean;
}
