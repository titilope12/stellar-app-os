/**
 * GET /api/anchor/fundable-offramp/banks?country=NG&currency=NGN[&providerId=…]
 *
 * Lists the destination banks for a corridor. The returned `code` is the value
 * to pass back as `bankCode` on `verify-account` and `quote`.
 */

import { type NextResponse } from 'next/server';
import {
  badRequest,
  checkRateLimit,
  ok,
  offrampDisabled,
  offrampErrorResponse,
  parseRequiredString,
} from '@/lib/api/fundable-offramp-http';
import {
  createFundableOfframpClient,
  isFundableOfframpEnabled,
  isStellarPublicKey,
} from '@/lib/stellar/fundable-offramp';

export const dynamic = 'force-dynamic';

export async function GET(request: Request): Promise<NextResponse> {
  const limited = await checkRateLimit(request);
  if (limited) return limited;

  if (!isFundableOfframpEnabled()) return offrampDisabled();

  const url = new URL(request.url);
  const country = parseRequiredString(url.searchParams.get('country'));
  const currency = parseRequiredString(url.searchParams.get('currency'));
  const providerId = parseRequiredString(url.searchParams.get('providerId'));

  if (!country) return badRequest('country is required.');
  if (!currency) return badRequest('currency is required.');

  // Optional here: bank lookup works anonymously, but a malformed id is rejected
  // rather than silently dropped.
  const headerWalletId = request.headers.get('x-wallet-id')?.trim() || undefined;
  if (headerWalletId && !isStellarPublicKey(headerWalletId)) {
    return badRequest('x-wallet-id must be a valid Stellar public key.', 'invalid_wallet_id');
  }

  try {
    const banks = await createFundableOfframpClient().listBanks({
      country,
      currency,
      ...(providerId ? { providerId } : {}),
      ...(headerWalletId ? { walletId: headerWalletId } : {}),
    });
    return ok({ banks });
  } catch (error) {
    return offrampErrorResponse(error);
  }
}
