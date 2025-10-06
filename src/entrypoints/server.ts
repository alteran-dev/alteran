import type { SSRManifest } from 'astro';
import { App } from 'astro/app';
import { handle } from '@astrojs/cloudflare/handler';
import { Sequencer } from '../worker/sequencer';

export function createExports(manifest: SSRManifest) {
  const app = new App(manifest);
  const fetch = async (request: Request, env: unknown, context: unknown) => {
    // Ensure ASSETS binding exists to satisfy @astrojs/cloudflare handler
    // even when the worker has no static asset binding configured.
    const e = env as any;
    if (!e?.ASSETS || typeof e.ASSETS.fetch !== 'function') {
      e.ASSETS = {
        async fetch() {
          return new Response('Not Found', {
            status: 404,
            headers: { 'Cache-Control': 'public, max-age=60' },
          });
        },
      };
    }

    // Delegate to the Cloudflare adapter handler while preserving Alteran additions.
    return await handle(manifest, app, request, e, context as any);
  };

  return {
    default: { fetch },
    Sequencer,
  };
}

export { Sequencer };
