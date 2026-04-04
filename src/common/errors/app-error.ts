/**
 * Base error class for all application errors.
 * `isOperational = true` means the error is expected and handled gracefully.
 * `isOperational = false` means it's a programmer error and the process should restart.
 */
export class AppError extends Error {
  constructor(
    message: string,
    public readonly httpStatus: number,
    public readonly code: string,
    public readonly isOperational: boolean = true,
    public readonly details?: unknown,
  ) {
    super(message);
    this.name = this.constructor.name;
    Error.captureStackTrace(this, this.constructor);
  }
}
