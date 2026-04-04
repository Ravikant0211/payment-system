import { PoolClient } from 'pg';
import { v4 as uuidv4 } from 'uuid';
import { LedgerRepository } from './ledger.repository';
import { logger } from '@/common/logger/logger';

/**
 * LedgerService: implements double-entry bookkeeping for payment events.
 *
 * Every financial event produces exactly two entries:
 *   - DEBIT one account
 *   - CREDIT another account
 * The amounts must be equal (enforced by a PostgreSQL trigger).
 *
 * Chart of accounts used:
 *   RECEIVABLE      — what customers owe us (Asset, debit-normal)
 *   REVENUE         — payment income (Revenue, credit-normal)
 *   MERCHANT_PAYABLE — what we owe merchants (Liability, credit-normal)
 *   STRIPE_FEE      — processing fees we pay Stripe (Expense, debit-normal)
 *   REFUND_EXPENSE  — refunds issued (Expense, debit-normal)
 */
export class LedgerService {
  constructor(private readonly ledgerRepo: LedgerRepository) {}

  /**
   * Record a successful payment:
   *   DEBIT  RECEIVABLE  (asset ↑ — customer owes us money)
   *   CREDIT REVENUE     (revenue ↑ — we earned income)
   */
  async recordPaymentReceived(
    client: PoolClient,
    paymentId: string,
    amount: number,
    currency: string,
  ): Promise<void> {
    const transactionId = uuidv4();
    const [receivable, revenue] = await Promise.all([
      this.ledgerRepo.findAccountByCode('RECEIVABLE'),
      this.ledgerRepo.findAccountByCode('REVENUE'),
    ]);

    await this.ledgerRepo.insertEntry(client, {
      transactionId,
      paymentId,
      accountId: receivable.id,
      entrySide: 'DEBIT',
      amount,
      currency,
      description: `Payment received for payment ${paymentId}`,
    });

    await this.ledgerRepo.insertEntry(client, {
      transactionId,
      paymentId,
      accountId: revenue.id,
      entrySide: 'CREDIT',
      amount,
      currency,
      description: `Revenue recognised for payment ${paymentId}`,
    });

    logger.info(
      { paymentId, amount, currency, transactionId },
      'Ledger: payment received recorded',
    );
  }

  /**
   * Record a refund:
   *   DEBIT  REFUND_EXPENSE  (expense ↑ — we're paying money back)
   *   CREDIT RECEIVABLE      (asset ↓ — customer no longer owes us)
   */
  async recordRefund(
    client: PoolClient,
    paymentId: string,
    amount: number,
    currency: string,
  ): Promise<void> {
    const transactionId = uuidv4();
    const [refundExpense, receivable] = await Promise.all([
      this.ledgerRepo.findAccountByCode('REFUND_EXPENSE'),
      this.ledgerRepo.findAccountByCode('RECEIVABLE'),
    ]);

    await this.ledgerRepo.insertEntry(client, {
      transactionId,
      paymentId,
      accountId: refundExpense.id,
      entrySide: 'DEBIT',
      amount,
      currency,
      description: `Refund issued for payment ${paymentId}`,
    });

    await this.ledgerRepo.insertEntry(client, {
      transactionId,
      paymentId,
      accountId: receivable.id,
      entrySide: 'CREDIT',
      amount,
      currency,
      description: `Refund: receivable reduced for payment ${paymentId}`,
    });

    logger.info(
      { paymentId, amount, currency, transactionId },
      'Ledger: refund recorded',
    );
  }

  /**
   * Record Stripe processing fee:
   *   DEBIT  STRIPE_FEE   (expense ↑)
   *   CREDIT RECEIVABLE   (asset ↓ — net receivable reduced by fee)
   */
  async recordStripeFee(
    client: PoolClient,
    paymentId: string,
    feeAmount: number,
    currency: string,
  ): Promise<void> {
    if (feeAmount === 0) return;

    const transactionId = uuidv4();
    const [stripeFee, receivable] = await Promise.all([
      this.ledgerRepo.findAccountByCode('STRIPE_FEE'),
      this.ledgerRepo.findAccountByCode('RECEIVABLE'),
    ]);

    await this.ledgerRepo.insertEntry(client, {
      transactionId,
      paymentId,
      accountId: stripeFee.id,
      entrySide: 'DEBIT',
      amount: feeAmount,
      currency,
      description: `Stripe fee for payment ${paymentId}`,
    });

    await this.ledgerRepo.insertEntry(client, {
      transactionId,
      paymentId,
      accountId: receivable.id,
      entrySide: 'CREDIT',
      amount: feeAmount,
      currency,
      description: `Receivable reduced by Stripe fee for payment ${paymentId}`,
    });

    logger.info(
      { paymentId, feeAmount, currency, transactionId },
      'Ledger: Stripe fee recorded',
    );
  }
}
