/**
 * CLI utility: manually trigger reconciliation for a specific date.
 * Usage: ts-node scripts/run-reconciliation.ts [YYYY-MM-DD]
 * Defaults to yesterday if no date provided.
 */

import 'dotenv/config';
import { getPool, closePool } from '../src/infrastructure/database/pg-pool';
import { getProducer, disconnectProducer } from '../src/infrastructure/kafka/producer';
import { ReconciliationService } from '../src/domains/reconciliation/reconciliation.service';

async function main(): Promise<void> {
  const dateArg = process.argv[2];
  const targetDate = dateArg ? new Date(dateArg) : (() => {
    const d = new Date();
    d.setUTCDate(d.getUTCDate() - 1);
    d.setUTCHours(0, 0, 0, 0);
    return d;
  })();

  if (isNaN(targetDate.getTime())) {
    console.error('Invalid date format. Use YYYY-MM-DD');
    process.exit(1);
  }

  console.log(`Running reconciliation for: ${targetDate.toISOString().split('T')[0]}`);

  const pool = getPool();
  await getProducer();

  const service = new ReconciliationService(pool);
  await service.runReconciliation(targetDate);

  console.log('Reconciliation complete');

  await disconnectProducer();
  await closePool();
}

main().catch((err) => {
  console.error('Reconciliation failed:', err);
  process.exit(1);
});
