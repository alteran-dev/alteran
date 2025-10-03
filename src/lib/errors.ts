/**
 * XRPC Error Hierarchy
 * Implements AT Protocol error codes and consistent error handling
 */

export class XRPCError extends Error {
  constructor(
    public code: string,
    message: string,
    public status: number,
    public details?: Record<string, unknown>
  ) {
    super(message);
    this.name = 'XRPCError';
  }

  toJSON() {
    return {
      error: this.code,
      message: this.message,
      ...(this.details && { details: this.details }),
    };
  }

  toResponse(requestId?: string): Response {
    const headers = new Headers({
      'Content-Type': 'application/json',
    });

    if (requestId) {
      headers.set('X-Request-ID', requestId);
    }

    return new Response(JSON.stringify(this.toJSON()), {
      status: this.status,
      headers,
    });
  }
}

// 400 - Bad Request
export class InvalidRequest extends XRPCError {
  constructor(message: string = 'Invalid request parameters', details?: Record<string, unknown>) {
    super('InvalidRequest', message, 400, details);
    this.name = 'InvalidRequest';
  }
}

// 401 - Unauthorized
export class AuthRequired extends XRPCError {
  constructor(message: string = 'Authentication required', details?: Record<string, unknown>) {
    super('AuthRequired', message, 401, details);
    this.name = 'AuthRequired';
  }
}

export class InvalidToken extends XRPCError {
  constructor(message: string = 'Invalid or expired token', details?: Record<string, unknown>) {
    super('InvalidToken', message, 401, details);
    this.name = 'InvalidToken';
  }
}

// 403 - Forbidden
export class Forbidden extends XRPCError {
  constructor(message: string = 'Access forbidden', details?: Record<string, unknown>) {
    super('Forbidden', message, 403, details);
    this.name = 'Forbidden';
  }
}

// 404 - Not Found
export class NotFound extends XRPCError {
  constructor(message: string = 'Resource not found', details?: Record<string, unknown>) {
    super('NotFound', message, 404, details);
    this.name = 'NotFound';
  }
}

// 429 - Rate Limit
export class RateLimitExceeded extends XRPCError {
  constructor(message: string = 'Rate limit exceeded', details?: Record<string, unknown>) {
    super('RateLimitExceeded', message, 429, details);
    this.name = 'RateLimitExceeded';
  }
}

// 500 - Internal Server Error
export class InternalServerError extends XRPCError {
  constructor(message: string = 'Internal server error', details?: Record<string, unknown>) {
    super('InternalServerError', message, 500, details);
    this.name = 'InternalServerError';
  }
}

/**
 * User-friendly error messages
 * Maps technical errors to actionable guidance
 */
export const USER_FRIENDLY_MESSAGES: Record<string, string> = {
  AuthRequired: 'Please log in to continue.',
  InvalidToken: 'Your session has expired. Please log in again.',
  InvalidRequest: 'The request contains invalid data. Please check your input.',
  Forbidden: 'You do not have permission to perform this action.',
  NotFound: 'The requested resource could not be found.',
  RateLimitExceeded: 'Too many requests. Please try again later.',
  InternalServerError: 'An unexpected error occurred. Please try again.',
};

/**
 * Get user-friendly message for error code
 */
export function getUserFriendlyMessage(code: string): string {
  return USER_FRIENDLY_MESSAGES[code] || 'An error occurred. Please try again.';
}

/**
 * Categorize error by status code
 */
export function categorizeError(status: number): 'client' | 'server' {
  return status >= 400 && status < 500 ? 'client' : 'server';
}

/**
 * Convert any error to XRPCError
 */
export function toXRPCError(error: unknown): XRPCError {
  if (error instanceof XRPCError) {
    return error;
  }

  if (error instanceof Error) {
    return new InternalServerError(error.message, {
      originalError: error.name,
      stack: error.stack,
    });
  }

  return new InternalServerError('Unknown error occurred', {
    error: String(error),
  });
}