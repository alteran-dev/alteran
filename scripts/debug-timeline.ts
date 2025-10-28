import { createApp } from '../src/app';
import { makeEnv, ctx } from '../tests/helpers/env';
import { AtpAgent } from '@atproto/api';

async function main() {
  const app = createApp();
  const env: any = await makeEnv();

  // Bootstrap DB tables and defaults
  await app.fetch(
    new Request('http://localhost/debug/db/bootstrap', { method: 'POST' }),
    env,
    ctx,
  );

  // Create a session so we can seed data via auth-required endpoints
  const sessionRes = await app.fetch(
    new Request('http://localhost/xrpc/com.atproto.server.createSession', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ identifier: 'user', password: 'pwd' }),
    }),
    env,
    ctx,
  );
  if (!sessionRes.ok) {
    console.error('createSession failed', sessionRes.status, await sessionRes.text());
    return;
  }
  const session = await sessionRes.json();

  // Create a post so the timeline has content
  const postRes = await app.fetch(
    new Request('http://localhost/xrpc/com.atproto.repo.createRecord', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${session.accessJwt}`,
      },
      body: JSON.stringify({
        collection: 'app.bsky.feed.post',
        record: { text: 'hello world' },
      }),
    }),
    env,
    ctx,
  );
  if (!postRes.ok) {
    console.error('createRecord failed', postRes.status, await postRes.text());
    return;
  }

  // Wire an agent to call the app using the worker fetch implementation
  const workerFetch: typeof fetch = (async (input: RequestInfo, init?: RequestInit) => {
    const url = typeof input === 'string' ? new URL(input, 'http://localhost') : new URL((input as Request).url);
    const request = input instanceof Request ? input : new Request(url.toString(), init);
    return app.fetch(request, env, ctx);
  }) as typeof fetch;

  const agent = new AtpAgent({
    service: 'http://localhost',
    fetch: workerFetch,
  });

  await agent.resumeSession({
    accessJwt: session.accessJwt,
    refreshJwt: session.refreshJwt,
    did: env.PDS_DID,
    handle: env.PDS_HANDLE,
    email: undefined,
    emailConfirmed: true,
    emailAuthFactor: false,
    status: undefined,
    active: true,
  });

  const timeline = await agent.app.bsky.feed.getTimeline({});
  console.log('timeline success', timeline.success);
  if (!timeline.success) {
    console.error('timeline error', timeline);
  } else {
    console.log(JSON.stringify(timeline.data, null, 2));
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
