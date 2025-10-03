// Types via tsconfig.app.json
import type { R2ObjectBody } from '@cloudflare/workers-types';
import type { Env } from '../env';

export type PutOptions = {
  contentType?: string;
  maxBytes?: number; // default from env or 5 MiB
};

export type PutResult = {
  key: string;
  size: number;
  sha256: string; // base64url
};

export class R2BlobStore {
  constructor(private env: Env) {}

  private maxBytes(defaultMax = 5 * 1024 * 1024): number {
    const raw = (this.env as any).PDS_MAX_BLOB_SIZE as string | undefined;
    const n = raw ? Number(raw) : defaultMax;
    return Number.isFinite(n) && n > 0 ? n : defaultMax;
  }

  private static b64url(bytes: ArrayBuffer): string {
    const b = new Uint8Array(bytes);
    let s = '';
    for (const v of b) s += String.fromCharCode(v);
    return btoa(s).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
  }

  private static hex(bytes: Uint8Array): string {
    return Array.from(bytes).map((v) => v.toString(16).padStart(2, '0')).join('');
  }

  private static cidKey(shaB64url: string, prefix = 'blobs/by-cid/'): string {
    return `${prefix}${shaB64url}`;
  }

  async put(body: ArrayBuffer, opts: PutOptions = {}): Promise<PutResult> {
    const size = body.byteLength;
    const limit = opts.maxBytes ?? this.maxBytes();
    if (size > limit) throw new Error(`BlobTooLarge:${size}>${limit}`);

    const contentType = opts.contentType ?? 'application/octet-stream';
    const sha = await crypto.subtle.digest('SHA-256', body);
    const shaB64 = R2BlobStore.b64url(sha);
    const key = R2BlobStore.cidKey(shaB64);
    await this.env.BLOBS.put(key, body, { httpMetadata: { contentType } });
    return { key, size, sha256: shaB64 };
  }

  async get(key: string): Promise<R2ObjectBody | null> {
    return this.env.BLOBS.get(key);
  }

  async delete(key: string): Promise<void> {
    await this.env.BLOBS.delete(key);
  }
}
