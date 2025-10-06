import type { Env } from '../env';
import { logger } from './logger';

/**
 * Required environment variables/secrets
 */
const REQUIRED_SECRETS = [
  'PDS_DID',
  'PDS_HANDLE',
] as const;

/**
 * Optional environment variables with defaults
 */
const OPTIONAL_VARS = {
  PDS_ALLOWED_MIME: 'image/jpeg,image/png,image/webp,image/gif,image/avif',
  PDS_MAX_BLOB_SIZE: '5242880', // 5MB
  PDS_MAX_JSON_BYTES: '65536', // 64KB
  PDS_RATE_LIMIT_PER_MIN: '60',
  PDS_CORS_ORIGIN: '*',
  PDS_SEQ_WINDOW: '512',
  ENVIRONMENT: 'development',
  PDS_BSKY_APP_VIEW_URL: 'https://public.api.bsky.app',
  PDS_BSKY_APP_VIEW_DID: 'did:web:api.bsky.app',
  PDS_BSKY_APP_VIEW_CDN_URL_PATTERN: '',
} as const;

/**
 * Configuration validation result
 */
export interface ConfigValidationResult {
  valid: boolean;
  missing: string[];
  warnings: string[];
  config: {
    required: Record<string, string>;
    optional: Record<string, string>;
  };
}

/**
 * Validate environment configuration on startup
 * Checks for required secrets and logs configuration status
 *
 * @param env - Worker environment
 * @returns Validation result with missing secrets and warnings
 */
export function validateConfig(env: Env): ConfigValidationResult {
  const missing: string[] = [];
  const warnings: string[] = [];
  const required: Record<string, string> = {};
  const optional: Record<string, string> = {};

  // Check required secrets
  for (const secret of REQUIRED_SECRETS) {
    const value = env[secret];
    if (!value || value === '') {
      missing.push(secret);
    } else {
      required[secret] = '***'; // Mask secret values in logs
    }
  }

  // Check optional vars and apply defaults
  for (const [key, defaultValue] of Object.entries(OPTIONAL_VARS)) {
    const value = env[key as keyof Env] as string | undefined;
    optional[key] = value || defaultValue;
  }

  // Validate specific configurations

  // CORS validation
  const corsOrigin = optional.PDS_CORS_ORIGIN;
  if (corsOrigin === '*' && optional.ENVIRONMENT === 'production') {
    warnings.push('PDS_CORS_ORIGIN is set to wildcard (*) in production - this is insecure');
  }

  // DID format validation
  const did = env.PDS_DID;
  if (did && !did.startsWith('did:')) {
    warnings.push(`PDS_DID should start with 'did:' (got: ${did})`);
  }

  // Handle format validation
  const handle = env.PDS_HANDLE;
  if (handle && handle.includes('://')) {
    warnings.push(`PDS_HANDLE should not include protocol (got: ${handle})`);
  }

  // Numeric validation
  const maxBlobSize = parseInt(optional.PDS_MAX_BLOB_SIZE);
  if (isNaN(maxBlobSize) || maxBlobSize <= 0) {
    warnings.push(`PDS_MAX_BLOB_SIZE must be a positive number (got: ${optional.PDS_MAX_BLOB_SIZE})`);
  }

  const maxJsonBytes = parseInt(optional.PDS_MAX_JSON_BYTES);
  if (isNaN(maxJsonBytes) || maxJsonBytes <= 0) {
    warnings.push(`PDS_MAX_JSON_BYTES must be a positive number (got: ${optional.PDS_MAX_JSON_BYTES})`);
  }

  const rateLimit = parseInt(optional.PDS_RATE_LIMIT_PER_MIN);
  if (isNaN(rateLimit) || rateLimit <= 0) {
    warnings.push(`PDS_RATE_LIMIT_PER_MIN must be a positive number (got: ${optional.PDS_RATE_LIMIT_PER_MIN})`);
  }

  // Check for signing key
  if (!env.REPO_SIGNING_KEY) {
    warnings.push('REPO_SIGNING_KEY is not set - repository commits will not be signed');
  }

  // Service-auth now uses REPO_SIGNING_KEY (Ed25519). No separate service key required.

  const valid = missing.length === 0;

  return {
    valid,
    missing,
    warnings,
    config: {
      required,
      optional,
    },
  };
}

/**
 * Log configuration validation results
 *
 * @param result - Validation result
 */
export function logConfigValidation(result: ConfigValidationResult): void {
  if (result.valid) {
    logger.info('config_validation', {
      message: 'Configuration validated successfully',
      environment: result.config.optional.ENVIRONMENT,
      warnings: result.warnings.length,
    });

    if (result.warnings.length > 0) {
      for (const warning of result.warnings) {
        logger.warn('config_validation', { message: warning });
      }
    }
  } else {
    logger.error('config_validation', {
      message: 'Configuration validation failed',
      missing: result.missing,
      warnings: result.warnings,
    });
  }
}

/**
 * Validate configuration and fail fast if invalid
 * Call this on worker startup to ensure proper configuration
 *
 * @param env - Worker environment
 * @throws Error if configuration is invalid
 */
export function validateConfigOrThrow(env: Env): void {
  const result = validateConfig(env);
  logConfigValidation(result);

  if (!result.valid) {
    const error = new Error(
      `Configuration validation failed. Missing required secrets: ${result.missing.join(', ')}`
    );
    logger.error('config_validation', {
      message: 'Startup failed due to invalid configuration',
      error: error.message,
    });
    throw error;
  }
}

/**
 * Get parsed configuration values with defaults applied
 *
 * @param env - Worker environment
 * @returns Parsed configuration object
 */
export function getConfig(env: Env) {
  const result = validateConfig(env);

  return {
    // Required
    did: env.PDS_DID!,
    handle: env.PDS_HANDLE!,

    // Optional with defaults
    allowedMime: result.config.optional.PDS_ALLOWED_MIME.split(','),
    maxBlobSize: parseInt(result.config.optional.PDS_MAX_BLOB_SIZE),
    maxJsonBytes: parseInt(result.config.optional.PDS_MAX_JSON_BYTES),
    rateLimitPerMin: parseInt(result.config.optional.PDS_RATE_LIMIT_PER_MIN),
    corsOrigin: result.config.optional.PDS_CORS_ORIGIN,
    seqWindow: parseInt(result.config.optional.PDS_SEQ_WINDOW),
    environment: result.config.optional.ENVIRONMENT,
    appView: {
      url: result.config.optional.PDS_BSKY_APP_VIEW_URL,
      did: result.config.optional.PDS_BSKY_APP_VIEW_DID,
      cdnUrlPattern:
        result.config.optional.PDS_BSKY_APP_VIEW_CDN_URL_PATTERN?.trim() || undefined,
    },

    // Optional
    repoSigningKey: env.REPO_SIGNING_KEY,
    hostname: env.PDS_HOSTNAME,
    accessTtlSec: env.PDS_ACCESS_TTL_SEC ? parseInt(env.PDS_ACCESS_TTL_SEC) : 3600,
    refreshTtlSec: env.PDS_REFRESH_TTL_SEC ? parseInt(env.PDS_REFRESH_TTL_SEC) : 2592000,
    serviceSigningKeyHex: undefined,
  };
}

export type Config = ReturnType<typeof getConfig>;
