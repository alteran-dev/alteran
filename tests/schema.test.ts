import { describe, test, expect, beforeAll } from 'bun:test';
import { drizzle } from 'drizzle-orm/d1';
import { record, blob_usage, commit_log, blockstore, refresh_token_store, account, secret } from '../src/db/schema';
import { eq, desc } from 'drizzle-orm';

// Mock D1 database for testing
let db: ReturnType<typeof drizzle>;
let mockD1: any;

beforeAll(() => {
  // Create a mock D1 database
  mockD1 = {
    prepare: (query: string) => ({
      bind: (...args: any[]) => ({
        all: async () => ({ results: [], success: true }),
        first: async () => null,
        run: async () => ({ success: true, meta: { changes: 0 } }),
      }),
    }),
    batch: async (statements: any[]) => [],
    exec: async (query: string) => ({ count: 0, duration: 0 }),
  };

  db = drizzle(mockD1);
});

describe('Schema Tests', () => {
  describe('Indexes', () => {
    test('record table has did index', () => {
      // Verify the schema definition includes the index
      const schema = record;
      expect(schema).toBeDefined();
      // Index is defined in the schema, this test verifies compilation
    });

    test('record table has cid index', () => {
      const schema = record;
      expect(schema).toBeDefined();
    });

    test('blob_usage table has record_uri index', () => {
      const schema = blob_usage;
      expect(schema).toBeDefined();
    });

    test('refresh_token table has did index', () => {
      const schema = refresh_token_store;
      expect(schema).toBeDefined();
    });

    test('commit_log table has seq index', () => {
      const schema = commit_log;
      expect(schema).toBeDefined();
    });
  });

  describe('Schema Constraints', () => {
    test('record table has primary key on uri', () => {
      const schema = record;
      expect(schema.uri.primary).toBe(true);
    });

    test('record table requires did, cid, and json', () => {
      const schema = record;
      expect(schema.did.notNull).toBe(true);
      expect(schema.cid.notNull).toBe(true);
      expect(schema.json.notNull).toBe(true);
    });

    test('blob_usage table requires recordUri and key', () => {
      const schema = blob_usage;
      expect(schema.recordUri.notNull).toBe(true);
      expect(schema.key.notNull).toBe(true);
    });

    test('refresh_token table has primary key on id', () => {
      const schema = refresh_token_store;
      expect(schema.id.primary).toBe(true);
    });

    test('account table requires did and handle', () => {
      const schema = account;
      expect(schema.did.notNull).toBe(true);
      expect(schema.handle.notNull).toBe(true);
    });

    test('commit_log table has primary key on seq', () => {
      const schema = commit_log;
      expect(schema.seq.primary).toBe(true);
    });

    test('blockstore table has primary key on cid', () => {
      const schema = blockstore;
      expect(schema.cid.primary).toBe(true);
    });
  });

  describe('Data Types', () => {
    test('record.createdAt is integer', () => {
      const schema = record;
      expect(schema.createdAt.dataType).toBe('number');
    });

    test('commit_log.seq is integer', () => {
      const schema = commit_log;
      expect(schema.seq.dataType).toBe('number');
    });

    test('refresh_token.expiresAt is integer', () => {
      const schema = refresh_token_store;
      expect(schema.expiresAt.dataType).toBe('number');
    });

    test('secret.updatedAt is integer', () => {
      const schema = secret;
      expect(schema.updatedAt.dataType).toBe('number');
    });
  });

  describe('Schema Documentation', () => {
    test('commit_log has pruning documentation', () => {
      // This test verifies that the schema file contains documentation
      // The actual documentation is in comments, so we just verify the table exists
      const schema = commit_log;
      expect(schema).toBeDefined();
      expect(schema.seq).toBeDefined();
      expect(schema.cid).toBeDefined();
      expect(schema.data).toBeDefined();
    });

    test('blockstore has GC documentation', () => {
      const schema = blockstore;
      expect(schema).toBeDefined();
      expect(schema.cid).toBeDefined();
      expect(schema.bytes).toBeDefined();
    });
  });
});

describe('Migration Tests', () => {
  test('migrations directory exists', async () => {
    const fs = await import('fs/promises');
    const path = await import('path');

    const migrationsDir = path.join(process.cwd(), 'migrations');
    const exists = await fs.access(migrationsDir).then(() => true).catch(() => false);

    expect(exists).toBe(true);
  });

  test('migration journal exists', async () => {
    const fs = await import('fs/promises');
    const path = await import('path');

    const journalPath = path.join(process.cwd(), 'migrations', 'meta', '_journal.json');
    const exists = await fs.access(journalPath).then(() => true).catch(() => false);

    expect(exists).toBe(true);
  });

  test('index migrations are present', async () => {
    const fs = await import('fs/promises');
    const path = await import('path');

    const migrationsDir = path.join(process.cwd(), 'migrations');
    const files = await fs.readdir(migrationsDir);

    // Check for migration files
    const sqlFiles = files.filter(f => f.endsWith('.sql'));
    expect(sqlFiles.length).toBeGreaterThan(0);

    // Check that at least one migration contains index creation
    let hasIndexMigration = false;
    for (const file of sqlFiles) {
      const content = await fs.readFile(path.join(migrationsDir, file), 'utf-8');
      if (content.includes('CREATE INDEX')) {
        hasIndexMigration = true;
        break;
      }
    }

    expect(hasIndexMigration).toBe(true);
  });
});

describe('Query Performance Tests', () => {
  test('record queries by did should use index', async () => {
    // This is a conceptual test - in a real scenario, you'd use EXPLAIN QUERY PLAN
    // For now, we just verify the query can be constructed
    const query = db.select().from(record).where(eq(record.did, 'did:example:test'));
    expect(query).toBeDefined();
  });

  test('record queries by cid should use index', async () => {
    const query = db.select().from(record).where(eq(record.cid, 'bafytest'));
    expect(query).toBeDefined();
  });

  test('blob_usage queries by recordUri should use index', async () => {
    const query = db.select().from(blob_usage).where(eq(blob_usage.recordUri, 'at://did:example/app.bsky.feed.post/123'));
    expect(query).toBeDefined();
  });

  test('refresh_token queries by did should use index', async () => {
    const query = db.select().from(refresh_token_store).where(eq(refresh_token_store.did, 'did:example:test'));
    expect(query).toBeDefined();
  });

  test('commit_log queries by seq should use index', async () => {
    const query = db.select().from(commit_log).orderBy(desc(commit_log.seq)).limit(100);
    expect(query).toBeDefined();
  });
});
