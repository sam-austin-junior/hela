import { config, modelConfigured } from './config.js';
import { createPool, migrate } from './db.js';
import { buildApp } from './app.js';
import { SimulatedAdapter, type PaymentAdapter } from './payments/adapter.js';
import { PaystackTestAdapter } from './payments/paystack.js';
import { anthropicModel } from './agent/orchestrator.js';
import { applyRules } from './services/finance.js';
import { categoriseWithModel } from './agent/categorise.js';

const db = createPool();
await migrate(db);

const adapter: PaymentAdapter = config.paystackSecretKey
  ? new PaystackTestAdapter(config.paystackSecretKey)
  : new SimulatedAdapter();
const model = modelConfigured() ? anthropicModel() : null;

const app = buildApp({ db, adapter, model });

// Rules first; whatever they cannot place goes to the model, which must pick
// from the fixed category list.
const left = await applyRules(db, 'stu_demo').catch(() => 0);
if (left > 0 && model) {
  categoriseWithModel(db, 'stu_demo').catch((e) => console.warn('Model categorisation skipped:', (e as Error).message));
}

await app.listen({ port: config.port, host: '0.0.0.0' });
console.log(`Hela on ${config.publicUrl}  ·  payments: ${adapter.name}  ·  model: ${model ? config.model : 'not configured'}`);
