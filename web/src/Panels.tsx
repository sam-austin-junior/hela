import { useEffect, useState } from 'react';
import { api, CATEGORIES, label, money, type Invoice, type Limits, type RouteComparison, type TuitionPlan, type Txn } from './api';

/* ── Plans: tuition planner and route comparison, no AI needed ── */

const PLAN_STATUS: Record<TuitionPlan['status'], { text: string; tone: string }> = {
  funded: { text: 'Funded', tone: 'good' },
  on_track: { text: 'On track', tone: 'good' },
  at_risk: { text: 'At risk', tone: 'warn' },
  overdue: { text: 'Overdue', tone: 'bad' },
};

export function PlansView({ invoices, refreshKey }: { invoices: Invoice[]; refreshKey: number }) {
  const foreign = invoices.filter((i) => i.currency !== 'KES' && i.status === 'open');
  const [plan, setPlan] = useState<TuitionPlan | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api.latestPlan().then(setPlan).catch(() => {});
  }, [refreshKey]);

  const build = async (id: string) => {
    setBusy(true);
    setError(null);
    try {
      setPlan(await api.planTuition(id));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="pad">
      <h4>Tuition plan</h4>
      <div className="row">
        {foreign.map((i) => (
          <button key={i.id} className="btn small" disabled={busy} onClick={() => build(i.id)}>
            Plan {money(i.amountMinor, i.currency)} due {i.dueDate}
          </button>
        ))}
        {foreign.length === 0 && <p className="muted small">No open foreign-currency invoices.</p>}
      </div>
      {error && <p className="error">{error}</p>}
      {plan && <PlanCard plan={plan} />}
      <RouteCompare />
    </div>
  );
}

function PlanCard({ plan: p }: { plan: TuitionPlan }) {
  const s = PLAN_STATUS[p.status];
  const pct = Math.min(100, (p.savingsKesMinor / Math.max(p.neededHighKesMinor, 1)) * 100);
  return (
    <div className="card">
      <div className="proposal-head">
        <span className="proposal-title">
          {p.issuer} · {money(p.amountMinor, p.currency)}
        </span>
        <span className={`pill pill-${s.tone}`}>{s.text}</span>
      </div>
      <p className="muted small">
        Due {p.dueDate} · {p.daysLeft} days ({p.weeksLeft} weeks) · via {p.routeName}
      </p>
      <div className="range" aria-label="Exchange-rate range">
        <div className="range-row">
          <span className="muted small">KES needed at today's rate</span>
          <span className="num">{money(p.neededTodayKesMinor, 'KES')}</span>
        </div>
        <div className="range-row">
          <span className="muted small">If the rate moves against you (95%)</span>
          <span className="num strong">{money(p.neededHighKesMinor, 'KES')}</span>
        </div>
        <div className="bar-track tall" title={`${pct.toFixed(0)}% saved`}>
          <div className="bar-fill" style={{ width: `${pct}%` }} />
        </div>
        <div className="range-row">
          <span className="muted small">Saved (after your buffer)</span>
          <span className="num">{money(p.savingsKesMinor, 'KES')}</span>
        </div>
      </div>
      <div className="stats">
        <div><span className="muted small">Shortfall</span><strong className="num">{money(p.shortfallKesMinor, 'KES')}</strong></div>
        <div><span className="muted small">Save weekly</span><strong className="num">{money(p.weeklyTargetKesMinor, 'KES')}</strong></div>
        <div><span className="muted small">You free up</span><strong className={`num ${p.weeklySurplusKesMinor < p.weeklyTargetKesMinor ? 'bad' : 'good'}`}>{money(p.weeklySurplusKesMinor, 'KES')}</strong></div>
      </div>
      {p.options.length > 0 && (
        <>
          <h4>Options</h4>
          <ul className="options">
            {p.options.map((o, i) => (
              <li key={i}>
                <span>{o.text}</span>
                {o.weeklyKesMinor !== undefined && <span className="num">{money(o.weeklyKesMinor, 'KES')}/week</span>}
                {o.amountKesMinor !== undefined && <span className="num">{money(o.amountKesMinor, 'KES')}</span>}
              </li>
            ))}
          </ul>
        </>
      )}
      <p className="muted small">
        Rate today KES {p.rate.today.toFixed(2)}, high side KES {p.rate.high.toFixed(2)} per {p.currency}. Daily volatility {(p.sigmaDaily * 100).toFixed(2)}%; r_high = r_today × e^(1.65·σ·√days). Sandbox rates.
      </p>
    </div>
  );
}

