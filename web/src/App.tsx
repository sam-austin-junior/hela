import { useCallback, useEffect, useRef, useState } from 'react';
import { api, label, money, type AuditEntry, type Budget, type ChainCheck, type Proposal, type State, type TurnStep } from './api';
import { Markdown } from './Markdown';
import { ProposalCard } from './ProposalCard';
import { AddPayeeForm, LimitsDialog, PlansView, TransactionsView } from './Panels';

// One screen, one job: talk to Hela. Money facts sit beside the chat, and
// every safety control lives in a single drawer, in plain words.

interface ChatItem {
  role: 'user' | 'assistant' | 'error';
  text: string;
  proposals?: Proposal[];
}

const SUGGESTIONS = [
  'Plan my spring tuition',
  'Cheapest way to pay my USD 350 fee?',
  'How am I doing this month?',
  'Nisaidie kupanga karo yangu',
];

/** The four tiers, as a student would say them. */
const TIERS = [
  { name: 'Just look', text: 'Hela can see your money but never plans or pays.' },
  { name: 'Advise me', text: 'Hela makes plans and comparisons. It never pays.' },
  { name: 'Ask me first', text: 'Hela prepares payments. You confirm every one.' },
  { name: 'Pay within my limits', text: 'Hela pays approved payees on its own, under your limits. Anything else, it asks.' },
];

/** What each tool is doing, in the student's terms. */
const STEP_TEXT: Record<string, string> = {
  get_overview: 'Checking your accounts',
  list_transactions: 'Looking through your transactions',
  get_budget: 'Adding up your budget',
  list_invoices: 'Reading your bills',
  list_payees: 'Checking who you can pay',
  get_fx_rate: "Getting today's exchange rate",
  compare_routes: 'Comparing ways to send money',
  plan_tuition: 'Building a tuition plan',
  credit_checklist: 'Preparing your credit checklist',
  propose_payment: 'Asking the safety check about a payment',
  propose_schedule: 'Setting up a repeating payment for you to approve',
};

/* ── PIN prompt ──────────────────────────────────────────────── */

function usePin() {
  const [ask, setAsk] = useState<{ title: string; resolve: (pin: string | null) => void } | null>(null);
  const request = (title: string) => new Promise<string | null>((resolve) => setAsk({ title, resolve }));
  const dialog = ask ? <PinDialog title={ask.title} onDone={(pin) => { ask.resolve(pin); setAsk(null); }} /> : null;
  return { request, dialog };
}

function PinDialog({ title, onDone }: { title: string; onDone: (pin: string | null) => void }) {
  const [pin, setPin] = useState('');
  return (
    <div className="modal-backdrop top-layer" role="dialog" aria-modal="true" aria-label={title}>
      <form className="modal" onSubmit={(e) => { e.preventDefault(); onDone(pin); }}>
        <h2>{title}</h2>
        <p className="muted">Enter your app PIN to continue.</p>
        <input autoFocus type="password" inputMode="numeric" maxLength={8} value={pin} onChange={(e) => setPin(e.target.value)} placeholder="PIN" />
        <div className="row end">
          <button type="button" className="btn" onClick={() => onDone(null)}>Cancel</button>
          <button type="submit" className="btn primary" disabled={pin.length < 4}>Continue</button>
        </div>
      </form>
    </div>
  );
}

/* ── App ─────────────────────────────────────────────────────── */

