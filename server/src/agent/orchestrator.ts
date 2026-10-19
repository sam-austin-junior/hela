import Anthropic from '@anthropic-ai/sdk';
import type { Db } from '../db.js';
import { config } from '../config.js';
import { clock } from '../clock.js';
import { audit } from '../audit/log.js';
import { TIER_NAMES } from '../policy/engine.js';
import type { PaymentAdapter } from '../payments/adapter.js';
import { getAccounts, getInvoices, getPayees, getStudent } from '../services/data.js';
import { formatMinor } from '../domain/money.js';
import type { ProposalView } from '../services/payments.js';
import { API_TOOLS, runTool, TOOL_KIND, type ToolContext } from './tools.js';
import { SYSTEM_PROMPT } from './prompt.js';

type MessageParam = Anthropic.Beta.BetaMessageParam;
type Message = Anthropic.Beta.BetaMessage;

/** The one call the orchestrator makes to the model; swapped for a script in tests. */
export interface ModelClient {
  create(params: {
    system: string;
    tools: Anthropic.Tool[];
    messages: MessageParam[];
    /** Lets a provider report progress, such as waiting out a rate limit. */
    onEvent?: (e: TurnEvent) => void;
  }): Promise<Message>;
}

export function anthropicModel(client: Pick<Anthropic, 'beta'> = new Anthropic()): ModelClient {
  // Server-side refusal fallback is on by default. If this account or model
  // rejects the option, carry on without it rather than failing the student.
  let useFallback = true;
  const send = (params: { system: string; tools: Anthropic.Tool[]; messages: MessageParam[] }) =>
    client.beta.messages.create({
      model: config.model,
      max_tokens: 16000,
      ...(useFallback ? { betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default' } : {}),
      thinking: { type: 'adaptive' },
      output_config: { effort: 'medium' },
      system: [{ type: 'text', text: params.system, cache_control: { type: 'ephemeral' } }],
      tools: params.tools,
      messages: params.messages,
    } as Anthropic.Beta.MessageCreateParamsNonStreaming);
  return {
    async create(params) {
      try {
        return await send(params);
      } catch (err) {
        if (useFallback && err instanceof Anthropic.BadRequestError && /fallback/i.test(err.message)) {
          useFallback = false;
          return send(params);
        }
        throw err;
      }
    },
  };
}

/** Progress a turn reports while it runs, for the app to show live. */
export type TurnEvent =
  | { type: 'thinking' }
  | { type: 'waiting'; seconds: number }
  | { type: 'tool_start'; name: string; kind: string }
  | { type: 'tool_end'; name: string; kind: string; ok: boolean };

export interface TurnResult {
  reply: string;
  proposals: ProposalView[];
  schedules: string[];
  tools: { name: string; kind: string; ok: boolean }[];
}

const MAX_STEPS = 10;

async function loadHistory(db: Db, studentId: string): Promise<MessageParam[]> {
  const r = await db.query('SELECT messages FROM conversations WHERE student_id = $1', [studentId]);
  return (r.rows[0]?.messages as MessageParam[]) ?? [];
}

async function saveHistory(db: Db, studentId: string, messages: MessageParam[]) {
  await db.query(
    `INSERT INTO conversations (student_id, messages, updated_at) VALUES ($1, $2, now())
     ON CONFLICT (student_id) DO UPDATE SET messages = EXCLUDED.messages, updated_at = now()`,
    [studentId, JSON.stringify(messages)],
  );
}

/**
 * Facts from storage that ride along with each message, so the model rarely
 * needs a round trip to look them up. It cannot change any of them.
 */
// Common Kiswahili words. Detecting the language in code is more reliable
// than asking every model to notice it.
const KISWAHILI = /\b(nisaidie|tafadhali|yangu|wangu|karo|pesa|nini|ninataka|naomba|lipa|kulipa|bajeti|asante|habari|je|ya|kwa|na|ni)\b/gi;

export function replyLanguage(text: string): 'Kiswahili' | null {
  const hits = text.match(KISWAHILI)?.length ?? 0;
  const words = text.split(/\s+/).filter(Boolean).length;
  return hits >= 2 || (words <= 4 && hits >= 1) ? 'Kiswahili' : null;
}

export async function buildContext(db: Db, studentId: string, userText = ''): Promise<string> {
  const student = (await getStudent(db, studentId))!;
  const accounts = await getAccounts(db, studentId);
  const kes = accounts.filter((a) => a.currency === 'KES').reduce((s, a) => s + a.balanceMinor, 0);
  const bills = (await getInvoices(db, studentId))
    .filter((i) => i.status === 'open')
    .map((i) => `${i.id}=${i.issuer}, ${formatMinor(i.amountMinor, i.currency)} (amount_decimal ${(i.amountMinor / 100).toFixed(2)}), due ${i.dueDate}, payee_id ${i.payeeId}`);
  const payees = (await getPayees(db, studentId)).filter((p) => p.approved).map((p) => `${p.id}=${p.name} (${p.currency})`);
  return [
    '<context>',
    `today=${clock.today()}; tier=${student.tier} (${TIER_NAMES[student.tier]}); first_name=${student.firstName}`,
    `balance_total=${formatMinor(kes, 'KES')}`,
    `open_bills: ${bills.join(' | ') || 'none'}`,
    `approved_payees: ${payees.join(' | ') || 'none'}`,
    'bill_texts: not shown here; call list_invoices to read what a bill says',
    ...(replyLanguage(userText) ? [`reply_language=${replyLanguage(userText)} (write the whole reply in it)`] : []),
    '</context>',
  ].join('\n');
}

export async function resetConversation(db: Db, studentId: string) {
  await db.query('DELETE FROM conversations WHERE student_id = $1', [studentId]);
}

/** One student message in, one reply out, with any tool calls in between. */
export async function runTurn(
  db: Db,
  model: ModelClient,
  adapter: PaymentAdapter,
  studentId: string,
  userText: string,
  onEvent: (e: TurnEvent) => void = () => {},
): Promise<TurnResult> {
  const student = await getStudent(db, studentId);
  if (!student) throw new Error('Unknown student');

  const messages = await loadHistory(db, studentId);
  // Facts from storage ride along with each message; the model cannot change them.
  const context = await buildContext(db, studentId, userText);
  messages.push({ role: 'user', content: [{ type: 'text', text: `${context}\n${userText}` }] });

  const ctx: ToolContext = { db, adapter, studentId, proposals: [], schedules: [] };
  const tools: TurnResult['tools'] = [];
  let reply = '';
  let emptyRetries = 0;

  for (let step = 0; step < MAX_STEPS; step++) {
    onEvent({ type: 'thinking' });
    const res = await model.create({ system: SYSTEM_PROMPT, tools: API_TOOLS, messages, onEvent });

    // Some models occasionally return nothing at all. Ask again once rather
    // than show the student an empty answer.
    const hasText = res.content.some((b) => b.type === 'text' && b.text.trim() !== '');
    const hasCall = res.content.some((b) => b.type === 'tool_use');
    if (!hasText && !hasCall && res.stop_reason !== 'refusal' && emptyRetries < 1) {
      emptyRetries++;
      continue;
    }

    if (res.stop_reason === 'refusal') {
      await audit(db, { studentId, kind: 'model_refusal', data: { category: res.stop_details?.category ?? null } });
      reply = 'I can\'t help with that request. I can help with budgeting, tuition planning, sending money and credit building.';
      messages.push({ role: 'assistant', content: [{ type: 'text', text: reply }] });
      break;
    }

    // Keep the whole content, thinking blocks included, exactly as returned.
    messages.push({ role: 'assistant', content: res.content as Anthropic.Beta.BetaContentBlockParam[] });

    if (res.stop_reason === 'pause_turn') continue;

    const calls = res.content.filter((b): b is Anthropic.Beta.BetaToolUseBlock => b.type === 'tool_use');
    if (res.stop_reason !== 'tool_use' || calls.length === 0) {
      reply = res.content
        .filter((b): b is Anthropic.Beta.BetaTextBlock => b.type === 'text')
        .map((b) => b.text)
        .join('\n')
        .trim();
      break;
    }

    const results: Anthropic.Beta.BetaToolResultBlockParam[] = [];
    for (const call of calls) {
      const kind = TOOL_KIND.get(call.name) ?? 'unknown';
      onEvent({ type: 'tool_start', name: call.name, kind });
      const out = await runTool(call.name, call.input, ctx);
      onEvent({ type: 'tool_end', name: call.name, kind, ok: !out.isError });
      tools.push({ name: call.name, kind, ok: !out.isError });
      await audit(db, { studentId, kind: 'tool_call', data: { tool: call.name, toolKind: kind, input: call.input, ok: !out.isError } });
      results.push({ type: 'tool_result', tool_use_id: call.id, content: out.content, is_error: out.isError || undefined });
    }
    // All results of one step go back in a single message.
    messages.push({ role: 'user', content: results });
  }

  if (!reply) reply = 'Sorry, I could not finish that one. Could you ask it a different way?';
  await saveHistory(db, studentId, messages);
  return { reply, proposals: ctx.proposals, schedules: ctx.schedules, tools };
}
