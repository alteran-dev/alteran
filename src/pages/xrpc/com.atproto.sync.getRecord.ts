import type { APIContext } from 'astro';
import { RepoManager } from '../../services/repo-manager';
import { encodeRecordBlock } from '../../services/car';
import * as dagCbor from '@ipld/dag-cbor';
import { CID } from 'multiformats/cid';
import { sha256 } from 'multiformats/hashes/sha2';

export const prerender = false;

/**
 * com.atproto.sync.getRecord
 * Get a single record as a CAR file
 */
export async function GET({ locals, url }: APIContext) {
  const { env } = locals.runtime;

  const did = url.searchParams.get('did') || env.PDS_DID || 'did:example:single-user';
  const collection = url.searchParams.get('collection');
  const rkey = url.searchParams.get('rkey');

  if (!collection || !rkey) {
    return new Response(
      JSON.stringify({ error: 'InvalidRequest', message: 'collection and rkey required' }),
      { status: 400, headers: { 'Content-Type': 'application/json' } }
    );
  }

  try {
    const repoManager = new RepoManager(env);
    const record = await repoManager.getRecord(collection, rkey);

    if (!record) {
      return new Response(
        JSON.stringify({ error: 'RecordNotFound' }),
        { status: 404, headers: { 'Content-Type': 'application/json' } }
      );
    }

    // Encode the record as a single-block CAR snapshot (root = record CID)
    const { cid, bytes } = await encodeRecordBlock(record);

    // Minimal CAR encoding (header + single block)
    const header = dagCbor.encode({ version: 1, roots: [cid] });
    const varint = (n: number) => { const a:number[]=[]; while(n>=0x80){a.push((n&0x7f)|0x80); n>>>=7;} a.push(n); return new Uint8Array(a); };
    const concat = (parts: Uint8Array[]) => { const len = parts.reduce((n,p)=>n+p.byteLength,0); const out = new Uint8Array(len); let o=0; for(const p of parts){out.set(p,o); o+=p.byteLength;} return out; };
    const block = concat([cid.bytes, bytes]);
    const carBytes = concat([varint(header.byteLength), header, varint(block.byteLength), block]);

    return new Response(carBytes as any, {
      status: 200,
      headers: {
        'Content-Type': 'application/vnd.ipld.car; version=1',
        'Content-Disposition': 'inline; filename="record.car"',
      },
    });
  } catch (error) {
    console.error('getRecord error:', error);
    return new Response(
      JSON.stringify({ error: 'InternalServerError', message: String(error) }),
      { status: 500, headers: { 'Content-Type': 'application/json' } }
    );
  }
}
