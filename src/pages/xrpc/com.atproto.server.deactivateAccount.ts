import type { APIContext } from 'astro';
import { isAuthorized, unauthorized } from '../../lib/auth';
import { setAccountActive, getAccountState } from '../../db/dal';

export const prerender = false;

/**
 * com.atproto.server.deactivateAccount
 *
 * Deactivates an account, preventing write operations.
 * Used when migrating away from this PDS.
 */
export async function POST({ locals, request }: APIContext) {
  const { env } = locals.runtime;

  if (!(await isAuthorized(request, env))) return unauthorized();

  try {
    const did = env.PDS_DID ?? 'did:example:single-user';

    // Check if account exists
    const accountState = await getAccountState(env, did);
    if (!accountState) {
      return new Response(
        JSON.stringify({
          error: 'AccountNotFound',
          message: 'Account does not exist'
        }),
        { status: 404, headers: { 'Content-Type': 'application/json' } }
      );
    }

    // Deactivate the account
    await setAccountActive(env, did, false);

    return new Response(
      JSON.stringify({
        did,
        active: false,
        message: 'Account deactivated successfully'
      }),
      { status: 200, headers: { 'Content-Type': 'application/json' } }
    );
  } catch (error: any) {
    return new Response(
      JSON.stringify({
        error: 'InternalServerError',
        message: error.message || 'Failed to deactivate account'
      }),
      { status: 500, headers: { 'Content-Type': 'application/json' } }
    );
  }
}