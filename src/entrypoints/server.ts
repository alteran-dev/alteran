import type { SSRManifest } from 'astro';
import { App } from 'astro/app';
import { handle } from '@astrojs/cloudflare/handler';
import { Sequencer } from '../worker/sequencer';

export function createExports(manifest: SSRManifest) {
  const app = new App(manifest);
  const fetch = async (request: Request, env: unknown, context: unknown) => {
    // Delegate to the Cloudflare adapter handler while preserving Alteran additions.
    return await handle(manifest, app, request, env as any, context as any);
  };

  return {
    default: { fetch },
    Sequencer,
  };
}

export { Sequencer };
