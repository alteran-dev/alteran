import type { APIContext } from 'astro';
import { isAuthorized, unauthorized } from '../../lib/auth';

export const prerender = false;

/**
 * com.atproto.identity.requestPlcOperationSignature
 *
 * Single-user PDS instances typically control the PLC rotation key directly,
 * so the email-based 2FA flow used by the public PDS is unnecessary.  Clients
 * (like the Indigo goat CLI) still invoke this endpoint prior to signing a PLC
 * operation, so we acknowledge the request and report success without
 * triggering any side effects.
 */
export async function POST({ locals, request }: APIContext) {
  const { env } = locals.runtime;

  if (!(await isAuthorized(request, env))) {
    return unauthorized();
  }

  return new Response(null, { status: 200 });
}

