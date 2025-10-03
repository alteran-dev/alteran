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

  // Export public key for verification
  const publicKeyBuffer = await webcrypto.subtle.exportKey('spki', keyPair.publicKey);
  const publicKeyBase64 = Buffer.from(publicKeyBuffer).toString('base64');

  console.log('='.repeat(80));
  console.log('Ed25519 Signing Keypair Generated');
  console.log('='.repeat(80));
  console.log();
  console.log('Private Key (base64):');
  console.log(privateKeyBase64);
  console.log();
  console.log('Public Key (base64):');
  console.log(publicKeyBase64);
  console.log();
  console.log('='.repeat(80));
  console.log('IMPORTANT: Store the private key securely!');
  console.log('='.repeat(80));
  console.log();
  console.log('To add to Wrangler secrets:');
  console.log(`  wrangler secret put REPO_SIGNING_KEY`);
  console.log('  Then paste the private key when prompted');
  console.log();
  console.log('Or add to .dev.vars for local development:');
  console.log(`  REPO_SIGNING_KEY="${privateKeyBase64}"`);
  console.log();
}

generateSigningKey().catch(console.error);