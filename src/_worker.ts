import { handle } from 'astro/internal/handler';
import { onRequest } from './middleware';
import { seed } from './db/seed';
import { validateConfigOrThrow } from './lib/config';
import type { Env } from './env';

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext) {
    // Validate configuration on startup (fail fast if invalid)
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
      );
    }

    await seed(env.DB, env.PDS_DID ?? 'did:example:single-user');

    const url = new URL(request.url);
    if (url.pathname === '/xrpc/com.atproto.sync.subscribeRepos') {
      const upgrade = request.headers.get('upgrade');
      if (upgrade !== 'websocket') return new Response('Expected websocket', { status: 426 });
      if (!env.SEQUENCER) return new Response('Sequencer not configured', { status: 503 });

      const id = env.SEQUENCER.idFromName('default');
      const stub = env.SEQUENCER.get(id);
      return stub.fetch(request as any);
    }

    const locals: any = { runtime: { env, ctx, request } };
    return await onRequest(locals as any, async () => await handle(locals as any));
  },
};

// Export Durable Object(s)
export { Sequencer } from './worker/sequencer';
