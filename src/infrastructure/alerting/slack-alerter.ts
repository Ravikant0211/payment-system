import { appConfig } from '@/config';
import { logger } from '@/common/logger/logger';

export type AlertSeverity = 'warning' | 'critical';

export interface AlertPayload {
  severity: AlertSeverity;
  title: string;
  message: string;
  fields?: Record<string, string | number>;
}

/**
 * Sends a structured alert to Slack via incoming webhook.
 * Fire-and-forget — never throws so that alert failures don't disrupt the caller.
 *
 * Falls back to logging if ALERT_SLACK_WEBHOOK_URL is not configured.
 */
export async function sendAlert(payload: AlertPayload): Promise<void> {
  const webhookUrl = appConfig.alertSlackWebhookUrl;

  if (!webhookUrl) {
    // Degrade gracefully: log the alert instead of failing
    logger.warn(
      { alertTitle: payload.title, fields: payload.fields },
      `[ALERT/${payload.severity.toUpperCase()}] ${payload.message}`,
    );
    return;
  }

  const color = payload.severity === 'critical' ? '#FF0000' : '#FFA500';
  const emoji = payload.severity === 'critical' ? ':rotating_light:' : ':warning:';

  const slackBody = {
    attachments: [
      {
        color,
        blocks: [
          {
            type: 'header',
            text: {
              type: 'plain_text',
              text: `${emoji} ${payload.title}`,
            },
          },
          {
            type: 'section',
            text: { type: 'mrkdwn', text: payload.message },
          },
          ...(payload.fields
            ? [
                {
                  type: 'section',
                  fields: Object.entries(payload.fields).map(([k, v]) => ({
                    type: 'mrkdwn',
                    text: `*${k}:*\n${v}`,
                  })),
                },
              ]
            : []),
          {
            type: 'context',
            elements: [
              {
                type: 'mrkdwn',
                text: `Sent at ${new Date().toISOString()}`,
              },
            ],
          },
        ],
      },
    ],
  };

  try {
    const response = await fetch(webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(slackBody),
    });

    if (!response.ok) {
      logger.error(
        { status: response.status, alertTitle: payload.title },
        'Slack alert delivery failed',
      );
    }
  } catch (err) {
    // Never propagate — alert failures must not break payment processing
    logger.error({ err, alertTitle: payload.title }, 'Slack alerter error');
  }
}
