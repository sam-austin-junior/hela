import { randomUUID } from 'node:crypto';
import { withTx, type Db } from '../db.js';
import { clock } from '../clock.js';
import { appendAudit } from '../audit/log.js';
import type { PaymentAdapter } from '../payments/adapter.js';
import { proposePayment, type ProposalView } from './payments.js';
import { getAccounts, getPayee } from './data.js';

// Standing payment rules. The agent can only *propose* a schedule; it runs
// after the student approves it, and every run still goes through the
// policy engine like any other payment.

export async function createSchedule(
  db: Db,
  input: { studentId: string; payeeId: string; amountMinor: number; currency: string; intervalDays: number; firstDate: string; memo: string },
) {
  const payee = await getPayee(db, input.payeeId);
  if (!payee || payee.studentId !== input.studentId) throw new Error('The payee is not one of your saved payees.');
  if (!payee.approved) throw new Error('The payee is not on your approved list.');
  if (input.firstDate < clock.today()) throw new Error('The first payment date is in the past.');
  const source = (await getAccounts(db, input.studentId)).find((a) => a.currency === 'KES');
  if (!source) throw new Error('No KES account to pay from.');
  const id = `sch_${randomUUID().slice(0, 8)}`;
  await withTx(db, async (tx) => {
    await tx.query(
      `INSERT INTO scheduled_payments (id, student_id, payee_id, source_account_id, amount_minor, currency, memo, interval_days, next_run, status, created_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'pending_approval',$10)`,
      [id, input.studentId, input.payeeId, source.id, input.amountMinor, input.currency, input.memo, input.intervalDays, input.firstDate, clock.now()],
    );
    await appendAudit(tx, { studentId: input.studentId, kind: 'schedule_created', data: { scheduleId: id, ...input } });
  });
  return listSchedules(db, input.studentId).then((s) => s.find((x) => x.id === id)!);
}

export async function listSchedules(db: Db, studentId: string) {
  const r = await db.query(
    `SELECT s.*, p.name AS payee_name FROM scheduled_payments s JOIN payees p ON p.id = s.payee_id
      WHERE s.student_id = $1 ORDER BY s.created_at DESC`,
    [studentId],
  );
  return r.rows.map((s) => ({
    id: s.id as string,
    payee: { id: s.payee_id as string, name: s.payee_name as string },
    amountMinor: s.amount_minor as number,
    currency: s.currency as string,
    intervalDays: s.interval_days as number,
    nextRun: s.next_run as string,
    memo: s.memo as string,
    status: s.status as 'pending_approval' | 'active' | 'revoked',
  }));
}

export async function setScheduleStatus(db: Db, studentId: string, id: string, status: 'active' | 'revoked') {
  await withTx(db, async (tx) => {
    const from = status === 'active' ? ['pending_approval'] : ['pending_approval', 'active'];
    const r = await tx.query(
      'UPDATE scheduled_payments SET status = $3 WHERE id = $1 AND student_id = $2 AND status = ANY($4)',
      [id, studentId, status, from],
    );
    if (r.rowCount === 0) throw new Error('Schedule not found or already changed.');
    await appendAudit(tx, {
      studentId,
      kind: status === 'active' ? 'schedule_approved' : 'schedule_revoked',
      data: { scheduleId: id },
    });
  });
}

/** Run every active schedule that is due. Each run is its own proposal. */
export async function runDueSchedules(db: Db, adapter: PaymentAdapter, studentId?: string): Promise<ProposalView[]> {
  const today = clock.today();
  const due = (
    await db.query(
      `SELECT * FROM scheduled_payments WHERE status = 'active' AND next_run <= $1 AND ($2::text IS NULL OR student_id = $2)`,
      [today, studentId ?? null],
    )
  ).rows;
  const results: ProposalView[] = [];
  for (const s of due) {
    const view = await proposePayment(db, adapter, {
      studentId: s.student_id,
      origin: 'schedule',
      payeeId: s.payee_id,
      amountMinor: s.amount_minor,
      currency: s.currency,
      sourceAccountId: s.source_account_id,
      memo: s.memo,
      // One key per schedule per due date: a re-run of the same date cannot pay twice.
      idempotencyKey: `sched-${s.id}-${s.next_run}`,
    });
    results.push(view);
    await db.query(`UPDATE scheduled_payments SET next_run = next_run + $2::int WHERE id = $1`, [s.id, s.interval_days]);
  }
  return results;
}
