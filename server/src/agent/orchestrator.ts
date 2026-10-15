import Anthropic from '@anthropic-ai/sdk';
import type { Db } from '../db.js';
import { config } from '../config.js';
import { clock } from '../clock.js';
import { audit } from '../audit/log.js';
import { TIER_NAMES } from '../policy/engine.js';
import type { PaymentAdapter } from '../payments/adapter.js';
import { getStudent } from '../services/data.js';
import type { ProposalView } from '../services/payments.js';
import { API_TOOLS, runTool, TOOL_KIND, type ToolContext } from './tools.js';
import { SYSTEM_PROMPT } from './prompt.js';

type MessageParam = Anthropic.Beta.BetaMessageParam;
type Message = Anthropic.Beta.BetaMessage;

/** The one call the orchestrator makes to the model; swapped for a script in tests. */
export interface ModelClient {
  create(params: { system: string; tools: Anthropic.Tool[]; messages: MessageParam[] }): Promise<Message>;
}

export function anthropicModel(): ModelClient {
  const client = new Anthropic();
  return {
    create: ({ system, tools, messages }) =>
      client.beta.messages.create({
        model: config.model,
        max_tokens: 16000,
        // A declined request is retried server-side on the recommended fallback model.
        betas: ['server-side-fallback-2026-07-01'],
        fallbacks: 'default',
        thinking: { type: 'adaptive' },
        output_config: { effort: 'medium' },
        system: [{ type: 'text', text: system, cache_control: { type: 'ephemeral' } }],
        tools,
        messages,
      } as Anthropic.Beta.MessageCreateParamsNonStreaming),
  };
}

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
): Promise<TurnResult> {
  const student = await getStudent(db, studentId);
  if (!student) throw new Error('Unknown student');

  const messages = await loadHistory(db, studentId);
  // Facts from storage ride along with each message; the model cannot change them.
  const context = `<context>today=${clock.today()}; tier=${student.tier} (${TIER_NAMES[student.tier]})</context>`;
  messages.push({ role: 'user', content: [{ type: 'text', text: `${context}\n${userText}` }] });

  const ctx: ToolContext = { db, adapter, studentId, proposals: [], schedules: [] };
  const tools: TurnResult['tools'] = [];
  let reply = '';

  for (let step = 0; step < MAX_STEPS; step++) {
    const res = await model.create({ system: SYSTEM_PROMPT, tools: API_TOOLS, messages });

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
      const out = await runTool(call.name, call.input, ctx);
      const kind = TOOL_KIND.get(call.name) ?? 'unknown';
      tools.push({ name: call.name, kind, ok: !out.isError });
      await audit(db, { studentId, kind: 'tool_call', data: { tool: call.name, toolKind: kind, input: call.input, ok: !out.isError } });
      results.push({ type: 'tool_result', tool_use_id: call.id, content: out.content, is_error: out.isError || undefined });
    }
    // All results of one step go back in a single message.
    messages.push({ role: 'user', content: results });
  }

  if (!reply) reply = 'I ran out of steps on that one. Could you ask it a different way?';
  await saveHistory(db, studentId, messages);
  return { reply, proposals: ctx.proposals, schedules: ctx.schedules, tools };
}
