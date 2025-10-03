import { Miniflare } from 'miniflare';
import type { Env } from '../../src/env';

export async function makeEnv(overrides: Partial<Env> = {}): Promise<Env> {
  const mf = new Miniflare({
    d1Databases: { DB: ':memory:' },
    r2Buckets: ['BLOBS'],
    compatibilityDate: '2025-10-02',
    script: "export default { fetch: () => new Response('ok') }",
    modules: true,
    bindings: {
      PDS_DID: 'did:example:test',
      PDS_HANDLE: 'test.example',
      USER_PASSWORD: 'pwd',
      ACCESS_TOKEN_SECRET: 'access-secret',
      REFRESH_TOKEN_SECRET: 'refresh-secret',
      PDS_MAX_BLOB_SIZE: '5242880',
      PDS_ALLOWED_MIME: 'image/png,image/jpeg',
    },
  });
  const DB = await mf.getD1Database('DB');
  const BLOBS = await mf.getR2Bucket('BLOBS');
  return { DB, BLOBS, PDS_DID: 'did:example:test', PDS_HANDLE: 'test.example', USER_PASSWORD: 'pwd', ...overrides } as Env;
}

export const ctx = {
  waitUntil: (_p: Promise<any>) => {},
  passThroughOnException: () => {},
} as unknown as ExecutionContext;
