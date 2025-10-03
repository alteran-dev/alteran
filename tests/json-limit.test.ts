import { describe, it, expect } from 'bun:test';
import { makeEnv } from './helpers/env';
import * as Create from '../src/pages/xrpc/com.atproto.repo.createRecord';

describe('JSON size limit enforcement', () => {
  it('rejects oversized JSON bodies with 413', async () => {
    const env = await makeEnv({ PDS_MAX_JSON_BYTES: '128', PDS_ALLOW_DEV_TOKEN: '1', USER_PASSWORD: 'pwd' } as any);

    const bigText = 'x'.repeat(1024);
    const body = JSON.stringify({ collection: 'app.bsky.feed.post', record: { text: bigText } });
    const req = new Request('http://localhost/xrpc/com.atproto.repo.createRecord', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer pwd' },
      body,
    });
    const res = await (Create as any).POST({ locals: { runtime: { env } }, request: req });
    expect(res.status).toBe(413);
  });
});

