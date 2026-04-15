import Stripe from 'stripe';
import { getStripeClient } from './stripe-client';
import { retryWithBackoff } from '@/common/utils/retry';
import { metrics } from '@/metrics/metrics';
import { logger } from '@/common/logger/logger';

/**
 * Returns true only for errors that are safe to retry:
 *  - Network / connection errors
 *  - Stripe 429 (rate limit) — SDK handles transport-level but not app-level backoff
 *  - Stripe 5xx server errors
 *
 * 4xx client errors (bad card, invalid params, auth failures) are not retried
 * because re-sending the same request will always fail.
 */
function isRetryableStripeError(err: unknown): boolean {
  if (err instanceof Stripe.errors.StripeError) {
    // Connection errors and API errors with server-side status
    if (err instanceof Stripe.errors.StripeConnectionError) return true;
    if (err instanceof Stripe.errors.StripeAPIError) {
      return (err.statusCode ?? 0) >= 500;
    }
    if (err instanceof Stripe.errors.StripeRateLimitError) return true;
    return false;
  }
  // Node.js network errors
  const code = (err as NodeJS.ErrnoException).code;
  return code === 'ECONNRESET' || code === 'ETIMEDOUT' || code === 'ECONNREFUSED';
}

export type SupportedPaymentMethod =
  | 'CREDIT_CARD'
  | 'DEBIT_CARD'
  | 'UPI'
  | 'NET_BANKING';

/**
 * Maps our internal payment method types to Stripe's payment_method_types.
 * Stripe handles the actual routing for UPI and net banking on its hosted page.
 */
function toStripePaymentMethods(
  method: SupportedPaymentMethod,
): Stripe.Checkout.SessionCreateParams.PaymentMethodType[] {
  switch (method) {
    case 'CREDIT_CARD':
    case 'DEBIT_CARD':
      return ['card'];
    case 'UPI':
      // 'upi' is valid in Stripe's API for India but not yet in the installed SDK type union
      return ['upi' as Stripe.Checkout.SessionCreateParams.PaymentMethodType];
    case 'NET_BANKING':
      // 'netbanking' is valid in Stripe's API for India but not yet in the installed SDK type union
      return ['netbanking' as Stripe.Checkout.SessionCreateParams.PaymentMethodType];
  }
}

export interface CreateCheckoutSessionParams {
  paymentId: string;
  orderId: string;
  customerId: string;
  amount: number;        // minor units
  currency: string;
  paymentMethod: SupportedPaymentMethod;
  successUrl: string;
  cancelUrl: string;
  metadata?: Record<string, string>;
}

export interface CheckoutSessionResult {
  sessionId: string;
  checkoutUrl: string;
  expiresAt: Date;
}

export async function createCheckoutSession(
  params: CreateCheckoutSessionParams,
): Promise<CheckoutSessionResult> {
  const stripe = getStripeClient();
  const timer = metrics.stripeApiDuration.startTimer({
    operation: 'createCheckoutSession',
  });

  try {
    const session = await retryWithBackoff(
      () => stripe.checkout.sessions.create({
      payment_method_types: toStripePaymentMethods(params.paymentMethod),
      line_items: [
        {
          price_data: {
            currency: params.currency.toLowerCase(),
            product_data: {
              name: `Order ${params.orderId}`,
              metadata: { orderId: params.orderId },
            },
            unit_amount: params.amount,
          },
          quantity: 1,
        },
      ],
      mode: 'payment',
      success_url: `${params.successUrl}?payment_id=${params.paymentId}`,
      cancel_url: `${params.cancelUrl}?payment_id=${params.paymentId}`,
      expires_at: Math.floor(Date.now() / 1000) + 30 * 60, // 30 minutes
      metadata: {
        paymentId: params.paymentId,
        orderId: params.orderId,
        customerId: params.customerId,
        ...params.metadata,
      },
    }),
      {
        maxAttempts: 3,
        initialDelayMs: 500,
        maxDelayMs: 4_000,
        jitterFactor: 0.3,
        isRetryable: isRetryableStripeError,
      },
    );

    timer({ result: 'success' });

    if (!session.url) {
      throw new Error('Stripe did not return a checkout URL');
    }

    return {
      sessionId: session.id,
      checkoutUrl: session.url,
      expiresAt: new Date((session.expires_at ?? 0) * 1000),
    };
  } catch (err) {
    timer({ result: 'error' });
    logger.error({ err, paymentId: params.paymentId }, 'Stripe checkout session creation failed');
    throw err;
  }
}

export async function expireCheckoutSession(sessionId: string): Promise<void> {
  const stripe = getStripeClient();
  await stripe.checkout.sessions.expire(sessionId);
}

export async function retrieveCheckoutSession(
  sessionId: string,
): Promise<Stripe.Checkout.Session> {
  const stripe = getStripeClient();
  const timer = metrics.stripeApiDuration.startTimer({
    operation: 'retrieveCheckoutSession',
  });
  try {
    const session = await stripe.checkout.sessions.retrieve(sessionId, {
      expand: ['payment_intent'],
    });
    timer({ result: 'success' });
    return session;
  } catch (err) {
    timer({ result: 'error' });
    throw err;
  }
}
