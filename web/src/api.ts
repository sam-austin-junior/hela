// Thin client for the Hela API. Types mirror what the server returns.

export interface Account { id: string; kind: string; label: string; currency: string; balanceMinor: number }
export interface Payee { id: string; name: string; kind: string; country: string; currency: string; approved: boolean; createdAt: string }
export interface Invoice { id: string; payeeId: string | null; issuer: string; reference: string; amountMinor: number; currency: string; dueDate: string; status: string; rawText: string }
export interface Schedule { id: string; payee: { id: string; name: string }; amountMinor: number; currency: string; intervalDays: number; nextRun: string; memo: string; status: 'pending_approval' | 'active' | 'revoked' }
export interface Check { check: string; passed: boolean; detail: string }
export interface Decision { outcome: 'allow' | 'confirm' | 'deny'; requiresOtp: boolean; reason: string; checks: Check[] }
export interface Proposal {
  id: string | null;
  status: 'needs_confirmation' | 'denied' | 'executing' | 'executed' | 'failed' | 'cancelled';
  payee: { id: string; name: string } | null;
  amountMinor: number;
  currency: string;
  debitMinor: number;
  debitCurrency: string;
  feeMinor: number;
  fxRate: number | null;
  routeName: string | null;
  invoiceId: string | null;
  memo: string;
  decision: Decision;
  requiresOtp: boolean;
  providerRef: string | null;
  failureReason: string | null;
  duplicateOf?: string;
  demoOtp?: string;
}
export interface State {
  today: string;
  student: { firstName: string; homeCurrency: string; tier: number; tierName: string; limits: Record<string, number> };
  accounts: Account[];
  paymentMethod: string | null;
  provider: string;
  modelReady: boolean;
  payees: Payee[];
  invoices: Invoice[];
  schedules: Schedule[];
  proposals: Proposal[];
}
export interface Budget {
  summary: { month: string; currency: string; incomeMinor: number; spendMinor: number; netMinor: number; byCategory: { category: string; spendMinor: number }[] };
  budgets: { category: string; monthlyMinor: number }[];
  recurring: { payee: string; typicalMinor: number; currency: string; intervalDays: number; nextDate: string }[];
  alerts: { kind: string; text: string }[];
  uncategorised: number;
}
export interface AuditEntry { seq: number; at: string; kind: string; data: Record<string, unknown>; prev_hash: string; hash: string }
export interface ChainCheck { ok: boolean; entries: number; headHash: string; firstBrokenSeq?: number; problem?: string }
export type TurnStep =
  | { type: 'thinking' }
  | { type: 'waiting'; seconds: number }
  | { type: 'tool_start'; name: string; kind: string }
  | { type: 'tool_end'; name: string; kind: string; ok: boolean };

export interface TurnResult { reply: string; proposals: Proposal[]; schedules: string[]; tools: { name: string; kind: string; ok: boolean }[] }

export interface Txn { id: string; occurredAt: string; amountMinor: number; currency: string; payee: string; description: string; category: string | null; categorySource: string | null }
export interface Limits { perPaymentMinor: number; dailyMinor: number; monthlyMinor: number; minBufferMinor: number; otpThresholdMinor: number }
export interface TuitionPlan {
  planId?: string;
  invoiceId: string;
  issuer: string;
  amountMinor: number;
  currency: string;
  dueDate: string;
  sigmaDaily: number;
  daysLeft: number;
  weeksLeft: number;
  rate: { low: number; today: number; high: number };
  neededTodayKesMinor: number;
  neededHighKesMinor: number;
  routeName: string;
  feeKesMinor: number;
  savingsKesMinor: number;
  shortfallKesMinor: number;
  weeklyTargetKesMinor: number;
  weeklySurplusKesMinor: number;
  status: 'funded' | 'on_track' | 'at_risk' | 'overdue';
  options: { kind: string; text: string; weeklyKesMinor?: number; amountKesMinor?: number }[];
}
export interface RouteComparison {
  midKesPerUnit: number;
  rateDate: string;
  ranked: {
    route: { id: string; routeName: string; arrivalHours: number; snapshotDate: string };
    quote: { sendKesMinor: number; feeKesMinor: number; marginCostKesMinor: number; totalCostKesMinor: number; receivedMinor: number };
    eligible: boolean;
    reasons: string[];
  }[];
}

