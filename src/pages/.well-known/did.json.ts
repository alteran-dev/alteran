import type { APIContext } from 'astro';
import { withCache, CACHE_CONFIGS } from '../../lib/cache';
import { base58btc } from 'multiformats/bases/base58';

export const prerender = false;

/**
 * DID Document endpoint for did:web
 *
 * Returns a DID document with:
 * - Service endpoints (PDS, firehose)
 * - Verification methods (signing key)
 *
 * Spec: https://w3c-ccg.github.io/did-method-web/
 */
export async function GET({ locals, request }: APIContext) {
  const { env } = locals.runtime;

  return withCache(
    request,
    async () => {
      const did = env.PDS_DID ?? 'did:example:single-user';
      const handle = env.PDS_HANDLE ?? 'user.example.com';
      const hostname = env.PDS_HOSTNAME ?? new URL(request.url).hostname;

      // Public repository signing key (raw 32-byte Ed25519) base64-encoded
      const pubKeyB64: string | undefined = (env as any).REPO_SIGNING_PUBLIC_KEY;
      let publicKeyMultibase: string | undefined;
      if (pubKeyB64) {
        try {
          const bin = atob(pubKeyB64.replace(/\s+/g, ''));
          const raw = new Uint8Array(bin.length);
          for (let i = 0; i < bin.length; i++) raw[i] = bin.charCodeAt(i);
          if (raw.byteLength === 32) {
            // multicodec: ed25519-pub = 0xED 0x01 prefix
            const prefixed = new Uint8Array(2 + raw.byteLength);
            prefixed[0] = 0xed; prefixed[1] = 0x01; prefixed.set(raw, 2);
            publicKeyMultibase = base58btc.encode(prefixed);
          }
        } catch {}
      }

      // Build DID document
      const didDocument = {
        '@context': [
          'https://www.w3.org/ns/did/v1',
          'https://w3id.org/security/suites/ed25519-2020/v1',
        ],
        id: did,
        alsoKnownAs: [`at://${handle}`],
        verificationMethod: publicKeyMultibase ? [
          {
            id: `${did}#atproto`,
            type: 'Ed25519VerificationKey2020',
            controller: did,
            publicKeyMultibase,
          },
        ] : [],
        service: [
          {
            id: `${did}#atproto_pds`,
            type: 'AtprotoPersonalDataServer',
            serviceEndpoint: `https://${hostname}`,
          },
        ],
      };

      return new Response(JSON.stringify(didDocument, null, 2), {
        headers: {
          'Content-Type': 'application/json',
        },
      });
    },
    CACHE_CONFIGS.DID_DOCUMENT
  );
}
