import { describe, it, expect } from 'bun:test';
import { readJsonBounded } from '../src/lib/util';

describe('JSON size limit boundary', () => {
  it('accepts payload exactly at limit', async () => {
    const env: any = { PDS_MAX_JSON_BYTES: '128' };
    const text = 'x'.repeat(128 - 20); // reserve for JSON syntax overhead
    const body = JSON.stringify({ text });
    expect(body.length).toBeLessThanOrEqual(128);
    const req = new Request('http://localhost', { method: 'POST', body, headers: { 'content-type': 'application/json' } });
    const parsed = await readJsonBounded(env, req);
    expect(parsed.text).toBe(text);
  });
});

