import type Anthropic from '@anthropic-ai/sdk';
import { createPool, migrate, type Db } from '../src/db.js';
import { clock } from '../src/clock.js';
import { seedDemo } from '../src/scripts/seed-data.js';
import { applyRules } from '../src/services/finance.js';
import type { ModelClient } from '../src/agent/orchestrator.js';

export const TEST_DB_URL = process.env.TEST_DATABASE_URL ?? 'postgres://hela:hela@127.0.0.1:5544/hela_test';
export const SID = 'stu_demo';
/** Tests run on a fixed "today" so dates and rates never drift. */
export const NOW = new Date('2026-10-15T09:00:00Z');

/** A fresh schema with the demo student, at a fixed clock. */
export async function freshDb(): Promise<Db> {
  clock.set(NOW);
  const db = createPool(TEST_DB_URL);
  await db.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
  await migrate(db);
  await seedDemo(db);
  await applyRules(db, SID);
  return db;
}

export async function setTier(db: Db, tier: number) {
  await db.query('UPDATE students SET tier = $1 WHERE id = $2', [tier, SID]);
}

type Block = Anthropic.Beta.BetaContentBlock;
let seq = 0;

function message(content: Block[], stop: Anthropic.Beta.BetaStopReason): Anthropic.Beta.BetaMessage {
  return {
    id: `msg_test_${++seq}`,
    type: 'message',
    role: 'assistant',
    model: 'scripted',
    content,
    stop_reason: stop,
    stop_sequence: null,
    usage: { input_tokens: 0, output_tokens: 0 },
  } as unknown as Anthropic.Beta.BetaMessage;
}

export const toolUse = (calls: { name: string; input: unknown }[]) =>
  message(
    calls.map((c) => ({ type: 'tool_use', id: `toolu_${++seq}`, name: c.name, input: c.input }) as unknown as Block),
    'tool_use',
  );

export const final = (text: string) => message([{ type: 'text', text, citations: null } as unknown as Block], 'end_turn');

/**
 * A model that follows a script. Each step may look at the conversation so
 * far (for example the last tool results) to decide what to return.
 */
export function scripted(steps: ((messages: Anthropic.Beta.BetaMessageParam[]) => Anthropic.Beta.BetaMessage)[]): ModelClient & { calls: number } {
  const m = {
    calls: 0,
    async create({ messages }: { messages: Anthropic.Beta.BetaMessageParam[] }) {
      const step = steps[m.calls++];
      if (!step) throw new Error('Script ran out of steps');
      return step(messages);
    },
  };
  return m;
}

/** The parsed JSON of the tool results in the latest user message. */
export function lastToolResults(messages: Anthropic.Beta.BetaMessageParam[]): any[] {
  const last = messages[messages.length - 1];
  if (!last || !Array.isArray(last.content)) return [];
  return last.content
    .filter((b: any) => b.type === 'tool_result')
    .map((b: any) => {
      try {
        return JSON.parse(b.content);
      } catch {
        return { error: b.content };
      }
    });
}
