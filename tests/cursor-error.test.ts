import { describe, it, expect } from 'bun:test';
import { checkCursor } from '../src/lib/firehose/validation';
import * as dagCbor from '@ipld/dag-cbor';

function decodeFramedError(bytes: Uint8Array) {
  const payload = bytes.slice(4);
  const headerBytes = dagCbor.encode({ op: -1 });
  const ok = headerBytes.every((b, i) => payload[i] === b);
  expect(ok).toBe(true);
  const body = dagCbor.decode(payload.slice(headerBytes.length)) as any;
  return body;
}

describe('cursor validation error', () => {
  it('returns a framed FutureCursor error when cursor is ahead', () => {
    const err = checkCursor(150, 100);
    expect(err).toBeInstanceOf(Uint8Array);
    const body = decodeFramedError(err as Uint8Array);
    expect(body.error).toBe('FutureCursor');
  });
});

