#!/usr/bin/env bun
/**
 * Import CAR file directly into D1 database
 * This bypasses Workers CPU limits by running locally
 */

import { parseCarFile } from '../src/lib/car-reader';
import * as dagCbor from '@ipld/dag-cbor';
import { CID } from 'multiformats/cid';
import { readFileSync, writeFileSync } from 'fs';
import { execSync } from 'child_process';
import * as uint8arrays from 'uint8arrays';

const DB_NAME = process.env.DB_NAME || 'alteran';
const USE_REMOTE = process.env.USE_REMOTE !== 'false'; // Default to remote
const CAR_FILE = process.argv[2];
const DID = process.argv[3];

if (!CAR_FILE || !DID) {
  console.error('Usage: bun scripts/import-car-to-d1.ts <car-file> <did>');
  console.error('Example: bun scripts/import-car-to-d1.ts repo.car did:plc:xxxxx');
  console.error('');
  console.error('Environment variables:');
  console.error('  DB_NAME=<name>        D1 database name (default: alteran)');
  console.error('  USE_REMOTE=false      Use local D1 instead of remote (default: true)');
  process.exit(1);
}

console.log(`[INFO] Target: ${USE_REMOTE ? 'REMOTE' : 'LOCAL'} database`);

console.log(`[INFO] Importing ${CAR_FILE} for ${DID} into ${DB_NAME}`);

// Read and parse CAR file
const carBytes = new Uint8Array(readFileSync(CAR_FILE));
const { header, blocks } = parseCarFile(carBytes);

console.log(`[INFO] Parsed CAR file: ${blocks.length} blocks`);

// Get root commit
const rootCid = header.roots[0];
if (!rootCid) {
  console.error('[ERROR] CAR file has no root CID');
  process.exit(1);
}

const commitBlock = blocks.find(b => b.cid.equals(rootCid));
if (!commitBlock) {
  console.error('[ERROR] Root commit block not found');
  process.exit(1);
}

const commit = dagCbor.decode(commitBlock.bytes) as any;
const rev = commit.rev || commit.version || '1';
const dataCid = commit.data;

console.log(`[INFO] Commit: ${rootCid.toString()}, Rev: ${rev}`);

// Build a block map for MST walking
const blockMap = new Map<string, Uint8Array>();
for (const block of blocks) {
  blockMap.set(block.cid.toString(), block.bytes);
}

// Walk MST and collect records
console.log(`[INFO] Walking MST to index records...`);
const mstRootCid = typeof dataCid === 'string' ? CID.parse(dataCid) : dataCid;
const records: Array<{ uri: string; cid: string; json: string }> = [];

try {
  await walkMST(mstRootCid, blockMap, DID, records);
  console.log(`[INFO] Found ${records.length} records in MST`);
} catch (error: any) {
  console.error(`[ERROR] Failed to walk MST: ${error.message}`);
  console.error(error.stack);
  process.exit(1);
}

// Generate SQL for batch insert
// D1 has a statement size limit, so we use smaller batches
const BATCH_SIZE = 50; // Reduced from 500 to avoid SQLITE_TOOBIG
const sqlStatements: string[] = [];

// Clean up previous import
sqlStatements.push(`DELETE FROM repo_root WHERE did = '${DID}';`);
sqlStatements.push(`DELETE FROM record WHERE did = '${DID}';`);
sqlStatements.push(`DELETE FROM account_state WHERE did = '${DID}';`);

console.log(`[INFO] Generating SQL for ${blocks.length} blocks...`);