export default function App() {
  const [state, setState] = useState<State | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const [refreshKey, setRefreshKey] = useState(0);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const pin = usePin();

  const refresh = useCallback(async () => {
    try {
      setState(await api.state());
      setLoadError(null);
      setRefreshKey((k) => k + 1);
    } catch (e) {
      setLoadError((e as Error).message);
    }
  }, []);

  useEffect(() => {
    refresh();
    if (new URLSearchParams(location.search).get('linked')) {
      setToast('Card linked.');
      history.replaceState(null, '', '/');
    }
  }, [refresh]);

  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), 4000);
    return () => clearTimeout(t);
  }, [toast]);

  const guarded = async (fn: () => Promise<unknown>, done?: string) => {
    try {
      await fn();
      if (done) setToast(done);
    } catch (e) {
      setToast((e as Error).message);
    }
    refresh();
  };

  if (!state) {
    return <div className="loading">{loadError ? `Cannot reach the Hela server: ${loadError}` : 'Loading…'}</div>;
  }

  const tier = TIERS[state.student.tier]!;

  return (
    <div className="app">
      <header className="top">
        <div className="brand">
          <span className="logo" aria-hidden>H</span>
          <span className="brand-name">Hela</span>
          <span className="pill pill-muted" title="All money movement is simulated">Demo</span>
        </div>
        <button className="safety-chip" onClick={() => setSettingsOpen(true)} title="Safety settings">
          <ShieldIcon />
          <span className="safety-text">
            <span className="safety-label">Hela can</span>
            <span className="safety-value">{tier.name}</span>
          </span>
        </button>
      </header>

      <main className="layout">
        <Chat state={state} onChange={refresh} onOpenSettings={() => setSettingsOpen(true)} />
        <MoneyPanel state={state} refreshKey={refreshKey} onChange={refresh} />
      </main>

      {settingsOpen && (
        <SettingsDrawer
          state={state}
          onClose={() => setSettingsOpen(false)}
          onAction={guarded}
          requestPin={pin.request}
          notify={(m) => {
            setToast(m);
            refresh();
          }}
        />
      )}
      {pin.dialog}
      {toast && <div className="toast" role="status">{toast}</div>}
    </div>
  );
}

function ShieldIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M12 3l8 3v6c0 4.5-3.4 8.3-8 9-4.6-.7-8-4.5-8-9V6l8-3z" />
      <path d="M9 12l2 2 4-4" />
    </svg>
  );
}

/* ── Chat ────────────────────────────────────────────────────── */

interface LiveStep {
  name: string;
  kind: string;
  state: 'running' | 'ok' | 'error';
  label?: string;
}

