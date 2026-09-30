/**
 * Fundable offramp client — Stellar USDC → local fiat (NGN, KES, GHS, ZAR, …).
 *
 * Fundable's offramp workspace is a client-side SPA backed by a REST API served
 * from `<base>/api/offramp`. It is deliberately *not* treated as a SEP anchor:
 * `stellar.fundable.finance/.well-known/stellar.toml` serves the SPA's HTML, so
 * there is no SEP-10/24 service discovery to read. Requests are authenticated
 * with an `x-wallet-id` header carrying the user's Stellar public key — there is
 * no server-side API key.
 *
 * Two consequences shape this module:
 *   1. Wallet signing stays on the client. The Circle CCTP approval/burn
 *      transactions are produced as unsigned XDR and signed by the user's wallet
 *      (Freighter/Albedo/xBull), so this client never touches a secret key.
 *   2. The upstream host is undocumented and can change without notice, so every
 *      call is funneled through `FundableOfframpError` and callers are expected
 *      to degrade gracefully (see `getHostedOfframpUrl`).
 */

export type OfframpNetwork = 'stellar';

/** Assets Fundable currently settles. Offramp is USDC-only on Stellar. */
export const OFFRAMP_TOKEN = 'USDC' as const;

/** Default backend for Fundable's Stellar deployment. */
export const DEFAULT_FUNDABLE_API_BASE_URL = 'https://king-prawn-app-bt2xr.ondigitalocean.app';

/** Hosted workspace — the no-API fallback entry point. */
export const DEFAULT_FUNDABLE_OFFRAMP_URL = 'https://stellar.fundable.finance/offramp';

/** Upstream poll cadence used by Fundable's own client. */
export const OFFRAMP_POLL_INTERVAL_MS = 5_000;
export const OFFRAMP_POLL_TIMEOUT_MS = 15 * 60_000;

// ── Errors ────────────────────────────────────────────────────────────────────

/**
 * Raised for any upstream/transport failure. `status` is the HTTP status when the
 * upstream responded, or 502 when the request never completed.
 */
export class FundableOfframpError extends Error {
  readonly status: number;
  readonly code?: string;
  readonly retriable: boolean;

  constructor(message: string, status = 502, code?: string) {
    super(message);
    this.name = 'FundableOfframpError';
    this.status = status;
    this.code = code;
    this.retriable = status >= 500 || status === 429;
  }
}

// ── Types ─────────────────────────────────────────────────────────────────────

export interface OfframpCountry {
  /** ISO 3166-1 alpha-2, e.g. `NG`. */
  code: string;
  /** ISO 4217 payout currency, e.g. `NGN`. */
  currency: string;
  name?: string;
}

export interface OfframpBank {
  /** Provider-specific bank code, passed back as `bankCode`. */
  code: string;
  name: string;
}

/** A single provider's rate for a corridor. */
export interface OfframpRate {
  /** Payout currency, e.g. `NGN`. */
  currency: string;
  /** Local currency units per 1 USDC. */
  rate: number;
  /** Provider id — round-trip this into `verifyAccount`/`createQuote`. */
  providerId?: string;
  /** Fixed fee in the payout currency. */
  providerFee?: number;
  /** Opaque reference the provider issued for this rate. */
  quoteReference?: string;
}

/** `/rates` response. `best` is absent when the corridor has no liquidity. */
export interface OfframpRates {
  best?: OfframpRate | null;
}

export interface OfframpBankAccount {
  accountName: string;
}

export interface VerifyAccountInput {
  bankCode: string;
  accountNumber: string;
  country: string;
  currency: string;
  providerId?: string;
}

export interface CreateQuoteInput {
  amount: number;
  country: string;
  currency: string;
  bankCode: string;
  accountNumber: string;
  accountName: string;
  providerId?: string;
  email?: string;
  token?: typeof OFFRAMP_TOKEN;
  network?: OfframpNetwork;
}

export interface OfframpQuote {
  quoteId: string;
  /** USDC to send, when quoted back by the provider. */
  sendAmount?: number;
  /** Local currency the recipient receives. */
  receiveAmount?: number;
  /** Payout currency. */
  currency?: string;
  rate?: number;
  providerId?: string;
  /** ISO timestamp after which the quote must be re-fetched. */
  expiresAt?: string;
}

export interface OfframpOrder {
  orderId?: string;
  /** Only `circle_cctp` orders can be completed on Stellar. */
  bridgeProvider: string;
  /** Unsigned Circle CCTP approval transaction for the user's wallet. */
  unsignedApprovalXdr?: string;
  reference?: string;
  status?: OfframpStatusValue;
  [key: string]: unknown;
}

