/**
 * POST /api/anchor/fundable-offramp/quotes
 *
 * Locks in a USDC → local-currency quote. The returned `quoteId` is passed to
 * `POST /orders` to create the withdrawal.
 *
 * Body: { amount, country, currency, bankCode, accountNumber, accountName,
 *         providerId?, email?, walletId? }
 */

import { type NextResponse } from 'next/server';
import {
  badRequest,
  checkRateLimit,
  invalidJson,
  ok,
  offrampDisabled,
  offrampErrorResponse,
  parsePositiveNumber,
  parseRequiredString,
  readJsonBody,
  resolveWalletId,
} from '@/lib/api/fundable-offramp-http';
import {
  createFundableOfframpClient,
  isFundableOfframpEnabled,
} from '@/lib/stellar/fundable-offramp';

export const dynamic = 'force-dynamic';

interface CreateQuoteBody {
  amount?: number | string;
  country?: string;
  currency?: string;
  bankCode?: string;
  accountNumber?: string;
  accountName?: string;
  providerId?: string;
  email?: string;
  walletId?: string;
}

export async function POST(request: Request): Promise<NextResponse> {
  const limited = await checkRateLimit(request);
  if (limited) return limited;

  if (!isFundableOfframpEnabled()) return offrampDisabled();

  const body = await readJsonBody<CreateQuoteBody>(request);
  if (!body) return invalidJson();

  const amount = parsePositiveNumber(
    typeof body.amount === 'number' ? String(body.amount) : (body.amount ?? null)
  );
  const country = parseRequiredString(body.country);
  const currency = parseRequiredString(body.currency);
  const bankCode = parseRequiredString(body.bankCode);
  const accountNumber = parseRequiredString(body.accountNumber);
  const accountName = parseRequiredString(body.accountName);
  const providerId = parseRequiredString(body.providerId);
  const email = parseRequiredString(body.email);

  if (amount === null) return badRequest('amount must be a positive number.');
  if (!country) return badRequest('country is required.');
  if (!currency) return badRequest('currency is required.');
  if (!bankCode) return badRequest('bankCode is required.');
  if (!accountNumber) return badRequest('accountNumber is required.');
  // Required by the provider; normally comes from /verify-account.
  if (!accountName) return badRequest('accountName is required.');

  const identity = resolveWalletId(request, body.walletId);
  if ('error' in identity) return identity.error;

  try {
    const quote = await createFundableOfframpClient().createQuote(
      {
        amount,
        country,
        currency,
        bankCode,
        accountNumber,
        accountName,
        ...(providerId ? { providerId } : {}),
        ...(email ? { email } : {}),
      },
      identity.walletId
    );
    return ok({ quote }, 201);
  } catch (error) {
    return offrampErrorResponse(error);
  }
}
