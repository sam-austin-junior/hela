import Fastify, { type FastifyInstance } from 'fastify';
import fastifyStatic from '@fastify/static';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { withTx, type Db } from './db.js';
import { clock } from './clock.js';
import { config, modelName } from './config.js';
import { appendAudit, audit, verifyChain } from './audit/log.js';
import { TIER_NAMES, type Tier } from './policy/engine.js';
import type { PaymentAdapter } from './payments/adapter.js';
import { checkPin } from './security/pin.js';
import { parseAmount, isCurrency } from './domain/money.js';
import { isCategory } from './domain/budget.js';
import { getAccounts, getInvoices, getPayees, getStudent, getTransactions } from './services/data.js';
import { budgetView, compareRoutesFor, correctCategory, tuitionPlan } from './services/finance.js';
import { cancelProposal, ConfirmError, confirmProposal, getProposalView } from './services/payments.js';
import { listSchedules, runDueSchedules, setScheduleStatus } from './services/schedules.js';
import { resetConversation, runTurn, type ModelClient } from './agent/orchestrator.js';

export const DEMO_STUDENT_ID = 'stu_demo';

export interface AppDeps {
  db: Db;
  adapter: PaymentAdapter;
  model: ModelClient | null;
  /** The signed-in student. The demo has one; a real deployment would use sessions. */
  studentId?: string;
}

class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

