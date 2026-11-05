/**
 * Unit tests for LLMCostStorage data corruption tolerance and recovery
 */

import { LLMCostStorage, LLMCostRecord } from '../../src/storage/llmCostStorage';
import * as vscode from 'vscode';

// Mock VS Code extension context with ability to inject corrupted data
class MockExtensionContext implements Partial<vscode.ExtensionContext> {
    private storage = new Map<string, any>();
    
    workspaceState = {
        get: (key: string) => this.storage.get(key),
        update: async (key: string, value: any) => {
            this.storage.set(key, value);
        },
        keys: () => Array.from(this.storage.keys())
    } as any;
    
    globalState = this.workspaceState;
    subscriptions = [];
    extensionPath = '';
    extensionUri = {} as any;
    environmentVariableCollection = {} as any;
    storagePath = '';
    globalStoragePath = '';
    logPath = '';
    extensionMode = 3; // ExtensionMode.Test
    
    asAbsolutePath(relativePath: string): string {
        return relativePath;
    }
    
    // Helper method to inject corrupted data for testing
    setCorruptedData(key: string, data: any): void {
        this.storage.set(key, data);
    }
}

describe('LLMCostStorage - Data Corruption Tolerance', () => {
    let storage: LLMCostStorage;
    let mockContext: MockExtensionContext;
    
    beforeEach(() => {
        mockContext = new MockExtensionContext();
        storage = new LLMCostStorage(mockContext as any);
    });
    
    describe('loadStoredData - Missing records property', () => {
        it('should handle missing records property and return default structure', async () => {
            // Inject corrupted data missing records
            mockContext.setCorruptedData('samuraiAgent.llmCostRecords', {
                totalCost: 123.45,
                lastUpdated: '2024-01-01T00:00:00.000Z'
            });
            
            // Should not throw and should return empty records
            const records = storage.getRecords();
            expect(records).toEqual([]);
            expect(Array.isArray(records)).toBe(true);
        });
        
        it('should handle records as null', async () => {
            mockContext.setCorruptedData('samuraiAgent.llmCostRecords', {
                records: null,
                totalCost: 100,
                lastUpdated: '2024-01-01T00:00:00.000Z'
            });
            
            const records = storage.getRecords();
            expect(records).toEqual([]);
        });
        
        it('should handle records as undefined', async () => {
            mockContext.setCorruptedData('samuraiAgent.llmCostRecords', {
                records: undefined,
                totalCost: 100,
                lastUpdated: '2024-01-01T00:00:00.000Z'
            });
            
            const records = storage.getRecords();
            expect(records).toEqual([]);
        });
        
        it('should handle records as non-array', async () => {
            mockContext.setCorruptedData('samuraiAgent.llmCostRecords', {
                records: 'not an array',
                totalCost: 100,
                lastUpdated: '2024-01-01T00:00:00.000Z'
            });
            
            const records = storage.getRecords();
            expect(records).toEqual([]);
        });
    });
    
    describe('loadStoredData - Missing totalCost property', () => {
        it('should handle missing totalCost and reset to 0', async () => {
            const validRecord: LLMCostRecord = {
                id: 'cost-1',
                timestamp: new Date().toISOString(),
                provider: 'openai',
                model: 'gpt-4',
                promptTokens: 1000,
                completionTokens: 500,
                totalTokens: 1500,
                cost: 0.50
            };
            
            mockContext.setCorruptedData('samuraiAgent.llmCostRecords', {
                records: [validRecord],
                lastUpdated: '2024-01-01T00:00:00.000Z'
            });
            
            // Should repair and recalculate totalCost from records
            const totalCost = storage.getTotalCost();
            expect(totalCost).toBe(0.50); // Recalculated from valid records
        });
        
        it('should handle totalCost as NaN', async () => {
            mockContext.setCorruptedData('samuraiAgent.llmCostRecords', {
                records: [],
                totalCost: NaN,
                lastUpdated: '2024-01-01T00:00:00.000Z'
            });
            
            const totalCost = storage.getTotalCost();
            expect(totalCost).toBe(0);
        });
        
        it('should handle totalCost as string', async () => {
            mockContext.setCorruptedData('samuraiAgent.llmCostRecords', {
                records: [],
                totalCost: '100',
                lastUpdated: '2024-01-01T00:00:00.000Z'
            });
            
            const totalCost = storage.getTotalCost();
            expect(totalCost).toBe(0);
        });
    });
    
    describe('loadStoredData - Missing lastUpdated property', () => {
        it('should handle missing lastUpdated and set current timestamp', async () => {
            mockContext.setCorruptedData('samuraiAgent.llmCostRecords', {
                records: [],
                totalCost: 0
            });
            
            const records = storage.getRecords();
            expect(records).toEqual([]);
            // Should not throw
        });
    });
    
    describe('loadStoredData - Partially corrupted records array', () => {
        it('should filter out invalid records and keep valid ones', async () => {
            const validRecord: LLMCostRecord = {
                id: 'cost-1',
                timestamp: new Date().toISOString(),
                provider: 'openai',
                model: 'gpt-4',
                promptTokens: 1000,
                completionTokens: 500,
                totalTokens: 1500,
                cost: 0.50
            };
            
            const invalidRecord1 = { id: 'cost-2', cost: 0.30 }; // Missing required fields
            const invalidRecord2 = null;
            const invalidRecord3 = { id: 'cost-3', cost: 'not a number' }; // Wrong type
            
            mockContext.setCorruptedData('samuraiAgent.llmCostRecords', {
                records: [validRecord, invalidRecord1, invalidRecord2, invalidRecord3],
                totalCost: 100,
                lastUpdated: '2024-01-01T00:00:00.000Z'
            });
            
            const records = storage.getRecords();
            expect(records).toHaveLength(1);
            expect(records[0].id).toBe('cost-1');
            expect(records[0].cost).toBe(0.50);
            
            // TotalCost should be recalculated from valid records
            const totalCost = storage.getTotalCost();
            expect(totalCost).toBe(0.50);
        });
        
        it('should handle records with NaN values', async () => {
            const corruptedRecord = {
                id: 'cost-1',
                timestamp: new Date().toISOString(),
                provider: 'openai',
                model: 'gpt-4',
                promptTokens: NaN,
                completionTokens: 500,
                totalTokens: 1500,
                cost: 0.50
            };
            
            mockContext.setCorruptedData('samuraiAgent.llmCostRecords', {
                records: [corruptedRecord],
                totalCost: 100,
                lastUpdated: '2024-01-01T00:00:00.000Z'
            });
            
            const records = storage.getRecords();
            expect(records).toHaveLength(0); // Invalid record should be filtered out
        });
    });
    
    describe('saveRecord - Recovery after corruption', () => {
        it('should save new record after detecting corruption', async () => {
            // Start with corrupted data
            mockContext.setCorruptedData('samuraiAgent.llmCostRecords', {
                records: null,
                totalCost: 'invalid',
                lastUpdated: 'invalid'
            });
            
            const newRecord: LLMCostRecord = {
                id: 'cost-new',
                timestamp: new Date().toISOString(),
                provider: 'openai',
                model: 'gpt-4',
                promptTokens: 1000,
                completionTokens: 500,
                totalTokens: 1500,
                cost: 0.75
            };
            
            // Should not throw and should save successfully
            await storage.saveRecord(newRecord);
            
            const records = storage.getRecords();
            expect(records).toHaveLength(1);
            expect(records[0].id).toBe('cost-new');
            expect(records[0].cost).toBe(0.75);
            
            const totalCost = storage.getTotalCost();
            expect(totalCost).toBe(0.75);
        });
        
        it('should continue working after partial corruption repair', async () => {
            const validRecord: LLMCostRecord = {
                id: 'cost-1',
                timestamp: new Date().toISOString(),
                provider: 'openai',
                model: 'gpt-4',
                promptTokens: 1000,
                completionTokens: 500,
                totalTokens: 1500,
                cost: 0.50
            };
            
            const invalidRecord = { invalid: 'data' };
            
            mockContext.setCorruptedData('samuraiAgent.llmCostRecords', {
                records: [validRecord, invalidRecord],
                totalCost: 999, // Wrong total
                lastUpdated: '2024-01-01T00:00:00.000Z'
            });
            
            // Should repair and keep valid record
            let records = storage.getRecords();
            expect(records).toHaveLength(1);
            
            // Add new record
            const newRecord: LLMCostRecord = {
                id: 'cost-2',
                timestamp: new Date().toISOString(),
                provider: 'openai',
                model: 'gpt-4',
                promptTokens: 2000,
                completionTokens: 1000,
                totalTokens: 3000,
                cost: 1.00
            };
            
            await storage.saveRecord(newRecord);
            
            records = storage.getRecords();
            expect(records).toHaveLength(2);
            
            const totalCost = storage.getTotalCost();
            expect(totalCost).toBe(1.50); // 0.50 + 1.00
        });
    });
    
    describe('getStatistics - Corruption handling', () => {
        it('should return valid statistics even with corrupted data', async () => {
            mockContext.setCorruptedData('samuraiAgent.llmCostRecords', {
                records: null,
                totalCost: 'invalid',
                lastUpdated: 'invalid'
            });
            
            const stats = storage.getStatistics();
            expect(stats.totalRecords).toBe(0);
            expect(stats.totalCost).toBe(0);
            expect(stats.currentSessionCost).toBe(0);
            expect(stats.currentMonthCost).toBe(0);
            expect(stats.oldestRecord).toBeUndefined();
            expect(stats.newestRecord).toBeUndefined();
        });
    });
    
    describe('getCurrentSessionCost - Corruption handling', () => {
        it('should handle corrupted data and return 0', async () => {
            mockContext.setCorruptedData('samuraiAgent.llmCostRecords', {
                records: 'not an array',
                totalCost: 100,
                lastUpdated: '2024-01-01T00:00:00.000Z'
            });
            
            const sessionCost = storage.getCurrentSessionCost();
            expect(sessionCost).toBe(0);
        });
    });
    
    describe('getCurrentMonthCost - Corruption handling', () => {
        it('should handle corrupted data and return 0', async () => {
            mockContext.setCorruptedData('samuraiAgent.llmCostRecords', {
                records: null,
                totalCost: 100,
                lastUpdated: '2024-01-01T00:00:00.000Z'
            });
            
            const monthCost = storage.getCurrentMonthCost();
            expect(monthCost).toBe(0);
        });
    });
    
    describe('getRecordsBySession - Corruption handling', () => {
        it('should handle corrupted data and return empty array', async () => {
            mockContext.setCorruptedData('samuraiAgent.llmCostRecords', {
                records: undefined,
                totalCost: 0,
                lastUpdated: '2024-01-01T00:00:00.000Z'
            });
            
            const records = storage.getRecordsBySession('session-1');
            expect(records).toEqual([]);
        });
    });
    
    describe('Completely corrupted data object', () => {
        it('should handle null data', async () => {
            mockContext.setCorruptedData('samuraiAgent.llmCostRecords', null);
            
            const records = storage.getRecords();
            expect(records).toEqual([]);
        });
        
        it('should handle undefined data', async () => {
            mockContext.setCorruptedData('samuraiAgent.llmCostRecords', undefined);
            
            const records = storage.getRecords();
            expect(records).toEqual([]);
        });
        
        it('should handle non-object data', async () => {
            mockContext.setCorruptedData('samuraiAgent.llmCostRecords', 'string data');
            
            const records = storage.getRecords();
            expect(records).toEqual([]);
        });
        
        it('should handle empty object', async () => {
            mockContext.setCorruptedData('samuraiAgent.llmCostRecords', {});
            
            const records = storage.getRecords();
            expect(records).toEqual([]);
        });
    });
    
    describe('Record validation - Optional fields', () => {
        it('should accept records with optional fields as undefined', async () => {
            const record: LLMCostRecord = {
                id: 'cost-1',
                timestamp: new Date().toISOString(),
                provider: 'openai',
                model: 'gpt-4',
                promptTokens: 1000,
                completionTokens: 500,
                totalTokens: 1500,
                cost: 0.50
                // sessionId, requestId, isBetaUserActive are undefined
            };
            
            await storage.saveRecord(record);
            
            const records = storage.getRecords();
            expect(records).toHaveLength(1);
            expect(records[0].sessionId).toBeUndefined();
        });
        
        it('should reject records with wrong type for optional fields', async () => {
            const corruptedRecord = {
                id: 'cost-1',
                timestamp: new Date().toISOString(),
                provider: 'openai',
                model: 'gpt-4',
                promptTokens: 1000,
                completionTokens: 500,
                totalTokens: 1500,
                cost: 0.50,
                sessionId: 123, // Should be string, not number
                isBetaUserActive: 'true' // Should be boolean, not string
            };
            
            mockContext.setCorruptedData('samuraiAgent.llmCostRecords', {
                records: [corruptedRecord],
                totalCost: 0.50,
                lastUpdated: '2024-01-01T00:00:00.000Z'
            });
            
            const records = storage.getRecords();
            expect(records).toHaveLength(0); // Should be filtered out
        });
    });
});








