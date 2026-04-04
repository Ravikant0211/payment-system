import { Pool, PoolClient } from 'pg';
import { Payment, PaymentEvent } from './payment.entity';
import { PaymentMethodValue, PaymentStatusValue } from './payment-status.enum';
import { NotFoundError } from '@/common/errors';

export interface CreatePaymentParams {
  merchantId: string;
  orderId: string;
  customerId: string;
  idempotencyKey: string;
  amount: number;
  currency: string;
  paymentMethod: PaymentMethodValue;
  successUrl: string;
  cancelUrl: string;
  metadata: Record<string, string>;
}

export interface UpdatePaymentStatusParams {
  id: string;
  status: PaymentStatusValue;
  stripeSessionId?: string;
  stripePaymentIntentId?: string;
  checkoutUrl?: string;
  failureReason?: string;
}

export interface ListPaymentsOptions {
  merchantId: string;
  cursor?: string;
  limit: number;
  status?: PaymentStatusValue;
  fromDate?: Date;
  toDate?: Date;
}

export interface PaymentPage {
  payments: Payment[];
  nextCursor: string | null;
}

/**
 * PaymentRepository: all SQL for the payments domain.
 * Never contains business logic — that lives in PaymentService.
 */
export class PaymentRepository {
  constructor(private readonly pool: Pool) {}

  async create(
    client: PoolClient,
    params: CreatePaymentParams,
  ): Promise<Payment> {
    const { rows } = await client.query<DbPaymentRow>(
      `INSERT INTO payments
         (merchant_id, order_id, customer_id, idempotency_key,
          amount, currency, payment_method, status,
          success_url, cancel_url, metadata)
       VALUES ($1,$2,$3,$4,$5,$6,$7,'PENDING',$8,$9,$10)
       RETURNING *`,
      [
        params.merchantId,
        params.orderId,
        params.customerId,
        params.idempotencyKey,
        params.amount,
        params.currency,
        params.paymentMethod,
        params.successUrl,
        params.cancelUrl,
        JSON.stringify(params.metadata),
      ],
    );
    return toPayment(rows[0]!);
  }

  async findById(id: string): Promise<Payment | null> {
    const { rows } = await this.pool.query<DbPaymentRow>(
      'SELECT * FROM payments WHERE id = $1',
      [id],
    );
    return rows[0] ? toPayment(rows[0]) : null;
  }

  async findByIdOrThrow(id: string): Promise<Payment> {
    const payment = await this.findById(id);
    if (!payment) throw new NotFoundError('Payment', id);
    return payment;
  }

  async findByStripeSessionId(sessionId: string): Promise<Payment | null> {
    const { rows } = await this.pool.query<DbPaymentRow>(
      'SELECT * FROM payments WHERE stripe_session_id = $1',
      [sessionId],
    );
    return rows[0] ? toPayment(rows[0]) : null;
  }

  async findByIdempotencyKey(
    merchantId: string,
    idempotencyKey: string,
  ): Promise<Payment | null> {
    const { rows } = await this.pool.query<DbPaymentRow>(
      'SELECT * FROM payments WHERE merchant_id = $1 AND idempotency_key = $2',
      [merchantId, idempotencyKey],
    );
    return rows[0] ? toPayment(rows[0]) : null;
  }

  async updateStatus(
    client: PoolClient,
    params: UpdatePaymentStatusParams,
  ): Promise<Payment> {
    const { rows } = await client.query<DbPaymentRow>(
      `UPDATE payments SET
         status = $2,
         stripe_session_id = COALESCE($3, stripe_session_id),
         stripe_payment_intent_id = COALESCE($4, stripe_payment_intent_id),
         checkout_url = COALESCE($5, checkout_url),
         failure_reason = COALESCE($6, failure_reason),
         updated_at = NOW()
       WHERE id = $1
       RETURNING *`,
      [
        params.id,
        params.status,
        params.stripeSessionId ?? null,
        params.stripePaymentIntentId ?? null,
        params.checkoutUrl ?? null,
        params.failureReason ?? null,
      ],
    );
    if (!rows[0]) throw new NotFoundError('Payment', params.id);
    return toPayment(rows[0]);
  }

