// `startReplaceNonce` then `sendReplaceNonce`: as the deployer, queue a replacement of
// the vault account's transaction at a named nonce, flush it, and record its
// SignBidirectionalEvent in the vault's bidirectionalReplaceNonceMap. It asks the MPC
// to sign a zero-value self-transfer to the vault's own EVM address, with no
// calldata, sent from the VAULT's derived address (path "vault") at that nonce. The
// request id is recomputed off-chain with the library's TS twin of the request-id
// circuit and asserted against the ledger map key before it is returned. The settle
// side lives in complete-replace-nonce.ts.
import {
  calculateRequestId,
  hexToBytes,
  type RequestIdHex,
  requestIdHex,
  type SignBidirectionalEvent,
  SIGNET_DEFAULT_KEY_VERSION,
  stripHexPrefix,
  toSignBidirectionalEventIndex,
  TxParamType,
} from "@sig-net/midnight";
import {
  newInputIndex,
  queuedRequestKey,
  readVaultLedger,
  VAULT_PATH_BYTES,
} from "@sig-net/midnight-examples-erc20-vault-contract";

import { logEvmFeeCap } from "../evm-logging.ts";
import { VAULT_RESPONSE_MPC_ROUTING } from "../mpc-routing.ts";
import type { VaultContext } from "../vault-context.ts";
import { flushUntil } from "./vault-queue.ts";

/** Options for {@link startReplaceNonce}. */
export interface StartReplaceNonceOptions {
  /** The vault account nonce whose transaction the replacement takes. */
  readonly evmNonce: bigint;
}

/**
 * Queue a nonce replacement with `startReplaceNonce` under a fresh input index,
 * flush it into the output buffer, send it with `sendReplaceNonce`, and return the
 * resulting request id.
 *
 * The contract's warning on `startReplaceNonce` applies in full: the replacement
 * takes the nonce of whichever request the flush assigned it, and that request's
 * own transaction can then never execute. Call this only for a transaction that can
 * never be mined and is in flight nowhere. The circuit is deployer-gated, so the
 * context's identity must be the deployer's. The caller names only the nonce: the
 * contract fixes the transfer and copies the vault's fee settings at start under a
 * 21000 gas limit. The expected record is reconstructed off-chain from the flushed
 * entry and its stored arguments, its id computed with the library's
 * `calculateRequestId` TS twin, and asserted present as a ledger map key after the
 * send.
 *
 * @param context - The flow context, holding the deployer's identity.
 * @param options - The nonce to replace.
 * @returns The request id as 64-char lowercase hex.
 * @throws {Error} If the nonce is negative, the vault is uninitialised, the
 *   context's identity is not the deployer's, or the recomputed id does not appear
 *   on the ledger.
 */
export async function startReplaceNonce(
  context: VaultContext,
  options: StartReplaceNonceOptions,
): Promise<RequestIdHex> {
  if (options.evmNonce < 0n) {
    throw new Error(`evmNonce must be non-negative; got ${String(options.evmNonce)}.`);
  }
  console.log(`vault contract: ${context.vaultContractAddress}`);
  console.log(`vault account:  ${context.evmVaultAddress}`);
  console.log(`replaced nonce: ${String(options.evmNonce)}`);

  const before = await readVaultLedger(
    context.providers.publicDataProvider,
    context.vaultContractAddress,
  );
  if (!before.initialised) {
    throw new Error("vault is not initialised, run the initialise flow first");
  }

  const inIndex = newInputIndex();
  const queued = await context.vault.callTx.startReplaceNonce(inIndex, options.evmNonce);
  console.log(`replacement queued in tx ${queued.public.txId}`);
  const outKey = queuedRequestKey(
    await readVaultLedger(context.providers.publicDataProvider, context.vaultContractAddress),
    inIndex,
  );
  // Only the flush removes an entry from the input buffer. An identical open request
  // holds outKey already, so outputRequestBuffer membership would not show this one moved.
  const flushed = await flushUntil(context, (state) => !state.inputRequestBuffer.member(inIndex), {
    inIndexes: [inIndex],
    requestIds: [],
  });
  const { gas } = flushed.replaceNonceArgsMap.lookup(inIndex);

  // The record the contract will store, reconstructed byte for byte: the event's own
  // sender (the vault contract, kernel.self() in-circuit), the pinned chain, the
  // named nonce, the gas the start copied, a zero-value transfer to the vault's own
  // EVM address with no calldata, the vault's own 32-byte derivation path, and the
  // contract-fixed routing.
  const keyVersion = SIGNET_DEFAULT_KEY_VERSION;
  const expectedRecord: SignBidirectionalEvent = {
    sender: { bytes: hexToBytes(stripHexPrefix(context.vaultContractAddress)) },
    keyVersion,
    path: VAULT_PATH_BYTES,
    ...VAULT_RESPONSE_MPC_ROUTING,
    txParamType: TxParamType.evmType2,
    txParams: {
      to: before.vaultEvmAddress,
      chainId: before.evmChainId,
      nonce: options.evmNonce,
      gasLimit: gas.gasLimit,
      maxFeePerGas: gas.maxFeePerGas,
      maxPriorityFeePerGas: gas.maxPriorityFeePerGas,
      value: 0n,
      accessListEntryCount: 0n,
      accessList: [],
      calldata: {
        is_some: false,
        value: { selector: new Uint8Array(4), noWords: 0n, words: [] },
      },
    },
  };
  const expectedIdHex = requestIdHex(calculateRequestId(expectedRecord));
  logEvmFeeCap(
    expectedIdHex,
    context.evmVaultAddress,
    expectedRecord.txParams.gasLimit,
    expectedRecord.txParams.maxFeePerGas,
    expectedRecord.txParams.maxPriorityFeePerGas,
  );

  const result = await context.vault.callTx.sendReplaceNonce(outKey);
  console.log(`replacement sent in tx ${result.public.txId}`);

  // The bidirectionalReplaceNonceMap key IS the record's transientHash digest:
  // recomputing it off-chain and finding it on the ledger proves both sides agree on
  // every byte of the event.
  const after = await readVaultLedger(
    context.providers.publicDataProvider,
    context.vaultContractAddress,
  );
  const index = toSignBidirectionalEventIndex(after.bidirectionalReplaceNonceMap);
  if (!index.has(expectedIdHex)) {
    throw new Error(
      `recomputed request id ${expectedIdHex} not found in the vault's nonce replacement map ` +
        `(present ids: [${[...index.keys()].join(", ")}])`,
    );
  }
  console.log(`request id:     ${expectedIdHex}`);
  return expectedIdHex;
}
