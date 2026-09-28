// The happy-day e2e flow: initialisation → deposit round trip, against
// contracts the globalSetup pipeline (src/setup.ts) has already
// compiled/deployed/derived — vitest.config.ts holds the
// orchestration contract (setup runs first, flow files run one at a time in
// a pinned order). Tests in THIS file run in source order and feed each
// other through module-scoped state, so the file is one ordered pipeline on
// purpose. Run with `yarn test:erc20-vault:e2e` from the repo root (--bail 1
// stops the pipeline at the first failure); without RUN_INTEGRATION_TESTS
// the whole suite skips so plain `yarn test` stays offline. Set
// STEP_THROUGH=1 to pause before each step (after the first) until you hit
// Enter in the terminal.
//
// Tests drive the vault THROUGH the example's typed flow functions
// (src/flows/) — in-process, never a subprocess.
import {
  abiWordToUint128,
  bytesToHex,
  OutputKind,
  parseSecp256k1PublicKey,
  requestIdBytes,
  type RequestIdHex,
  requestIdHex,
  stripHexPrefix,
  verifyRespondBidirectionalSignature,
} from "@sig-net/midnight";
import { calculateSignetAttestationDigest } from "@sig-net/midnight/testing";
import {
  printVaultState,
  readVaultLedger,
  VAULT_DEPOSIT_REQUESTS_PATH,
} from "@sig-net/midnight-examples-erc20-vault-contract";
import {
  InitialiseVaultOutcome,
  resolveInitialiseConfig,
} from "@sig-net/midnight-examples-erc20-vault-deploy";
import {
  banner,
  getErc20Balance,
  getEthBalance,
  getTransactionNonce,
  logSkip,
  pollSignetNotification,
  requireEnv as requireEnvOf,
} from "@sig-net/midnight-examples-test-harness";
import { injectE2eEnv, installFlowHooks } from "@sig-net/midnight-examples-test-harness/flow-hooks";
import { JsonRpcProvider, parseEther, parseUnits, type Transaction } from "ethers";
import { afterAll, describe, expect, it } from "vitest";

import { fundingSummary } from "../src/evm-logging.ts";
import { broadcastEvm } from "../src/flows/broadcast-evm.ts";
import { settleDeposit } from "../src/flows/complete-deposit.ts";
import { initialise } from "../src/flows/initialise.ts";
import {
  pollRespondBidirectional,
  type RespondOutcome,
} from "../src/flows/poll-respond-bidirectional.ts";
import { pollSignatureResponse } from "../src/flows/poll-signature-response.ts";
import { startDeposit } from "../src/flows/start-deposit.ts";
import { POLL_TIMEOUT_MS } from "../src/poll-timeout.ts";
import { createVaultSession } from "../src/vault-session.ts";

const MINUTE = 60_000;

/**
 * The setup-populated env accumulator: repo-root `.env` overlaid with the
 * real environment (which wins), plus every value the globalSetup pipeline
 * derived or deployed. Empty when RUN_INTEGRATION_TESTS is unset — the suite
 * below skips before reading it.
 */
const env = injectE2eEnv();

/** Assert a setup step populated `name`, failing with a pointed message. */
const requireEnv = (name: string): string => requireEnvOf(env, name);

// An index read into decoded calldata cannot narrow, so name the word the
// assertion needs and fail loudly when the contract stored a shorter one.
const calldataWordAt = (words: readonly Uint8Array[], index: number): Uint8Array => {
  const word = words.at(index);
  if (word === undefined) {
    throw new Error(`decoded calldata has no ABI word at index ${String(index)}`);
  }
  return word;
};

// Wallet facade + vault context + MPC-style reader shared by every test in
// this file (lazily built, so the offline path never touches the network);
// stopped once in afterAll.
const session = createVaultSession(env);

