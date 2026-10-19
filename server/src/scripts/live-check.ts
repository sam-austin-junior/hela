// Ad-hoc live check: run demo prompts through the configured model and print
// what happened. Not part of the app; used while tuning the model.
import { createPool } from '../db.js';
import { modelName } from '../config.js';
import { createModel } from '../agent/model.js';
import { runTurn, resetConversation } from '../agent/orchestrator.js';
import { SimulatedAdapter } from '../payments/adapter.js';

const prompts = process.argv.slice(2);
const db = createPool();
const base = createModel();
if (!base) throw new Error('No model configured');
let tokensIn = 0;
let tokensOut = 0;
let calls = 0;
const model = {
  async create(p: Parameters<typeof base.create>[0]) {
    const r = await base.create(p);
    calls++;
    tokensIn += r.usage.input_tokens;
    tokensOut += r.usage.output_tokens;
    return r;
  },
};
console.log('model:', modelName());
await resetConversation(db, 'stu_demo');
for (const p of prompts) {
  const tierSet = /^!tier=(\d)$/.exec(p);
  if (tierSet) {
    await db.query('UPDATE students SET tier = $1 WHERE id = $2', [Number(tierSet[1]), 'stu_demo']);
    console.log(`
--- tier set to ${tierSet[1]}`);
    continue;
  }
  const t0 = Date.now();
  tokensIn = tokensOut = calls = 0;
  const steps: string[] = [];
  try {
    const r = await runTurn(db, model, new SimulatedAdapter(), 'stu_demo', p, (e) => {
      if (e.type === 'tool_end') steps.push(`${e.name}${e.ok ? '' : '(ERR)'}`);
    });
    console.log(`\n>>> ${p}  [${((Date.now() - t0) / 1000).toFixed(1)}s, ${calls} calls, ${tokensIn} in / ${tokensOut} out]\ntools: ${steps.join(', ') || 'none'}\nproposals: ${r.proposals.map((x) => `${x.status}${x.decision ? ' - ' + x.decision.reason : ''}`).join(' | ') || 'none'}\n${r.reply}`);
  } catch (e) {
    console.log(`\n>>> ${p}\nERROR: ${(e as Error).message}`);
  }
}
await db.end();
