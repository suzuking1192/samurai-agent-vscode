/**
 * Chat / session models persisted by the DataStore and exchanged with the webview.
 */

import { BaseModel, Metadata } from './base-models';

export enum MessageType {
    USER = 'user',
    ASSISTANT = 'assistant',
    SYSTEM = 'system'
}

export enum SessionStatus {
    ACTIVE = 'active',
    ARCHIVED = 'archived'
}

export enum UserIntentEnum {
    PURE_DISCUSSION = 'pure_discussion',
    BUG_ANALYSIS = 'bug_analysis'
}

export type ChatRole = 'user' | 'assistant' | 'system';

export interface ChatMessage extends BaseModel {
    sessionId: string;
    projectId: string;
    type: MessageType;
    content: string;
    role: ChatRole;
    metadata: Metadata;
    parentMessageId?: string;
    isEdited: boolean;
    specClarificationData?: unknown;
    interactiveQuestions?: unknown;
}

export type CreateChatMessageRequest = Pick<ChatMessage, 'sessionId' | 'projectId' | 'content' | 'role'> &
    Partial<Pick<ChatMessage, 'id' | 'type' | 'metadata' | 'parentMessageId' | 'specClarificationData' | 'interactiveQuestions'>>;

export interface SessionMetadata extends Metadata {
    projectId: string;
    model?: string;
    mode?: string;
    connectedCodebasePath?: string;
}

export interface Session extends BaseModel {
    title: string;
    /** Optional session mode discriminator (e.g. 'code-review'). */
    type?: string;
    status: SessionStatus;
    messageCount: number;
    totalTokens: number;
    totalCost: number;
    lastMessageAt: Date;
    tags: string[];
    metadata: SessionMetadata;
    codeContextIds: string[];
    previous_session_intent: UserIntentEnum;
    pinnedFilePaths?: string[];
    currentArtifact?: Metadata;
}

export interface CreateSessionRequest {
    projectId: string;
    title?: string;
    tags?: string[];
    model?: string;
    metadata?: Metadata;
}

export interface DebugStatusUpdateEvent {
    type: 'debugStatusUpdate';
    payload: {
        sessionId: string;
        stepId: string;
        category: 'phase' | 'thought' | 'tool';
        message: string;
        timestamp: number;
    };
}
