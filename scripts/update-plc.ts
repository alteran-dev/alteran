#!/usr/bin/env bun
export {};
/**
 * update-plc.ts
 *
 * Update your PLC document (atproto signing key + PDS endpoint) without re-importing data.
 *
 * Flow:
 * - Auth to NEW PDS (your server) and OLD PDS (previous host, e.g., bsky.social)
 * - NEW: GET com.atproto.identity.getRecommendedDidCredentials (uses your REPO_SIGNING_KEY)
 * - OLD: POST com.atproto.identity.requestPlcOperationSignature (sends email with token)
 * - OLD: POST com.atproto.identity.signPlcOperation with token + recommended payload
 * - NEW: POST com.atproto.identity.submitPlcOperation with returned { operation }
 * - Verify PLC doc and optionally request crawl from relay(s)
 *
 * Usage examples:
 *   bun scripts/update-plc.ts \
 *     --new https://rawkode.dev --old https://bsky.social \
 *     --did did:plc:xxxx --handle rawkode.dev \
 *     --new-pass "$NEW_PWD" --old-pass "$OLD_PWD"
 *
 * Flags:
 *   --new <url>         New PDS URL (default: https://rawkode.dev)
 *   --old <url>         Old PDS URL (default: https://bsky.social)
 *   --did <did:plc:..>  Your PLC DID (required)
 *   --handle <handle>   Your handle (default: rawkode.dev)
 *   --new-pass <pwd>    Password for NEW PDS (if omitted, prompt)
 *   --old-pass <pwd>    Password for OLD PDS (if omitted, prompt)
 *   --token <code>      PLC token from email (if omitted, prompt after sending)
 *   --no-crawl          Skip relay crawl request after submit
 *   --relays <csv>      Relay hosts (default: bsky.network)
 */

type Args = Record<string, string | boolean>

function parseArgs(argv: string[]): Args {
  const out: Args = {}
  for (let i = 2; i < argv.length; i++) {
    const t = argv[i]
    if (!t.startsWith('--')) continue
    const eq = t.indexOf('=')
    if (eq > 0) {
      out[t.slice(2, eq)] = t.slice(eq + 1)
    } else {
      const k = t.slice(2)
      const nxt = argv[i + 1]
      if (nxt && !nxt.startsWith('--')) { out[k] = nxt; i++ } else { out[k] = true }
    }
  }
  return out
}

async function prompt(label: string, hidden = false): Promise<string> {
  if (typeof (globalThis as any).Bun?.password === 'function') {
    return hidden ? await (Bun as any).password({ prompt: label + ': ' }) : await (Bun as any).prompt(label + ': ')
  }
  // Fallback: minimal prompt (not hidden)
  const buf = new Uint8Array(1024)
  await Bun.stdout.write(label + ': ')
  const n = await (Bun.stdin as any).read(buf)
  return new TextDecoder().decode(buf.subarray(0, n ?? 0)).trim()
}

async function httpJson(method: string, url: string, opts?: { headers?: Record<string, string>, body?: any }) {
  const res = await fetch(url, {
    method,
    headers: { 'accept': 'application/json', ...(opts?.headers || {}), ...(opts?.body ? { 'content-type': 'application/json' } : {}) },
    body: opts?.body ? JSON.stringify(opts.body) : undefined,
  })
  let json: any = null
  try { json = await res.json() } catch {}
  return { status: res.status, ok: res.ok, json }
}

