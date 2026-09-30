/**
 * POST /api/anchor/fundable-offramp/orders/:id/cctp
 *
 * Exposes the three Circle CCTP steps of a Stellar offramp. The signing split is
 * deliberate: `burn-xdr` only *fetches* an unsigned transaction, while
 * `submit-approval` / `submit-burn` accept an XDR the user's wallet already
 * signed in the browser. No key material reaches this route.
 *
 * Body: { action: 'burn-xdr' | 'submit-approval' | 'submit-burn', signedXdr?, walletId? }
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

const CCTP_ACTIONS = ['burn-xdr', 'submit-approval', 'submit-burn'] as const;
type CctpAction = (typeof CCTP_ACTIONS)[number];

interface CctpBody {
  action?: string;
  signedXdr?: string;
  walletId?: string;
}

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
): Promise<NextResponse> {
  const limited = await checkRateLimit(request);
  if (limited) return limited;

  if (!isFundableOfframpEnabled()) return offrampDisabled();

  const { id } = await params;
  if (!id?.trim()) return badRequest('orderId is required.');
  const orderId = id.trim();

  const body = await readJsonBody<CctpBody>(request);
  if (!body) return invalidJson();

  const action = parseRequiredString(body.action);
  if (!action || !CCTP_ACTIONS.includes(action as CctpAction)) {
    return badRequest(`action must be one of: ${CCTP_ACTIONS.join(', ')}.`);
  }

  // The signed XDRs are the whole point of the submit steps; require them.
  const signedXdr = parseRequiredString(body.signedXdr);
  if (action !== 'burn-xdr' && !signedXdr) {
    return badRequest(`signedXdr is required for action '${action}'.`);
  }

  const identity = resolveWalletId(request, body.walletId);
  if ('error' in identity) return identity.error;

  const client = createFundableOfframpClient();

  try {
    if (action === 'burn-xdr') {
      const prepared = await client.getCctpBurnXdr(orderId, identity.walletId);
      return ok({ action, orderId, ...prepared });
    }

    if (action === 'submit-approval') {
      const result = await client.submitCctpApproval(
        orderId,
        signedXdr as string,
        identity.walletId
      );
      return ok({ action, orderId, result });
    }

    const result = await client.submitCctpBurn(orderId, signedXdr as string, identity.walletId);
    return ok({ action, orderId, result });
  } catch (error) {
    return offrampErrorResponse(error);
  }
}
