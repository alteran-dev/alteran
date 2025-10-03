import { describe, it, expect, beforeAll } from 'bun:test';
import { createApp } from '../src/app';
import { makeEnv, ctx } from './helpers/env';
import { Hono } from 'hono';
import { AtpAgent } from '@atproto/api';

const app = createApp();

function makeFetch(env: Awaited<ReturnType<typeof makeEnv>>) {
  return async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = typeof input === 'string' ? new URL(input, 'http://localhost') : (input instanceof URL ? input : new URL(input.url));
    const req = input instanceof Request ? input : new Request(url.toString(), init);
    return app.fetch(req, env as any, ctx);
  };
}

describe('AtpAgent integration', () => {
  let env: Awaited<ReturnType<typeof makeEnv>>;
  let fetchImpl: ReturnType<typeof makeFetch>;

  beforeAll(async () => {
    env = await makeEnv();
    fetchImpl = makeFetch(env);
    // Bootstrap DB
    await app.fetch(new Request('http://localhost/debug/db/bootstrap', { method: 'POST' }), env, ctx);
  });

  it('login and create/get record via AtpAgent', async () => {
    const agent = new AtpAgent({ service: 'http://localhost', fetch: fetchImpl as any });
    // login
    await agent.login({ identifier: 'user', password: 'pwd' });
    expect(agent.session?.accessJwt).toBeDefined();
    const did = env.PDS_DID!;
    // create record
    const createRes = await agent.com.atproto.repo.createRecord({
      repo: did,
      collection: 'app.bsky.feed.post',
      record: { text: 'from agent' },
    });
    expect(createRes.success).toBe(true);
    const uri = (createRes.data as any).uri as string;
    expect(uri.startsWith(`at://${did}/app.bsky.feed.post/`)).toBe(true);
    // get record
    const getRes = await agent.com.atproto.repo.getRecord({ repo: did, collection: 'app.bsky.feed.post', rkey: uri.split('/').pop()! });
    expect(getRes.success).toBe(true);
  });

  it('subscribeRepos supports cursor replay', async () => {
    // Build a local URL using the test app
    const base = 'http://localhost';
    // connect WS without cursor
    const url = base.replace('http', 'ws') + '/xrpc/com.atproto.sync.subscribeRepos';
    const ws1 = new WebSocket(url);
    const events1: any[] = [];
    ws1.addEventListener('message', (e) => { try { events1.push(JSON.parse(String((e as MessageEvent).data))); } catch {} });
    await new Promise((r) => ws1.addEventListener('open', () => r(undefined)));
    // produce a couple commits via writes
    const sess = (await fetch(base + '/xrpc/com.atproto.server.createSession', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ identifier: 'ws', password: 'changeme' }),
    }).then((r) => r.json())) as { accessJwt?: string };
    if (typeof sess.accessJwt !== 'string') throw new Error('session response missing accessJwt');
    const auth = { authorization: `Bearer ${sess.accessJwt}` };
    for (let i = 0; i < 2; i++) {
      await fetch(base + '/xrpc/com.atproto.repo.createRecord', { method: 'POST', headers: { 'content-type': 'application/json', ...auth }, body: JSON.stringify({ collection: 'app.bsky.feed.post', record: { text: `ws-${i}` } }) });
    }
    await new Promise((r) => setTimeout(r, 200));
    ws1.close();

    // Find last seq from events1
    const commits = events1.filter((e) => e.type === 'commit');
    const last = commits[commits.length - 1];
    const cursor = last?.seq ?? 0;

    // connect with cursor to replay future ones
    const ws2 = new WebSocket(url + `?cursor=${cursor}`);
    const events2: any[] = [];
    ws2.addEventListener('message', (e) => { try { events2.push(JSON.parse(String((e as MessageEvent).data))); } catch {} });
    await new Promise((r) => ws2.addEventListener('open', () => r(undefined)));
    // create more commits
    for (let i = 0; i < 2; i++) {
      await fetch(base + '/xrpc/com.atproto.repo.createRecord', { method: 'POST', headers: { 'content-type': 'application/json', ...auth }, body: JSON.stringify({ collection: 'app.bsky.feed.post', record: { text: `ws2-${i}` } }) });
    }
    await new Promise((r) => setTimeout(r, 200));
    ws2.close();
    const commits2 = events2.filter((e) => e.type === 'commit');
    expect(commits2.length).toBeGreaterThan(0);
    // ensure seqs are strictly greater than cursor
    expect(Math.min(...commits2.map((c) => c.seq))).toBeGreaterThan(cursor);
  });
});
