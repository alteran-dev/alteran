import { bytesToHex, randomBytes } from '@noble/hashes/utils.js';
import type { Env } from '../env';
import { getRuntimeString } from './secrets';
import { getOrCreateSecret } from '../db/account';

const SESSION_SECRET_KEY = 'session_jwt_secret';
const GRACE_PERIOD_SECONDS = 2 * 60 * 60;
const ACCESS_TTL_SECONDS = 120 * 60; // 120 minutes
const REFRESH_TTL_SECONDS = 90 * 24 * 60 * 60; // 90 days

async function loadSecret(env: Env): Promise<string> {
  const fromEnv = await getRuntimeString(env, 'SESSION_JWT_SECRET' as keyof Env, '');
  if (fromEnv) {
    // Mirror into D1 so Workers without env access can retrieve it
    await getOrCreateSecret(env, SESSION_SECRET_KEY, async () => fromEnv);
    return fromEnv;
  }

  return getOrCreateSecret(env, SESSION_SECRET_KEY, async () => bytesToHex(randomBytes(32)));
}

async function getJwtKey(env: Env): Promise<Uint8Array> {
  const secret = await loadSecret(env);
  return new TextEncoder().encode(secret);
}

async function getServiceDid(env: Env): Promise<string> {
  const did = await getRuntimeString(env, 'PDS_DID', 'did:example:single-user');
  if (!did) {
    throw new Error('PDS_DID is not configured');
  }
  return did;
}

export async function issueSessionTokens(env: Env, did: string, opts: { jti?: string } = {}) {
  const jwtKey = await getJwtKey(env);
  const serviceDid = await getServiceDid(env);
  const now = Math.floor(Date.now() / 1000);

  const accessExp = now + ACCESS_TTL_SECONDS;
  const accessPayload: TokenPayload = {
    scope: 'access',
    aud: serviceDid,
    sub: did,
    iat: now,
    exp: accessExp,
  };
  const accessJwt = await signJwt(jwtKey, 'at+jwt', accessPayload);

  const jti = opts.jti ?? generateTokenId();
  const refreshExp = now + REFRESH_TTL_SECONDS;
  const refreshPayload: RefreshTokenPayload = {
    scope: 'refresh',
    aud: serviceDid,
    sub: did,
    iat: now,
    exp: refreshExp,
    jti,
  };
  const refreshJwt = await signJwt(jwtKey, 'refresh+jwt', refreshPayload);

  return {
    accessJwt,
    refreshJwt,
    refreshPayload,
    refreshExpiry: refreshPayload.exp,
  } as const;
}

export async function verifyRefreshToken(env: Env, token: string) {
  const key = await getJwtKey(env);
  const serviceDid = await getServiceDid(env);
  const { header, payload } = await decodeAndVerifyJwt(key, token, 'refresh+jwt', serviceDid);
  if (header.typ !== 'refresh+jwt') {
    throw new Error('Invalid token type');
  }
  if (payload.scope !== 'refresh') {
    throw new Error('Invalid refresh token scope');
  }
  return {
    payload,
    decoded: {
      scope: payload.scope,
      sub: payload.sub,
      exp: payload.exp,
      jti: payload.jti,
    } as RefreshTokenPayload,
  } as const;
}

export async function verifyAccessToken(env: Env, token: string) {
  const key = await getJwtKey(env);
  const serviceDid = await getServiceDid(env);
  const { header, payload } = await decodeAndVerifyJwt(key, token, 'at+jwt', serviceDid);
  if (header.typ !== 'at+jwt') {
    throw new Error('Invalid token type');
  }
  if (payload.scope === 'refresh') {
    throw new Error('Unexpected scope for access token');
  }
  return payload;
}

export function computeGraceExpiry(previousExpiry: number, nowSeconds: number): number {
  const candidate = nowSeconds + GRACE_PERIOD_SECONDS;
  return Math.min(previousExpiry, candidate);
}

type TokenPayload = {
  scope: string;
  aud: string;
  sub: string;
  iat: number;
  exp: number;
  jti?: string;
  [key: string]: unknown;
};

type RefreshTokenPayload = TokenPayload & { jti: string };

type TokenHeader = { alg: 'HS256'; typ: 'at+jwt' | 'refresh+jwt' };

async function signJwt(key: Uint8Array, typ: TokenHeader['typ'], payload: TokenPayload): Promise<string> {
  const header: TokenHeader = { alg: 'HS256', typ };
  const encodedHeader = base64UrlEncode(JSON.stringify(header));
  const encodedPayload = base64UrlEncode(JSON.stringify(payload));
  const data = `${encodedHeader}.${encodedPayload}`;
  const signature = await hmacSign(key, data);
  return `${data}.${signature}`;
}

async function decodeAndVerifyJwt(key: Uint8Array, token: string, expectedTyp: TokenHeader['typ'], audience: string) {
  const parts = token.split('.');
  if (parts.length !== 3) {
    throw new Error('Invalid token format');
  }
  const header = JSON.parse(base64UrlDecode(parts[0])) as TokenHeader;
  const payload = JSON.parse(base64UrlDecode(parts[1])) as TokenPayload;

  if (header.alg !== 'HS256' || header.typ !== expectedTyp) {
    throw new Error('Unexpected token header');
  }
  if (payload.aud !== audience) {
    throw new Error('Token audience mismatch');
  }
  if (!payload.sub) {
    throw new Error('Token missing subject');
  }
  if (typeof payload.exp !== 'number') {
    throw new Error('Token missing expiry');
  }

  const data = `${parts[0]}.${parts[1]}`;
  const ok = await hmacVerify(key, data, parts[2]);
  if (!ok) {
    throw new Error('Invalid token signature');
  }

  return { header, payload };
}

function generateTokenId(): string {
  const bytes = randomBytes(32);
  return base64UrlEncode(bytes);
}

async function hmacSign(keyBytes: Uint8Array, data: string): Promise<string> {
  const cryptoKey = await crypto.subtle.importKey('raw', keyBytes, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const signature = await crypto.subtle.sign('HMAC', cryptoKey, textEncoder.encode(data));
  return base64UrlEncode(new Uint8Array(signature));
}

async function hmacVerify(keyBytes: Uint8Array, data: string, signatureB64: string): Promise<boolean> {
  const cryptoKey = await crypto.subtle.importKey('raw', keyBytes, { name: 'HMAC', hash: 'SHA-256' }, false, ['verify']);
  return crypto.subtle.verify('HMAC', cryptoKey, base64UrlDecodeToBytes(signatureB64), textEncoder.encode(data));
}

function base64UrlEncode(value: string | Uint8Array): string {
  const bytes = typeof value === 'string' ? textEncoder.encode(value) : value;
  let binary = '';
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function base64UrlDecode(encoded: string): string {
  const pad = encoded.length % 4 === 2 ? '==' : encoded.length % 4 === 3 ? '=' : '';
  const binary = atob(encoded.replace(/-/g, '+').replace(/_/g, '/') + pad);
  return binary;
}

function base64UrlDecodeToBytes(encoded: string): Uint8Array {
  const binary = base64UrlDecode(encoded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

const textEncoder = new TextEncoder();
