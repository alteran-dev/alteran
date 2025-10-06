/*
 Starts the AppView dataplane repo subscription (firehose ingester)
 against a PDS or aggregator so your local AppView has data.
 Env vars:
  - SUBSCRIPTION_SERVICE (required)  e.g. http://localhost:2583
  - SUBSCRIPTION_DID_PLC_URL (default: http://localhost:2582)
  - DATAPLANE_DB_POSTGRES_URL (required) same DB as dataplane
  - DATAPLANE_DB_POSTGRES_SCHEMA (optional)
*/
/* eslint-env node */
'use strict'

const { RepoSubscription, Database } = require('@atproto/bsky')
const { IdResolver, MemoryCache } = require('@atproto/identity')

async function main() {
  const service = process.env.SUBSCRIPTION_SERVICE
  const plcUrl = process.env.SUBSCRIPTION_DID_PLC_URL || 'http://localhost:2582'
  const url = process.env.DATAPLANE_DB_POSTGRES_URL
  const schema = process.env.DATAPLANE_DB_POSTGRES_SCHEMA || undefined

  if (!service) {
    console.error('SUBSCRIPTION_SERVICE is required (your PDS base URL)')
    process.exit(1)
  }
  if (!url) {
    console.error('DATAPLANE_DB_POSTGRES_URL is required')
    process.exit(1)
  }

  const db = new Database({ url, schema, poolSize: 10 })
  await db.migrateToLatestOrThrow()

  const idResolver = new IdResolver({ plcUrl, didCache: new MemoryCache() })
  const sub = new RepoSubscription({ service, db, idResolver })
  sub.start()

  const shutdown = async () => {
    try {
      await sub.destroy()
      await db.close()
    } finally {
      process.exit(0)
    }
  }
  process.on('SIGINT', shutdown)
  process.on('SIGTERM', shutdown)

  console.log(`subscription connected to ${service}`)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})

