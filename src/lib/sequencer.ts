import type { Env } from '../env';

export async function notifySequencer(env: Env, obj: unknown) {
  if (!env.SEQUENCER) {
    console.warn('notifySequencer: SEQUENCER binding missing');
    return;
  }
  try {
    const id = env.SEQUENCER.idFromName('default');
    const stub = env.SEQUENCER.get(id);
    await stub.fetch('https://sequencer/commit', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(obj),
    });
  } catch (e) {
    console.warn('notifySequencer: failed to POST /commit to sequencer', e);
  }
}