export type OfframpStatusValue =
  | 'pending'
  | 'awaiting_approval'
  | 'awaiting_burn'
  | 'processing'
  | 'completed'
  | 'failed'
  | 'refunded';

export interface OfframpOrderStatus {
  id?: string;
  status: OfframpStatusValue | string;
  message?: string;
  /** Amount delivered to the recipient's bank/mobile-money account. */
  amountOut?: string;
  currency?: string;
  externalReference?: string;
  [key: string]: unknown;
}

/**
 * Wallet-signing hook. Fundable returns unsigned CCTP XDRs; the wallet adapter
 * in `lib/stellar/signing.ts` signs them. Injected so this module stays pure and
 * testable.
 */
export type OfframpSigner = (xdr: string) => Promise<string>;

// ── Configuration ─────────────────────────────────────────────────────────────

/**
 * Normalises the configured backend into Fundable's offramp namespace.
 * Accepts either a bare origin (`https://host`) or one already suffixed with
 * `/api`, and appends `/api/offramp` accordingly.
 */
export function buildFundableOfframpBaseUrl(rawBase: string): string {
  const trimmed = rawBase.trim().replace(/\/+$/, '');
  if (!trimmed) {
    throw new FundableOfframpError('Fundable offramp API configuration is incomplete.', 500);
  }
  return `${trimmed.endsWith('/api') ? trimmed : `${trimmed}/api`}/offramp`;
}

/**
 * First non-blank value wins. An env var set to an empty string is treated as
 * unset — otherwise a stray `FUNDABLE_API_BASE_URL=` in a deploy config would
 * silently produce a relative URL.
 */
function firstNonBlank(...values: Array<string | undefined>): string | undefined {
  for (const value of values) {
    const trimmed = value?.trim();
    if (trimmed) return trimmed;
  }
  return undefined;
}

/** Resolves the offramp API base URL from the environment. */
export function getFundableOfframpBaseUrl(): string {
  return buildFundableOfframpBaseUrl(
    firstNonBlank(
      process.env.FUNDABLE_API_BASE_URL,
      process.env.NEXT_PUBLIC_FUNDABLE_API_BASE_URL
    ) ?? DEFAULT_FUNDABLE_API_BASE_URL
  );
}

/**
 * Hosted offramp workspace. Used as the fallback when the API is disabled or
 * unreachable, so users can always complete an offramp manually.
 */
export function getHostedOfframpUrl(): string {
  return (
    firstNonBlank(process.env.NEXT_PUBLIC_FUNDABLE_OFFRAMP_URL) ?? DEFAULT_FUNDABLE_OFFRAMP_URL
  );
}

/**
 * Offramp routes are opt-in: the upstream host is undocumented, so it must be
 * enabled explicitly rather than switching on for every environment.
 */
export function isFundableOfframpEnabled(): boolean {
  return process.env.FUNDABLE_OFFRAMP_ENABLED === 'true';
}

/** Stellar ed25519 public keys are `G` + 55 base32 characters. */
export function isStellarPublicKey(value: unknown): value is string {
  return typeof value === 'string' && /^G[A-Z2-7]{55}$/.test(value);
}

// ── HTTP plumbing ─────────────────────────────────────────────────────────────

interface RequestOptions {
  method: 'GET' | 'POST';
  path: string;
  /** Query string parameters; `undefined` entries are dropped. */
  params?: Record<string, string | number | undefined>;
  body?: unknown;
  walletId?: string;
}

