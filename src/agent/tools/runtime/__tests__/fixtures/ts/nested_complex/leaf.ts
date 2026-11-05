// leaf.ts (nested complex TypeScript fixture)

type Context = {
  accountId: string;
  base: number;
  adjusted: number;
  profile: { country: string; risk: number; aliases: string[] };
  tags: string[];
  config: {
    multiplier: number;
    threshold: number;
    features: Record<string, boolean>;
  };
};

export function calculateLeaf(ctx: Context) {
  const appliedMultiplier = ctx.adjusted * ctx.config.multiplier;
  const surcharge = ctx.profile.risk > 0.2 ? 100 : 25;
  const finalBalance = appliedMultiplier + surcharge;

  const riskScore =
    (ctx.profile.risk * ctx.tags.length + (ctx.config.features.auditTrail ? 0.05 : 0)) *
    (ctx.adjusted > ctx.config.threshold ? 1.2 : 0.9);

  const tagSummary = ctx.tags.join(',') || 'none';

  return {
    finalBalance,
    riskScore,
    tagSummary,
  };
}
