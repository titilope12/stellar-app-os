/**
 * Route-level tests for the Fundable offramp API.
 *
 * Fundable's backend is undocumented, so every upstream call is stubbed here and
 * the tests pin the behaviour we control: the feature flag gate, input
 * validation, wallet-id validation, and the mapping of upstream failures onto
 * honest HTTP statuses.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { GET as configGET } from '../route';
import { GET as countriesGET } from '../countries/route';
import { GET as banksGET } from '../banks/route';
import { GET as ratesGET } from '../rates/route';
import { POST as verifyAccountPOST } from '../verify-account/route';
import { POST as quotesPOST } from '../quotes/route';
import { POST as ordersPOST } from '../orders/route';
import { GET as orderGET } from '../orders/[id]/route';
import { POST as cctpPOST } from '../orders/[id]/cctp/route';

const BASE = 'http://localhost/api/anchor/fundable-offramp';
const WALLET = 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5';
const UPSTREAM = 'https://offramp.example.com';

let ipCounter = 0;

function fakeResponse(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: () => Promise.resolve(typeof body === 'string' ? body : JSON.stringify(body)),
  } as unknown as Response;
}

function stubUpstream(
  handler: (url: string, init: RequestInit) => Response | Promise<Response>
): ReturnType<typeof vi.fn> {
  const mock = vi.fn((input: unknown, init?: unknown) =>
    handler(String(input), (init ?? {}) as RequestInit)
  );
  vi.stubGlobal('fetch', mock);
  return mock;
}

/**
 * Unique `x-forwarded-for` per request so the shared in-memory rate limiter is
 * keyed per test rather than shared across the whole file.
 */
function req(
  path: string,
  method = 'GET',
  body?: unknown,
  headers: Record<string, string> = {}
): Request {
  ipCounter += 1;
  return new Request(`${BASE}${path}`, {
    method,
    headers: {
      'x-forwarded-for': `10.0.0.${ipCounter}`,
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      ...headers,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

function ctx(id: string): { params: Promise<{ id: string }> } {
  return { params: Promise.resolve({ id }) };
}

beforeEach(() => {
  vi.stubEnv('FUNDABLE_OFFRAMP_ENABLED', 'true');
  vi.stubEnv('FUNDABLE_API_BASE_URL', UPSTREAM);
  vi.stubEnv('NEXT_PUBLIC_FUNDABLE_OFFRAMP_URL', 'https://stellar.fundable.finance/offramp');
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

// ── Feature flag ──────────────────────────────────────────────────────────────

describe('feature flag', () => {
  it('answers 503 with a hosted fallback when the integration is off', async () => {
    vi.stubEnv('FUNDABLE_OFFRAMP_ENABLED', 'false');
    stubUpstream(() => fakeResponse({}));

    const response = await countriesGET(req('/countries'));

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toMatchObject({
      success: false,
      code: 'offramp_disabled',
      hostedOfframpUrl: 'https://stellar.fundable.finance/offramp',
    });
  });

  it('reports capability metadata when enabled', async () => {
    const response = await configGET(req(''));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      success: true,
      enabled: true,
      token: 'USDC',
      network: 'stellar',
      bridgeProvider: 'circle_cctp',
    });
  });
});

// ── Read routes ───────────────────────────────────────────────────────────────

describe('GET /countries', () => {
  it('returns the corridors from upstream', async () => {
    const upstream = stubUpstream(() => fakeResponse({ data: [{ code: 'NG', currency: 'NGN' }] }));

    const response = await countriesGET(req('/countries'));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      success: true,
      countries: [{ code: 'NG', currency: 'NGN' }],
    });
    expect(String(upstream.mock.calls[0][0])).toBe(`${UPSTREAM}/api/offramp/countries`);
  });

  it('maps an upstream outage to 502 rather than a misleading success', async () => {
    stubUpstream(() => {
      throw new Error('ECONNREFUSED');
    });

    const response = await countriesGET(req('/countries'));

    expect(response.status).toBe(502);
    await expect(response.json()).resolves.toMatchObject({ code: 'upstream_error' });
  });
});

describe('GET /banks', () => {
  it('requires both country and currency', async () => {
    stubUpstream(() => fakeResponse([]));

    expect((await banksGET(req('/banks?country=NG'))).status).toBe(400);
    expect((await banksGET(req('/banks?currency=NGN'))).status).toBe(400);
  });

  it('rejects a malformed wallet header instead of forwarding it', async () => {
    const upstream = stubUpstream(() => fakeResponse([]));

    const response = await banksGET(
      req('/banks?country=NG&currency=NGN', 'GET', undefined, { 'x-wallet-id': 'not-a-key' })
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({ code: 'invalid_wallet_id' });
    expect(upstream).not.toHaveBeenCalled();
  });
});

describe('GET /rates', () => {
  it('rejects a non-positive amount', async () => {
    stubUpstream(() => fakeResponse({}));

    expect((await ratesGET(req('/rates?amount=0&country=NG&currency=NGN'))).status).toBe(400);
    expect((await ratesGET(req('/rates?amount=abc&country=NG&currency=NGN'))).status).toBe(400);
    expect((await ratesGET(req('/rates?country=NG&currency=NGN'))).status).toBe(400);
  });

  it('passes a valid corridor through to upstream', async () => {
    stubUpstream(() => fakeResponse({ best: { currency: 'NGN', rate: 1570 } }));

    const response = await ratesGET(req('/rates?amount=100&country=NG&currency=NGN'));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      rates: { best: { currency: 'NGN', rate: 1570 } },
    });
  });
});

// ── Wallet identity ───────────────────────────────────────────────────────────

describe('wallet identity', () => {
  it('requires a wallet on write routes', async () => {
    stubUpstream(() => fakeResponse({}));

    const response = await verifyAccountPOST(
      req('/verify-account', 'POST', {
        bankCode: '058',
        accountNumber: '0123456789',
        country: 'NG',
        currency: 'NGN',
      })
    );

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toMatchObject({ code: 'unauthorized' });
  });

  it('accepts the wallet from the x-wallet-id header', async () => {
    const upstream = stubUpstream(() => fakeResponse({ accountName: 'ADA OKONKWO' }));

    const response = await verifyAccountPOST(
      req(
        '/verify-account',
        'POST',
        { bankCode: '058', accountNumber: '0123456789', country: 'NG', currency: 'NGN' },
        { 'x-wallet-id': WALLET }
      )
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      account: { accountName: 'ADA OKONKWO' },
    });
    const init = upstream.mock.calls[0][1] as RequestInit;
    expect(init.headers).toMatchObject({ 'x-wallet-id': WALLET });
  });
});

