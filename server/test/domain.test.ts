import { describe, expect, it } from 'vitest';
import { formatMinor, parseAmount } from '../src/domain/money.js';
import { dailyVolatility, rateOn, rateRange } from '../src/domain/fx.js';
import { compareRoutes, offeredRate, quoteReceive, quoteSend, type Route } from '../src/domain/remittance.js';
import { planTuition } from '../src/domain/tuition.js';
import { budgetAlerts, categoriseByRules, detectRecurring, summariseMonth, type Txn } from '../src/domain/budget.js';
import { creditChecklist } from '../src/domain/credit.js';

describe('money', () => {
  it('parses decimal strings exactly into minor units', () => {
    expect(parseAmount('4200')).toBe(420000);
    expect(parseAmount('4,200.5')).toBe(420050);
    expect(parseAmount('0.07')).toBe(7);
  });
  it('rejects ambiguous or unsafe amounts', () => {
    for (const bad of ['', '-5', '1.234', '1e3', 'abc', '12.']) expect(() => parseAmount(bad)).toThrow();
  });
  it('formats with grouping and two decimals', () => {
    expect(formatMinor(123456789, 'KES')).toBe('KES 1,234,567.89');
    expect(formatMinor(-499, 'USD')).toBe('-USD 4.99');
  });
});

describe('exchange rates', () => {
  it('has zero volatility for a flat series', () => {
    const s = [1, 2, 3, 4].map((d) => ({ date: `2026-01-0${d}`, kesPerUnit: 130 }));
    expect(dailyVolatility(s)).toBe(0);
  });
  it('computes sample volatility of log returns', () => {
    // returns: ln(1.01), ln(0.99) → mean ≈ -0.00005, sample sd ≈ 0.0141
    const s = [{ date: '2026-01-01', kesPerUnit: 100 }, { date: '2026-01-02', kesPerUnit: 101 }, { date: '2026-01-03', kesPerUnit: 99.99 }];
    expect(dailyVolatility(s)).toBeCloseTo(0.01414, 4);
  });
  it('widens the range with √days at a one-sided 95% z', () => {
    const r = rateRange(130, 0.01, 100);
    expect(r.high).toBeCloseTo(130 * Math.exp(1.65 * 0.01 * 10), 6);
    expect(r.low).toBeCloseTo(130 * Math.exp(-0.165), 6);
  });
  it('uses the latest rate on or before a date', () => {
    const s = [{ date: '2026-01-01', kesPerUnit: 1 }, { date: '2026-01-05', kesPerUnit: 2 }];
    expect(rateOn(s, '2026-01-04')).toBe(1);
    expect(rateOn(s, '2026-01-05')).toBe(2);
    expect(rateOn(s, '2025-12-31')).toBeUndefined();
  });
});

const route = (over: Partial<Route> = {}): Route => ({
  id: 'r',
  routeName: 'Route',
  routeKind: 'x',
  toCurrency: 'USD',
  feeFixedMinor: 10_000, // KES 100
  feePct: 0.01,
  fxMarginPct: 0.02,
  minSendMinor: 0,
  maxSendMinor: 1e12,
  arrivalHours: 24,
  requires: [],
  snapshotDate: '2026-10-01',
  ...over,
});

