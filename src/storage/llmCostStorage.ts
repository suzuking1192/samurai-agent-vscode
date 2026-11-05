/**
 * LLM Cost Storage
 * 
 * Manages persistence of LLM cost records using VS Code's global state.
 * Stores cost data globally across all workspaces for consistent tracking and limit enforcement.
 */

import * as vscode from 'vscode';

export interface LLMCostRecord {
    id: string;
    timestamp: string; // ISO 8601 format
    provider: string;
    model: string;
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
    cost: number;
    sessionId?: string;
    requestId?: string;
    isBetaUserActive?: boolean; // Flag for beta user calls
}

interface StoredCostData {
    records: LLMCostRecord[];
    totalCost: number;
    lastUpdated: string;
}

const STORAGE_KEY = 'samuraiAgent.llmCostRecords';
const MAX_RECORDS = 1000; // Prevent memento bloat by limiting stored records

export class LLMCostStorage {
    private context: vscode.ExtensionContext;
    private sessionCosts: Map<string, number> = new Map();
    
    constructor(context: vscode.ExtensionContext) {
        this.context = context;
    }
    
    /**
     * Migrate cost data from workspaceState to globalState for backward compatibility.
     * This ensures users don't lose their cost history when upgrading.
     * Migration is idempotent - safe to call multiple times.
     */
    async migrateFromWorkspaceState(): Promise<void> {
        try {
            // Guard against null/undefined context
            if (!this.context || !this.context.globalState || !this.context.workspaceState) {
                console.warn('[LLM Cost Storage] Context unavailable, skipping migration');
                return;
            }

            // Check if globalState already has data - migration already done
            const globalData = this.context.globalState.get<StoredCostData>(STORAGE_KEY);
            if (globalData) {
                console.log('[LLM Cost Storage] Migration already completed (globalState has data)');
                return;
            }

            // Check if workspaceState has data to migrate
            const workspaceData = this.context.workspaceState.get<StoredCostData>(STORAGE_KEY);
            if (!workspaceData) {
                console.log('[LLM Cost Storage] No workspace data to migrate');
                return;
            }

            // Validate workspace data before migration
            if (!this.validateStoredData(workspaceData)) {
                console.warn('[LLM Cost Storage] Workspace data is invalid, attempting repair before migration');
                const repaired = this.repairStoredData(workspaceData);
                if (!repaired) {
                    console.error('[LLM Cost Storage] Failed to repair workspace data, skipping migration');
                    return;
                }
                
                // Migrate repaired data
                await this.context.globalState.update(STORAGE_KEY, repaired);
                console.log(`[LLM Cost Storage] Migrated ${repaired.records.length} cost records from workspaceState to globalState (repaired)`);
            } else {
                // Migrate valid data
                await this.context.globalState.update(STORAGE_KEY, workspaceData);
                console.log(`[LLM Cost Storage] Migrated ${workspaceData.records.length} cost records from workspaceState to globalState`);
            }
        } catch (error) {
            console.error('[LLM Cost Storage] Migration failed:', error);
            // Don't throw - migration failure shouldn't block extension activation
        }
    }
    
    /**
     * Save a new LLM cost record
     * @param record - Cost record to save
     */
    async saveRecord(record: LLMCostRecord): Promise<void> {
        try {
            const currentData = this.loadStoredData();
            
            // Add new record
            currentData.records.push(record);
            
            // Update total cost (exclude beta costs)
            if (record.isBetaUserActive !== true) {
                currentData.totalCost += record.cost;
            }
            currentData.lastUpdated = new Date().toISOString();
            
            // Trim old records if exceeding max
            if (currentData.records.length > MAX_RECORDS) {
                const removedRecords = currentData.records.splice(0, currentData.records.length - MAX_RECORDS);
                // Only subtract non-beta costs from totalCost
                const removedCost = removedRecords
                    .filter(r => r.isBetaUserActive !== true)
                    .reduce((sum, r) => sum + r.cost, 0);
                currentData.totalCost -= removedCost;
            }
            
            // Update session cost tracking (exclude beta costs)
            if (record.sessionId && record.isBetaUserActive !== true) {
                const currentSessionCost = this.sessionCosts.get(record.sessionId) || 0;
                this.sessionCosts.set(record.sessionId, currentSessionCost + record.cost);
            }
            
            // Save to global state (verify context is still valid)
            if (!this.context || !this.context.globalState) {
                const error = new Error('Context or globalState is unavailable when attempting to save record');
                console.error('[LLM Cost Storage] Failed to save record:', error);
                throw error;
            }
            
            await this.context.globalState.update(STORAGE_KEY, currentData);
        } catch (error) {
            console.error('[LLM Cost Storage] Failed to save record:', error);
            throw error;
        }
    }
    
