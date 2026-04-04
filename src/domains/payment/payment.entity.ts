import { PaymentMethodValue, PaymentStatusValue } from './payment-status.enum';

/**
 * Payment entity — the aggregate root for a payment transaction.
 * Immutable value object; state transitions produce new instances via the service layer.
 */
export interface Payment {
  readonly id: string;
  readonly merchantId: string;
  readonly orderId: string;
  readonly customerId: string;
  readonly idempotencyKey: string;
  readonly amount: number;          // minor units
  readonly currency: string;
  readonly paymentMethod: PaymentMethodValue;
  readonly status: PaymentStatusValue;
  readonly stripeSessionId: string | null;
  readonly stripePaymentIntentId: string | null;
  readonly checkoutUrl: string | null;
  readonly failureReason: string | null;
  readonly retryCount: number;
  readonly successUrl: string;
  readonly cancelUrl: string;
  readonly metadata: Record<string, string>;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export interface PaymentEvent {
  readonly id: string;
  readonly paymentId: string;
  readonly eventType: string;
  readonly oldStatus: PaymentStatusValue | null;
  readonly newStatus: PaymentStatusValue | null;
  readonly actor: string;
  readonly payload: Record<string, unknown>;
  readonly createdAt: Date;
}