describe('remittance', () => {
  it('matches a hand-worked send quote', () => {
    // KES 10,000 sent: fee 100 + 1% = KES 200; net KES 9,800;
    // offered = (1/130)·0.98 USD per KES → 73.876… → USD 73.87 received.
    const q = quoteSend(1_000_000, route(), 130);
    expect(q.feeKesMinor).toBe(20_000);
    expect(q.receivedMinor).toBe(7_387);
    expect(q.offeredForeignPerKes).toBeCloseTo(offeredRate(130, 0.02), 12);
    // margin = 980,000 − 7,387·130 = 19,690 minor
    expect(q.marginCostKesMinor).toBe(19_690);
    expect(q.totalCostKesMinor).toBe(39_690);
  });
  it('finds the smallest send that delivers the full amount', () => {
    const q = quoteReceive(7_387, route(), 130);
    expect(q.receivedMinor).toBeGreaterThanOrEqual(7_387);
    expect(quoteSend(q.sendKesMinor - 1, route(), 130).receivedMinor).toBeLessThan(7_387);
  });
  it('ranks eligible routes first, cheapest first, and explains exclusions', () => {
    const routes = [
      route({ id: 'pricey', feeFixedMinor: 50_000 }),
      route({ id: 'cheap_needs_passport', feeFixedMinor: 0, requires: ['passport'] }),
      route({ id: 'cheap', feeFixedMinor: 1_000 }),
      route({ id: 'small_cap', feeFixedMinor: 0, maxSendMinor: 100_000 }),
    ];
    const ranked = compareRoutes(35_000, 'USD', routes, 130, ['national_id']);
    expect(ranked.map((r) => r.route.id)).toEqual(['cheap', 'pricey', 'cheap_needs_passport', 'small_cap']);
    expect(ranked[2]!.reasons).toEqual(['Needs passport']);
    expect(ranked[3]!.reasons[0]).toMatch(/over this route's limit/);
  });
});

describe('tuition planner', () => {
  const base = {
    invoiceAmountMinor: 100_000, // USD 1,000
    currency: 'USD',
    dueDate: '2026-12-24',
    today: '2026-10-15', // 70 days → 10 weeks
    savingsKesMinor: 3_000_000,
    monthlySurplusKesMinor: 5_000_000,
    rateToday: 130,
    sigma: 0,
    route: route({ feeFixedMinor: 0, feePct: 0, fxMarginPct: 0 }),
    discretionary: [
      { category: 'eating_out', monthlyKesMinor: 800_000 },
      { category: 'entertainment', monthlyKesMinor: 200_000 },
    ],
  };
  it('works out the weekly target from the shortfall', () => {
    const p = planTuition(base);
    expect(p.neededHighKesMinor).toBe(13_000_000);
    expect(p.shortfallKesMinor).toBe(10_000_000);
    expect(p.weeksLeft).toBe(10);
    expect(p.weeklyTargetKesMinor).toBe(1_000_000);
    expect(p.weeklySurplusKesMinor).toBe(1_153_846);
    expect(p.status).toBe('on_track');
    expect(p.options).toEqual([]);
  });
  it('flags a plan at risk and suggests capped cuts, largest first', () => {
    const p = planTuition({ ...base, monthlySurplusKesMinor: 4_000_000 });
    expect(p.status).toBe('at_risk');
    const cuts = p.options.filter((o) => o.kind === 'cut_spending');
    expect(cuts[0]!.text).toMatch(/eating out/);
    // never more than a quarter of a category: 800,000·0.25/4.33 = 46,153
    expect(cuts[0]!.weeklyKesMinor).toBeLessThanOrEqual(46_154);
    expect(p.options.some((o) => o.kind === 'instalment_plan')).toBe(true);
  });
  it('is funded when savings cover the high-side amount', () => {
    expect(planTuition({ ...base, savingsKesMinor: 13_000_000 }).status).toBe('funded');
  });
  it('raises the amount needed when the rate is volatile', () => {
    const calm = planTuition(base);
    const volatile = planTuition({ ...base, sigma: 0.004 });
    expect(volatile.neededHighKesMinor).toBeGreaterThan(calm.neededHighKesMinor);
    expect(volatile.neededTodayKesMinor).toBe(calm.neededTodayKesMinor);
  });
});

const t = (id: string, date: string, amount: number, payee: string, category: string | null = null, currency = 'KES'): Txn => ({
  id,
  occurredAt: `${date}T10:00:00.000Z`,
  amountMinor: amount,
  currency,
  payee,
  description: '',
  category,
});

describe('budgeting', () => {
  it('prefers a student rule over a global one, and income is always income', () => {
    const rules = [
      { pattern: 'grill', category: 'eating_out', studentId: null },
      { pattern: 'grill', category: 'entertainment', studentId: 's1' },
    ];
    expect(categoriseByRules({ payee: 'Uptown Grill', description: '', amountMinor: -100 }, rules)).toBe('entertainment');
    expect(categoriseByRules({ payee: 'Uptown Grill', description: '', amountMinor: 100 }, rules)).toBe('income');
    expect(categoriseByRules({ payee: 'Unknown', description: '', amountMinor: -100 }, rules)).toBeNull();
  });
  it('converts each transaction at its own date before summing', () => {
    const txns = [t('a', '2026-10-01', -1000, 'x', 'other', 'USD'), t('b', '2026-10-02', -1000, 'y', 'other', 'USD')];
    const conv = (amt: number, _c: string, date: string) => amt * (date === '2026-10-01' ? 130 : 131);
    const s = summariseMonth(txns, '2026-10', 'KES', conv);
    expect(s.spendMinor).toBe(261_000);
  });
  it('detects monthly payments and skips irregular ones', () => {
    const txns = [
      t('1', '2026-07-03', -1_250_000, 'Rent'),
      t('2', '2026-08-03', -1_250_000, 'Rent'),
      t('3', '2026-09-03', -1_260_000, 'Rent'),
      t('4', '2026-07-05', -10_000, 'Cafe'),
      t('5', '2026-07-09', -10_000, 'Cafe'),
      t('6', '2026-08-30', -10_000, 'Cafe'),
    ];
    const r = detectRecurring(txns);
    expect(r).toHaveLength(1);
    expect(r[0]!.payee).toBe('Rent');
    expect(r[0]!.nextDate).toBe('2026-10-04');
  });
  it('alerts on a bill that would breach the buffer', () => {
    const alerts = budgetAlerts({
      summary: { month: '2026-10', currency: 'KES', incomeMinor: 0, spendMinor: 0, netMinor: 0, byCategory: [{ category: 'eating_out', spendMinor: 500 }] },
      budgets: [{ category: 'eating_out', monthlyMinor: 400 }],
      recurring: [{ payee: 'Rent', typicalMinor: -1_000_000, currency: 'KES', intervalDays: 31, lastDate: '2026-09-18', nextDate: '2026-10-19', occurrences: 3 }],
      today: '2026-10-15',
      balanceKesMinor: 1_200_000,
      minBufferKesMinor: 500_000,
    });
    expect(alerts.map((a) => a.kind)).toEqual(['over_budget', 'low_balance_for_bill']);
  });
});

describe('credit checklist', () => {
  it('puts arrears and late payments first and never mentions a score', () => {
    const items = creditChecklist({ studentLoan: 'in_arrears', mobileLoans: 'late', missedPayments12m: 2, hasBankAccount: false, checkedCrbReport12m: false });
    expect(items.slice(0, 3).every((i) => i.priority === 1)).toBe(true);
    expect(items[0]!.id).toBe('clear-loan-arrears');
    expect(JSON.stringify(items)).not.toMatch(/score/i);
  });
  it('gives a short list to a student with a clean record', () => {
    const items = creditChecklist({ studentLoan: 'none', mobileLoans: 'none', missedPayments12m: 0, hasBankAccount: true, checkedCrbReport12m: true });
    expect(items.map((i) => i.id)).toEqual(['keep-utilisation-low']);
  });
});