export interface FundableOfframpClientOptions {
  baseUrl?: string;
  /** Default wallet id, e.g. from an authenticated session. */
  walletId?: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

export interface FundableOfframpClient {
  listCountries(): Promise<OfframpCountry[]>;
  listBanks(params: {
    country: string;
    currency: string;
    providerId?: string;
    walletId?: string;
  }): Promise<OfframpBank[]>;
  getRates(params: {
    amount: number;
    country: string;
    currency: string;
    token?: typeof OFFRAMP_TOKEN;
    network?: OfframpNetwork;
  }): Promise<OfframpRates>;
  verifyAccount(input: VerifyAccountInput, walletId?: string): Promise<OfframpBankAccount>;
  createQuote(input: CreateQuoteInput, walletId?: string): Promise<OfframpQuote>;
  createFromQuote(quoteId: string, walletId?: string): Promise<OfframpOrder>;
  getCctpBurnXdr(orderId: string, walletId?: string): Promise<{ unsignedBurnXdr: string }>;
  submitCctpApproval(orderId: string, signedXdr: string, walletId?: string): Promise<unknown>;
  submitCctpBurn(orderId: string, signedXdr: string, walletId?: string): Promise<unknown>;
  getStatus(orderId: string, walletId?: string): Promise<OfframpOrderStatus>;
  /**
   * Full client-side settlement: create quote → create order → sign approval →
   * sign burn → submit both. Signing is delegated to `signer`.
   */
  offramp(
    input: CreateQuoteInput & { walletId?: string },
    signer: OfframpSigner
  ): Promise<OfframpOrderStatus>;
}

/** Unwraps Fundable's `{ data: … }` / double-wrapped response envelopes. */
function unwrapEnvelope(payload: unknown): unknown {
  let current: unknown = payload;
  for (let depth = 0; depth < 3; depth += 1) {
    if (
      current === null ||
      typeof current !== 'object' ||
      Array.isArray(current) ||
      !('data' in (current as Record<string, unknown>))
    ) {
      return current;
    }
    current = (current as Record<string, unknown>).data;
  }
  return current;
}

/** Pulls the most useful message out of an upstream error payload. */
function extractErrorMessage(payload: unknown, fallback: string): string {
  const body = unwrapEnvelope(payload);
  if (typeof body === 'string' && body.trim()) return body;
  if (body && typeof body === 'object') {
    const record = body as Record<string, unknown>;
    for (const key of ['error', 'message', 'detail', 'errors']) {
      const value = record[key];
      if (typeof value === 'string' && value.trim()) return value;
      if (Array.isArray(value) && typeof value[0] === 'string') return value[0];
    }
  }
  return fallback;
}

export function createFundableOfframpClient(
  options: FundableOfframpClientOptions = {}
): FundableOfframpClient {
  const baseUrl = buildFundableOfframpBaseUrl(
    firstNonBlank(
      options.baseUrl,
      process.env.FUNDABLE_API_BASE_URL,
      process.env.NEXT_PUBLIC_FUNDABLE_API_BASE_URL
    ) ?? DEFAULT_FUNDABLE_API_BASE_URL
  );
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  const defaultWalletId = options.walletId;
  const timeoutMs = options.timeoutMs ?? 20_000;

  async function request<T>(opts: RequestOptions): Promise<T> {
    const url = new URL(opts.path.replace(/^\//, ''), `${baseUrl}/`);
    for (const [key, value] of Object.entries(opts.params ?? {})) {
      if (value !== undefined && value !== '') url.searchParams.set(key, String(value));
    }

    const walletId = opts.walletId ?? defaultWalletId;
    const headers: Record<string, string> = {};
    if (opts.body !== undefined) headers['Content-Type'] = 'application/json';
    if (walletId) headers['x-wallet-id'] = walletId;

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    let response: Response;
    try {
      response = await fetchImpl(url.toString(), {
        method: opts.method,
        headers,
        body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
        signal: controller.signal,
        cache: 'no-store',
      });
    } catch (error) {
      const aborted = error instanceof Error && error.name === 'AbortError';
      throw new FundableOfframpError(
        aborted
          ? 'Fundable offramp request timed out.'
          : 'Unable to reach the Fundable offramp service.',
        502
      );
    } finally {
      clearTimeout(timer);
    }

    const raw = await response.text();
    let parsed: unknown = undefined;
    if (raw) {
      try {
        parsed = JSON.parse(raw);
      } catch {
        parsed = raw;
      }
    }

    if (!response.ok) {
      throw new FundableOfframpError(
        extractErrorMessage(parsed, `Fundable offramp request failed (${response.status})`),
        response.status
      );
    }

    if (parsed === undefined) {
      throw new FundableOfframpError('Fundable offramp returned an empty response.', 502);
    }

    const body = unwrapEnvelope(parsed);
    if (body === null || body === undefined) {
      throw new FundableOfframpError('Fundable offramp returned an empty response.', 502);
    }
    return body as T;
  }

  const client: FundableOfframpClient = {
    async listCountries() {
      const data = await request<unknown>({ method: 'GET', path: '/countries' });
      if (!Array.isArray(data)) {
        throw new FundableOfframpError('Invalid offramp country data received.', 502);
      }
      return data as OfframpCountry[];
    },

    async listBanks({ country, currency, providerId, walletId }) {
      const data = await request<unknown>({
        method: 'GET',
        path: '/banks',
        params: { country, currency, providerId },
        walletId,
      });
      if (!Array.isArray(data)) {
        throw new FundableOfframpError('Invalid offramp bank data received.', 502);
      }
      return data as OfframpBank[];
    },

    async getRates({ amount, country, currency, token, network }) {
      return request<OfframpRates>({
        method: 'GET',
        path: '/rates',
        params: {
          token: token ?? OFFRAMP_TOKEN,
          amount,
          country,
          currency,
          network: network ?? 'stellar',
        },
      });
    },

    async verifyAccount(input, walletId) {
      const data = await request<unknown>({
        method: 'POST',
        path: '/verify-account',
        walletId,
        body: {
          bankCode: input.bankCode,
          accountNumber: input.accountNumber,
          country: input.country,
          currency: input.currency,
          ...(input.providerId ? { providerId: input.providerId } : {}),
        },
      });
      const accountName = (data as OfframpBankAccount | null)?.accountName;
      if (typeof accountName !== 'string' || !accountName.trim()) {
        throw new FundableOfframpError('Bank account could not be verified.', 422);
      }
      return { accountName };
    },

    async createQuote(input, walletId) {
      const data = await request<OfframpQuote>({
        method: 'POST',
        path: '/quote',
        walletId,
        body: {
          providerId: input.providerId,
          token: input.token ?? OFFRAMP_TOKEN,
          amount: input.amount,
          country: input.country,
          currency: input.currency,
          network: input.network ?? 'stellar',
          bankCode: input.bankCode,
          accountNumber: input.accountNumber,
          accountName: input.accountName,
          ...(input.email ? { email: input.email } : {}),
        },
      });
      if (!data?.quoteId) {
        throw new FundableOfframpError('Fundable did not return an offramp quote.', 502);
      }
      return data;
    },

    async createFromQuote(quoteId, walletId) {
      const data = await request<OfframpOrder>({
        method: 'POST',
        path: '/create',
        walletId,
        body: { quoteId },
      });
      if (data?.bridgeProvider !== 'circle_cctp') {
        throw new FundableOfframpError(
          'This Stellar withdrawal is not ready for CCTP transfer.',
          502
        );
      }
      return data;
    },

    async getCctpBurnXdr(orderId, walletId) {
      const data = await request<{ unsignedBurnXdr?: string; unsigned_burn_xdr?: string }>({
        method: 'POST',
        path: `/${encodeURIComponent(orderId)}/cctp/burn-xdr`,
        walletId,
      });
      const unsignedBurnXdr = data?.unsignedBurnXdr ?? data?.unsigned_burn_xdr;
      if (typeof unsignedBurnXdr !== 'string' || !unsignedBurnXdr) {
        throw new FundableOfframpError('Fundable did not return a burn transaction.', 502);
      }
      return { unsignedBurnXdr };
    },

    async submitCctpApproval(orderId, signedXdr, walletId) {
      return request<unknown>({
        method: 'POST',
        path: `/${encodeURIComponent(orderId)}/cctp/submit-approval`,
        walletId,
        body: { signedXdr },
      });
    },

    async submitCctpBurn(orderId, signedXdr, walletId) {
      return request<unknown>({
        method: 'POST',
        path: `/${encodeURIComponent(orderId)}/cctp/submit-burn`,
        walletId,
        body: { signedXdr },
      });
    },

    async getStatus(orderId, walletId) {
      return request<OfframpOrderStatus>({
        method: 'GET',
        path: `/status/${encodeURIComponent(orderId)}`,
        walletId,
      });
    },

    async offramp(input, signer) {
      const walletId = input.walletId ?? defaultWalletId;
      if (!walletId) {
        throw new FundableOfframpError('Connect your wallet before withdrawing.', 400);
      }

      const quote = await client.createQuote(input, walletId);
      const order = await client.createFromQuote(quote.quoteId, walletId);

      const orderId = order.orderId ?? order.reference;
      if (!orderId) {
        throw new FundableOfframpError('Fundable did not return an offramp order id.', 502);
      }

      if (order.unsignedApprovalXdr) {
        const signedApproval = await signer(order.unsignedApprovalXdr);
        await client.submitCctpApproval(orderId, signedApproval, walletId);
      }

      const { unsignedBurnXdr } = await client.getCctpBurnXdr(orderId, walletId);
      const signedBurn = await signer(unsignedBurnXdr);
      await client.submitCctpBurn(orderId, signedBurn, walletId);

      return client.getStatus(orderId, walletId);
    },
  };

  return client;
}
