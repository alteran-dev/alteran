import type { APIContext } from 'astro';
import type { Env } from '../env';
import { verifyJwt, type JwtClaims } from './jwt';

export interface AuthContext {
  token: string;
  claims: JwtClaims;
}

export async function isAuthorized(request: Request, env: Env): Promise<boolean> {
  const auth = request.headers.get('authorization');
  if (!auth || !auth.startsWith('Bearer ')) return false;
  const token = auth.slice(7);
  // Prefer JWT
  const ver = await verifyJwt(env, token).catch((err) => {
    console.error('JWT verification error:', err);
    return null;
  });
  if (ver && ver.valid && ver.payload.t === 'access') return true;
  // Back-compat local escape hatch if explicitly enabled
  const allowDev = (env as any).PDS_ALLOW_DEV_TOKEN === '1';
  if (allowDev && token === 'dev-access-token') return true;
  if (allowDev && env.USER_PASSWORD && token === env.USER_PASSWORD) return true;
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
