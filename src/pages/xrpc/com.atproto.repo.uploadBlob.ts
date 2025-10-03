import type { APIContext } from 'astro';
import { isAuthorized, unauthorized } from '../../lib/auth';
import { checkRate } from '../../lib/ratelimit';
import { isAllowedMime } from '../../lib/util';
import { R2BlobStore } from '../../services/r2-blob-store';
import { putBlobRef, checkBlobQuota, updateBlobQuota, isAccountActive } from '../../db/dal';

export const prerender = false;

export async function POST({ locals, request }: APIContext) {
  const { env } = locals.runtime;
  if (!(await isAuthorized(request, env))) return unauthorized();

  // Get DID from environment (single-user PDS)
  const did = env.PDS_DID ?? 'did:example:single-user';

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
  if (!isAllowedMime(env, contentType)) return new Response(JSON.stringify({ error: 'UnsupportedMediaType' }), { status: 415 });

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

    // Register blob ref with CID-based key
    await putBlobRef(env, did, res.sha256, res.key, contentType, res.size);

    // Update quota
    await updateBlobQuota(env, did, res.size, 1);

    return new Response(JSON.stringify({ blob: { ref: { $link: res.key }, mimeType: contentType, size: res.size } }), {
      headers: { 'Content-Type': 'application/json' },
    });
  } catch (e: any) {
    if (String(e.message || '').startsWith('BlobTooLarge')) return new Response(JSON.stringify({ error: 'PayloadTooLarge' }), { status: 413 });
    return new Response(JSON.stringify({ error: 'UploadFailed' }), { status: 500 });
  }
}
