export const ReconciliationStatus = {
  RUNNING:   'RUNNING',
  COMPLETED: 'COMPLETED',
  FAILED:    'FAILED',
} as const;

export const MismatchType = {
  MISSING_IN_DB:     'MISSING_IN_DB',      // In Stripe, not in our DB
  MISSING_IN_STRIPE: 'MISSING_IN_STRIPE',  // In our DB, not in Stripe
  AMOUNT_MISMATCH:   'AMOUNT_MISMATCH',    // Same ID, different amounts
  STATUS_MISMATCH:   'STATUS_MISMATCH',    // Same ID, different status
} as const;

export type MismatchTypeValue = typeof MismatchType[keyof typeof MismatchType];

export interface Mismatch {
  type: MismatchTypeValue;
  paymentId?: string;
  stripeChargeId?: string;
  internalValue?: string;
  externalValue?: string;
  description: string;
}

export interface ReconciliationReport {
  readonly id: string;
  readonly runDate: string;
  readonly status: 'RUNNING' | 'COMPLETED' | 'FAILED';
  readonly totalInternal: number;
  readonly totalExternal: number;
  readonly matchedCount: number;
  readonly mismatchCount: number;
  readonly mismatches: Mismatch[];
  readonly error: string | null;
  readonly startedAt: Date;
  readonly completedAt: Date | null;
}
