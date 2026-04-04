import { Request, Response, NextFunction } from 'express';
import { v4 as uuidv4 } from 'uuid';
import { runWithTraceContext } from '@/common/tracing/trace-context';
import { logger } from '@/common/logger/logger';
import { metrics } from '@/metrics/metrics';

/**
 * Assigns a traceId to every request and runs the rest of the request
 * inside AsyncLocalStorage so all log lines automatically carry the traceId.
 * Also records request duration in Prometheus.
 */
export function requestLogger(
  req: Request,
  res: Response,
  next: NextFunction,
): void {
  const traceId =
    (req.headers['x-trace-id'] as string | undefined) ?? uuidv4();
  const correlationId =
    (req.headers['x-correlation-id'] as string | undefined) ?? uuidv4();

  res.setHeader('X-Trace-Id', traceId);
  const start = Date.now();

  const timer = metrics.httpRequestDuration.startTimer({
    method: req.method,
    route: req.path,
  });

  res.on('finish', () => {
    const duration = Date.now() - start;
    timer({ status: String(res.statusCode) });

    logger.info({
      method: req.method,
      url: req.url,
      status: res.statusCode,
      durationMs: duration,
      traceId,
    }, 'HTTP request completed');
  });

  runWithTraceContext({ traceId, correlationId }, () => next());
}
