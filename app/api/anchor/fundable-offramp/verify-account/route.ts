/**
 * POST /api/anchor/fundable-offramp/verify-account
 *
 * Resolves the beneficiary name for a destination bank account. Must be called
 * before `quotes`, because Fundable requires the verified `accountName` on the
 * quote payload.
 *
 * Body: { bankCode, accountNumber, country, currency, providerId?, walletId? }
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

interface VerifyAccountBody {
  bankCode?: string;
  accountNumber?: string;
  country?: string;
  currency?: string;
  providerId?: string;
  walletId?: string;
}

export async function POST(request: Request): Promise<NextResponse> {
  const limited = await checkRateLimit(request);
  if (limited) return limited;

  if (!isFundableOfframpEnabled()) return offrampDisabled();

  const body = await readJsonBody<VerifyAccountBody>(request);
  if (!body) return invalidJson();

  const bankCode = parseRequiredString(body.bankCode);
  const accountNumber = parseRequiredString(body.accountNumber);
  const country = parseRequiredString(body.country);
  const currency = parseRequiredString(body.currency);
  const providerId = parseRequiredString(body.providerId);

  if (!bankCode) return badRequest('bankCode is required.');
  if (!accountNumber) return badRequest('accountNumber is required.');
  if (!country) return badRequest('country is required.');
  if (!currency) return badRequest('currency is required.');

  const identity = resolveWalletId(request, body.walletId);
  if ('error' in identity) return identity.error;

  try {
    const account = await createFundableOfframpClient().verifyAccount(
      {
        bankCode,
        accountNumber,
        country,
        currency,
        ...(providerId ? { providerId } : {}),
      },
      identity.walletId
    );
    return ok({ account });
  } catch (error) {
    return offrampErrorResponse(error);
  }
}