    /**
     * Get all stored cost records
     * @returns Array of cost records
     */
    getRecords(): LLMCostRecord[] {
        const data = this.loadStoredData();
        return data.records;
    }
    
    /**
     * Get records for a specific session
     * @param sessionId - Session ID to filter by
     * @returns Array of cost records for the session
     */
    getRecordsBySession(sessionId: string): LLMCostRecord[] {
        const data = this.loadStoredData();
        return data.records.filter(r => r.sessionId === sessionId);
    }
    
    /**
     * Get total cost across all sessions
     * @returns Total cost in USD
     */
    getTotalCost(): number {
        const data = this.loadStoredData();
        return data.totalCost;
    }
    
    /**
     * Get cost for a specific session (excludes beta costs)
     * @param sessionId - Session ID
     * @returns Session cost in USD
     */
    getSessionCost(sessionId: string): number {
        // Use in-memory cache if available
        if (this.sessionCosts.has(sessionId)) {
            return this.sessionCosts.get(sessionId)!;
        }
        
        // Calculate from stored records (exclude beta costs)
        const sessionRecords = this.getRecordsBySession(sessionId);
        const sessionCost = sessionRecords
            .filter(r => r.isBetaUserActive !== true)
            .reduce((sum, record) => sum + record.cost, 0);
        
        // Cache for future use
        this.sessionCosts.set(sessionId, sessionCost);
        
        return sessionCost;
    }
    
    /**
     * Get cost for the current VS Code session (since extension activation, excludes beta costs)
     * @returns Current session cost in USD
     */
    getCurrentSessionCost(): number {
        // Get all records from today's session
        const now = new Date();
        const sessionStart = this.getSessionStartTime();
        
        const data = this.loadStoredData();
        const sessionRecords = data.records.filter(r => {
            const recordTime = new Date(r.timestamp);
            return recordTime >= sessionStart && r.isBetaUserActive !== true;
        });
        
        return sessionRecords.reduce((sum, record) => sum + record.cost, 0);
    }
    
    /**
     * Get cost for the current month (excludes beta costs)
     * @returns Current month's cost in USD
     */
    getCurrentMonthCost(): number {
        const now = new Date();
        const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);
        
        const data = this.loadStoredData();
        const monthRecords = data.records.filter(r => {
            const recordTime = new Date(r.timestamp);
            return recordTime >= monthStart && r.isBetaUserActive !== true;
        });
        
