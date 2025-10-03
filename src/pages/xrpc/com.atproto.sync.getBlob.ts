import type { APIContext } from 'astro';
import { getDb } from '../../db/client';
import { blob_ref } from '../../db/schema';
import { eq } from 'drizzle-orm';

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
    const cid = url.searchParams.get('cid');
    if (!cid) {
      return new Response(
        JSON.stringify({
          error: 'InvalidRequest',
          message: 'cid parameter is required'
        }),
        { status: 400, headers: { 'Content-Type': 'application/json' } }
      );
    }

    const db = getDb(env);

    // Look up blob metadata by CID
    const blobMeta = await db
      .select()
      .from(blob_ref)
      .where(eq(blob_ref.cid, cid))
      .get();

    if (!blobMeta) {
      return new Response(
        JSON.stringify({
          error: 'BlobNotFound',
          message: 'Blob not found'
        }),
        { status: 404, headers: { 'Content-Type': 'application/json' } }
      );
    }

    // Fetch blob from R2
    const r2 = env.BLOBS;
    const object = await r2.get(blobMeta.key);

    if (!object) {
      return new Response(
        JSON.stringify({
          error: 'BlobNotFound',
          message: 'Blob not found in storage'
        }),
        { status: 404, headers: { 'Content-Type': 'application/json' } }
      );
    }

    // Stream the blob with appropriate content type
    return new Response(object.body as any, {
      status: 200,
      headers: {
        'Content-Type': blobMeta.mime,
        'Content-Length': blobMeta.size.toString(),
        'Cache-Control': 'public, max-age=31536000, immutable',
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