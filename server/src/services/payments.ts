import { createHash, randomInt, randomUUID, timingSafeEqual } from 'node:crypto';
import { withTx, type Db, type Queryable } from '../db.js';
import { clock } from '../clock.js';
import { appendAudit } from '../audit/log.js';
import { evaluate, RATE_WINDOW_MINUTES, type Decision, type PolicyContext, type ProposalFacts } from '../policy/engine.js';
import { compareRoutes, quoteReceive } from '../domain/remittance.js';
import { rateOn } from '../domain/fx.js';
import type { PaymentAdapter } from '../payments/adapter.js';
import {
  getAccounts,
  getDocuments,
  getInvoice,
  getPayee,
  getRateSeries,
  getRecentProposalCount,
  getRoutes,
  getSpent,
  getStudent,
  type Student,
} from './data.js';

export interface ProposalRequest {
  studentId: string;
  origin: 'agent' | 'schedule';
  payeeId: string;
  amountMinor: number;
  currency: string;
  invoiceId?: string | null;
  routeId?: string | null;
  sourceAccountId?: string | null;
  memo?: string;
  /** Supplied for scheduled runs; derived from the payment's content otherwise. */
  idempotencyKey?: string;
}

export interface ProposalView {
  id: string | null;
  status: 'needs_confirmation' | 'denied' | 'executing' | 'executed' | 'failed' | 'cancelled';
  payee: { id: string; name: string } | null;
  amountMinor: number;
  currency: string;
  debitMinor: number;
  debitCurrency: string;
  feeMinor: number;
  fxRate: number | null;
  routeName: string | null;
  invoiceId: string | null;
  memo: string;
  decision: Decision;
  requiresOtp: boolean;
  providerRef: string | null;
  failureReason: string | null;
  duplicateOf?: string;
  /** Shown on screen in the demo instead of an SMS. Never sent to the model. */
  demoOtp?: string;
}

const MAX_OTP_ATTEMPTS = 3;

function hashOtp(proposalId: string, code: string): string {
  return createHash('sha256').update(`${proposalId}:${code}`).digest('hex');
}

/**
 * The same payment proposed twice on the same day maps to the same key, so a
 * model that repeats itself, or a retried request, cannot pay twice.
 */
export function deriveIdempotencyKey(r: ProposalRequest, today: string): string {
  return createHash('sha256')
    .update([r.studentId, r.origin, r.payeeId, r.amountMinor, r.currency, r.invoiceId ?? '', today].join('|'))
    .digest('hex')
    .slice(0, 32);
}

interface Pricing {
  sourceAccountId: string;
  debitMinor: number;
  feeMinor: number;
  fxRate: number | null;
  routeId: string | null;
  routeName: string | null;
}

async function price(db: Queryable, student: Student, r: ProposalRequest, today: string): Promise<Pricing | { error: string }> {
  const accounts = (await getAccounts(db, student.id)).filter((a) => a.currency === 'KES');
  const source = r.sourceAccountId ? accounts.find((a) => a.id === r.sourceAccountId) : accounts[0];
  if (!source) return { error: 'No KES account to pay from.' };

  if (r.currency === 'KES') {
    return { sourceAccountId: source.id, debitMinor: r.amountMinor, feeMinor: 0, fxRate: null, routeId: null, routeName: null };
  }
  const routes = await getRoutes(db, r.currency);
  const mid = rateOn(await getRateSeries(db, r.currency, 7, today), today);
  if (!mid || routes.length === 0) return { error: `No route or rate for ${r.currency}.` };
  let route = routes.find((x) => x.id === r.routeId);
  if (r.routeId && !route) return { error: 'Unknown route.' };
  if (!route) {
    const best = compareRoutes(r.amountMinor, r.currency, routes, mid, await getDocuments(db, student.id)).find((x) => x.eligible);
    if (!best) return { error: 'No eligible route for this amount.' };
    route = best.route;
  }
  const q = quoteReceive(r.amountMinor, route, mid);
  return {
    sourceAccountId: source.id,
    debitMinor: q.sendKesMinor,
    feeMinor: q.feeKesMinor,
    fxRate: mid,
    routeId: route.id,
    routeName: route.routeName,
  };
}

