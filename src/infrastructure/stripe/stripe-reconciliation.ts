import Stripe from 'stripe';
import { getStripeClient } from './stripe-client';
import { logger } from '@/common/logger/logger';

export interface StripeChargeSummary {
  id: string;
  paymentIntentId: string | null;
  amount: number;
  currency: string;
  status: string;
  metadata: Record<string, string>;
  createdAt: Date;
}

/**
 * Pages through all Stripe charges for a given UTC date range.
 * Uses cursor-based pagination to avoid memory issues on large datasets.
 */
export async function* listChargesForDateRange(
  fromTs: number,
  toTs: number,
): AsyncGenerator<StripeChargeSummary> {
  const stripe = getStripeClient();
  let startingAfter: string | undefined;

  while (true) {
    const params: Stripe.ChargeListParams = {
      created: { gte: fromTs, lte: toTs },
      limit: 100,
      ...(startingAfter ? { starting_after: startingAfter } : {}),
    };

    const charges = await stripe.charges.list(params);

    for (const charge of charges.data) {
      yield {
        id: charge.id,
        paymentIntentId:
          typeof charge.payment_intent === 'string'
            ? charge.payment_intent
            : (charge.payment_intent?.id ?? null),
        amount: charge.amount,
        currency: charge.currency,
        status: charge.status,
        metadata: charge.metadata as Record<string, string>,
        createdAt: new Date(charge.created * 1000),
      };
    }

    if (!charges.has_more) break;

    const last = charges.data[charges.data.length - 1];
    startingAfter = last?.id;
    logger.debug(
      { startingAfter, count: charges.data.length },
      'Fetched Stripe charges page',
    );
  }
}
