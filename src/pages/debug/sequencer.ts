import type { APIContext } from 'astro';

export const prerender = false;

export async function GET({ locals }: APIContext) {
  const { env } = locals.runtime;

  if (!env.SEQUENCER) {
    return new Response(JSON.stringify({ error: 'SequencerNotConfigured' }), {
      status: 503,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  try {
    const id = env.SEQUENCER.idFromName('default');
    const stub = env.SEQUENCER.get(id);
    const res = await stub.fetch(new Request('http://internal/metrics') as any);
    const text = await res.text();
    return new Response(text, { status: res.status, headers: { 'Content-Type': 'application/json' } });
  } catch (e: any) {
    return new Response(JSON.stringify({ error: 'InternalError', message: String(e?.message || e) }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }
}
