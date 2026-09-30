/**
 * GET /api/anchor/fundable-offramp/rates?amount=100&country=NG&currency=NGN
 *
 * Returns the live USDC → local-currency rate for a corridor. `best` is omitted
 * when there is no liquidity, which callers should surface as "temporarily
 * unavailable" rather than a hard error.
 */

import { type NextResponse } from 'next/server';
import {
  badRequest,
  checkRateLimit,
  ok,
  offrampDisabled,
  offrampErrorResponse,
  parsePositiveNumber,
  parseRequiredString,
} from '@/lib/api/fundable-offramp-http';
import {
  createFundableOfframpClient,
  isFundableOfframpEnabled,
} from '@/lib/stellar/fundable-offramp';

export const dynamic = 'force-dynamic';

export async function GET(request: Request): Promise<NextResponse> {
  const limited = await checkRateLimit(request);
  if (limited) return limited;

  if (!isFundableOfframpEnabled()) return offrampDisabled();

  const url = new URL(request.url);
  const amount = parsePositiveNumber(url.searchParams.get('amount'));
  const country = parseRequiredString(url.searchParams.get('country'));
  const currency = parseRequiredString(url.searchParams.get('currency'));

  if (amount === null) return badRequest('amount must be a positive number.');
  if (!country) return badRequest('country is required.');
  if (!currency) return badRequest('currency is required.');

  try {
    const rates = await createFundableOfframpClient().getRates({ amount, country, currency });
    return ok({ rates });
  } catch (error) {
    return offrampErrorResponse(error);
  }
}
