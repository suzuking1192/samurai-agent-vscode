/**
 * Models describing agent execution outcomes.
 */

import type { Metadata } from '../../common/models/base-models';

export interface AgentExecutionResult {
    success: boolean;
    message: string;
    metadata: Metadata;
}