async function policyContext(
  db: Queryable,
  student: Student,
  facts: ProposalFacts,
  sourceAccountId: string,
  opts: { confirmed: boolean; idempotencyKeyUsed: boolean; excludeProposalId?: string },
): Promise<PolicyContext> {
  const now = clock.now();
  const today = clock.today();
  const payee = await getPayee(db, facts.payeeId);
  const invoice = facts.invoiceId ? await getInvoice(db, facts.invoiceId) : null;
  const spent = await getSpent(db, student.id, today);
  const account = (await getAccounts(db, student.id)).find((a) => a.id === sourceAccountId);
  return {
    studentId: student.id,
    tier: student.tier,
    payee: payee && { id: payee.id, studentId: payee.studentId, approved: payee.approved, createdAt: payee.createdAt },
    limits: {
      perPaymentMinor: student.perPaymentCapMinor,
      dailyMinor: student.dailyCapMinor,
      monthlyMinor: student.monthlyCapMinor,
      minBufferMinor: student.minBufferMinor,
      otpThresholdMinor: student.otpThresholdMinor,
    },
    spentTodayMinor: spent.todayMinor,
    spentMonthMinor: spent.monthMinor,
    sourceBalanceMinor: account?.balanceMinor ?? 0,
    invoice: invoice && {
      studentId: invoice.studentId,
      payeeId: invoice.payeeId,
      amountMinor: invoice.amountMinor,
      currency: invoice.currency,
      status: invoice.status,
    },
    recentProposalCount: await getRecentProposalCount(
      db,
      student.id,
      new Date(now.getTime() - RATE_WINDOW_MINUTES * 60_000),
      opts.excludeProposalId,
    ),
    idempotencyKeyUsed: opts.idempotencyKeyUsed,
    now,
    confirmed: opts.confirmed,
  };
}

export async function getProposalView(db: Queryable, id: string): Promise<ProposalView | null> {
  const r = await db.query(
    `SELECT p.*, py.name AS payee_name, f.route_name
       FROM proposals p JOIN payees py ON py.id = p.payee_id
       LEFT JOIN fee_snapshots f ON f.id = p.route_id
      WHERE p.id = $1`,
    [id],
  );
  const p = r.rows[0];
  if (!p) return null;
  return {
    id: p.id,
    status: p.status,
    payee: { id: p.payee_id, name: p.payee_name },
    amountMinor: p.amount_minor,
    currency: p.currency,
    debitMinor: p.debit_minor,
    debitCurrency: p.debit_currency,
    feeMinor: p.fee_minor,
    fxRate: p.fx_rate,
    routeName: p.route_name,
    invoiceId: p.invoice_id,
    memo: p.memo,
    decision: p.decision,
    requiresOtp: Boolean(p.otp_hash),
    providerRef: p.provider_ref,
    failureReason: p.failure_reason,
  };
}

