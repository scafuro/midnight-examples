import {
  CallTxFailedError,
  createCallTxOptions,
  createUnprovenCallTx,
  submitTx,
} from "@midnight-ntwrk/midnight-js/contracts";
import { getNetworkId } from "@midnight-ntwrk/midnight-js/network-id";
import {
  encodeContractKeyLocation,
  FailFallible,
  hashVerifierKey,
  SucceedEntirely,
} from "@midnight-ntwrk/midnight-js/types";
import {
  communicationCommitmentRandomness,
  ContractCallPrototype,
  ContractState,
  Intent,
  Transaction,
} from "@midnight-ntwrk/midnight-js-protocol/ledger";

import {
  VAULT_PRIVATE_STATE_ID,
  type VaultCompiledContract,
  type VaultProviders,
} from "./contract-surface.ts";
import {
  FlushChannel,
  type FlushSlot,
  pureCircuits,
} from "./managed/erc20-vault/contract/index.js";
import { readVaultLedger, type VaultLedgerState } from "./vault-ledger.ts";

/** Slots one `flushQueue` call carries. */
export const FLUSH_WIDTH = 10;

/**
 * The slot vector `flushQueue` takes: attestation slots first, so the request slots
 * behind them record those heights as their `lastSeen`, then empty slots to the width.
 *
 * @param inIndexes - The input buffer indexes of the requests to flush.
 * @param digests - The digests of the attestations to flush.
 * @returns The padded slot vector.
 * @throws {Error} When more items than the flush width are given.
 */
export function flushSlots(
  inIndexes: readonly bigint[],
  digests: readonly Uint8Array[],
): FlushSlot[] {
  if (inIndexes.length + digests.length > FLUSH_WIDTH) {
    throw new Error(
      `a flush takes at most ${String(FLUSH_WIDTH)} items; got ${String(inIndexes.length + digests.length)}`,
    );
  }
  const empty = new Uint8Array(32);
  return [
    ...digests.map((digest) => ({ channel: FlushChannel.attestation, inIndex: 0n, digest })),
    ...inIndexes.map((inIndex) => ({ channel: FlushChannel.request, inIndex, digest: empty })),
    ...Array.from({ length: FLUSH_WIDTH - inIndexes.length - digests.length }, () => ({
      channel: FlushChannel.empty,
      inIndex: 0n,
      digest: empty,
    })),
  ];
}

/**
 * A fresh input buffer index for a start circuit: 64 random bits.
 *
 * @returns The index to queue the request under.
 */
export function newInputIndex(): bigint {
  const bytes = crypto.getRandomValues(new Uint8Array(8));
  return new DataView(bytes.buffer).getBigUint64(0);
}

/**
 * The output buffer key a queued request moves to when flushed, computed by the
 * compiled `requestKey` circuit from the entry the start circuit wrote.
 *
 * @param state - The vault ledger state.
 * @param inIndex - The request's input buffer index.
 * @returns The request key.
 * @throws {Error} When no request is queued under the index.
 */
export function queuedRequestKey(state: VaultLedgerState, inIndex: bigint): Uint8Array {
  if (!state.inputRequestBuffer.member(inIndex)) {
    throw new Error(`no request is queued under input index ${String(inIndex)}`);
  }
  return pureCircuits.requestKey(state.inputRequestBuffer.lookup(inIndex));
}

/**
 * The digests under which an attestation buffer holds records for a request.
 *
 * @param buffer - `inputAttestationBuffer` or `outputAttestationBuffer`.
 * @param requestId - The request the attestations name.
 * @returns The matching digests, in ledger order.
 */
export function attestationDigestsFor(
  buffer: VaultLedgerState["inputAttestationBuffer"],
  requestId: Uint8Array,
): Uint8Array[] {
  const digests: Uint8Array[] = [];
  for (const [digest, record] of buffer) {
    if (
      record.requestId.length === requestId.length &&
      record.requestId.every((byte, i) => byte === requestId[i])
    ) {
      digests.push(digest);
    }
  }
  return digests;
}

const FLUSH_TTL_MS = 5 * 60_000;

