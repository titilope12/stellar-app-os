/**
 * Unit tests for the Fundable offramp client.
 *
 * The upstream API is undocumented, so these tests pin the exact request shapes
 * (paths, query params, `x-wallet-id` header) and the failure contract: transport
 * and malformed-response errors must surface as FundableOfframpError, never as a
 * silently empty successful result.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  buildFundableOfframpBaseUrl,
  createFundableOfframpClient,
  FundableOfframpError,
  getFundableOfframpBaseUrl,
  getHostedOfframpUrl,
  isFundableOfframpEnabled,
  isStellarPublicKey,
} from '../fundable-offramp';

const WALLET = 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5';
const BASE = 'https://offramp.example.com';

function fakeResponse(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => (typeof body === 'string' ? body : JSON.stringify(body)),
  } as unknown as Response;
}

function mockFetch(
  handler: (url: string, init: RequestInit) => Response | Promise<Response>
): typeof fetch {
  return vi.fn(async (input: unknown, init?: unknown) =>
    handler(String(input), (init ?? {}) as RequestInit)
  ) as unknown as typeof fetch;
}

function client(fetchImpl: typeof fetch, walletId: string = WALLET) {
  return createFundableOfframpClient({ baseUrl: BASE, walletId, fetchImpl });
}

beforeEach(() => {
  vi.unstubAllEnvs();
});

afterEach(() => {
  vi.restoreAllMocks();
});

// ── Configuration ─────────────────────────────────────────────────────────────

describe('buildFundableOfframpBaseUrl', () => {
  it('appends /api/offramp to a bare origin', () => {
    expect(buildFundableOfframpBaseUrl('https://host.example.com')).toBe(
      'https://host.example.com/api/offramp'
    );
  });

  it('does not double up an existing /api suffix', () => {
    expect(buildFundableOfframpBaseUrl('https://host.example.com/api')).toBe(
      'https://host.example.com/api/offramp'
    );
  });

  it('trims trailing slashes and whitespace', () => {
    expect(buildFundableOfframpBaseUrl('  https://host.example.com///  ')).toBe(
      'https://host.example.com/api/offramp'
    );
  });

  it('still rejects an all-whitespace base even after trimming', () => {
    expect(() => buildFundableOfframpBaseUrl('\n\t ')).toThrow(FundableOfframpError);
  });

  it('throws rather than building a relative URL from an empty base', () => {
    expect(() => buildFundableOfframpBaseUrl('   ')).toThrow(FundableOfframpError);
  });
});

describe('environment flags', () => {
  it('is disabled unless FUNDABLE_OFFRAMP_ENABLED is exactly "true"', () => {
    vi.stubEnv('FUNDABLE_OFFRAMP_ENABLED', '1');
    expect(isFundableOfframpEnabled()).toBe(false);

    vi.stubEnv('FUNDABLE_OFFRAMP_ENABLED', 'true');
    expect(isFundableOfframpEnabled()).toBe(true);
  });

  it('exposes the hosted workspace as a fallback target', () => {
    vi.stubEnv('NEXT_PUBLIC_FUNDABLE_OFFRAMP_URL', '');
    expect(getHostedOfframpUrl()).toBe('https://stellar.fundable.finance/offramp');

    vi.stubEnv('NEXT_PUBLIC_FUNDABLE_OFFRAMP_URL', 'https://offramp.test/start');
    expect(getHostedOfframpUrl()).toBe('https://offramp.test/start');
  });

  it('falls back to the default base URL when the env var is blank', () => {
    vi.stubEnv('FUNDABLE_API_BASE_URL', '');
    vi.stubEnv('NEXT_PUBLIC_FUNDABLE_API_BASE_URL', '');
    expect(getFundableOfframpBaseUrl()).toBe(
      'https://king-prawn-app-bt2xr.ondigitalocean.app/api/offramp'
    );

    vi.stubEnv('FUNDABLE_API_BASE_URL', 'https://override.example.com');
    expect(getFundableOfframpBaseUrl()).toBe('https://override.example.com/api/offramp');
  });
});

describe('isStellarPublicKey', () => {
  it('accepts a well-formed ed25519 public key', () => {
    expect(isStellarPublicKey(WALLET)).toBe(true);
  });

  it('rejects secrets, short strings and non-G prefixes', () => {
    expect(isStellarPublicKey('S' + WALLET.slice(1))).toBe(false);
    expect(isStellarPublicKey(WALLET.slice(0, 20))).toBe(false);
    expect(isStellarPublicKey('')).toBe(false);
    expect(isStellarPublicKey(undefined)).toBe(false);
    // '0' and '1' are not in the Stellar base32 alphabet.
    expect(isStellarPublicKey('G' + '0'.repeat(55))).toBe(false);
  });
});

// ── Read endpoints ────────────────────────────────────────────────────────────

describe('listCountries', () => {
  it('GETs /countries and unwraps the data envelope', async () => {
    const fetchImpl = mockFetch(() => fakeResponse({ data: [{ code: 'NG', currency: 'NGN' }] }));

    const countries = await client(fetchImpl).listCountries();

    expect(fetchImpl).toHaveBeenCalledOnce();
    const [url, init] = (fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(String(url)).toBe(`${BASE}/api/offramp/countries`);
    expect((init as RequestInit).method).toBe('GET');
    expect(countries).toEqual([{ code: 'NG', currency: 'NGN' }]);
  });

  it('rejects a non-array payload instead of returning it', async () => {
    const fetchImpl = mockFetch(() => fakeResponse({ data: { nope: true } }));
    await expect(client(fetchImpl).listCountries()).rejects.toThrow(/Invalid offramp country data/);
  });
});

describe('listBanks', () => {
  it('forwards the corridor as query params plus the wallet header', async () => {
    const fetchImpl = mockFetch(() => fakeResponse([{ code: '058', name: 'GTBank' }]));

    const banks = await client(fetchImpl).listBanks({
      country: 'NG',
      currency: 'NGN',
      providerId: 'cashwyre',
    });

    const [url, init] = (fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls[0];
    const parsed = new URL(String(url));
    expect(parsed.pathname).toBe('/api/offramp/banks');
    expect(parsed.searchParams.get('country')).toBe('NG');
    expect(parsed.searchParams.get('currency')).toBe('NGN');
    expect(parsed.searchParams.get('providerId')).toBe('cashwyre');
    expect((init as RequestInit).headers).toMatchObject({ 'x-wallet-id': WALLET });
    expect(banks).toEqual([{ code: '058', name: 'GTBank' }]);
  });

  it('omits undefined params rather than sending the string "undefined"', async () => {
    const fetchImpl = mockFetch(() => fakeResponse([]));

    await client(fetchImpl).listBanks({ country: 'NG', currency: 'NGN' });

    const [url] = (fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(new URL(String(url)).searchParams.has('providerId')).toBe(false);
  });
});

describe('getRates', () => {
  it('always pins token=USDC and network=stellar', async () => {
    const fetchImpl = mockFetch(() =>
      fakeResponse({ best: { currency: 'NGN', rate: 1570, providerId: 'cashwyre' } })
    );

    const rates = await client(fetchImpl).getRates({
      amount: 100,
      country: 'NG',
      currency: 'NGN',
    });

    const [url] = (fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls[0];
    const parsed = new URL(String(url));
    expect(parsed.pathname).toBe('/api/offramp/rates');
    expect(parsed.searchParams.get('token')).toBe('USDC');
    expect(parsed.searchParams.get('network')).toBe('stellar');
    expect(parsed.searchParams.get('amount')).toBe('100');
    expect(rates.best?.rate).toBe(1570);
  });
});

// ── Write endpoints ───────────────────────────────────────────────────────────

describe('verifyAccount', () => {
  it('POSTs the account details and returns the resolved name', async () => {
    const fetchImpl = mockFetch(() => fakeResponse({ accountName: 'ADA OKONKWO' }));

    const account = await client(fetchImpl).verifyAccount({
      bankCode: '058',
      accountNumber: '0123456789',
      country: 'NG',
      currency: 'NGN',
    });

    const [url, init] = (fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(String(url)).toBe(`${BASE}/api/offramp/verify-account`);
    expect((init as RequestInit).method).toBe('POST');
    expect(JSON.parse(String((init as RequestInit).body))).toEqual({
      bankCode: '058',
      accountNumber: '0123456789',
      country: 'NG',
      currency: 'NGN',
    });
    expect(account).toEqual({ accountName: 'ADA OKONKWO' });
  });

  it('fails when the provider returns no account name', async () => {
    const fetchImpl = mockFetch(() => fakeResponse({}));
    await expect(
      client(fetchImpl).verifyAccount({
        bankCode: '058',
        accountNumber: '0123456789',
        country: 'NG',
        currency: 'NGN',
      })
    ).rejects.toThrow(/could not be verified/);
  });
});

describe('createQuote / createFromQuote', () => {
  it('creates a quote with the verified account name', async () => {
    const fetchImpl = mockFetch(() => fakeResponse({ quoteId: 'quote-1' }));

    const quote = await client(fetchImpl).createQuote({
      amount: 50,
      country: 'NG',
      currency: 'NGN',
      bankCode: '058',
      accountNumber: '0123456789',
      accountName: 'ADA OKONKWO',
    });

    const [url, init] = (fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(String(url)).toBe(`${BASE}/api/offramp/quote`);
    expect(JSON.parse(String((init as RequestInit).body))).toMatchObject({
      token: 'USDC',
      network: 'stellar',
      amount: 50,
      accountName: 'ADA OKONKWO',
    });
    expect(quote.quoteId).toBe('quote-1');
  });

  it('rejects a quote response with no quoteId', async () => {
    const fetchImpl = mockFetch(() => fakeResponse({}));
    await expect(
      client(fetchImpl).createQuote({
        amount: 50,
        country: 'NG',
        currency: 'NGN',
        bankCode: '058',
        accountNumber: '0123456789',
        accountName: 'ADA OKONKWO',
      })
    ).rejects.toThrow(/did not return an offramp quote/);
  });

  it('surfaces the CCTP requirement when the bridge provider is unsupported', async () => {
    const fetchImpl = mockFetch(() => fakeResponse({ bridgeProvider: 'other_bridge' }));
    await expect(client(fetchImpl).createFromQuote('quote-1')).rejects.toThrow(
      /not ready for CCTP transfer/
    );
  });
});

// ── Failure contract ──────────────────────────────────────────────────────────

describe('error handling', () => {
  it('maps an upstream error payload onto FundableOfframpError', async () => {
    const fetchImpl = mockFetch(() =>
      fakeResponse({ message: 'Corridor temporarily unavailable' }, 503)
    );

    await expect(client(fetchImpl).getStatus('order-1')).rejects.toMatchObject({
      name: 'FundableOfframpError',
      message: 'Corridor temporarily unavailable',
      status: 503,
      retriable: true,
    });
  });

  it('preserves the upstream 4xx status for a real rejection', async () => {
    const fetchImpl = mockFetch(() => fakeResponse({ error: 'Account not found' }, 404));

    await expect(client(fetchImpl).getStatus('order-1')).rejects.toMatchObject({
      status: 404,
      retriable: false,
    });
  });

  it('reports a network failure as a non-retriable-classified 502', async () => {
    const fetchImpl = mockFetch(() => {
      throw new Error('ECONNREFUSED');
    });

    await expect(client(fetchImpl).listCountries()).rejects.toMatchObject({
      status: 502,
      message: 'Unable to reach the Fundable offramp service.',
    });
  });

  it('treats an empty body as an error rather than empty success', async () => {
    const fetchImpl = mockFetch(() => fakeResponse(''));
    await expect(client(fetchImpl).listCountries()).rejects.toThrow(/empty response/);
  });
});

// ── Full flow ─────────────────────────────────────────────────────────────────

describe('offramp', () => {
  it('runs quote → create → approve → burn → status with wallet signing delegated', async () => {
    const signer = vi.fn(async (xdr: string) => `signed:${xdr}`);
    const seen: string[] = [];

    const fetchImpl = mockFetch((url) => {
      const path = new URL(String(url)).pathname;
      seen.push(path);

      if (path.endsWith('/quote')) return fakeResponse({ quoteId: 'quote-1' });
      if (path.endsWith('/create')) {
        return fakeResponse({
          bridgeProvider: 'circle_cctp',
          reference: 'order-1',
          unsignedApprovalXdr: 'approval-xdr',
        });
      }
      if (path.endsWith('/submit-approval')) return fakeResponse({ ok: true });
      if (path.endsWith('/burn-xdr')) return fakeResponse({ unsignedBurnXdr: 'burn-xdr' });
      if (path.endsWith('/submit-burn')) return fakeResponse({ ok: true });
      if (path.endsWith('/status/order-1')) {
        return fakeResponse({ status: 'processing', amountOut: '78,500' });
      }
      return fakeResponse({}, 404);
    });

    const status = await client(fetchImpl).offramp(
      {
        amount: 50,
        country: 'NG',
        currency: 'NGN',
        bankCode: '058',
        accountNumber: '0123456789',
        accountName: 'ADA OKONKWO',
      },
      signer
    );

    expect(seen).toEqual([
      '/api/offramp/quote',
      '/api/offramp/create',
      '/api/offramp/order-1/cctp/submit-approval',
      '/api/offramp/order-1/cctp/burn-xdr',
      '/api/offramp/order-1/cctp/submit-burn',
      '/api/offramp/status/order-1',
    ]);
    expect(signer).toHaveBeenNthCalledWith(1, 'approval-xdr');
    expect(signer).toHaveBeenNthCalledWith(2, 'burn-xdr');
    expect(status.status).toBe('processing');
  });

  it('refuses to start without a wallet', async () => {
    const fetchImpl = mockFetch(() => fakeResponse({}));
    const orphan = createFundableOfframpClient({ baseUrl: BASE, fetchImpl });

    await expect(
      orphan.offramp(
        {
          amount: 1,
          country: 'NG',
          currency: 'NGN',
          bankCode: '058',
          accountNumber: '1',
          accountName: 'X',
        },
        async (xdr) => xdr
      )
    ).rejects.toThrow(/Connect your wallet/);
  });
});
