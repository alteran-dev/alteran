import { describe, test, expect } from 'bun:test';
import {
  createCommit,
  signCommit,
  verifyCommit,
  commitCid,
  generateTid,
  isValidTid,
} from '../src/lib/commit';
import { CID } from 'multiformats/cid';
import { webcrypto } from 'crypto';

describe('Commit Structure & Signing', () => {
  test('should create a commit', () => {
    const did = 'did:plc:test123';
    const mstRoot = CID.parse('bafyreigbtj4x7ip5legnfznufuopl4sg4knzc2cof6duas4b3q2fy6swua');
    const rev = '3jzfcijpj2z2a';

    const commit = createCommit(did, mstRoot, rev);

    expect(commit.did).toBe(did);
    expect(commit.version).toBe(3);
    expect(commit.data.toString()).toBe(mstRoot.toString());
    expect(commit.rev).toBe(rev);
    expect(commit.prev).toBeNull();
  });

  test('should generate valid TID', () => {
    const tid = generateTid();
    expect(isValidTid(tid)).toBe(true);
    expect(tid.length).toBe(13);
  });

  test('should sign and verify commit', async () => {
    // Generate test keypair
    const keyPair = await webcrypto.subtle.generateKey(
      { name: 'Ed25519', namedCurve: 'Ed25519' } as any,
      true,
      ['sign', 'verify']
    );

    const privateKeyBuffer = await webcrypto.subtle.exportKey('pkcs8', keyPair.privateKey);
    const privateKeyBase64 = Buffer.from(privateKeyBuffer).toString('base64');

    const publicKeyBuffer = await webcrypto.subtle.exportKey('spki', keyPair.publicKey);
    const publicKeyBase64 = Buffer.from(publicKeyBuffer).toString('base64');

    // Create and sign commit
    const did = 'did:plc:test123';
    const mstRoot = CID.parse('bafyreigbtj4x7ip5legnfznufuopl4sg4knzc2cof6duas4b3q2fy6swua');
    const rev = generateTid();

    const commit = createCommit(did, mstRoot, rev);
    const signedCommit = await signCommit(commit, privateKeyBase64);

    // Verify signature
    const isValid = await verifyCommit(signedCommit, publicKeyBase64);
    expect(isValid).toBe(true);
  });

  test('should calculate deterministic commit CID', async () => {
    const keyPair = await webcrypto.subtle.generateKey(
      { name: 'Ed25519', namedCurve: 'Ed25519' } as any,
      true,
      ['sign', 'verify']
    );

    const privateKeyBuffer = await webcrypto.subtle.exportKey('pkcs8', keyPair.privateKey);
    const privateKeyBase64 = Buffer.from(privateKeyBuffer).toString('base64');

    const did = 'did:plc:test123';
    const mstRoot = CID.parse('bafyreigbtj4x7ip5legnfznufuopl4sg4knzc2cof6duas4b3q2fy6swua');
    const rev = '3jzfcijpj2z2a';

    const commit1 = createCommit(did, mstRoot, rev);
    const signed1 = await signCommit(commit1, privateKeyBase64);
    const cid1 = await commitCid(signed1);

    const commit2 = createCommit(did, mstRoot, rev);
    const signed2 = await signCommit(commit2, privateKeyBase64);
    const cid2 = await commitCid(signed2);

    // CIDs should be the same for identical commits
    expect(cid1.toString()).toBe(cid2.toString());
  });

  test('should reject invalid signature', async () => {
    const keyPair1 = await webcrypto.subtle.generateKey(
      { name: 'Ed25519', namedCurve: 'Ed25519' } as any,
      true,
      ['sign', 'verify']
    );

    const keyPair2 = await webcrypto.subtle.generateKey(
      { name: 'Ed25519', namedCurve: 'Ed25519' } as any,
      true,
      ['sign', 'verify']
    );

    const privateKey1Buffer = await webcrypto.subtle.exportKey('pkcs8', keyPair1.privateKey);
    const privateKey1Base64 = Buffer.from(privateKey1Buffer).toString('base64');

    const publicKey2Buffer = await webcrypto.subtle.exportKey('spki', keyPair2.publicKey);
    const publicKey2Base64 = Buffer.from(publicKey2Buffer).toString('base64');

    const did = 'did:plc:test123';
    const mstRoot = CID.parse('bafyreigbtj4x7ip5legnfznufuopl4sg4knzc2cof6duas4b3q2fy6swua');
    const rev = generateTid();

    const commit = createCommit(did, mstRoot, rev);
    const signedCommit = await signCommit(commit, privateKey1Base64);

    // Verify with wrong public key should fail
    const isValid = await verifyCommit(signedCommit, publicKey2Base64);
    expect(isValid).toBe(false);
  });
});