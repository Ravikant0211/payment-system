import pino from 'pino';
import { appConfig } from '@/config';
import { getTraceContext } from '@/common/tracing/trace-context';

export const logger = pino({
  level: appConfig.logLevel,
  transport:
    appConfig.isDevelopment
      ? { target: 'pino-pretty', options: { colorize: true, singleLine: false } }
      : undefined,
  formatters: {
    level: (label) => ({ level: label }),
    bindings: (bindings) => ({ pid: bindings['pid'], hostname: bindings['hostname'] }),
  },
  // Inject trace context into every log line automatically
  mixin: () => {
    const ctx = getTraceContext();
    return ctx ? { traceId: ctx.traceId, correlationId: ctx.correlationId } : {};
  },
  timestamp: pino.stdTimeFunctions.isoTime,
});
