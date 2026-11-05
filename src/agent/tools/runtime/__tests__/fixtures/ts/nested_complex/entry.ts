// entry.ts (nested complex TypeScript fixture)
import { runMiddle, type Adjustment } from './middle';

type Account = {
  id: string;
  balance: number;
  tags: string[];
  profile: {
    country: string;
    risk: number;
    aliases: string[];
  };
};

type Config = {
  multiplier: number;
  threshold: number;
  features: Record<string, boolean>;
};

const config: Config = {
  multiplier: 1.25,
  threshold: 5000,
  features: {
    auditTrail: true,
    fxEnabled: false,
    taxEnabled: true,
  },
};

const account: Account = {
  id: 'acct-01',
  balance: 3200,
  tags: ['vip', 'beta'],
  profile: {
    country: 'JP',
    risk: 0.12,
    aliases: ['primary', 'legacy'],
  },
};

async function startFlow() {
  const adjustments: Adjustment[] = [
    { type: 'credit', amount: 250 },
    { type: 'fx', rate: 1.1, amount: 100 },
    { type: 'fee', amount: -30 },
  ];

  const request = {
    account,
    adjustments,
    config,
  };

  const result = await runMiddle(request);
  return result;
}

startFlow()
  .then((result) => {
    console.log('Complex Final:', result.finalBalance, 'Risk:', result.risk);
  })
  .catch((err) => {
    console.error('Complex Error', err);
  });
