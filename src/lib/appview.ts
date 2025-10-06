import { Secp256k1Keypair } from '@atproto/crypto';
import type { Env } from '../env';
import { resolveSecret } from './secrets';
import { authenticateRequest, unauthorized } from './auth';

const DEFAULT_APPVIEW_URL = 'https://public.api.bsky.app';
const DEFAULT_APPVIEW_DID = 'did:web:api.bsky.app';

export interface AppViewConfig {
  url: string;
  did: string;
  cdnUrlPattern?: string;
}

let cachedSigningKey: Promise<Secp256k1Keypair> | null = null;

const didDocumentCache = new Map<string, Promise<unknown>>();

function encodeBase64Url(bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function encodeJson(obj: Record<string, unknown>): string {
  const encoder = new TextEncoder();
  return encodeBase64Url(encoder.encode(JSON.stringify(obj)));
}

function randomHex(bytes = 16): string {
  const arr = new Uint8Array(bytes);
  crypto.getRandomValues(arr);
  return Array.from(arr, (b) => b.toString(16).padStart(2, '0')).join('');
}

interface ProxyTarget {
  did: string;
  url: string;
}

type AuthScope =
  | 'com.atproto.access'
  | 'com.atproto.appPass'
  | 'com.atproto.appPassPrivileged'
  | 'com.atproto.signupQueued'
  | 'com.atproto.takendown';

const DEFAULT_ACCESS_SCOPE: AuthScope = 'com.atproto.access';
const TAKENDOWN_SCOPE: AuthScope = 'com.atproto.takendown';
const PRIVILEGED_SCOPES = new Set<AuthScope>([
  'com.atproto.access',
  'com.atproto.appPassPrivileged',
]);

const PRIVILEGED_METHODS = new Set<string>([
  'chat.bsky.actor.deleteAccount',
  'chat.bsky.actor.exportAccountData',
  'chat.bsky.convo.deleteMessageForSelf',
  'chat.bsky.convo.getConvo',
  'chat.bsky.convo.getConvoForMembers',
  'chat.bsky.convo.getLog',
  'chat.bsky.convo.getMessages',
  'chat.bsky.convo.leaveConvo',
  'chat.bsky.convo.listConvos',
  'chat.bsky.convo.muteConvo',
  'chat.bsky.convo.sendMessage',
  'chat.bsky.convo.sendMessageBatch',
  'chat.bsky.convo.unmuteConvo',
  'chat.bsky.convo.updateRead',
  'com.atproto.server.createAccount',
]);

const PROTECTED_METHODS = new Set<string>([
  'com.atproto.admin.sendEmail',
  'com.atproto.identity.requestPlcOperationSignature',
  'com.atproto.identity.signPlcOperation',
  'com.atproto.identity.updateHandle',
  'com.atproto.server.activateAccount',
  'com.atproto.server.confirmEmail',
  'com.atproto.server.createAppPassword',
  'com.atproto.server.deactivateAccount',
  'com.atproto.server.getAccountInviteCodes',
  'com.atproto.server.getSession',
  'com.atproto.server.listAppPasswords',
  'com.atproto.server.requestAccountDelete',
  'com.atproto.server.requestEmailConfirmation',
  'com.atproto.server.requestEmailUpdate',
  'com.atproto.server.revokeAppPassword',
  'com.atproto.server.updateEmail',
]);

class ProxyHeaderError extends Error {}

function resolveAuthScope(scope: unknown): AuthScope {
  if (typeof scope !== 'string') {
    return DEFAULT_ACCESS_SCOPE;
  }

  switch (scope) {
    case 'com.atproto.access':
    case 'com.atproto.appPass':
    case 'com.atproto.appPassPrivileged':
    case 'com.atproto.signupQueued':
    case 'com.atproto.takendown':
      return scope;
    default:
      console.warn('Unknown auth scope, treating as access scope', scope);
      return DEFAULT_ACCESS_SCOPE;
  }
}

function parseProxyHeader(header: string): { did: string; serviceId: string } {
  const value = header.trim();
  const hashIndex = value.indexOf('#');

  if (hashIndex <= 0 || hashIndex === value.length - 1) {
    throw new ProxyHeaderError('invalid format');
  }

  if (value.indexOf('#', hashIndex + 1) !== -1) {
    throw new ProxyHeaderError('invalid format');
  }

  const did = value.slice(0, hashIndex);
  const serviceId = value.slice(hashIndex);

  if (!did.startsWith('did:')) {
    throw new ProxyHeaderError('invalid DID');
  }

  if (!serviceId.startsWith('#')) {
    throw new ProxyHeaderError('invalid service id');
  }

  if (value.includes(' ')) {
    throw new ProxyHeaderError('invalid format');
  }

  return { did, serviceId };
}

async function resolveProxyTarget(
  env: Env,
  proxyHeader: string,
  config: AppViewConfig,
): Promise<ProxyTarget> {
  const { did, serviceId } = parseProxyHeader(proxyHeader);

  if (did === config.did && serviceId === '#bsky_appview') {
    return { did, url: config.url };
  }

  const didDoc = await resolveDidDocument(env, did);
  const endpoint = getServiceEndpointFromDidDoc(didDoc, did, serviceId);

  if (!endpoint) {
    throw new ProxyHeaderError('service id not found in DID document');
  }

  return { did, url: endpoint };
}

async function resolveDidDocument(env: Env, did: string): Promise<any> {
  const existing = didDocumentCache.get(did);
  if (existing) {
    return existing;
  }

  const loader = fetchDidDocument(env, did).catch((error) => {
    didDocumentCache.delete(did);
    throw error;
  });

  didDocumentCache.set(did, loader);
  return loader;
}

async function fetchDidDocument(_env: Env, did: string): Promise<any> {
  let url: string;
  if (did.startsWith('did:web:')) {
    url = buildDidWebUrl(did);
  } else if (did.startsWith('did:plc:')) {
    url = `https://plc.directory/${did}`;
  } else {
    throw new ProxyHeaderError('unsupported DID method');
  }

  const res = await fetch(url, {
    headers: {
      accept: 'application/did+json, application/json;q=0.9',
    },
  });

  if (!res.ok) {
    throw new ProxyHeaderError('failed to resolve DID document');
  }

  return res.json();
}

function buildDidWebUrl(did: string): string {
  const suffix = did.slice('did:web:'.length);
  const parts = suffix.split(':').map((segment) => {
    try {
      return decodeURIComponent(segment);
    } catch {
      throw new ProxyHeaderError('invalid did:web encoding');
    }
  });

  const host = parts.shift();
  if (!host) throw new ProxyHeaderError('invalid did:web value');

  if (parts.length === 0) {
    return `https://${host}/.well-known/did.json`;
  }

  const path = parts.join('/');
  return `https://${host}/${path}/did.json`;
}

function getServiceEndpointFromDidDoc(didDoc: any, did: string, serviceId: string): string | null {
  if (!didDoc || typeof didDoc !== 'object') return null;
  const services = Array.isArray((didDoc as any).service) ? (didDoc as any).service : [];
  if (!services.length) return null;

  const targets = new Set<string>([serviceId]);
  const docId = typeof (didDoc as any).id === 'string' ? (didDoc as any).id : undefined;
  if (docId && !serviceId.startsWith(docId)) {
    targets.add(`${docId}${serviceId}`);
  }

  for (const service of services) {
    if (!service || typeof service !== 'object') continue;
    const id = typeof service.id === 'string' ? service.id : undefined;
    if (!id || !targets.has(id)) continue;

    const endpoint = extractServiceEndpoint(service);
    if (endpoint) return endpoint;
  }

  return null;
}

function extractServiceEndpoint(service: any): string | null {
  const endpoint = service?.serviceEndpoint;
  if (typeof endpoint === 'string') return endpoint;
  if (endpoint && typeof endpoint === 'object') {
    if (typeof endpoint.uri === 'string') return endpoint.uri;
    if (Array.isArray(endpoint.urls)) {
      const first = endpoint.urls.find((value: unknown) => typeof value === 'string');
      if (typeof first === 'string') return first;
    }
  }
  return null;
}

async function getServiceSigningKey(env: Env): Promise<Secp256k1Keypair> {
  if (!cachedSigningKey) {
    cachedSigningKey = (async () => {
      const configured =
        (await resolveSecret(env.PDS_SERVICE_SIGNING_KEY_HEX as any)) ??
        (await resolveSecret(env.PDS_PLC_ROTATION_KEY as any));

      if (!configured || configured.trim() === '') {
        throw new Error('Service signing key is not configured');
      }

      return Secp256k1Keypair.import(configured.trim());
    })();
  }

  return cachedSigningKey;
}

export function getAppViewConfig(env: Env): AppViewConfig | null {
  const url = (typeof env.PDS_BSKY_APP_VIEW_URL === 'string' && env.PDS_BSKY_APP_VIEW_URL.trim() !== '')
    ? env.PDS_BSKY_APP_VIEW_URL.trim()
    : DEFAULT_APPVIEW_URL;
  const did = (typeof env.PDS_BSKY_APP_VIEW_DID === 'string' && env.PDS_BSKY_APP_VIEW_DID.trim() !== '')
    ? env.PDS_BSKY_APP_VIEW_DID.trim()
    : DEFAULT_APPVIEW_DID;

  if (!url || !did) return null;

  const cdn = typeof env.PDS_BSKY_APP_VIEW_CDN_URL_PATTERN === 'string'
    ? env.PDS_BSKY_APP_VIEW_CDN_URL_PATTERN.trim()
    : undefined;

  return { url, did, cdnUrlPattern: cdn || undefined };
}

async function createServiceJwt(
  env: Env,
  issuerDid: string,
  audienceDid: string,
  lexiconMethod: string | null,
  expiresInSeconds = 60,
): Promise<string> {
  const keypair = await getServiceSigningKey(env);
  const now = Math.floor(Date.now() / 1000);
  const exp = now + Math.max(1, expiresInSeconds);
  const header = {
    typ: 'JWT',
    alg: keypair.jwtAlg,
  };
  const payload: Record<string, unknown> = {
    iss: issuerDid,
    aud: audienceDid,
    iat: now,
    exp,
    jti: randomHex(),
  };
  if (lexiconMethod) {
    payload.lxm = lexiconMethod;
  }

  const encodedHeader = encodeJson(header);
  const encodedPayload = encodeJson(payload);
  const toSign = `${encodedHeader}.${encodedPayload}`;
  const signature = await keypair.sign(new TextEncoder().encode(toSign));
  const encodedSignature = encodeBase64Url(signature);
  return `${toSign}.${encodedSignature}`;
}

const FORWARDED_HEADERS = [
  'accept',
  'accept-encoding',
  'accept-language',
  'atproto-accept-labelers',
  'atproto-accept-personalized-feed',
  'cache-control',
  'if-none-match',
  'if-modified-since',
  'pragma',
  'x-bsky-topics',
  'x-bsky-feeds',
  'x-bsky-latest',
  'x-bsky-appview-features',
  'user-agent',
];

export interface ProxyAppViewOptions {
  request: Request;
  env: Env;
  lxm: string;
  fallback?: () => Promise<Response>;
}

export async function proxyAppView({ request, env, lxm, fallback }: ProxyAppViewOptions): Promise<Response> {
  const config = getAppViewConfig(env);
  if (!config) {
    return fallback ? await fallback() : new Response('AppView not configured', { status: 501 });
  }

  const auth = await authenticateRequest(request, env);
  if (!auth) return unauthorized();

  if (!auth.claims.sub) {
    return new Response(JSON.stringify({ error: 'InvalidToken' }), {
      status: 401,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  if (PROTECTED_METHODS.has(lxm)) {
    return new Response(
      JSON.stringify({ error: 'InvalidToken', message: 'method cannot be proxied' }),
      {
        status: 400,
        headers: { 'Content-Type': 'application/json' },
      },
    );
  }

  const scope = resolveAuthScope(auth.claims.scope);
  if (scope === TAKENDOWN_SCOPE) {
    return new Response(JSON.stringify({ error: 'AccountTakendown' }), {
      status: 403,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  if (!PRIVILEGED_SCOPES.has(scope) && PRIVILEGED_METHODS.has(lxm)) {
    return new Response(JSON.stringify({ error: 'InvalidToken' }), {
      status: 401,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  let target: ProxyTarget = { did: config.did, url: config.url };
  const proxyHeader = request.headers.get('atproto-proxy');
  if (proxyHeader) {
    try {
      target = await resolveProxyTarget(env, proxyHeader, config);
    } catch (error) {
      console.error('AppView proxy header error:', error);
      const isHeaderError = error instanceof ProxyHeaderError;
      return new Response(
        JSON.stringify({ error: isHeaderError ? 'InvalidProxyHeader' : 'ProxyResolutionFailed' }),
        {
          status: isHeaderError ? 400 : 502,
          headers: { 'Content-Type': 'application/json' },
        },
      );
    }
  }

  const originalUrl = new URL(request.url);
  const upstreamUrl = new URL(target.url);
  upstreamUrl.pathname = originalUrl.pathname;
  upstreamUrl.search = originalUrl.search;
  upstreamUrl.hash = '';

  const headers = new Headers();
  for (const header of FORWARDED_HEADERS) {
    const value = request.headers.get(header);
    if (value) headers.set(header, value);
  }

  let serviceJwt: string;
  try {
    serviceJwt = await createServiceJwt(env, auth.claims.sub, target.did, lxm);
  } catch (error) {
    console.error('AppView service token error:', error);
    if (fallback) {
      return fallback();
    }
    return new Response(JSON.stringify({ error: 'ServiceAuthUnavailable' }), {
      status: 503,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  headers.set('authorization', `Bearer ${serviceJwt}`);

  const method = request.method.toUpperCase();
  if (method !== 'GET' && method !== 'HEAD' && method !== 'POST') {
    return new Response(JSON.stringify({ error: 'MethodNotAllowed' }), {
      status: 405,
      headers: {
        'Content-Type': 'application/json',
        Allow: 'GET, HEAD, POST',
      },
    });
  }

  if (!headers.has('accept-encoding')) {
    headers.set('accept-encoding', 'identity');
  }

  if (method === 'POST') {
    const contentType = request.headers.get('content-type');
    if (contentType) headers.set('content-type', contentType);
    const contentEncoding = request.headers.get('content-encoding');
    if (contentEncoding) headers.set('content-encoding', contentEncoding);
  }

  try {
    const init: RequestInit = {
      method,
      headers,
    };

    if (method === 'POST') {
      init.body = request.body as any;
      (init as any).duplex = 'half';
    }

    const upstream = await fetch(upstreamUrl.toString(), init);

    const responseHeaders = new Headers(upstream.headers);
    return new Response(upstream.body, {
      status: upstream.status,
      statusText: upstream.statusText,
      headers: responseHeaders,
    });
  } catch (error) {
    console.error('AppView proxy error:', error);
    if (fallback) {
      return fallback();
    }
    return new Response(JSON.stringify({ error: 'UpstreamUnavailable' }), {
      status: 502,
      headers: { 'Content-Type': 'application/json' },
    });
  }
}

export async function getAppViewServiceToken(env: Env, did: string, aud?: string, lxm?: string | null, expiresInSeconds = 60) {
  const config = getAppViewConfig(env);
  if (!config) {
    throw new Error('AppView not configured');
  }
  return createServiceJwt(env, did, aud ?? config.did, lxm ?? null, expiresInSeconds);
}

export async function createServiceAuthToken(
  env: Env,
  issuerDid: string,
  audienceDid: string,
  lexiconMethod: string | null,
  expiresInSeconds = 60,
): Promise<string> {
  return createServiceJwt(env, issuerDid, audienceDid, lexiconMethod, expiresInSeconds);
}
