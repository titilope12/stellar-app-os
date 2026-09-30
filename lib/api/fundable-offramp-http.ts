/**
 * Shared HTTP helpers for the Fundable offramp API routes.
 *
 * These routes are a thin, validated proxy in front of Fundable's offramp REST
 * API. Two rules drive the helpers here:
 *   - The upstream host is undocumented, so upstream failures must never leak as
 *     a plausible-looking 200. Anything we cannot classify becomes a 502.
 *   - The caller supplies the `x-wallet-id` (a Stellar public key, not a secret),
 *     so it is validated before being forwarded — the proxy must not relay
 *     malformed identities to a third party on our behalf.
 */

import { NextResponse } from 'next/server';
import { MemoryRateLimiter } from '@/lib/rate-limit';
import {
  FundableOfframpError,
  getHostedOfframpUrl,
  isStellarPublicKey,
} from '@/lib/stellar/fundable-offramp';

/** Proxy calls are cheap but reach a third party, so keep the budget modest. */
const limiter = new MemoryRateLimiter({ windowMs: 60_000, maxRequests: 30 });

export interface OfframpErrorBody {
  success: false;
  error: string;
  code: string;
  /** Present when the caller should fall back to the hosted workspace. */
  hostedOfframpUrl?: string;
}

function fail(
  status: number,
  error: string,
  code: string,
  extra?: Partial<OfframpErrorBody>
): NextResponse {
  return NextResponse.json({ success: false, error, code, ...extra } satisfies OfframpErrorBody, {
    status,
  });
}

/** Client-supplied the wrong/missing parameters. */
export function badRequest(error: string, code = 'invalid_request'): NextResponse {
  return fail(400, error, code);
}

export function invalidJson(): NextResponse {
  return fail(400, 'Invalid JSON body', 'invalid_json');
}

export function unauthorized(error = 'A connected wallet is required.'): NextResponse {
  return fail(401, error, 'unauthorized');
}

/**
 * The integration is feature-flagged. When off, callers get a 503 plus the
 * hosted link so the UI can still send users somewhere useful.
 */
export function offrampDisabled(): NextResponse {
  return fail(503, 'Fundable offramp is not enabled in this environment.', 'offramp_disabled', {
    hostedOfframpUrl: getHostedOfframpUrl(),
  });
}

/**
 * Maps a thrown error onto a response. Upstream 4xx statuses are preserved so
 * callers see a real rejection; everything else collapses to 502 rather than
 * pretending the request succeeded.
 */
export function offrampErrorResponse(error: unknown): NextResponse {
  if (error instanceof FundableOfframpError) {
    const status = error.status >= 400 && error.status < 500 ? error.status : 502;
    const code =
      status === 404
        ? 'not_found'
        : status === 409
          ? 'conflict'
          : status === 502
            ? 'upstream_error'
            : 'upstream_rejected';
    return fail(status, error.message, code);
  }

  if (error instanceof SyntaxError) {
    return fail(502, 'Fundable offramp returned a malformed response.', 'upstream_error');
  }

  return fail(502, 'Unexpected Fundable offramp error.', 'upstream_error');
}

export function tooManyRequests(retryAfter?: number): NextResponse {
  return NextResponse.json(
    { success: false, error: 'Too many requests. Please try again later.', code: 'rate_limited' },
    { status: 429, headers: { 'Retry-After': String(retryAfter ?? 60) } }
  );
}

export function clientIp(request: Request): string {
  return request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() || 'unknown';
}

/** Applies the shared proxy budget, keyed by client IP. */
export async function checkRateLimit(request: Request): Promise<NextResponse | null> {
  const limit = await limiter.limit(`fundable-offramp:${clientIp(request)}`);
  if (!limit.success) return tooManyRequests(limit.retryAfter);
  return null;
}

/** Reads a JSON body, returning null for malformed payloads. */
export async function readJsonBody<T>(request: Request): Promise<T | null> {
  try {
    const body = (await request.json()) as T;
    if (body === null || typeof body !== 'object') return null;
    return body;
  } catch {
    return null;
  }
}

/**
 * Resolves the wallet identity to forward upstream.
 *
 * Prefers an explicit body/query value over the `x-wallet-id` header. Returns
 * null when the value is absent or is not a well-formed Stellar public key, so
 * the caller can answer 401/400 instead of relaying a bogus identity.
 */
export function resolveWalletId(
  request: Request,
  explicit?: unknown
): { walletId: string } | { error: NextResponse } {
  const candidate =
    (typeof explicit === 'string' && explicit.trim()) ||
    request.headers.get('x-wallet-id')?.trim() ||
    null;

  if (!candidate) return { error: unauthorized() };
  if (!isStellarPublicKey(candidate)) {
    return {
      error: badRequest('walletId must be a valid Stellar public key.', 'invalid_wallet_id'),
    };
  }
  return { walletId: candidate };
}

export function ok<T extends Record<string, unknown>>(body: T, status = 200): NextResponse {
  return NextResponse.json(
    { success: true, ...body },
    { status, headers: { 'Cache-Control': 'no-store' } }
  );
}

/** Coerces a query-string value into a positive finite number. */
export function parsePositiveNumber(value: string | null): number | null {
  if (value === null || value.trim() === '') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

/** Non-empty trimmed string, or null. */
export function parseRequiredString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}
