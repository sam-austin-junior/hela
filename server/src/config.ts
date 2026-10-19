import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Configuration comes only from the environment. Secrets stay on the
// server: nothing here is ever sent to the model or the browser.

// A local .env at the repository root is loaded if present (never committed).
const dotenv = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../.env');
if (existsSync(dotenv)) process.loadEnvFile(dotenv);

function env(name: string): string | undefined {
  const v = process.env[name];
  return v && v.trim() !== '' ? v.trim() : undefined;
}

export const config = {
  databaseUrl: env('DATABASE_URL') ?? 'postgres://hela:hela@127.0.0.1:5544/hela',
  port: Number(env('PORT') ?? 8787),
  // Local only by default: the demo has no login, so it must not be reachable
  // from the network. Docker sets HOST=0.0.0.0 inside its own network.
  host: env('HOST') ?? '127.0.0.1',
  publicUrl: env('PUBLIC_URL') ?? 'http://localhost:8787',
  model: env('HELA_MODEL') ?? 'claude-opus-5-5',
  // Open models on Groq's free tier: the alternative when no Claude key is set.
  groqApiKey: env('GROQ_API_KEY'),
  groqModel: env('HELA_GROQ_MODEL') ?? 'openai/gpt-oss-120b',
  paystackSecretKey: env('PAYSTACK_SECRET_KEY'),
  // The demo shows one-time codes on screen instead of sending an SMS.
  demoOtpOnScreen: env('HELA_DEMO_OTP') !== 'off',
};

export type ModelProvider = 'anthropic' | 'groq';

/**
 * Which model provider to use: HELA_MODEL_PROVIDER if set, otherwise Claude
 * when its key is present, otherwise Groq when its key is present.
 */
export function modelProvider(): ModelProvider | null {
  const anthropic = Boolean(env('ANTHROPIC_API_KEY') ?? env('ANTHROPIC_AUTH_TOKEN'));
  const groq = Boolean(config.groqApiKey);
  const wanted = env('HELA_MODEL_PROVIDER');
  if (wanted === 'anthropic') return anthropic ? 'anthropic' : null;
  if (wanted === 'groq') return groq ? 'groq' : null;
  return anthropic ? 'anthropic' : groq ? 'groq' : null;
}

/** True when some model can be called. */
export function modelConfigured(): boolean {
  return modelProvider() !== null;
}

/** The model actually in use, for logs and evidence. */
export function modelName(): string | null {
  const p = modelProvider();
  return p === 'anthropic' ? config.model : p === 'groq' ? `${config.groqModel} (Groq)` : null;
}