function Chat({ state, onChange, onOpenSettings }: { state: State; onChange: () => void; onOpenSettings: () => void }) {
  const [items, setItems] = useState<ChatItem[]>([]);
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [live, setLive] = useState<LiveStep[]>([]);
  const endRef = useRef<HTMLDivElement>(null);

  // Braces matter: newer browsers return a Promise from scrollIntoView, and an
  // effect must return nothing or a cleanup function.
  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' });
  }, [items, busy, live]);

  const onStep = (e: TurnStep) => {
    if (e.type === 'waiting') {
      // The free AI tier allows a limited amount per minute; say so instead of looking stuck.
      setLive((l) => [...l.filter((s) => s.name !== '__wait'), { name: '__wait', kind: 'wait', state: 'ok', label: `Waiting ${e.seconds}s for the free AI tier's per-minute limit` }]);
    }
    if (e.type === 'tool_start') setLive((l) => [...l.filter((s) => s.name !== '__wait'), { name: e.name, kind: e.kind, state: 'running' }]);
    if (e.type === 'tool_end') {
      setLive((l) => {
        const i = l.findIndex((s) => s.name === e.name && s.state === 'running');
        if (i < 0) return l;
        const next = [...l];
        next[i] = { ...next[i]!, state: e.ok ? 'ok' : 'error' };
        return next;
      });
    }
  };

  const send = async (text: string) => {
    const message = text.trim();
    if (!message || busy) return;
    setItems((x) => [...x, { role: 'user', text: message }]);
    setInput('');
    setBusy(true);
    setLive([]);
    try {
      const r = await api.chatStream(message, onStep);
      setItems((x) => [...x, { role: 'assistant', text: r.reply, proposals: r.proposals }]);
      onChange();
    } catch (e) {
      setItems((x) => [...x, { role: 'error', text: (e as Error).message }]);
    } finally {
      setBusy(false);
      setLive([]);
    }
  };

  const reset = async () => {
    await api.resetChat();
    setItems([]);
  };

  return (
    <section className="panel chat">
      {items.length > 0 && (
        <div className="chat-head">
          <button className="link" onClick={reset}>Start over</button>
        </div>
      )}

      <div className="messages" aria-live="polite">
        {items.length === 0 && (
          <div className="empty">
            <p className="hello">Hi {state.student.firstName}.</p>
            <p className="empty-title">What would you like to sort out today?</p>
            <div className="chips">
              {SUGGESTIONS.map((s) => (
                <button key={s} className="chip" onClick={() => send(s)} disabled={!state.modelReady}>{s}</button>
              ))}
            </div>
            {!state.modelReady && (
              <p className="notice">Chat is off in this copy: the server has no AI key. Your money panel and settings still work.</p>
            )}
            <p className="muted small">
              Hela only pays when your safety settings allow it.{' '}
              <button className="link" onClick={onOpenSettings}>See what it can do</button>
            </p>
          </div>
        )}
        {items.map((m, i) => (
          <div key={i} className={`msg msg-${m.role}`}>
            {m.role === 'assistant' ? <Markdown text={m.text} /> : <p>{m.text}</p>}
            {m.proposals?.map((p, j) => <ProposalCard key={`${i}-${j}`} initial={p} onChange={onChange} />)}
          </div>
        ))}
        {busy && (
          <div className="msg msg-assistant live" aria-live="polite">
            {live.length === 0 ? (
              <div className="typing"><span /><span /><span /></div>
            ) : (
              <ul className="steps">
                {live.map((s, i) => (
                  <li key={i} className={`step step-${s.state} tool-${s.kind}`}>
                    <span className="step-dot" aria-hidden />
                    {s.label ?? STEP_TEXT[s.name] ?? s.name.replace(/_/g, ' ')}
                    {s.state === 'running' ? '…' : s.state === 'error' ? ' (failed)' : ''}
                  </li>
                ))}
                {live.every((s) => s.state !== 'running') && (
                  <li className="step step-running"><span className="step-dot" aria-hidden />Writing the answer…</li>
                )}
              </ul>
            )}
          </div>
        )}
        <div ref={endRef} />
      </div>

      <form className="composer" onSubmit={(e) => { e.preventDefault(); send(input); }}>
        <input
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder={state.modelReady ? 'Ask Hela anything about your money…' : 'Chat is off (no AI key)'}
          disabled={busy || !state.modelReady}
          aria-label="Message Hela"
        />
        <button className="btn primary" disabled={busy || !input.trim() || !state.modelReady}>Send</button>
      </form>
    </section>
  );
}

/* ── Your money: Overview, Plans, Activity ───────────────────── */

type MoneyTab = 'overview' | 'plans' | 'activity';

function MoneyPanel({ state, refreshKey, onChange }: { state: State; refreshKey: number; onChange: () => void }) {
  const [tab, setTab] = useState<MoneyTab>('overview');
  const tabs: [MoneyTab, string][] = [
    ['overview', 'Overview'],
    ['plans', 'Plans'],
    ['activity', 'Activity'],
  ];
  return (
    <aside className="panel money">
      <div className="tabs" role="tablist">
        {tabs.map(([id, text]) => (
          <button key={id} role="tab" aria-selected={tab === id} className={tab === id ? 'active' : ''} onClick={() => setTab(id)}>
            {text}
          </button>
        ))}
      </div>
      {tab === 'overview' && <Overview state={state} refreshKey={refreshKey} />}
      {tab === 'plans' && <PlansView invoices={state.invoices} refreshKey={refreshKey} />}
      {tab === 'activity' && <Activity state={state} refreshKey={refreshKey} onChange={onChange} />}
    </aside>
  );
}

function daysUntil(date: string, today: string) {
  return Math.round((Date.parse(`${date}T00:00:00Z`) - Date.parse(`${today}T00:00:00Z`)) / 864e5);
}

