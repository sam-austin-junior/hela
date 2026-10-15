// Exchange-rate maths. Rates are KES per one unit of the foreign currency.

export interface RatePoint {
  date: string; // YYYY-MM-DD
  kesPerUnit: number;
}

/** Sample standard deviation of daily log returns. */
export function dailyVolatility(series: RatePoint[]): number {
  const sorted = [...series].sort((a, b) => a.date.localeCompare(b.date));
  const returns: number[] = [];
  for (let i = 1; i < sorted.length; i++) {
    returns.push(Math.log(sorted[i]!.kesPerUnit / sorted[i - 1]!.kesPerUnit));
  }
  if (returns.length < 2) return 0;
  const mean = returns.reduce((s, r) => s + r, 0) / returns.length;
  const variance = returns.reduce((s, r) => s + (r - mean) ** 2, 0) / (returns.length - 1);
  return Math.sqrt(variance);
}

/** One-sided z for a 95 % bound. */
export const Z_95_ONE_SIDED = 1.65;

/**
 * The high side of the rate range at a horizon of `days`:
 * r_high = r_today · e^(z·σ·√h). For a student paying in foreign currency,
 * a higher KES-per-unit rate is the costly direction.
 */
export function rateRange(rateToday: number, sigma: number, days: number, z = Z_95_ONE_SIDED) {
  const spread = z * sigma * Math.sqrt(Math.max(days, 0));
  return {
    low: rateToday * Math.exp(-spread),
    today: rateToday,
    high: rateToday * Math.exp(spread),
  };
}

/** Convert foreign minor units to KES minor units at a KES-per-unit rate. */
export function toKesMinor(foreignMinor: number, kesPerUnit: number): number {
  return Math.round(foreignMinor * kesPerUnit);
}

/** The latest rate on or before `date`, from a series sorted any way. */
export function rateOn(series: RatePoint[], date: string): number | undefined {
  let best: RatePoint | undefined;
  for (const p of series) {
    if (p.date <= date && (!best || p.date > best.date)) best = p;
  }
  return best?.kesPerUnit;
}
