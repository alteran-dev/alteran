import type { APIContext } from 'astro';
import { isAuthorized, unauthorized } from '../../lib/auth';

export const prerender = false;

/**
 * com.atproto.identity.getRecommendedDidCredentials
 *
 * Returns recommended DID credentials for this PDS.
 * Used during migration to update identity documents.
 */
export async function GET({ locals, request }: APIContext) {
  const { env } = locals.runtime;

  if (!(await isAuthorized(request, env))) return unauthorized();

  try {
    const did = env.PDS_DID ?? 'did:example:single-user';
    const handle = env.PDS_HANDLE ?? 'example.com';
    const hostname = env.PDS_HOSTNAME ?? handle;

    // Get signing key if available
    let signingKey: string | undefined;
    if (env.REPO_SIGNING_KEY_PUBLIC) {
      // Convert raw public key to multibase format
      const pubKeyStr = String(env.REPO_SIGNING_KEY_PUBLIC);
      const pubKeyBytes = Uint8Array.from(atob(pubKeyStr), c => c.charCodeAt(0));

      // Ed25519 multicodec prefix (0xed01) + public key
      const multicodecBytes = new Uint8Array(2 + pubKeyBytes.length);
      multicodecBytes[0] = 0xed;
      multicodecBytes[1] = 0x01;
      multicodecBytes.set(pubKeyBytes, 2);

      // Base58 encode with 'z' prefix for multibase
      signingKey = 'z' + base58Encode(multicodecBytes);
    }

    return new Response(
      JSON.stringify({
        did,
        handle,
        pds: `https://${hostname}`,
        signingKey,
        alsoKnownAs: [`at://${handle}`],
        verificationMethods: signingKey ? {
          atproto: signingKey
        } : undefined,
        services: {
          atproto_pds: {
            type: 'AtprotoPersonalDataServer',
            endpoint: `https://${hostname}`
          }
        }
      }),
      { status: 200, headers: { 'Content-Type': 'application/json' } }
    );
  } catch (error: any) {
    return new Response(
      JSON.stringify({
        error: 'InternalServerError',
        message: error.message || 'Failed to get DID credentials'
      }),
      { status: 500, headers: { 'Content-Type': 'application/json' } }
    );
  }
}

/**
 * Base58 encode (Bitcoin alphabet)
 */
function base58Encode(bytes: Uint8Array): string {
  const ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';

  // Convert bytes to bigint
  let num = 0n;
  for (const byte of bytes) {
    num = num * 256n + BigInt(byte);
  }

  // Convert to base58
  let result = '';
  while (num > 0n) {
    const remainder = Number(num % 58n);
    result = ALPHABET[remainder] + result;
    num = num / 58n;
  }

  // Add leading '1's for leading zero bytes
  for (const byte of bytes) {
    if (byte === 0) {
      result = '1' + result;
    } else {
      break;
    }
  }

  return result;
}