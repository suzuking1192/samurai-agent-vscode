/**
 * Budget Manager for Debugging Flow
 * 
 * Tracks LLM calls and time limits to prevent runaway costs and latency
 */

export interface BudgetConfig {
  maxLLMCallsPerIncident: number;
  maxExtractionMillis: number;
  p95TargetMillis: number;
}

export interface CallTracker {
  [tag: string]: number;
}

export class BudgetManager {
  private callTracker: CallTracker = {};
  private startTime: number;
  private config: BudgetConfig;

  constructor(config: BudgetConfig) {
    this.startTime = Date.now();
    this.config = config;
  }

  /**
   * Track a call and return true if within budget
   */
  trackCalls(tag: string): boolean {
    const currentCalls = this.callTracker[tag] || 0;
    const totalCalls = Object.values(this.callTracker).reduce((sum, count) => sum + count, 0);
    
    if (totalCalls >= this.config.maxLLMCallsPerIncident) {
      console.warn(`[BudgetManager] LLM call limit exceeded: ${totalCalls}/${this.config.maxLLMCallsPerIncident}`);
      return false;
    }
    
    this.callTracker[tag] = currentCalls + 1;
    return true;
  }

  /**
   * Check if we're within time budget
   */
  withinTime(startTime: number, limitMs: number): boolean {
    const elapsed = Date.now() - startTime;
    return elapsed <= limitMs;
  }

  /**
   * Check if we're within overall P95 target
   */
  withinP95Target(): boolean {
    const elapsed = Date.now() - this.startTime;
    return elapsed <= this.config.p95TargetMillis;
  }

  /**
   * Get current call counts
   */
  getCallCounts(): CallTracker {
    return { ...this.callTracker };
  }

  /**
   * Get total calls made
   */
  getTotalCalls(): number {
    return Object.values(this.callTracker).reduce((sum, count) => sum + count, 0);
  }

  /**
   * Get elapsed time since start
   */
  getElapsedTime(): number {
    return Date.now() - this.startTime;
  }

  /**
   * Check if budget is exhausted
   */
  isExhausted(): boolean {
    return this.getTotalCalls() >= this.config.maxLLMCallsPerIncident || 
           !this.withinP95Target();
  }

  /**
   * Get budget status for logging
   */
  getStatus(): string {
    const totalCalls = this.getTotalCalls();
    const elapsed = this.getElapsedTime();
    return `Calls: ${totalCalls}/${this.config.maxLLMCallsPerIncident}, Time: ${elapsed}ms/${this.config.p95TargetMillis}ms`;
  }
}

/**
 * Default budget configuration
 */
export const DEFAULT_BUDGET_CONFIG: BudgetConfig = {
  maxLLMCallsPerIncident: 6,
  maxExtractionMillis: 500,
  p95TargetMillis: 2000,
};



















