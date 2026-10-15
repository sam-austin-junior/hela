# Hela

**An AI agent for students who pay for education across currencies.** Hela plans tuition for a foreign-currency invoice, compares ways to send money abroad, budgets across currencies, builds a credit checklist, and prepares payments. It runs only inside limits the student sets.

Built for the PBCSF Fintechathon 2026, International Track, Topic C (Cross-border & Student Finance Assistant).

> **Sandbox only.** Payments go through Paystack **test mode** (live keys are refused in code) or a built-in simulated provider. Exchange rates are a seeded random walk. Fee tables are illustrative. The student, the university and every account are fictional.

## The one idea

The language model can **propose** a payment but can never **approve** one. A deterministic policy engine decides, using the student's permission tier and limits, which are loaded from the database and which the model cannot read as editable or change. Even a model that has been fully taken over by an injected instruction cannot move money outside those rules. The tests prove it with a scripted "compromised" model.

```
student ─▶ web app ─▶ agent orchestrator ◀─▶ Claude (plans, explains)
                          │ runs tools
                          ▼
                 read · plan · act tools ──▶ data (accounts, rates, fee snapshots)
                          │ act returns a proposal
                          ▼
                    POLICY ENGINE ──────────▶ audit log (append-only, hash-chained)
               allow │        │ needs confirmation
                     ▼        └──▶ student confirms in the app (one-time code over KES 10,000)
             payment adapter ─▶ Paystack test mode / simulated sandbox
```

## Permission tiers

| Tier | Hela may | Money movement |
|---|---|---|
| 0 · Read only | read balances and transactions | none |
| 1 · Advise | plus plans and comparisons | none |
| 2 · Act with confirmation | plus prepare payments | each payment needs the student, with a code over KES 10,000 |
| 3 · Act within limits | plus run approved schedules | automatic only for approved payees under the caps; anything else falls back to tier 2 |

Raising the tier or loosening a limit needs the app PIN; five wrong PINs lock these actions for 15 minutes. Lowering the tier or tightening a limit takes effect at once. New payees start unapproved. The student can download all their data as JSON.

**Policy checks, in order** ([server/src/policy/engine.ts](server/src/policy/engine.ts)): tier → payee approved (and not added in the last 24 h) → per-payment, daily and monthly caps → balance minus buffer → consistency with the cited invoice → rate of requests (5 per 10 min) → duplicate key.

## Run it

You need Node 22+ and Docker.

```bash
npm install
npm run db:up          # Postgres 16 on 127.0.0.1:5544
npm run seed           # demo student "Amina"; prints the demo PIN (2468)
npm run build -w web
npm start              # http://localhost:8787
```

For the chat, copy `.env.example` to `.env` and set `ANTHROPIC_API_KEY`. Without a key the panels, payments and tests still work.

To use **Paystack test mode** instead of the simulated provider, set `PAYSTACK_SECRET_KEY=sk_test_...`, then click **Link a test card** in the app and pay with one of Paystack's published test cards. Hela stores only the reusable authorization token, never card details.

Everything in one container: `docker compose --profile app up --build`.

## Tests and evidence

```bash
npm test               # 97 tests: maths, every policy check, payments, audit tampering, agent journeys, API controls
npm run evidence       # runs 12 payment scenarios in the sandbox → evidence/sandbox-log.md
```

`npm test` needs the database running. It uses a separate `hela_test` database. With a Claude key set, `npm run evidence` also records five live agent turns, one of them a prompt-injection attempt.

| Test file | What it proves |
|---|---|
| `domain.test.ts` | tuition, remittance, exchange-rate, budget and credit maths against hand-worked examples |
| `policy.test.ts` | each tier, and each of the 7 checks allowing, asking or denying as specified |
| `payments.test.ts` | the full flow on a real database: code entry, 3 wrong codes, duplicates and races, caps, buffer, burst, re-check at confirmation, schedules |
| `audit.test.ts` | triggers refuse edits; an edited or deleted entry is detected even with the triggers bypassed |
| `agent.test.ts` | injection attempts, malformed tool input, the code never reaching the model, and 5 scripted student journeys |
| `api.test.ts` | limits and tier changes (loosening needs the PIN), PIN lockout after 5 tries, new payees start unapproved, data export, category corrections |
| `stream.test.ts` | live step events in order, the streamed chat endpoint, an error event instead of a hang, and the fallback-option retry |
| `paystack.test.ts` | live keys refused, reference format, and no second charge after a failed attempt |

## Layout

```
server/src/
  agent/       orchestrator (Claude tool loop), tools, system prompt, model categoriser
  policy/      the policy engine (pure function)
  audit/       hash-chained audit log
  domain/      money, fx, remittance, tuition, budget, credit (pure, tested)
  services/    database-backed payments, schedules, finance views
  payments/    Paystack test adapter, simulated adapter
server/db/migrations/   schema, including the append-only triggers
web/src/       React app: chat, proposal cards, budget, audit view
evidence/      generated sandbox logs and audit export
```

## Model

The agent uses Claude (`claude-opus-5-5` by default; set `HELA_MODEL` to change it) through the official Anthropic SDK, with tool use, adaptive thinking, prompt caching of the fixed system prompt, and server-side refusal fallback. Every number the student sees comes from a tool. The model never does money arithmetic.

## Licence

MIT