function RouteCompare() {
  const [amount, setAmount] = useState('350');
  const [currency, setCurrency] = useState('USD');
  const [r, setR] = useState<RouteComparison | null>(null);
  const [error, setError] = useState<string | null>(null);
  const run = async () => {
    setError(null);
    try {
      setR(await api.compareRoutes(amount, currency));
    } catch (e) {
      setError((e as Error).message);
    }
  };
  return (
    <>
      <h4>Compare ways to send money</h4>
      <form className="row" onSubmit={(e) => { e.preventDefault(); run(); }}>
        <input className="grow" inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} aria-label="Amount the payee receives" />
        <select value={currency} onChange={(e) => setCurrency(e.target.value)} aria-label="Currency">
          {['USD', 'GBP', 'EUR'].map((c) => <option key={c}>{c}</option>)}
        </select>
        <button className="btn small primary">Compare</button>
      </form>
      {error && <p className="error">{error}</p>}
      {r && (
        <>
          <p className="muted small">Mid rate KES {r.midKesPerUnit.toFixed(4)} on {r.rateDate}. Illustrative fee tables, snapshot {r.ranked[0]?.route.snapshotDate}.</p>
          <ol className="routes">
            {r.ranked.map((x, i) => (
              <li key={x.route.id} className={x.eligible ? '' : 'ineligible'}>
                <div className="list-main">
                  <span>
                    {x.eligible && i === 0 && <span className="pill pill-good">Best</span>} {x.route.routeName}
                  </span>
                  <span className="num strong">{money(x.quote.sendKesMinor, 'KES')}</span>
                </div>
                <div className="list-sub">
                  Fees {money(x.quote.feeKesMinor, 'KES')} · rate margin {money(x.quote.marginCostKesMinor, 'KES')} · arrives within {x.route.arrivalHours} h
                  {!x.eligible && <> · <span className="bad">{x.reasons.join('; ')}</span></>}
                </div>
              </li>
            ))}
          </ol>
        </>
      )}
    </>
  );
}

/* ── Transactions, with categories the student can correct ── */

