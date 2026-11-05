/**
 * Implementation spec model persisted by the DataStore.
 */

import { BaseModel, Metadata } from './base-models';

export enum SpecStatus {
    PENDING = 'pending',
    IN_PROGRESS = 'in_progress',
    COMPLETED = 'completed',
    BLOCKED = 'blocked',
    CANCELLED = 'cancelled'
}

export enum SpecPriority {
    LOW = 'low',
    MEDIUM = 'medium',
    HIGH = 'high',
    CRITICAL = 'critical'
}

export interface Spec extends BaseModel {
    title: string;
    spec: string;
    status: SpecStatus;
    priority: SpecPriority;
    isCompleted: boolean;
    depth: number;
    parentSpecId: string | null;
    hasSubspecs: boolean;
    tags: string[];
    dependencies: string[];
    metadata: Metadata;
}
