import { handle } from 'astro/internal/handler';
import { onRequest } from '../middleware';
import { seed } from '../db/seed';
import { validateConfigOrThrow } from '../lib/config';
import type { Env } from '../env';
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

/**
 * Returns the Alteran PDS Worker fetch handler so downstream apps can
 * compose it inside their own Cloudflare Worker entrypoint.
 */
export function createPdsFetchHandler(): PdsFetchHandler {
  return async function fetch(request: WorkersRequest, env: Env, ctx: ExecutionContext) {
    try {
      validateConfigOrThrow(env);
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

    await seed(env.DB, env.PDS_DID ?? 'did:example:single-user');

    const url = new URL(request.url);
    if (url.pathname === '/xrpc/com.atproto.sync.subscribeRepos') {
      const upgrade = request.headers.get('upgrade');
      if (upgrade !== 'websocket') {
        return new Response('Expected websocket', { status: 426 }) as unknown as WorkersResponse;
      }
      if (!env.SEQUENCER) {
        return new Response('Sequencer not configured', { status: 503 }) as unknown as WorkersResponse;
      }

      const id = env.SEQUENCER.idFromName('default');
      const stub = env.SEQUENCER.get(id);
      return (await stub.fetch(request as any)) as unknown as WorkersResponse;
    }

    const locals: any = { runtime: { env, ctx, request } };
    return (await onRequest(locals as any, async () => await handle(locals as any))) as unknown as WorkersResponse;
  };
}

export { onRequest };
export { seed };
export { validateConfigOrThrow };
