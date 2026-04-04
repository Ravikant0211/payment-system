import { Pool } from 'pg';
import { databaseConfig } from '@/config';
import { logger } from '@/common/logger/logger';

let pool: Pool | null = null;

export function getPool(): Pool {
  if (!pool) {
    pool = new Pool({
      connectionString: databaseConfig.url,
      min: databaseConfig.poolMin,
      max: databaseConfig.poolMax,
      ssl: databaseConfig.ssl ? { rejectUnauthorized: false } : false,
      idleTimeoutMillis: 30_000,
      connectionTimeoutMillis: 5_000,
    });

    pool.on('error', (err) => {
      logger.error({ err }, 'Unexpected error on idle PostgreSQL client');
    });

    pool.on('connect', () => {
      logger.debug('New PostgreSQL client connected');
    });
  }
  return pool;
}

export async function closePool(): Promise<void> {
  if (pool) {
    await pool.end();
    pool = null;
    logger.info('PostgreSQL pool closed');
  }
}
