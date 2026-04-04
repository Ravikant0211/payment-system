function requireEnv(key: string): string {
  const value = process.env[key];
  if (!value) throw new Error(`Missing required environment variable: ${key}`);
  return value;
}

export const stripeConfig = {
  secretKey: requireEnv('STRIPE_SECRET_KEY'),
  webhookSecret: requireEnv('STRIPE_WEBHOOK_SECRET'),
  apiVersion: (process.env['STRIPE_API_VERSION'] ??
    '2023-10-16') as '2023-10-16',
} as const;