export const CATEGORIES = [
  'housing', 'groceries', 'eating_out', 'transport', 'airtime_data', 'tuition_fees',
  'books_supplies', 'health', 'entertainment', 'family_support', 'savings_transfers', 'other',
];

async function call<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(path, {
    method,
    headers: body === undefined ? {} : { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error((json as { error?: string }).error ?? `Request failed (${res.status})`);
  return json as T;
}

export const api = {
  state: () => call<State>('GET', '/api/state'),
  budget: (month?: string, currency?: string) => {
    const q = new URLSearchParams();
    if (month) q.set('month', month);
    if (currency) q.set('currency', currency);
    return call<Budget>('GET', `/api/budget?${q}`);
  },
  chat: (message: string) => call<TurnResult>('POST', '/api/chat', { message }),
  /** The chat turn as a stream: `onStep` sees each step as the agent works. */
  async chatStream(message: string, onStep: (e: TurnStep) => void): Promise<TurnResult> {
    const res = await fetch('/api/chat/stream', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message }),
    });
    if (!res.ok || !res.body) {
      const json = await res.json().catch(() => ({}));
      throw new Error((json as { error?: string }).error ?? `Request failed (${res.status})`);
    }
    const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
    let buffer = '';
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += value;
      let cut: number;
      while ((cut = buffer.indexOf('\n\n')) >= 0) {
        const frame = buffer.slice(0, cut);
        buffer = buffer.slice(cut + 2);
        const event = /^event: (.+)$/m.exec(frame)?.[1];
        const data = /^data: (.+)$/m.exec(frame)?.[1];
        if (!event || !data) continue;
        const payload = JSON.parse(data);
        if (event === 'step') onStep(payload);
        else if (event === 'done') return payload as TurnResult;
        else if (event === 'error') throw new Error(payload.error);
      }
    }
    throw new Error('The connection closed before Hela finished.');
  },
  resetChat: () => call('POST', '/api/chat/reset', {}),
  proposal: (id: string) => call<Proposal>('GET', `/api/proposals/${id}`),
  confirm: (id: string, otp?: string) => call<Proposal>('POST', `/api/proposals/${id}/confirm`, { otp }),
  cancel: (id: string) => call<Proposal>('POST', `/api/proposals/${id}/cancel`, {}),
  setTier: (tier: number, pin?: string) => call<{ tier: number }>('POST', '/api/tier', { tier, pin }),
  approvePayee: (id: string, pin: string) => call('POST', `/api/payees/${id}/approve`, { pin }),
  approveSchedule: (id: string, pin: string) => call('POST', `/api/schedules/${id}/approve`, { pin }),
  revokeSchedule: (id: string) => call('POST', `/api/schedules/${id}/revoke`, {}),
  runSchedules: () => call<{ results: Proposal[] }>('POST', '/api/schedules/run', {}),
  linkPaymentMethod: () => call<{ url?: string; linked?: boolean }>('POST', '/api/payment-method/link', {}),
  transactions: (month?: string) => call<Txn[]>('GET', `/api/transactions${month ? `?month=${month}` : ''}`),
  setCategory: (id: string, category: string) => call<{ uncategorised: number }>('POST', `/api/transactions/${id}/category`, { category }),
  addPayee: (p: { name: string; kind: string; country: string; currency: string }) => call<{ id: string }>('POST', '/api/payees', p),
  setLimits: (l: Limits & { pin?: string }) => call<Limits & { loosened: boolean }>('POST', '/api/limits', l),
  planTuition: (invoiceId: string) => call<TuitionPlan>('POST', `/api/invoices/${invoiceId}/plan`, {}),
  latestPlan: () => call<TuitionPlan | null>('GET', '/api/plans/latest'),
  compareRoutes: (amount: string, currency: string) => call<RouteComparison>('POST', '/api/routes/compare', { amount, currency }),
  audit: (limit = 60) => call<AuditEntry[]>('GET', `/api/audit?limit=${limit}`),
  verifyAudit: () => call<ChainCheck>('GET', '/api/audit/verify'),
};

export function money(minor: number, currency: string): string {
  const sign = minor < 0 ? '−' : '';
  const abs = Math.abs(minor) / 100;
  return `${sign}${currency} ${abs.toLocaleString('en-KE', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

export const label = (s: string) => s.replace(/_/g, ' ').replace(/^./, (c) => c.toUpperCase());
