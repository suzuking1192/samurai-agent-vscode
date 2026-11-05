/**
 * Long-term memory entry persisted by the DataStore.
 */

import { BaseModel, Metadata } from './base-models';

export interface Memory extends BaseModel {
    title?: string;
    content?: string;
    tags?: string[];
    metadata?: Metadata;
}
