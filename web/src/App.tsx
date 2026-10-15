import { useCallback, useEffect, useRef, useState } from 'react';
import { api, label, money, type AuditEntry, type Budget, type ChainCheck, type Proposal, type State, type TurnStep } from './api';
import { Markdown } from './Markdown';
import { ProposalCard } from './ProposalCard';
import { AddPayeeForm, LimitsDialog, PlansView, TransactionsView } from './Panels';

interface ChatItem {
  role: 'user' | 'assistant' | 'error';
  text: string;
  proposals?: Proposal[];
  tools?: { name: string; kind: string; ok: boolean }[];
}

const SUGGESTIONS = [
  'Plan my spring tuition',
  'What is the cheapest way to pay my USD 350 registration fee?',
  'How am I doing this month?',
  'Pay my November rent invoice',
  'Help me build my credit',
  'Nisaidie kupanga karo yangu',
];

/** What each tool is doing, in the student's terms. */
const STEP_TEXT: Record<string, string> = {
  get_overview: 'Checking your accounts and limits',
  list_transactions: 'Looking through your transactions',
  get_budget: 'Adding up your budget',
  list_invoices: 'Reading your invoices',
  list_payees: 'Checking your saved payees',
  get_fx_rate: "Getting today's exchange rate",
  compare_routes: 'Comparing ways to send money',
  plan_tuition: 'Building a tuition plan',
  credit_checklist: 'Preparing your credit checklist',
  propose_payment: 'Sending a payment to the policy engine',
  propose_schedule: 'Setting up a schedule for your approval',
};

interface LiveStep {
  name: string;
  kind: string;
  state: 'running' | 'ok' | 'error';
}

const TIERS = ['Read only', 'Advise', 'Act with confirmation', 'Act within limits'];

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
    <div className="modal-backdrop" role="dialog" aria-modal="true" aria-label={title}>
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
      setToast('Payment method linked.');
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

  const changeTier = async (tier: number) => {
    if (tier === state.student.tier) return;
    let p: string | null | undefined;
    if (tier > state.student.tier) {
      p = await pin.request(`Raise tier to “${TIERS[tier]}”`);
      if (p === null) return;
    }
    guarded(() => api.setTier(tier, p ?? undefined), `Tier is now “${TIERS[tier]}”.`);
  };

  return (
    <div className="app">
      <header className="top">
        <div className="brand">
          <span className="logo" aria-hidden>H</span>
          <div>
            <div className="brand-name">Hela</div>
            <div className="brand-sub">Student finance agent</div>
          </div>
        </div>
        <div className="top-right">
          <span className="pill pill-muted" title="All money movement is in a sandbox">
            Sandbox · {state.provider === 'paystack_test' ? 'Paystack test mode' : 'simulated payments'}
          </span>
          <label className="tier-select">
            <span>Permission tier</span>
            <select value={state.student.tier} onChange={(e) => changeTier(Number(e.target.value))}>
              {TIERS.map((t, i) => (
                <option key={t} value={i}>{i} · {t}</option>
              ))}
            </select>
          </label>
        </div>
      </header>

      <main className="layout">
        <Sidebar state={state} onAction={guarded} requestPin={pin.request} notify={(m) => { setToast(m); refresh(); }} />
        <Chat state={state} onChange={refresh} />
        <Insights refreshKey={refreshKey} invoices={state.invoices} onChange={refresh} />
      </main>

      {pin.dialog}
      {toast && <div className="toast" role="status">{toast}</div>}
    </div>
  );
}

/* ── Sidebar: accounts, limits, invoices, payees, schedules ──── */

