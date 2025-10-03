import type { APIContext } from 'astro';
import { CID } from 'multiformats/cid';
import * as dagCbor from '@ipld/dag-cbor';
import { sha256 } from 'multiformats/hashes/sha2';

export function tryParse(json: string): unknown {
  try {
    return JSON.parse(json);
  } catch {
    return json;
  }
}

// JSON helper with size cap
export async function readJson(request: Request): Promise<any> {
  const max = 64 * 1024;
  const text = await request.text();
  if (text.length > max) throw new Error('PayloadTooLarge');
  return JSON.parse(text || '{}');
}

export async function readJsonBounded(env: any, request: Request): Promise<any> {
  const raw = (env.PDS_MAX_JSON_BYTES as string | undefined) ?? '65536';
  const max = Number(raw) > 0 ? Number(raw) : 65536;
  const text = await request.text();
  if (text.length > max) {
    const err: any = new Error('PayloadTooLarge');
    err.code = 'PayloadTooLarge';
    throw err;
  }
  return JSON.parse(text || '{}');
}

export function bearerToken(request: Request): string | null {
  const auth = request.headers.get('authorization');
  if (!auth || !auth.startsWith('Bearer ')) return null;
  return auth.slice(7);
}

export function isAllowedMime(env: any, mime: string): boolean {
  const def = ['image/jpeg', 'image/png', 'image/gif', 'image/webp', 'image/avif'];
  const raw = (env.PDS_ALLOWED_MIME as string | undefined) ?? def.join(',');
  const set = new Set(raw.split(',').map((s) => s.trim()).filter(Boolean));
  return set.has(mime.toLowerCase());
}

export function randomRkey(): string {
  return crypto.randomUUID().replace(/-/g, '').substring(0, 13);
}

export async function cidFromJson(json: any): Promise<CID> {
  const bytes = dagCbor.encode(json);
  const hash = await sha256.digest(bytes);
  return CID.create(1, dagCbor.code, hash);
}
