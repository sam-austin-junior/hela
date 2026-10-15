// Money as integer minor units. Every currency Hela handles has two
// decimal places in its minor unit, so 1 unit = 100 minor units.

export const MINOR_PER_UNIT = 100;

const SUPPORTED = new Set(['KES', 'USD', 'GBP', 'EUR', 'UGX', 'TZS', 'NGN', 'ZAR', 'CAD', 'AUD']);

export function isCurrency(code: string): boolean {
  return SUPPORTED.has(code);
}

/**
 * Parse a decimal amount such as "4200", "4,200.50" or "4200.5" into minor
 * units. Rejects anything ambiguous instead of guessing: the model never
 * gets to hand us a float.
 */
export function parseAmount(input: string | number): number {
  const s = String(input).replace(/,/g, '').trim();
  if (!/^\d{1,13}(\.\d{1,2})?$/.test(s)) {
    throw new Error(`Not a valid amount: "${input}"`);
  }
  const [whole, frac = ''] = s.split('.');
  return Number(whole) * MINOR_PER_UNIT + Number(frac.padEnd(2, '0'));
}

export function formatMinor(minor: number, currency: string): string {
  const sign = minor < 0 ? '-' : '';
  const abs = Math.abs(Math.round(minor));
  const units = Math.floor(abs / MINOR_PER_UNIT);
  const cents = abs % MINOR_PER_UNIT;
  const grouped = units.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return `${sign}${currency} ${grouped}.${cents.toString().padStart(2, '0')}`;
}

/** Round half away from zero to whole minor units. */
export function roundMinor(x: number): number {
  return Math.sign(x) * Math.round(Math.abs(x));
}
