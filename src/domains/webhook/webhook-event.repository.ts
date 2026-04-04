import { Pool, PoolClient } from 'pg';

export interface WebhookEventRow {
  id: string;
  stripeEventId: string;
  eventType: string;
  processed: boolean;
  processedAt: Date | null;
  processingError: string | null;
  createdAt: Date;
}

export class WebhookEventRepository {
  constructor(private readonly pool: Pool) {}

  async findByStripeEventId(
    client: PoolClient,
    stripeEventId: string,
  ): Promise<WebhookEventRow | null> {
    const { rows } = await client.query<{
      id: string;
      stripe_event_id: string;
      event_type: string;
      processed: boolean;
      processed_at: Date | null;
      processing_error: string | null;
      created_at: Date;
    }>(
      'SELECT * FROM webhook_events WHERE stripe_event_id = $1 FOR UPDATE',
      [stripeEventId],
    );
    if (!rows[0]) return null;
    return {
      id: rows[0].id,
      stripeEventId: rows[0].stripe_event_id,
      eventType: rows[0].event_type,
      processed: rows[0].processed,
      processedAt: rows[0].processed_at,
      processingError: rows[0].processing_error,
      createdAt: rows[0].created_at,
    };
  }

  async create(
    client: PoolClient,
    stripeEventId: string,
    eventType: string,
    rawPayload: unknown,
  ): Promise<string> {
    const { rows } = await client.query<{ id: string }>(
      `INSERT INTO webhook_events (stripe_event_id, event_type, raw_payload)
       VALUES ($1, $2, $3)
       RETURNING id`,
      [stripeEventId, eventType, JSON.stringify(rawPayload)],
    );
    return rows[0]!.id;
  }

  async markProcessed(client: PoolClient, id: string): Promise<void> {
    await client.query(
      `UPDATE webhook_events
       SET processed = true, processed_at = NOW()
       WHERE id = $1`,
      [id],
    );
  }

  async markFailed(
    client: PoolClient,
    id: string,
    error: string,
  ): Promise<void> {
    await client.query(
      `UPDATE webhook_events SET processing_error = $2 WHERE id = $1`,
      [id, error],
    );
  }
}
