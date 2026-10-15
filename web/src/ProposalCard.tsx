import { useState } from 'react';
import { api, money, label, type Proposal } from './api';

// The confirmation card is drawn from the stored proposal record, never from
// the model's words, so what the student approves is what will be paid.

const STATUS: Record<Proposal['status'], { text: string; tone: string }> = {
  needs_confirmation: { text: 'Waiting for you', tone: 'warn' },
  executing: { text: 'Paying…', tone: 'info' },
  executed: { text: 'Paid (sandbox)', tone: 'good' },
  denied: { text: 'Blocked by policy', tone: 'bad' },
  failed: { text: 'Failed', tone: 'bad' },
  cancelled: { text: 'Cancelled', tone: 'muted' },
};

export function ProposalCard({ initial, onChange }: { initial: Proposal; onChange: () => void }) {
  const [p, setP] = useState(initial);
  const [otp, setOtp] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showChecks, setShowChecks] = useState(p.status === 'denied');
  const s = STATUS[p.status];

  const act = async (fn: () => Promise<Proposal>) => {
    setBusy(true);
    setError(null);
    try {
      const next = await fn();
      setP({ ...next, demoOtp: undefined });
      onChange();
    } catch (e) {
      setError((e as Error).message);
      if (p.id) setP(await api.proposal(p.id).catch(() => p));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className={`proposal tone-${s.tone}`}>
      <div className="proposal-head">
        <span className="proposal-title">{p.payee ? `Pay ${p.payee.name}` : 'Payment request'}</span>
        <span className={`pill pill-${s.tone}`}>{s.text}</span>
      </div>
      <dl className="proposal-grid">
        <dt>They receive</dt>
        <dd className="num strong">{money(p.amountMinor, p.currency)}</dd>
        {p.debitMinor > 0 && (
          <>
            <dt>Leaves your account</dt>
            <dd className="num">{money(p.debitMinor, p.debitCurrency)}</dd>
          </>
        )}
        {p.feeMinor > 0 && (
          <>
            <dt>Fees included</dt>
            <dd className="num">{money(p.feeMinor, p.debitCurrency)}</dd>
          </>
        )}
        {p.routeName && (
          <>
            <dt>Route</dt>
            <dd>{p.routeName}</dd>
          </>
        )}
        {p.fxRate && (
          <>
            <dt>Mid rate</dt>
            <dd className="num">KES {p.fxRate.toFixed(4)} per {p.currency}</dd>
          </>
        )}
        {p.invoiceId && (
          <>
            <dt>Invoice</dt>
            <dd>{p.invoiceId}</dd>
          </>
        )}
        {p.providerRef && (
          <>
            <dt>Reference</dt>
            <dd className="mono">{p.providerRef}</dd>
          </>
        )}
      </dl>
      <p className="proposal-reason">
        {p.duplicateOf ? 'Same payment already requested; showing the earlier one. ' : ''}
        {p.failureReason ?? p.decision.reason}
      </p>

      {p.status === 'needs_confirmation' && p.id && (
        <div className="proposal-actions">
          {p.requiresOtp && (
            <label className="otp">
              <span>One-time code</span>
              <input inputMode="numeric" maxLength={6} value={otp} onChange={(e) => setOtp(e.target.value.replace(/\D/g, ''))} placeholder="6 digits" />
            </label>
          )}
          {p.requiresOtp && initial.demoOtp && (
            <p className="demo-sms">Demo SMS: your Hela code is <strong className="mono">{initial.demoOtp}</strong></p>
          )}
          <div className="row">
            <button className="btn primary" disabled={busy || (p.requiresOtp && otp.length !== 6)} onClick={() => act(() => api.confirm(p.id!, otp || undefined))}>
              Confirm and pay
            </button>
            <button className="btn" disabled={busy} onClick={() => act(() => api.cancel(p.id!))}>
              Cancel
            </button>
          </div>
        </div>
      )}
      {error && <p className="error">{error}</p>}

      <button className="link" onClick={() => setShowChecks((v) => !v)}>
        {showChecks ? 'Hide' : 'Show'} policy checks
      </button>
      {showChecks && (
        <ul className="checks">
          {p.decision.checks.map((c) => (
            <li key={c.check} className={c.passed ? 'ok' : 'no'}>
              <span className="check-mark" aria-hidden>{c.passed ? '✓' : '✕'}</span>
              <span className="check-name">{label(c.check)}</span>
              <span className="check-detail">{c.detail}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
