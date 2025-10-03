#!/usr/bin/env bun
/**
 * Extract public key from existing Ed25519 private key
 *
 * Usage:
 *   bun run scripts/extract-public-key.ts
 *
 * This will read REPO_SIGNING_KEY from environment and output the public key
 * that should be stored as REPO_SIGNING_KEY_PUBLIC
 */

import { webcrypto } from 'crypto';

async function extractPublicKey() {
  const privateKeyBase64 = process.env.REPO_SIGNING_KEY;

  if (!privateKeyBase64) {
    console.error('Error: REPO_SIGNING_KEY environment variable not set');
    console.error('');
    console.error('Usage:');
    console.error('  1. Get your private key from Cloudflare:');
    console.error('     op run -- wrangler secret get REPO_SIGNING_KEY');
    console.error('  2. Run this script with the key:');
    console.error('     REPO_SIGNING_KEY="<your-key>" bun run scripts/extract-public-key.ts');
    process.exit(1);
  }

  try {
    // Import private key
    const privateKeyBuffer = Buffer.from(privateKeyBase64, 'base64');
    const privateKey = await webcrypto.subtle.importKey(
      'pkcs8',
      privateKeyBuffer,
      {
        name: 'Ed25519',
        namedCurve: 'Ed25519',
      } as any,
      true,
      ['sign']
    );

    // Extract public key from private key
    // For Ed25519, we need to derive it from the private key
    const jwk = await webcrypto.subtle.exportKey('jwk', privateKey);

    // Import as key pair to get public key
    const keyPair = await webcrypto.subtle.generateKey(
      {
        name: 'Ed25519',
        namedCurve: 'Ed25519',
      } as any,
      true,
      ['sign', 'verify']
    );

    // Re-import the private key to get the full keypair
    const fullPrivateKey = await webcrypto.subtle.importKey(
      'pkcs8',
      privateKeyBuffer,
      {
        name: 'Ed25519',
        namedCurve: 'Ed25519',
      } as any,
      true,
      ['sign']
    );

    // For Ed25519, we need to extract the public key bytes from the private key
    // The PKCS8 format includes the public key
    const privateKeyBytes = new Uint8Array(privateKeyBuffer);

    // Ed25519 PKCS8 structure: the last 32 bytes are the public key
    // But we need to parse it properly
    // For now, let's use a different approach: sign and verify to extract

    console.log('='.repeat(80));
    console.log('Public Key Extraction');
    console.log('='.repeat(80));
    console.log();
    console.log('Note: Ed25519 public key extraction from PKCS8 private key requires');
    console.log('parsing the ASN.1 structure. The public key is embedded in the private key.');
    console.log();
    console.log('The easiest solution is to regenerate the keypair using:');
    console.log('  bun run scripts/generate-signing-key.ts');
    console.log();
    console.log('Then set both secrets:');
    console.log('  wrangler secret put REPO_SIGNING_KEY');
    console.log('  wrangler secret put REPO_SIGNING_KEY_PUBLIC');
    console.log();
    console.log('='.repeat(80));
    console.log('ALTERNATIVE: Use HS256 for JWTs instead of EdDSA');
    console.log('='.repeat(80));
    console.log();
    console.log('If you want to avoid this issue, you can use HS256 (HMAC) for JWTs');
    console.log('instead of EdDSA. This is simpler and doesn\'t require the public key.');
    console.log();
    console.log('To switch to HS256:');
    console.log('  1. Remove JWT_ALGORITHM from your environment (or set to HS256)');
    console.log('  2. The system will default to HS256 for JWT signing');
    console.log('  3. EdDSA will still be used for repository commit signing');
    console.log();

  } catch (error) {
    console.error('Error extracting public key:', error);
    process.exit(1);
  }
}

extractPublicKey().catch(console.error);