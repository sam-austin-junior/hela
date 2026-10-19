import type Anthropic from '@anthropic-ai/sdk';
import type { ModelClient } from './orchestrator.js';

// Open models on Groq's free tier, behind the same ModelClient interface the
// orchestrator uses for Claude. Groq speaks the OpenAI chat-completions
// format, so this adapter translates both ways: the conversation stays
// stored in one format, and the policy engine and tools are untouched.

type MessageParam = Anthropic.Beta.BetaMessageParam;
type Message = Anthropic.Beta.BetaMessage;

const BASE = 'https://api.groq.com/openai/v1';

interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string | null;
  tool_calls?: { id: string; type: 'function'; function: { name: string; arguments: string } }[];
  tool_call_id?: string;
}

interface ChatResponse {
  id: string;
  model: string;
  choices: {
    finish_reason: string;
    message: { content: string | null; tool_calls?: { id: string; function: { name: string; arguments: string } }[] };
  }[];
  usage?: { prompt_tokens: number; completion_tokens: number };
}

const blocks = (content: MessageParam['content']) =>
  typeof content === 'string' ? [{ type: 'text', text: content } as Anthropic.Beta.BetaTextBlockParam] : content;

/**
 * Keep the request small: the free tier limits tokens per minute. Send the
 * last few student turns only, always starting at a student's own message so
 * no tool result arrives without the call that asked for it.
 */
export function recentTurns(messages: MessageParam[], keepTurns = 3): MessageParam[] {
  const starts: number[] = [];
  messages.forEach((m, i) => {
    if (m.role === 'user' && blocks(m.content).some((b) => b.type === 'text')) starts.push(i);
  });
  if (starts.length <= keepTurns) return messages;
  return messages.slice(starts[starts.length - keepTurns]);
}

/** Anthropic-format conversation → OpenAI chat messages. */
export function toChat(system: string, messages: MessageParam[]): ChatMessage[] {
  const out: ChatMessage[] = [{ role: 'system', content: system }];
  for (const m of messages) {
    const parts = blocks(m.content);
    if (m.role === 'user') {
      for (const b of parts) {
        if (b.type === 'tool_result') {
          const c = b.content;
          const text = typeof c === 'string' ? c : (c ?? []).map((x) => ('text' in x ? x.text : '')).join('\n');
          out.push({ role: 'tool', tool_call_id: b.tool_use_id, content: b.is_error ? `ERROR: ${text}` : text });
        }
      }
      const text = parts.filter((b) => b.type === 'text').map((b) => (b as { text: string }).text).join('\n');
      if (text) out.push({ role: 'user', content: text });
    } else {
      const text = parts.filter((b) => b.type === 'text').map((b) => (b as { text: string }).text).join('\n');
      const calls = parts
        .filter((b) => b.type === 'tool_use')
        .map((b) => {
          const t = b as Anthropic.Beta.BetaToolUseBlockParam;
          return { id: t.id, type: 'function' as const, function: { name: t.name, arguments: JSON.stringify(t.input ?? {}) } };
        });
      // Thinking blocks from another model are dropped; they mean nothing here.
      if (!text && calls.length === 0) continue;
      out.push({ role: 'assistant', content: text || null, ...(calls.length ? { tool_calls: calls } : {}) });
    }
  }
  return out;
}

/** OpenAI chat response → the Anthropic message shape the orchestrator reads. */
export function fromChat(res: ChatResponse): Message {
  const choice = res.choices[0]!;
  const content: Anthropic.Beta.BetaContentBlock[] = [];
  if (choice.message.content?.trim()) {
    content.push({ type: 'text', text: choice.message.content, citations: null } as Anthropic.Beta.BetaTextBlock);
  }
  for (const call of choice.message.tool_calls ?? []) {
    let input: unknown;
    try {
      input = JSON.parse(call.function.arguments || '{}');
    } catch {
      // Malformed arguments fail schema validation in runTool and go back as an error.
      input = { __unparseable_arguments: call.function.arguments };
    }
    content.push({ type: 'tool_use', id: call.id, name: call.function.name, input } as Anthropic.Beta.BetaToolUseBlock);
  }
  const stop =
    choice.finish_reason === 'tool_calls' || (choice.message.tool_calls?.length ?? 0) > 0
      ? 'tool_use'
      : choice.finish_reason === 'length'
        ? 'max_tokens'
        : 'end_turn';
  return {
    id: res.id,
    type: 'message',
    role: 'assistant',
    model: res.model,
    content,
    stop_reason: stop,
    stop_sequence: null,
    usage: { input_tokens: res.usage?.prompt_tokens ?? 0, output_tokens: res.usage?.completion_tokens ?? 0 },
  } as unknown as Message;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export function groqModel(apiKey: string, model: string, fetchImpl: typeof fetch = fetch, wait = sleep): ModelClient {
  return {
    async create({ system, tools, messages, onEvent }) {
      const body = JSON.stringify({
        model,
        messages: toChat(system, recentTurns(messages)),
        tools: tools.map((t) => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.input_schema } })),
        tool_choice: 'auto',
        temperature: 0.2,
        max_tokens: 1200,
        // gpt-oss models think before answering; low effort keeps each step
        // fast and inside the free tier's tokens-per-minute limit.
        ...(model.startsWith('openai/gpt-oss') ? { reasoning_effort: 'low' } : {}),
      });
      // The free tier answers 429 when a per-minute limit is hit; wait as told and retry.
      for (let attempt = 0; ; attempt++) {
        const res = await fetchImpl(`${BASE}/chat/completions`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
          body,
          signal: AbortSignal.timeout(90_000),
        });
        if (res.status === 429 && attempt < 4) {
          const after = Number(res.headers.get('retry-after'));
          const ms = Math.min(Number.isFinite(after) && after > 0 ? after * 1000 : 5000 * (attempt + 1), 60_000);
          onEvent?.({ type: 'waiting', seconds: Math.ceil(ms / 1000) });
          await wait(ms);
          continue;
        }
        const json = (await res.json().catch(() => ({}))) as ChatResponse & { error?: { message?: string } };
        if (!res.ok) throw new Error(`Groq ${res.status}: ${json.error?.message ?? 'request failed'}`);
        return fromChat(json);
      }
    },
  };
}
