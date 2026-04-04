function requireEnv(key: string): string {
  const value = process.env[key];
  if (!value) throw new Error(`Missing required environment variable: ${key}`);
  return value;
}

export const databaseConfig = {
  url: requireEnv('DATABASE_URL'),
  poolMin: parseInt(process.env['DATABASE_POOL_MIN'] ?? '2', 10),
  poolMax: parseInt(process.env['DATABASE_POOL_MAX'] ?? '10', 10),
  ssl: process.env['DATABASE_SSL'] === 'true',
} as const;