function Sidebar({
  state,
  onAction,
  requestPin,
  notify,
}: {
  state: State;
  onAction: (fn: () => Promise<unknown>, done?: string) => void;
  requestPin: (title: string) => Promise<string | null>;
  notify: (msg: string) => void;
}) {
  const l = state.student.limits;
  const [editLimits, setEditLimits] = useState(false);
  const withPin = async (title: string, fn: (pin: string) => Promise<unknown>, done: string) => {
    const p = await requestPin(title);
    if (p) onAction(() => fn(p), done);
  };
  const link = () =>
    onAction(async () => {
      const r = await api.linkPaymentMethod();
      if (r.url) location.href = r.url;
    }, state.provider === 'simulated' ? 'Sandbox card linked.' : undefined);

  return (
    <aside className="panel side">
      <section>
        <h3>Hello, {state.student.firstName}</h3>
        <ul className="accounts">
          {state.accounts.map((a) => (
            <li key={a.id}>
              <span>{a.label}</span>
              <span className="num">{money(a.balanceMinor, a.currency)}</span>
            </li>
          ))}
        </ul>
      </section>

      <section>
        <div className="section-head">
          <h4>Limits the agent cannot change</h4>
          <button className="btn small" onClick={() => setEditLimits(true)}>Edit</button>
        </div>
        <dl className="limits">
          <dt>Per payment</dt><dd className="num">{money(l.perPaymentMinor!, 'KES')}</dd>
          <dt>Daily</dt><dd className="num">{money(l.dailyMinor!, 'KES')}</dd>
          <dt>Monthly</dt><dd className="num">{money(l.monthlyMinor!, 'KES')}</dd>
          <dt>Keep at least</dt><dd className="num">{money(l.minBufferMinor!, 'KES')}</dd>
          <dt>Code needed over</dt><dd className="num">{money(l.otpThresholdMinor!, 'KES')}</dd>
        </dl>
        <div className="method">
          {state.paymentMethod ? (
            <span className="muted">Paying with {state.paymentMethod}</span>
          ) : (
            <button className="btn small" onClick={link}>Link a test card</button>
          )}
        </div>
      </section>

      <section>
        <h4>Invoices</h4>
        <ul className="list">
          {state.invoices.map((i) => (
            <li key={i.id}>
              <div className="list-main">
                <span>{i.issuer}</span>
                <span className="num">{money(i.amountMinor, i.currency)}</span>
              </div>
              <div className="list-sub">
                Due {i.dueDate} · {i.status === 'paid' ? <span className="good">paid</span> : 'open'}
              </div>
            </li>
          ))}
        </ul>
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

      <section>
        <div className="section-head">
          <h4>Payees</h4>
          <AddPayeeForm onDone={notify} />
        </div>
        <ul className="list">
          {state.payees.map((p) => (
            <li key={p.id}>
              <div className="list-main">
                <span>{p.name}</span>
                {p.approved ? (
                  <span className="pill pill-good">approved</span>
                ) : (
                  <button className="btn small" onClick={() => withPin(`Approve ${p.name}`, (pin) => api.approvePayee(p.id, pin), `${p.name} approved.`)}>
                    Approve
                  </button>
                )}
              </div>
              <div className="list-sub">{p.currency} · {label(p.kind)} · added {p.createdAt.slice(0, 10)}</div>
            </li>
          ))}
        </ul>
      </section>

      {state.proposals.length > 0 && (
        <section>
          <h4>Recent payments</h4>
          <div className="stack">
            {state.proposals.slice(0, 6).map((p) => (
              <ProposalCard key={`${p.id}-${p.status}`} initial={p} onChange={() => onAction(async () => {})} />
            ))}
          </div>
        </section>
      )}

      <section>
        <div className="section-head">
          <h4>Scheduled payments</h4>
          {state.schedules.some((s) => s.status === 'active') && (
            <button className="btn small" onClick={() => onAction(() => api.runSchedules(), 'Ran the payments that are due.')}>Run due now</button>
          )}
        </div>
        {state.schedules.length === 0 && <p className="muted small">None yet. Ask Hela to set up weekly tuition savings.</p>}
        <ul className="list">
          {state.schedules.map((s) => (
            <li key={s.id}>
              <div className="list-main">
                <span>{s.payee.name}</span>
                <span className="num">{money(s.amountMinor, s.currency)}</span>
              </div>
              <div className="list-sub">
                Every {s.intervalDays} days · next {s.nextRun} · {label(s.status)}
              </div>
              <div className="row">
                {s.status === 'pending_approval' && (
                  <button className="btn small primary" onClick={() => withPin('Approve this schedule', (pin) => api.approveSchedule(s.id, pin), 'Schedule approved.')}>
                    Approve
                  </button>
                )}
                {s.status !== 'revoked' && (
                  <button className="btn small" onClick={() => onAction(() => api.revokeSchedule(s.id), 'Schedule revoked.')}>Revoke</button>
                )}
              </div>
            </li>
          ))}
        </ul>
      </section>

      <section>
        <h4>Your data</h4>
        <a className="btn small" href="/api/export" download>Download my data (JSON)</a>
      </section>
    </aside>
  );
}

/* ── Chat ────────────────────────────────────────────────────── */

