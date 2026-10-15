import { randomUUID } from 'node:crypto';
import type { Db, Queryable } from '../db.js';
import { clock } from '../clock.js';
import {
  budgetAlerts,
  categoriseByRules,
  DISCRETIONARY,
  detectRecurring,
  summariseMonth,
  type Txn,
} from '../domain/budget.js';
import { dailyVolatility, rateOn, toKesMinor } from '../domain/fx.js';
import { compareRoutes } from '../domain/remittance.js';
import { planTuition } from '../domain/tuition.js';
import { creditChecklist, type CreditAnswers } from '../domain/credit.js';
import {
  getAccounts,
  getAllRates,
  getBudgets,
  getDocuments,
  getInvoice,
  getRateSeries,
  getRoutes,
  getRules,
  getStudent,
  getTransactions,
} from './data.js';

/** A converter from any currency to the target, at the rate on a given date. */
export async function converter(db: Queryable, target: string) {
  const rates = await getAllRates(db);
  const kesPer = (cur: string, date: string) => (cur === 'KES' ? 1 : rateOn(rates.get(cur) ?? [], date));
  return (amountMinor: number, from: string, date: string): number => {
    if (from === target) return amountMinor;
    const a = kesPer(from, date);
    const b = kesPer(target, date);
    if (!a || !b) throw new Error(`No rate for ${from}→${target} on ${date}`);
    return Math.round((amountMinor * a) / b);
  };
}

/** Apply rules to uncategorised transactions. Returns how many were left for the model. */
export async function applyRules(db: Db, studentId: string): Promise<number> {
  const rules = await getRules(db, studentId);
  const txns = (await getTransactions(db, studentId)).filter((t) => !t.category);
  const ids: string[] = [];
  const cats: string[] = [];
  for (const t of txns) {
    const c = categoriseByRules(t, rules);
    if (c) {
      ids.push(t.id);
      cats.push(c);
    }
  }
  if (ids.length) {
    await db.query(
      `UPDATE transactions t SET category = u.category, category_source = 'rule'
         FROM unnest($1::text[], $2::text[]) AS u(id, category) WHERE t.id = u.id`,
      [ids, cats],
    );
  }
  return txns.length - ids.length;
}

/** A student's correction updates the transaction and becomes a rule. */
export async function correctCategory(db: Db, studentId: string, transactionId: string, category: string) {
  const t = (await db.query('SELECT payee FROM transactions WHERE id = $1 AND student_id = $2', [transactionId, studentId])).rows[0];
  if (!t) throw new Error('Transaction not found');
  await db.query(`UPDATE transactions SET category = $2, category_source = 'student' WHERE id = $1`, [transactionId, category]);
  await db.query('INSERT INTO category_rules (student_id, pattern, category) VALUES ($1, $2, $3)', [studentId, t.payee, category]);
  return applyRules(db, studentId);
}

export async function budgetView(db: Queryable, studentId: string, month?: string, currency?: string) {
  const student = (await getStudent(db, studentId))!;
  const target = currency ?? student.homeCurrency;
  const today = clock.today();
  const m = month ?? today.slice(0, 7);
  const txns = await getTransactions(db, studentId);
  const convert = await converter(db, target);
  const summary = summariseMonth(txns, m, target, convert);
  const recurring = detectRecurring(txns);
  const accounts = await getAccounts(db, studentId);
  const kesBalance = accounts.filter((a) => a.currency === 'KES').reduce((s, a) => s + a.balanceMinor, 0);
  const budgets = await getBudgets(db, studentId);
  // Budgets are set in KES; compare like with like.
  const kesSummary = target === 'KES' ? summary : summariseMonth(txns, m, 'KES', await converter(db, 'KES'));
  const alerts = budgetAlerts({
    summary: kesSummary,
    budgets,
    recurring,
    today,
    balanceKesMinor: kesBalance,
    minBufferKesMinor: student.minBufferMinor,
  });
  return { summary, budgets, recurring, alerts, uncategorised: txns.filter((t) => !t.category).length };
}