  /**
   * Keyset (cursor) pagination — O(log n) regardless of dataset size.
   * Cursor encodes (createdAt, id) of the last item in the previous page.
   */
  async list(opts: ListPaymentsOptions): Promise<PaymentPage> {
    const conditions: string[] = ['p.merchant_id = $1'];
    const values: unknown[] = [opts.merchantId];
    let idx = 2;

    if (opts.status) {
      conditions.push(`p.status = $${idx++}`);
      values.push(opts.status);
    }
    if (opts.fromDate) {
      conditions.push(`p.created_at >= $${idx++}`);
      values.push(opts.fromDate);
    }
    if (opts.toDate) {
      conditions.push(`p.created_at <= $${idx++}`);
      values.push(opts.toDate);
    }
    if (opts.cursor) {
      const { createdAt, id } = decodeCursor(opts.cursor);
      conditions.push(
        `(p.created_at, p.id) < ($${idx++}::timestamptz, $${idx++}::uuid)`,
      );
      values.push(createdAt, id);
    }

    const where = conditions.join(' AND ');
    values.push(opts.limit + 1);

    const { rows } = await this.pool.query<DbPaymentRow>(
      `SELECT p.* FROM payments p
       WHERE ${where}
       ORDER BY p.created_at DESC, p.id DESC
       LIMIT $${idx}`,
      values,
    );

    const hasMore = rows.length > opts.limit;
    const data = hasMore ? rows.slice(0, opts.limit) : rows;
    const payments = data.map((r) => toPayment(r));
    const lastItem = data[data.length - 1];
    const nextCursor =
      hasMore && lastItem
        ? encodeCursor(lastItem.created_at, lastItem.id)
        : null;

    return { payments, nextCursor };
  }

  async recordEvent(
    client: PoolClient,
    event: Omit<PaymentEvent, 'id' | 'createdAt'>,
  ): Promise<void> {
    await client.query(
      `INSERT INTO payment_events
         (payment_id, event_type, old_status, new_status, actor, payload)
       VALUES ($1,$2,$3,$4,$5,$6)`,
      [
        event.paymentId,
        event.eventType,
        event.oldStatus ?? null,
        event.newStatus ?? null,
        event.actor,
        JSON.stringify(event.payload),
      ],
    );
  }

  /**
   * Returns payments stuck in PROCESSING state beyond the given age threshold.
   * Used by StuckPaymentsChecker to detect and recover delayed payments.
   *
   * Different payment methods have different thresholds:
   *   - CREDIT_CARD / DEBIT_CARD: 35 min (Stripe session is 30 min; +5 min buffer)
   *   - UPI / NET_BANKING: 3 hours (bank processing can legitimately take longer)
   */
  async findStuckPayments(olderThanMinutes: number): Promise<Payment[]> {
    const { rows } = await this.pool.query<DbPaymentRow>(
      `SELECT * FROM payments
       WHERE status = 'PROCESSING'
         AND updated_at < NOW() - ($1 || ' minutes')::INTERVAL
       ORDER BY updated_at ASC
       LIMIT 100`,
      [olderThanMinutes],
    );
    return rows.map(toPayment);
  }

  /** Returns all payments with COMPLETED status for a given date (for reconciliation) */
  async findCompletedForDate(date: Date): Promise<Payment[]> {
    const start = new Date(date);
    start.setUTCHours(0, 0, 0, 0);
    const end = new Date(date);
    end.setUTCHours(23, 59, 59, 999);

    const { rows } = await this.pool.query<DbPaymentRow>(
      `SELECT * FROM payments
       WHERE status = 'COMPLETED'
         AND created_at BETWEEN $1 AND $2`,
      [start, end],
    );
    return rows.map(toPayment);
  }
}

// ─── DB row → domain entity mapping ─────────────────────────────────────────

interface DbPaymentRow {
  id: string;
  merchant_id: string;
  order_id: string;
  customer_id: string;
  idempotency_key: string;
  amount: string;
  currency: string;
  payment_method: PaymentMethodValue;
  status: PaymentStatusValue;
  stripe_session_id: string | null;
  stripe_payment_intent_id: string | null;
  checkout_url: string | null;
  failure_reason: string | null;
  retry_count: string;
  success_url: string;
  cancel_url: string;
  metadata: Record<string, string>;
  created_at: Date;
  updated_at: Date;
}

function toPayment(row: DbPaymentRow): Payment {
  return {
    id:                    row.id,
    merchantId:            row.merchant_id,
    orderId:               row.order_id,
    customerId:            row.customer_id,
    idempotencyKey:        row.idempotency_key,
    amount:                parseInt(row.amount, 10),
    currency:              row.currency,
    paymentMethod:         row.payment_method,
    status:                row.status,
    stripeSessionId:       row.stripe_session_id,
    stripePaymentIntentId: row.stripe_payment_intent_id,
    checkoutUrl:           row.checkout_url,
    failureReason:         row.failure_reason,
    retryCount:            parseInt(row.retry_count, 10),
    successUrl:            row.success_url,
    cancelUrl:             row.cancel_url,
    metadata:              row.metadata ?? {},
    createdAt:             row.created_at,
    updatedAt:             row.updated_at,
  };
}

// ─── Cursor helpers (keyset pagination) ─────────────────────────────────────

function encodeCursor(createdAt: Date, id: string): string {
  return Buffer.from(
    JSON.stringify({ createdAt: createdAt.toISOString(), id }),
  ).toString('base64url');
}

function decodeCursor(cursor: string): { createdAt: string; id: string } {
  return JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as {
    createdAt: string;
    id: string;
  };
}
