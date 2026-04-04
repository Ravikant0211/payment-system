function requireEnv(key: string): string {
  const value = process.env[key];
  if (!value) throw new Error(`Missing required environment variable: ${key}`);
  return value;
}

function optionalEnv(key: string, fallback: string): string {
  return process.env[key] ?? fallback;
}

export const appConfig = {
  nodeEnv: optionalEnv('NODE_ENV', 'development'),
  port: parseInt(optionalEnv('PORT', '3000'), 10),
  logLevel: optionalEnv('LOG_LEVEL', 'info'),
  isProduction: process.env['NODE_ENV'] === 'production',
  isDevelopment: process.env['NODE_ENV'] === 'development',
  apiKeySalt: requireEnv('API_KEY_SALT'),
  alertSlackWebhookUrl: process.env['ALERT_SLACK_WEBHOOK_URL'],
} as const;
