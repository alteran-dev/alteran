import type { Env } from '../env';

export async function notifySequencer(env: Env, obj: unknown) {
  if (!env.SEQUENCER) return;
  try {
    const id = env.SEQUENCER.idFromName('default');
    const stub = env.SEQUENCER.get(id);
    await stub.fetch('https://sequencer/commit', { method: 'POST', body: JSON.stringify(obj) });
  } catch {}
}
