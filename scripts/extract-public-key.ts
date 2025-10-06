#!/usr/bin/env bun
/**
 * Extract the Ed25519 public key from a PKCS#8 private key (base64),
 * and print it in both raw base64 and did:multikey (base58btc) formats.
 *
 * Usage:
 *   REPO_SIGNING_KEY="<base64-pkcs8>" bun run scripts/extract-public-key.ts
 */

import { createPrivateKey, createPublicKey, KeyObject } from 'crypto';
import { base58btc } from 'multiformats/bases/base58';

function wrapPem(base64: string, type: 'PRIVATE KEY' | 'PUBLIC KEY'): string {
  const lines = base64.replace(/\s+/g, '').match(/.{1,64}/g) || [];
  return `-----BEGIN ${type}-----\n${lines.join('\n')}\n-----END ${type}-----\n`;
}

function b64urlToBytes(s: string): Uint8Array {
  const pad = s.length % 4 === 2 ? '==' : s.length % 4 === 3 ? '=' : '';
  const bin = Buffer.from(s.replace(/-/g, '+').replace(/_/g, '/') + pad, 'base64');
  return new Uint8Array(bin);
}

function parseSpkiToRaw(spkiDer: Uint8Array): Uint8Array {
  // Minimal DER parser: SPKI = SEQUENCE { algId SEQUENCE, subjectPublicKey BIT STRING }
  let i = 0;
  const buf = spkiDer;
  const expect = (tag: number) => {
    if (buf[i++] !== tag) throw new Error(`DER parse error: expected tag 0x${tag.toString(16)}`);
  };
  const readLen = (): number => {
    let len = buf[i++];
    if (len & 0x80) {
      const n = len & 0x7f;
      if (n === 0 || n > 4) throw new Error('DER parse error: bad length');
      len = 0;
      for (let j = 0; j < n; j++) len = (len << 8) | buf[i++];
    }
    return len;
  };
  expect(0x30); // SEQ
  const seqLen = readLen();
  const end = i + seqLen;
  // algId
  expect(0x30);
  i += readLen(); // skip AlgorithmIdentifier
  // subjectPublicKey
  expect(0x03); // BIT STRING
  const bitLen = readLen();
  const unused = buf[i++];
  if (unused !== 0) throw new Error('Unexpected unused bits in BIT STRING');
  const key = buf.slice(i, i + (bitLen - 1));
  if (key.length !== 32) throw new Error(`Unexpected public key length ${key.length}`);
  return key;
}

async function main() {
  const privateKeyBase64 = process.env.REPO_SIGNING_KEY?.trim();
  if (!privateKeyBase64) {
    console.error('Error: REPO_SIGNING_KEY environment variable not set');
    console.error('Example: REPO_SIGNING_KEY="<base64>" bun run scripts/extract-public-key.ts');
    process.exit(1);
  }

  // Build PEM for Node crypto
  const pem = wrapPem(privateKeyBase64, 'PRIVATE KEY');
  let pubKeyRaw: Uint8Array;
  try {
    const priv: KeyObject = createPrivateKey({ key: pem, format: 'pem', type: 'pkcs8' });
    const pub: KeyObject = createPublicKey(priv);

    // Try to export as JWK first (supported in modern runtimes)
    try {
      const jwk = pub.export({ format: 'jwk' }) as any;
      const x = jwk?.x as string | undefined; // base64url
      if (!x) throw new Error('Missing x in JWK');
      pubKeyRaw = b64urlToBytes(x);
      if (pubKeyRaw.length !== 32) throw new Error('Unexpected JWK x length');
    } catch {
      // Fallback: export SPKI DER and parse BIT STRING to get raw key
      const spkiDer = pub.export({ format: 'der', type: 'spki' }) as Buffer;
      pubKeyRaw = parseSpkiToRaw(new Uint8Array(spkiDer));
    }
  } catch (err) {
    console.error('Failed to parse PKCS#8 private key:', err);
    process.exit(1);
  }

  // did:multikey for Ed25519 is base58btc of 0xED 0x01 + raw32
  const prefixed = new Uint8Array(2 + pubKeyRaw.length);
  prefixed[0] = 0xed;
  prefixed[1] = 0x01;
  prefixed.set(pubKeyRaw, 2);
  const multikey = base58btc.encode(prefixed); // z...

  console.log('='.repeat(80));
  console.log('Public Key Extraction');
  console.log('='.repeat(80));
  console.log();
  console.log('Raw public key (base64):');
  console.log(Buffer.from(pubKeyRaw).toString('base64'));
  console.log();
  console.log('did:multikey (base58btc, for DID documents):');
  console.log(multikey);
  console.log();
  console.log('Set this as REPO_SIGNING_KEY_PUBLIC, e.g.:');
  console.log('  wrangler secret put REPO_SIGNING_KEY_PUBLIC --env production');
  console.log();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
