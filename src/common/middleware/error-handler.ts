import { Request, Response, NextFunction } from 'express';
import { ZodError } from 'zod';
import { AppError } from '@/common/errors';
import { logger } from '@/common/logger/logger';
import { metrics } from '@/metrics/metrics';

/**
 * Centralised error handler — must be the last middleware registered.
 *
 * Maps domain errors and library errors to consistent HTTP responses.
 * Never leaks stack traces or internal details in production.
 */
export function errorHandler(
  err: unknown,
  req: Request,
  res: Response,
  _next: NextFunction,
): void {
  if (err instanceof AppError) {
    if (!err.isOperational) {
      logger.fatal({ err }, 'Non-operational error — programmer error');
    } else {
      logger.warn({ err, path: req.path, method: req.method }, err.message);
    }

    metrics.httpErrors.inc({ status: String(err.httpStatus), code: err.code });

    res.status(err.httpStatus).json({
      error: {
        code: err.code,
        message: err.message,
        ...(err.details !== undefined ? { details: err.details } : {}),
      },
    });
    return;
  }

  if (err instanceof ZodError) {
    const formatted = err.errors.map((e) => ({
      field: e.path.join('.'),
      message: e.message,
    }));

    res.status(400).json({
      error: {
        code: 'VALIDATION_ERROR',
        message: 'Request validation failed',
        details: formatted,
      },
    });
    return;
  }

  // Stripe errors
  if (
    err instanceof Error &&
    err.constructor.name === 'StripeError'
  ) {
    logger.error({ err }, 'Stripe API error');
    res.status(502).json({
      error: {
        code: 'PSP_ERROR',
        message: 'Payment service provider error. Please try again.',
      },
    });
    return;
  }

  // Unknown / programmer error
  logger.error({ err, path: req.path, method: req.method }, 'Unhandled error');
  metrics.httpErrors.inc({ status: '500', code: 'INTERNAL_ERROR' });

  res.status(500).json({
    error: {
      code: 'INTERNAL_ERROR',
      message: 'An unexpected error occurred. Please try again later.',
    },
  });
}