function Overview({ state, refreshKey }: { state: State; refreshKey: number }) {
  const [b, setB] = useState<Budget | null>(null);
  useEffect(() => {
    api.budget(undefined, 'KES').then(setB).catch(() => setB(null));
  }, [refreshKey]);

  const total = state.accounts.filter((a) => a.currency === 'KES').reduce((s, a) => s + a.balanceMinor, 0);
  const bills = [...state.invoices].sort((x, y) => Number(x.status === 'paid') - Number(y.status === 'paid') || x.dueDate.localeCompare(y.dueDate));
  const top = b?.summary.byCategory.slice(0, 4) ?? [];
  const max = Math.max(...top.map((c) => c.spendMinor), 1);

  return (
    <div className="pad">
      <div className="balance">
        <span className="muted small">You have</span>
        <strong className="balance-value num">{money(total, 'KES')}</strong>
        <details className="accounts-detail">
          <summary className="small">{state.accounts.length} accounts</summary>
          <ul className="accounts">
            {state.accounts.map((a) => (
              <li key={a.id}>
                <span>{a.label}</span>
                <span className="num">{money(a.balanceMinor, a.currency)}</span>
              </li>
            ))}
          </ul>
        </details>
      </div>

      <section>
        <h4>Bills</h4>
        <ul className="bills">
          {bills.map((i) => {
            const d = daysUntil(i.dueDate, state.today);
            return (
              <li key={i.id}>
                <div>
                  <div>{i.issuer.replace(' (sandbox)', '')}</div>
                  <div className="muted small">
                    {i.status === 'paid' ? 'Paid' : d < 0 ? 'Overdue' : d === 0 ? 'Due today' : `Due in ${d} days`}
                  </div>
                </div>
                <span className={`num ${i.status === 'paid' ? 'muted' : 'strong'}`}>{money(i.amountMinor, i.currency)}</span>
              </li>
            );
          })}
        </ul>
      </section>

      {b && (
        <section>
          <h4>This month</h4>
          <div className="inout">
            <span>In <strong className="num">{money(b.summary.incomeMinor, 'KES')}</strong></span>
            <span>Out <strong className="num">{money(b.summary.spendMinor, 'KES')}</strong></span>
          </div>
          {b.alerts.map((a, i) => <p key={i} className="alert-line">{a.text.replace(/^./, (c) => c.toUpperCase())}.</p>)}
          <ul className="bars">
            {top.map((c) => (
              <li key={c.category}>
                <div className="bar-label">
                  <span>{label(c.category)}</span>
                  <span className="num">{money(c.spendMinor, 'KES')}</span>
                </div>
                <div className="bar-track"><div className="bar-fill" style={{ width: `${(c.spendMinor / max) * 100}%` }} /></div>
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}

function Activity({ state, refreshKey, onChange }: { state: State; refreshKey: number; onChange: () => void }) {
  const [view, setView] = useState<'payments' | 'spending' | 'log'>('payments');
  return (
    <div>
      <div className="segmented" role="radiogroup" aria-label="Show">
        {(
          [
            ['payments', 'Payments'],
            ['spending', 'Spending'],
            ['log', 'Safety log'],
          ] as const
        ).map(([id, text]) => (
          <button key={id} role="radio" aria-checked={view === id} className={view === id ? 'on' : ''} onClick={() => setView(id)}>
            {text}
          </button>
        ))}
      </div>
      {view === 'payments' && (
        <div className="pad">
          {state.proposals.length === 0 && <p className="muted small">No payments yet. Ask Hela to pay a bill and it will appear here.</p>}
          <div className="stack">
            {state.proposals.map((p) => <ProposalCard key={`${p.id}-${p.status}`} initial={p} onChange={onChange} />)}
          </div>
        </div>
      )}
      {view === 'spending' && <TransactionsView refreshKey={refreshKey} onChange={onChange} />}
      {view === 'log' && <SafetyLog refreshKey={refreshKey} />}
    </div>
  );
}

function SafetyLog({ refreshKey }: { refreshKey: number }) {
  const [rows, setRows] = useState<AuditEntry[]>([]);
  const [check, setCheck] = useState<ChainCheck | null>(null);
  useEffect(() => {
    api.audit().then(setRows).catch(() => setRows([]));
    api.verifyAudit().then(setCheck).catch(() => setCheck(null));
  }, [refreshKey]);
  return (
    <div className="pad">
      <p className={`chain ${check?.ok ? 'ok' : 'bad'}`}>
        {check
          ? check.ok
            ? `Every action is recorded and nothing has been altered (${check.entries} entries).`
            : `Warning: entry ${check.firstBrokenSeq} was altered. ${check.problem}`
          : 'Checking…'}
      </p>
      <ol className="audit">
        {rows.map((r) => (
          <li key={r.seq}>
            <div className="audit-head">
              <span className={`kind kind-${r.kind}`}>{label(r.kind)}</span>
              <span className="muted small">{new Date(r.at).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })}</span>
            </div>
            <div className="audit-body">{summarise(r)}</div>
          </li>
        ))}
      </ol>
      <a className="link small" href="/api/audit/export" download>Download the full log</a>
    </div>
  );
}

function summarise(r: AuditEntry): string {
  const d = r.data as Record<string, any>;
  switch (r.kind) {
    case 'tool_call':
      return `Hela used: ${String(d.tool).replace(/_/g, ' ')}${d.ok ? '' : ' (failed)'}`;
    case 'policy_decision':
      return `${d.outcome === 'allow' ? 'Allowed' : d.outcome === 'confirm' ? 'Asked you' : d.outcome === 'deny' ? 'Blocked' : 'Repeat ignored'}: ${d.reason ?? ''}`;
    case 'proposal_created':
      return `${(d.amountMinor / 100).toFixed(2)} ${d.currency} proposed`;
    case 'payment_executed':
      return `Paid, reference ${d.providerRef}`;
    case 'payment_failed':
      return d.reason;
    case 'tier_changed':
      return `${TIERS[d.from]?.name ?? d.from} → ${TIERS[d.to]?.name ?? d.to}`;
    default:
      return '';
  }
}

/* ── Safety settings drawer ──────────────────────────────────── */

function SettingsDrawer({
  state,
  onClose,
  onAction,
  requestPin,
  notify,
}: {
  state: State;
  onClose: () => void;
  onAction: (fn: () => Promise<unknown>, done?: string) => void;
  requestPin: (title: string) => Promise<string | null>;
  notify: (msg: string) => void;
}) {
  const l = state.student.limits;
  const [editLimits, setEditLimits] = useState(false);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const changeTier = async (to: number) => {
    if (to === state.student.tier) return;
    let p: string | null | undefined;
    if (to > state.student.tier) {
      p = await requestPin(`Let Hela “${TIERS[to]!.name.toLowerCase()}”`);
      if (p === null) return;
    }
    onAction(() => api.setTier(to, p ?? undefined), `Hela can now: ${TIERS[to]!.name.toLowerCase()}.`);
  };

  const withPin = async (title: string, fn: (pin: string) => Promise<unknown>, done: string) => {
    const p = await requestPin(title);
    if (p) onAction(() => fn(p), done);
  };

  const link = () =>
    onAction(async () => {
      const r = await api.linkPaymentMethod();
      if (r.url) location.href = r.url;
    }, state.provider === 'simulated' ? 'Demo card linked.' : undefined);

  return (
    <div className="drawer-backdrop" onClick={onClose}>
      <aside className="drawer" role="dialog" aria-modal="true" aria-label="Safety settings" onClick={(e) => e.stopPropagation()}>
        <div className="drawer-head">
          <h2>Safety settings</h2>
          <button className="btn small" onClick={onClose}>Done</button>
        </div>
        <p className="muted small">Only you can change these. Hela can't, even if someone asks it to.</p>

        <section>
          <h4>What Hela is allowed to do</h4>
          <div className="tier-options" role="radiogroup">
            {TIERS.map((t, i) => (
              <button key={t.name} role="radio" aria-checked={state.student.tier === i} className={`tier-option ${state.student.tier === i ? 'on' : ''}`} onClick={() => changeTier(i)}>
                <span className="tier-radio" aria-hidden />
                <span>
                  <span className="tier-name">{t.name}</span>
                  <span className="tier-text">{t.text}</span>
                </span>
              </button>
            ))}
          </div>
          <p className="muted small">Giving Hela more freedom needs your PIN. Taking it away never does.</p>
        </section>

        <section>
          <div className="section-head">
            <h4>Spending limits</h4>
            <button className="link" onClick={() => setEditLimits(true)}>Change</button>
          </div>
          <dl className="limits">
            <dt>Largest single payment</dt><dd className="num">{money(l.perPaymentMinor!, 'KES')}</dd>
            <dt>Per day</dt><dd className="num">{money(l.dailyMinor!, 'KES')}</dd>
            <dt>Per month</dt><dd className="num">{money(l.monthlyMinor!, 'KES')}</dd>
            <dt>Always keep</dt><dd className="num">{money(l.minBufferMinor!, 'KES')}</dd>
            <dt>Ask for a code above</dt><dd className="num">{money(l.otpThresholdMinor!, 'KES')}</dd>
          </dl>
        </section>

        <section>
          <div className="section-head">
            <h4>Who Hela can pay</h4>
            <AddPayeeForm onDone={notify} />
          </div>
          <ul className="list">
            {state.payees.map((p) => (
              <li key={p.id} className="list-main">
                <span>
                  {p.name.replace(' (sandbox)', '')}
                  <span className="muted small"> · {p.currency}</span>
                </span>
                {p.approved ? (
                  <span className="pill pill-good">Approved</span>
                ) : (
                  <button className="btn small" onClick={() => withPin(`Approve ${p.name}`, (pin) => api.approvePayee(p.id, pin), `${p.name} approved.`)}>
                    Approve
                  </button>
                )}
              </li>
            ))}
          </ul>
        </section>

        {state.schedules.length > 0 && (
          <section>
            <div className="section-head">
              <h4>Repeating payments</h4>
              {state.schedules.some((s) => s.status === 'active') && (
                <button className="link" onClick={() => onAction(() => api.runSchedules(), 'Ran the payments that are due.')}>Run due now</button>
              )}
            </div>
            <ul className="list">
              {state.schedules.map((s) => (
                <li key={s.id}>
                  <div className="list-main">
                    <span>{s.payee.name}</span>
                    <span className="num">{money(s.amountMinor, s.currency)}</span>
                  </div>
                  <div className="list-sub">Every {s.intervalDays} days · next {s.nextRun} · {label(s.status)}</div>
                  <div className="row">
                    {s.status === 'pending_approval' && (
                      <button className="btn small primary" onClick={() => withPin('Approve this repeating payment', (pin) => api.approveSchedule(s.id, pin), 'Approved.')}>Approve</button>
                    )}
                    {s.status !== 'revoked' && <button className="btn small" onClick={() => onAction(() => api.revokeSchedule(s.id), 'Stopped.')}>Stop</button>}
                  </div>
                </li>
              ))}
            </ul>
          </section>
        )}

        <section>
          <h4>Card and data</h4>
          <div className="list-main">
            <span>{state.paymentMethod ?? 'No card linked'}</span>
            {!state.paymentMethod && <button className="btn small" onClick={link}>Link a test card</button>}
          </div>
          <a className="link small" href="/api/export" download>Download everything Hela knows about you</a>
        </section>

        {editLimits && (
          <LimitsDialog
            current={{
              perPaymentMinor: l.perPaymentMinor!,
              dailyMinor: l.dailyMinor!,
              monthlyMinor: l.monthlyMinor!,
              minBufferMinor: l.minBufferMinor!,
              otpThresholdMinor: l.otpThresholdMinor!,
            }}
            requestPin={requestPin}
            onClose={(msg) => {
              setEditLimits(false);
              if (msg) notify(msg);
            }}
          />
        )}
      </aside>
    </div>
  );
}
