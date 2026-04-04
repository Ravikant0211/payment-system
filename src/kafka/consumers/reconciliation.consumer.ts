import { EachMessagePayload } from 'kafkajs';
import { registerConsumer } from '@/infrastructure/kafka/consumer-manager';
import { KafkaTopic } from '@/infrastructure/kafka/topics';
import { sendAlert } from '@/infrastructure/alerting/slack-alerter';
import { logger } from '@/common/logger/logger';

interface ReconciliationDoneEvent {
  eventType: 'RECONCILIATION_COMPLETED';
  date: string;
  mismatchCount: number;
  mismatches: Array<{
    type: string;
    paymentId?: string;
    stripeChargeId?: string;
    description: string;
  }>;
}

export async function registerReconciliationConsumer(): Promise<void> {
  await registerConsumer({
    groupId: 'reconciliation',
    topics: [KafkaTopic.RECONCILIATION_DONE],
    maxRetries: 3,
    handler: async (payload: EachMessagePayload) => {
      const raw = payload.message.value?.toString();
      if (!raw) return;

      const event = JSON.parse(raw) as ReconciliationDoneEvent;

      if (event.mismatchCount === 0) {
        logger.info({ date: event.date }, 'Reconciliation: all records matched');
        return;
      }

      logger.error(
        { date: event.date, mismatchCount: event.mismatchCount, mismatches: event.mismatches },
        'RECONCILIATION ALERT: mismatches found — manual review required',
      );

      // Build a readable summary of the first 5 mismatches for the alert body
      const sample = event.mismatches
        .slice(0, 5)
        .map((m, i) => `${i + 1}. [${m.type}] ${m.description}`)
        .join('\n');
      const overflow =
        event.mismatchCount > 5 ? `\n…and ${event.mismatchCount - 5} more.` : '';

      await sendAlert({
        severity: 'critical',
        title: `Reconciliation mismatches detected — ${event.date}`,
        message: `${event.mismatchCount} mismatch(es) found between internal DB and Stripe.\n\n${sample}${overflow}`,
        fields: {
          Date: event.date,
          'Mismatch count': event.mismatchCount,
          'Review endpoint': `/v1/reconciliation/${event.date}`,
        },
      });
    },
  });
}
