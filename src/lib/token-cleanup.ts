import type { Env } from '../env';
import { drizzle } from 'drizzle-orm/d1';
import { token_revocation } from '../db/schema';
import { lt } from 'drizzle-orm';

/**
 * Clean up expired tokens from the revocation table
 * This prevents the table from growing indefinitely
 */
export async function cleanupExpiredTokens(env: Env): Promise<number> {
  const db = drizzle(env.DB);
  const now = Math.floor(Date.now() / 1000);

  // Delete tokens where expiry is in the past
  const result = await db.delete(token_revocation)
    .where(lt(token_revocation.exp, now))
    .run();

  return result.meta.changes || 0;
}

/**
 * Lazy cleanup - only runs cleanup occasionally (1% of requests)
 * This spreads the cleanup load across requests
 */
export async function lazyCleanupExpiredTokens(env: Env): Promise<void> {
  // Only run cleanup 1% of the time to avoid overhead
  if (Math.random() > 0.01) return;

  try {
    const deleted = await cleanupExpiredTokens(env);
    if (deleted > 0) {
      console.log(`Cleaned up ${deleted} expired tokens`);
    }
  } catch (error) {
    console.error('Failed to cleanup expired tokens:', error);
  }
}