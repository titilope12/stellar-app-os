/**
 * POST /api/anchor/fundable-offramp/orders
 *
 * Turns a quote into a withdrawal order. The response contains the unsigned
 * Circle CCTP approval transaction (`unsignedApprovalXdr`) plus the `reference`
 * used as the order id. Both XDRs must be signed by the user's wallet — this
 * route never signs anything.
 *
 * Body: { quoteId, walletId? }
 */

import { type NextResponse } from 'next/server';
import {
  badRequest,
  checkRateLimit,
  invalidJson,
  ok,
  offrampDisabled,
  offrampErrorResponse,
  parseRequiredString,
  readJsonBody,
  resolveWalletId,
} from '@/lib/api/fundable-offramp-http';
import {
  createFundableOfframpClient,
  isFundableOfframpEnabled,
} from '@/lib/stellar/fundable-offramp';

export const dynamic = 'force-dynamic';

interface CreateOrderBody {
  quoteId?: string;
  walletId?: string;
}

export async function POST(request: Request): Promise<NextResponse> {
  const limited = await checkRateLimit(request);
  if (limited) return limited;

  if (!isFundableOfframpEnabled()) return offrampDisabled();

  const body = await readJsonBody<CreateOrderBody>(request);
  if (!body) return invalidJson();

  const quoteId = parseRequiredString(body.quoteId);
  if (!quoteId) return badRequest('quoteId is required.');

  const identity = resolveWalletId(request, body.walletId);
  if ('error' in identity) return identity.error;

  try {
    const order = await createFundableOfframpClient().createFromQuote(quoteId, identity.walletId);
    const orderId = order.orderId ?? order.reference;

    return ok({ order, orderId }, 201);
  } catch (error) {
    return offrampErrorResponse(error);
  }
}
