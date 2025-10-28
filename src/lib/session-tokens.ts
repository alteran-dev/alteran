import { bytesToHex, randomBytes } from '@noble/hashes/utils.js';
import type { Env } from '../env';
import { getRuntimeString } from './secrets';
import { getOrCreateSecret } from '../db/account';
import { SignJWT, jwtVerify, type JWTPayload } from 'jose';

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
  const did = await getRuntimeString(env, 'PDS_DID', '');
  if (!did) throw new Error('PDS_DID is not configured');
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
  // jose will set standard claims via dedicated methods; we also keep custom claims in payload
  const signer = new SignJWT(payload as JWTPayload)
    .setProtectedHeader({ alg: 'HS256', typ })
    .setSubject(payload.sub)
    .setAudience(payload.aud)
    .setIssuedAt(payload.iat)
    .setExpirationTime(payload.exp);
  return await signer.sign(key);
}

async function decodeAndVerifyJwt(key: Uint8Array, token: string, expectedTyp: TokenHeader['typ'], audience: string) {
  const { payload, protectedHeader } = await jwtVerify(token, key, {
    algorithms: ['HS256'],
    audience,
  });
  if (protectedHeader.typ !== expectedTyp) {
    throw new Error('Unexpected token header');
  }
  // jose already validates exp/nbf/iat format and audience, but we keep minimal sanity checks
  if (!payload.sub || typeof payload.sub !== 'string') {
    throw new Error('Token missing subject');
  }
  if (typeof payload.exp !== 'number') {
    throw new Error('Token missing expiry');
  }
  return { header: protectedHeader as TokenHeader, payload: payload as unknown as TokenPayload };
}

function generateTokenId(): string {
  return bytesToHex(randomBytes(16));
}
// removed custom HMAC/base64url helpers in favor of jose
