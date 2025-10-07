import type { Env } from "../env";
import { getRuntimeString } from "./secrets";
import {
  issueSessionTokens,
  verifyAccessToken,
  verifyRefreshToken,
} from "./session-tokens";

export interface JwtClaims {
  sub: string; // DID
  handle?: string;
  scope?: string;
  aud?: string;
  jti?: string;
  t: "access" | "refresh";
}

// JWT
export async function signJwt(
  env: Env,
  claims: JwtClaims,
  kind: "access" | "refresh",
): Promise<string> {
  if (!claims.sub) {
    throw new Error("Cannot sign JWT without subject");
  }
  const { accessJwt, refreshJwt } = await issueSessionTokens(env, claims.sub, {
    jti: claims.jti,
  });
  return kind === "access" ? accessJwt : refreshJwt;
}

export async function verifyJwt(
  env: Env,
  token: string,
): Promise<{ valid: boolean; payload: JwtClaims } | null> {
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  const header = JSON.parse(
    atob(parts[0].replace(/-/g, "+").replace(/_/g, "/")),
  );

  if (header.typ === "at+jwt") {
    const payload = await verifyAccessToken(env, token).catch(() => null);
    if (!payload) return null;
    if (!payload.sub) return null;
    const claims: JwtClaims = {
      sub: String(payload.sub),
      aud: payload.aud as string | undefined,
      scope: payload.scope as string | undefined,
      jti: payload.jti as string | undefined,
      t: "access",
    };
    if (payload.handle) {
      claims.handle = String(payload.handle);
    }
    return { valid: true, payload: claims };
  }

  if (header.typ === "refresh+jwt") {
    const verified = await verifyRefreshToken(env, token).catch(() => null);
    if (!verified) return null;
    if (!verified.payload.sub) return null;
    const payload: JwtClaims = {
      sub: String(verified.payload.sub),
      aud: verified.payload.aud as string | undefined,
      scope: verified.payload.scope as string | undefined,
      jti: verified.payload.jti as string | undefined,
      t: "refresh",
    };
    return { valid: true, payload };
  }

  const payload = JSON.parse(
    atob(parts[1].replace(/-/g, "+").replace(/_/g, "/")),
  );

  let ok = false;
  if (header.alg === "HS256" && header.typ === "JWT") {
    const secret = await getRuntimeString(
      env,
      payload.t === "refresh" ? "REFRESH_TOKEN_SECRET" : "REFRESH_TOKEN",
      payload.t === "refresh" ? "dev-refresh" : "dev-access",
    );
    if (!secret) return null;
    ok = await hmacJwtVerify(parts[0] + "." + parts[1], parts[2], secret);
  } else {
    return null;
  }

  const now = Math.floor(Date.now() / 1000);
  if (!ok || (payload.exp && now > payload.exp)) return null;
  return { valid: true, payload: payload as JwtClaims };
}

async function hmacJwtSign(payload: any, secret: string): Promise<string> {
  const enc = new TextEncoder();
  const header = { alg: "HS256", typ: "JWT" };
  const h = b64url(enc.encode(JSON.stringify(header)));
  const p = b64url(enc.encode(JSON.stringify(payload)));
  const data = `${h}.${p}`;
  const key = await crypto.subtle.importKey(
    "raw",
    enc.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", key, enc.encode(data));
  const s = b64url(new Uint8Array(sig));
  return `${h}.${p}.${s}`;
}

async function hmacJwtVerify(
  data: string,
  sigB64: string,
  secret: string,
): Promise<boolean> {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    enc.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["verify"],
  );
  const ok = await crypto.subtle.verify(
    "HMAC",
    key,
    b64urlDecode(sigB64),
    enc.encode(data),
  );
  return !!ok;
}


function b64url(bytes: ArrayBuffer | Uint8Array): string {
  const b = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let s = "";
  for (let i = 0; i < b.length; i++) {
    s += String.fromCharCode(b[i]);
  }
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function b64urlDecode(s: string): Uint8Array {
  const pad = s.length % 4 === 2 ? "==" : s.length % 4 === 3 ? "=" : "";
  const bin = atob(s.replace(/-/g, "+").replace(/_/g, "/") + pad);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

// EdDSA (Ed25519) path removed; only HS256 session tokens are supported
