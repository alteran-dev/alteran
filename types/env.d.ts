/// <reference types="astro/client" />

import type {
  D1Database,
  DurableObjectNamespace,
  ExecutionContext,
  R2Bucket,
} from '@cloudflare/workers-types';

declare global {
  interface Env {
    DB: D1Database;
    BLOBS: R2Bucket;
    SEQUENCER?: DurableObjectNamespace;
    PDS_HANDLE?: string;
    PDS_DID?: string;
    PDS_HOSTNAME?: string;
    USER_PASSWORD?: string;
    PDS_MAX_BLOB_SIZE?: string;
    ACCESS_TOKEN_SECRET?: string;
    REFRESH_TOKEN_SECRET?: string;
    PDS_ACCESS_TTL_SEC?: string;
    PDS_REFRESH_TTL_SEC?: string;
    JWT_ALGORITHM?: string;
    JWT_ED25519_PRIVATE_KEY?: string;
    JWT_ED25519_PUBLIC_KEY?: string;
    REPO_SIGNING_KEY?: string;
    PDS_RATE_LIMIT_PER_MIN?: string;
    PDS_MAX_JSON_BYTES?: string;
    PDS_CORS_ORIGIN?: string;
  }

  namespace App {
    interface Locals {
      runtime: {
        env: Env;
        ctx: ExecutionContext;
        request: Request;
      };
      requestId?: string;
    }
  }
}

export {};

export type Env = globalThis.Env;
export type PdsLocals = globalThis.App.Locals;
