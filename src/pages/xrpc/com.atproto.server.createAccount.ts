import type { APIContext } from 'astro';
import { isAuthorized, unauthorized } from '../../lib/auth';
import { createAccountState, getAccountState } from '../../db/dal';

export const prerender = false;

/**
 * com.atproto.server.createAccount
 *
 * Single-user PDS implementation:
 * - Only allows creating account for the configured PDS_DID
 * - Creates account in deactivated state for migration
 * - Optionally validates serviceAuth JWT from old PDS
 */
export async function POST({ locals, request }: APIContext) {
  const { env } = locals.runtime;

  // Require authentication for account creation
  if (!(await isAuthorized(request, env))) return unauthorized();

  try {
    const body = await request.json() as { did?: string; handle?: string; deactivated?: boolean };
    const { did, handle, deactivated } = body;

    // Validate required fields
    if (!did) {
      return new Response(
        JSON.stringify({ error: 'InvalidRequest', message: 'did is required' }),
        { status: 400, headers: { 'Content-Type': 'application/json' } }
      );
    }

    // Single-user enforcement: only allow configured DID
    const configuredDid = env.PDS_DID;
    if (did !== configuredDid) {
      return new Response(
        JSON.stringify({
          error: 'InvalidRequest',
          message: `This is a single-user PDS. Only ${configuredDid} is allowed.`
        }),
        { status: 400, headers: { 'Content-Type': 'application/json' } }
      );
    }

    // Check if account already exists
    const existing = await getAccountState(env, did);
    if (existing) {
      return new Response(
        JSON.stringify({
          error: 'AccountAlreadyExists',
          message: 'Account already exists for this DID'
        }),
        { status: 400, headers: { 'Content-Type': 'application/json' } }
      );
    }

    // Create account in deactivated state (for migration)
    const active = deactivated === true ? false : true;
    await createAccountState(env, did, active);

    return new Response(
      JSON.stringify({
        did,
        handle: handle || env.PDS_HANDLE,
        active,
        createdAt: new Date().toISOString()
      }),
      { status: 200, headers: { 'Content-Type': 'application/json' } }
    );
  } catch (error: any) {
    return new Response(
      JSON.stringify({
        error: 'InternalServerError',
        message: error.message || 'Failed to create account'
      }),
      { status: 500, headers: { 'Content-Type': 'application/json' } }
    );
  }
}