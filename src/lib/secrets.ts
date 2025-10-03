import type { Env } from '../env';
import type { SecretsStoreSecret } from '../../types/env';

const SECRET_KEYS = [
  'PDS_DID',
  'PDS_HANDLE',
  'USER_PASSWORD',
  'ACCESS_TOKEN_SECRET',
  'REFRESH_TOKEN_SECRET',
  'REPO_SIGNING_KEY',
  'REPO_SIGNING_PUBLIC_KEY',
  'JWT_ED25519_PRIVATE_KEY',
  'JWT_ED25519_PUBLIC_KEY',
] as const satisfies readonly (keyof Env)[];

function isSecretStoreBinding(value: unknown): value is SecretsStoreSecret {
  return !!value && typeof value === 'object' && typeof (value as any).get === 'function';
}

export async function resolveSecret(
  value: string | SecretsStoreSecret | undefined
): Promise<string | undefined> {
  if (value === undefined) return undefined;
  if (typeof value === 'string') return value;
  if (isSecretStoreBinding(value)) return value.get();
  return undefined;
}

/**
 * Return a shallow-cloned Env where all known secret fields are materialized to strings.
 * Non-secret bindings (DB, BLOBS, SEQUENCER, vars) are preserved as-is.
 */
export async function resolveEnvSecrets<E extends Env>(env: E): Promise<E> {
  const resolved: Record<string, unknown> = { ...env };

  await Promise.all(
    SECRET_KEYS.map(async (key) => {
      const val = await resolveSecret((env as any)[key]);
      if (val !== undefined) {
        resolved[key as string] = val;
      }
    })
  );

  return resolved as E;
}