// midnight-js sections a call's transcript before the wallet adds its fee payment, so
// a flush carrying one item stays in the guaranteed section and the payment then
// pushes it past the node's time-to-dismiss cap (error 231). With the whole
// transcript fallible, only the proof check and the payment count toward that cap.
async function submitFlush(
  providers: VaultProviders,
  compiledContract: VaultCompiledContract,
  vaultContractAddress: string,
  slots: FlushSlot[],
): Promise<void> {
  const call = await createUnprovenCallTx(providers, {
    ...createCallTxOptions(
      compiledContract,
      "flushQueue",
      vaultContractAddress,
      VAULT_PRIVATE_STATE_ID,
      undefined,
      [slots],
    ),
    privateStateId: VAULT_PRIVATE_STATE_ID,
  });
  const [guaranteed, fallible] = call.public.partitionedTranscript;
  const raw = await providers.publicDataProvider.queryContractState(vaultContractAddress);
  // The indexer's state is the runtime's ContractState class, and ContractCallPrototype
  // accepts only the ledger's own ContractOperation: round-trip through bytes.
  const state = raw && ContractState.deserialize(raw.serialize());
  const operation = state?.operation("flushQueue");
  if (!operation?.verifierKey) {
    throw new Error(`flushQueue has no verifier key on chain at ${vaultContractAddress}`);
  }
  const prototype = new ContractCallPrototype(
    vaultContractAddress,
    "flushQueue",
    operation,
    undefined,
    guaranteed ?? fallible,
    call.private.privateTranscriptOutputs,
    call.private.input,
    call.private.output,
    communicationCommitmentRandomness(),
    encodeContractKeyLocation({
      contractAddress: vaultContractAddress,
      circuitId: "flushQueue",
      verifierKeyHash: hashVerifierKey(operation.verifierKey),
    }),
  );
  const intent = Intent.new(new Date(Date.now() + FLUSH_TTL_MS)).addCall(prototype);
  const unprovenTx = Transaction.fromPartsRandomized(getNetworkId(), undefined, undefined, intent);
  const finalized = await submitTx(providers, { unprovenTx, circuitId: "flushQueue" });
  if (finalized.status !== SucceedEntirely) {
    throw new CallTxFailedError(finalized, "flushQueue");
  }
}

/**
 * Flushes up to FLUSH_WIDTH waiting items, whoever queued them: queued attestations
 * first, then queued requests, in ledger order. The flush's ledger work runs in the
 * transaction's fallible section, so a flush that loses a race to another flush lands
 * as a {@link CallTxFailedError} with status `FailFallible` and still pays its fee.
 *
 * @param providers - The vault's provider set, whose wallet pays for the flush.
 * @param compiledContract - The vault's compiled contract.
 * @param vaultContractAddress - The vault's contract address.
 * @returns How many slots the flush filled.
 * @throws {CallTxFailedError} When the flush lands but does not succeed entirely.
 */
export async function flushPending(
  providers: VaultProviders,
  compiledContract: VaultCompiledContract,
  vaultContractAddress: string,
): Promise<number> {
  const state = await readVaultLedger(providers.publicDataProvider, vaultContractAddress);
  const digests = [...state.inputAttestationBuffer].map(([digest]) => digest).slice(0, FLUSH_WIDTH);
  const inIndexes = [...state.inputRequestBuffer]
    .map(([inIndex]) => inIndex)
    .slice(0, FLUSH_WIDTH - digests.length);
  await submitFlush(
    providers,
    compiledContract,
    vaultContractAddress,
    flushSlots(inIndexes, digests),
  );
  return digests.length + inIndexes.length;
}

/**
 * Flushes until `flushed` holds for the ledger. A flush that loses its block to another
 * flush is retried.
 *
 * @param providers - The vault's provider set, whose wallet pays for the flushes.
 * @param compiledContract - The vault's compiled contract.
 * @param vaultContractAddress - The vault's contract address.
 * @param flushed - Whether the ledger shows what the caller waits for.
 * @param attempts - How many flushes to try.
 * @returns The ledger state that satisfied `flushed`.
 * @throws {Error} On a non-conflict failure, or when `flushed` still fails after the attempts.
 */
export async function flushUntil(
  providers: VaultProviders,
  compiledContract: VaultCompiledContract,
  vaultContractAddress: string,
  flushed: (state: VaultLedgerState) => boolean,
  attempts = 5,
): Promise<VaultLedgerState> {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const state = await readVaultLedger(providers.publicDataProvider, vaultContractAddress);
    if (flushed(state)) return state;
    try {
      await flushPending(providers, compiledContract, vaultContractAddress);
    } catch (error) {
      const staleRead: boolean =
        error instanceof Error && error.message.includes("mismatch between expected read");
      const failedFallible: boolean =
        error instanceof CallTxFailedError && error.finalizedTxData.status === FailFallible;
      if (!staleRead && !failedFallible) throw error;
      console.log(
        `flush attempt ${String(attempt + 1)} lost: ${String(error).split("\n")[0] ?? ""}`,
      );
    }
  }
  const state = await readVaultLedger(providers.publicDataProvider, vaultContractAddress);
  if (flushed(state)) return state;
  throw new Error(`still not flushed after ${String(attempts)} flush attempts`);
}
