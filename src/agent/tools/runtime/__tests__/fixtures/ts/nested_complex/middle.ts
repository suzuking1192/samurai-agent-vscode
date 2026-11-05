// middle.ts (nested complex TypeScript fixture)
import { calculateLeaf } from './leaf';

export type Adjustment =
  | { type: 'credit'; amount: number }
  | { type: 'fee'; amount: number }
  | { type: 'fx'; amount: number; rate: number };

type RequestPayload = {
  account: {
    id: string;
    balance: number;
    tags: string[];
    profile: { country: string; risk: number; aliases: string[] };
  };
  adjustments: Adjustment[];
  config: {
    multiplier: number;
    threshold: number;
    features: Record<string, boolean>;
  };
};

type MiddleResult = {
  finalBalance: number;
  risk: number;
  tagSummary: string;
  applied: number[];
};

export async function runMiddle(request: RequestPayload): Promise<MiddleResult> {
  const base = request.account.balance;
  const appliedAdjustments = request.adjustments.map((adj) => {
    if (adj.type === 'fx') {
      return adj.amount * adj.rate;
    }
    return adj.amount;
  });

  const adjusted = appliedAdjustments.reduce((acc, curr) => acc + curr, base);

  const context = {
    accountId: request.account.id,
    base,
    adjusted,
    profile: request.account.profile,
    tags: [...request.account.tags],
    config: request.config,
  };

  const leafResult = calculateLeaf(context);

  return {
    finalBalance: leafResult.finalBalance,
    risk: leafResult.riskScore,
    tagSummary: leafResult.tagSummary,
    applied: appliedAdjustments,
  };
}