describe.skipIf(!process.env.RUN_INTEGRATION_TESTS)("erc20-vault happy-day e2e", () => {
  installFlowHooks();

  afterAll(async () => {
    await session.stop();
  });

  it(
    "initialise [erc-vault contract method call]: seal vault EVM address + MPC response key and read back state",
    async () => {
      const context = await session.vaultContext();
      const readLedger = () =>
        readVaultLedger(context.providers.publicDataProvider, context.vaultContractAddress);

      // The same arguments the stagenet deploy+initialise entrypoint resolves, from the
      // same env. A rerun against a kept, initialised contract is a no-op inside initialise.
      const config = await resolveInitialiseConfig(env, context.vaultContractAddress);
      const outcome = await initialise(context, config);
      if (outcome === InitialiseVaultOutcome.AlreadyInitialised) {
        logSkip("initialise", "vault is already initialised (rerun against a kept contract)");
      }

      await printVaultState(context.providers.publicDataProvider, context.vaultContractAddress);

      const state = await readLedger();
      expect(state.initialised).toBe(true);
      expect(`0x${bytesToHex(state.vaultEvmAddress)}`.toLowerCase()).toBe(
        config.vaultEvmAddress.toLowerCase(),
      );
      expect(state.evmChainId).toBe(BigInt(requireEnv("EVM_CHAIN_ID")));
      // The stored MPC response key, verbatim: the sender-scoped key claim and
      // completeWithdraw verify responses against.
      expect(state.mpcResponseKey).toEqual(parseSecp256k1PublicKey(config.mpcResponseKey));
    },
    15 * MINUTE,
  );

  it(
    "deposit funding preflight: check user EVM account for minimum ETH and USDC balances.",
    async () => {
      const rpcUrl = requireEnv("EVM_RPC_URL");
      const userAddress = requireEnv("EVM_USER_ADDRESS");
      const erc20Address = requireEnv("ERC20_ADDRESS");

      const ethBalance = await getEthBalance(rpcUrl, userAddress);
      console.log(
        `${userAddress}: ${fundingSummary(ethBalance, parseEther("0.01"), 18, "ETH")} (funding reserve)`,
      );
      expect(ethBalance, `fund ${userAddress} with >= 0.01 ETH on EVM`).toBeGreaterThanOrEqual(
        parseEther("0.01"),
      );

      const { balance, decimals } = await getErc20Balance(rpcUrl, erc20Address, userAddress);
      console.log(
        `${userAddress}: ${fundingSummary(balance, parseUnits("0.1", decimals), decimals, erc20Address)}`,
      );
      expect(
        balance,
        `fund ${userAddress} with >= 0.1 of ERC20 ${erc20Address} on EVM`,
      ).toBeGreaterThanOrEqual(parseUnits("0.1", decimals));
    },
    MINUTE,
  );

  // Populated by the deposit test (or DEPOSIT_REQUEST_ID) for the
  // subsequent deposit stages.
  let depositTransactionSignatureRequestId: RequestIdHex;

  it(
    "deposit [erc-vault contract method call]: request a deposit through the flow and read it back MPC-style",
    async () => {
      // A request id given in the environment resumes a prior run (for
      // skipping steps during local development / OOM recovery).
      if (env.DEPOSIT_REQUEST_ID) {
        depositTransactionSignatureRequestId = env.DEPOSIT_REQUEST_ID as RequestIdHex;
        logSkip(
          "deposit",
          `DEPOSIT_REQUEST_ID present in environment, skipping deposit call '${depositTransactionSignatureRequestId}'`,
        );
        return;
      }

      const context = await session.vaultContext();

      // The sweep tx sender is the user's derived EVM account; its next nonce
      // comes from the chain, exactly as a wallet would fetch it.
      const evmNonce = await getTransactionNonce(
        requireEnv("EVM_RPC_URL"),
        requireEnv("EVM_USER_ADDRESS"),
      );
      const amount = parseUnits("0.1", 6); // 0.1 USDC — the funding preflight's minimum

      depositTransactionSignatureRequestId = await startDeposit(context, { amount, evmNonce });
      await printVaultState(context.providers.publicDataProvider, context.vaultContractAddress);

      expect(depositTransactionSignatureRequestId).toMatch(/^[0-9a-f]{64}$/);

      // MPC-convention verification: fetch the request record the way the
      // response server does — through a SignetRequestResponseReader over RAW
      // contract state. getSignatureRequest throws when the id is absent, so a
      // returned record is itself proof the request landed on the vault ledger.
      const record = await session
        .responseReader(VAULT_DEPOSIT_REQUESTS_PATH)
        .getSignatureRequest(depositTransactionSignatureRequestId);
      expect(record.txParams.nonce).toBe(evmNonce);
      expect(record.txParams.calldata.is_some).toBe(true);
      expect(abiWordToUint128(calldataWordAt(record.txParams.calldata.value.words, 1))).toBe(
        amount,
      );

      banner([
        `Deposit request recorded on the vault ledger:`,
        "",
        `  request id: ${depositTransactionSignatureRequestId}`,
        "",
        "The response server (MIDNIGHT_SIGNET_CONTRACT_ADDRESS set) polls the",
        "signet contract's emitted notification events and should pick it up",
        "on its next poll — resolving it from THIS vault's ledger — and sign the EVM tx.",
      ]);
    },
    5 * MINUTE,
  );

  it(
    "golden notification: the vault's deposit emitted a decodable notification event on the signet contract",
    async () => {
      // Pins the SignBidirectionalNotification payload layout against a LIVE
      // indexer, read exactly the way the MPC reads it — the signet
      // contract's emitted Misc events through the shared event decoders.
      // The vault's deposit cross-contract-called signBidirectional to emit
      // this.
      expect(depositTransactionSignatureRequestId).toBeDefined();
      const vaultAddress = requireEnv("MIDNIGHT_VAULT_CONTRACT_ADDRESS");

      const decoded = await pollSignetNotification({
        env,
        callerAddress: vaultAddress,
        requestsPath: [0, 0],
        requestId: depositTransactionSignatureRequestId,
        description: `for request ${depositTransactionSignatureRequestId}`,
      });

      // callerAddress points at the vault (the contract whose authenticated
      // ledger holds the request); the event map's resolved ledger-tree path
      // is [0, 0] (chunked past 15 fields). The notification is a doorbell declaring WHICH request (the
      // disclosed id) and WHERE to look, and the MPC reads the declared
      // request from the vault's own authenticated ledger.
      expect(decoded.version).toBe(1);
      expect(decoded.callerAddress).toBe(stripHexPrefix(vaultAddress).toLowerCase());
      expect(decoded.requestsPath).toEqual([0, 0]);

      banner([
        "Golden SignBidirectionalEventNotification decoded from the live indexer:",
        "",
        `  version:       ${String(decoded.version)}`,
        `  callerAddress: ${decoded.callerAddress}`,
        `  requestsPath:  [${decoded.requestsPath.join(", ")}]`,
      ]);
    },
    2 * MINUTE,
  );

  // Populated by the poll step below for the broadcast step.
  let signedDepositSweepTransaction: Transaction;

  it(
    "pollSignatureResponse: poll signet contract for sweep transaction signature response",
    async () => {
      expect(depositTransactionSignatureRequestId).toBeDefined();

      const context = await session.vaultContext();
      // Deposit sweeps are signed by the USER's derived account.
      signedDepositSweepTransaction = await pollSignatureResponse(context, {
        requestId: depositTransactionSignatureRequestId,
        intervalMs: 1000,
        timeoutMs: POLL_TIMEOUT_MS,
        expectedSigner: requireEnv("EVM_USER_ADDRESS"),
        requestsPath: VAULT_DEPOSIT_REQUESTS_PATH,
      });

      banner([
        `MPC signed Response for request ${depositTransactionSignatureRequestId} found from Signet Contract.`,
        "",
        `Signature: ${signedDepositSweepTransaction.serialized}`,
      ]);
    },
    POLL_TIMEOUT_MS + 5 * MINUTE,
  );

  it(
    "broadcast deposit sweep evm txn: broadcast to evm",
    async () => {
      expect(signedDepositSweepTransaction).toBeDefined();

      const context = await session.vaultContext();
      const receipt = await broadcastEvm(context, { transaction: signedDepositSweepTransaction });

      // No-translation invariant: the transaction the EVM chain accepted
      // carries the vault's stored calldata VERBATIM — selector || words,
      // byte for byte as they sit on the Midnight ledger. This is the
      // definitive end-to-end proof that nothing between the contract write
      // and the MPC signature reordered or reinterpreted the calldata.
      const record = await session
        .responseReader(VAULT_DEPOSIT_REQUESTS_PATH)
        .getSignatureRequest(depositTransactionSignatureRequestId);
      const storedCalldata = record.txParams.calldata.value;
      const expectedData =
        `0x${bytesToHex(storedCalldata.selector)}` +
        storedCalldata.words
          .slice(0, Number(storedCalldata.noWords))
          .map((word) => bytesToHex(word))
          .join("");
      const minedTx = await new JsonRpcProvider(requireEnv("EVM_RPC_URL")).getTransaction(
        receipt.hash,
      );
      expect(minedTx?.data, "broadcast calldata must be the stored bytes verbatim").toBe(
        expectedData,
      );

      banner([
        `Deposit sweep transaction broadcast to EVM.`,
        "",
        `Deposit Sweep Transaction Hex: ${receipt.hash} (block ${String(receipt.blockNumber)})`,
        "",
        "Verified: the mined transaction's calldata is the vault-stored",
        "selector || words, verbatim.",
      ]);
    },
    1 * MINUTE,
  );

  // Populated by the poll step below for the settle step.
  let depositSweepTransactionRespondBidirectional: RespondOutcome;

  it(
    "pollRespondBidirectional: poll signet contract for sweep transaction attestation",
    async () => {
      expect(depositTransactionSignatureRequestId).toBeDefined();

      // The output the attestation signs over travels off chain: the poll
      // traces the sweep's mined transaction for its raw output, re-packs it
      // per the schema and verifies the posted events' signatures over it
      // against the response key the vault pinned.
      const context = await session.vaultContext();
      depositSweepTransactionRespondBidirectional = await pollRespondBidirectional(context, {
        requestId: depositTransactionSignatureRequestId,
        intervalMs: 1000,
        timeoutMs: POLL_TIMEOUT_MS,
        requestsPath: VAULT_DEPOSIT_REQUESTS_PATH,
      });

      // The signature seals the round trip: it only verifies over bytes the
      // MPC itself produced, so a verified outcome means both sides ran the
      // same two conversions and got the same payload.
      const outcome = depositSweepTransactionRespondBidirectional;
      const { mpcResponseKey } = await readVaultLedger(
        context.providers.publicDataProvider,
        context.vaultContractAddress,
      );
      expect(
        verifyRespondBidirectionalSignature(
          outcome.serializedOutput,
          outcome.event,
          mpcResponseKey,
        ),
        "the attestation must verify over the recomputed output",
      ).toBe(true);
      expect(
        requestIdHex(outcome.event.requestId),
        "the verified event must name the deposit request",
      ).toBe(depositTransactionSignatureRequestId);
      const digest = calculateSignetAttestationDigest(
        requestIdBytes(depositTransactionSignatureRequestId),
        outcome.event.blockHeight,
        outcome.event.outputKind,
        outcome.serializedOutput,
      );
      expect(outcome.event.digest, "the posted digest must be the one recomputed here").toEqual(
        digest,
      );

      banner([
        `Found deposit RespondBidirectionalEvent (signature-verified) on the signet contract: ` +
          `success '${String(outcome.succeeded)}' ` +
          `(payload 0x${bytesToHex(outcome.serializedOutput)}, ${String(outcome.serializedOutput.length)} byte(s), ` +
          `kind ${OutputKind[outcome.event.outputKind]}, block ${String(outcome.event.blockHeight)})`,
        "",
        `Recomputed digest: 0x${bytesToHex(digest)}`,
        "",
        "The output stayed off chain: the raw bytes came from a",
        "debug_traceTransaction of the mined sweep transaction, were",
        "re-packed here, and the posted signature verified over them.",
      ]);
    },
    POLL_TIMEOUT_MS + 5 * MINUTE,
  );

  it(
    "completeDeposit [erc-vault contract method call]: verify the MPC attestation in-circuit and consume the request",
    async () => {
      // Final leg of the deposit round trip: the request is on the vault ledger
      // and the MPC's respond-bidirectional response is posted (previous
      // steps). Settling re-verifies the response IN-CIRCUIT (ECDSA signature
      // against the stored MPC response key, EVM success flag) and the caller
      // identity, then mints
      // shielded vault tokens and CONSUMES the request (double-claim
      // protection). The mint is shielded so it isn't publicly observable; the
      // request's removal from RAW ledger state is — present before, absent
      // after — and it only happens if every in-circuit check passed.
      expect(depositTransactionSignatureRequestId).toBeDefined();
      expect(depositSweepTransactionRespondBidirectional).toBeDefined();

      const context = await session.vaultContext();
      const requestKey = requestIdBytes(depositTransactionSignatureRequestId);

      const isRequestOnLedger = async () => {
        const ledger = await readVaultLedger(
          context.providers.publicDataProvider,
          context.vaultContractAddress,
        );
        return ledger.bidirectionalDepositMap.member(requestKey);
      };

      // Rerun against a kept contract address: if a prior run already claimed
      // this request the entry is gone and completeDeposit would reject with
      // "Request not sent", so skip cleanly instead.
      if (!(await isRequestOnLedger())) {
        logSkip(
          "completeDeposit",
          `request ${depositTransactionSignatureRequestId} already claimed (not on the ledger)`,
        );
        return;
      }

      await settleDeposit(context, depositSweepTransactionRespondBidirectional);
      await printVaultState(context.providers.publicDataProvider, context.vaultContractAddress);

      expect(
        await isRequestOnLedger(),
        "completeDeposit must consume the request from the ledger",
      ).toBe(false);

      banner([
        `Deposit ${depositTransactionSignatureRequestId} claimed.`,
        "",
        "The vault verified the MPC attestation in-circuit, minted shielded",
        "vault tokens to the caller, and removed the request from its ledger.",
      ]);
    },
    15 * MINUTE,
  );
});
