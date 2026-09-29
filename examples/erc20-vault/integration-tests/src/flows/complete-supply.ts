// Settle side of the supply flow: queue the MPC's attestation of the vault's
// stataToken deposit, flush it, then settle through `completeSupply` with the
// request id, the output bytes the attestation signs, and a fresh RANDOM mint nonce
// so the minted coin cannot be linked back to the request.
import {
  bytesToBigint,
  bytesToHex,
  OutputKind,
  type RequestIdHex,
  requestIdHex,
  serializeRespondOutput,
} from "@sig-net/midnight";
import {
  pureCircuits,
  VAULT_SUPPLY_REQUESTS_PATH,
} from "@sig-net/midnight-examples-erc20-vault-contract";

import { POLL_TIMEOUT_MS } from "../poll-timeout.ts";
import type { VaultContext } from "../vault-context.ts";
import { pollRespondBidirectional } from "./poll-respond-bidirectional.ts";
import { queueAndFlushAttestation } from "./queue-attestation.ts";
import type { RespondOutcome } from "./respond-output.ts";

/**
 * The stataToken shares an executed supply's attestation carries, which
 * `completeSupply` mints. The output packs them as a little-endian uint64 under
 * the compiled `supplyRespondSchema()`, and the decoded value is re-packed with
 * that schema to prove it reproduces the attested bytes.
 *
 * @param outcome - The attested outcome from {@link pollRespondBidirectional}.
 * @returns The attested share count.
 * @throws {Error} If the outcome is not an execution, or its output is not the
 *   packing of a share count under the supply's respond schema.
 */
export function attestedSupplyShares(outcome: RespondOutcome): bigint {
  const requestId = requestIdHex(outcome.event.requestId);
  if (outcome.event.outputKind !== OutputKind.executed) {
    throw new Error(
      `supply ${requestId} was attested ${OutputKind[outcome.event.outputKind]}: it carries no shares`,
    );
  }
  const shares = bytesToBigint(outcome.serializedOutput);
  const repacked = serializeRespondOutput(pureCircuits.supplyRespondSchema(), { shares });
  if (bytesToHex(repacked) !== bytesToHex(outcome.serializedOutput)) {
    throw new Error(
      `supply ${requestId} attests output 0x${bytesToHex(outcome.serializedOutput)}, ` +
        `which is not a share count packed by supplyRespondSchema()`,
    );
  }
  return shares;
}

/**
 * Settle a resolved supply outcome: {@link queueAndFlushAttestation}, then call
 * `completeSupply` with the request id, the output bytes (eight zero bytes for
 * a failed or unviable deposit, whose output the circuit ignores) and a random
 * mint nonce. An executed deposit mints the attested shares as the stataToken
 * vault coin. A failed or unviable one re-mints the surrendered stataUnderlying
 * amount. Either mint goes to this wallet, which must be the supplier's. The
 * mint's coin handling is midnight-js's job: the callTx balances the resulting
 * offer like any other call.
 *
 * @param context - The flow context.
 * @param outcome - The attested outcome from {@link pollRespondBidirectional}.
 */
export async function settleSupply(context: VaultContext, outcome: RespondOutcome): Promise<void> {
  const executed = outcome.event.outputKind === OutputKind.executed;
  console.log(`vault contract:  ${context.vaultContractAddress}`);
  console.log(`request id:      ${requestIdHex(outcome.event.requestId)}`);
  console.log(
    executed
      ? `EVM deposit executed: completeSupply mints ${String(attestedSupplyShares(outcome))} stataToken shares to this wallet (the supplier)`
      : `the MPC attested the deposit as ${OutputKind[outcome.event.outputKind]}: ` +
          `completeSupply re-mints the surrendered underlying to this wallet (the supplier)`,
  );

  await queueAndFlushAttestation(context, outcome);
  const serializedOutput = executed ? outcome.serializedOutput : new Uint8Array(8);

  // A fresh random mint nonce per settle: the circuit threads it into the mint
  // verbatim, so randomness HERE is what keeps the minted coin unlinkable to the
  // (public) request id.
  const mintNonce = crypto.getRandomValues(new Uint8Array(32));

  const result = await context.vault.callTx.completeSupply(
    outcome.event.requestId,
    serializedOutput,
    mintNonce,
  );
  console.log(`completeSupply settled in tx ${result.public.txId}`);
}

/** Options for {@link completeSupply}. */
export interface CompleteSupplyOptions {
  /** The supply request id to settle. */
  readonly requestId: RequestIdHex;
}

/**
 * Poll until the supply's attestation resolves, then settle:
 * {@link pollRespondBidirectional} over the supply request map followed by
 * {@link settleSupply}.
 *
 * @param context - The flow context.
 * @param options - The request id to settle.
 * @throws {Error} If no verifying attestation posts within the poll's
 *   deadline.
 */
export async function completeSupply(
  context: VaultContext,
  options: CompleteSupplyOptions,
): Promise<void> {
  const outcome = await pollRespondBidirectional(context, {
    requestId: options.requestId,
    intervalMs: 1000,
    timeoutMs: POLL_TIMEOUT_MS,
    requestsPath: VAULT_SUPPLY_REQUESTS_PATH,
  });
  await settleSupply(context, outcome);
}
