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
import { Secp256k1Keypair } from '@atproto/crypto';

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
    // Generate test keypair (secp256k1)
    const keypair = await Secp256k1Keypair.create({ exportable: true });
    const privBytes = await keypair.export();
    const privateKeyHex = Array.from(privBytes).map(b => b.toString(16).padStart(2, '0')).join('');
    const didKey = keypair.did();

    // Create and sign commit
    const did = 'did:plc:test123';
    const mstRoot = CID.parse('bafyreigbtj4x7ip5legnfznufuopl4sg4knzc2cof6duas4b3q2fy6swua');
    const rev = generateTid();

    const commit = createCommit(did, mstRoot, rev);
    const signedCommit = await signCommit(commit, privateKeyHex);

    // Verify signature
    const isValid = await verifyCommit(signedCommit, didKey);
    expect(isValid).toBe(true);
  });

  test('should calculate deterministic commit CID', async () => {
    const keypair = await Secp256k1Keypair.create({ exportable: true });
    const privBytes = await keypair.export();
    const privateKeyHex = Array.from(privBytes).map(b => b.toString(16).padStart(2, '0')).join('');

    const did = 'did:plc:test123';
    const mstRoot = CID.parse('bafyreigbtj4x7ip5legnfznufuopl4sg4knzc2cof6duas4b3q2fy6swua');
    const rev = '3jzfcijpj2z2a';

    const commit1 = createCommit(did, mstRoot, rev);
    const signed1 = await signCommit(commit1, privateKeyHex);
    const cid1 = await commitCid(signed1);

    const commit2 = createCommit(did, mstRoot, rev);
    const signed2 = await signCommit(commit2, privateKeyHex);
    const cid2 = await commitCid(signed2);

    // CIDs should be the same for identical commits
    expect(cid1.toString()).toBe(cid2.toString());
  });

  test('should reject invalid signature', async () => {
    const keypair1 = await Secp256k1Keypair.create({ exportable: true });
    const keypair2 = await Secp256k1Keypair.create({ exportable: true });
    const priv1Bytes = await keypair1.export();
    const privateKey1Hex = Array.from(priv1Bytes).map(b => b.toString(16).padStart(2, '0')).join('');
    const wrongDid = keypair2.did();

    const did = 'did:plc:test123';
    const mstRoot = CID.parse('bafyreigbtj4x7ip5legnfznufuopl4sg4knzc2cof6duas4b3q2fy6swua');
    const rev = generateTid();

    const commit = createCommit(did, mstRoot, rev);
    const signedCommit = await signCommit(commit, privateKey1Hex);

    // Verify with wrong public key should fail
    const isValid = await verifyCommit(signedCommit, wrongDid);
    expect(isValid).toBe(false);
  });
});
