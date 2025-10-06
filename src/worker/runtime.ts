import { seed } from '../db/seed';
import { validateConfigOrThrow } from '../lib/config';
import { resolveEnvSecrets } from '../lib/secrets';
import { notifyRelaysIfNeeded } from '../lib/relay';
import type { Env } from '../env';
import type { SSRManifest } from 'astro';
import type {
  ExecutionContext,
  Request as WorkersRequest,
  Response as WorkersResponse,
} from '@cloudflare/workers-types';

export type PdsFetchHandler = (
  request: WorkersRequest,
  env: Env,
  ctx: ExecutionContext
) => Promise<WorkersResponse>;

export interface CreatePdsFetchHandlerOptions {
  /**
   * Optionally pass the host project's manifest when composing the worker manually.
   * When omitted, the integration will load the manifest lazily from the build output.
   */
  manifest?: SSRManifest;
}

/**
 * Returns the Alteran PDS Worker fetch handler so downstream apps can
 * compose it inside their own Cloudflare Worker entrypoint.
 */
export function createPdsFetchHandler(options?: CreatePdsFetchHandlerOptions): PdsFetchHandler {
  return async function fetch(request: WorkersRequest, env: Env, ctx: ExecutionContext) {
    // Resolve any Secret Store bindings to strings so downstream code can
    // treat secrets uniformly regardless of source (Secret or Secret Store).
    const resolvedEnv = await resolveEnvSecrets(env);

    // Cloudflare's Astro adapter expects an ASSETS binding for serving static
    // fallback content. Our worker doesn't ship static assets in production,
    // so provide a no-op stub to prevent adapter crashes (error code 1101).
    if (!resolvedEnv.ASSETS || typeof (resolvedEnv as any).ASSETS.fetch !== 'function') {
      (resolvedEnv as any).ASSETS = {
        async fetch() {
          return new Response('Not Found', {
            status: 404,
            headers: { 'Cache-Control': 'public, max-age=60' },
          });
        },
      };
    }

    try {
      validateConfigOrThrow(resolvedEnv);
    } catch (error) {
      return new Response(
        JSON.stringify({
          error: 'ConfigurationError',
          message: error instanceof Error ? error.message : 'Invalid configuration',
        }),
        {
          status: 500,
          headers: { 'Content-Type': 'application/json' },
        }
      ) as unknown as WorkersResponse;
    }

    // Short-circuit CORS preflight at the worker entrypoint to avoid
    // adapter/method routing mismatches causing 500s on OPTIONS.
    if (request.method === 'OPTIONS') {
      const headers = new Headers({
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': '*',
        'Access-Control-Allow-Headers': '*',
        'Access-Control-Max-Age': '86400',
      });
      return new Response(null, { status: 204, headers }) as unknown as WorkersResponse;
    }

    await seed(resolvedEnv.DB, (resolvedEnv.PDS_DID as string | undefined) ?? 'did:example:single-user');

    // Fire-and-forget: let relays know this PDS exists and is reachable.
    // Throttled per isolate and safe to call frequently.
    try {
      ctx.waitUntil(notifyRelaysIfNeeded(resolvedEnv as any, request.url));
    } catch (err) {
      // Never block on relay notification
    }

    const url = new URL(request.url);
    if (url.pathname === '/xrpc/com.atproto.sync.subscribeRepos') {
      const upgrade = request.headers.get('upgrade');
      if (upgrade !== 'websocket') {
        return new Response('Expected websocket', { status: 426 }) as unknown as WorkersResponse;
      }
      if (!resolvedEnv.SEQUENCER) {
        return new Response('Sequencer not configured', { status: 503 }) as unknown as WorkersResponse;
      }

      const id = resolvedEnv.SEQUENCER.idFromName('default');
      const stub = resolvedEnv.SEQUENCER.get(id);
      return (await stub.fetch(request as any)) as unknown as WorkersResponse;
    }

    const astroFetch = await getAstroFetch(options);
    const response = await astroFetch(request, resolvedEnv as any, ctx);
    return response as unknown as WorkersResponse;
  };
}

type AstroFetchHandler = (
  request: WorkersRequest,
  env: Env,
  ctx: ExecutionContext
) => Promise<WorkersResponse>;

let cachedFetchPromise: Promise<AstroFetchHandler> | undefined;

async function loadAstroFetchFromManifest(manifest: SSRManifest): Promise<AstroFetchHandler> {
  const { createExports } = await import('@astrojs/cloudflare/entrypoints/server.js');
  const exports = createExports(manifest);
  return exports.default.fetch as unknown as AstroFetchHandler;
}

async function getAstroFetch(options?: CreatePdsFetchHandlerOptions): Promise<AstroFetchHandler> {
  if (options?.manifest) {
    return loadAstroFetchFromManifest(options.manifest);
  }

  if (!cachedFetchPromise) {
    cachedFetchPromise = (async () => {
      const { manifest } = await import('@astrojs-manifest');
      return loadAstroFetchFromManifest(manifest as SSRManifest);
    })();
  }

  return cachedFetchPromise;
}

export { onRequest } from '../middleware';
export { seed };
export { validateConfigOrThrow };
