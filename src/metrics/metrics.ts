import { Counter, Histogram, Gauge, Registry } from 'prom-client';

/**
 * All custom Prometheus metrics for the payment system.
 * Each metric follows the convention: <system>_<name>_<unit>.
 */
class PaymentMetrics {
  readonly register: Registry;

  // ─── HTTP ──────────────────────────────────────────────────────────────────
  readonly httpRequestDuration: Histogram<'method' | 'route' | 'status'>;
  readonly httpErrors: Counter<'status' | 'code'>;

  // ─── Payments ──────────────────────────────────────────────────────────────
  readonly paymentCreated: Counter<'method' | 'currency'>;
  readonly paymentCompleted: Counter<'method' | 'currency'>;
  readonly paymentFailed: Counter<'method' | 'currency' | 'reason'>;
  readonly paymentAmountMinorUnits: Histogram<'method' | 'currency'>;

  // ─── Stripe ────────────────────────────────────────────────────────────────
  readonly stripeApiDuration: Histogram<'operation' | 'result'>;

  // ─── Kafka ─────────────────────────────────────────────────────────────────
  readonly kafkaProducerDuration: Histogram<'topic' | 'result'>;
  readonly kafkaConsumerLag: Gauge<'group' | 'topic' | 'partition'>;

  // ─── Outbox ────────────────────────────────────────────────────────────────
  readonly outboxProcessed: Counter<'topic'>;
  readonly outboxFailed: Counter<'topic'>;

  // ─── Idempotency ───────────────────────────────────────────────────────────
  readonly idempotencyCacheHits: Counter;
  readonly idempotencyCacheMisses: Counter;

  // ─── Reconciliation ────────────────────────────────────────────────────────
  readonly reconciliationMismatches: Counter<'type'>;
  readonly reconciliationDuration: Histogram;
  readonly reconciliationLastRunTimestamp: Gauge;

  // ─── DLQ ───────────────────────────────────────────────────────────────────
  readonly dlqMessagesTotal: Counter<'topic'>;

  // ─── Retry queue ───────────────────────────────────────────────────────────
  readonly retryQueueProcessed: Counter<'eventType'>;

  // ─── Stuck payments ────────────────────────────────────────────────────────
  readonly stuckPaymentsDetected: Counter<'method'>;
  readonly stuckPaymentsRecovered: Counter<'method' | 'outcome'>;

  constructor() {
    this.register = new Registry();
    this.register.setDefaultLabels({ app: 'payment-system' });

    this.httpRequestDuration = new Histogram({
      name: 'http_request_duration_seconds',
      help: 'HTTP request duration in seconds',
      labelNames: ['method', 'route', 'status'],
      buckets: [0.01, 0.05, 0.1, 0.25, 0.5, 1, 2, 5],
      registers: [this.register],
    });

    this.httpErrors = new Counter({
      name: 'http_errors_total',
      help: 'Total HTTP errors by status code and error code',
      labelNames: ['status', 'code'],
      registers: [this.register],
    });

    this.paymentCreated = new Counter({
      name: 'payment_created_total',
      help: 'Total payments created',
      labelNames: ['method', 'currency'],
      registers: [this.register],
    });

    this.paymentCompleted = new Counter({
      name: 'payment_completed_total',
      help: 'Total payments completed successfully',
      labelNames: ['method', 'currency'],
      registers: [this.register],
    });

    this.paymentFailed = new Counter({
      name: 'payment_failed_total',
      help: 'Total payments that failed',
      labelNames: ['method', 'currency', 'reason'],
      registers: [this.register],
    });

    this.paymentAmountMinorUnits = new Histogram({
      name: 'payment_amount_minor_units',
      help: 'Distribution of payment amounts in minor units',
      labelNames: ['method', 'currency'],
      buckets: [100, 500, 1000, 5000, 10000, 50000, 100000, 500000],
      registers: [this.register],
    });

    this.stripeApiDuration = new Histogram({
      name: 'stripe_api_call_duration_seconds',
      help: 'Stripe API call duration',
      labelNames: ['operation', 'result'],
      buckets: [0.1, 0.3, 0.5, 1, 2, 5, 10],
      registers: [this.register],
    });

    this.kafkaProducerDuration = new Histogram({
      name: 'kafka_producer_send_duration_seconds',
      help: 'Kafka producer send duration',
      labelNames: ['topic', 'result'],
      buckets: [0.005, 0.01, 0.05, 0.1, 0.5, 1],
      registers: [this.register],
    });

    this.kafkaConsumerLag = new Gauge({
      name: 'kafka_consumer_group_lag',
      help: 'Kafka consumer group lag by topic and partition',
      labelNames: ['group', 'topic', 'partition'],
      registers: [this.register],
    });

    this.outboxProcessed = new Counter({
      name: 'outbox_processed_total',
      help: 'Total outbox messages successfully published to Kafka',
      labelNames: ['topic'],
      registers: [this.register],
    });

    this.outboxFailed = new Counter({
      name: 'outbox_failed_total',
      help: 'Total outbox messages permanently failed',
      labelNames: ['topic'],
      registers: [this.register],
    });

    this.idempotencyCacheHits = new Counter({
      name: 'idempotency_cache_hits_total',
      help: 'Idempotency Redis cache hits',
      registers: [this.register],
    });

    this.idempotencyCacheMisses = new Counter({
      name: 'idempotency_cache_misses_total',
      help: 'Idempotency Redis cache misses (new requests)',
      registers: [this.register],
    });

    this.reconciliationMismatches = new Counter({
      name: 'reconciliation_mismatch_total',
      help: 'Reconciliation mismatches found by type',
      labelNames: ['type'],
      registers: [this.register],
    });

    this.reconciliationDuration = new Histogram({
      name: 'reconciliation_duration_seconds',
      help: 'Time taken to run nightly reconciliation',
      buckets: [1, 5, 10, 30, 60, 120, 300],
      registers: [this.register],
    });

    this.reconciliationLastRunTimestamp = new Gauge({
      name: 'reconciliation_last_run_timestamp_seconds',
      help: 'Unix timestamp of the last successful reconciliation run',
      registers: [this.register],
    });

    this.dlqMessagesTotal = new Counter({
      name: 'kafka_dlq_messages_total',
      help: 'Messages routed to dead-letter topics',
      labelNames: ['topic'],
      registers: [this.register],
    });

    this.retryQueueProcessed = new Counter({
      name: 'payment_retry_queue_processed_total',
      help: 'Messages processed from the retry queue',
      labelNames: ['eventType'],
      registers: [this.register],
    });

    this.stuckPaymentsDetected = new Counter({
      name: 'payment_stuck_detected_total',
      help: 'Payments found stuck in PROCESSING beyond their threshold',
      labelNames: ['method'],
      registers: [this.register],
    });

    this.stuckPaymentsRecovered = new Counter({
      name: 'payment_stuck_recovered_total',
      help: 'Stuck payments resolved by the checker (outcome: completed | failed)',
      labelNames: ['method', 'outcome'],
      registers: [this.register],
    });
  }
}

// Singleton — import `metrics` everywhere
export const metrics = new PaymentMetrics();
