import { Pool, PoolClient } from 'pg';

export interface OutboxRow {
  id: string;
  aggregateType: string;
  aggregateId: string;
  topic: string;
  eventType: string;
  payload: unknown;
  headers: Record<string, string>;
  retryCount: number;
  scheduledAt: Date;
  createdAt: Date;
}

export interface InsertOutboxParams {
  aggregateType: string;
  aggregateId: string;
  topic: string;
  eventType: string;
  payload: unknown;
  headers?: Record<string, string>;
  /** When to publish. Defaults to NOW(). Set to a future time for delayed retries. */
  scheduledAt?: Date;
}

export class OutboxRepository {
  constructor(private readonly pool: Pool) {}

  /**
   * Insert an outbox row within an existing transaction.
   * Called alongside domain writes — both commit or both roll back.
   */
  async insert(
    client: PoolClient,
    params: InsertOutboxParams,
  ): Promise<string> {
    const { rows } = await client.query<{ id: string }>(
      `INSERT INTO outbox
         (aggregate_type, aggregate_id, topic, event_type, payload, headers, scheduled_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING id`,
      [
        params.aggregateType,
        params.aggregateId,
        params.topic,
        params.eventType,
        JSON.stringify(params.payload),
        JSON.stringify(params.headers ?? {}),
        params.scheduledAt ?? new Date(),
      ],
    );
    return rows[0]!.id;
  }

  /**
   * Insert a retry outbox row using the pool directly (not inside a domain transaction).
   * Called by the consumer-manager when routing a retryable failure to the retry queue.
   * Uses the pool because the original message transaction has already committed or failed.
   */
  async insertRetry(params: InsertOutboxParams): Promise<string> {
    const { rows } = await this.pool.query<{ id: string }>(
      `INSERT INTO outbox
         (aggregate_type, aggregate_id, topic, event_type, payload, headers, scheduled_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING id`,
      [
        params.aggregateType,
        params.aggregateId,
        params.topic,
        params.eventType,
        JSON.stringify(params.payload),
        JSON.stringify(params.headers ?? {}),
        params.scheduledAt ?? new Date(),
      ],
    );
    return rows[0]!.id;
  }

  /**
   * Fetch pending outbox rows whose scheduled_at has passed.
   * `FOR UPDATE SKIP LOCKED` prevents multiple relay instances from processing
   * the same row concurrently (safe for horizontal scaling).
   */
  async fetchPending(limit: number): Promise<OutboxRow[]> {
    const { rows } = await this.pool.query<{
      id: string;
      aggregate_type: string;
      aggregate_id: string;
      topic: string;
      event_type: string;
      payload: unknown;
      headers: Record<string, string>;
      retry_count: number;
      scheduled_at: Date;
      created_at: Date;
    }>(
      `SELECT id, aggregate_type, aggregate_id, topic, event_type,
              payload, headers, retry_count, scheduled_at, created_at
       FROM outbox
       WHERE status = 'PENDING'
         AND scheduled_at <= NOW()
       ORDER BY scheduled_at ASC
       LIMIT $1
       FOR UPDATE SKIP LOCKED`,
      [limit],
    );

    return rows.map((r) => ({
      id: r.id,
      aggregateType: r.aggregate_type,
      aggregateId: r.aggregate_id,
      topic: r.topic,
      eventType: r.event_type,
      payload: r.payload,
      headers: r.headers,
      retryCount: r.retry_count,
      scheduledAt: r.scheduled_at,
      createdAt: r.created_at,
    }));
  }

  async markProcessed(id: string): Promise<void> {
    await this.pool.query(
      `UPDATE outbox SET status = 'PROCESSED', processed_at = NOW() WHERE id = $1`,
      [id],
    );
  }

  async markFailed(id: string, error: string): Promise<void> {
    await this.pool.query(
      `UPDATE outbox
       SET status = 'FAILED', retry_count = retry_count + 1, last_error = $2
       WHERE id = $1`,
      [id, error],
    );
  }

  async incrementRetry(id: string, error: string): Promise<void> {
    await this.pool.query(
      `UPDATE outbox
       SET retry_count = retry_count + 1, last_error = $2
       WHERE id = $1`,
      [id, error],
    );
  }
}
