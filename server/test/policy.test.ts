import { describe, expect, it } from 'vitest';
import { evaluate, type PolicyContext, type ProposalFacts } from '../src/policy/engine.js';

const NOW = new Date('2026-10-15T09:00:00Z');
const facts = (over: Partial<ProposalFacts> = {}): ProposalFacts => ({
  origin: 'agent',
  payeeId: 'p1',
  amountMinor: 35_000,
  currency: 'USD',
  debitMinor: 4_600_000,
  invoiceId: null,
  ...over,
});
const ctx = (over: Partial<PolicyContext> = {}): PolicyContext => ({
  studentId: 's1',
  tier: 2,
  payee: { id: 'p1', studentId: 's1', approved: true, createdAt: new Date(NOW.getTime() - 30 * 864e5) },
  limits: { perPaymentMinor: 10_000_000, dailyMinor: 12_000_000, monthlyMinor: 20_000_000, minBufferMinor: 500_000, otpThresholdMinor: 1_000_000 },
  spentTodayMinor: 0,
  spentMonthMinor: 0,
  sourceBalanceMinor: 30_000_000,
  invoice: null,
  recentProposalCount: 0,
  idempotencyKeyUsed: false,
  now: NOW,
  confirmed: false,
  ...over,
});

const failed = (d: ReturnType<typeof evaluate>) => d.checks.find((c) => !c.passed)?.check;

describe('policy engine — tiers', () => {
  it('tier 0 and tier 1 never allow a payment', () => {
    for (const tier of [0, 1] as const) {
      const d = evaluate(facts(), ctx({ tier }));
      expect(d.outcome).toBe('deny');
      expect(failed(d)).toBe('tier');
    }
  });
  it('tier 2 always asks the student', () => {
    const d = evaluate(facts(), ctx({ tier: 2 }));
    expect(d.outcome).toBe('confirm');
    expect(d.requiresOtp).toBe(true); // 46,000 > 10,000 threshold
  });
  it('tier 2 needs no code under the threshold', () => {
    expect(evaluate(facts({ debitMinor: 900_000 }), ctx()).requiresOtp).toBe(false);
  });
  it('tier 3 pays an approved, established payee within limits', () => {
    const d = evaluate(facts(), ctx({ tier: 3 }));
    expect(d.outcome).toBe('allow');
    expect(d.checks.every((c) => c.passed)).toBe(true);
  });
  it('tier 3 falls back to confirmation for a payee added in the last 24 hours', () => {
    const d = evaluate(facts(), ctx({ tier: 3, payee: { id: 'p1', studentId: 's1', approved: true, createdAt: new Date(NOW.getTime() - 2 * 36e5) } }));
    expect(d.outcome).toBe('confirm');
  });
  it('a confirmed proposal is allowed once every check passes again', () => {
    expect(evaluate(facts(), ctx({ confirmed: true })).outcome).toBe('allow');
  });
});

describe('policy engine — each check', () => {
  const cases: [string, Partial<ProposalFacts>, Partial<PolicyContext>, string][] = [
    ['unknown payee', {}, { payee: null }, 'payee'],
    ['another student\'s payee', {}, { payee: { id: 'p1', studentId: 'other', approved: true, createdAt: NOW } }, 'payee'],
    ['unapproved payee', {}, { payee: { id: 'p1', studentId: 's1', approved: false, createdAt: new Date(0) } }, 'payee'],
    ['over the per-payment cap', { debitMinor: 10_000_001 }, {}, 'limits'],
    ['over the daily cap', {}, { spentTodayMinor: 8_000_000 }, 'limits'],
    ['over the monthly cap', {}, { spentMonthMinor: 16_000_000 }, 'limits'],
    ['zero amount', { debitMinor: 0 }, {}, 'limits'],
    ['would breach the buffer', {}, { sourceBalanceMinor: 5_000_000 }, 'balance'],
    ['invoice not found', { invoiceId: 'i1' }, { invoice: null }, 'consistency'],
    ['invoice already paid', { invoiceId: 'i1' }, { invoice: { studentId: 's1', payeeId: 'p1', amountMinor: 35_000, currency: 'USD', status: 'paid' } }, 'consistency'],
    ['amount differs from invoice', { invoiceId: 'i1', amountMinor: 95_000 }, { invoice: { studentId: 's1', payeeId: 'p1', amountMinor: 35_000, currency: 'USD', status: 'open' } }, 'consistency'],
    ['payee differs from invoice', { invoiceId: 'i1' }, { invoice: { studentId: 's1', payeeId: 'p2', amountMinor: 35_000, currency: 'USD', status: 'open' } }, 'consistency'],
    ['burst of proposals', {}, { recentProposalCount: 5 }, 'rate'],
    ['repeat of an earlier payment', {}, { idempotencyKeyUsed: true }, 'duplicate'],
  ];
  for (const [name, f, c, check] of cases) {
    it(`denies: ${name}`, () => {
      const d = evaluate(facts(f), ctx({ tier: 3, ...c }));
      expect(d.outcome).toBe('deny');
      expect(failed(d)).toBe(check);
    });
  }
  it('denies even a confirmed proposal that now breaks a limit', () => {
    expect(evaluate(facts(), ctx({ confirmed: true, sourceBalanceMinor: 1_000_000 })).outcome).toBe('deny');
  });
  it('stops at the first failure, in order', () => {
    const d = evaluate(facts({ debitMinor: 99_000_000 }), ctx({ tier: 1, payee: null }));
    expect(d.checks).toHaveLength(1);
    expect(d.checks[0]!.check).toBe('tier');
  });
  it('accepts an invoice that matches exactly', () => {
    const d = evaluate(facts({ invoiceId: 'i1' }), ctx({ invoice: { studentId: 's1', payeeId: 'p1', amountMinor: 35_000, currency: 'USD', status: 'open' } }));
    expect(d.checks.find((c) => c.check === 'consistency')!.passed).toBe(true);
  });
});
