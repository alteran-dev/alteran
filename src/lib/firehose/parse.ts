import * as dagCbor from '@ipld/dag-cbor';

function readU32BE(buf: Uint8Array, off = 0): number {
  return ((buf[off] << 24) | (buf[off + 1] << 16) | (buf[off + 2] << 8) | buf[off + 3]) >>> 0;
}

function readVarUint(buf: Uint8Array, off: number, addl: number): { value: number; off: number } {
  if (addl < 24) return { value: addl, off };
  if (addl === 24) return { value: buf[off], off: off + 1 };
  if (addl === 25) return { value: (buf[off] << 8) | buf[off + 1], off: off + 2 };
  if (addl === 26)
    return {
      value: (buf[off] * 2 ** 24) + (buf[off + 1] << 16) + (buf[off + 2] << 8) + buf[off + 3],
      off: off + 4,
    };
  if (addl === 27) throw new Error('uint64 not supported in header');
  throw new Error('indefinite lengths not supported');
}

function skipItem(buf: Uint8Array, off: number): number {
  const ib = buf[off];
  if (ib === undefined) throw new Error('unexpected EOF');
  const major = ib >>> 5;
  const addl = ib & 0x1f;
  off += 1;
  const readLen = () => {
    const r = readVarUint(buf, off, addl);
    off = r.off;
    return r.value;
  };

  switch (major) {
    case 0: // unsigned
    case 1: // negative
      if (addl >= 24) off = readVarUint(buf, off, addl).off;
      return off;
    case 2: // byte string
    case 3: { // text string
      const len = readLen();
      return off + len;
    }
    case 4: { // array
      const len = readLen();
      for (let i = 0; i < len; i++) off = skipItem(buf, off);
      return off;
    }
    case 5: { // map
      const len = readLen();
      for (let i = 0; i < len; i++) {
        off = skipItem(buf, off); // key
        off = skipItem(buf, off); // value
      }
      return off;
    }
    case 6: { // tag
      // skip tag and the tagged item
      if (addl >= 24) off = readVarUint(buf, off, addl).off;
      return skipItem(buf, off);
    }
    case 7: // simple/float/bool/null
      if (addl === 24) return off + 1; // simple(8)
      if (addl === 25) return off + 2; // half float
      if (addl === 26) return off + 4; // float
      if (addl === 27) return off + 8; // double
      return off; // simple values (true/false/null)
    default:
      throw new Error('unknown major type');
  }
}

export function parseFramedFrame<T = unknown>(framed: Uint8Array): { header: any; body: T } {
  if (framed.byteLength < 5) throw new Error('frame too small');
  const total = readU32BE(framed, 0);
  if (total !== framed.byteLength - 4) throw new Error('length prefix mismatch');
  const payload = framed.subarray(4);

  const hdrEnd = skipItem(payload, 0);
  const header = dagCbor.decode(payload.subarray(0, hdrEnd));
  const body = dagCbor.decode(payload.subarray(hdrEnd)) as T;
  return { header, body };
}

