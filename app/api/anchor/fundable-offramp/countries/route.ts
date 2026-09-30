/**
 * GET /api/anchor/fundable-offramp/countries
 *
 * Lists the corridors Fundable can offramp to (NGN, KES, GHS, ZAR, …). Each entry
 * carries the country code and payout currency required by the downstream
 * `banks`, `rates` and `quote` calls.
 */

import { type NextResponse } from 'next/server';
import {
  checkRateLimit,
  ok,
  offrampDisabled,
  offrampErrorResponse,
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

  try {
    const countries = await createFundableOfframpClient().listCountries();
    return ok({ countries });
  } catch (error) {
    return offrampErrorResponse(error);
  }
}
