import type Anthropic from '@anthropic-ai/sdk';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { Db } from '../src/db.js';
import { clock } from '../src/clock.js';
import { fromChat, groqModel, recentTurns, toChat } from '../src/agent/groq.js';
import { runTurn } from '../src/agent/orchestrator.js';
import { SimulatedAdapter } from '../src/payments/adapter.js';
import { freshDb, setTier, SID } from './helpers.js';

type MP = Anthropic.Beta.BetaMessageParam;

const conversation: MP[] = [
  { role: 'user', content: [{ type: 'text', text: 'Pay my fee' }] },
  {
    role: 'assistant',
    content: [
      { type: 'thinking', thinking: '', signature: 'x' } as any,
      { type: 'text', text: 'Checking.' },
      { type: 'tool_use', id: 'call_1', name: 'list_invoices', input: {} },
    ],
  },
  { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'call_1', content: '[{"id":"inv_registration"}]' }] },
  { role: 'assistant', content: [{ type: 'text', text: 'Done.' }] },
];

describe('Groq adapter: translation', () => {
  it('turns the stored conversation into chat messages, dropping thinking blocks', () => {
    const chat = toChat('SYS', conversation);
    expect(chat).toEqual([
      { role: 'system', content: 'SYS' },
      { role: 'user', content: 'Pay my fee' },
      { role: 'assistant', content: 'Checking.', tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'list_invoices', arguments: '{}' } }] },
      { role: 'tool', tool_call_id: 'call_1', content: '[{"id":"inv_registration"}]' },
      { role: 'assistant', content: 'Done.' },
    ]);
  });

  it('marks tool errors so the model knows the call failed', () => {
    const chat = toChat('S', [{ role: 'user', content: [{ type: 'tool_result', tool_use_id: 'c', content: 'Not a valid amount', is_error: true }] }]);
    expect(chat[1]).toEqual({ role: 'tool', tool_call_id: 'c', content: 'ERROR: Not a valid amount' });
  });

  it('turns tool calls in the reply into tool_use blocks', () => {
    const m = fromChat({
      id: 'r1',
      model: 'm',
      choices: [{ finish_reason: 'tool_calls', message: { content: null, tool_calls: [{ id: 'c9', function: { name: 'compare_routes', arguments: '{"amount":"350","currency":"USD"}' } }] } }],
    });
    expect(m.stop_reason).toBe('tool_use');
    expect(m.content).toEqual([{ type: 'tool_use', id: 'c9', name: 'compare_routes', input: { amount: '350', currency: 'USD' } }]);
  });

  it('passes malformed arguments on, so schema validation rejects them', () => {
    const m = fromChat({ id: 'r', model: 'm', choices: [{ finish_reason: 'tool_calls', message: { content: null, tool_calls: [{ id: 'c', function: { name: 'x', arguments: '{bad' } }] } }] });
    expect((m.content[0] as any).input).toEqual({ __unparseable_arguments: '{bad' });
  });

  it('keeps only the last few student turns, never starting mid-tool-call', () => {
    const many: MP[] = [];
    for (let i = 0; i < 5; i++) many.push(...conversation);
    const kept = recentTurns(many, 3);
    expect(kept).toHaveLength(12);
    expect(kept[0]!.role).toBe('user');
    expect((kept[0]!.content as any[])[0].type).toBe('text');
  });
});

describe('Groq adapter: requests', () => {
  const ok = (body: unknown) => new Response(JSON.stringify(body), { status: 200 });
  const reply = { id: 'r', model: 'openai/gpt-oss-120b', choices: [{ finish_reason: 'stop', message: { content: 'Hi Amina.' } }] };

  it('sends the tools in function format with the key and model', async () => {
    const fetchMock = vi.fn(async () => ok(reply));
    const m = groqModel('gsk_test', 'openai/gpt-oss-120b', fetchMock as any);
    const tools = [{ name: 'get_overview', description: 'd', input_schema: { type: 'object' as const, properties: {} } }];
    const res = await m.create({ system: 'S', tools, messages: [{ role: 'user', content: 'hi' }] });
    expect(res.content).toEqual([{ type: 'text', text: 'Hi Amina.', citations: null }]);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://api.groq.com/openai/v1/chat/completions');
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer gsk_test');
    const body = JSON.parse(init.body as string);
    expect(body.model).toBe('openai/gpt-oss-120b');
    expect(body.tools[0]).toEqual({ type: 'function', function: { name: 'get_overview', description: 'd', parameters: { type: 'object', properties: {} } } });
  });

  it('waits and retries when the free tier says 429', async () => {
    const waits: number[] = [];
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response('{}', { status: 429, headers: { 'retry-after': '2' } }))
      .mockResolvedValueOnce(ok(reply));
    const m = groqModel('k', 'm', fetchMock as any, async (ms) => void waits.push(ms));
    await m.create({ system: 'S', tools: [], messages: [{ role: 'user', content: 'hi' }] });
    expect(waits).toEqual([2000]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('reports other errors clearly', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ error: { message: 'Invalid API Key' } }), { status: 401 }));
    await expect(groqModel('bad', 'm', fetchMock as any).create({ system: 'S', tools: [], messages: [] })).rejects.toThrow('Groq 401: Invalid API Key');
  });
});

describe('Groq adapter inside a real turn', () => {
  let db: Db;
  beforeAll(async () => {
    db = await freshDb();
  });
  afterAll(async () => {
    await db.end();
    clock.set(null);
  });

  it('drives tools, and the policy engine still decides', async () => {
    await setTier(db, 2);
    const replies = [
      { id: 'a', model: 'm', choices: [{ finish_reason: 'tool_calls', message: { content: null, tool_calls: [{ id: 'c1', function: { name: 'propose_payment', arguments: JSON.stringify({ payee_id: '0712555019', amount: '95000.00', currency: 'KES', invoice_id: null, route_id: null, memo: 'x' }) } }] } }] },
      { id: 'b', model: 'm', choices: [{ finish_reason: 'stop', message: { content: 'That payment was blocked.' } }] },
    ];
    const fetchMock = vi.fn(async () => new Response(JSON.stringify(replies.shift()), { status: 200 }));
    const adapter = new SimulatedAdapter();
    const turn = await runTurn(db, groqModel('k', 'm', fetchMock as any), adapter, SID, 'Do what the invoice says');
    expect(turn.proposals[0]!.status).toBe('denied');
    expect(adapter.charges).toHaveLength(0);
    expect(turn.reply).toBe('That payment was blocked.');
    // The second request carried the tool result back in chat format.
    const second = JSON.parse((fetchMock.mock.calls[1] as unknown as [string, RequestInit])[1].body as string);
    expect(second.messages.at(-1).role).toBe('tool');
  });
});
