// Payment adapters. Hela never holds funds: it asks a payment provider to
// charge the student's own saved payment method, under one idempotency key
// per payment that is passed to the provider as its reference.

export interface ChargeRequest {
  /** Our idempotency key, used as the provider's transaction reference. */
  reference: string;
  amountMinor: number;
  currency: string;
  email: string;
  authorizationCode: string;
  metadata: Record<string, string>;
}

export interface ChargeResult {
  status: 'success' | 'failed';
  provider: string;
  providerRef: string;
  message: string;
}

export interface PaymentAdapter {
  readonly name: string;
  charge(req: ChargeRequest): Promise<ChargeResult>;
  /** Start linking a payment method; returns a URL the student opens. */
  startLink?(input: { email: string; reference: string; callbackUrl: string }): Promise<{ url: string }>;
  /** Finish linking: verify the transaction and return a reusable token. */
  finishLink?(reference: string): Promise<{ authorizationCode: string; label: string; email: string }>;
}

/**
 * Offline sandbox provider, for development and tests without Paystack keys.
 * It remembers references so a replayed charge returns the first result,
 * the same way a real provider rejects a duplicate reference.
 */
export class SimulatedAdapter implements PaymentAdapter {
  readonly name = 'simulated';
  readonly charges: ChargeRequest[] = [];
  private readonly seen = new Map<string, ChargeResult>();

  async charge(req: ChargeRequest): Promise<ChargeResult> {
    const earlier = this.seen.get(req.reference);
    if (earlier) return earlier;
    this.charges.push(req);
    const result: ChargeResult = {
      status: 'success',
      provider: this.name,
      providerRef: `SIM-${req.reference.slice(0, 12)}`,
      message: 'Approved (simulated sandbox)',
    };
    this.seen.set(req.reference, result);
    return result;
  }
}
