/*
 Simple runner for the Bluesky AppView dataplane server in local dev.
 Env vars:
  - DATAPLANE_DB_POSTGRES_URL (required)
  - DATAPLANE_DB_POSTGRES_SCHEMA (optional)
  - DATAPLANE_PORT (default: 2590)
  - DATAPLANE_DID_PLC_URL (default: http://localhost:2582)
*/
/* eslint-env node */
'use strict'

const { DataPlaneServer, Database } = require('@atproto/bsky')

async function main() {
  const port = parseInt(process.env.DATAPLANE_PORT || '2590', 10)
  const plcUrl = process.env.DATAPLANE_DID_PLC_URL || 'http://localhost:2582'
  const url = process.env.DATAPLANE_DB_POSTGRES_URL
  const schema = process.env.DATAPLANE_DB_POSTGRES_SCHEMA || undefined

  if (!url) {
    console.error('DATAPLANE_DB_POSTGRES_URL is required')
    process.exit(1)
  }

  const db = new Database({ url, schema, poolSize: 10 })
  await db.migrateToLatestOrThrow()

  const server = await DataPlaneServer.create(db, port, plcUrl)

  const shutdown = async () => {
    try {
      await server.destroy()
      await db.close()
    } finally {
      process.exit(0)
    }
  }
  process.on('SIGINT', shutdown)
  process.on('SIGTERM', shutdown)

  console.log(`dataplane listening on http://localhost:${port}`)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})

