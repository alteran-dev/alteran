import type { APIContext } from 'astro';

export async function GET(ctx: APIContext) {
  try {
    const db = (ctx.locals as any).runtime?.env?.DB ?? (ctx.locals as any).DB ?? (globalThis as any).DB;
    if (db) {
      await db.prepare('select 1').first();
    }
    return new Response('ok', { status: 200 });
  } catch {
    return new Response('db not ready', { status: 503 });
  }
}

