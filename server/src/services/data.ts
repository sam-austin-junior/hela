import type { Queryable } from '../db.js';
import type { Tier } from '../policy/engine.js';
import type { Route } from '../domain/remittance.js';
import type { RatePoint } from '../domain/fx.js';
import type { Rule, Txn } from '../domain/budget.js';

// Typed reads. Everything the policy engine relies on is loaded here, from
// storage, never from what the model says.

export interface Student {
  id: string;
  firstName: string;
  email: string;
  homeCurrency: string;
  tier: Tier;
  perPaymentCapMinor: number;
  dailyCapMinor: number;
  monthlyCapMinor: number;
  minBufferMinor: number;
  otpThresholdMinor: number;
  pinHash: string;
}

export async function getStudent(db: Queryable, id: string): Promise<Student | null> {
  const r = await db.query(
    `SELECT id, first_name, email, home_currency, tier, per_payment_cap_minor, daily_cap_minor,
            monthly_cap_minor, min_buffer_minor, otp_threshold_minor, pin_hash
       FROM students WHERE id = $1`,
    [id],
  );
  const s = r.rows[0];
  if (!s) return null;
  return {
    id: s.id,
    firstName: s.first_name,
    email: s.email,
    homeCurrency: s.home_currency,
    tier: s.tier as Tier,
    perPaymentCapMinor: s.per_payment_cap_minor,
    dailyCapMinor: s.daily_cap_minor,
    monthlyCapMinor: s.monthly_cap_minor,
    minBufferMinor: s.min_buffer_minor,
    otpThresholdMinor: s.otp_threshold_minor,
    pinHash: s.pin_hash,
  };
}

export interface Account {
  id: string;
  kind: string;
  label: string;
  currency: string;
  balanceMinor: number;
}

export async function getAccounts(db: Queryable, studentId: string): Promise<Account[]> {
  const r = await db.query(
    'SELECT id, kind, label, currency, balance_minor FROM accounts WHERE student_id = $1 ORDER BY balance_minor DESC',
    [studentId],
  );
  return r.rows.map((a) => ({ id: a.id, kind: a.kind, label: a.label, currency: a.currency, balanceMinor: a.balance_minor }));
}

export async function getTransactions(db: Queryable, studentId: string, sinceDate?: string): Promise<(Txn & { accountId: string; categorySource: string | null })[]> {
  const r = await db.query(
    `SELECT id, account_id, occurred_at, amount_minor, currency, payee, description, category, category_source
       FROM transactions
      WHERE student_id = $1 AND ($2::date IS NULL OR occurred_at >= $2::date)
      ORDER BY occurred_at DESC`,
    [studentId, sinceDate ?? null],
  );
  return r.rows.map((t) => ({
    id: t.id,
    accountId: t.account_id,
    occurredAt: (t.occurred_at as Date).toISOString(),
    amountMinor: t.amount_minor,
    currency: t.currency,
    payee: t.payee,
    description: t.description,
    category: t.category,
    categorySource: t.category_source,
  }));
}

export async function getRules(db: Queryable, studentId: string): Promise<Rule[]> {
  const r = await db.query(
    'SELECT pattern, category, student_id FROM category_rules WHERE student_id IS NULL OR student_id = $1',
    [studentId],
  );
  return r.rows.map((x) => ({ pattern: x.pattern, category: x.category, studentId: x.student_id }));
}

export async function getBudgets(db: Queryable, studentId: string) {
  const r = await db.query('SELECT category, monthly_minor FROM category_budgets WHERE student_id = $1', [studentId]);
  return r.rows.map((b) => ({ category: b.category as string, monthlyMinor: b.monthly_minor as number }));
}

export interface Payee {
  id: string;
  studentId: string;
  name: string;
  kind: string;
  country: string;
  currency: string;
  approved: boolean;
  createdAt: Date;
}

const payeeFrom = (p: any): Payee => ({
  id: p.id,
  studentId: p.student_id,
  name: p.name,
  kind: p.kind,
  country: p.country,
  currency: p.currency,
  approved: p.approved,
  createdAt: p.created_at,
});

export async function getPayees(db: Queryable, studentId: string): Promise<Payee[]> {
  const r = await db.query('SELECT * FROM payees WHERE student_id = $1 ORDER BY name', [studentId]);
  return r.rows.map(payeeFrom);
}

export async function getPayee(db: Queryable, id: string): Promise<Payee | null> {
  const r = await db.query('SELECT * FROM payees WHERE id = $1', [id]);
  return r.rows[0] ? payeeFrom(r.rows[0]) : null;
}

