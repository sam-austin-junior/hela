import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { Db } from '../src/db.js';
import { clock } from '../src/clock.js';
import { buildApp } from '../src/app.js';
import { SimulatedAdapter } from '../src/payments/adapter.js';
import { DEMO_PIN } from '../src/scripts/seed-data.js';
import { proposePayment } from '../src/services/payments.js';
import { freshDb, setTier, SID } from './helpers.js';

let db: Db;
let app: FastifyInstance;
let adapter: SimulatedAdapter;

beforeEach(async () => {
  if (db) await db.end();
  db = await freshDb();
  adapter = new SimulatedAdapter();
  app = buildApp({ db, adapter, model: null });
});
afterAll(async () => {
  await db?.end();
  clock.set(null);
});

const limits = { perPaymentMinor: 80_000_000, dailyMinor: 90_000_000, monthlyMinor: 120_000_000, minBufferMinor: 500_000, otpThresholdMinor: 1_000_000 };
const post = (url: string, payload: unknown = {}) => app.inject({ method: 'POST', url, payload: payload as object });
const auditKinds = async () => (await db.query('SELECT kind FROM audit_log ORDER BY seq')).rows.map((r) => r.kind);

describe('student controls over the API', () => {
  it('tightening a limit needs no PIN', async () => {
    const r = await post('/api/limits', { ...limits, perPaymentMinor: 1_000_000 });
    expect(r.statusCode).toBe(200);
    expect(r.json().loosened).toBe(false);
    expect(await auditKinds()).toContain('limits_changed');
  });

  it('loosening a limit needs the PIN', async () => {
    const without = await post('/api/limits', { ...limits, dailyMinor: 100_000_000, monthlyMinor: 150_000_000 });
    expect(without.statusCode).toBe(403);
    const lowerBuffer = await post('/api/limits', { ...limits, minBufferMinor: 0 });
    expect(lowerBuffer.statusCode).toBe(403);
    const ok = await post('/api/limits', { ...limits, dailyMinor: 100_000_000, monthlyMinor: 150_000_000, pin: DEMO_PIN });
    expect(ok.statusCode).toBe(200);
    expect(ok.json().loosened).toBe(true);
  });

  it('refuses caps that contradict each other', async () => {
    const r = await post('/api/limits', { ...limits, perPaymentMinor: 95_000_000 });
    expect(r.statusCode).toBe(400);
  });

  it('a tightened cap applies to the very next payment', async () => {
    await setTier(db, 3);
    await post('/api/limits', { ...limits, perPaymentMinor: 1_000_000 });
    const p = await proposePayment(db, adapter, { studentId: SID, origin: 'agent', payeeId: 'pay_family', amountMinor: 2_000_000, currency: 'KES', memo: '' });
    expect(p.status).toBe('denied');
    expect(p.decision.checks.at(-1)!.check).toBe('limits');
  });

  it('raising the tier needs the PIN; lowering does not', async () => {
    expect((await post('/api/tier', { tier: 3 })).statusCode).toBe(403);
    expect((await post('/api/tier', { tier: 3, pin: '0000' })).statusCode).toBe(403);
    expect((await post('/api/tier', { tier: 3, pin: DEMO_PIN })).statusCode).toBe(200);
    expect((await post('/api/tier', { tier: 0 })).statusCode).toBe(200);
    const s = await db.query('SELECT tier FROM students WHERE id = $1', [SID]);
    expect(s.rows[0].tier).toBe(0);
  });

  it('locks PIN-protected actions after five wrong PINs, then unlocks after 15 minutes', async () => {
    for (let i = 0; i < 5; i++) expect((await post('/api/tier', { tier: 3, pin: '1111' })).statusCode).toBe(403);
    // Even the right PIN is refused while locked.
    expect((await post('/api/tier', { tier: 3, pin: DEMO_PIN })).statusCode).toBe(429);
    clock.set(new Date(clock.now().getTime() + 16 * 60_000));
    expect((await post('/api/tier', { tier: 3, pin: DEMO_PIN })).statusCode).toBe(200);
  });

  it('a new payee starts unapproved and cannot be paid until approved with the PIN', async () => {
    await setTier(db, 3);
    const r = await post('/api/payees', { name: 'Landlord Ltd', kind: 'merchant', country: 'ke', currency: 'KES' });
    expect(r.statusCode).toBe(200);
    const { id } = r.json();
    const before = await proposePayment(db, adapter, { studentId: SID, origin: 'agent', payeeId: id, amountMinor: 100_000, currency: 'KES', memo: '' });
    expect(before.status).toBe('denied');
    expect((await post(`/api/payees/${id}/approve`, { pin: '9999' })).statusCode).toBe(403);
    expect((await post(`/api/payees/${id}/approve`, { pin: DEMO_PIN })).statusCode).toBe(200);
    // Approved, but added today: even tier 3 asks the student.
    const after = await proposePayment(db, adapter, { studentId: SID, origin: 'agent', payeeId: id, amountMinor: 100_001, currency: 'KES', memo: '' });
    expect(after.status).toBe('needs_confirmation');
    expect(await auditKinds()).toEqual(expect.arrayContaining(['payee_added', 'payee_approved']));
  });

  it('confirms a payment through the API with the code', async () => {
    await setTier(db, 2);
    const p = await proposePayment(db, adapter, { studentId: SID, origin: 'agent', payeeId: 'pay_family', amountMinor: 1_500_000, currency: 'KES', memo: '' });
    expect((await post(`/api/proposals/${p.id}/confirm`, { otp: '000000' })).statusCode).toBe(409);
    const ok = await post(`/api/proposals/${p.id}/confirm`, { otp: p.demoOtp });
    expect(ok.json().status).toBe('executed');
    expect((await post(`/api/proposals/${p.id}/cancel`)).statusCode).toBe(409);
  });
});