export function buildApp(deps: AppDeps): FastifyInstance {
  const { db, adapter } = deps;
  const studentId = deps.studentId ?? DEMO_STUDENT_ID;
  const app = Fastify({ logger: false, bodyLimit: 64 * 1024 });

  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof HttpError) return reply.status(err.status).send({ error: err.message });
    if (err instanceof ConfirmError) return reply.status(409).send({ error: err.message });
    if (err instanceof z.ZodError) return reply.status(400).send({ error: err.issues.map((i) => i.message).join('; ') });
    app.log.error(err);
    return reply.status(500).send({ error: (err as Error).message });
  });

  // Five wrong PINs lock PIN-protected actions for 15 minutes.
  const PIN_MAX_FAILS = 5;
  const PIN_LOCK_MS = 15 * 60_000;
  const pinState = { fails: 0, lockedUntil: 0 };
  const requirePin = async (pin: unknown) => {
    const now = clock.now().getTime();
    if (now < pinState.lockedUntil) {
      throw new HttpError(429, `Too many wrong PINs. Try again after ${new Date(pinState.lockedUntil).toISOString().slice(11, 16)} UTC.`);
    }
    const s = (await getStudent(db, studentId))!;
    if (typeof pin !== 'string' || !checkPin(pin, s.pinHash)) {
      pinState.fails++;
      if (pinState.fails >= PIN_MAX_FAILS) {
        pinState.lockedUntil = now + PIN_LOCK_MS;
        pinState.fails = 0;
        await audit(db, { studentId, kind: 'student_denied', data: { reason: 'PIN locked after repeated failures' } });
      }
      throw new HttpError(403, 'PIN is not right.');
    }
    pinState.fails = 0;
  };

  app.get('/api/state', async () => {
    const s = (await getStudent(db, studentId))!;
    const method = (await db.query('SELECT label FROM payment_methods WHERE student_id = $1', [studentId])).rows[0];
    const proposals = (
      await db.query('SELECT id FROM proposals WHERE student_id = $1 ORDER BY created_at DESC LIMIT 20', [studentId])
    ).rows;
    return {
      today: clock.today(),
      student: {
        firstName: s.firstName,
        homeCurrency: s.homeCurrency,
        tier: s.tier,
        tierName: TIER_NAMES[s.tier],
        limits: {
          perPaymentMinor: s.perPaymentCapMinor,
          dailyMinor: s.dailyCapMinor,
          monthlyMinor: s.monthlyCapMinor,
          minBufferMinor: s.minBufferMinor,
          otpThresholdMinor: s.otpThresholdMinor,
        },
      },
      accounts: await getAccounts(db, studentId),
      paymentMethod: method?.label ?? null,
      provider: adapter.name,
      modelReady: deps.model !== null,
      payees: await getPayees(db, studentId),
      invoices: (await getInvoices(db, studentId)).map(({ rawText, ...i }) => ({ ...i, rawText })),
      schedules: await listSchedules(db, studentId),
      proposals: await Promise.all(proposals.map((p) => getProposalView(db, p.id))),
    };
  });

  app.get('/api/budget', async (req) => {
    const q = z.object({ month: z.string().regex(/^\d{4}-\d{2}$/).optional(), currency: z.string().optional() }).parse(req.query);
    return budgetView(db, studentId, q.month, q.currency);
  });

  app.get('/api/transactions', async (req) => {
    const q = z.object({ month: z.string().regex(/^\d{4}-\d{2}$/).optional() }).parse(req.query);
    const txns = await getTransactions(db, studentId);
    return q.month ? txns.filter((t) => t.occurredAt.startsWith(q.month!)) : txns;
  });

  app.post('/api/transactions/:id/category', async (req) => {
    const { id } = req.params as { id: string };
    const { category } = z.object({ category: z.string().refine(isCategory, 'Unknown category') }).parse(req.body);
    const left = await correctCategory(db, studentId, id, category);
    await audit(db, { studentId, kind: 'category_corrected', data: { transactionId: id, category } });
    return { ok: true, uncategorised: left };
  });

  app.post('/api/chat', async (req, reply) => {
    if (!deps.model) {
      return reply.status(503).send({ error: 'The AI model is not configured. Set ANTHROPIC_API_KEY and restart.' });
    }
    const { message } = z.object({ message: z.string().min(1).max(4000) }).parse(req.body);
    return runTurn(db, deps.model, adapter, studentId, message);
  });

  // The same turn as /api/chat, streamed as server-sent events so the app can
  // show each step while the agent works: event "step", then one "done".
  app.post('/api/chat/stream', async (req, reply) => {
    if (!deps.model) {
      return reply.status(503).send({ error: 'The AI model is not configured. Set ANTHROPIC_API_KEY and restart.' });
    }
    const { message } = z.object({ message: z.string().min(1).max(4000) }).parse(req.body);
    reply.hijack();
    const res = reply.raw;
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    const send = (event: string, data: unknown) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    try {
      const result = await runTurn(db, deps.model, adapter, studentId, message, (e) => send('step', e));
      send('done', result);
    } catch (err) {
      send('error', { error: (err as Error).message });
    } finally {
      res.end();
    }
  });

  app.post('/api/chat/reset', async () => {
    await resetConversation(db, studentId);
    return { ok: true };
  });

  app.get('/api/proposals/:id', async (req) => {
    const v = await getProposalView(db, (req.params as { id: string }).id);
    if (!v) throw new HttpError(404, 'Not found');
    return v;
  });

  app.post('/api/proposals/:id/confirm', async (req) => {
    const { otp } = z.object({ otp: z.string().max(12).optional() }).parse(req.body ?? {});
    return confirmProposal(db, adapter, studentId, (req.params as { id: string }).id, otp);
  });

  app.post('/api/proposals/:id/cancel', async (req) => cancelProposal(db, studentId, (req.params as { id: string }).id));

  app.post('/api/tier', async (req) => {
    const { tier, pin } = z.object({ tier: z.number().int().min(0).max(3), pin: z.string().optional() }).parse(req.body);
    const s = (await getStudent(db, studentId))!;
    // Raising the tier needs re-authentication; lowering it never does.
    if (tier > s.tier) await requirePin(pin);
    await withTx(db, async (tx) => {
      await tx.query('UPDATE students SET tier = $2 WHERE id = $1', [studentId, tier]);
      await appendAudit(tx, { studentId, kind: 'tier_changed', data: { from: s.tier, to: tier as Tier } });
    });
    return { tier, tierName: TIER_NAMES[tier as Tier] };
  });

  app.post('/api/payees', async (req) => {
    const b = z
      .object({
        name: z.string().min(2).max(80),
        kind: z.enum(['university', 'person', 'merchant']),
        country: z.string().length(2),
        currency: z.string().refine(isCurrency, 'Unsupported currency'),
      })
      .parse(req.body);
    const id = `pay_${randomUUID().slice(0, 8)}`;
    await withTx(db, async (tx) => {
      // A new payee starts unapproved; only the student can approve it, with the PIN.
      await tx.query(
        'INSERT INTO payees (id, student_id, name, kind, country, currency, approved, created_at) VALUES ($1,$2,$3,$4,$5,$6,false,$7)',
        [id, studentId, b.name, b.kind, b.country.toUpperCase(), b.currency, clock.now()],
      );
      await appendAudit(tx, { studentId, kind: 'payee_added', data: { payeeId: id, ...b } });
    });
    return { id };
  });

  app.post('/api/limits', async (req) => {
    const minor = z.number().int().min(0).max(1_000_000_000_00);
    const b = z
      .object({
        perPaymentMinor: minor,
        dailyMinor: minor,
        monthlyMinor: minor,
        minBufferMinor: minor,
        otpThresholdMinor: minor,
        pin: z.string().optional(),
      })
      .parse(req.body);
    if (!(b.perPaymentMinor <= b.dailyMinor && b.dailyMinor <= b.monthlyMinor)) {
      throw new HttpError(400, 'The per-payment cap must not exceed the daily cap, nor the daily cap the monthly cap.');
    }
    const s = (await getStudent(db, studentId))!;
    const next = {
      perPaymentMinor: b.perPaymentMinor,
      dailyMinor: b.dailyMinor,
      monthlyMinor: b.monthlyMinor,
      minBufferMinor: b.minBufferMinor,
      otpThresholdMinor: b.otpThresholdMinor,
    };
    const prev = {
      perPaymentMinor: s.perPaymentCapMinor,
      dailyMinor: s.dailyCapMinor,
      monthlyMinor: s.monthlyCapMinor,
      minBufferMinor: s.minBufferMinor,
      otpThresholdMinor: s.otpThresholdMinor,
    };
    // Loosening any control needs the PIN; tightening never does.
    const loosens =
      next.perPaymentMinor > prev.perPaymentMinor ||
      next.dailyMinor > prev.dailyMinor ||
      next.monthlyMinor > prev.monthlyMinor ||
      next.minBufferMinor < prev.minBufferMinor ||
      next.otpThresholdMinor > prev.otpThresholdMinor;
    if (loosens) await requirePin(b.pin);
    await withTx(db, async (tx) => {
      await tx.query(
        `UPDATE students SET per_payment_cap_minor = $2, daily_cap_minor = $3, monthly_cap_minor = $4,
                             min_buffer_minor = $5, otp_threshold_minor = $6 WHERE id = $1`,
        [studentId, next.perPaymentMinor, next.dailyMinor, next.monthlyMinor, next.minBufferMinor, next.otpThresholdMinor],
      );
      await appendAudit(tx, { studentId, kind: 'limits_changed', data: { from: prev, to: next, withPin: loosens } });
    });
    return { ...next, loosened: loosens };
  });

  // Everything Hela holds about the student, as one JSON file.
  app.get('/api/export', async (_req, reply) => {
    const q = (sql: string) => db.query(sql, [studentId]).then((r) => r.rows);
    const { pinHash: _pin, ...student } = (await getStudent(db, studentId))!;
    const data = {
      exportedAt: clock.now().toISOString(),
      student,
      accounts: await q('SELECT id, kind, label, currency, balance_minor FROM accounts WHERE student_id = $1'),
      transactions: await q('SELECT id, account_id, occurred_at, amount_minor, currency, payee, description, category, category_source FROM transactions WHERE student_id = $1 ORDER BY occurred_at'),
      payees: await q('SELECT id, name, kind, country, currency, approved, created_at FROM payees WHERE student_id = $1'),
      invoices: await q('SELECT id, issuer, reference, amount_minor, currency, due_date, status FROM invoices WHERE student_id = $1'),
      plans: await q('SELECT id, kind, payload, created_at FROM plans WHERE student_id = $1'),
      payments: await q('SELECT id, origin, payee_id, amount_minor, currency, debit_minor, fee_minor, status, provider_ref, created_at FROM proposals WHERE student_id = $1 ORDER BY created_at'),
      schedules: await q('SELECT id, payee_id, amount_minor, currency, interval_days, next_run, status FROM scheduled_payments WHERE student_id = $1'),
      conversation: (await q('SELECT messages FROM conversations WHERE student_id = $1'))[0]?.messages ?? [],
    };
    await audit(db, { studentId, kind: 'data_exported', data: { sections: Object.keys(data).length } });
    reply.header('Content-Disposition', `attachment; filename="hela-my-data-${clock.today()}.json"`);
    return data;
  });

  app.post('/api/payees/:id/approve', async (req) => {
    await requirePin((req.body as { pin?: string } | undefined)?.pin);
    const { id } = req.params as { id: string };
    await withTx(db, async (tx) => {
      const r = await tx.query('UPDATE payees SET approved = true WHERE id = $1 AND student_id = $2', [id, studentId]);
      if (r.rowCount === 0) throw new HttpError(404, 'Payee not found');
      await appendAudit(tx, { studentId, kind: 'payee_approved', data: { payeeId: id } });
    });
    return { ok: true };
  });

  app.post('/api/schedules/:id/approve', async (req) => {
    await requirePin((req.body as { pin?: string } | undefined)?.pin);
    await setScheduleStatus(db, studentId, (req.params as { id: string }).id, 'active');
    return { ok: true };
  });

  app.post('/api/schedules/:id/revoke', async (req) => {
    await setScheduleStatus(db, studentId, (req.params as { id: string }).id, 'revoked');
    return { ok: true };
  });

  app.post('/api/schedules/run', async () => ({ results: await runDueSchedules(db, adapter, studentId) }));

  app.post('/api/routes/compare', async (req) => {
    const b = z.object({ amount: z.string(), currency: z.string().refine(isCurrency) }).parse(req.body);
    return compareRoutesFor(db, studentId, parseAmount(b.amount), b.currency);
  });

  app.post('/api/invoices/:id/plan', async (req) => tuitionPlan(db, studentId, (req.params as { id: string }).id));

  app.get('/api/plans/latest', async () => {
    const r = await db.query(`SELECT payload FROM plans WHERE student_id = $1 AND kind = 'tuition' ORDER BY created_at DESC LIMIT 1`, [studentId]);
    return r.rows[0]?.payload ?? null;
  });

  app.get('/api/audit', async (req) => {
    const { limit } = z.object({ limit: z.coerce.number().int().min(1).max(500).default(100) }).parse(req.query);
    const r = await db.query(
      'SELECT seq, at, kind, data, prev_hash, hash FROM audit_log WHERE student_id = $1 OR student_id IS NULL ORDER BY seq DESC LIMIT $2',
      [studentId, limit],
    );
    return r.rows;
  });

  app.get('/api/audit/verify', async () => verifyChain(db));

  app.get('/api/audit/export', async (_req, reply) => {
    const rows = (await db.query('SELECT seq, student_id, at, kind, data, prev_hash, hash FROM audit_log ORDER BY seq')).rows;
    const check = await verifyChain(db);
    reply.header('Content-Disposition', `attachment; filename="hela-audit-${clock.today()}.json"`);
    return { exportedAt: clock.now().toISOString(), verification: check, entries: rows };
  });

  // Linking a payment method: Paystack's hosted checkout with a test card.
  app.post('/api/payment-method/link', async () => {
    const s = (await getStudent(db, studentId))!;
    if (!adapter.startLink) {
      await db.query(
        `INSERT INTO payment_methods (student_id, provider, authorization_code, email, label)
         VALUES ($1, $2, 'simulated', $3, 'Simulated sandbox card')
         ON CONFLICT (student_id) DO NOTHING`,
        [studentId, adapter.name, s.email],
      );
      await audit(db, { studentId, kind: 'payment_method_linked', data: { provider: adapter.name } });
      return { linked: true };
    }
    const reference = `link_${randomUUID().replace(/-/g, '').slice(0, 16)}`;
    const { url } = await adapter.startLink({ email: s.email, reference, callbackUrl: `${config.publicUrl}/paystack/callback` });
    return { url };
  });

  app.get('/paystack/callback', async (req, reply) => {
    const { reference } = z.object({ reference: z.string() }).parse(req.query);
    if (!adapter.finishLink) throw new HttpError(400, 'Linking is not available');
    const m = await adapter.finishLink(reference);
    await db.query(
      `INSERT INTO payment_methods (student_id, provider, authorization_code, email, label) VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (student_id) DO UPDATE SET authorization_code = EXCLUDED.authorization_code, email = EXCLUDED.email, label = EXCLUDED.label`,
      [studentId, adapter.name, m.authorizationCode, m.email, m.label],
    );
    await audit(db, { studentId, kind: 'payment_method_linked', data: { provider: adapter.name, label: m.label } });
    return reply.redirect('/?linked=1');
  });

  app.get('/api/health', async () => ({ ok: true, model: modelName(), provider: adapter.name }));

  const webDist = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../web/dist');
  if (existsSync(webDist)) {
    app.register(fastifyStatic, { root: webDist });
    app.setNotFoundHandler((req, reply) =>
      req.url.startsWith('/api/') ? reply.status(404).send({ error: 'Not found' }) : reply.sendFile('index.html'),
    );
  }

  return app;
}
