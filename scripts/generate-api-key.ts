/**
 * CLI utility: generates a new API key and creates a merchant record.
 * Usage: ts-node scripts/generate-api-key.ts <merchant-name> <email>
 */

import 'dotenv/config';
import { getPool, closePool } from '../src/infrastructure/database/pg-pool';
import { generateApiKey, hashApiKey } from '../src/common/utils/crypto';

async function main(): Promise<void> {
  const [, , name, email] = process.argv;
  if (!name || !email) {
    console.error('Usage: ts-node scripts/generate-api-key.ts <name> <email>');
    process.exit(1);
  }

  const pool = getPool();
  const rawKey = generateApiKey();
  const keyHash = hashApiKey(rawKey);

  const { rows } = await pool.query<{ id: string }>(
    `INSERT INTO merchants (name, email, api_key_hash)
     VALUES ($1, $2, $3)
     ON CONFLICT (email) DO UPDATE SET api_key_hash = $3
     RETURNING id`,
    [name, email, keyHash],
  );

  console.log('✓ Merchant created/updated');
  console.log(`  Merchant ID: ${rows[0]?.id}`);
  console.log(`  API Key:     ${rawKey}`);
  console.log('');
  console.log('Store the API key securely — it cannot be recovered.');

  await closePool();
}

main().catch((err) => {
  console.error('Error:', err);
  process.exit(1);
});
