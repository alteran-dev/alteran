import type { APIContext } from 'astro';
import { isAuthorized, unauthorized } from '../../lib/auth';
import { resolveSecret } from '../../lib/secrets';
import * as uint8arrays from 'uint8arrays';

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

    // We must advertise the exact Ed25519 public key that will sign service-auth.
    // Prefer REPO_SIGNING_KEY_PUBLIC (raw 32-byte base64). This avoids brittle PKCS#8 parsing.
    const pubRawB64 = await resolveSecret((env as any).REPO_SIGNING_KEY_PUBLIC);
    let didKey: string | undefined;
    if (pubRawB64 && typeof pubRawB64 === 'string') {
      const cleaned = pubRawB64.replace(/\s+/g, '');
      try {
        const bin = atob(cleaned);
        const raw = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i++) raw[i] = bin.charCodeAt(i);
        if (raw.byteLength !== 32) {
          throw new Error(`REPO_SIGNING_KEY_PUBLIC must be 32 bytes (got ${raw.byteLength})`);
        }
        const prefixed = new Uint8Array(2 + raw.byteLength);
        prefixed[0] = 0xed; // Ed25519 multicodec prefix
        prefixed[1] = 0x01;
        prefixed.set(raw, 2);
        didKey = 'did:key:z' + uint8arrays.toString(prefixed, 'base58btc');
      } catch (e) {
        return new Response(
          JSON.stringify({ error: 'InvalidRequest', message: 'Invalid REPO_SIGNING_KEY_PUBLIC (expected raw 32-byte base64)' }),
          { status: 400, headers: { 'Content-Type': 'application/json' } },
        );
      }
    }

    if (!didKey) {
      // Fallback: require REPO_SIGNING_KEY_PUBLIC to be set explicitly.
      // Deriving from PKCS#8 is unreliable across encoders; failing early is safer.
      return new Response(
        JSON.stringify({
          error: 'InvalidRequest',
          message: 'REPO_SIGNING_KEY_PUBLIC not configured. Set raw 32-byte Ed25519 public key (base64).',
        }),
        { status: 400, headers: { 'Content-Type': 'application/json' } },
      );
    }

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
      verificationMethods: { atproto: didKey },
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