export interface Invoice {
  id: string;
  studentId: string;
  payeeId: string | null;
  issuer: string;
  reference: string;
  amountMinor: number;
  currency: string;
  dueDate: string;
  rawText: string;
  status: string;
}

const invoiceFrom = (i: any): Invoice => ({
  id: i.id,
  studentId: i.student_id,
  payeeId: i.payee_id,
  issuer: i.issuer,
  reference: i.reference,
  amountMinor: i.amount_minor,
  currency: i.currency,
  dueDate: i.due_date,
  rawText: i.raw_text,
  status: i.status,
});

export async function getInvoices(db: Queryable, studentId: string): Promise<Invoice[]> {
  const r = await db.query('SELECT * FROM invoices WHERE student_id = $1 ORDER BY due_date', [studentId]);
  return r.rows.map(invoiceFrom);
}

export async function getInvoice(db: Queryable, id: string): Promise<Invoice | null> {
  const r = await db.query('SELECT * FROM invoices WHERE id = $1', [id]);
  return r.rows[0] ? invoiceFrom(r.rows[0]) : null;
}

export async function getRateSeries(db: Queryable, currency: string, days = 90, onOrBefore?: string): Promise<RatePoint[]> {
  const r = await db.query(
    `SELECT rate_date, kes_per_unit FROM fx_rates
      WHERE currency = $1 AND ($3::date IS NULL OR rate_date <= $3::date)
      ORDER BY rate_date DESC LIMIT $2`,
    [currency, days + 1, onOrBefore ?? null],
  );
  return r.rows.map((x) => ({ date: x.rate_date, kesPerUnit: x.kes_per_unit })).reverse();
}

export async function getAllRates(db: Queryable): Promise<Map<string, RatePoint[]>> {
  const r = await db.query('SELECT rate_date, currency, kes_per_unit FROM fx_rates ORDER BY rate_date');
  const m = new Map<string, RatePoint[]>();
  for (const x of r.rows) {
    m.set(x.currency, [...(m.get(x.currency) ?? []), { date: x.rate_date, kesPerUnit: x.kes_per_unit }]);
  }
  return m;
}

export async function getRoutes(db: Queryable, toCurrency?: string): Promise<Route[]> {
  const r = await db.query(
    'SELECT * FROM fee_snapshots WHERE ($1::text IS NULL OR to_currency = $1) ORDER BY id',
    [toCurrency ?? null],
  );
  return r.rows.map((f) => ({
    id: f.id,
    routeName: f.route_name,
    routeKind: f.route_kind,
    toCurrency: f.to_currency,
    feeFixedMinor: f.fee_fixed_minor,
    feePct: f.fee_pct,
    fxMarginPct: f.fx_margin_pct,
    minSendMinor: f.min_send_minor,
    maxSendMinor: f.max_send_minor,
    arrivalHours: f.arrival_hours,
    requires: f.requires,
    snapshotDate: f.snapshot_date,
  }));
}

export async function getDocuments(db: Queryable, studentId: string): Promise<string[]> {
  const r = await db.query('SELECT document FROM student_documents WHERE student_id = $1', [studentId]);
  return r.rows.map((d) => d.document);
}

/** KES debited by payments today and this calendar month (Nairobi time). */
export async function getSpent(db: Queryable, studentId: string, today: string) {
  const r = await db.query(
    `SELECT
       COALESCE(SUM(debit_minor) FILTER (WHERE (created_at AT TIME ZONE 'Africa/Nairobi')::date = $2::date), 0) AS today,
       COALESCE(SUM(debit_minor) FILTER (WHERE date_trunc('month', created_at AT TIME ZONE 'Africa/Nairobi') = date_trunc('month', $2::date)), 0) AS month
       FROM proposals
      WHERE student_id = $1 AND status IN ('executing', 'executed')`,
    [studentId, today],
  );
  return { todayMinor: Number(r.rows[0].today), monthMinor: Number(r.rows[0].month) };
}

/**
 * Payment attempts the agent made in the window, counted from the audit log
 * so that attempts denied before a proposal row exists (an unknown payee,
 * say) still count.
 */
export async function getRecentProposalCount(db: Queryable, studentId: string, since: Date, excludeProposalId?: string) {
  const r = await db.query(
    `SELECT count(*)::int AS n FROM audit_log
      WHERE student_id = $1 AND kind = 'policy_decision' AND data->>'origin' = 'agent'
        AND data->>'stage' = 'proposed' AND at >= $2
        AND ($3::text IS NULL OR data->>'proposalId' IS DISTINCT FROM $3)`,
    [studentId, since, excludeProposalId ?? null],
  );
  return r.rows[0].n as number;
}