// ── Write routes ──────────────────────────────────────────────────────────────

describe('POST /verify-account', () => {
  it('returns 400 for malformed JSON', async () => {
    stubUpstream(() => fakeResponse({}));

    const response = await verifyAccountPOST(
      new Request(`${BASE}/verify-account`, {
        method: 'POST',
        body: 'not-json{',
        headers: { 'x-forwarded-for': '10.9.9.9' },
      })
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({ code: 'invalid_json' });
  });

  it('calls out each missing field', async () => {
    stubUpstream(() => fakeResponse({ accountName: 'X' }));

    const response = await verifyAccountPOST(
      req('/verify-account', 'POST', { bankCode: '058' }, { 'x-wallet-id': WALLET })
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      error: expect.stringContaining('accountNumber'),
    });
  });
});

describe('POST /quotes', () => {
  it('requires the verified accountName', async () => {
    stubUpstream(() => fakeResponse({ quoteId: 'q1' }));

    const response = await quotesPOST(
      req(
        '/quotes',
        'POST',
        {
          amount: 50,
          country: 'NG',
          currency: 'NGN',
          bankCode: '058',
          accountNumber: '0123456789',
        },
        { 'x-wallet-id': WALLET }
      )
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      error: expect.stringContaining('accountName'),
    });
  });

  it('creates a quote and returns the quoteId', async () => {
    stubUpstream(() => fakeResponse({ quoteId: 'quote-1', rate: 1570 }));

    const response = await quotesPOST(
      req(
        '/quotes',
        'POST',
        {
          amount: 50,
          country: 'NG',
          currency: 'NGN',
          bankCode: '058',
          accountNumber: '0123456789',
          accountName: 'ADA OKONKWO',
        },
        { 'x-wallet-id': WALLET }
      )
    );

    expect(response.status).toBe(201);
    await expect(response.json()).resolves.toMatchObject({ quote: { quoteId: 'quote-1' } });
  });
});

