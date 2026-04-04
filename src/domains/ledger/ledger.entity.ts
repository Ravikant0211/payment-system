export const EntrySide = {
  DEBIT:  'DEBIT',
  CREDIT: 'CREDIT',
} as const;

export type EntrySideValue = typeof EntrySide[keyof typeof EntrySide];

export const AccountType = {
  ASSET:     'ASSET',
  LIABILITY: 'LIABILITY',
  REVENUE:   'REVENUE',
  EXPENSE:   'EXPENSE',
  EQUITY:    'EQUITY',
} as const;

export type AccountTypeValue = typeof AccountType[keyof typeof AccountType];

export const NormalBalance = {
  DEBIT:  'DEBIT',
  CREDIT: 'CREDIT',
} as const;

export interface Account {
  readonly id: string;
  readonly code: string;
  readonly name: string;
  readonly accountType: AccountTypeValue;
  readonly normalBalance: EntrySideValue;
  readonly createdAt: Date;
}

/**
 * LedgerEntry: one side of a double-entry transaction.
 * Every financial event produces exactly two entries (one DEBIT, one CREDIT)
 * sharing the same transactionId. The DB trigger enforces they balance.
 */
export interface LedgerEntry {
  readonly id: string;
  readonly transactionId: string;
  readonly paymentId: string;
  readonly accountId: string;
  readonly entrySide: EntrySideValue;
  readonly amount: number;   // minor units
  readonly currency: string;
  readonly description: string | null;
  readonly createdAt: Date;
}

export interface AccountBalance {
  readonly accountId: string;
  readonly accountCode: string;
  readonly balance: number;  // positive = normal balance direction
  readonly currency: string;
}
