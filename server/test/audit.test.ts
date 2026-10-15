import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Db } from '../src/db.js';
import { clock } from '../src/clock.js';
import { audit, verifyChain } from '../src/audit/log.js';
import { freshDb, SID } from './helpers.js';

let db: Db;

beforeAll(async () => {
  db = await freshDb();
  for (let i = 0; i < 5; i++) await audit(db, { studentId: SID, kind: 'tool_call', data: { tool: 'get_overview', n: i } });
});
afterAll(async () => {
  await db.end();
  clock.set(null);
});

describe('audit log', () => {
  it('verifies an untouched chain', async () => {
    const c = await verifyChain(db);
    expect(c).toMatchObject({ ok: true, entries: 5 });
  });

  it('refuses UPDATE, DELETE and TRUNCATE', async () => {
    await expect(db.query(`UPDATE audit_log SET kind = 'x' WHERE seq = 1`)).rejects.toThrow(/append-only/);
    await expect(db.query('DELETE FROM audit_log WHERE seq = 1')).rejects.toThrow(/append-only/);
    await expect(db.query('TRUNCATE audit_log')).rejects.toThrow(/append-only/);
  });

  it('detects an edited entry even if the triggers are bypassed', async () => {
    // Simulate an attacker with database-owner rights.
    await db.query('ALTER TABLE audit_log DISABLE TRIGGER audit_log_no_update');
    await db.query(`UPDATE audit_log SET data = '{"tool":"propose_payment","n":2}' WHERE seq = 3`);
    const c = await verifyChain(db);
    expect(c.ok).toBe(false);
    expect(c.firstBrokenSeq).toBe(3);
    expect(c.problem).toMatch(/changed/);
  });

  it('detects a deleted entry', async () => {
    await db.query(`UPDATE audit_log SET data = '{"tool":"get_overview","n":2}' WHERE seq = 3`); // undo the edit
    expect((await verifyChain(db)).ok).toBe(true);
    await db.query('DELETE FROM audit_log WHERE seq = 4');
    const c = await verifyChain(db);
    expect(c.ok).toBe(false);
    expect(c.firstBrokenSeq).toBe(5);
    expect(c.problem).toMatch(/missing/);
    await db.query('ALTER TABLE audit_log ENABLE TRIGGER audit_log_no_update');
  });
});