function Chat({ state, onChange }: { state: State; onChange: () => void }) {
  const [items, setItems] = useState<ChatItem[]>([]);
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [live, setLive] = useState<LiveStep[]>([]);
  const endRef = useRef<HTMLDivElement>(null);

  useEffect(() => endRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' }), [items, busy, live]);

  const onStep = (e: TurnStep) => {
    if (e.type === 'tool_start') setLive((l) => [...l, { name: e.name, kind: e.kind, state: 'running' }]);
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
      setItems((x) => [...x, { role: 'assistant', text: r.reply, proposals: r.proposals, tools: r.tools }]);
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
      <div className="chat-head">
        <div>
          <h3>Ask Hela</h3>
          <p className="muted small">Tier {state.student.tier} · {state.student.tierName}</p>
        </div>
        {items.length > 0 && <button className="btn small" onClick={reset}>New conversation</button>}
      </div>

      <div className="messages" aria-live="polite">
        {items.length === 0 && (
          <div className="empty">
            <p className="empty-title">Plan tuition, send money abroad, see where your money goes, and build credit.</p>
            {!state.modelReady && (
              <p className="error">The AI model is not configured on the server. Set ANTHROPIC_API_KEY and restart. The panels still work.</p>
            )}
            <div className="chips">
              {SUGGESTIONS.map((s) => (
                <button key={s} className="chip" onClick={() => send(s)} disabled={!state.modelReady}>{s}</button>
              ))}
            </div>
          </div>
        )}
        {items.map((m, i) => (
          <div key={i} className={`msg msg-${m.role}`}>
            {m.role === 'assistant' ? <Markdown text={m.text} /> : <p>{m.text}</p>}
            {m.tools && m.tools.length > 0 && (
              <div className="tools">
                {m.tools.map((t, j) => (
                  <span key={j} className={`tool tool-${t.kind}`} title={`${t.kind} tool${t.ok ? '' : ' (error)'}`}>
                    {t.name.replace(/_/g, ' ')}
                  </span>
                ))}
              </div>
            )}
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
                    {STEP_TEXT[s.name] ?? s.name.replace(/_/g, ' ')}
                    {s.state === 'running' ? '…' : s.state === 'error' ? ' (failed)' : ''}
                  </li>
                ))}
                {live.every((s) => s.state !== 'running') && <li className="step step-running"><span className="step-dot" aria-hidden />Writing the answer…</li>}
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
          placeholder={state.modelReady ? 'Ask about tuition, transfers, your budget or credit…' : 'AI model not configured'}
          disabled={busy || !state.modelReady}
          aria-label="Message Hela"
        />
        <button className="btn primary" disabled={busy || !input.trim() || !state.modelReady}>Send</button>
      </form>
    </section>
  );
}

/* ── Insights: budget and audit ──────────────────────────────── */

type InsightTab = 'budget' | 'transactions' | 'plans' | 'audit';

function Insights({ refreshKey, invoices, onChange }: { refreshKey: number; invoices: State['invoices']; onChange: () => void }) {
  const [tab, setTab] = useState<InsightTab>('budget');
  const tabs: [InsightTab, string][] = [
    ['budget', 'Budget'],
    ['transactions', 'Spending'],
    ['plans', 'Plans'],
    ['audit', 'Audit'],
  ];
  return (
    <aside className="panel insights">
      <div className="tabs" role="tablist">
        {tabs.map(([id, text]) => (
          <button key={id} role="tab" aria-selected={tab === id} className={tab === id ? 'active' : ''} onClick={() => setTab(id)}>
            {text}
          </button>
        ))}
      </div>
      {tab === 'budget' && <BudgetView refreshKey={refreshKey} />}
      {tab === 'transactions' && <TransactionsView refreshKey={refreshKey} onChange={onChange} />}
      {tab === 'plans' && <PlansView invoices={invoices} refreshKey={refreshKey} />}
      {tab === 'audit' && <AuditView refreshKey={refreshKey} />}
    </aside>
  );
}

function BudgetView({ refreshKey }: { refreshKey: number }) {
  const [currency, setCurrency] = useState('KES');
  const [b, setB] = useState<Budget | null>(null);
  useEffect(() => {
    api.budget(undefined, currency).then(setB).catch(() => setB(null));
  }, [currency, refreshKey]);
  if (!b) return <p className="muted pad">Loading…</p>;
  const s = b.summary;
  const max = Math.max(...s.byCategory.map((c) => c.spendMinor), 1);
  return (
    <div className="pad">
      <div className="section-head">
        <h4>{new Date(`${s.month}-01T00:00:00`).toLocaleString('en-GB', { month: 'long', year: 'numeric' })}</h4>
        <select value={currency} onChange={(e) => setCurrency(e.target.value)} aria-label="Show in currency">
          {['KES', 'USD', 'GBP', 'EUR'].map((c) => <option key={c}>{c}</option>)}
        </select>
      </div>
      <div className="stats">
        <div><span className="muted small">In</span><strong className="num">{money(s.incomeMinor, s.currency)}</strong></div>
        <div><span className="muted small">Out</span><strong className="num">{money(s.spendMinor, s.currency)}</strong></div>
        <div><span className="muted small">Net</span><strong className={`num ${s.netMinor < 0 ? 'bad' : 'good'}`}>{money(s.netMinor, s.currency)}</strong></div>
      </div>
      {b.alerts.length > 0 && (
        <ul className="alerts">
          {b.alerts.map((a, i) => <li key={i}>{a.text}</li>)}
        </ul>
      )}
      <ul className="bars">
        {s.byCategory.map((c) => {
          const budget = currency === 'KES' ? b.budgets.find((x) => x.category === c.category) : undefined;
          const over = budget && c.spendMinor > budget.monthlyMinor;
          return (
            <li key={c.category}>
              <div className="bar-label">
                <span>{label(c.category)}</span>
                <span className="num">{money(c.spendMinor, s.currency)}</span>
              </div>
              <div className="bar-track">
                <div className={`bar-fill ${over ? 'over' : ''}`} style={{ width: `${(c.spendMinor / max) * 100}%` }} />
                {budget && <div className="bar-budget" style={{ left: `${Math.min((budget.monthlyMinor / max) * 100, 100)}%` }} title={`Budget ${money(budget.monthlyMinor, 'KES')}`} />}
              </div>
            </li>
          );
        })}
      </ul>
      <h4>Recurring</h4>
      <ul className="list">
        {b.recurring.map((r) => (
          <li key={r.payee}>
            <div className="list-main">
              <span>{r.payee}</span>
              <span className="num">{money(r.typicalMinor, r.currency)}</span>
            </div>
            <div className="list-sub">Every ~{r.intervalDays} days · next {r.nextDate}</div>
          </li>
        ))}
      </ul>
      {b.uncategorised > 0 && <p className="muted small">{b.uncategorised} transactions not yet categorised.</p>}
    </div>
  );
}

function AuditView({ refreshKey }: { refreshKey: number }) {
  const [rows, setRows] = useState<AuditEntry[]>([]);
  const [check, setCheck] = useState<ChainCheck | null>(null);
  useEffect(() => {
    api.audit().then(setRows).catch(() => setRows([]));
    api.verifyAudit().then(setCheck).catch(() => setCheck(null));
  }, [refreshKey]);
  return (
    <div className="pad">
      <div className={`chain ${check?.ok ? 'ok' : 'bad'}`}>
        {check ? (
          check.ok ? (
            <>Hash chain verified · {check.entries} entries · head <span className="mono">{check.headHash.slice(0, 12)}…</span></>
          ) : (
            <>Chain broken at entry {check.firstBrokenSeq}: {check.problem}</>
          )
        ) : (
          'Checking…'
        )}
      </div>
      <a className="btn small" href="/api/audit/export" download>Export log (JSON)</a>
      <ol className="audit">
        {rows.map((r) => (
          <li key={r.seq}>
            <div className="audit-head">
              <span className={`kind kind-${r.kind}`}>{label(r.kind)}</span>
              <span className="muted small">#{r.seq} · {new Date(r.at).toLocaleTimeString('en-GB')}</span>
            </div>
            <div className="audit-body">{summarise(r)}</div>
          </li>
        ))}
      </ol>
    </div>
  );
}

function summarise(r: AuditEntry): string {
  const d = r.data as Record<string, any>;
  switch (r.kind) {
    case 'tool_call':
      return `${d.toolKind} tool ${d.tool}${d.ok ? '' : ' (error)'}`;
    case 'policy_decision':
      return `${d.stage}: ${d.outcome} — ${d.reason ?? ''}`;
    case 'proposal_created':
      return `${d.proposalId}: ${(d.amountMinor / 100).toFixed(2)} ${d.currency}`;
    case 'payment_executed':
      return `${d.provider} ref ${d.providerRef}`;
    case 'payment_failed':
      return d.reason;
    case 'tier_changed':
      return `${d.from} → ${d.to}`;
    default:
      return Object.entries(d)
        .slice(0, 3)
        .map(([k, v]) => `${k}: ${typeof v === 'object' ? JSON.stringify(v) : v}`)
        .join(' · ');
  }
}
