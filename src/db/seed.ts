import { drizzle } from 'drizzle-orm/d1';
import { repo_root } from './schema';

export async function seed(db: D1Database, did: string) {
  const d1 = drizzle(db);
  const rows = await d1.select().from(repo_root).all();
  if (rows.length === 0) {
    await d1.insert(repo_root).values({
      did,
      commitCid: 'bafyreih2y3p6t2i4y567q2z5q2z5q2z5q2z5q2z5q2z5q2z5q2z5q2z5q',
      rev: '0',
    });
  }
}
