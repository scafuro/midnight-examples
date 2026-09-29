// The supply e2e flow: the vault's own EVM account deposits the pinned
// stataUnderlying (Aave USDC) into the pinned stataToken wrapper (stataUSDC), and
// the caller receives the attested shares as shielded stataToken vault coins.
// The supply runs the six steps: `startSupply` burns the caller's shielded
// underlying and queues the request, a flush assigns its vault nonce, the send
// records it for the MPC, then the MPC's width-8 attestation of the shares is
// queued, flushed and settled by `completeSupply`, which mints them.
//
// The wrapper's exchange rate is live, so the shares are read from the
// attestation, never hardcoded. The arrange stage runs a deposit round trip of
// the underlying first (the caller must hold shielded underlying to surrender,
// and the vault account must hold the ERC20 the wrapper pulls). Run AFTER
// tests/happy-day-e2e.test.ts (initialise) and tests/approve-e2e.test.ts (the
// wrapper's allowance on the underlying), as FILE_ORDER pins. Recovery from a
// run that died mid-flow (proof-server OOM): rerun this file with
// SUPPLY_DEPOSIT_REQUEST_ID / SUPPLY_REQUEST_ID set to the ids the failed run
// printed.
//
// Tests drive the vault THROUGH the example's typed flow functions
// (src/flows/), in-process, never a subprocess.
import { bytesToHex, OutputKind, requestIdBytes, type RequestIdHex } from "@sig-net/midnight";
import {
  readVaultLedger,
  VAULT_SUPPLY_REQUESTS_PATH,
  vaultGasEnvelope,
  type VaultLedgerState,
} from "@sig-net/midnight-examples-erc20-vault-contract";
import { waitForFacadeState } from "@sig-net/midnight-examples-lib";
import {
  banner,
  getErc20Balance,
  getEthBalance,
  logSkip,
  requireEnv as requireEnvOf,
} from "@sig-net/midnight-examples-test-harness";
import { injectE2eEnv, installFlowHooks } from "@sig-net/midnight-examples-test-harness/flow-hooks";
import { formatEther, formatUnits, parseEther, type Transaction } from "ethers";
import { afterAll, describe, expect, it } from "vitest";

import { fundingSummary } from "../src/evm-logging.ts";
import { broadcastEvm } from "../src/flows/broadcast-evm.ts";
import { attestedSupplyShares, settleSupply } from "../src/flows/complete-supply.ts";
import { runDepositRoundTrip } from "../src/flows/deposit-round-trip.ts";
import {
  pollRespondBidirectional,
  type RespondOutcome,
} from "../src/flows/poll-respond-bidirectional.ts";
import { pollSignatureResponse } from "../src/flows/poll-signature-response.ts";
import { startSupply } from "../src/flows/start-supply.ts";
import { POLL_TIMEOUT_MS } from "../src/poll-timeout.ts";
import type { VaultContext } from "../src/vault-context.ts";
import { createVaultSession } from "../src/vault-session.ts";
import { vaultTokenType } from "../src/vault-token.ts";

// ethers types `hash` nullable for the unsigned case. A transaction that came
// back from the MPC is signed, so a null here is a broken response, not a
// formatting concern.
const signedTxHash = (transaction: Transaction): string => {
  if (transaction.hash === null) {
    throw new Error("expected a signed transaction to carry a hash");
  }
  return transaction.hash;
};

const MINUTE = 60_000;

/**
 * The setup-populated env accumulator: repo-root `.env` overlaid with the
 * real environment (which wins), plus every value the globalSetup pipeline
 * derived or deployed. Empty when RUN_INTEGRATION_TESTS is unset: the suite
 * below skips before reading it.
 */
const env = injectE2eEnv();

/** Assert a setup step populated `name`, failing with a pointed message. */
const requireEnv = (name: string): string => requireEnvOf(env, name);

// Wallet facade + vault context shared by every test in this file (lazily
// built, so the offline path never touches the network), stopped once in
// afterAll.
const session = createVaultSession(env);

// 1 USDC (6 decimals): deposited, then surrendered by the supply.
const SUPPLY_AMOUNT = 1_000_000n;

/**
 * The vault ledger as the stages read it: the pinned Aave pair lives there,
 * so the spec follows whatever pair the deployment sealed in.
 *
 * @param context - The flow context.
 * @returns The decoded vault ledger state.
 */
const vaultLedger = (context: VaultContext): Promise<VaultLedgerState> =>
  readVaultLedger(context.providers.publicDataProvider, context.vaultContractAddress);

