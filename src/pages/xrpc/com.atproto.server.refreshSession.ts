import type { APIContext } from 'astro';
import { signJwt, verifyJwt } from '../../lib/jwt';
import { bearerToken } from '../../lib/util';
import { lazyCleanupExpiredTokens } from '../../lib/token-cleanup';
import { drizzle } from 'drizzle-orm/d1';
import { token_revocation } from '../../db/schema';
import { eq } from 'drizzle-orm';

export const prerender = false;

export async function POST({ locals, request }: APIContext) {
  const { env } = locals.runtime;
  const token = bearerToken(request);
  if (!token) {
    return new Response(
      JSON.stringify({ error: 'AuthRequired', message: 'No authorization token provided' }),
      { status: 401, headers: { 'Content-Type': 'application/json' } }
    );
  }

  const ver = await verifyJwt(env, token).catch(() => null);
  if (!ver || ver.payload.t !== 'refresh') {
    return new Response(
      JSON.stringify({ error: 'InvalidToken', message: 'Invalid or expired refresh token' }),
      { status: 401, headers: { 'Content-Type': 'application/json' } }
    );
  }

  // Reject if JTI is revoked (single-use refresh tokens)
  const jtiOld = String(ver.payload.jti || '');
  if (jtiOld) {
    const db = drizzle(env.DB);
    const revoked = await db.select().from(token_revocation).where(eq(token_revocation.jti, jtiOld)).get();
    if (revoked) {
      return new Response(
        JSON.stringify({ error: 'InvalidToken', message: 'Refresh token has already been used' }),
        { status: 401, headers: { 'Content-Type': 'application/json' } }
      );
    }
  }

  const did = String(ver.payload.sub || (env.PDS_DID ?? 'did:example:single-user'));
  const handle = String(ver.payload.handle || env.PDS_HANDLE || 'user.example');

  // Rotate: generate new token pair with new JTI
  const jtiNew = crypto.randomUUID();
  const accessJwt = await signJwt(env, { sub: did, handle, t: 'access' }, 'access');
  const refreshJwt = await signJwt(env, { sub: did, handle, t: 'refresh', jti: jtiNew }, 'refresh');

  // Revoke old refresh token by inserting into revocation table
  if (jtiOld && ver.payload.exp) {
    const db = drizzle(env.DB);
    const now = Math.floor(Date.now() / 1000);
    await db.insert(token_revocation).values({
      jti: jtiOld,
      exp: Number(ver.payload.exp),
      revoked_at: now,
    }).run();
  }

  // Lazy cleanup of expired tokens (runs 1% of the time)
  lazyCleanupExpiredTokens(env).catch(console.error);

  return new Response(JSON.stringify({ did, handle, accessJwt, refreshJwt }), {
    headers: { 'Content-Type': 'application/json' },
  });
}
