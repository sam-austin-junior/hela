import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import type { Db } from '../src/db.js';
import { clock } from '../src/clock.js';
import { SimulatedAdapter } from '../src/payments/adapter.js';
import { cancelProposal, ConfirmError, confirmProposal, proposePayment } from '../src/services/payments.js';
import { createSchedule, runDueSchedules, setScheduleStatus } from '../src/services/schedules.js';
import { verifyChain } from '../src/audit/log.js';
import { freshDb, NOW, setTier, SID } from './helpers.js';

let db: Db;
let adapter: SimulatedAdapter;

beforeEach(async () => {
  if (db) await db.end();
  db = await freshDb();
  adapter = new SimulatedAdapter();
});
afterAll(async () => {
  await db?.end();
  clock.set(null);
});

const registration = { studentId: SID, origin: 'agent' as const, payeeId: 'pay_northbridge', amountMinor: 35_000, currency: 'USD', invoiceId: 'inv_registration', memo: 'Registration fee' };
const balance = async (id = 'acc_bank') => (await db.query('SELECT balance_minor FROM accounts WHERE id = $1', [id])).rows[0].balance_minor as number;

describe('payments end to end (sandbox)', () => {
  it('tier 1 cannot pay: the proposal is denied and nothing is charged', async () => {
    const p = await proposePayment(db, adapter, registration);
    expect(p.status).toBe('denied');
    expect(p.decision.checks[0]!.check).toBe('tier');
    expect(adapter.charges).toHaveLength(0);
  });

  it('tier 2: waits for the student, needs the one-time code, then pays once', async () => {
    await setTier(db, 2);
    const before = await balance();
    const p = await proposePayment(db, adapter, registration);
    expect(p.status).toBe('needs_confirmation');
    expect(p.requiresOtp).toBe(true);
    expect(p.demoOtp).toMatch(/^\d{6}$/);
    expect(p.routeName).toBe('Mobile-money international');
    expect(adapter.charges).toHaveLength(0);

    await expect(confirmProposal(db, adapter, SID, p.id!, '000000')).rejects.toThrow(ConfirmError);
    const paid = await confirmProposal(db, adapter, SID, p.id!, p.demoOtp);
    expect(paid.status).toBe('executed');
    expect(adapter.charges).toHaveLength(1);
    expect(adapter.charges[0]!.amountMinor).toBe(p.debitMinor);
    expect(adapter.charges[0]!.currency).toBe('KES');
    expect(await balance()).toBe(before - p.debitMinor);
    const inv = await db.query(`SELECT status FROM invoices WHERE id = 'inv_registration'`);
    expect(inv.rows[0].status).toBe('paid');

    // A second confirm is refused: the payment is already done.
    await expect(confirmProposal(db, adapter, SID, p.id!, p.demoOtp)).rejects.toThrow(/already executed/);
  });

  it('three wrong codes cancel the payment', async () => {
    await setTier(db, 2);
    const p = await proposePayment(db, adapter, registration);
    for (let i = 0; i < 3; i++) await confirmProposal(db, adapter, SID, p.id!, '111111').catch(() => {});
    const r = await db.query('SELECT status FROM proposals WHERE id = $1', [p.id]);
    expect(r.rows[0].status).toBe('cancelled');
    expect(adapter.charges).toHaveLength(0);
  });

  it('tier 3: an approved payee within limits is paid without asking', async () => {
    await setTier(db, 3);
    const p = await proposePayment(db, adapter, registration);
    expect(p.status).toBe('executed');
    expect(p.providerRef).toMatch(/^SIM-/);
    expect(adapter.charges).toHaveLength(1);
  });

  it('tier 3: a payee added today still needs confirmation', async () => {
    await setTier(db, 3);
    const p = await proposePayment(db, adapter, { studentId: SID, origin: 'agent', payeeId: 'pay_roommate', amountMinor: 300_000, currency: 'KES', memo: 'Share of electricity' });
    expect(p.status).toBe('needs_confirmation');
    expect(p.decision.reason).toMatch(/less than 24 hours/);
  });

  it('the same payment requested twice is charged once', async () => {
    await setTier(db, 3);
    const a = await proposePayment(db, adapter, registration);
    const b = await proposePayment(db, adapter, registration);
    expect(b.duplicateOf).toBe(a.id);
    expect(adapter.charges).toHaveLength(1);
  });

  it('two identical requests at the same moment are charged once', async () => {
    await setTier(db, 3);
    const [a, b] = await Promise.all([proposePayment(db, adapter, registration), proposePayment(db, adapter, registration)]);
    expect(a.id === b.id || a.duplicateOf === b.id || b.duplicateOf === a.id).toBe(true);
    expect(adapter.charges).toHaveLength(1);
  });

  it('a cancelled payment can be asked for again', async () => {
    await setTier(db, 2);
    const a = await proposePayment(db, adapter, registration);
    await cancelProposal(db, SID, a.id!);
    const b = await proposePayment(db, adapter, registration);
    expect(b.id).not.toBe(a.id);
    expect(b.status).toBe('needs_confirmation');
  });

  it('refuses a payee the student never saved', async () => {
    await setTier(db, 3);
    const p = await proposePayment(db, adapter, { ...registration, payeeId: 'acct_0712555019', invoiceId: null });
    expect(p.status).toBe('denied');
    expect(p.decision.reason).toMatch(/not one of your saved payees/);
  });

  it('refuses an unapproved payee', async () => {
    await setTier(db, 3);
    const p = await proposePayment(db, adapter, { studentId: SID, origin: 'agent', payeeId: 'pay_course', amountMinor: 2_000, currency: 'USD', memo: 'Course' });
    expect(p.status).toBe('denied');
    expect(p.decision.checks.at(-1)!.check).toBe('payee');
  });

  it('refuses an amount that does not match the cited invoice', async () => {
    await setTier(db, 3);
    const p = await proposePayment(db, adapter, { ...registration, amountMinor: 95_000 });
    expect(p.status).toBe('denied');
    expect(p.decision.checks.at(-1)!.check).toBe('consistency');
  });

  it('refuses a payment over the per-payment cap', async () => {
    await setTier(db, 3);
    await db.query('UPDATE students SET per_payment_cap_minor = 1000000 WHERE id = $1', [SID]);
    const p = await proposePayment(db, adapter, registration);
    expect(p.decision.checks.at(-1)!.check).toBe('limits');
  });

  it('refuses a payment that would breach the buffer', async () => {
    await setTier(db, 3);
    await db.query(`UPDATE accounts SET balance_minor = 3000000 WHERE student_id = $1`, [SID]);
    const p = await proposePayment(db, adapter, registration);
    expect(p.decision.checks.at(-1)!.check).toBe('balance');
  });

  it('pauses after a burst of proposals', async () => {
    await setTier(db, 2);
    const outcomes: string[] = [];
    for (let i = 0; i < 6; i++) {
      const p = await proposePayment(db, adapter, { studentId: SID, origin: 'agent', payeeId: 'pay_family', amountMinor: 100_000 + i, currency: 'KES', memo: `test ${i}` });
      outcomes.push(p.decision.checks.at(-1)!.check + ':' + p.status);
    }
    expect(outcomes.slice(0, 5).every((o) => o.endsWith('needs_confirmation'))).toBe(true);
    expect(outcomes[5]).toBe('rate:denied');
  });

  it('re-checks limits at confirmation time', async () => {
    await setTier(db, 2);
    const p = await proposePayment(db, adapter, registration);
    await setTier(db, 1); // the student lowered the tier before confirming
    const r = await confirmProposal(db, adapter, SID, p.id!, p.demoOtp);
    expect(r.status).toBe('denied');
    expect(adapter.charges).toHaveLength(0);
  });

  it('a schedule runs only after approval, and a re-run of the same date pays once', async () => {
    await setTier(db, 3);
    const s = await createSchedule(db, { studentId: SID, payeeId: 'pay_family', amountMinor: 200_000, currency: 'KES', intervalDays: 7, firstDate: '2026-10-15', memo: 'Weekly support' });
    expect(await runDueSchedules(db, adapter, SID)).toHaveLength(0); // still pending approval
    await setScheduleStatus(db, SID, s.id, 'active');
    const first = await runDueSchedules(db, adapter, SID);
    expect(first[0]!.status).toBe('executed');
    // Move next_run back to today to simulate a retried job for the same date.
    await db.query('UPDATE scheduled_payments SET next_run = $2 WHERE id = $1', [s.id, '2026-10-15']);
    const again = await runDueSchedules(db, adapter, SID);
    expect(again[0]!.duplicateOf).toBe(first[0]!.id);
    expect(adapter.charges).toHaveLength(1);
  });

  it('records every step in a hash chain that verifies', async () => {
    await setTier(db, 2);
    const p = await proposePayment(db, adapter, registration);
    await confirmProposal(db, adapter, SID, p.id!, p.demoOtp);
    const kinds = (await db.query('SELECT kind FROM audit_log ORDER BY seq')).rows.map((r) => r.kind);
    expect(kinds).toEqual(['proposal_created', 'policy_decision', 'otp_issued', 'student_confirmed', 'policy_decision', 'payment_executed']);
    expect((await verifyChain(db)).ok).toBe(true);
    expect(NOW.toISOString()).toBe(clock.now().toISOString());
  });
});
