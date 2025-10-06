import type { Env } from '../env';
import { getRecord } from '../db/dal';
import { buildProfileView, getPrimaryActor } from './actor';

export interface LabelerViewOptions {
  detailed?: boolean;
}

const LABELER_COLLECTION = 'app.bsky.labeler.service';
const LABELER_RKEY = 'self';

export async function getLabelerServiceViews(
  env: Env,
  dids: string[],
  options: LabelerViewOptions = {}
) {
  const detailed = options.detailed ?? false;
  const primaryActor = await getPrimaryActor(env);

  const unique = Array.from(new Set(dids.map((did) => did.trim()).filter(Boolean)));
  const views: any[] = [];

  for (const did of unique) {
    if (did !== primaryActor.did) continue; // Single-user PDS only has local labeler data

    const uri = `at://${did}/${LABELER_COLLECTION}/${LABELER_RKEY}`;
    const row = await getRecord(env, uri);
    if (!row || !row.json) continue;

    let record: any;
    try {
      record = JSON.parse(row.json);
    } catch {
      continue;
    }

    if (typeof record !== 'object' || record === null) continue;

    const indexedAt = typeof record.createdAt === 'string' ? record.createdAt : new Date().toISOString();
    const baseView: any = {
      uri,
      cid: row.cid,
      creator: buildProfileView(primaryActor),
      indexedAt,
      likeCount: 0,
      viewer: {},
    };

    if (detailed) {
      const policies = normalizePolicies(record.policies);
      views.push({
        ...baseView,
        policies,
        reasonTypes: Array.isArray(record.reasonTypes) ? record.reasonTypes : undefined,
        subjectTypes: Array.isArray(record.subjectTypes) ? record.subjectTypes : undefined,
        subjectCollections: Array.isArray(record.subjectCollections) ? record.subjectCollections : undefined,
        labels: extractLabels(record.labels),
      });
    } else {
      const labels = extractLabels(record.labels);
      if (labels) baseView.labels = labels;
      views.push(baseView);
    }
  }

  return views;
}

function normalizePolicies(input: any) {
  if (input && typeof input === 'object') {
    const labelValues = Array.isArray(input.labelValues) ? input.labelValues : [];
    const labelValueDefinitions = Array.isArray(input.labelValueDefinitions)
      ? input.labelValueDefinitions
      : undefined;
    return {
      labelValues,
      labelValueDefinitions,
    };
  }

  return {
    labelValues: [],
  };
}

function extractLabels(input: any) {
  if (!input) return undefined;
  if (Array.isArray(input)) return input.length ? input : undefined;
  if (typeof input === 'object') return input;
  return undefined;
}
