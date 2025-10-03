import { describe, it, expect } from 'bun:test';
import * as Did from '../src/pages/.well-known/did.json';
import { base58btc } from 'multiformats/bases/base58';

function b64(u8: Uint8Array): string {
  let s = '';
  for (const b of u8) s += String.fromCharCode(b);
  return btoa(s);
}

describe('did.json exposes publicKeyMultibase when provided', () => {
  it('includes multibase key', async () => {
    const pub = new Uint8Array(32);
    for (let i = 0; i < 32; i++) pub[i] = i + 1;
    const env: any = {
      PDS_DID: 'did:web:example.com',
      PDS_HANDLE: 'user.example.com',
      REPO_SIGNING_PUBLIC_KEY: b64(pub),
    };
    const req = new Request('http://localhost/.well-known/did.json');
    const res = await (Did as any).GET({ locals: { runtime: { env } }, request: req });
    expect(res.status).toBe(200);
    const json = await res.json();
    const vm = (json.verificationMethod || [])[0];
    expect(vm).toBeTruthy();
    // Verify prefix ed25519-pub multicodec
    const decoded = base58btc.decode(vm.publicKeyMultibase);
    expect(decoded[0]).toBe(0xed);
    expect(decoded[1]).toBe(0x01);
    expect(decoded.slice(2).length).toBe(32);
  });
});

