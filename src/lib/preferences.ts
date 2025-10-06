import type { Env } from '../env';
import { resolveSecret } from './secrets';

let tableEnsured = false;

async function ensureTable(env: Env) {
  if (tableEnsured) return;
  await env.DB.exec(
    'CREATE TABLE IF NOT EXISTS actor_preferences (did TEXT PRIMARY KEY, json TEXT NOT NULL, updated_at INTEGER NOT NULL)'
  );
  tableEnsured = true;
}

const DEFAULT_PREFERENCES = [
  {
    $type: 'app.bsky.actor.defs#savedFeedsPrefV2',
    items: [],
  },
  {
    $type: 'app.bsky.actor.defs#feedViewPref',
    feed: 'home',
    hideReplies: false,
    hideRepliesByUnfollowed: false,
    hideRepliesByLikeCount: 0,
    hideReposts: false,
    hideQuotePosts: false,
  },
  {
    $type: 'app.bsky.actor.defs#threadViewPref',
    sort: 'oldest',
    prioritizeFollowedUsers: true,
  },
  {
    $type: 'app.bsky.actor.defs#labelersPref',
    labelers: [
      {
        did: 'did:plc:ar7c4by46qjdydhdevvrndac',
      },
    ],
  },
];

export async function getActorPreferences(env: Env): Promise<{ did: string; preferences: any[] }> {
  await ensureTable(env);
  const did = (await resolveSecret(env.PDS_DID)) ?? 'did:example:single-user';
  const row = await env.DB.prepare('SELECT json FROM actor_preferences WHERE did = ?')
    .bind(did)
    .first<{ json: string }>();

  if (!row?.json) {
    return { did, preferences: DEFAULT_PREFERENCES };
  }

  try {
    const parsed = JSON.parse(row.json);
    const preferences = Array.isArray(parsed) ? parsed : [];
    // If preferences exist but are empty, return defaults
    return { did, preferences: preferences.length > 0 ? preferences : DEFAULT_PREFERENCES };
  } catch {
    return { did, preferences: DEFAULT_PREFERENCES };
  }
}

export async function setActorPreferences(env: Env, preferences: any[]): Promise<void> {
  await ensureTable(env);
  const did = (await resolveSecret(env.PDS_DID)) ?? 'did:example:single-user';
  const now = Date.now();
  await env.DB.prepare(
    'INSERT INTO actor_preferences (did, json, updated_at) VALUES (?, ?, ?) ON CONFLICT(did) DO UPDATE SET json = excluded.json, updated_at = excluded.updated_at'
  )
    .bind(did, JSON.stringify(preferences ?? []), now)
    .run();
}
