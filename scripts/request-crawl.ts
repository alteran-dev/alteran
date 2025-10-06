/**
 * Simple helper to request a crawl from a relay.
 * Usage:
 *   bun run scripts/request-crawl.ts --host your-pds.example.com [--relays bsky.network,relay.example.org]
 */

const args = new Map(
  Array.from(process.argv.slice(2)).flatMap((arg) => {
    const m = arg.match(/^--([^=]+)=(.*)$/);
    if (m) return [[`--${m[1]}`, m[2]] as const];
    return [[arg, 'true'] as const];
  }),
);

function getFlag(name: string, fallback?: string): string | undefined {
  const v = args.get(`--${name}`);
  return v === undefined || v === 'true' ? fallback : v;
}

const hostArg = getFlag('host') || process.env.PDS_HOSTNAME || '';
const relaysArg = getFlag('relays') || process.env.PDS_RELAY_HOSTS || 'bsky.network';

function normalizeHost(input: string): string {
  return input.replace(/^https?:\/\//i, '').replace(/:\d+$/, '').trim();
}

async function main() {
  const host = normalizeHost(hostArg);
  if (!host) {
    console.error('Missing --host (bare hostname, no scheme)');
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

