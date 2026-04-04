import { Pool } from 'pg';
import { ReconciliationRepository } from './reconciliation.repository';
import { PaymentRepository } from '@/domains/payment/payment.repository';
import { Mismatch, MismatchType } from './reconciliation.entity';
import { listChargesForDateRange } from '@/infrastructure/stripe/stripe-reconciliation';
import { sendMessage } from '@/infrastructure/kafka/producer';
import { KafkaTopic } from '@/infrastructure/kafka/topics';
import { metrics } from '@/metrics/metrics';
import { logger } from '@/common/logger/logger';

/**
 * ReconciliationService: nightly comparison of internal records vs Stripe.
 *
 * Algorithm:
 * 1. Fetch all COMPLETED payments from our DB for the target date.
 * 2. Page through all Stripe charges for the same date range (async generator).
 * 3. Build index maps and identify three classes of mismatches:
 *    a. Missing in DB  — charge exists in Stripe but not our DB
 *    b. Missing in Stripe — payment in DB but no Stripe charge found
 *    c. Amount mismatch — same identifiers, different amounts
 * 4. Persist the report.
 * 5. Emit metrics and Kafka event for alerting.
 */
export class ReconciliationService {
  private readonly reconciliationRepo: ReconciliationRepository;
  private readonly paymentRepo: PaymentRepository;

  constructor(private readonly pool: Pool) {
    this.reconciliationRepo = new ReconciliationRepository(pool);
    this.paymentRepo = new PaymentRepository(pool);
  }

  async runReconciliation(targetDate: Date): Promise<void> {
    const dateStr = targetDate.toISOString().split('T')[0]!;
    logger.info({ date: dateStr }, 'Starting reconciliation run');

    const reportId = await this.reconciliationRepo.createReport(targetDate);
    const timer = metrics.reconciliationDuration.startTimer();

    const dayStart = new Date(targetDate);
    dayStart.setUTCHours(0, 0, 0, 0);
    const dayEnd = new Date(targetDate);
    dayEnd.setUTCHours(23, 59, 59, 999);

    const fromTs = Math.floor(dayStart.getTime() / 1000);
    const toTs = Math.floor(dayEnd.getTime() / 1000);

    try {
      // 1. Internal: COMPLETED payments with a Stripe payment intent
      const internalPayments = await this.paymentRepo.findCompletedForDate(targetDate);
      const internalMap = new Map<string, { paymentId: string; amount: number; currency: string }>();
      for (const p of internalPayments) {
        if (p.stripePaymentIntentId) {
          internalMap.set(p.stripePaymentIntentId, {
            paymentId: p.id,
            amount: p.amount,
            currency: p.currency,
          });
        }
      }

      // 2. External: Stripe charges (streamed via async generator)
      const externalMap = new Map<string, { amount: number; currency: string; chargeId: string }>();
      for await (const charge of listChargesForDateRange(fromTs, toTs)) {
        if (charge.paymentIntentId) {
          externalMap.set(charge.paymentIntentId, {
            amount: charge.amount,
            currency: charge.currency.toUpperCase(),
            chargeId: charge.id,
          });
        }
      }

      // 3. Find mismatches
      const mismatches: Mismatch[] = [];

      // a. Missing in DB
      for (const [piId, ext] of externalMap) {
        if (!internalMap.has(piId)) {
          mismatches.push({
            type: MismatchType.MISSING_IN_DB,
            stripeChargeId: ext.chargeId,
            externalValue: `amount=${ext.amount} currency=${ext.currency}`,
            description: `Stripe charge ${ext.chargeId} (payment_intent=${piId}) has no matching DB record`,
          });
          metrics.reconciliationMismatches.inc({ type: MismatchType.MISSING_IN_DB });
        }
      }

      // b. Missing in Stripe + amount mismatches
      for (const [piId, int] of internalMap) {
        const ext = externalMap.get(piId);
        if (!ext) {
          mismatches.push({
            type: MismatchType.MISSING_IN_STRIPE,
            paymentId: int.paymentId,
            internalValue: `amount=${int.amount} currency=${int.currency}`,
            description: `Payment ${int.paymentId} is COMPLETED in DB but no matching Stripe charge found`,
          });
          metrics.reconciliationMismatches.inc({ type: MismatchType.MISSING_IN_STRIPE });
        } else if (ext.amount !== int.amount) {
          mismatches.push({
            type: MismatchType.AMOUNT_MISMATCH,
            paymentId: int.paymentId,
            stripeChargeId: ext.chargeId,
            internalValue: String(int.amount),
            externalValue: String(ext.amount),
            description: `Amount mismatch for payment ${int.paymentId}: internal=${int.amount}, stripe=${ext.amount}`,
          });
          metrics.reconciliationMismatches.inc({ type: MismatchType.AMOUNT_MISMATCH });
        }
      }

      const matchedCount =
        internalMap.size + externalMap.size - mismatches.length;

      // 4. Persist report
      await this.reconciliationRepo.updateReport(reportId, {
        status: 'COMPLETED',
        totalInternal: internalMap.size,
        totalExternal: externalMap.size,
        matchedCount: Math.max(0, matchedCount),
        mismatchCount: mismatches.length,
        mismatches,
      });

      // 5. Emit Kafka event for downstream alerting
      await sendMessage({
        topic: KafkaTopic.RECONCILIATION_DONE,
        key: dateStr,
        value: {
          eventType: 'RECONCILIATION_COMPLETED',
          date: dateStr,
          mismatchCount: mismatches.length,
          mismatches,
          timestamp: new Date().toISOString(),
        },
      });

      metrics.reconciliationLastRunTimestamp.set(Date.now() / 1000);
      timer();

      if (mismatches.length > 0) {
        logger.warn(
          { date: dateStr, mismatchCount: mismatches.length, mismatches },
          'Reconciliation completed with mismatches — ATTENTION REQUIRED',
        );
      } else {
        logger.info(
          { date: dateStr, total: internalMap.size },
          'Reconciliation completed — all records match',
        );
      }
    } catch (err) {
      timer();
      const errMsg = err instanceof Error ? err.message : String(err);
      await this.reconciliationRepo.updateReport(reportId, {
        status: 'FAILED',
        totalInternal: 0,
        totalExternal: 0,
        matchedCount: 0,
        mismatchCount: 0,
        mismatches: [],
        error: errMsg,
      });
      logger.error({ err, date: dateStr }, 'Reconciliation run failed');
      throw err;
    }
  }

  async getReport(date: string) {
    return this.reconciliationRepo.findByDate(date);
  }

  async listReports() {
    return this.reconciliationRepo.listReports();
  }
}