        return monthRecords.reduce((sum, record) => sum + record.cost, 0);
    }
    
    /**
     * Clear all stored cost records
     */
    async clearRecords(): Promise<void> {
        try {
            // Verify context is still valid
            if (!this.context || !this.context.globalState) {
                const error = new Error('Context or globalState is unavailable when attempting to clear records');
                console.error('[LLM Cost Storage] Failed to clear records:', error);
                throw error;
            }
            
            await this.context.globalState.update(STORAGE_KEY, undefined);
            this.sessionCosts.clear();
        } catch (error) {
            console.error('[LLM Cost Storage] Failed to clear records:', error);
            throw error;
        }
    }
    
    /**
     * Get statistics about stored costs
     */
    getStatistics(): {
        totalRecords: number;
        totalCost: number;
        currentSessionCost: number;
        currentMonthCost: number;
        oldestRecord?: string;
        newestRecord?: string;
    } {
        const data = this.loadStoredData();
        const currentSessionCost = this.getCurrentSessionCost();
        const currentMonthCost = this.getCurrentMonthCost();
        
        return {
            totalRecords: data.records.length,
            totalCost: data.totalCost,
            currentSessionCost,
            currentMonthCost,
            oldestRecord: data.records.length > 0 ? data.records[0].timestamp : undefined,
            newestRecord: data.records.length > 0 ? data.records[data.records.length - 1].timestamp : undefined,
        };
    }
    
    /**
     * Load stored data from global state with validation and corruption tolerance
     * @private
     */
    private loadStoredData(): StoredCostData {
        // Guard against null/undefined context or globalState
        if (!this.context || !this.context.globalState) {
            console.error('[LLM Cost Storage] Context or globalState is unavailable. Returning default data.');
            return {
                records: [],
                totalCost: 0,
                lastUpdated: new Date().toISOString(),
            };
        }

        const stored = this.context.globalState.get<StoredCostData>(STORAGE_KEY);
        
        if (!stored) {
            return {
                records: [],
                totalCost: 0,
                lastUpdated: new Date().toISOString(),
            };
        }
        
        // Validate stored data structure
        if (this.validateStoredData(stored)) {
            return stored;
        }
        
        // Attempt to repair corrupted data
        const repaired = this.repairStoredData(stored);
        if (repaired) {
            console.warn('[LLM Cost Storage] Repaired corrupted data structure');
            // Save repaired data back to storage (only if context is still valid)
            if (this.context && this.context.globalState) {
                Promise.resolve(this.context.globalState.update(STORAGE_KEY, repaired)).catch((error: any) => {
                    console.error('[LLM Cost Storage] Failed to save repaired data:', error);
                });
            }
            return repaired;
        }
        
        // If repair fails, log warning and return default structure
        console.warn('[LLM Cost Storage] Data corruption detected, resetting to default structure');
        const defaultData = {
            records: [],
            totalCost: 0,
            lastUpdated: new Date().toISOString(),
        };
        
        // Clear corrupted data from storage (only if context is still valid)
        if (this.context && this.context.globalState) {
            Promise.resolve(this.context.globalState.update(STORAGE_KEY, defaultData)).catch((error: any) => {
                console.error('[LLM Cost Storage] Failed to reset corrupted data:', error);
            });
        }
        
        return defaultData;
    }
    
    /**
     * Validate that stored data has the correct structure and types
     * @private
     */
    private validateStoredData(data: any): data is StoredCostData {
        if (!data || typeof data !== 'object') {
            return false;
        }
        
        // Check that records is an array
        if (!Array.isArray(data.records)) {
            return false;
        }
        
        // Validate that totalCost is a number
        if (typeof data.totalCost !== 'number' || isNaN(data.totalCost)) {
            return false;
        }
        
        // Validate that lastUpdated is a string
        if (typeof data.lastUpdated !== 'string') {
            return false;
        }
        
        // Validate each record in the array (tolerate partial corruption by checking structure)
        for (const record of data.records) {
            if (!this.validateRecord(record)) {
                return false;
            }
        }
        
        return true;
    }
    
    /**
     * Validate that a record has the correct structure
     * @private
     */
    private validateRecord(record: any): record is LLMCostRecord {
        if (!record || typeof record !== 'object') {
            return false;
        }
        
        // Required fields
        if (typeof record.id !== 'string' ||
            typeof record.timestamp !== 'string' ||
            typeof record.provider !== 'string' ||
            typeof record.model !== 'string' ||
            typeof record.promptTokens !== 'number' ||
            typeof record.completionTokens !== 'number' ||
            typeof record.totalTokens !== 'number' ||
            typeof record.cost !== 'number') {
            return false;
        }
        
        // Optional fields must be correct type if present
        if (record.sessionId !== undefined && typeof record.sessionId !== 'string') {
            return false;
        }
        if (record.requestId !== undefined && typeof record.requestId !== 'string') {
            return false;
        }
        if (record.isBetaUserActive !== undefined && typeof record.isBetaUserActive !== 'boolean') {
            return false;
        }
        
        // Validate numeric values are not NaN
        if (isNaN(record.promptTokens) || 
            isNaN(record.completionTokens) || 
            isNaN(record.totalTokens) || 
            isNaN(record.cost)) {
            return false;
        }
        
        return true;
    }
    
    /**
     * Attempt to repair corrupted data by extracting valid records and fixing structure
     * @private
     */
    private repairStoredData(data: any): StoredCostData | null {
        if (!data || typeof data !== 'object') {
            return null;
        }
        
        const repaired: StoredCostData = {
            records: [],
            totalCost: 0,
            lastUpdated: new Date().toISOString(),
        };
        
        // Try to extract valid records from corrupted data
        if (Array.isArray(data.records)) {
            const validRecords = data.records.filter((record: any) => this.validateRecord(record));
            repaired.records = validRecords;
            
            // Recalculate totalCost from valid records
            repaired.totalCost = validRecords.reduce((sum: number, record: LLMCostRecord) => sum + record.cost, 0);
            
            // Preserve lastUpdated if it's valid, otherwise use current time
            if (typeof data.lastUpdated === 'string') {
                repaired.lastUpdated = data.lastUpdated;
            }
            
            // Log if we filtered out invalid records
            if (validRecords.length !== data.records.length) {
                console.warn(`[LLM Cost Storage] Filtered out ${data.records.length - validRecords.length} invalid records during repair`);
            }
            
            return repaired;
        }
        
        // If records is not an array but other properties are valid, try to salvage
        if (typeof data.totalCost === 'number' && !isNaN(data.totalCost)) {
            // If we have a valid totalCost but no records, reset to default
            // (records might have been lost, so we can't trust totalCost)
            return {
                records: [],
                totalCost: 0,
                lastUpdated: new Date().toISOString(),
            };
        }
        
        return null;
    }
    
    /**
     * Get the start time of the current VS Code session
     * @private
     */
    private getSessionStartTime(): Date {
        // For simplicity, consider session start as extension activation
        // This could be enhanced to use actual VS Code session tracking
        return new Date(Date.now() - (24 * 60 * 60 * 1000)); // Last 24 hours as fallback
    }
}
