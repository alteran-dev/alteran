import type { APIContext } from 'astro';
import { withCache, CACHE_CONFIGS } from '../../lib/cache';
import { resolveSecret } from '../../lib/secrets';
import { Secp256k1Keypair } from '@atproto/crypto';
import { formatMultikey } from '@atproto/crypto/dist/did';

export const prerender = false;

export async function GET({ locals, request }: APIContext) {
  const { env } = locals.runtime;

  return withCache(
    request,
    async () => {
      const did = env.PDS_DID ?? 'did:example:single-user';
      const handle = env.PDS_HANDLE ?? 'user.example.com';
      const hostname = env.PDS_HOSTNAME ?? new URL(request.url).hostname;

      let publicKeyMultibase: string | undefined;
      const signingKey = await resolveSecret((env as any).REPO_SIGNING_KEY);
      if (signingKey) {
        try {
          const cleaned = signingKey.trim();
          let kp: Secp256k1Keypair;
          if (/^[0-9a-fA-F]{64}$/.test(cleaned)) {
            kp = await Secp256k1Keypair.import(cleaned);
          } else {
            const bin = atob(cleaned.replace(/\s+/g, ''));
            const bytes = new Uint8Array(bin.length);
            for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
            kp = await Secp256k1Keypair.import(bytes);
          }
          publicKeyMultibase = formatMultikey(kp.jwtAlg, kp.publicKeyBytes());
        } catch (error) {
          console.warn('Failed to encode REPO_SIGNING_KEY', error);
        }
      }

      const verificationMethods = publicKeyMultibase
        ? [
            {
              id: `${did}#atproto`,
              type: 'Multikey',
              controller: did,
              publicKeyMultibase,
            },
          ]
        : [];

      const didDocument = {
        '@context': [
          'https://www.w3.org/ns/did/v1',
          'https://w3id.org/security/multikey/v1',
        ],
        id: did,
        alsoKnownAs: [`at://${handle}`],
        verificationMethod: verificationMethods,
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
    CACHE_CONFIGS.DID_DOCUMENT,
  );
}
