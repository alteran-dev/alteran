/**
 * Structured Logging
 * Provides JSON-formatted logs with levels and context
 */

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export interface LogContext {
  requestId?: string;
  path?: string;
  method?: string;
  status?: number;
  duration?: number;
  error?: string;
  stack?: string;
  [key: string]: unknown;
}

export class Logger {
  constructor(private context: LogContext = {}) {}

  private log(level: LogLevel, message: string, extra: LogContext = {}) {
    const entry = {
      level,
      message,
      timestamp: new Date().toISOString(),
      ...this.context,
      ...extra,
    };

    console.log(JSON.stringify(entry));
  }

  debug(message: string, context?: LogContext) {
    this.log('debug', message, context);
  }

  info(message: string, context?: LogContext) {
    this.log('info', message, context);
  }

  warn(message: string, context?: LogContext) {
    this.log('warn', message, context);
  }

  error(message: string, error?: Error | unknown, context?: LogContext) {
    const errorContext: LogContext = { ...context };

    if (error instanceof Error) {
      errorContext.error = error.message;
      errorContext.stack = error.stack;
      errorContext.errorName = error.name;
    } else if (error) {
      errorContext.error = String(error);
    }

    this.log('error', message, errorContext);
  }

  child(context: LogContext): Logger {
    return new Logger({ ...this.context, ...context });
  }
}

// Global logger instance
export const logger = new Logger();

/**
 * Create a request-scoped logger
 */
export function createRequestLogger(requestId: string, path: string, method: string): Logger {
  return logger.child({ requestId, path, method });
}