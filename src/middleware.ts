import { defineMiddleware, sequence } from 'astro:middleware';

const cors = defineMiddleware(async ({ locals, request }, next) => {
  const { env } = (locals as any).runtime ?? (locals as any);
  const corsOrigins = (env.PDS_CORS_ORIGIN ?? '*').split(',').map((s: string) => s.trim()).filter(Boolean);
  const origin = request.headers.get('origin') ?? '';

  // In production, never allow wildcard - require explicit origins
  const isProduction = env.PDS_HOSTNAME && !env.PDS_HOSTNAME.includes('localhost');
  const allowWildcard = !isProduction && corsOrigins.includes('*');

  // Check if origin is in allowlist
  const isAllowed = allowWildcard || corsOrigins.includes(origin);

  if (request.method === 'OPTIONS') {
    if (!isAllowed) {
      return new Response('CORS origin not allowed', { status: 403 });
    }

    const headers = new Headers({
      'Access-Control-Allow-Origin': allowWildcard ? '*' : origin,
      'Access-Control-Allow-Methods': 'GET, HEAD, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization',
      'Access-Control-Max-Age': '86400', // 24 hours
    });
    return new Response(null, { status: 204, headers });
  }

  const response = await next();

  if (isAllowed) {
    response.headers.set('Access-Control-Allow-Origin', allowWildcard ? '*' : origin);
    response.headers.set('Vary', 'Origin');
  }

  return response;
});

const logger = defineMiddleware(async ({ request, locals }, next) => {
  const rid = crypto.randomUUID();
  (locals as any).requestId = rid;

  const start = Date.now();
  const url = new URL(request.url);

  try {
    const response = await next();
    const dur = Date.now() - start;

    // Structured logging
    console.log(JSON.stringify({
      level: 'info',
      type: 'request',
      requestId: rid,
      method: request.method,
      path: url.pathname,
      status: response.status,
      duration: dur,
      timestamp: new Date().toISOString(),
    }));

    // Track metrics (import dynamically to avoid circular deps)
    try {
      const { trackRequest } = await import('./lib/metrics');
      trackRequest(request.method, url.pathname, response.status, dur);
    } catch (e) {
      // Metrics are optional, don't fail request
    }

    // Add request ID to response headers
    response.headers.set('X-Request-ID', rid);

    return response;
  } catch (error) {
    const dur = Date.now() - start;

    // Log error
    console.log(JSON.stringify({
      level: 'error',
      type: 'request',
      requestId: rid,
      method: request.method,
      path: url.pathname,
      duration: dur,
      error: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined,
      timestamp: new Date().toISOString(),
    }));

    // Track error metrics
    try {
      const { trackRequest } = await import('./lib/metrics');
      trackRequest(request.method, url.pathname, 500, dur);
    } catch (e) {
      // Metrics are optional
    }

    throw error;
  }
});

export const onRequest = sequence(cors, logger);