/** Create a payment proposal, run the policy engine, and execute if allowed. */
export async function proposePayment(db: Db, adapter: PaymentAdapter, r: ProposalRequest): Promise<ProposalView> {
  const student = await getStudent(db, r.studentId);
  if (!student) throw new Error('Unknown student');
  const today = clock.today();
  const baseKey = r.idempotencyKey ?? deriveIdempotencyKey(r, today);
  // A payment that was cancelled, denied or failed may be asked for again;
  // one that is pending or done may not.
  let key = baseKey;
  for (let n = 2; ; n++) {
    const row = (await db.query('SELECT status FROM proposals WHERE idempotency_key = $1', [key])).rows[0];
    if (!row || !['cancelled', 'denied', 'failed'].includes(row.status)) break;
    key = `${baseKey}-${n}`;
  }

  const denied = async (detail: string, check: Decision['checks'][number]['check']): Promise<ProposalView> => {
    const decision: Decision = { outcome: 'deny', requiresOtp: false, reason: detail, checks: [{ check, passed: false, detail }] };
    await withTx(db, (tx) =>
      appendAudit(tx, {
        studentId: student.id,
        kind: 'policy_decision',
        data: { stage: 'proposed', origin: r.origin, proposalId: null, request: r, outcome: 'deny', reason: detail },
      }),
    );
    return {
      id: null,
      status: 'denied',
      payee: null,
      amountMinor: r.amountMinor,
      currency: r.currency,
      debitMinor: 0,
      debitCurrency: 'KES',
      feeMinor: 0,
      fxRate: null,
      routeName: null,
      invoiceId: r.invoiceId ?? null,
      memo: r.memo ?? '',
      decision,
      requiresOtp: false,
      providerRef: null,
      failureReason: null,
    };
  };

  // Duplicate: hand back the earlier result instead of paying again.
  const existing = await db.query('SELECT id FROM proposals WHERE idempotency_key = $1', [key]);
  if (existing.rows[0]) {
    const earlier = (await getProposalView(db, existing.rows[0].id))!;
    await withTx(db, (tx) =>
      appendAudit(tx, {
        studentId: student.id,
        kind: 'policy_decision',
        data: { stage: 'proposed', origin: r.origin, proposalId: earlier.id, outcome: 'duplicate', reason: 'Same payment already requested' },
      }),
    );
    return { ...earlier, duplicateOf: earlier.id! };
  }

  // A payee the student has never saved cannot be paid, whatever the model says.
  const payee = await getPayee(db, r.payeeId);
  if (!payee || payee.studentId !== student.id) return denied('The payee is not one of your saved payees.', 'payee');

  const pricing = await price(db, student, r, today);
  if ('error' in pricing) return denied(pricing.error, 'consistency');

  const facts: ProposalFacts = {
    origin: r.origin,
    payeeId: r.payeeId,
    amountMinor: r.amountMinor,
    currency: r.currency,
    debitMinor: pricing.debitMinor,
    invoiceId: r.invoiceId ?? null,
  };
  const ctx = await policyContext(db, student, facts, pricing.sourceAccountId, { confirmed: false, idempotencyKeyUsed: false });
  const decision = evaluate(facts, ctx);

  const id = `pr_${randomUUID().replace(/-/g, '').slice(0, 20)}`;
  let otp: string | undefined;
  if (decision.outcome === 'confirm' && decision.requiresOtp) otp = String(randomInt(0, 1_000_000)).padStart(6, '0');
  const status = decision.outcome === 'deny' ? 'denied' : decision.outcome === 'confirm' ? 'needs_confirmation' : 'executing';

  try {
    await withTx(db, async (tx) => {
      await tx.query(
        `INSERT INTO proposals (id, student_id, idempotency_key, origin, payee_id, source_account_id, amount_minor, currency,
                                debit_minor, debit_currency, fee_minor, fx_rate, route_id, invoice_id, memo, status, decision,
                                otp_hash, created_at, decided_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'KES',$10,$11,$12,$13,$14,$15,$16,$17,$18,$18)`,
        [
          id, student.id, key, r.origin, r.payeeId, pricing.sourceAccountId, r.amountMinor, r.currency,
          pricing.debitMinor, pricing.feeMinor, pricing.fxRate, pricing.routeId, r.invoiceId ?? null, r.memo ?? '',
          status, JSON.stringify(decision), otp ? hashOtp(id, otp) : null, clock.now(),
        ],
      );
      await appendAudit(tx, {
        studentId: student.id,
        kind: 'proposal_created',
        data: { proposalId: id, origin: r.origin, payeeId: r.payeeId, amountMinor: r.amountMinor, currency: r.currency, debitMinor: pricing.debitMinor, feeMinor: pricing.feeMinor, routeId: pricing.routeId, invoiceId: r.invoiceId ?? null, idempotencyKey: key },
      });
      await appendAudit(tx, {
        studentId: student.id,
        kind: 'policy_decision',
        data: { stage: 'proposed', origin: r.origin, proposalId: id, outcome: decision.outcome, reason: decision.reason, checks: decision.checks },
      });
      if (otp) await appendAudit(tx, { studentId: student.id, kind: 'otp_issued', data: { proposalId: id } });
    });
  } catch (err: any) {
    // Two identical requests raced: the unique key let only one in.
    if (err?.code === '23505') {
      const row = await db.query('SELECT id FROM proposals WHERE idempotency_key = $1', [key]);
      const earlier = (await getProposalView(db, row.rows[0].id))!;
      return { ...earlier, duplicateOf: earlier.id! };
    }
    throw err;
  }

  if (status === 'executing') await execute(db, adapter, id);
  const view = (await getProposalView(db, id))!;
  return otp ? { ...view, demoOtp: otp } : view;
}