async function main() {
  const args = parseArgs(process.argv)

  const NEW = String(args.new || 'https://rawkode.dev').replace(/\/?$/, '')
  let OLD = typeof args.old === 'string' ? String(args.old).replace(/\/?$/, '') : ''
  const DID = String(args.did || '')
  const HANDLE = String(args.handle || 'rawkode.dev')
  if (!DID || !DID.startsWith('did:plc:')) {
    console.error('ERROR: --did did:plc:... is required')
    process.exit(2)
  }

  const env = (globalThis as any).process?.env || {}
  let NEW_PASS = typeof args['new-pass'] === 'string' ? String(args['new-pass']) : (env.UPDATE_PLC_NEW_PASS || env.NEW_PASS || '')
  let OLD_PASS = typeof args['old-pass'] === 'string' ? String(args['old-pass']) : (env.UPDATE_PLC_OLD_PASS || env.OLD_PASS || '')
  let TOKEN = typeof args['token'] === 'string' ? String(args['token']) : (env.UPDATE_PLC_TOKEN || env.PLC_TOKEN || '')
  const NO_CRAWL = Boolean(args['no-crawl'] || false)
  const RELAYS = String(args.relays || 'bsky.network').split(',').map(s => s.trim()).filter(Boolean)

  console.log(`[INFO] NEW: ${NEW}  OLD: ${OLD}`)
  console.log(`[INFO] DID: ${DID}  HANDLE: ${HANDLE}`)

  if (!NEW_PASS) {
    // Try interactive; if not available, instruct to pass via flags/env
    try {
      NEW_PASS = await prompt(`Password for ${HANDLE} on NEW (${NEW})`, true)
    } catch (e) {
      console.error('No interactive input available. Pass --new-pass or set env NEW_PASS / UPDATE_PLC_NEW_PASS')
      process.exit(9)
    }
  }

  // If --old omitted, infer from PLC document's current endpoint
  if (!OLD) {
    try {
      const plc = await fetch(`https://plc.directory/${encodeURIComponent(DID)}`)
      if (plc.ok) {
        const doc: any = await plc.json()
        OLD = ((): string => {
          const svc = doc?.services?.atproto_pds?.endpoint
          if (typeof svc === 'string') return String(svc)
          const arr = Array.isArray(doc?.service) ? doc.service : []
          const rec = arr.find((s: any) => s?.type === 'AtprotoPersonalDataServer')
          return String(rec?.serviceEndpoint || '')
        })().replace(/\/?$/, '')
      }
    } catch {}
  }
  if (!OLD) {
    console.error('ERROR: Could not infer --old from PLC doc; please pass --old https://current.host')
    process.exit(2)
  }
  if (!OLD_PASS) {
    try {
      OLD_PASS = await prompt(`Password for ${HANDLE} on OLD (${OLD})`, true)
    } catch (e) {
      console.error('No interactive input available. Pass --old-pass or set env OLD_PASS / UPDATE_PLC_OLD_PASS')
      process.exit(10)
    }
  }

  // Auth NEW
  console.log('[INFO] Auth NEW: createSession')
  const createNew = await httpJson('POST', `${NEW}/xrpc/com.atproto.server.createSession`, { body: { identifier: HANDLE, password: NEW_PASS } })
  if (!createNew.ok || !createNew.json?.accessJwt) {
    console.error('[ERROR] NEW createSession failed', createNew.status, createNew.json)
    process.exit(3)
  }
  const ACCESS_NEW = createNew.json.accessJwt as string

  // Auth OLD
  console.log('[INFO] Auth OLD: createSession')
  const createOld = await httpJson('POST', `${OLD}/xrpc/com.atproto.server.createSession`, { body: { identifier: HANDLE, password: OLD_PASS } })
  if (!createOld.ok || !createOld.json?.accessJwt) {
    console.error('[ERROR] OLD createSession failed', createOld.status, createOld.json)
    process.exit(4)
  }
  const ACCESS_OLD = createOld.json.accessJwt as string

  // NEW: get recommended credentials (requires REPO_SIGNING_KEY configured on NEW)
  console.log('[INFO] Fetch NEW recommended credentials')
  const credsRes = await httpJson('GET', `${NEW}/xrpc/com.atproto.identity.getRecommendedDidCredentials`, { headers: { authorization: `Bearer ${ACCESS_NEW}` } })
  if (!credsRes.ok || !credsRes.json?.verificationMethods?.atproto) {
    console.error('[ERROR] getRecommendedDidCredentials failed', credsRes.status, credsRes.json)
    console.error('HINT: Ensure REPO_SIGNING_KEY is set and deployed on NEW')
    process.exit(5)
  }
  const CREDS = credsRes.json
  console.log(`[INFO] Recommended atproto: ${CREDS.verificationMethods.atproto}`)

  // OLD: request token (email)
  if (!TOKEN) {
    console.log('[INFO] Requesting PLC token from OLD')
    const tokRes = await httpJson('POST', `${OLD}/xrpc/com.atproto.identity.requestPlcOperationSignature`, { headers: { authorization: `Bearer ${ACCESS_OLD}` } })
    if (!tokRes.ok) {
      console.warn('[WARN] requestPlcOperationSignature did not return 200', tokRes.status)
    }
    try {
      TOKEN = await prompt('Enter PLC token from email', false)
    } catch (e) {
      console.error('No interactive input available. Pass --token or set env PLC_TOKEN / UPDATE_PLC_TOKEN')
      process.exit(11)
    }
    if (!TOKEN) {
      console.error('[ERROR] No PLC token provided')
      process.exit(6)
    }
  }

  // OLD: sign operation with recommended payload
  console.log('[INFO] OLD signing PLC operation')
  const signRes = await httpJson('POST', `${OLD}/xrpc/com.atproto.identity.signPlcOperation`, {
    headers: { authorization: `Bearer ${ACCESS_OLD}` },
    body: {
      token: TOKEN,
      rotationKeys: CREDS.rotationKeys,
      alsoKnownAs: CREDS.alsoKnownAs,
      verificationMethods: CREDS.verificationMethods,
      services: CREDS.services,
    },
  })
  const OP = signRes.json?.operation
  if (!signRes.ok || !OP) {
    console.error('[ERROR] signPlcOperation failed', signRes.status, signRes.json)
    process.exit(7)
  }

  // NEW: submit op
  console.log('[INFO] Submitting PLC operation via NEW')
  const subRes = await httpJson('POST', `${NEW}/xrpc/com.atproto.identity.submitPlcOperation`, {
    headers: { authorization: `Bearer ${ACCESS_NEW}` },
    body: { operation: OP },
  })
  if (!subRes.ok) {
    console.warn('[WARN] NEW submitPlcOperation failed', subRes.status)
    // Fallback: submit directly to PLC directory using @did-plc/lib
    try {
      const mod = await import('@did-plc/lib')
      const client = new (mod as any).Client('https://plc.directory')
      await client.sendOperation(DID, OP)
      console.log('[SUCCESS] PLC operation submitted directly to plc.directory')
    } catch (e: any) {
      console.error('[ERROR] Direct PLC submit failed', e?.message || e)
      console.error('Response from NEW submit:', subRes.json)
      process.exit(8)
    }
  } else {
    console.log('[SUCCESS] PLC operation submitted')
  }

  // Verify PLC
  console.log('[INFO] Verifying PLC document...')
  const plc = await fetch(`https://plc.directory/${encodeURIComponent(DID)}`)
  const plcJson: any = await plc.json().catch(() => ({}))
  const keys: string[] = Array.isArray(plcJson.verificationMethod)
    ? plcJson.verificationMethod.map((v: any) => v?.publicKeyMultibase).filter((s: any) => typeof s === 'string')
    : []
  const endpoint = ((): string | null => {
    try {
      const svc = plcJson.services?.atproto_pds?.endpoint
      if (typeof svc === 'string') return svc
      const arr = Array.isArray(plcJson.service) ? plcJson.service : []
      const rec = arr.find((s: any) => s?.type === 'AtprotoPersonalDataServer')
      return typeof rec?.serviceEndpoint === 'string' ? rec.serviceEndpoint : null
    } catch { return null }
  })()
  console.log('[INFO] PLC publicKeyMultibase:', keys.join(', ') || '(none)')
  console.log('[INFO] PLC atproto_pds endpoint:', endpoint || '(none)')

  // Optional: relay crawl
  if (!NO_CRAWL) {
    const host = NEW.replace(/^https?:\/\//i, '')
    for (const r of RELAYS) {
      const url = `https://${r}/xrpc/com.atproto.sync.requestCrawl`
      try {
        const rr = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ hostname: host }) })
        console.log(`[INFO] requestCrawl ${r} -> ${rr.status}`)
      } catch (e: any) {
        console.warn(`[WARN] requestCrawl ${r} error`, e?.message)
      }
    }
  }

  console.log('\nDone. If the PLC doc shows the new key and endpoint, AppView should ingest new commits shortly.')
}

main().catch((e) => { console.error('[FATAL]', e?.stack || String(e)); process.exit(1) })
