import type { APIContext } from 'astro';
import type { Env } from '../env';
import { verifyJwt, type JwtClaims } from './jwt';

export interface AuthContext {
  token: string;
  claims: JwtClaims;
}

export async function isAuthorized(request: Request, env: Env): Promise<boolean> {
  const auth = request.headers.get('authorization');

  console.error('=== AUTH DEBUG START ===');
  console.error('URL:', request.url);
  console.error('Has Auth Header:', !!auth);
  console.error('Auth Prefix:', auth?.substring(0, 30));
  console.error('=== AUTH DEBUG END ===');

  if (!auth || !auth.startsWith('Bearer ')) {
    console.error('RESULT: No Bearer token found');
    return false;
  }

  const token = auth.slice(7);
  console.error('Token Length:', token.length);
  console.error('Token Prefix:', token.substring(0, 30));

  // Prefer JWT
  const ver = await verifyJwt(env, token).catch((err) => {
    console.error('JWT VERIFICATION ERROR:', err instanceof Error ? err.message : String(err));
    return null;
  });

  console.error('JWT Valid:', ver?.valid);
  console.error('JWT Type:', ver?.payload?.t);
  console.error('JWT Sub:', ver?.payload?.sub);

  if (ver && ver.valid && ver.payload.t === 'access') {
    console.error('RESULT: JWT Success');
    return true;
  }

  // Back-compat local escape hatch if explicitly enabled
  const allowDev = (env as any).PDS_ALLOW_DEV_TOKEN === '1';
  console.error('Allow Dev Token:', allowDev);

  if (allowDev && token === 'dev-access-token') {
    console.error('RESULT: Dev token accepted');
    return true;
  }
  if (allowDev && env.USER_PASSWORD && token === env.USER_PASSWORD) {
    console.error('RESULT: User password accepted');
    return true;
  }

  console.error('RESULT: Unauthorized');
  return false;
}

export function unauthorized() {
  return new Response(JSON.stringify({ error: 'AuthRequired' }), { status: 401 });
}

export async function authenticateRequest(request: Request, env: Env): Promise<AuthContext | null> {
  const auth = request.headers.get('authorization');
  if (!auth || !auth.startsWith('Bearer ')) return null;
  const token = auth.slice(7);
  const ver = await verifyJwt(env, token).catch((err) => {
    console.error('JWT verification error:', err);
    return null;
  });
  if (!ver || !ver.valid) return null;
  const claims = ver.payload as JwtClaims;
  if (claims.t !== 'access') return null;
  return { token, claims };
}
