/** Error types shared across API clients and the bot layer. */

export class ApiError extends Error {
  constructor(
    message: string,
    readonly service: string,
    readonly status?: number,
    readonly retryable = false,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

export class RateLimitError extends ApiError {
  constructor(service: string, readonly retryAfterMs?: number) {
    super(`${service} rate limit exceeded`, service, 429, true);
    this.name = 'RateLimitError';
  }
}

export class TimeoutError extends ApiError {
  constructor(service: string, timeoutMs: number) {
    super(`${service} did not respond within ${timeoutMs} ms`, service, undefined, true);
    this.name = 'TimeoutError';
  }
}

/** Validation failure for user input — safe to show to the user verbatim. */
export class UserInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UserInputError';
  }
}

export class DatabaseError extends Error {
  constructor(
    message: string,
    readonly operation: string,
    readonly code?: string,
  ) {
    super(message);
    this.name = 'DatabaseError';
  }
}

/** A short message safe to show to Telegram users (never includes URLs or secrets). */
export function userFacingError(err: unknown): string {
  if (err instanceof UserInputError) return err.message;
  if (err instanceof RateLimitError) return `${err.service} is rate limiting requests right now. Please try again in a minute.`;
  if (err instanceof TimeoutError) return `${err.service} is responding slowly. Please try again shortly.`;
  if (err instanceof ApiError) {
    if (err.status === 404) return `${err.service} has no data for that request.`;
    return `${err.service} is temporarily unavailable. Please try again later.`;
  }
  if (err instanceof DatabaseError) return 'The database is temporarily unavailable. Please try again later.';
  return 'Something went wrong while processing your request. Please try again.';
}
