import { rateRange } from './fx.js';
import { quoteReceive, type Route } from './remittance.js';

export const WEEKS_PER_MONTH = 52 / 12; // 4.33

export interface TuitionInput {
  invoiceAmountMinor: number;
  currency: string;
  dueDate: string; // YYYY-MM-DD
  today: string;
  savingsKesMinor: number;
  monthlySurplusKesMinor: number;
  rateToday: number; // KES per unit
  sigma: number; // daily log-return volatility
  /** The cheapest eligible route for this corridor. */
  route: Route;
  /** Spending this month by discretionary category, KES minor, largest first is not required. */
  discretionary: { category: string; monthlyKesMinor: number }[];
}

export interface TuitionOption {
  kind: 'cut_spending' | 'pay_part_now' | 'instalment_plan';
  text: string;
  weeklyKesMinor?: number;
  amountKesMinor?: number;
}

export interface TuitionPlan {
  daysLeft: number;
  weeksLeft: number;
  rate: { low: number; today: number; high: number };
  neededTodayKesMinor: number;
  neededHighKesMinor: number;
  routeId: string;
  routeName: string;
  feeKesMinor: number;
  savingsKesMinor: number;
  shortfallKesMinor: number;
  weeklyTargetKesMinor: number;
  weeklySurplusKesMinor: number;
  status: 'funded' | 'on_track' | 'at_risk' | 'overdue';
  options: TuitionOption[];
}

function daysBetween(from: string, to: string): number {
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 864e5);
}

const CUT_SHARE = 0.25; // never suggest cutting a category by more than a quarter

export function planTuition(input: TuitionInput): TuitionPlan {
  const daysLeft = daysBetween(input.today, input.dueDate);
  const weeksLeft = Math.max(1, Math.ceil(daysLeft / 7));
  const rate = rateRange(input.rateToday, input.sigma, Math.max(daysLeft, 0));

  const atToday = quoteReceive(input.invoiceAmountMinor, input.route, rate.today);
  const atHigh = quoteReceive(input.invoiceAmountMinor, input.route, rate.high);

  const shortfall = Math.max(atHigh.sendKesMinor - input.savingsKesMinor, 0);
  const weeklyTarget = Math.ceil(shortfall / weeksLeft);
  const weeklySurplus = Math.floor(input.monthlySurplusKesMinor / WEEKS_PER_MONTH);

  let status: TuitionPlan['status'];
  if (shortfall === 0) status = 'funded';
  else if (daysLeft <= 0) status = 'overdue';
  else if (weeklyTarget <= weeklySurplus) status = 'on_track';
  else status = 'at_risk';

  const options: TuitionOption[] = [];
  if (status === 'at_risk' || status === 'overdue') {
    let gapWeekly = weeklyTarget - Math.max(weeklySurplus, 0);
    const byLargest = [...input.discretionary].sort((a, b) => b.monthlyKesMinor - a.monthlyKesMinor);
    for (const c of byLargest) {
      if (gapWeekly <= 0) break;
      const maxWeeklyCut = Math.floor((c.monthlyKesMinor * CUT_SHARE) / WEEKS_PER_MONTH);
      const cut = Math.min(maxWeeklyCut, gapWeekly);
      if (cut <= 0) continue;
      options.push({
        kind: 'cut_spending',
        text: `Spend less on ${c.category.replace(/_/g, ' ')}`,
        weeklyKesMinor: cut,
      });
      gapWeekly -= cut;
    }
    // Paying the part already saved locks today's rate for that part.
    if (input.savingsKesMinor > 0) {
      options.push({
        kind: 'pay_part_now',
        text: 'Pay the part you have saved now, at today\'s rate',
        amountKesMinor: input.savingsKesMinor,
      });
    }
    options.push({
      kind: 'instalment_plan',
      text: 'Ask the university for an instalment plan before the due date',
    });
  }

  return {
    daysLeft,
    weeksLeft,
    rate,
    neededTodayKesMinor: atToday.sendKesMinor,
    neededHighKesMinor: atHigh.sendKesMinor,
    routeId: input.route.id,
    routeName: input.route.routeName,
    feeKesMinor: atHigh.feeKesMinor,
    savingsKesMinor: input.savingsKesMinor,
    shortfallKesMinor: shortfall,
    weeklyTargetKesMinor: weeklyTarget,
    weeklySurplusKesMinor: weeklySurplus,
    status,
    options,
  };
}
