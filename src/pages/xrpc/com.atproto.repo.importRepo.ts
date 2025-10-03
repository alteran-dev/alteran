import type { APIContext } from 'astro';
import { isAuthorized, unauthorized } from '../../lib/auth';
import { parseCarFile } from '../../lib/car-reader';
import { D1Blockstore } from '../../lib/mst';
import { getDb } from '../../db/client';
import { repo_root, commit_log } from '../../db/schema';
import { putRecord } from '../../db/dal';
import * as dagCbor from '@ipld/dag-cbor';
import { CID } from 'multiformats/cid';

export const prerender = false;

/**
 * com.atproto.repo.importRepo
 *
 * Imports a repository from a CAR (Content Addressable aRchive) file.
 * This is used during account migration to transfer the complete repo history.
 */
export async function POST({ locals, request }: APIContext) {
  const { env } = locals.runtime;

  if (!(await isAuthorized(request, env))) return unauthorized();

  try {
    const contentType = request.headers.get('content-type');
    if (contentType !== 'application/vnd.ipld.car') {
      return new Response(
        JSON.stringify({
          error: 'InvalidRequest',
          message: 'Content-Type must be application/vnd.ipld.car'
        }),
        { status: 400, headers: { 'Content-Type': 'application/json' } }
      );
    }

    const did = env.PDS_DID ?? 'did:example:single-user';
    const carBytes = new Uint8Array(await request.arrayBuffer());

    // Parse CAR file
    const { header, blocks } = parseCarFile(carBytes);

    if (blocks.length === 0) {
      return new Response(
        JSON.stringify({
          error: 'InvalidRequest',
          message: 'CAR file contains no blocks'
        }),
        { status: 400, headers: { 'Content-Type': 'application/json' } }
      );
    }

    // Store all blocks in blockstore
    const blockstore = new D1Blockstore(env);
    for (const block of blocks) {
      await blockstore.put(block.cid, block.bytes);
    }

    // Find the commit block (root of the CAR)
    const rootCid = header.roots[0];
    if (!rootCid) {
      return new Response(
        JSON.stringify({
          error: 'InvalidRequest',
          message: 'CAR file has no root CID'
        }),
        { status: 400, headers: { 'Content-Type': 'application/json' } }
      );
    }

    // Decode the commit to get repo details
    const commitBlock = blocks.find(b => b.cid.equals(rootCid));
    if (!commitBlock) {
      return new Response(
        JSON.stringify({
          error: 'InvalidRequest',
          message: 'Root commit block not found in CAR'
        }),
        { status: 400, headers: { 'Content-Type': 'application/json' } }
      );
    }

    const commit = dagCbor.decode(commitBlock.bytes) as any;
    const rev = commit.rev || commit.version || 1;

    // Update repo root
    const db = getDb(env);
    await db
      .insert(repo_root)
      .values({
        did,
        commitCid: rootCid.toString(),
        rev: typeof rev === 'string' ? parseInt(rev) : rev,
      })
      .onConflictDoUpdate({
        target: repo_root.did,
        set: {
          commitCid: rootCid.toString(),
          rev: typeof rev === 'string' ? parseInt(rev) : rev,
        },
      })
      .run();

    // Index records from MST
    // Note: This is a simplified implementation
    // A full implementation would walk the MST tree and index all records
    let recordCount = 0;
    for (const block of blocks) {
      try {
        const obj = dagCbor.decode(block.bytes) as any;

        // Check if this looks like a record (has $type)
        if (obj && typeof obj === 'object' && obj.$type) {
          // This is a record, we should index it
          // For now, we'll skip detailed indexing and let it be done lazily
          recordCount++;
        }
      } catch {
        // Not a valid CBOR object or not a record, skip
      }
    }

    return new Response(
      JSON.stringify({
        did,
        commitCid: rootCid.toString(),
        rev,
        blocksImported: blocks.length,
        recordsFound: recordCount,
        message: 'Repository imported successfully'
      }),
      { status: 200, headers: { 'Content-Type': 'application/json' } }
    );
  } catch (error: any) {
    return new Response(
      JSON.stringify({
        error: 'InternalServerError',
        message: error.message || 'Failed to import repository'
      }),
      { status: 500, headers: { 'Content-Type': 'application/json' } }
    );
  }
}