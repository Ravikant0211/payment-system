import pino from 'pino';
import { appConfig } from '@/config';
import { getTraceContext } from '@/common/tracing/trace-context';

export const logger = pino({
  level: appConfig.logLevel,
  // exactOptionalPropertyTypes: omit the key entirely in production rather than setting it to
  // undefined — pino's LoggerOptions.transport does not accept undefined as a value.
  ...(appConfig.isDevelopment
    ? { transport: { target: 'pino-pretty', options: { colorize: true, singleLine: false } } }
    : {}),
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
