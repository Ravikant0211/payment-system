import Stripe from 'stripe';
import { getStripeClient } from './stripe-client';
import { stripeConfig } from '@/config';
import { logger } from '@/common/logger/logger';

export function parseStripeWebhook(
  rawBody: Buffer,
  signature: string,
): Stripe.Event {
  const stripe = getStripeClient();
  try {
    return stripe.webhooks.constructEvent(
      rawBody,
      signature,
      stripeConfig.webhookSecret,
    );
  } catch (err) {
    logger.warn({ err }, 'Stripe webhook signature verification failed');
    throw err;
  }
}

// Type-narrowing helpers for each handled event
export function isCheckoutSessionCompleted(
  event: Stripe.Event,
): event is Stripe.Event & { data: { object: Stripe.Checkout.Session } } {
  return event.type === 'checkout.session.completed';
}

export function isCheckoutSessionExpired(
  event: Stripe.Event,
): event is Stripe.Event & { data: { object: Stripe.Checkout.Session } } {
  return event.type === 'checkout.session.expired';
}

export function isPaymentIntentFailed(
  event: Stripe.Event,
): event is Stripe.Event & { data: { object: Stripe.PaymentIntent } } {
  return event.type === 'payment_intent.payment_failed';
}

export function isChargeRefunded(
  event: Stripe.Event,
): event is Stripe.Event & { data: { object: Stripe.Charge } } {
  return event.type === 'charge.refunded';
}
