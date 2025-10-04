import type { APIContext } from 'astro';
import { Secp256k1Keypair } from '@atproto/crypto';
import { isAuthorized, unauthorized } from '../../lib/auth';
import { resolveSecret } from '../../lib/secrets';

export const prerender = false;

/**
 * com.atproto.identity.getRecommendedDidCredentials
 *
 * Returns the recommended DID credentials for the current account.
 * This includes the handle, signing key, and PDS endpoint that should be
 * used when updating the PLC identity.
 */
export async function GET({ locals, request }: APIContext) {
  const { env } = locals.runtime;

  if (!(await isAuthorized(request, env))) return unauthorized();

  try {
    const handle = (await resolveSecret(env.PDS_HANDLE)) ?? 'example.com';
    const hostname = env.PDS_HOSTNAME ?? handle;

    // Load signing key
    const signingKeyHex = await resolveSecret(env.REPO_SIGNING_KEY);
    if (!signingKeyHex) {
      return new Response(
        JSON.stringify({
          error: 'InvalidRequest',
          message: 'Signing key not configured'
        }),
        { status: 400, headers: { 'Content-Type': 'application/json' } }
      );
    }

    const signingKey = await Secp256k1Keypair.import(signingKeyHex);

    // Get current PLC data to preserve rotation keys
    const did = (await resolveSecret(env.PDS_DID)) ?? 'did:example:single-user';
    const plcResponse = await fetch(`https://plc.directory/${did}/data`);

    let rotationKeys: string[] = [];
    if (plcResponse.ok) {
      const plcData = await plcResponse.json() as { rotationKeys?: string[] };
      rotationKeys = plcData.rotationKeys || [];
    }

    const credentials = {
      rotationKeys,
      alsoKnownAs: [`at://${handle}`],
      verificationMethods: {
        atproto: signingKey.did()
      },
      services: {
        atproto_pds: {
          type: 'AtprotoPersonalDataServer',
          endpoint: `https://${hostname}`
        }
      }
    };

    return new Response(
      JSON.stringify(credentials),
      { status: 200, headers: { 'Content-Type': 'application/json' } }
    );
  } catch (error: any) {
    console.error('Get recommended credentials error:', error);
    return new Response(
      JSON.stringify({
        error: 'InternalServerError',
        message: error.message || 'Failed to get recommended credentials'
      }),
      { status: 500, headers: { 'Content-Type': 'application/json' } }
    );
  }
}