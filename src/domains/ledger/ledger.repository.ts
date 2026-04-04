import { Pool, PoolClient } from 'pg';
import { Account, AccountBalance, LedgerEntry, EntrySideValue } from './ledger.entity';
import { NotFoundError } from '@/common/errors';

export interface InsertEntryParams {
  transactionId: string;
  paymentId: string;
  accountId: string;
  entrySide: EntrySideValue;
  amount: number;
  currency: string;
  description?: string;
}

export class LedgerRepository {
  constructor(private readonly pool: Pool) {}

  async findAccountByCode(code: string): Promise<Account> {
    const { rows } = await this.pool.query<{
      id: string;
      code: string;
      name: string;
      account_type: string;
      normal_balance: EntrySideValue;
      created_at: Date;
    }>('SELECT * FROM accounts WHERE code = $1', [code]);

    if (!rows[0]) throw new NotFoundError('Account', code);

    return {
      id: rows[0].id,
      code: rows[0].code,
      name: rows[0].name,
      accountType: rows[0].account_type as Account['accountType'],
      normalBalance: rows[0].normal_balance,
      createdAt: rows[0].created_at,
    };
  }

  /**
   * Insert a ledger entry. Always called within a transaction (receives PoolClient).
   * The DB trigger will verify debit = credit totals after both entries are inserted.
   */
  async insertEntry(
    client: PoolClient,
    params: InsertEntryParams,
  ): Promise<LedgerEntry> {
    const { rows } = await client.query<{
      id: string;
      transaction_id: string;
      payment_id: string;
      account_id: string;
      entry_side: EntrySideValue;
      amount: string;
      currency: string;
      description: string | null;
      created_at: Date;
    }>(
      `INSERT INTO ledger_entries
         (transaction_id, payment_id, account_id, entry_side, amount, currency, description)
       VALUES ($1,$2,$3,$4,$5,$6,$7)
       RETURNING *`,
      [
        params.transactionId,
        params.paymentId,
        params.accountId,
        params.entrySide,
        params.amount,
        params.currency,
        params.description ?? null,
      ],
    );

    const row = rows[0]!;
    return {
      id: row.id,
      transactionId: row.transaction_id,
      paymentId: row.payment_id,
      accountId: row.account_id,
      entrySide: row.entry_side,
      amount: parseInt(row.amount, 10),
      currency: row.currency,
      description: row.description,
      createdAt: row.created_at,
    };
  }

  async getEntriesForPayment(paymentId: string): Promise<LedgerEntry[]> {
    const { rows } = await this.pool.query<{
      id: string;
      transaction_id: string;
      payment_id: string;
      account_id: string;
      entry_side: EntrySideValue;
      amount: string;
      currency: string;
      description: string | null;
      created_at: Date;
    }>(
      `SELECT * FROM ledger_entries WHERE payment_id = $1 ORDER BY created_at`,
      [paymentId],
    );

    return rows.map((r) => ({
      id: r.id,
      transactionId: r.transaction_id,
      paymentId: r.payment_id,
      accountId: r.account_id,
      entrySide: r.entry_side,
      amount: parseInt(r.amount, 10),
      currency: r.currency,
      description: r.description,
      createdAt: r.created_at,
    }));
  }

  /**
   * Compute account balance using normal balance convention.
   * ASSET/EXPENSE: balance = SUM(debits) - SUM(credits)
   * LIABILITY/REVENUE/EQUITY: balance = SUM(credits) - SUM(debits)
   */
  async getAccountBalance(
    accountCode: string,
    currency: string,
  ): Promise<AccountBalance> {
    const account = await this.findAccountByCode(accountCode);

    const { rows } = await this.pool.query<{
      debit_sum: string;
      credit_sum: string;
    }>(
      `SELECT
         COALESCE(SUM(amount) FILTER (WHERE entry_side = 'DEBIT'), 0)  AS debit_sum,
         COALESCE(SUM(amount) FILTER (WHERE entry_side = 'CREDIT'), 0) AS credit_sum
       FROM ledger_entries
       WHERE account_id = $1 AND currency = $2`,
      [account.id, currency.toUpperCase()],
    );

    const debit = parseInt(rows[0]?.debit_sum ?? '0', 10);
    const credit = parseInt(rows[0]?.credit_sum ?? '0', 10);

    const isDebitNormal =
      account.normalBalance === 'DEBIT';
    const balance = isDebitNormal ? debit - credit : credit - debit;

    return {
      accountId: account.id,
      accountCode: account.code,
      balance,
      currency: currency.toUpperCase(),
    };
  }
}
