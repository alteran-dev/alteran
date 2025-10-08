import type { APIContext } from 'astro';
import { isAuthorized, unauthorized } from '../../lib/auth';
import { checkRate } from '../../lib/ratelimit';
import { isAllowedMime } from '../../lib/util';
import { R2BlobStore } from '../../services/r2-blob-store';
import { putBlobRef, checkBlobQuota, updateBlobQuota, isAccountActive } from '../../db/dal';
import { resolveSecret } from '../../lib/secrets';
import { CID } from 'multiformats/cid';
import { sha256 } from 'multiformats/hashes/sha2';

export const prerender = false;

export async function POST({ locals, request }: APIContext) {
  const { env } = locals.runtime;
  if (!(await isAuthorized(request, env))) return unauthorized();

  // Get DID from environment (single-user PDS)
  const did = (await resolveSecret(env.PDS_DID)) ?? 'did:example:single-user';

  // Check if account is active
  const active = await isAccountActive(env, did);
  if (!active) {
    return new Response(
      JSON.stringify({
        error: 'AccountDeactivated',
        message: 'Account is deactivated. Activate it before uploading blobs.'
      }),
      { status: 403, headers: { 'Content-Type': 'application/json' } }
    );
  }

  const rateLimitResponse = await checkRate(env, request, 'blob');
  if (rateLimitResponse) return rateLimitResponse;

  const buf = await request.arrayBuffer();
  const contentType = request.headers.get('content-type') ?? 'application/octet-stream';

  // Skip MIME type validation during migration - accept all types
  // Uncomment the line below to re-enable MIME type restrictions after migration
  // if (!isAllowedMime(env, contentType)) return new Response(JSON.stringify({ error: 'UnsupportedMediaType' }), { status: 415 });

  // Check quota before upload
  const canUpload = await checkBlobQuota(env, did, buf.byteLength);
  if (!canUpload) {
    return new Response(
      JSON.stringify({
        error: 'BlobQuotaExceeded',
        message: 'Blob storage quota exceeded'
      }),
      { status: 413 }
    );
  }

  const store = new R2BlobStore(env);
  try {
    const res = await store.put(buf, { contentType });

    // Compute a CIDv1 (raw) for the blob so clients receive a valid CID link
    const digest = await sha256.digest(new Uint8Array(buf));
    const cid = CID.createV1(0x55, digest); // 0x55 = raw codec
    const cidStr = cid.toString();

    // Register blob ref with CID-based key
    await putBlobRef(env, did, cidStr, res.key, contentType, res.size);

    // Update quota
    await updateBlobQuota(env, did, res.size, 1);

    return new Response(JSON.stringify({ blob: { ref: { $link: cidStr }, mimeType: contentType, size: res.size } }), {
      headers: { 'Content-Type': 'application/json' },
    });
  } catch (e: any) {
    if (String(e.message || '').startsWith('BlobTooLarge')) return new Response(JSON.stringify({ error: 'PayloadTooLarge' }), { status: 413 });
    return new Response(JSON.stringify({ error: 'UploadFailed' }), { status: 500 });
  }
}
