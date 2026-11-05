/**
 * Shared base shapes for persisted / traceable models.
 */

export interface BaseModel {
    id: string;
    createdAt: Date;
    updatedAt: Date;
}

export type Metadata = Record<string, any>;
