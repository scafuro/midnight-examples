// The CONTRACT-FIXED MPC routing of every vault SignBidirectionalEvent: the
// TS mirror of the vault contract's in-circuit constants, needed to rebuild
// expected event records off-chain. MUST stay in lockstep with
// erc20-vault.compact, whose round-trip simulator tests in the vault
// contract package assert the same values against the real compiled contract.

import {
  asciiPadded,
  MPC_PARAMS_BYTES,
  MPCDestination,
  MPCSignatureAlgorithm,
  pureCircuits,
} from "@sig-net/midnight";
import { pureCircuits as vaultPureCircuits } from "@sig-net/midnight-examples-erc20-vault-contract";

/**
 * What the MPC reports back about an ERC20 `transfer` or `approve`: a single
 * bool, the contract's `vaultResponseSchema()`. Serves as both the
 * output-deserialization and the respond-serialization schema of the events
 * that use it. Stored at its EXACT byte width (schemas are exact-width by
 * protocol convention, never zero-padded: off-chain readers recover the
 * declared width from the stored bytes).
 */
export const ERC20_TRANSFER_RESULT_SCHEMA = '[{"name":"success","type":"bool"}]';

/** The contract-declared byte width of `vaultResponseSchema()` (Compact `Bytes<34>`). */
export const VAULT_RESPONSE_SCHEMA_BYTES = ERC20_TRANSFER_RESULT_SCHEMA.length;

/**
 * The contract-fixed routing fields of a vault event. Field names match
 * `SignBidirectionalEvent`, so an expected event record can spread a value
 * of this type directly.
 */
export interface VaultMpcRouting {
  /** Signature algorithm: an `MPCSignatureAlgorithm` variant index (ecdsa). */
  readonly algo: number;
  /** Execution destination: the MPC's Ethereum routing key (`ethereumCaip2Id()`), zero-padded to 32 bytes. */
  readonly executionDest: Uint8Array;
  /** Signature destination: an `MPCDestination` variant index (unused, reserved). */
  readonly signatureDest: number;
  /** Extra MPC parameters (reserved, zeroed), 64 bytes. */
  readonly params: Uint8Array;
  /** MPC output_deserialization_schema at its contract-declared width. */
  readonly outputDeserializationSchema: Uint8Array;
  /** MPC respond_serialization_schema at its contract-declared width. */
  readonly respondSerializationSchema: Uint8Array;
}

/**
 * The routing the vault contract bakes into every event it records under
 * `vaultResponseSchema()` (deposits, withdrawals, approvals and nonce
 * replacements): ECDSA, an unused signature destination, no extras, the MPC's
 * Ethereum routing key as the execution destination, and the ERC20 bool
 * result schema in both directions.
 */
export const VAULT_RESPONSE_MPC_ROUTING: VaultMpcRouting = {
  algo: MPCSignatureAlgorithm.ecdsa,
  executionDest: pureCircuits.ethereumCaip2Id(),
  signatureDest: MPCDestination.unused,
  params: new Uint8Array(MPC_PARAMS_BYTES),
  outputDeserializationSchema: asciiPadded(
    ERC20_TRANSFER_RESULT_SCHEMA,
    VAULT_RESPONSE_SCHEMA_BYTES,
  ),
  respondSerializationSchema: asciiPadded(
    ERC20_TRANSFER_RESULT_SCHEMA,
    VAULT_RESPONSE_SCHEMA_BYTES,
  ),
};

/**
 * The routing the vault contract bakes into every supply event: the fields of
 * {@link VAULT_RESPONSE_MPC_ROUTING} under the supply's own schemas, read from
 * the compiled `supplyOutputSchema()` (the wrapper's uint256 shares) and
 * `supplyRespondSchema()` (the shares re-packed as a uint64).
 */
export const SUPPLY_MPC_ROUTING: VaultMpcRouting = {
  algo: MPCSignatureAlgorithm.ecdsa,
  executionDest: pureCircuits.ethereumCaip2Id(),
  signatureDest: MPCDestination.unused,
  params: new Uint8Array(MPC_PARAMS_BYTES),
  outputDeserializationSchema: vaultPureCircuits.supplyOutputSchema(),
  respondSerializationSchema: vaultPureCircuits.supplyRespondSchema(),
};