export function TransactionsView({ refreshKey, onChange }: { refreshKey: number; onChange: () => void }) {
  const months = Array.from({ length: 4 }, (_, i) => {
    const d = new Date();
    d.setUTCDate(1);
    d.setUTCMonth(d.getUTCMonth() - i);
    return d.toISOString().slice(0, 7);
  });
  const [month, setMonth] = useState(months[0]!);
  const [txns, setTxns] = useState<Txn[]>([]);
  const [onlyUncat, setOnlyUncat] = useState(false);

  useEffect(() => {
    api.transactions(month).then(setTxns).catch(() => setTxns([]));
  }, [month, refreshKey]);

  const correct = async (id: string, category: string) => {
    await api.setCategory(id, category);
    setTxns(await api.transactions(month));
    onChange();
  };

  const shown = onlyUncat ? txns.filter((t) => !t.category) : txns;
  const uncat = txns.filter((t) => !t.category).length;

  return (
    <div className="pad">
      <div className="section-head">
        <select value={month} onChange={(e) => setMonth(e.target.value)} aria-label="Month">
          {months.map((m) => <option key={m} value={m}>{new Date(`${m}-01T00:00:00`).toLocaleString('en-GB', { month: 'long', year: 'numeric' })}</option>)}
        </select>
        {uncat > 0 && (
          <label className="small row">
            <input type="checkbox" checked={onlyUncat} onChange={(e) => setOnlyUncat(e.target.checked)} /> {uncat} to categorise
          </label>
        )}
      </div>
      <p className="muted small">Change a category and Hela makes it a rule for that payee.</p>
      <ul className="txns">
        {shown.map((t) => (
          <li key={t.id} className={t.category ? '' : 'uncat'}>
            <div className="list-main">
              <span className="txn-payee">{t.payee}</span>
              <span className={`num ${t.amountMinor > 0 ? 'good' : ''}`}>{money(t.amountMinor, t.currency)}</span>
            </div>
            <div className="list-sub row">
              <span>{t.occurredAt.slice(0, 10)}</span>
              {t.amountMinor < 0 ? (
                <select className="mini" value={t.category ?? ''} onChange={(e) => correct(t.id, e.target.value)} aria-label={`Category for ${t.payee}`}>
                  {!t.category && <option value="">Choose…</option>}
                  {CATEGORIES.map((c) => <option key={c} value={c}>{label(c)}</option>)}
                </select>
              ) : (
                <span>Income</span>
              )}
              {t.categorySource && t.categorySource !== 'rule' && <span className="muted">· by {t.categorySource}</span>}
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}

/* ── Add payee ── */

export function AddPayeeForm({ onDone }: { onDone: (msg: string) => void }) {
  const [open, setOpen] = useState(false);
  const [f, setF] = useState({ name: '', kind: 'person', country: 'KE', currency: 'KES' });
  const [error, setError] = useState<string | null>(null);
  if (!open) return <button className="btn small" onClick={() => setOpen(true)}>Add payee</button>;
  const submit = async () => {
    setError(null);
    try {
      await api.addPayee(f);
      setOpen(false);
      setF({ name: '', kind: 'person', country: 'KE', currency: 'KES' });
      onDone(`${f.name} added. Approve it with your PIN before Hela can pay it.`);
    } catch (e) {
      setError((e as Error).message);
    }
  };
  return (
    <form className="mini-form" onSubmit={(e) => { e.preventDefault(); submit(); }}>
      <input placeholder="Name" value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} aria-label="Payee name" />
      <div className="row">
        <select value={f.kind} onChange={(e) => setF({ ...f, kind: e.target.value })} aria-label="Kind">
          <option value="person">Person</option>
          <option value="university">University</option>
          <option value="merchant">Merchant</option>
        </select>
        <input className="w-country" maxLength={2} value={f.country} onChange={(e) => setF({ ...f, country: e.target.value.toUpperCase() })} aria-label="Country code" />
        <select value={f.currency} onChange={(e) => setF({ ...f, currency: e.target.value })} aria-label="Currency">
          {['KES', 'USD', 'GBP', 'EUR', 'UGX', 'TZS'].map((c) => <option key={c}>{c}</option>)}
        </select>
      </div>
      {error && <p className="error">{error}</p>}
      <div className="row">
        <button className="btn small primary" disabled={f.name.trim().length < 2}>Save</button>
        <button type="button" className="btn small" onClick={() => setOpen(false)}>Cancel</button>
      </div>
    </form>
  );
}

/* ── Limits editor ── */

const LIMIT_FIELDS: { key: keyof Limits; text: string; loosenIfHigher: boolean }[] = [
  { key: 'perPaymentMinor', text: 'Per payment', loosenIfHigher: true },
  { key: 'dailyMinor', text: 'Daily', loosenIfHigher: true },
  { key: 'monthlyMinor', text: 'Monthly', loosenIfHigher: true },
  { key: 'minBufferMinor', text: 'Keep at least', loosenIfHigher: false },
  { key: 'otpThresholdMinor', text: 'Code needed over', loosenIfHigher: true },
];

export function LimitsDialog({
  current,
  onClose,
  requestPin,
}: {
  current: Limits;
  onClose: (msg?: string) => void;
  requestPin: (title: string) => Promise<string | null>;
}) {
  const [v, setV] = useState(() => Object.fromEntries(LIMIT_FIELDS.map((f) => [f.key, String(current[f.key] / 100)])) as Record<keyof Limits, string>);
  const [error, setError] = useState<string | null>(null);
  const parsed = Object.fromEntries(LIMIT_FIELDS.map((f) => [f.key, Math.round(Number(v[f.key].replace(/,/g, '')) * 100)])) as unknown as Limits;
  const valid = LIMIT_FIELDS.every((f) => Number.isFinite(parsed[f.key]) && parsed[f.key] >= 0);
  const loosens = LIMIT_FIELDS.some((f) => (f.loosenIfHigher ? parsed[f.key] > current[f.key] : parsed[f.key] < current[f.key]));

  const save = async () => {
    setError(null);
    let pin: string | null | undefined;
    if (loosens) {
      pin = await requestPin('Loosen your limits');
      if (pin === null) return;
    }
    try {
      await api.setLimits({ ...parsed, pin: pin ?? undefined });
      onClose(loosens ? 'Limits loosened.' : 'Limits tightened.');
    } catch (e) {
      setError((e as Error).message);
    }
  };

  return (
    <div className="modal-backdrop" role="dialog" aria-modal="true" aria-label="Edit limits">
      <form className="modal" onSubmit={(e) => { e.preventDefault(); save(); }}>
        <h2>Your limits (KES)</h2>
        <p className="muted small">Tightening takes effect at once. Loosening needs your PIN. Hela cannot change these.</p>
        {LIMIT_FIELDS.map((f) => (
          <label key={f.key} className="limit-field">
            <span>{f.text}</span>
            <input inputMode="decimal" value={v[f.key]} onChange={(e) => setV({ ...v, [f.key]: e.target.value })} />
          </label>
        ))}
        {error && <p className="error">{error}</p>}
        <div className="row end">
          <button type="button" className="btn" onClick={() => onClose()}>Cancel</button>
          <button className="btn primary" disabled={!valid}>{loosens ? 'Save with PIN' : 'Save'}</button>
        </div>
      </form>
    </div>
  );
}
