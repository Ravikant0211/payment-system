import { Router, Request, Response, NextFunction } from 'express';
import { Pool } from 'pg';
import { sendMessage } from '@/infrastructure/kafka/producer';
import { LedgerRepository } from '@/domains/ledger/ledger.repository';
import { logger } from '@/common/logger/logger';
import { NotFoundError, ValidationError } from '@/common/errors';

/**
 * Admin router — debugging and operations endpoints.
 *
 * Routes:
 *   GET  /admin/payments/:id/state      Full state dump: payment + event history + ledger entries + outbox + DLQ
 *   GET  /admin/dlq                     List DLQ messages (filterable by topic/status)
 *   POST /admin/dlq/:id/replay          Re-publish to original topic, marks RESOLVED
 *   POST /admin/dlq/:id/discard         Mark as IGNORED without replay
 *
 * Intended for internal operator use only — must sit behind a VPN/private network.
 * No merchant API key auth: operators use internal tooling, not merchant credentials.
 */
export function createAdminRouter(pool: Pool): Router {
  const router = Router();
  const ledgerRepo = new LedgerRepository(pool);

  // ─── Payment state dump ───────────────────────────────────────────────────────

  /**
   * GET /admin/payments/:id/state
   *
   * Full audit snapshot:
   *  - Payment record (current state)
   *  - Ordered event history (status transitions, actors, timestamps)
   *  - All ledger entries (double-entry lines)
   *  - Outbox rows for this payment (pending/sent/failed)
   *  - DLQ messages referencing this payment
   */
  router.get(
    '/payments/:id/state',
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const { id } = req.params as { id: string };

        const [paymentResult, eventsResult, ledgerEntries, outboxResult, dlqResult] =
          await Promise.all([
            pool.query('SELECT * FROM payments WHERE id = $1', [id]),
            pool.query(
              `SELECT * FROM payment_events
               WHERE payment_id = $1
               ORDER BY created_at ASC`,
              [id],
            ),
            ledgerRepo.getEntriesForPayment(id),
            pool.query(
              `SELECT id, event_type, status, retry_count, scheduled_at, sent_at, created_at
               FROM outbox
               WHERE payload->>'paymentId' = $1
               ORDER BY created_at ASC`,
              [id],
            ),
            pool.query(
              `SELECT id, topic, partition, kafka_offset, event_type,
                      error, status, notes, created_at, resolved_at
               FROM dead_letter_messages
               WHERE payment_id = $1
               ORDER BY created_at DESC`,
              [id],
            ),
          ]);

        if (!paymentResult.rows[0]) {
          throw new NotFoundError('Payment', id);
        }

        res.json({
          data: {
            payment: paymentResult.rows[0],
            events:  eventsResult.rows,
            ledger:  ledgerEntries,
            outbox:  outboxResult.rows,
            dlq:     dlqResult.rows,
          },
        });
      } catch (err) {
        next(err);
      }
    },
  );

  // ─── DLQ management ───────────────────────────────────────────────────────────

  /**
   * GET /admin/dlq?topic=&status=OPEN&limit=50&offset=0
   *
   * Lists DLQ messages for operator review.
   * status filter: OPEN (default) | RESOLVED | IGNORED
   */
  router.get(
    '/dlq',
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const statusFilter = (req.query['status'] as string | undefined) ?? 'OPEN';
        const topicFilter  = (req.query['topic']  as string | undefined) ?? '';
        const limit  = Math.min(parseInt((req.query['limit']  as string) ?? '50', 10), 200);
        const offset = parseInt((req.query['offset'] as string) ?? '0', 10);

        const conditions: string[] = ['status = $1'];
        const values: unknown[] = [statusFilter];
        let idx = 2;

        if (topicFilter) {
          conditions.push(`topic ILIKE $${idx++}`);
          values.push(`%${topicFilter}%`);
        }

        const where = conditions.join(' AND ');

        const [rowsResult, countResult] = await Promise.all([
          pool.query(
            `SELECT id, topic, partition, kafka_offset, payment_id, event_type,
                    payload, error, status, notes, created_at, resolved_at
             FROM dead_letter_messages
             WHERE ${where}
             ORDER BY created_at DESC
             LIMIT $${idx++} OFFSET $${idx++}`,
            [...values, limit, offset],
          ),
          pool.query(
            `SELECT COUNT(*) AS total FROM dead_letter_messages WHERE ${where}`,
            values,
          ),
        ]);

        res.json({
          data: rowsResult.rows,
          meta: {
            total:  parseInt((countResult.rows[0] as { total: string }).total, 10),
            limit,
            offset,
          },
        });
      } catch (err) {
        next(err);
      }
    },
  );

  /**
   * POST /admin/dlq/:id/replay
   *
   * Re-publishes the DLQ message payload to the original topic
   * (derived by stripping the `.dlq` suffix from the DLQ topic name),
   * then marks the message RESOLVED.
   *
   * Returns 409 if the message is already resolved or ignored.
   */
  router.post(
    '/dlq/:id/replay',
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const { id } = req.params as { id: string };

        const { rows } = await pool.query<DlqRow>(
          'SELECT * FROM dead_letter_messages WHERE id = $1',
          [id],
        );
        const msg = rows[0];
        if (!msg) throw new NotFoundError('DLQ message', id);

        if (msg.status !== 'OPEN') {
          res.status(409).json({
            error: {
              code:    'ALREADY_RESOLVED',
              message: `DLQ message is already ${msg.status.toLowerCase()}`,
            },
          });
          return;
        }

        // Derive original topic by stripping the trailing '.dlq'
        const originalTopic = msg.topic.endsWith('.dlq')
          ? msg.topic.slice(0, -4)
          : msg.topic;

        const payload = typeof msg.payload === 'string'
          ? JSON.parse(msg.payload) as unknown
          : msg.payload;

        const paymentKey = (payload as Record<string, unknown>)['paymentId'] as string | undefined;

        await sendMessage({
          topic: originalTopic,
          ...(paymentKey ? { key: paymentKey } : {}),
          value:   payload,
          headers: { replayedFromDlq: id, replayedAt: new Date().toISOString() },
        });

        await pool.query(
          `UPDATE dead_letter_messages
           SET status = 'RESOLVED', resolved_at = NOW(), notes = 'replayed by operator'
           WHERE id = $1`,
          [id],
        );

        logger.info(
          { dlqId: id, topic: msg.topic, originalTopic },
          'DLQ message replayed by operator',
        );

        res.json({ data: { replayed: true, originalTopic } });
      } catch (err) {
        next(err);
      }
    },
  );

  /**
   * POST /admin/dlq/:id/discard
   * Body: { "note": "reason" }
   *
   * Marks the message IGNORED without replay.
   * Use when the event represents a known-bad payload that must not be reprocessed.
   */
  router.post(
    '/dlq/:id/discard',
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const { id } = req.params as { id: string };
        const note = ((req.body as Record<string, unknown>)?.['note'] as string | undefined) ?? '';

        if (!note) {
          throw new ValidationError('note is required when discarding a DLQ message');
        }

        const { rows } = await pool.query<Pick<DlqRow, 'id' | 'status'>>(
          'SELECT id, status FROM dead_letter_messages WHERE id = $1',
          [id],
        );
        const msg = rows[0];
        if (!msg) throw new NotFoundError('DLQ message', id);

        if (msg.status !== 'OPEN') {
          res.status(409).json({
            error: {
              code:    'ALREADY_RESOLVED',
              message: `DLQ message is already ${msg.status.toLowerCase()}`,
            },
          });
          return;
        }

        await pool.query(
          `UPDATE dead_letter_messages
           SET status = 'IGNORED', resolved_at = NOW(), notes = $2
           WHERE id = $1`,
          [id, note],
        );

        logger.info({ dlqId: id, note }, 'DLQ message discarded by operator');

        res.json({ data: { discarded: true } });
      } catch (err) {
        next(err);
      }
    },
  );

  return router;
}

// ─── Internal types ────────────────────────────────────────────────────────────

interface DlqRow {
  id: string;
  topic: string;
  partition: number;
  kafka_offset: number;
  payment_id: string | null;
  event_type: string | null;
  payload: unknown;
  error: string;
  status: 'OPEN' | 'RESOLVED' | 'IGNORED';
  notes: string | null;
  resolved_at: Date | null;
  created_at: Date;
}
