export {};
/**
 * Simple helper to request a crawl from a relay.
 * Usage (recommend adding `--` so Bun doesn’t eat args):
 *   bun run scripts/request-crawl.ts -- --host your-pds.example.com [--relays bsky.network,relay.example.org]
 *
 * Flags support both "--key=value" and "--key value" forms.
 */

function parseArgs(argv: string[]): Map<string, string | boolean> {
  const out = new Map<string, string | boolean>();
  let i = 0;
  const sep = argv.indexOf("--");
  if (sep !== -1) i = sep + 1;
  for (; i < argv.length; i++) {
    const token = argv[i];
    if (!token.startsWith("--")) continue;
    const eq = token.indexOf("=");
    if (eq !== -1) {
      const k = token.slice(2, eq);
      out.set(`--${k}`, token.slice(eq + 1));
      continue;
    }
    const k = token;
    const next = argv[i + 1];
    if (next && !next.startsWith("--")) {
      out.set(k, next);
      i++;
    } else {
      out.set(k, true);
    }
  }
  return out;
}

const args = parseArgs(process.argv.slice(2));

function getFlag(name: string, fallback?: string): string | undefined {
  const v = args.get(`--${name}`);
  if (v === undefined) return fallback;
  if (typeof v === 'boolean') return fallback;
  return v;
}

const hostArg = getFlag('host') || process.env.PDS_HOSTNAME || '';
const relaysArg = getFlag('relays') || process.env.PDS_RELAY_HOSTS || 'bsky.network';

function normalizeHost(input: string): string {
  return input.replace(/^https?:\/\//i, '').replace(/:\d+$/, '').trim();
}

async function main() {
  const host = normalizeHost(hostArg);
  if (!host) {
    console.error('Missing --host. Example: --host your-pds.example.com or --host=https://your-pds.example.com');
    process.exit(1);
  }

  const relays = relaysArg
    .split(',')
    .map((r) => r.trim())
    .filter((r) => r && !/^https?:\/\//i.test(r));

  let ok = true;
  for (const relay of relays) {
    const url = `https://${relay}/xrpc/com.atproto.sync.requestCrawl`;
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ hostname: host }),
      });
      console.log(relay, res.status, res.statusText);
      if (!res.ok) ok = false;
    } catch (err) {
      console.error(relay, 'error', String(err));
      ok = false;
    }
  }

  process.exit(ok ? 0 : 2);
}

main();
