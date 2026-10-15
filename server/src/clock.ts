// One clock for the whole server, so tests can pin "today".

let fixed: Date | null = null;

export const clock = {
  now(): Date {
    return fixed ? new Date(fixed) : new Date();
  },
  /** Today's date in Nairobi (UTC+3, no daylight saving), as YYYY-MM-DD. */
  today(): string {
    return new Date(this.now().getTime() + 3 * 36e5).toISOString().slice(0, 10);
  },
  set(d: Date | null) {
    fixed = d;
  },
};