describe('POST /orders', () => {
  it('requires a quoteId', async () => {
    stubUpstream(() => fakeResponse({}));

    const response = await ordersPOST(req('/orders', 'POST', {}, { 'x-wallet-id': WALLET }));

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      error: expect.stringContaining('quoteId'),
    });
  });

  it('creates an order and surfaces the reference as orderId', async () => {
    stubUpstream(() =>
      fakeResponse({
        bridgeProvider: 'circle_cctp',
        reference: 'order-1',
        unsignedApprovalXdr: 'approval-xdr',
      })
    );

    const response = await ordersPOST(
      req('/orders', 'POST', { quoteId: 'quote-1' }, { 'x-wallet-id': WALLET })
    );

    expect(response.status).toBe(201);
    await expect(response.json()).resolves.toMatchObject({
      orderId: 'order-1',
      order: { bridgeProvider: 'circle_cctp', unsignedApprovalXdr: 'approval-xdr' },
    });
  });

  it('reports a non-CCTP order as 502 without signing anything', async () => {
    stubUpstream(() => fakeResponse({ bridgeProvider: 'other_bridge' }));

    const response = await ordersPOST(
      req('/orders', 'POST', { quoteId: 'quote-1' }, { 'x-wallet-id': WALLET })
    );

    expect(response.status).toBe(502);
    await expect(response.json()).resolves.toMatchObject({
      error: expect.stringContaining('CCTP'),
    });
  });
});

describe('GET /orders/:id', () => {
  it('requires a wallet', async () => {
    stubUpstream(() => fakeResponse({ status: 'pending' }));

    const response = await orderGET(req('/orders/order-1'), ctx('order-1'));

    expect(response.status).toBe(401);
  });

  it('returns the upstream status', async () => {
    stubUpstream(() => fakeResponse({ status: 'completed', amountOut: '78,500' }));

    const response = await orderGET(
      req('/orders/order-1', 'GET', undefined, { 'x-wallet-id': WALLET }),
      ctx('order-1')
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      status: { status: 'completed', amountOut: '78,500' },
    });
  });

  it('preserves a 404 from upstream', async () => {
    stubUpstream(() => fakeResponse({ error: 'Order not found' }, 404));

    const response = await orderGET(
      req('/orders/missing', 'GET', undefined, { 'x-wallet-id': WALLET }),
      ctx('missing')
    );

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toMatchObject({ code: 'not_found' });
  });
});

// ── CCTP steps ────────────────────────────────────────────────────────────────

describe('POST /orders/:id/cctp', () => {
  it('rejects an unknown action', async () => {
    stubUpstream(() => fakeResponse({}));

    const response = await cctpPOST(
      req('/orders/order-1/cctp', 'POST', { action: 'dance' }, { 'x-wallet-id': WALLET }),
      ctx('order-1')
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      error: expect.stringContaining('action must be one of'),
    });
  });

  it('returns the unsigned burn XDR without requiring a signature', async () => {
    stubUpstream(() => fakeResponse({ unsignedBurnXdr: 'burn-xdr' }));

    const response = await cctpPOST(
      req('/orders/order-1/cctp', 'POST', { action: 'burn-xdr' }, { 'x-wallet-id': WALLET }),
      ctx('order-1')
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      action: 'burn-xdr',
      orderId: 'order-1',
      unsignedBurnXdr: 'burn-xdr',
    });
  });

  it('requires a signed XDR for the submit steps', async () => {
    const upstream = stubUpstream(() => fakeResponse({}));

    const response = await cctpPOST(
      req('/orders/order-1/cctp', 'POST', { action: 'submit-burn' }, { 'x-wallet-id': WALLET }),
      ctx('order-1')
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      error: expect.stringContaining('signedXdr'),
    });
    expect(upstream).not.toHaveBeenCalled();
  });

  it('forwards a signed approval XDR', async () => {
    const upstream = stubUpstream(() => fakeResponse({ ok: true }));

    const response = await cctpPOST(
      req(
        '/orders/order-1/cctp',
        'POST',
        { action: 'submit-approval', signedXdr: 'signed-approval' },
        { 'x-wallet-id': WALLET }
      ),
      ctx('order-1')
    );

    expect(response.status).toBe(200);
    const [url, init] = upstream.mock.calls[0];
    expect(String(url)).toBe(`${UPSTREAM}/api/offramp/order-1/cctp/submit-approval`);
    expect(JSON.parse(String((init as RequestInit).body))).toEqual({
      signedXdr: 'signed-approval',
    });
  });
});
