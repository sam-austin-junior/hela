// Multi-currency budgeting: categorise, convert, detect recurring, alert.

export const CATEGORIES = [
  'housing',
  'groceries',
  'eating_out',
  'transport',
  'airtime_data',
  'tuition_fees',
  'books_supplies',
  'health',
  'entertainment',
  'family_support',
  'savings_transfers',
  'other',
] as const;
export type Category = (typeof CATEGORIES)[number];

/** Categories a student can reasonably trim; used by the tuition planner. */
export const DISCRETIONARY: Category[] = ['eating_out', 'entertainment', 'airtime_data', 'transport', 'groceries'];

export function isCategory(c: string): c is Category {
  return (CATEGORIES as readonly string[]).includes(c);
}

export interface Rule {
  pattern: string;
  category: string;
  /** Student rules win over global ones. */
  studentId: string | null;
}

export interface Txn {
  id: string;
  occurredAt: string; // ISO timestamp
  amountMinor: number; // negative = spend
  currency: string;
  payee: string;
  description: string;
  category: string | null;
}

export function categoriseByRules(t: Pick<Txn, 'payee' | 'description' | 'amountMinor'>, rules: Rule[]): string | null {
  if (t.amountMinor > 0) return 'income';
  const hay = `${t.payee} ${t.description}`.toLowerCase();
  const ordered = [...rules].sort((a, b) => Number(b.studentId !== null) - Number(a.studentId !== null));
  for (const r of ordered) {
    if (hay.includes(r.pattern.toLowerCase())) return r.category;
  }
  return null;
}

export interface MonthSummary {
  month: string; // YYYY-MM
  currency: string;
  incomeMinor: number;
  spendMinor: number;
  netMinor: number;
  byCategory: { category: string; spendMinor: number }[];
}

/**
 * Sum one month of transactions in the student's chosen currency.
 * `toTarget` converts an amount at the rate on the transaction's own date.
 */
export function summariseMonth(
  txns: Txn[],
  month: string,
  currency: string,
  toTarget: (amountMinor: number, fromCurrency: string, date: string) => number,
): MonthSummary {
  const inMonth = txns.filter((t) => t.occurredAt.slice(0, 7) === month);
  let income = 0;
  let spend = 0;
  const byCat = new Map<string, number>();
  for (const t of inMonth) {
    const v = toTarget(t.amountMinor, t.currency, t.occurredAt.slice(0, 10));
    if (v > 0) {
      income += v;
      continue;
    }
    spend += -v;
    const c = t.category ?? 'other';
    byCat.set(c, (byCat.get(c) ?? 0) - v);
  }
  return {
    month,
    currency,
    incomeMinor: income,
    spendMinor: spend,
    netMinor: income - spend,
    byCategory: [...byCat.entries()]
      .map(([category, spendMinor]) => ({ category, spendMinor }))
      .sort((a, b) => b.spendMinor - a.spendMinor),
  };
}

export interface Recurring {
  payee: string;
  typicalMinor: number; // negative for spend
  currency: string;
  intervalDays: number;
  lastDate: string;
  nextDate: string;
  occurrences: number;
}

function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
}

const DAY = 864e5;

/**
 * A payment is recurring when the same payee appears at least three times,
 * every amount is within 10 % of the median, and every gap is 26–35 days.
 */
export function detectRecurring(txns: Txn[]): Recurring[] {
  const byPayee = new Map<string, Txn[]>();
  for (const t of txns) {
    const key = `${t.payee.trim().toLowerCase()}|${t.currency}|${Math.sign(t.amountMinor)}`;
    byPayee.set(key, [...(byPayee.get(key) ?? []), t]);
  }
  const out: Recurring[] = [];
  for (const group of byPayee.values()) {
    if (group.length < 3) continue;
    const sorted = [...group].sort((a, b) => a.occurredAt.localeCompare(b.occurredAt));
    const amounts = sorted.map((t) => t.amountMinor);
    const med = median(amounts);
    if (!amounts.every((a) => Math.abs(a - med) <= Math.abs(med) * 0.1)) continue;
    const gaps: number[] = [];
    for (let i = 1; i < sorted.length; i++) {
      const a = Date.parse(sorted[i - 1]!.occurredAt.slice(0, 10));
      const b = Date.parse(sorted[i]!.occurredAt.slice(0, 10));
      gaps.push(Math.round((b - a) / DAY));
    }
    if (!gaps.every((g) => g >= 26 && g <= 35)) continue;
    const interval = Math.round(median(gaps));
    const last = sorted[sorted.length - 1]!;
    const lastDate = last.occurredAt.slice(0, 10);
    out.push({
      payee: last.payee,
      typicalMinor: Math.round(med),
      currency: last.currency,
      intervalDays: interval,
      lastDate,
      nextDate: new Date(Date.parse(lastDate) + interval * DAY).toISOString().slice(0, 10),
      occurrences: sorted.length,
    });
  }
  return out.sort((a, b) => a.nextDate.localeCompare(b.nextDate));
}

export interface Alert {
  kind: 'over_budget' | 'low_balance_for_bill';
  text: string;
  category?: string;
  payee?: string;
}

export function budgetAlerts(input: {
  summary: MonthSummary;
  budgets: { category: string; monthlyMinor: number }[];
  recurring: Recurring[];
  today: string;
  balanceKesMinor: number;
  minBufferKesMinor: number;
}): Alert[] {
  const alerts: Alert[] = [];
  for (const b of input.budgets) {
    const spent = input.summary.byCategory.find((c) => c.category === b.category)?.spendMinor ?? 0;
    if (spent > b.monthlyMinor) {
      alerts.push({
        kind: 'over_budget',
        category: b.category,
        text: `${b.category.replace(/_/g, ' ')} is over its monthly budget`,
      });
    }
  }
  // Bills due in the next 7 days that would push the balance under the buffer.
  let committed = 0;
  for (const r of input.recurring) {
    if (r.typicalMinor >= 0 || r.currency !== 'KES') continue;
    const days = (Date.parse(r.nextDate) - Date.parse(input.today)) / DAY;
    if (days < 0 || days > 7) continue;
    committed += -r.typicalMinor;
    if (input.balanceKesMinor - committed < input.minBufferKesMinor) {
      alerts.push({
        kind: 'low_balance_for_bill',
        payee: r.payee,
        text: `${r.payee} is due on ${r.nextDate} and would take the balance under your buffer`,
      });
    }
  }
  return alerts;
}
