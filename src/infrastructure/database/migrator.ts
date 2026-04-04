import * as fs from 'fs';
import * as path from 'path';
import { Pool } from 'pg';
import { getPool } from './pg-pool';
import { logger } from '@/common/logger/logger';

const MIGRATIONS_DIR = path.resolve(process.cwd(), 'migrations');
const ADVISORY_LOCK_ID = 987654321; // unique integer for this app

export async function runMigrations(pool?: Pool): Promise<void> {
  const db = pool ?? getPool();

  // Ensure migrations tracking table exists
  await db.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version     VARCHAR(255) PRIMARY KEY,
      applied_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);

  // Acquire advisory lock so concurrent instances don't race
  await db.query(`SELECT pg_advisory_lock($1)`, [ADVISORY_LOCK_ID]);

  try {
    const files = fs
      .readdirSync(MIGRATIONS_DIR)
      .filter((f) => f.endsWith('.sql'))
      .sort();

    const { rows: applied } = await db.query<{ version: string }>(
      'SELECT version FROM schema_migrations ORDER BY version',
    );
    const appliedSet = new Set(applied.map((r) => r.version));

    for (const file of files) {
      if (appliedSet.has(file)) {
        logger.debug({ migration: file }, 'Migration already applied, skipping');
        continue;
      }

      const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, file), 'utf-8');
      logger.info({ migration: file }, 'Applying migration');

      const client = await db.connect();
      try {
        await client.query('BEGIN');
        await client.query(sql);
        await client.query(
          'INSERT INTO schema_migrations (version) VALUES ($1)',
          [file],
        );
        await client.query('COMMIT');
        logger.info({ migration: file }, 'Migration applied successfully');
      } catch (err) {
        await client.query('ROLLBACK');
        logger.error({ err, migration: file }, 'Migration failed');
        throw err;
      } finally {
        client.release();
      }
    }
  } finally {
    await db.query(`SELECT pg_advisory_unlock($1)`, [ADVISORY_LOCK_ID]);
  }
}
