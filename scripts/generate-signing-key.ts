#!/usr/bin/env bun
/**
 * Generate Ed25519 signing keypair for repository commits
 *
 * Usage:
 *   bun run scripts/generate-signing-key.ts
 *
 * This will output a base64-encoded private key that should be stored
 * in Wrangler secrets as REPO_SIGNING_KEY
 */

import { webcrypto } from 'crypto';
import { base58btc } from 'multiformats/bases/base58';

async function generateSigningKey() {
  // Generate Ed25519 keypair
  const keyPair = await webcrypto.subtle.generateKey(
    {
      name: 'Ed25519',
      namedCurve: 'Ed25519',
    } as any,
    true,
    ['sign', 'verify']
  );

  // Export private key
  const privateKeyBuffer = await webcrypto.subtle.exportKey('pkcs8', keyPair.privateKey);
  const privateKeyBase64 = Buffer.from(privateKeyBuffer).toString('base64');

  // Export public key (two formats)
  // 1) raw 32-byte key for DID document (REPO_SIGNING_KEY_PUBLIC)
  const publicKeyRaw = await webcrypto.subtle.exportKey('raw', keyPair.publicKey);
  const publicKeyRawBase64 = Buffer.from(publicKeyRaw).toString('base64');
  // 2) SPKI for external verification tools (informational)
  const publicKeySpki = await webcrypto.subtle.exportKey('spki', keyPair.publicKey);
  const publicKeySpkiBase64 = Buffer.from(publicKeySpki).toString('base64');
  // 3) did:multikey for PLC (z… base58btc of 0xED 0x01 + raw32)
  const prefixed = new Uint8Array(2 + publicKeyRaw.byteLength);
  prefixed[0] = 0xed; prefixed[1] = 0x01; prefixed.set(new Uint8Array(publicKeyRaw), 2);
  const didMultikey = base58btc.encode(prefixed);

  console.log('='.repeat(80));
  console.log('Ed25519 Signing Keypair Generated');
  console.log('='.repeat(80));
  console.log();
  console.log('Private Key (base64):');
  console.log(privateKeyBase64);
  console.log();
  console.log('Public Key (raw, base64) — use as REPO_SIGNING_KEY_PUBLIC:');
  console.log(publicKeyRawBase64);
  console.log();
  console.log('did:multikey (for PLC DID verificationMethod.atproto):');
  console.log(didMultikey);
  console.log();
  console.log('Public Key (SPKI, base64) — informational:');
  console.log(publicKeySpkiBase64);
  console.log();
  console.log('='.repeat(80));
  console.log('IMPORTANT: Store the private key securely!');
  console.log('='.repeat(80));
  console.log();
  console.log('To add to Wrangler secrets:');
  console.log(`  wrangler secret put REPO_SIGNING_KEY`);
  console.log('  Then paste the private key when prompted');
  console.log();
  console.log('To publish the public key in did.json (optional):');
  console.log('  wrangler secret put REPO_SIGNING_KEY_PUBLIC');
  console.log('  Then paste the raw public key (first value above)');
  console.log();
  console.log('PLC migration note:');
  console.log('  The PLC operation will advertise verificationMethods.atproto = did:key:' + didMultikey);
  console.log('  Ensure REPO_SIGNING_KEY (private) and REPO_SIGNING_KEY_PUBLIC (raw 32-byte base64) match this key.');
  console.log();
  console.log('Or add to .dev.vars for local development:');
  console.log(`  REPO_SIGNING_KEY="${privateKeyBase64}"`);
  console.log();
}

generateSigningKey().catch(console.error);