describe('data and categories', () => {
  it('exports the student\'s data without the PIN hash, and logs the export', async () => {
    const r = await app.inject({ method: 'GET', url: '/api/export' });
    expect(r.statusCode).toBe(200);
    expect(r.headers['content-disposition']).toMatch(/attachment/);
    const body = r.json();
    expect(body.transactions.length).toBeGreaterThan(100);
    expect(JSON.stringify(body)).not.toMatch(/pin_?hash/i);
    expect(await auditKinds()).toContain('data_exported');
  });

  it('a correction becomes a rule for that payee', async () => {
    await db.query(
      `INSERT INTO transactions (id, student_id, account_id, occurred_at, amount_minor, currency, payee, description)
       VALUES ('tx_extra', $1, 'acc_card', now(), -50000, 'KES', 'POS 4471 KISUMU', 'Card purchase')`,
      [SID],
    );
    const t = (await db.query(`SELECT id FROM transactions WHERE payee = 'POS 4471 KISUMU' AND id <> 'tx_extra'`)).rows[0];
    const r = await post(`/api/transactions/${t.id}/category`, { category: 'groceries' });
    expect(r.statusCode).toBe(200);
    const after = await db.query(`SELECT category, category_source FROM transactions WHERE id = 'tx_extra'`);
    expect(after.rows[0]).toEqual({ category: 'groceries', category_source: 'rule' });
  });

  it('rejects a category outside the fixed list', async () => {
    const t = (await db.query('SELECT id FROM transactions LIMIT 1')).rows[0];
    expect((await post(`/api/transactions/${t.id}/category`, { category: 'crypto' })).statusCode).toBe(400);
  });

  it('chat answers 503 when no model is configured, and the panels still work', async () => {
    expect((await post('/api/chat', { message: 'hi' })).statusCode).toBe(503);
    expect((await app.inject({ method: 'GET', url: '/api/state' })).statusCode).toBe(200);
    expect((await post('/api/invoices/inv_spring/plan')).json().status).toBe('at_risk');
    expect((await post('/api/routes/compare', { amount: '350', currency: 'USD' })).json().ranked[0].route.routeName).toBe('Mobile-money international');
  });
});
