import { afterEach, describe, expect, it, vi } from 'vitest';
import { PaystackTestAdapter, paystackReference } from '../src/payments/paystack.js';

afterEach(() => vi.unstubAllGlobals());

const req = {
  reference: 'sched-sch_1a2b-2026-10-15',
  amountMinor: 4_614_087,
  currency: 'KES',
  email: 'amina.student@example.com',
  authorizationCode: 'AUTH_test',
  metadata: { proposal_id: 'pr_1' },
};

describe('Paystack adapter (test mode only)', () => {
  it('refuses a live secret key', () => {
    expect(() => new PaystackTestAdapter('sk_live_abc')).toThrow(/TEST secret key/);
    expect(() => new PaystackTestAdapter('sk_test_abc')).not.toThrow();
  });

  it('maps our key to a valid, stable Paystack reference', () => {
    expect(paystackReference('sched:sch_1a2b:2026-10-15')).toBe('sched-sch-1a2b-2026-10-15');
    expect(paystackReference('abc')).toBe(paystackReference('abc'));
  });

  it('charges the saved authorization in minor units under our reference', async () => {
    const fetch = vi.fn(async () => new Response(JSON.stringify({ status: true, message: 'ok', data: { status: 'success', reference: 'sched-sch-1a2b-2026-10-15', gateway_response: 'Approved' } })));
    vi.stubGlobal('fetch', fetch);
    const r = await new PaystackTestAdapter('sk_test_x').charge(req);
    expect(r).toMatchObject({ status: 'success', provider: 'paystack_test' });
    const [url, init] = fetch.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://api.paystack.co/transaction/charge_authorization');
    const body = JSON.parse(init.body as string);
    expect(body).toMatchObject({ amount: 4_614_087, currency: 'KES', reference: 'sched-sch-1a2b-2026-10-15', authorization_code: 'AUTH_test' });
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer sk_test_x');
  });

  it('on a failed charge, checks whether the reference was already paid instead of charging again', async () => {
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ status: false, message: 'Duplicate Transaction Reference' }), { status: 400 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ status: true, message: 'ok', data: { status: 'success', reference: 'sched-sch-1a2b-2026-10-15' } })));
    vi.stubGlobal('fetch', fetch);
    const r = await new PaystackTestAdapter('sk_test_x').charge(req);
    expect(r.status).toBe('success');
    expect(fetch).toHaveBeenCalledTimes(2);
    expect((fetch.mock.calls[1] as [string])[0]).toContain('/transaction/verify/sched-sch-1a2b-2026-10-15');
  });
});
