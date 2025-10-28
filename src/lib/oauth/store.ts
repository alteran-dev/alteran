import type { Env } from '../../env';
import { getSecret, setSecret } from '../../db/account';

const PAR_PREFIX = 'oauth:par:';
const CODE_PREFIX = 'oauth:code:';

export interface ParRecord {
  client_id: string;
  redirect_uri: string;
  code_challenge: string;
  code_challenge_method: 'S256';
  scope: string;
  state: string;
  login_hint?: string;
  dpopJkt: string;
  createdAt: number;
  expiresAt: number;
}

export interface CodeRecord {
  code: string;
  client_id: string;
  redirect_uri: string;
  code_challenge: string;
  scope: string;
  dpopJkt: string;
  did: string;
  createdAt: number;
  expiresAt: number;
  used?: boolean;
}

export async function savePar(env: Env, id: string, rec: ParRecord): Promise<void> {
  await setSecret(env, PAR_PREFIX + id, JSON.stringify(rec));
}

export async function loadPar(env: Env, id: string): Promise<ParRecord | null> {
  const raw = await getSecret(env, PAR_PREFIX + id);
  if (!raw) return null;
  try {
    const rec = JSON.parse(raw) as ParRecord;
    if (rec.expiresAt && rec.expiresAt < Math.floor(Date.now() / 1000)) return null;
    return rec;
  } catch {
    return null;
  }
}

export async function deletePar(env: Env, id: string): Promise<void> {
  // Overwrite with expired to minimize API surface
  await setSecret(env, PAR_PREFIX + id, JSON.stringify({}));
}

export async function saveCode(env: Env, code: string, rec: CodeRecord): Promise<void> {
  await setSecret(env, CODE_PREFIX + code, JSON.stringify(rec));
}

export async function loadCode(env: Env, code: string): Promise<CodeRecord | null> {
  const raw = await getSecret(env, CODE_PREFIX + code);
  if (!raw) return null;
  try {
    const rec = JSON.parse(raw) as CodeRecord;
    if (rec.expiresAt && rec.expiresAt < Math.floor(Date.now() / 1000)) return null;
    return rec;
  } catch {
    return null;
  }
}

export async function consumeCode(env: Env, code: string): Promise<CodeRecord | null> {
  const rec = await loadCode(env, code);
  if (!rec) return null;
  if (rec.used) return null;
  rec.used = true;
  await setSecret(env, CODE_PREFIX + code, JSON.stringify(rec));
  return rec;
}