// Insert blocks in batches
for (let i = 0; i < blocks.length; i += BATCH_SIZE) {
  const batch = blocks.slice(i, i + BATCH_SIZE);
  const values: string[] = [];

  for (const block of batch) {
    const cidStr = block.cid.toString();

    // Encode to base64
    let binary = '';
    const CHUNK_SIZE = 0x8000;
    for (let j = 0; j < block.bytes.length; j += CHUNK_SIZE) {
      binary += String.fromCharCode(...block.bytes.subarray(j, j + CHUNK_SIZE));
    }
    const base64 = btoa(binary);

    // Escape single quotes in base64 (though unlikely)
    const escapedBase64 = base64.replace(/'/g, "''");
    values.push(`('${cidStr}', '${escapedBase64}')`);
  }

  sqlStatements.push(
    `INSERT OR IGNORE INTO blockstore (cid, bytes) VALUES ${values.join(', ')};`
  );

  if ((i + BATCH_SIZE) % 1000 === 0 || i + BATCH_SIZE >= blocks.length) {
    console.log(`[INFO] Generated SQL for ${Math.min(i + BATCH_SIZE, blocks.length)}/${blocks.length} blocks`);
  }
}

// Insert repo_root
const commitCidStr = rootCid.toString();
const revStr = typeof rev === 'string' ? rev : String(rev);
sqlStatements.push(
  `INSERT INTO repo_root (did, commit_cid, rev) VALUES ('${DID}', '${commitCidStr}', '${revStr}');`
);

// Insert records in batches
console.log(`[INFO] Generating SQL for ${records.length} records...`);
for (let i = 0; i < records.length; i += BATCH_SIZE) {
  const batch = records.slice(i, i + BATCH_SIZE);
  const values: string[] = [];

  for (const record of batch) {
    const escapedUri = record.uri.replace(/'/g, "''");
    const escapedCid = record.cid.replace(/'/g, "''");
    const escapedJson = record.json.replace(/'/g, "''");
    const createdAt = Date.now();

    values.push(`('${escapedUri}', '${DID}', '${escapedCid}', '${escapedJson}', ${createdAt})`);
  }

  sqlStatements.push(
    `INSERT OR REPLACE INTO record (uri, did, cid, json, created_at) VALUES ${values.join(', ')};`
  );

  if ((i + BATCH_SIZE) % 1000 === 0 || i + BATCH_SIZE >= records.length) {
    console.log(`[INFO] Generated SQL for ${Math.min(i + BATCH_SIZE, records.length)}/${records.length} records`);
  }
}

// Write SQL to temp file
const sqlFile = `/tmp/import-${Date.now()}.sql`;
writeFileSync(sqlFile, sqlStatements.join('\n'));

console.log(`[INFO] Generated ${sqlStatements.length} SQL statements`);
console.log(`[INFO] Executing SQL via wrangler...`);

try {
  // Execute SQL via wrangler (use --remote for production database)
  const remoteFlag = USE_REMOTE ? '--remote' : '';
  const cmd = `wrangler d1 execute ${DB_NAME} ${remoteFlag} --file=${sqlFile}`;

  console.log(`[INFO] Running: ${cmd}`);
  execSync(cmd, {
    stdio: 'inherit'
  });

  console.log(`[SUCCESS] Import completed successfully`);
  console.log(`[INFO] DID: ${DID}`);
  console.log(`[INFO] Commit: ${commitCidStr}`);
  console.log(`[INFO] Rev: ${revStr}`);
  console.log(`[INFO] Blocks: ${blocks.length}`);

  console.log(`[INFO] Records indexed: ${records.length}`);

  // Clean up temp file
  execSync(`rm ${sqlFile}`);
} catch (error: any) {
  console.error(`[ERROR] Failed to execute SQL: ${error.message}`);
  console.error(`[INFO] SQL file saved at: ${sqlFile}`);
  process.exit(1);
}

/**
 * Walk MST tree and collect all records
 */
async function walkMST(
  rootCid: CID,
  blockMap: Map<string, Uint8Array>,
  did: string,
  records: Array<{ uri: string; cid: string; json: string }>
): Promise<void> {
  const visited = new Set<string>();

  async function walkNode(nodeCid: CID, prefix: string = ''): Promise<void> {
    const cidStr = nodeCid.toString();

    // Avoid infinite loops
    if (visited.has(cidStr)) return;
    visited.add(cidStr);

    const nodeBytes = blockMap.get(cidStr);
    if (!nodeBytes) {
      console.error(`[WARN] Missing block: ${cidStr}`);
      return;
    }

    const node = dagCbor.decode(nodeBytes) as any;

    // MST node structure: { l: CID | null, e: Array<{ p: number, k: Uint8Array, v: CID, t: CID | null }> }
    if (!node.e || !Array.isArray(node.e)) {
      console.error(`[WARN] Invalid MST node structure: ${cidStr}`);
      return;
    }

    // Walk left subtree first
    if (node.l) {
      await walkNode(node.l, prefix);
    }

    // Process entries
    let lastKey = prefix;
    for (const entry of node.e) {
      // Reconstruct key from prefix compression
      const keyBytes = entry.k;
      const keyStr = uint8arrays.toString(keyBytes, 'ascii');
      const fullKey = lastKey.slice(0, entry.p) + keyStr;
      lastKey = fullKey;

      // Get record value
      const recordCid = entry.v;
      const recordBytes = blockMap.get(recordCid.toString());

      if (recordBytes) {
        try {
          const recordData = dagCbor.decode(recordBytes);
          const uri = `at://${did}/${fullKey}`;

          records.push({
            uri,
            cid: recordCid.toString(),
            json: JSON.stringify(recordData)
          });
        } catch (error: any) {
          console.error(`[WARN] Failed to decode record ${recordCid.toString()}: ${error.message}`);
        }
      } else {
        console.error(`[WARN] Missing record block: ${recordCid.toString()} for key: ${fullKey}`);
      }

      // Walk right subtree
      if (entry.t) {
        await walkNode(entry.t, lastKey);
      }
    }
  }

  await walkNode(rootCid);
}
