import { getAuthzNonce } from './dpop';

export function isHttpsUrl(u: string): boolean {
  try {
    const url = new URL(u);
    if (url.protocol !== 'https:') return false;
    const host = url.hostname.toLowerCase();
    if (host === 'localhost' || host.endsWith('.local')) return false;
    if (/^(\d+\.){3}\d+$/.test(host)) return false;
    return true;
  } catch {
    return false;
  }
}

export async function fetchClientMetadata(client_id: string): Promise<any> {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), 3000);
  try {
    const res = await fetch(client_id, { signal: ctl.signal });
    if (!res.ok) throw new Error(`client metadata fetch failed: ${res.status}`);
    const ctype = res.headers.get('content-type') || '';
    if (!ctype.includes('application/json') && !ctype.includes('json'))
      throw new Error('client metadata must be JSON');
    return await res.json();
  } finally {
    clearTimeout(t);
  }
}

function b64urlToBytes(s: string): Uint8Array {
  const pad = s.length % 4 === 2 ? '==' : s.length % 4 === 3 ? '=' : '';
  const bin = atob(s.replace(/-/g, '+').replace(/_/g, '/') + pad);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function jwsEs256ToDer(sig: Uint8Array): Uint8Array {
  function trim(bytes: Uint8Array): Uint8Array {
    let i = 0;
    while (i < bytes.length - 1 && bytes[i] === 0) i++;
    let v = bytes.slice(i);
    if (v[0] & 0x80) {
      const out = new Uint8Array(v.length + 1);
      out[0] = 0;
      out.set(v, 1);
      return out;
    }
    return v;
  }
  const r = trim(sig.slice(0, 32));
  const s = trim(sig.slice(32));
  const totalLen = 2 + r.length + 2 + s.length;
  const seqLen = totalLen;
  const der = new Uint8Array(2 + 1 + seqLen);
  let offset = 0;
  der[offset++] = 0x30; // SEQUENCE
  der[offset++] = 0x81; // len marker
  der[offset++] = seqLen;
  der[offset++] = 0x02; // INTEGER
  der[offset++] = r.length;
  der.set(r, offset);
  offset += r.length;
  der[offset++] = 0x02; // INTEGER
  der[offset++] = s.length;
  der.set(s, offset);
  return der;
}

export async function verifyClientAssertion(client_id: string, issuerOrigin: string, assertionJwt: string, jwks: any): Promise<boolean> {
  try {
    const [h, p, s] = assertionJwt.split('.');
    if (!h || !p || !s) return false;
    const header = JSON.parse(new TextDecoder().decode(b64urlToBytes(h)));
    const payload = JSON.parse(new TextDecoder().decode(b64urlToBytes(p)));

    if (header.alg !== 'ES256') return false;
    const keys: any[] = Array.isArray(jwks?.keys) ? jwks.keys : [];
    if (!keys.length) return false;
    const byKid = typeof header.kid === 'string' ? keys.find((k) => k.kid === header.kid) : null;
    const candidates = byKid ? [byKid] : keys;

    const data = new TextEncoder().encode(`${h}.${p}`);
    const sig = b64urlToBytes(s);
    const der = jwsEs256ToDer(sig);

    let ok = false;
    for (const jwk of candidates) {
      try {
        const key = await crypto.subtle.importKey('jwk', jwk as JsonWebKey, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify']);
        const pass = await crypto.subtle.verify('ECDSA', key, der, data);
        if (pass) { ok = true; break; }
      } catch {}
    }
    if (!ok) return false;

    const now = Math.floor(Date.now() / 1000);
    if (payload.iss !== client_id) return false;
    if (payload.sub !== client_id) return false;
    if (payload.aud !== issuerOrigin) return false;
    if (typeof payload.iat !== 'number' || now - payload.iat > 300) return false;
    if (typeof payload.jti !== 'string' || payload.jti.length < 8) return false;
    return true;
  } catch {
    return false;
  }
}