/** Charge the provider for an allowed proposal and record the outcome. */
async function execute(db: Db, adapter: PaymentAdapter, proposalId: string): Promise<void> {
  const p = (await db.query('SELECT * FROM proposals WHERE id = $1', [proposalId])).rows[0];
  const student = (await getStudent(db, p.student_id))!;
  const method = (await db.query('SELECT * FROM payment_methods WHERE student_id = $1', [student.id])).rows[0];

  const fail = async (reason: string) =>
    withTx(db, async (tx) => {
      await tx.query(`UPDATE proposals SET status = 'failed', failure_reason = $2, provider = $3 WHERE id = $1`, [proposalId, reason, adapter.name]);
      await appendAudit(tx, { studentId: student.id, kind: 'payment_failed', data: { proposalId, reason, provider: adapter.name } });
    });

  if (!method && adapter.name !== 'simulated') {
    await fail('No linked payment method. Link a card first.');
    return;
  }

  let result;
  try {
    result = await adapter.charge({
      reference: p.idempotency_key,
      amountMinor: p.debit_minor,
      currency: p.debit_currency,
      email: method?.email ?? student.email,
      authorizationCode: method?.authorization_code ?? 'simulated',
      metadata: { proposal_id: proposalId, payee_id: p.payee_id, pays: `${p.currency} ${(p.amount_minor / 100).toFixed(2)}` },
    });
  } catch (err) {
    await fail(`Provider error: ${(err as Error).message}`);
    return;
  }
  if (result.status !== 'success') {
    await fail(result.message);
    return;
  }

  await withTx(db, async (tx) => {
    const now = clock.now();
    await tx.query(
      `UPDATE proposals SET status = 'executed', provider = $2, provider_ref = $3, executed_at = $4 WHERE id = $1`,
      [proposalId, result.provider, result.providerRef, now],
    );
    await tx.query('UPDATE accounts SET balance_minor = balance_minor - $2 WHERE id = $1', [p.source_account_id, p.debit_minor]);
    const payee = await tx.query('SELECT name FROM payees WHERE id = $1', [p.payee_id]);
    const category = p.invoice_id ? 'tuition_fees' : 'savings_transfers';
    await tx.query(
      `INSERT INTO transactions (id, student_id, account_id, occurred_at, amount_minor, currency, payee, description, category, category_source)
       VALUES ($1, $2, $3, $4, $5, 'KES', $6, $7, $8, 'rule')`,
      [`tx_${proposalId}`, student.id, p.source_account_id, now, -p.debit_minor, payee.rows[0].name, `Hela payment ${result.providerRef}`, category],
    );
    if (p.invoice_id) await tx.query(`UPDATE invoices SET status = 'paid' WHERE id = $1`, [p.invoice_id]);
    await appendAudit(tx, {
      studentId: student.id,
      kind: 'payment_executed',
      data: { proposalId, provider: result.provider, providerRef: result.providerRef, debitMinor: p.debit_minor, currency: p.debit_currency },
    });
  });
}