describe.skipIf(!process.env.RUN_INTEGRATION_TESTS)(
  "erc20-vault supply e2e: the vault account supplies the underlying for stataToken shares",
  () => {
    installFlowHooks();

    afterAll(async () => {
      await session.stop();
    });

    it(
      "funding preflight: user EVM account holds the supplied underlying, vault EVM account holds the supply gas budget",
      async () => {
        const rpcUrl = requireEnv("EVM_RPC_URL");
        const userAddress = requireEnv("EVM_USER_ADDRESS");
        const vaultAddress = requireEnv("EVM_VAULT_ADDRESS");
        const context = await session.vaultContext();
        const state = await vaultLedger(context);
        const underlying = `0x${bytesToHex(state.stataUnderlying)}`;

        // The user's derived account pays the deposit sweep's gas and supplies
        // the deposited underlying. A resumed deposit already swept it.
        const userEth = await getEthBalance(rpcUrl, userAddress);
        console.log(
          `${userAddress}: ${fundingSummary(userEth, parseEther("0.01"), 18, "ETH")} (funding reserve)`,
        );
        expect(userEth, `fund ${userAddress} with >= 0.01 ETH on EVM`).toBeGreaterThanOrEqual(
          parseEther("0.01"),
        );
        const required = env.SUPPLY_DEPOSIT_REQUEST_ID === undefined ? SUPPLY_AMOUNT : 0n;
        const { balance, decimals } = await getErc20Balance(rpcUrl, underlying, userAddress);
        console.log(
          `${userAddress}: ${fundingSummary(balance, required, decimals, underlying)} (supplied amount)`,
        );
        expect(
          balance,
          `fund ${userAddress} with >= ${formatUnits(required, decimals)} of ERC20 ${underlying} on EVM`,
        ).toBeGreaterThanOrEqual(required);

        // The vault's derived account sends the wrapper deposit itself, at the
        // vault's supply gas settings.
        const { gasLimit, maxFeePerGas } = vaultGasEnvelope(state, "supply");
        const gasBudget = gasLimit * maxFeePerGas;
        const vaultEth = await getEthBalance(rpcUrl, vaultAddress);
        console.log(
          `${vaultAddress}: ${fundingSummary(vaultEth, gasBudget, 18, "ETH")} (maximum gas fee)`,
        );
        expect(
          vaultEth,
          `fund the vault's derived account ${vaultAddress} with >= ${formatEther(gasBudget)} ETH on EVM`,
        ).toBeGreaterThanOrEqual(gasBudget);
      },
      5 * MINUTE,
    );

    it(
      "vault-initialised preflight: the vault contract is initialised (read-only)",
      async () => {
        const context = await session.vaultContext();
        expect(
          (await vaultLedger(context)).initialised,
          "vault is not initialised: run tests/happy-day-e2e.test.ts first (or initialise the vault)",
        ).toBe(true);
      },
      5 * MINUTE,
    );

    it(
      "arrange: deposit round trip mints the shielded underlying the supply will burn",
      async () => {
        const context = await session.vaultContext();
        const { requestId } = await runDepositRoundTrip(session, {
          amount: SUPPLY_AMOUNT,
          erc20Address: `0x${bytesToHex((await vaultLedger(context)).stataUnderlying)}`,
          reuseRequestId: env.SUPPLY_DEPOSIT_REQUEST_ID as RequestIdHex | undefined,
        });

        banner([
          `Arrange deposit ${requestId} complete: the caller holds ${String(SUPPLY_AMOUNT)} base units of shielded underlying.`,
          "",
          "If a later step dies (e.g. proof-server OOM), resume with",
          `  SUPPLY_DEPOSIT_REQUEST_ID=${requestId}`,
        ]);

        expect(requestId).toMatch(/^[0-9a-f]{64}$/);
      },
      2 * POLL_TIMEOUT_MS + 15 * MINUTE,
    );

    // Populated by the start stage (or SUPPLY_REQUEST_ID) for the later stages.
    let supplyRequestId: RequestIdHex;

    it(
      "supply: burn the shielded underlying, a flush assigns the vault nonce, and the supply is sent",
      async () => {
        if (env.SUPPLY_REQUEST_ID) {
          supplyRequestId = env.SUPPLY_REQUEST_ID as RequestIdHex;
          logSkip("supply", `SUPPLY_REQUEST_ID present, resuming supply '${supplyRequestId}'`);
          return;
        }

        const context = await session.vaultContext();
        supplyRequestId = await startSupply(context, { amount: SUPPLY_AMOUNT });
        expect(supplyRequestId).toMatch(/^[0-9a-f]{64}$/);

        banner([
          "Supply request recorded on the vault ledger:",
          "",
          `  request id: ${supplyRequestId}`,
          "",
          "The caller's shielded underlying is burned. If a later step dies,",
          `resume with SUPPLY_REQUEST_ID=${supplyRequestId}`,
        ]);
      },
      5 * MINUTE,
    );

    // Populated by the poll step below for the broadcast step.
    let signedSupplyTransaction: Transaction;

    it(
      "pollSignatureResponse: the MPC signs the wrapper deposit with the vault's account",
      async () => {
        expect(supplyRequestId).toBeDefined();

        const context = await session.vaultContext();
        signedSupplyTransaction = await pollSignatureResponse(context, {
          requestId: supplyRequestId,
          intervalMs: 1000,
          timeoutMs: POLL_TIMEOUT_MS,
          expectedSigner: requireEnv("EVM_VAULT_ADDRESS"),
          requestsPath: VAULT_SUPPLY_REQUESTS_PATH,
        });

        banner([
          `MPC signed response for supply ${supplyRequestId} found from Signet Contract.`,
          "",
          `Signed tx hash: ${signedTxHash(signedSupplyTransaction)}`,
        ]);
      },
      POLL_TIMEOUT_MS + 5 * MINUTE,
    );

    it(
      "broadcast the wrapper deposit: it mines on the EVM side",
      async () => {
        expect(signedSupplyTransaction).toBeDefined();
        const context = await session.vaultContext();

        // broadcastEvm waits for one confirmation and throws if the tx
        // reverted. An already-mined tx (rerun) short-circuits.
        const receipt = await broadcastEvm(context, { transaction: signedSupplyTransaction });

        banner([`The wrapper deposit mined on EVM: ${receipt.hash}`]);
      },
      3 * MINUTE,
    );

    // Populated by the poll step below for the settle step.
    let supplyAttestation: RespondOutcome;
    // The attested shares the settle mints.
    let supplyShares: bigint;

    it(
      "pollRespondBidirectional: the MPC attests the deposit as executed, carrying the minted shares",
      async () => {
        expect(supplyRequestId).toBeDefined();

        const context = await session.vaultContext();
        supplyAttestation = await pollRespondBidirectional(context, {
          requestId: supplyRequestId,
          intervalMs: 1000,
          timeoutMs: POLL_TIMEOUT_MS,
          requestsPath: VAULT_SUPPLY_REQUESTS_PATH,
        });

        // The broadcast step saw the deposit mine, so the MPC must attest an
        // execution whose 8-byte output packs the wrapper's share count.
        expect(
          supplyAttestation.event.outputKind,
          "a mined wrapper deposit must be attested under OutputKind.executed",
        ).toBe(OutputKind.executed);
        expect(supplyAttestation.serializedOutput).toHaveLength(8);
        supplyShares = attestedSupplyShares(supplyAttestation);
        expect(supplyShares).toBeGreaterThan(0n);

        banner([
          `Found execution attestation for supply ${supplyRequestId}:`,
          "",
          `  shares:       ${String(supplyShares)}`,
          `  block height: ${String(supplyAttestation.event.blockHeight)}`,
        ]);
      },
      POLL_TIMEOUT_MS + 5 * MINUTE,
    );

    it(
      "completeSupply: the execution attestation mints the shares as stataToken vault coins and consumes the request",
      async () => {
        expect(supplyRequestId).toBeDefined();
        expect(supplyAttestation).toBeDefined();

        const context = await session.vaultContext();
        const state = await vaultLedger(context);
        const isRequestOnLedger = async () =>
          (await vaultLedger(context)).bidirectionalSupplyMap.member(
            requestIdBytes(supplyRequestId),
          );

        // Rerun against a kept contract address: if a prior run already settled
        // this request the entry is gone and completeSupply would reject with
        // "Request not sent", so skip cleanly instead.
        if (!(await isRequestOnLedger())) {
          logSkip(
            "completeSupply",
            `supply ${supplyRequestId} already settled (not on the ledger)`,
          );
          return;
        }

        const color = vaultTokenType(
          `0x${bytesToHex(state.stataToken)}`,
          context.vaultContractAddress,
        );
        const wallet = await session.wallet();
        const balanceBefore =
          (await wallet.facade.waitForSyncedState()).shielded.balances[color] ?? 0n;

        await settleSupply(context, supplyAttestation);

        expect(
          await isRequestOnLedger(),
          "completeSupply must consume the request from the ledger",
        ).toBe(false);
        // The mint is a coin addressed to this wallet, so its balance shows it.
        const minted = await waitForFacadeState(
          wallet.facade,
          (synced) => (synced.shielded.balances[color] ?? 0n) >= balanceBefore + supplyShares,
        );
        expect(minted.shielded.balances[color] ?? 0n).toBe(balanceBefore + supplyShares);

        banner([
          `Supply ${supplyRequestId} settled with a MINT of ${String(supplyShares)} shares.`,
          "",
          "The vault verified the MPC's execution attestation, minted the",
          "attested shares as shielded stataToken vault coins to the supplier,",
          "and removed the request from its ledger.",
        ]);
      },
      15 * MINUTE,
    );
  },
);
