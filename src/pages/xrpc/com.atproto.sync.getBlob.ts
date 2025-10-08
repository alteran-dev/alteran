import type { APIContext } from 'astro';
import { getDb } from '../../db/client';
import { blob_ref } from '../../db/schema';
import { eq } from 'drizzle-orm';
import { CID } from 'multiformats/cid';
import { sha256 } from 'multiformats/hashes/sha2';
import { putBlobRef } from '../../db/dal';
import { isAccountActive } from '../../db/dal';

export const prerender = false;

/**
 * com.atproto.sync.getBlob
 *
 * Serves a blob by its CID. Used during migration to transfer blobs
 * from the old PDS to the new PDS.
 *
 * Query params:
 * - did: The DID of the account (optional, defaults to configured PDS_DID)
 * - cid: The CID of the blob to retrieve (required)
 */
export async function GET({ locals, url }: APIContext) {
  const { env } = locals.runtime;

  try {
    const did = url.searchParams.get('did') ?? (env.PDS_DID as string);
    const cid = url.searchParams.get('cid');
    if (!did || !cid) {
      return new Response(
        JSON.stringify({
          error: 'InvalidRequest',
          message: 'did and cid parameters are required'
        }),
        { status: 400, headers: { 'Content-Type': 'application/json' } }
      );
    }

    // Gate by account active state
    const active = await isAccountActive(env as any, did);
    if (!active) {
      return new Response(
        JSON.stringify({ error: 'AccountInactive', message: 'Account is not active' }),
        { status: 403, headers: { 'Content-Type': 'application/json' } }
      );
    }

    const db = getDb(env);

    // Look up blob metadata by CID
    let blobMeta = await db
      .select()
      .from(blob_ref)
      .where(eq(blob_ref.cid, cid))
      .get();

    let key: string | null = blobMeta?.key ?? null;
    let mime: string = blobMeta?.mime ?? 'application/octet-stream';
    let size: number | null = blobMeta?.size ?? null;

    // Fallback for older uploads: derive R2 key from CID (raw/sha256) if DB row missing
    if (!key) {
      try {
        const link = CID.parse(cid);
        // blob CIDs are raw (0x55) with sha256 multihash
        if (link.multihash.code !== sha256.code) {
          return new Response(
            JSON.stringify({ error: 'InvalidRequest', message: 'Unsupported multihash' }),
            { status: 400, headers: { 'Content-Type': 'application/json' } }
          );
        }
        // Recreate legacy R2 key scheme used by store.put()
        const digest = link.multihash.digest; // Uint8Array
        // base64url encode
        let s = '';
        for (const b of digest) s += String.fromCharCode(b);
        const b64url = btoa(s).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
        key = `blobs/by-cid/${b64url}`;
      } catch {
        key = null;
      }
    }

    if (!key) {
      return new Response(
        JSON.stringify({ error: 'InvalidRequest', message: 'Blob not found' }),
        { status: 400, headers: { 'Content-Type': 'application/json' } }
      );
    }

    // Fetch blob from R2
    const r2 = env.BLOBS;
    const object = await r2.get(key);

    if (!object) {
      return new Response(
        JSON.stringify({ error: 'InvalidRequest', message: 'Blob not found' }),
        { status: 400, headers: { 'Content-Type': 'application/json' } }
      );
    }

    // If row missing, opportunistically backfill blob_ref
    if (!blobMeta) {
      try {
        size = (object as any).size ?? size ?? 0;
        await putBlobRef(env as any, did, cid, key, mime, Number(size ?? 0));
      } catch {}
    }

    // Stream the blob with appropriate content type
    return new Response(object.body as any, {
      status: 200,
      headers: {
        'Content-Type': mime,
        ...(size != null ? { 'Content-Length': String(size) } : {}),
        'Cache-Control': 'public, max-age=31536000, immutable',
        'x-content-type-options': 'nosniff',
        'content-security-policy': "default-src 'none'; sandbox",
      },
    });
  } catch (error: any) {
    return new Response(
      JSON.stringify({
        error: 'InternalServerError',
        message: error.message || 'Failed to retrieve blob'
      }),
      { status: 500, headers: { 'Content-Type': 'application/json' } }
    );
  }
}
