import type { APIContext } from 'astro';
import { withCache, CACHE_CONFIGS } from '../../lib/cache';
import { base58btc } from 'multiformats/bases/base58';
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

      const serviceKeyHex = await resolveSecret(env.PDS_SERVICE_SIGNING_KEY_HEX as any);
      if (serviceKeyHex) {
        try {
          const keypair = await Secp256k1Keypair.import(serviceKeyHex.trim());
          publicKeyMultibase = formatMultikey(keypair.jwtAlg, keypair.publicKeyBytes());
        } catch (error) {
          console.warn('Failed to encode service signing key', error);
        }
      }

      if (!publicKeyMultibase) {
        const repoPubKeyB64 = await resolveSecret((env as any).REPO_SIGNING_KEY_PUBLIC);
        if (repoPubKeyB64) {
          try {
            const bin = atob(repoPubKeyB64.replace(/\s+/g, ''));
            const raw = new Uint8Array(bin.length);
            for (let i = 0; i < bin.length; i++) raw[i] = bin.charCodeAt(i);
            if (raw.byteLength === 32) {
              const prefixed = new Uint8Array(2 + raw.byteLength);
              prefixed[0] = 0xed;
              prefixed[1] = 0x01;
              prefixed.set(raw, 2);
              publicKeyMultibase = base58btc.encode(prefixed);
            }
          } catch (error) {
            console.warn('Failed to encode repo signing key', error);
          }
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

