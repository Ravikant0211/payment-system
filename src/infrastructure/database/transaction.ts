import { Pool, PoolClient } from 'pg';
import { logger } from '@/common/logger/logger';

/**
 * Executes `fn` inside a PostgreSQL transaction.
 * Rolls back automatically on any error thrown by `fn`.
 * The caller never manages BEGIN / COMMIT / ROLLBACK directly.
 */
export async function withTransaction<T>(
  pool: Pool,
  fn: (client: PoolClient) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK');
    logger.error({ err }, 'Transaction rolled back');
    throw err;
  } finally {
    client.release();
  }
}
