import Stripe from 'stripe';
import { stripeConfig } from '@/config';

let stripeClient: Stripe | null = null;

export function getStripeClient(): Stripe {
  if (!stripeClient) {
    stripeClient = new Stripe(stripeConfig.secretKey, {
      apiVersion: stripeConfig.apiVersion,
      maxNetworkRetries: 3,
      timeout: 10_000,
    });
  }
  return stripeClient;
}
