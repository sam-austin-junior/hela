// The policy engine: the only component that can let money move.
//
// It is a pure function of the proposal and facts loaded from the database.
// The language model never calls it with its own facts and never sees its
// inputs as editable: tier, limits and payee status come from storage.

export type Tier = 0 | 1 | 2 | 3;

export const TIER_NAMES: Record<Tier, string> = {
  0: 'Read only',
  1: 'Advise',
  2: 'Act with confirmation',
  3: 'Act within limits',
};

export const NEW_PAYEE_HOURS = 24;
export const RATE_WINDOW_MINUTES = 10;
export const RATE_MAX_PROPOSALS = 5;

export interface ProposalFacts {
  origin: 'agent' | 'schedule';
  payeeId: string;
  amountMinor: number; // what the payee receives
  currency: string;
  debitMinor: number; // what leaves the account, KES, fees included
  invoiceId: string | null;
}

export interface PolicyContext {
  studentId: string;
  tier: Tier;
  payee: { id: string; studentId: string; approved: boolean; createdAt: Date } | null;
  limits: {
    perPaymentMinor: number;
    dailyMinor: number;
    monthlyMinor: number;
    minBufferMinor: number;
    otpThresholdMinor: number;
  };
  spentTodayMinor: number;
  spentMonthMinor: number;
  sourceBalanceMinor: number;
  invoice: { studentId: string; payeeId: string | null; amountMinor: number; currency: string; status: string } | null;
  /** Payment proposals by this student in the rate window, not counting this one. */
  recentProposalCount: number;
  idempotencyKeyUsed: boolean;
  now: Date;
  /** True when the student has confirmed this exact proposal. */
  confirmed: boolean;
}

export type CheckName = 'tier' | 'payee' | 'limits' | 'balance' | 'consistency' | 'rate' | 'duplicate';

export interface CheckResult {
  check: CheckName;
  passed: boolean;
  detail: string;
}

export interface Decision {
  outcome: 'allow' | 'confirm' | 'deny';
  requiresOtp: boolean;
  reason: string;
  checks: CheckResult[];
}

const kes = (minor: number) => `KES ${(minor / 100).toLocaleString('en-KE', { minimumFractionDigits: 2 })}`;

export function evaluate(p: ProposalFacts, ctx: PolicyContext): Decision {
  const checks: CheckResult[] = [];
  const confirmReasons: string[] = [];

  const deny = (check: CheckName, detail: string): Decision => {
    checks.push({ check, passed: false, detail });
    return { outcome: 'deny', requiresOtp: false, reason: detail, checks };
  };
  const pass = (check: CheckName, detail: string) => checks.push({ check, passed: true, detail });

  // 1. Tier
  if (ctx.tier < 2) {
    return deny('tier', `Your tier is "${TIER_NAMES[ctx.tier]}", which does not allow payments.`);
  }
  pass('tier', `Tier "${TIER_NAMES[ctx.tier]}" allows payments.`);

  // 2. Payee
  const payee = ctx.payee;
  if (!payee || payee.studentId !== ctx.studentId || payee.id !== p.payeeId) {
    return deny('payee', 'The payee is not one of your saved payees.');
  }
  if (!payee.approved) {
    return deny('payee', 'The payee is not on your approved list. Approve it yourself first.');
  }
  const ageHours = (ctx.now.getTime() - payee.createdAt.getTime()) / 36e5;
  if (ageHours < NEW_PAYEE_HOURS) {
    confirmReasons.push(`The payee was added less than ${NEW_PAYEE_HOURS} hours ago.`);
    pass('payee', 'Approved payee, added recently: needs your confirmation.');
  } else {
    pass('payee', 'Approved payee.');
  }

  // 3. Limits
  if (p.debitMinor <= 0) return deny('limits', 'The amount must be more than zero.');
  if (p.debitMinor > ctx.limits.perPaymentMinor) {
    return deny('limits', `${kes(p.debitMinor)} is over your per-payment cap of ${kes(ctx.limits.perPaymentMinor)}.`);
  }
  if (ctx.spentTodayMinor + p.debitMinor > ctx.limits.dailyMinor) {
    return deny('limits', `This would take today's payments over your daily cap of ${kes(ctx.limits.dailyMinor)}.`);
  }
  if (ctx.spentMonthMinor + p.debitMinor > ctx.limits.monthlyMinor) {
    return deny('limits', `This would take this month's payments over your monthly cap of ${kes(ctx.limits.monthlyMinor)}.`);
  }
  pass('limits', 'Within your per-payment, daily and monthly caps.');

  // 4. Balance
  if (ctx.sourceBalanceMinor - p.debitMinor < ctx.limits.minBufferMinor) {
    return deny(
      'balance',
      `Paying ${kes(p.debitMinor)} would leave less than your ${kes(ctx.limits.minBufferMinor)} buffer.`,
    );
  }
  pass('balance', 'Enough balance, with your buffer kept.');

  // 5. Consistency with the cited document
  if (p.invoiceId) {
    const inv = ctx.invoice;
    if (!inv || inv.studentId !== ctx.studentId) return deny('consistency', 'The cited invoice was not found.');
    if (inv.status !== 'open') return deny('consistency', 'The cited invoice is already paid.');
    if (inv.payeeId !== p.payeeId) return deny('consistency', 'The payee does not match the invoice issuer.');
    if (inv.currency !== p.currency || inv.amountMinor !== p.amountMinor) {
      return deny('consistency', 'The amount or currency does not match the invoice.');
    }
    pass('consistency', 'Amount, currency and payee match the invoice.');
  } else {
    pass('consistency', 'No document cited.');
  }

  // 6. Rate of actions
  if (ctx.recentProposalCount >= RATE_MAX_PROPOSALS) {
    return deny(
      'rate',
      `More than ${RATE_MAX_PROPOSALS} payment proposals in ${RATE_WINDOW_MINUTES} minutes. Payments are paused for a few minutes.`,
    );
  }
  pass('rate', 'Normal rate of requests.');

  // 7. Duplicates
  if (ctx.idempotencyKeyUsed) {
    return deny('duplicate', 'This payment was already requested. The earlier result stands.');
  }
  pass('duplicate', 'Not a repeat of an earlier payment.');

  const requiresOtp = p.debitMinor > ctx.limits.otpThresholdMinor;

  if (ctx.confirmed) {
    return { outcome: 'allow', requiresOtp, reason: 'You confirmed this payment.', checks };
  }
  if (ctx.tier === 3 && confirmReasons.length === 0) {
    return { outcome: 'allow', requiresOtp: false, reason: 'Approved payee, within your limits.', checks };
  }
  const reason = ctx.tier === 2 ? 'Your tier needs your confirmation for every payment.' : confirmReasons.join(' ');
  return { outcome: 'confirm', requiresOtp, reason, checks };
}
