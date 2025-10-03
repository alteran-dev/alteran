import type { APIContext } from 'astro';
import { verifyJwt } from './jwt';

export async function isAuthorized(request: Request, env: any): Promise<boolean> {
  const auth = request.headers.get('authorization');
  if (!auth || !auth.startsWith('Bearer ')) return false;
  const token = auth.slice(7);
  // Prefer JWT
  const ver = await verifyJwt(env, token).catch(() => null);
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
