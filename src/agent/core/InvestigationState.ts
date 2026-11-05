/**
 * InvestigationState - Enhanced state structure for PlanningAgent
 * 
 * Implements Chain of Thought (CoT) persistence with hypothesis tracking,
 * active focus management, and thought history with compression strategy.
 */

export interface Hypothesis {
  id: string;
  description: string; // e.g., "I suspect a race condition in saveUser"
  status: 'pending' | 'verified' | 'disproven';
  confidence: number; // 0.0 to 1.0
}

export interface ThoughtStep {
  step: number;
  timestamp: number;
  reasoning: string; // "I need to check if saveUser awaits the DB call."
  action: string; // "static-analysis(saveUser)"
  observation: string; // "Tool found floating promise."
  outcome: string; // "Hypothesis verified."
}

export interface InvestigationState {
  goal: string; // Original user query
  epicenter: string; // Starting file
  facts: string[]; // Verified truths (compressed long-term memory)
  hypotheses: Hypothesis[]; // Active theories with confidence
  active_hypothesis_id: string | null; // CRITICAL: What we're focusing on RIGHT NOW
  thought_history: ThoughtStep[]; // Keeps the narrative logic (CoT)
  next_step: string; // What to do next
}















