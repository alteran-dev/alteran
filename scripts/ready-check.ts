/**
 * Ready check for a deployed single-user PDS
 * Usage: bun scripts/ready-check.ts https://your-host
 */

const base = (process.argv[2] || '').replace(/\/$/, '');
if (!base) {
  console.error('Usage: bun scripts/ready-check.ts https://your-host');
  process.exit(2);
}

function j(r: Response) { return r.text().then((t) => { try { return JSON.parse(t); } catch { return t; } }); }

async function main() {
  const out: string[] = [];
  const step = (s: string) => out.push(s);

  // Health
  const h = await fetch(`${base}/health`);
  step(`health: ${h.status}`);

  // Login
  const identifier = 'user';
  const password = process.env.PDS_PASSWORD || 'pwd';
  const s = await fetch(`${base}/xrpc/com.atproto.server.createSession`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ identifier, password }),
  });
  const sb = await j(s) as any;
  step(`createSession: ${s.status}`);
  if (s.status !== 200) throw new Error(`login failed: ${JSON.stringify(sb)}`);
  const did = sb.did as string;
  const auth = { 'authorization': `Bearer ${sb.accessJwt}` };

  // Create
  const cr = await fetch(`${base}/xrpc/com.atproto.repo.createRecord`, {
    method: 'POST', headers: { 'content-type': 'application/json', ...auth },
    body: JSON.stringify({ collection: 'app.bsky.feed.post', record: { text: 'hello from ready-check' } }),
  });
  const crb = await j(cr) as any;
  step(`createRecord: ${cr.status}`);
  if (cr.status !== 200) throw new Error(`createRecord failed: ${JSON.stringify(crb)}`);

  // Get
  const rkey = String(crb.uri).split('/').pop();
  const gr = await fetch(`${base}/xrpc/com.atproto.repo.getRecord?repo=${encodeURIComponent(did)}&collection=app.bsky.feed.post&rkey=${rkey}`);
  step(`getRecord: ${gr.status}`);

  // Head vs Repo CAR
  const head = await fetch(`${base}/xrpc/com.atproto.sync.getHead`).then(j) as any;
  const car = await fetch(`${base}/xrpc/com.atproto.sync.getRepo?did=${encodeURIComponent(did)}`).then((r) => r.arrayBuffer());

  // Parse CAR header varint + dag-cbor header root string
  const buf = new Uint8Array(car);
  const readVarint = (bytes: Uint8Array, off: number) => { let x=0,s=0,i=off; for(;;){ const b=bytes[i++]; x|=(b&0x7f)<<s; if((b&0x80)===0) return [x,i] as const; s+=7; } };
  const [hlen, off] = readVarint(buf, 0);
  const headerBytes = buf.subarray(off, off + hlen);
  // Best effort: parse dag-cbor via structured clone if not available; otherwise skip compare
  let rootOk = false;
  try {
    // dynamic import only if available in runtime
    const dag = await import('@ipld/dag-cbor');
    const header: any = dag.decode(headerBytes as any);
    const root = String(header.roots?.[0] ?? '');
    rootOk = !!root && root === head.root;
  } catch {}
  step(`CAR root == head: ${rootOk}`);

  console.log(out.join('\n'));
}

main().catch((e) => { console.error(e?.stack || String(e)); process.exit(1); });

