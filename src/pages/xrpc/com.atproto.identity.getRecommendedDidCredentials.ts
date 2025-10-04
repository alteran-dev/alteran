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

    // Load signing key (Ed25519 PKCS#8 base64)
    const signingKeyBase64 = await resolveSecret(env.REPO_SIGNING_KEY);
    if (!signingKeyBase64) {
      return new Response(
        JSON.stringify({
          error: 'InvalidRequest',
          message: 'Signing key not configured'
        }),
        { status: 400, headers: { 'Content-Type': 'application/json' } }
      );
    }

    // Import Ed25519 private key from PKCS#8 base64
    const b64 = signingKeyBase64.replace(/\s+/g, '');
    const bin = atob(b64);
    const pkcs8 = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) pkcs8[i] = bin.charCodeAt(i);

    const privateKey = await crypto.subtle.importKey(
      'pkcs8',
      pkcs8,
      { name: 'Ed25519', namedCurve: 'Ed25519' } as any,
      true,
      ['sign']
    );

    // Export public key as raw bytes
    const publicKeyRaw = await crypto.subtle.exportKey('raw', privateKey);
    const publicKeyBytes = new Uint8Array(publicKeyRaw as ArrayBuffer);

    // Create did:key from public key
    // Ed25519 multicodec prefix is 0xed01
    const multicodecPrefix = new Uint8Array([0xed, 0x01]);
    const multicodecKey = new Uint8Array(multicodecPrefix.length + publicKeyBytes.length);
    multicodecKey.set(multicodecPrefix);
    multicodecKey.set(publicKeyBytes, multicodecPrefix.length);

    const didKey = 'did:key:z' + uint8arrays.toString(multicodecKey, 'base58btc');

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
        atproto: didKey
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