/** Average monthly income minus spending over the last three full months, in KES. */
export async function monthlySurplus(db: Queryable, studentId: string): Promise<number> {
  const today = clock.today();
  const txns = await getTransactions(db, studentId);
  const convert = await converter(db, 'KES');
  const months: string[] = [];
  const d = new Date(`${today.slice(0, 7)}-01T00:00:00Z`);
  for (let i = 1; i <= 3; i++) {
    const x = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() - i, 1));
    months.push(x.toISOString().slice(0, 7));
  }
  const nets = months.map((m) => summariseMonth(txns, m, 'KES', convert).netMinor);
  return Math.round(nets.reduce((s, n) => s + n, 0) / nets.length);
}

export async function compareRoutesFor(db: Queryable, studentId: string, amountMinor: number, currency: string) {
  const today = clock.today();
  const series = await getRateSeries(db, currency, 7, today);
  const mid = rateOn(series, today);
  if (!mid) throw new Error(`No rate for ${currency}`);
  const routes = await getRoutes(db, currency);
  const ranked = compareRoutes(amountMinor, currency, routes, mid, await getDocuments(db, studentId));
  return { midKesPerUnit: mid, rateDate: series.at(-1)?.date, ranked };
}

export async function tuitionPlan(db: Db, studentId: string, invoiceId: string) {
  const invoice = await getInvoice(db, invoiceId);
  if (!invoice || invoice.studentId !== studentId) throw new Error('Invoice not found');
  const today = clock.today();
  const series = await getRateSeries(db, invoice.currency, 90, today);
  const rateToday = rateOn(series, today);
  if (!rateToday) throw new Error(`No rate for ${invoice.currency}`);
  const sigma = dailyVolatility(series);
  const cmp = await compareRoutesFor(db, studentId, invoice.amountMinor, invoice.currency);
  const best = cmp.ranked.find((r) => r.eligible);
  if (!best) throw new Error('No eligible route for this invoice');

  const accounts = await getAccounts(db, studentId);
  const savings = accounts.filter((a) => a.currency === 'KES').reduce((s, a) => s + a.balanceMinor, 0);
  const student = (await getStudent(db, studentId))!;
  // Savings available for tuition exclude the student's safety buffer.
  const available = Math.max(savings - student.minBufferMinor, 0);

  const lastMonth = new Date(Date.UTC(Number(today.slice(0, 4)), Number(today.slice(5, 7)) - 2, 1)).toISOString().slice(0, 7);
  const prev = (await budgetView(db, studentId, lastMonth, 'KES')).summary;
  const discretionary = prev.byCategory
    .filter((c) => (DISCRETIONARY as string[]).includes(c.category))
    .map((c) => ({ category: c.category, monthlyKesMinor: c.spendMinor }));

  const plan = planTuition({
    invoiceAmountMinor: invoice.amountMinor,
    currency: invoice.currency,
    dueDate: invoice.dueDate,
    today,
    savingsKesMinor: available,
    monthlySurplusKesMinor: await monthlySurplus(db, studentId),
    rateToday,
    sigma,
    route: best.route,
    discretionary,
  });
  const id = `plan_${randomUUID().slice(0, 8)}`;
  const stored = { invoiceId, issuer: invoice.issuer, amountMinor: invoice.amountMinor, currency: invoice.currency, dueDate: invoice.dueDate, sigmaDaily: sigma, ...plan };
  await db.query('INSERT INTO plans (id, student_id, kind, payload, created_at) VALUES ($1, $2, $3, $4, $5)', [
    id, studentId, 'tuition', JSON.stringify(stored), clock.now(),
  ]);
  return { planId: id, ...stored };
}

export function creditPlan(answers: CreditAnswers) {
  return creditChecklist(answers);
}

export { toKesMinor };
export type { Txn };
