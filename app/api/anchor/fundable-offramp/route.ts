/**
 * GET /api/anchor/fundable-offramp
 *
 * Capability probe for the offramp integration. Lets the client decide between
 * driving the API flow and falling back to Fundable's hosted workspace, without
 * having to attempt (and fail) a real request first.
 */

import { type NextResponse } from 'next/server';
import { checkRateLimit, ok, offrampDisabled } from '@/lib/api/fundable-offramp-http';
import {
  getHostedOfframpUrl,
  isFundableOfframpEnabled,
  OFFRAMP_POLL_INTERVAL_MS,
} from '@/lib/stellar/fundable-offramp';

export const dynamic = 'force-dynamic';

export async function GET(request: Request): Promise<NextResponse> {
  const limited = await checkRateLimit(request);
  if (limited) return limited;

  if (!isFundableOfframpEnabled()) return offrampDisabled();

  return ok({
    enabled: true,
    /** Where to send users when the API flow is unavailable. */
    hostedOfframpUrl: getHostedOfframpUrl(),
    /** Offramp on Stellar settles USDC only. */
    token: 'USDC',
    network: 'stellar',
    /** Circle CCTP is the only supported bridge for Stellar withdrawals. */
    bridgeProvider: 'circle_cctp',
    pollIntervalMs: OFFRAMP_POLL_INTERVAL_MS,
  });
}
