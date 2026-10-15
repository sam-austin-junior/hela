import type { ChargeRequest, ChargeResult, PaymentAdapter } from './adapter.js';

// Paystack in TEST MODE only. A live key is refused at start-up, so this
// build can never move real money.
//
// Flow: the student links a card once through Paystack's hosted checkout
// (test card), which returns a reusable authorization. Payments then charge
// that authorization with our idempotency key as the reference; Paystack
// itself rejects a reused reference, a second guard against double charges.

const BASE = 'https://api.paystack.co';

/**
 * Paystack references allow letters, digits, '-', '.' and '='. Map our key
 * onto that set; the same key always gives the same reference, so a replay
 * still hits Paystack's duplicate-reference guard.
 */
export function paystackReference(key: string): string {
  return key.replace(/[^A-Za-z0-9.=-]/g, '-');
}

interface PaystackEnvelope<T> {
  status: boolean;
  message: string;
  data: T;
}

export class PaystackTestAdapter implements PaymentAdapter {
  readonly name = 'paystack_test';

  constructor(private readonly secretKey: string) {
    if (!secretKey.startsWith('sk_test_')) {
      throw new Error('Hela only accepts a Paystack TEST secret key (sk_test_...). Live keys are refused.');
    }
  }

  private async call<T>(method: 'GET' | 'POST', path: string, body?: unknown): Promise<PaystackEnvelope<T>> {
    const res = await fetch(`${BASE}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${this.secretKey}`,
        'Content-Type': 'application/json',
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(20_000),
    });
    const json = (await res.json().catch(() => ({}))) as Partial<PaystackEnvelope<T>>;
    return { status: Boolean(json.status) && res.ok, message: json.message ?? `HTTP ${res.status}`, data: json.data as T };
  }

  async charge(req: ChargeRequest): Promise<ChargeResult> {
    const r = await this.call<{ status: string; reference: string; gateway_response?: string }>(
      'POST',
      '/transaction/charge_authorization',
      {
        authorization_code: req.authorizationCode,
        email: req.email,
        amount: req.amountMinor,
        currency: req.currency,
        reference: paystackReference(req.reference),
        metadata: { ...req.metadata, hela_key: req.reference },
      },
    );
    if (r.status && r.data?.status === 'success') {
      return { status: 'success', provider: this.name, providerRef: r.data.reference, message: r.data.gateway_response ?? r.message };
    }
    // A reused reference means an earlier attempt reached Paystack: look it up
    // rather than charging again.
    const existing = await this.call<{ status: string; reference: string; gateway_response?: string }>(
      'GET',
      `/transaction/verify/${encodeURIComponent(paystackReference(req.reference))}`,
    );
    if (existing.status && existing.data?.status === 'success') {
      return { status: 'success', provider: this.name, providerRef: existing.data.reference, message: 'Already charged under this reference' };
    }
    return {
      status: 'failed',
      provider: this.name,
      providerRef: paystackReference(req.reference),
      message: r.data?.gateway_response ?? r.message,
    };
  }

  async startLink(input: { email: string; reference: string; callbackUrl: string }): Promise<{ url: string }> {
    // A small KES 50 verification charge on a test card creates the reusable authorization.
    const r = await this.call<{ authorization_url: string }>('POST', '/transaction/initialize', {
      email: input.email,
      amount: 5000,
      currency: 'KES',
      reference: input.reference,
      callback_url: input.callbackUrl,
      channels: ['card'],
      metadata: { purpose: 'link_payment_method' },
    });
    if (!r.status) throw new Error(`Paystack: ${r.message}`);
    return { url: r.data.authorization_url };
  }

  async finishLink(reference: string): Promise<{ authorizationCode: string; label: string; email: string }> {
    const r = await this.call<{
      status: string;
      customer: { email: string };
      authorization: { authorization_code: string; reusable: boolean; brand: string; last4: string };
    }>('GET', `/transaction/verify/${encodeURIComponent(reference)}`);
    if (!r.status || r.data.status !== 'success') throw new Error(`Paystack verification failed: ${r.message}`);
    if (!r.data.authorization.reusable) throw new Error('This card cannot be charged again without the student.');
    return {
      authorizationCode: r.data.authorization.authorization_code,
      label: `${r.data.authorization.brand} ·${r.data.authorization.last4} (Paystack test)`,
      email: r.data.customer.email,
    };
  }
}
