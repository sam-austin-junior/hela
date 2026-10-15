import Anthropic from '@anthropic-ai/sdk';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Db } from '../src/db.js';
import { clock } from '../src/clock.js';
import { buildApp } from '../src/app.js';
import { SimulatedAdapter } from '../src/payments/adapter.js';
import { anthropicModel, runTurn, type TurnEvent } from '../src/agent/orchestrator.js';
import { final, freshDb, scripted, SID, toolUse } from './helpers.js';

let db: Db;

beforeAll(async () => {
  db = await freshDb();
});
afterAll(async () => {
  await db.end();
  clock.set(null);
});

describe('live progress', () => {
  it('reports each step in order while a turn runs', async () => {
    const events: TurnEvent[] = [];
    const model = scripted([
      () => toolUse([{ name: 'get_overview', input: {} }, { name: 'list_invoices', input: {} }]),
      () => toolUse([{ name: 'plan_tuition', input: { invoice_id: 'nope' } }]),
      () => final('Done.'),
    ]);
    await runTurn(db, model, new SimulatedAdapter(), SID, 'Plan', (e) => events.push(e));
    expect(events.map((e) => (e.type === 'thinking' ? 'think' : `${e.type}:${e.name}${e.type === 'tool_end' ? `:${e.ok}` : ''}`))).toEqual([
      'think',
      'tool_start:get_overview',
      'tool_end:get_overview:true',
      'tool_start:list_invoices',
      'tool_end:list_invoices:true',
      'think',
      'tool_start:plan_tuition',
      'tool_end:plan_tuition:false',
      'think',
    ]);
  });

  it('streams steps and the final result as server-sent events', async () => {
    const model = scripted([() => toolUse([{ name: 'get_overview', input: {} }]), () => final('Hello Amina.')]);
    const app = buildApp({ db, adapter: new SimulatedAdapter(), model });
    const res = await app.inject({ method: 'POST', url: '/api/chat/stream', payload: { message: 'hi' } });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toMatch(/text\/event-stream/);
    const frames = res.body
      .trim()
      .split('\n\n')
      .map((f) => ({ event: /^event: (.+)$/m.exec(f)![1], data: JSON.parse(/^data: (.+)$/m.exec(f)![1]!) }));
    expect(frames.map((f) => f.event)).toEqual(['step', 'step', 'step', 'step', 'done']);
    expect(frames.at(-1)!.data.reply).toBe('Hello Amina.');
  });

  it('streams an error event instead of hanging when the model fails', async () => {
    const model = { create: async () => { throw new Error('upstream down'); } };
    const app = buildApp({ db, adapter: new SimulatedAdapter(), model });
    const res = await app.inject({ method: 'POST', url: '/api/chat/stream', payload: { message: 'hi' } });
    expect(res.body).toContain('event: error');
    expect(res.body).toContain('upstream down');
  });
});

describe('model call', () => {
  it('drops the fallback option once if the API rejects it, then keeps working', async () => {
    const sent: any[] = [];
    const reply = final('ok');
    const fake = {
      beta: {
        messages: {
          create: async (params: any) => {
            sent.push(params);
            if (params.fallbacks) {
              throw new Anthropic.BadRequestError(400, { type: 'error', error: { type: 'invalid_request_error', message: 'fallbacks: not enabled for this organization' } }, 'fallbacks: not enabled for this organization', new Headers());
            }
            return reply;
          },
        },
      },
    } as unknown as Pick<Anthropic, 'beta'>;
    const model = anthropicModel(fake);
    await model.create({ system: 's', tools: [], messages: [{ role: 'user', content: 'hi' }] });
    await model.create({ system: 's', tools: [], messages: [{ role: 'user', content: 'hi' }] });
    expect(sent.map((p) => Boolean(p.fallbacks))).toEqual([true, false, false]);
    expect(sent[0].betas).toEqual(['server-side-fallback-2026-07-01']);
    expect(sent[0].model).toBe('claude-opus-5-5');
    expect(sent[0].thinking).toEqual({ type: 'adaptive' });
  });

  it('does not swallow other errors', async () => {
    const fake = {
      beta: { messages: { create: async () => { throw new Anthropic.BadRequestError(400, undefined, 'messages: bad', new Headers()); } } },
    } as unknown as Pick<Anthropic, 'beta'>;
    await expect(anthropicModel(fake).create({ system: 's', tools: [], messages: [] })).rejects.toThrow(/messages: bad/);
  });
});