export class ConfirmError extends Error {}

/** The student confirms a proposal: re-check everything, then pay. */
export async function confirmProposal(
  db: Db,
  adapter: PaymentAdapter,
  studentId: string,
  proposalId: string,
  otp?: string,
): Promise<ProposalView> {
  const p = (await db.query('SELECT * FROM proposals WHERE id = $1 AND student_id = $2', [proposalId, studentId])).rows[0];
  if (!p) throw new ConfirmError('Proposal not found.');
  if (p.status !== 'needs_confirmation') throw new ConfirmError(`This payment is already ${p.status.replace('_', ' ')}.`);

  if (p.otp_hash) {
    const given = Buffer.from(hashOtp(proposalId, (otp ?? '').trim()));
    const ok = given.length === Buffer.from(p.otp_hash).length && timingSafeEqual(given, Buffer.from(p.otp_hash));
    if (!ok) {
      const attempts = p.otp_attempts + 1;
      const cancel = attempts >= MAX_OTP_ATTEMPTS;
      await withTx(db, async (tx) => {
        await tx.query(`UPDATE proposals SET otp_attempts = $2, status = CASE WHEN $3 THEN 'cancelled' ELSE status END WHERE id = $1`, [proposalId, attempts, cancel]);
        await appendAudit(tx, { studentId, kind: 'student_denied', data: { proposalId, reason: cancel ? 'Too many wrong codes' : 'Wrong code', attempts } });
      });
      throw new ConfirmError(cancel ? 'Too many wrong codes. The payment was cancelled.' : 'That code is not right. Try again.');
    }
  }

  const student = (await getStudent(db, studentId))!;
  const facts: ProposalFacts = {
    origin: p.origin,
    payeeId: p.payee_id,
    amountMinor: p.amount_minor,
    currency: p.currency,
    debitMinor: p.debit_minor,
    invoiceId: p.invoice_id,
  };
  // Re-run every check: the tier, limits or balance may have changed since.
  const ctx = await policyContext(db, student, facts, p.source_account_id, {
    confirmed: true,
    idempotencyKeyUsed: false,
    excludeProposalId: proposalId,
  });
  const decision = evaluate(facts, ctx);
  const next = decision.outcome === 'allow' ? 'executing' : 'denied';
  await withTx(db, async (tx) => {
    await tx.query('UPDATE proposals SET status = $2, decision = $3, decided_at = $4 WHERE id = $1', [proposalId, next, JSON.stringify(decision), clock.now()]);
    await appendAudit(tx, { studentId, kind: 'student_confirmed', data: { proposalId, withOtp: Boolean(p.otp_hash) } });
    await appendAudit(tx, {
      studentId,
      kind: 'policy_decision',
      data: { stage: 'confirmed', origin: p.origin, proposalId, outcome: decision.outcome, reason: decision.reason, checks: decision.checks },
    });
  });
  if (next === 'executing') await execute(db, adapter, proposalId);
  return (await getProposalView(db, proposalId))!;
}

export async function cancelProposal(db: Db, studentId: string, proposalId: string): Promise<ProposalView> {
  await withTx(db, async (tx) => {
    const r = await tx.query(
      `UPDATE proposals SET status = 'cancelled', decided_at = $3 WHERE id = $1 AND student_id = $2 AND status = 'needs_confirmation'`,
      [proposalId, studentId, clock.now()],
    );
    if (r.rowCount === 0) throw new ConfirmError('Only a payment waiting for confirmation can be cancelled.');
    await appendAudit(tx, { studentId, kind: 'student_denied', data: { proposalId, reason: 'Cancelled by student' } });
  });
  return (await getProposalView(db, proposalId))!;
}
