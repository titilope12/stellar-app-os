/**
 * GET /api/anchor/fundable-offramp/orders/:id
 *
 * Polls the status of an offramp order. Poll no faster than the interval
 * advertised by `GET /api/anchor/fundable-offramp`.
 */

import { type NextResponse } from 'next/server';
import {
  badRequest,
  checkRateLimit,
  ok,
  offrampDisabled,
  offrampErrorResponse,
  resolveWalletId,
} from '@/lib/api/fundable-offramp-http';
import {
  createFundableOfframpClient,
  isFundableOfframpEnabled,
} from '@/lib/stellar/fundable-offramp';

export const dynamic = 'force-dynamic';

export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
): Promise<NextResponse> {
  const limited = await checkRateLimit(request);
  if (limited) return limited;

  if (!isFundableOfframpEnabled()) return offrampDisabled();

  const { id } = await params;
  if (!id?.trim()) return badRequest('orderId is required.');

  const identity = resolveWalletId(request, new URL(request.url).searchParams.get('walletId'));
  if ('error' in identity) return identity.error;

  try {
    const status = await createFundableOfframpClient().getStatus(id.trim(), identity.walletId);
    return ok({ status });
  } catch (error) {
    return offrampErrorResponse(error);
  }
}
