import { getDb } from '../db/client';
import { record } from '../db/schema';
import { resolveSecret } from './secrets';
import type { Env } from '../env';
import { eq } from 'drizzle-orm';

interface ProfileRecord {
  displayName?: string;
  description?: string;
  pronouns?: string;
  website?: string;
  avatar?: string;
  banner?: string;
  joinedViaStarterPack?: any;
  pinnedPost?: any;
  labels?: any;
  createdAt?: string;
}

export interface PrimaryActor {
  did: string;
  handle: string;
  displayName?: string;
  description?: string;
  pronouns?: string;
  website?: string;
  avatar?: string;
  banner?: string;
  labels?: any;
  createdAt?: string;
}

const PROFILE_COLLECTION = 'app.bsky.actor.profile';

export async function fetchProfileRecord(env: Env, did: string): Promise<ProfileRecord | null> {
  const db = getDb(env);

  const targetUri = `at://${did}/${PROFILE_COLLECTION}/self`;
  const byDid = await db.select().from(record).where(eq(record.uri, targetUri)).get();
  if (byDid?.json) {
    try {
      return JSON.parse(byDid.json) as ProfileRecord;
    } catch {
      return null;
    }
  }

  // Fallback: pick the most recent profile record regardless of DID
  const fallback = await env.DB.prepare(
    'SELECT json FROM record WHERE uri LIKE ? ORDER BY rowid DESC LIMIT 1'
  )
    .bind(`%/${PROFILE_COLLECTION}/%`)
    .first<{ json: string }>();

  if (fallback?.json) {
    try {
      return JSON.parse(fallback.json) as ProfileRecord;
    } catch {
      return null;
    }
  }

  return null;
}

export async function getPrimaryActor(env: Env): Promise<PrimaryActor> {
  const did = (await resolveSecret(env.PDS_DID)) ?? 'did:example:single-user';
  const handle = (await resolveSecret(env.PDS_HANDLE)) ?? 'user.example.com';

  const profile = await fetchProfileRecord(env, did);

  return {
    did,
    handle,
    displayName: profile?.displayName ?? handle,
    description: profile?.description,
    pronouns: profile?.pronouns,
    website: profile?.website,
    avatar: profile?.avatar,
    banner: profile?.banner,
    labels: profile?.labels,
    createdAt: profile?.createdAt,
  };
}

export function matchesPrimaryActor(identifier: string | null | undefined, actor: PrimaryActor): boolean {
  if (!identifier) return false;
  const lower = identifier.toLowerCase();
  return lower === actor.did.toLowerCase() || lower === actor.handle.toLowerCase();
}

export function buildProfileViewBasic(actor: PrimaryActor) {
  const createdAt = actor.createdAt ?? new Date().toISOString();
  const labels = Array.isArray(actor.labels) ? actor.labels : [];
  return {
    $type: 'app.bsky.actor.defs#profileViewBasic',
    did: actor.did,
    handle: actor.handle,
    displayName: actor.displayName,
    pronouns: actor.pronouns,
    avatar: actor.avatar,
    createdAt,
    associated: {
      $type: 'app.bsky.actor.defs#profileAssociated',
      lists: 0,
      feedgens: 0,
      starterPacks: 0,
      labeler: false,
      chat: {
        $type: 'app.bsky.actor.defs#profileAssociatedChat',
        allowIncoming: 'all',
      },
      activitySubscription: {
        $type: 'app.bsky.actor.defs#profileAssociatedActivitySubscription',
        allowSubscriptions: 'followers',
      },
    },
    labels,
  };
}

export function buildProfileView(actor: PrimaryActor) {
  const basic = buildProfileViewBasic(actor);
  return {
    ...basic,
    $type: 'app.bsky.actor.defs#profileView',
    description: actor.description,
    indexedAt: actor.createdAt ?? new Date().toISOString(),
  };
}

export function buildProfileViewDetailed(actor: PrimaryActor, counts: {
  followers: number;
  follows: number;
  posts: number;
}) {
  const view = buildProfileView(actor);
  return {
    ...view,
    $type: 'app.bsky.actor.defs#profileViewDetailed',
    banner: actor.banner,
    website: actor.website,
    followersCount: counts.followers,
    followsCount: counts.follows,
    postsCount: counts.posts,
    viewer: {},
  };
}
