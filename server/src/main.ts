import { config, modelName, modelProvider } from './config.js';
import { createPool, migrate } from './db.js';
import { buildApp } from './app.js';
import { SimulatedAdapter, type PaymentAdapter } from './payments/adapter.js';
import { PaystackTestAdapter } from './payments/paystack.js';
import { createModel } from './agent/model.js';
import { applyRules } from './services/finance.js';
import { categoriseWithModel } from './agent/categorise.js';

const db = createPool();
await migrate(db);

const adapter: PaymentAdapter = config.paystackSecretKey
  ? new PaystackTestAdapter(config.paystackSecretKey)
  : new SimulatedAdapter();
const model = createModel();

const app = buildApp({ db, adapter, model });

// Rules first; whatever they cannot place goes to the model, which must pick
// from the fixed category list.
const left = await applyRules(db, 'stu_demo').catch(() => 0);
// The categoriser uses Claude's structured outputs; with another provider,
// rules and the student's own corrections do the job.
if (left > 0 && modelProvider() === 'anthropic') {
  categoriseWithModel(db, 'stu_demo').catch((e) => console.warn('Model categorisation skipped:', (e as Error).message));
}

await app.listen({ port: config.port, host: config.host });
console.log(`Hela on ${config.publicUrl}  ·  payments: ${adapter.name}  ·  model: ${modelName() ?? 'not configured'}`);
