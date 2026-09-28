// Simulator-level unit tests: the contract runs entirely in-process via
// @midnight-ntwrk/compact-runtime. No ledger, no network, no proving.

import {
  type CircuitContext,
  createCircuitContext,
  createConstructorContext,
  rawTokenType,
  sampleContractAddress,
} from "@midnight-ntwrk/compact-runtime";
// This tree's wasm ContractState class: see signetStateProvider for why the
// portal-linked signet module's state must round-trip through it.
import { ContractState, CostModel, QueryContext } from "@midnightntwrk/onchain-runtime-v4";
import {
  asciiPadded,
  bytesToHex,
  calculateRequestId,
  decodeSignBidirectionalEventNotificationPayload,
  decodeSignBidirectionalNotification,
  decodeSignetLogEvents,
  evmAddressAbiWord,
  hexToBytes,
  MPCDestination,
  MPCSignatureAlgorithm,
  numericAbiWord,
  OutputKind,
  pureCircuits as signetCircuits,
  readSignetRequestsLedgerFromState,
  requestIdBytes,
  requestIdHex,
  type RespondBidirectionalEvent,
  respondBidirectionalEventToCircuitInput,
  serializeRespondOutput,
  type SignBidirectionalEventLedgerMap,
  SignetEventName,
  signetFieldNodeByPath,
  toSignBidirectionalEventIndex,
  TxParamType,
} from "@sig-net/midnight";
import { attestRespondBidirectional, secp256k1PublicKeyOf } from "@sig-net/midnight/testing";
import { describe, expect, it } from "vitest";

// The ERC20 transfer(address,uint256) selector: the TS mirror of the literal
// `Bytes [0xa9, 0x05, 0x9c, 0xbb]` hardcoded in erc20-vault.compact.
const ERC20_TRANSFER_SELECTOR = new Uint8Array([0xa9, 0x05, 0x9c, 0xbb]);

// The signet contract (callee) module, the same one the vault's generated code
// cross-contract-calls (via the compile-time src/managed/SignetSigner link
// into this npm package's managed output). The request circuits end in a call
// to its signBidirectional, so the simulator needs its state
// (see signetStateProvider) to execute that path.
import * as SignetSigner from "@sig-net/midnight-contract/managed/contract/index.js";

import {
  Action,
  Contract,
  createVaultPrivateState,
  FlushChannel,
  flushedRequestKey,
  flushSlots,
  ledger,
  pureCircuits,
  queuedRequestKey,
  VAULT_DEPOSIT_REQUESTS_PATH,
  VAULT_WITHDRAW_REQUESTS_PATH,
  type VaultPrivateState,
  witnesses,
} from "../src/index.ts";

// ---- Fixtures ----

// Dummy coin public key (32-byte hex). Required by the API, unused here.
const CPK = "0".repeat(64);

const bytes = (length: number, fill: number) => new Uint8Array(length).fill(fill);

// A `toHaveLength` assertion does not narrow the index read that follows it,
// so take the first element by iterating and fail naming what was missing.
const first = <T>(items: Iterable<T>, what: string): T => {
  for (const item of items) {
    return item;
  }
  throw new Error(`expected at least one ${what}`);
};

// Identity secrets for the simulated deployer/caller (same key: the deployer
// deposits in these tests) and for a stranger.
const SECRET_KEY = bytes(32, 7);
const OTHER_SECRET_KEY = bytes(32, 8);

// Commitments computed via the COMPILED circuit
const DEPLOYER_COMMITMENT = pureCircuits.userCommitment(SECRET_KEY);
const OTHER_COMMITMENT = pureCircuits.userCommitment(OTHER_SECRET_KEY);

// The "MPC" of these tests: its response key (secp256k1, derived per client
// contract from the contract address + the fixed path "midnight response
// key") is pinned by the one-shot initialise circuit right after deploy,
// exactly as a real deployment pins the off-chain-derived key (the key
// depends on the contract's own address, so it cannot be a constructor arg).
const MPC_RESPONSE_SECRET = bytes(32, 0x42);
const MPC_RESPONSE_KEY = secp256k1PublicKeyOf(MPC_RESPONSE_SECRET);
const EVM_START_HEIGHT = 100n;
const MPC_KEY_VERSION = 1n;
const ATTESTED_HEIGHT = 101n;

// The signet contract (callee) the vault seals + cross-contract-calls. A valid
// sample contract address so the runtime's address checks pass.
const SIGNET_ADDRESS = sampleContractAddress();
const SIGNET_CONTRACT_REF = {
  bytes: hexToBytes(SIGNET_ADDRESS),
};
const BLOCK_HASH = "0".repeat(64);

/**
 * A ContractStateProvider serving the signet contract's initial state to the
 * simulator's cross-contract call, which is how the request circuits reach
 * signBidirectionalEvent in-process (no node/indexer). Returns the state for
 * any address: the vault only calls the single sealed signet contract.
 *
 * The state is re-materialised through bytes: while `@sig-net/*` resolve to
 * the sibling checkout (portal wiring), the signet module runs on its OWN
 * copy of the wasm runtime, and the simulator's `instanceof ContractState`
 * checks demand THIS tree's class identity. Serialisation is
 * identity-neutral, so a byte round trip converts between the two. Harmless
 * (a no-op copy) under published single-tree installs.
 */
const signetStateProvider = async () => {
  const signet = new SignetSigner.Contract({});
  const { currentContractState } = await signet.initialState(
    createConstructorContext(undefined, CPK),
  );
  const state = ContractState.deserialize(currentContractState.serialize());
  return { getContractState: () => Promise.resolve(state) };
};

const VAULT_EVM = bytes(20, 0xee);
// The pinned Uniswap SwapRouter02 (initialise arg + swap `to`).
const ROUTER = bytes(20, 0x11);
const ERC20 = bytes(20, 0xaa);
// The pinned Aave USDC pair (initialise args): the underlying and its stataUSDC wrapper.
const STATA_UNDERLYING = bytes(20, 0xdd); // supply burns this colour, redeem mints it
const STATA_TOKEN = bytes(20, 0xcc); // supply/redeem `to`; supply mints this colour
const ZERO_ADDRESS = new Uint8Array(20);
const AMOUNT = 1_000_000n;
const UINT64_MAX = 18446744073709551615n;

// The EIP-155 chain id initialise() pins (Sepolia's).
const CHAIN_ID = 11155111n;

// The simulated vault's own contract address, fixed so tests can compute the
// token colors minted against kernel.self(). Doubles as the sender field of
// every event the vault records (kernel.self() again).
const VAULT_ADDRESS = sampleContractAddress();
const VAULT_ADDRESS_BYTES = hexToBytes(VAULT_ADDRESS);

// The contract-fixed MPC routing of every vault event (mirrors of the
// in-circuit constants; the round-trip tests below are the lockstep check for
// these values, including the escaped JSON schema literal at its EXACT
// contract-declared 34-byte width, never zero-padded).
const EXPECTED_SCHEMA = asciiPadded('[{"name":"success","type":"bool"}]', 34);
const EXPECTED_ROUTING = {
  algo: MPCSignatureAlgorithm.ecdsa,
  signatureDest: MPCDestination.unused,
  params: new Uint8Array(64),
  executionDest: signetCircuits.ethereumCaip2Id(),
  outputDeserializationSchema: EXPECTED_SCHEMA,
  respondSerializationSchema: EXPECTED_SCHEMA,
};

/**
 * A deposit's `startDeposit` arguments: the input index, the caller's EVM nonce,
 * the gas envelope and the `DepositRequest`. The derivation path IS the caller's
 * identity commitment, recomputed in-circuit from the secret-key witness.
 */
interface DepositCallArgs {
  inIndex: bigint;
  evmNonce: bigint;
  gasLimit: bigint;
  maxFeePerGas: bigint;
  maxPriorityFeePerGas: bigint;
  deposit: { erc20Address: Uint8Array; amount: bigint };
}

/**
 * Known-good deposit call args, the base every test varies from.
 * Shared across tests: NEVER mutate. Build a variation as an explicit spread
 * of this base with the delta inline (see {@link DEPOSIT_REJECTION_CASES}).
 */
const VALID_DEPOSIT: DepositCallArgs = {
  inIndex: 1n,
  evmNonce: 0n,
  gasLimit: 100000n,
  maxFeePerGas: 30000000000n,
  maxPriorityFeePerGas: 2000000000n,
  deposit: { erc20Address: ERC20, amount: AMOUNT },
};

// ---- Harness ----

const deployContract = async (deployerCommitment: Uint8Array = DEPLOYER_COMMITMENT) => {
  const contract = new Contract<VaultPrivateState>(witnesses);
  const { currentContractState, currentPrivateState } = await contract.initialState(
    createConstructorContext<VaultPrivateState>(createVaultPrivateState(SECRET_KEY), CPK),
    deployerCommitment,
    SIGNET_CONTRACT_REF,
  );
  const ctx = createCircuitContext(
    "startDeposit",
    VAULT_ADDRESS,
    CPK,
    currentContractState,
    currentPrivateState,
    await signetStateProvider(),
    undefined,
    undefined,
    undefined,
    BLOCK_HASH,
  );
  return { contract, ctx };
};

/**
 * Re-enter a threaded contract state as a DIFFERENT caller: same public
 * state, but the private state (the callerSecretKey witness) is a stranger's
 * ({@link OTHER_SECRET_KEY}).
 */
const strangerContext = async (
  circuitId: string,
  ctx: Parameters<Contract<VaultPrivateState>["circuits"]["startDeposit"]>[0],
) =>
  createCircuitContext(
    circuitId,
    VAULT_ADDRESS,
    CPK,
    ctx.callContext.currentQueryContext.state,
    createVaultPrivateState(OTHER_SECRET_KEY),
    await signetStateProvider(),
    undefined,
    undefined,
    undefined,
    BLOCK_HASH,
  );

const stateOf = (ctx: CircuitContext<VaultPrivateState>): unknown =>
  ctx.callContext.currentQueryContext.state;

const ledgerOf = (ctx: CircuitContext<VaultPrivateState>) => ledger(stateOf(ctx) as never);

/**
 * Deploy + initialise(VAULT_EVM, CHAIN_ID, MPC_RESPONSE_KEY) as
 * the deployer: the ready-to-use vault, with the MPC response key stored.
 */
const deployInitialised = async () => {
  const { contract, ctx } = await deployContract();
  const next = (
    await contract.circuits.initialise(
      ctx,
      VAULT_EVM,
      ROUTER,
      STATA_UNDERLYING,
      STATA_TOKEN,
      CHAIN_ID,
      MPC_RESPONSE_KEY,
      MPC_KEY_VERSION,
      EVM_START_HEIGHT,
    )
  ).context;
  return { contract, ctx: next };
};

/** One flushQueue call carrying the given request indexes and attestation request ids. */
const flush = async (
  contract: Contract<VaultPrivateState>,
  ctx: CircuitContext<VaultPrivateState>,
  inIndexes: readonly bigint[],
  requestIds: readonly Uint8Array[],
): Promise<CircuitContext<VaultPrivateState>> =>
  (await contract.circuits.flushQueue(ctx, flushSlots(inIndexes, requestIds))).context;

/** Queue a deposit: startDeposit with its args in circuit order. */
const queueDeposit = (
  contract: Contract<VaultPrivateState>,
  ctx: Parameters<Contract<VaultPrivateState>["circuits"]["startDeposit"]>[0],
  args: DepositCallArgs,
) =>
  contract.circuits.startDeposit(
    ctx,
    args.inIndex,
    args.evmNonce,
    {
      gasLimit: args.gasLimit,
      maxFeePerGas: args.maxFeePerGas,
      maxPriorityFeePerGas: args.maxPriorityFeePerGas,
    },
    args.deposit,
  );

/** Queue, flush and send a deposit, returning the send's context and the request key. */
const deposit = async (
  contract: Contract<VaultPrivateState>,
  ctx: Parameters<Contract<VaultPrivateState>["circuits"]["startDeposit"]>[0],
  args: DepositCallArgs,
) => {
  const queued = (await queueDeposit(contract, ctx, args)).context;
  const outKey = queuedRequestKey(ledgerOf(queued), args.inIndex);
  const flushed = await flush(contract, queued, [args.inIndex], []);
  const sent = await contract.circuits.sendDeposit(flushed, outKey);
  return { context: sent.context, outKey };
};

// ---- Tests ----

describe("erc20-vault ledger shape", () => {
  it("bidirectionalDepositMap parses into the shared signet-midnight types", async () => {
    const { ctx } = await deployContract();

    // The assignment is the real assertion: the generated ledger type must
    // stay structurally identical to the shared library's named types.
    const ledgerMap: SignBidirectionalEventLedgerMap = ledger(
      ctx.callContext.currentQueryContext.state,
    ).bidirectionalDepositMap;

    expect(ledgerMap.isEmpty()).toBe(true);
    expect(toSignBidirectionalEventIndex(ledgerMap).size).toBe(0);
  });

  it("MPC-style: finds the event map in RAW state by ledger-tree path, no ledger()", async () => {
    const { ctx } = await deployContract();

    const rawState = ctx.callContext.currentQueryContext.state;
    const node = signetFieldNodeByPath(rawState, VAULT_DEPOSIT_REQUESTS_PATH);
    expect(node.type()).toBe("map");

    const { requestsIndex } = readSignetRequestsLedgerFromState(
      rawState,
      VAULT_DEPOSIT_REQUESTS_PATH,
    );
    const typedIndex = toSignBidirectionalEventIndex(
      ledger(ctx.callContext.currentQueryContext.state).bidirectionalDepositMap,
    );
    expect(requestsIndex).toEqual(typedIndex);
    expect(requestsIndex.size).toBe(0);
  });
});

describe("userCommitment", () => {
  it("check 32-byte commitments computed off-chain via the compiled circuit", () => {
    expect(DEPLOYER_COMMITMENT).toHaveLength(32);
    expect(DEPLOYER_COMMITMENT).not.toEqual(new Uint8Array(32));
    expect(DEPLOYER_COMMITMENT).not.toEqual(OTHER_COMMITMENT);
  });
});

describe("ABI words (shared library circuits)", () => {
  it("TS mirrors match the compiled circuits byte for byte", () => {
    // Words are ABI-ready (big-endian, broadcast form): the library's TS
    // mirrors and its compiled circuits must emit identical bytes. The vault
    // stores exactly these words (see the deposit record tests).
    expect(evmAddressAbiWord(VAULT_EVM)).toEqual(signetCircuits.evmAddressAbiWord(VAULT_EVM));
    expect(numericAbiWord(AMOUNT)).toEqual(signetCircuits.numericAbiWord(AMOUNT));
    expect(signetCircuits.abiWordToUint128(numericAbiWord(AMOUNT))).toBe(AMOUNT);
  });
});

describe("initialise", () => {
  it("is deployer-gated", async () => {
    // Deployed with a stranger's commitment: our caller key can't initialise.
    const { contract, ctx } = await deployContract(OTHER_COMMITMENT);
    await expect(
      contract.circuits.initialise(
        ctx,
        VAULT_EVM,
        ROUTER,
        STATA_UNDERLYING,
        STATA_TOKEN,
        CHAIN_ID,
        MPC_RESPONSE_KEY,
        MPC_KEY_VERSION,
        EVM_START_HEIGHT,
      ),
    ).rejects.toThrow(/Not the deployer/);
  });

  it("rejects key version 0", async () => {
    const { contract, ctx } = await deployContract();
    await expect(
      contract.circuits.initialise(
        ctx,
        VAULT_EVM,
        ROUTER,
        STATA_UNDERLYING,
        STATA_TOKEN,
        CHAIN_ID,
        MPC_RESPONSE_KEY,
        0n,
        EVM_START_HEIGHT,
      ),
    ).rejects.toThrow(/keyVersion must be >= 1/);
  });

  it("is one-shot", async () => {
    const { contract, ctx } = await deployInitialised();
    await expect(
      contract.circuits.initialise(
        ctx,
        VAULT_EVM,
        ROUTER,
        STATA_UNDERLYING,
        STATA_TOKEN,
        CHAIN_ID,
        MPC_RESPONSE_KEY,
        MPC_KEY_VERSION,
        EVM_START_HEIGHT,
      ),
    ).rejects.toThrow(/Already initialised/);
  });

  it("rejects a zero chain id", async () => {
    const { contract, ctx } = await deployContract();
    await expect(
      contract.circuits.initialise(
        ctx,
        VAULT_EVM,
        ROUTER,
        STATA_UNDERLYING,
        STATA_TOKEN,
        0n,
        MPC_RESPONSE_KEY,
        MPC_KEY_VERSION,
        EVM_START_HEIGHT,
      ),
    ).rejects.toThrow(/Chain ID must be positive/);
  });

  it("stores the vault EVM address, the chain id and the MPC response key", async () => {
    const { ctx } = await deployInitialised();
    const state = ledger(ctx.callContext.currentQueryContext.state);
    expect(state.initialised).toBe(true);
    expect(state.vaultEvmAddress).toEqual(VAULT_EVM);
    expect(state.uniswapRouter).toEqual(ROUTER);
    expect(state.evmChainId).toBe(CHAIN_ID);
    expect(state.mpcResponseKey).toEqual(MPC_RESPONSE_KEY);
  });
});

describe("deposit round-trip", () => {
  it("stores a fully contract-composed event readable identically via ledger(), the shared parser, and the RAW reader", async () => {
    const { contract, ctx } = await deployInitialised();

    const { context: next, outKey } = await deposit(contract, ctx, VALID_DEPOSIT);
    const state = next.callContext.currentQueryContext.state;

    // Read 1: generated ledger().
    const typedIndex = toSignBidirectionalEventIndex(ledger(state).bidirectionalDepositMap);
    // Read 2: MPC-style raw read, no compiled contract involved.
    const rawLedger = readSignetRequestsLedgerFromState(state, VAULT_DEPOSIT_REQUESTS_PATH);

    expect(typedIndex.size).toBe(1);
    expect(rawLedger.requestsIndex).toEqual(typedIndex);

    const [idHex, record] = first(typedIndex.entries(), "indexed signBidirectional request");

    // The cross-contract call's observable effect: the signet contract
    // emitted the notification event, its payload declaring the stored
    // event's id and naming THIS vault and the bidirectionalDepositMap (decoded
    // through the shared library's decoders, the same read the MPC's
    // discovery feed performs).
    const notificationEvents = decodeSignetLogEvents(next.events, SIGNET_ADDRESS);
    expect(notificationEvents).toHaveLength(1);
    const notificationEvent = first(notificationEvents, "signet notification event");
    expect(notificationEvent.name).toBe(SignetEventName.SignBidirectionalEvent);
    const notificationPost = decodeSignBidirectionalEventNotificationPayload(
      notificationEvent.payload,
    );
    // The declared id IS the stored map key: the MPC looks it up directly.
    expect(requestIdHex(notificationPost.requestId)).toBe(idHex);
    expect(decodeSignBidirectionalNotification(notificationPost.event)).toEqual({
      version: 1,
      callerAddress: bytesToHex(VAULT_ADDRESS_BYTES),
      requestsPath: [1, 11],
    });

    // The contract-composed envelope: the deposit's token on the
    // initialise-pinned chain, no ETH value, the caller's nonce and the gas
    // args of the send.
    const { calldata, ...envelope } = record.txParams;
    expect(envelope).toEqual({
      to: ERC20,
      chainId: CHAIN_ID,
      nonce: VALID_DEPOSIT.evmNonce,
      gasLimit: VALID_DEPOSIT.gasLimit,
      maxFeePerGas: VALID_DEPOSIT.maxFeePerGas,
      maxPriorityFeePerGas: VALID_DEPOSIT.maxPriorityFeePerGas,
      value: 0n,
      accessListEntryCount: 0n,
      accessList: [],
    });

    // The event commits to its own sender (kernel.self()) and carries the
    // caller's identity commitment as its 32-byte derivation path. The
    // contract-fixed routing matches the TS expectations: the LOCKSTEP CHECK
    // for the in-circuit constants (including the escaped JSON schema
    // literal at its exact 34-byte width).
    expect(record.sender).toEqual({ bytes: VAULT_ADDRESS_BYTES });
    expect(record.path).toEqual(DEPLOYER_COMMITMENT);
    expect(record.executionDest).toEqual(EXPECTED_ROUTING.executionDest);
    expect(record.keyVersion).toBe(MPC_KEY_VERSION);
    expect(record.algo).toBe(EXPECTED_ROUTING.algo);
    expect(record.signatureDest).toBe(EXPECTED_ROUTING.signatureDest);
    expect(record.params).toEqual(EXPECTED_ROUTING.params);
    expect(record.txParamType).toBe(TxParamType.evmType2);
    expect(record.outputDeserializationSchema).toEqual(
      EXPECTED_ROUTING.outputDeserializationSchema,
    );
    expect(record.respondSerializationSchema).toEqual(EXPECTED_ROUTING.respondSerializationSchema);

    // Contract-built calldata: transfer(vaultEvmAddress, amount) as ABI-ready
    // big-endian words, stored exactly as broadcast.
    expect(calldata.is_some).toBe(true);
    expect(calldata.value.selector).toEqual(ERC20_TRANSFER_SELECTOR);
    expect(calldata.value.noWords).toBe(2n);
    expect(calldata.value.words).toHaveLength(2);
    expect(calldata.value.words[0]).toEqual(evmAddressAbiWord(VAULT_EVM));
    expect(calldata.value.words[1]).toEqual(numericAbiWord(AMOUNT));

    // The map key IS the record's transientHash digest, recomputed off-chain
    // with the library's TS twin of the request-id circuit. This assertion is
    // the lockstep check the twin's deviation note relies on: the id computed
    // in TS must equal the key the REAL compiled contract minted in-circuit.
    expect(idHex).toBe(requestIdHex(calculateRequestId(record)));

    // The flushed entry sits under its request key with the height the flush
    // recorded, its arguments sit in depositArgsMap under its input index, and
    // the send mapped the request id back to that key.
    const { entry, lastSeen } = ledger(state).outputRequestBuffer.lookup(outKey);
    expect(entry).toEqual({
      action: Action.deposit,
      nonceIsVault: false,
      evmNonce: VALID_DEPOSIT.evmNonce,
      inIndex: VALID_DEPOSIT.inIndex,
      commitment: pureCircuits.ownershipCommitment(VALID_DEPOSIT.inIndex, SECRET_KEY),
      argsHash: expect.any(Uint8Array) as Uint8Array,
    });
    expect(lastSeen).toBe(EVM_START_HEIGHT);
    expect(ledger(state).depositArgsMap.lookup(VALID_DEPOSIT.inIndex)).toEqual({
      request: VALID_DEPOSIT.deposit,
      path: DEPLOYER_COMMITMENT,
      gas: {
        gasLimit: VALID_DEPOSIT.gasLimit,
        maxFeePerGas: VALID_DEPOSIT.maxFeePerGas,
        maxPriorityFeePerGas: VALID_DEPOSIT.maxPriorityFeePerGas,
      },
    });
    expect(ledger(state).evictionMap.lookup(requestIdBytes(idHex))).toEqual(outKey);
    expect(ledger(state).inputRequestBuffer.isEmpty()).toBe(true);
  });
});

/** One row of the deposit rejection table: full inputs to expected error. */
interface DepositRejectionCase {
  /** Test name, completing the sentence "rejects <name>". */
  name: string;
  /** Complete call args passed to the circuits. */
  args: DepositCallArgs;
  /** Error the circuits must throw. */
  throws: RegExp;
}

const DEPOSIT_REJECTION_CASES: DepositRejectionCase[] = [
  {
    name: "a zero ERC20 address",
    args: { ...VALID_DEPOSIT, deposit: { erc20Address: ZERO_ADDRESS, amount: AMOUNT } },
    throws: /ERC20 address cannot be zero/,
  },
  {
    name: "a zero amount",
    args: { ...VALID_DEPOSIT, deposit: { erc20Address: ERC20, amount: 0n } },
    throws: /Amount must be positive/,
  },
  {
    name: "an amount above Uint<64> max (unclaimable)",
    args: { ...VALID_DEPOSIT, deposit: { erc20Address: ERC20, amount: UINT64_MAX + 1n } },
    throws: /Amount exceeds Uint<64> max/,
  },
  {
    name: "a zero gas limit",
    args: { ...VALID_DEPOSIT, gasLimit: 0n },
    throws: /Gas limit must be positive/,
  },
];

describe("deposit validation", () => {
  it.each(DEPOSIT_REJECTION_CASES)("rejects $name", async ({ args, throws }) => {
    const { contract, ctx } = await deployInitialised();
    await expect(deposit(contract, ctx, args)).rejects.toThrow(throws);
  });

  it("rejects before initialise", async () => {
    const { contract, ctx } = await deployContract();
    await expect(deposit(contract, ctx, VALID_DEPOSIT)).rejects.toThrow(/Not initialised/);
  });

  it("an identical repeat names the same transaction and stays queued while the first is open", async () => {
    const { contract, ctx } = await deployInitialised();
    const { context: afterFirst, outKey } = await deposit(contract, ctx, VALID_DEPOSIT);
    const repeat = { ...VALID_DEPOSIT, inIndex: 2n };

    const queued = (await queueDeposit(contract, afterFirst, repeat)).context;
    expect(queuedRequestKey(ledgerOf(queued), repeat.inIndex)).toEqual(outKey);
    const flushed = await flush(contract, queued, [repeat.inIndex], []);

    expect(ledgerOf(flushed).inputRequestBuffer.member(repeat.inIndex)).toBe(true);
    expect(ledgerOf(flushed).outputRequestBuffer.size()).toBe(1n);
    await expect(contract.circuits.sendDeposit(flushed, outKey)).rejects.toThrow(
      /Request already sent/,
    );
  });

  it("the SAME caller depositing twice with different EVM nonces gets two ids", async () => {
    const { contract, ctx } = await deployInitialised();

    const afterFirst = (await deposit(contract, ctx, VALID_DEPOSIT)).context;
    const afterSecond = (
      await deposit(contract, afterFirst, {
        ...VALID_DEPOSIT,
        inIndex: 2n,
        evmNonce: VALID_DEPOSIT.evmNonce + 1n,
      })
    ).context;
    const state = ledger(afterSecond.callContext.currentQueryContext.state);

    const index = toSignBidirectionalEventIndex(state.bidirectionalDepositMap);
    expect(index.size).toBe(2);
  });
});

// An MPC response secret OTHER than the one initialise pinned the key of.
const IMPOSTER_SECRET = bytes(32, 0x43);

// The caller-chosen mint nonce every minting settle circuit takes. In production the
// client draws it fresh from a CSPRNG per call (that randomness is the
// unlinkability guarantee). The circuit only threads it through, so a fixed
// value is fine for these deterministic simulator tests.
const MINT_NONCE = bytes(32, 0x2e);
// The vault's respond schema, read from the COMPILED circuit (the contract's
// own declaration), so the fixtures below run through the same ABI-to-compact
// pipeline the real client uses: schema -> descriptor -> midnight-serde
// compactSerialize. Nothing here hand-packs bytes.
const VAULT_RESPONSE_SCHEMA = pureCircuits.vaultResponseSchema();

// A successful remote execution: the packed bool result at its exact
// unpadded width, one 0x01 byte (the circuits take it as Bytes<1>).
const OUTPUT_SUCCESS = serializeRespondOutput(VAULT_RESPONSE_SCHEMA, { success: true });

// An EXECUTED transfer that returned false: one 0x00 byte.
const OUTPUT_FALSE = serializeRespondOutput(VAULT_RESPONSE_SCHEMA, { success: false });

// A failed or unviable execution attests an empty output (queueAttestation0).
const OUTPUT_EMPTY = new Uint8Array(0);

// completeDeposit takes a 1-byte output on every verdict and ignores it on a failure.
const OUTPUT_IGNORED = new Uint8Array(1);

/**
 * Sign a REAL RespondBidirectionalEvent for (requestId, blockHeight,
 * outputKind, serializedOutput) with `secretKey`: the record comes from the
 * library's sanctioned minting helper (pinned byte-for-byte against the
 * compiled oracles in signet-midnight's own tests), exactly like the MPC.
 * The wire event carries the request id, block height, kind, output width,
 * digest and the stored-form signature (big-endian SEC1, bigR as a full
 * point), and it is returned flipped to
 * verifyRespondBidirectionalEventV1's circuit-input form, which is what a
 * client hands to the queue circuits: the digest is recomputed by whoever
 * verifies, and the output travels as a separate circuit argument.
 */
const respond = (
  secretKey: Uint8Array,
  requestId: Uint8Array,
  outputKind: OutputKind,
  serializedOutput: Uint8Array,
  blockHeight: bigint,
): RespondBidirectionalEvent =>
  respondBidirectionalEventToCircuitInput(
    attestRespondBidirectional({ requestId, blockHeight, outputKind, serializedOutput }, secretKey),
  );

/** Queue a 1-byte attestation and flush it: the arrange step before a settle. */
const attest = async (
  contract: Contract<VaultPrivateState>,
  ctx: CircuitContext<VaultPrivateState>,
  attestation: RespondBidirectionalEvent,
  serializedOutput: Uint8Array,
): Promise<CircuitContext<VaultPrivateState>> => {
  const queued = (await contract.circuits.queueAttestation1(ctx, attestation, serializedOutput))
    .context;
  return flush(contract, queued, [], [attestation.requestId]);
};

// ---- Settle fixtures ----

// The circuit's `Maybe<Either<ZswapCoinPublicKey, ContractAddress>>` recipient
// argument. Compact's Maybe/Either are plain structs: even a `none` (and the
// unused Either side of a `some`) carries a fully default-valued payload so
// the argument stays well-aligned.
const CALLER_RECIPIENT = {
  is_some: false,
  value: {
    is_left: true,
    left: { bytes: new Uint8Array(32) },
    right: { bytes: new Uint8Array(32) },
  },
};
const OTHER_WALLET_RECIPIENT = {
  is_some: true,
  value: {
    is_left: true,
    left: { bytes: bytes(32, 0x21) },
    right: { bytes: new Uint8Array(32) },
  },
};
const CONTRACT_RECIPIENT = {
  is_some: true,
  value: {
    is_left: false,
    left: { bytes: new Uint8Array(32) },
    right: { bytes: hexToBytes(sampleContractAddress()) },
  },
};

/**
 * Deploy + initialise + deposit(VALID_DEPOSIT): the arrange step of
 * every claim test. Returns the sent deposit's request id (the single
 * ledger map key) and request key alongside the threaded context.
 */
const depositRequested = async () => {
  const { contract, ctx } = await deployInitialised();
  const { context: next, outKey } = await deposit(contract, ctx, VALID_DEPOSIT);
  const index = toSignBidirectionalEventIndex(ledgerOf(next).bidirectionalDepositMap);
  const idHex = first(index.keys(), "signBidirectional request id");
  return { contract, ctx: next, requestId: requestIdBytes(idHex), outKey };
};

// ---- Claim-deposit tests ----

describe("completeDeposit settle", () => {
  // The mint itself is shielded: the call resolving proves it executed, and
  // the publicly-observable effect asserted here is the request's consumption.
  it.each([
    { name: "no recipient: mints to the caller", recipient: CALLER_RECIPIENT },
    {
      name: "an explicit wallet recipient: mints to the given coin public key",
      recipient: OTHER_WALLET_RECIPIENT,
    },
    {
      name: "an explicit contract recipient: mints to the given contract address",
      recipient: CONTRACT_RECIPIENT,
    },
  ])("$name and consumes the request", async ({ recipient }) => {
    const { contract, ctx, requestId } = await depositRequested();
    const attested = await attest(
      contract,
      ctx,
      respond(MPC_RESPONSE_SECRET, requestId, OutputKind.executed, OUTPUT_SUCCESS, ATTESTED_HEIGHT),
      OUTPUT_SUCCESS,
    );

    const next = (
      await contract.circuits.completeDeposit(
        attested,
        requestId,
        OUTPUT_SUCCESS,
        MINT_NONCE,
        recipient,
      )
    ).context;

    expect(next.callContext.currentQueryContext.effects.shieldedMints.size).toBe(1);
    const state = ledgerOf(next);
    expect(state.bidirectionalDepositMap.isEmpty()).toBe(true);
    expect(state.outputRequestBuffer.isEmpty()).toBe(true);
    expect(state.outputAttestationBuffer.isEmpty()).toBe(true);
    expect(state.evictionMap.isEmpty()).toBe(true);
    expect(state.depositArgsMap.isEmpty()).toBe(true);
  });

  it("queueAttestation1 rejects a response signed by a key other than the stored MPC response key", async () => {
    const { contract, ctx, requestId } = await depositRequested();
    await expect(
      contract.circuits.queueAttestation1(
        ctx,
        respond(IMPOSTER_SECRET, requestId, OutputKind.executed, OUTPUT_SUCCESS, ATTESTED_HEIGHT),
        OUTPUT_SUCCESS,
      ),
    ).rejects.toThrow(/Invalid attestation signature/);
  });

  it("closes a genuinely signed sweep that returned false without minting", async () => {
    const { contract, ctx, requestId } = await depositRequested();
    const attested = await attest(
      contract,
      ctx,
      respond(MPC_RESPONSE_SECRET, requestId, OutputKind.executed, OUTPUT_FALSE, ATTESTED_HEIGHT),
      OUTPUT_FALSE,
    );

    const next = (
      await contract.circuits.completeDeposit(
        attested,
        requestId,
        OUTPUT_FALSE,
        MINT_NONCE,
        CALLER_RECIPIENT,
      )
    ).context;

    expect(next.callContext.currentQueryContext.effects.shieldedMints.size).toBe(0);
    const state = ledgerOf(next);
    expect(state.bidirectionalDepositMap.isEmpty()).toBe(true);
    expect(state.outputRequestBuffer.isEmpty()).toBe(true);
    expect(state.outputAttestationBuffer.isEmpty()).toBe(true);
    expect(state.evictionMap.isEmpty()).toBe(true);
    expect(state.depositArgsMap.isEmpty()).toBe(true);
  });

  it("queueAttestation1 rejects presented output bytes that differ from what was signed", async () => {
    const { contract, ctx, requestId } = await depositRequested();
    // Signed over the FALSE result, presented as a success byte: the digest
    // recomputed in-circuit is not the one the signature covers. This is the
    // attack the output-free event must stop: claiming a false return as a
    // success.
    await expect(
      contract.circuits.queueAttestation1(
        ctx,
        respond(MPC_RESPONSE_SECRET, requestId, OutputKind.executed, OUTPUT_FALSE, ATTESTED_HEIGHT),
        OUTPUT_SUCCESS,
      ),
    ).rejects.toThrow(/Invalid attestation signature/);
  });

  it("completeDeposit rejects presented output bytes that differ from the flushed attestation", async () => {
    const { contract, ctx, requestId } = await depositRequested();
    // Queued honestly over the FALSE result, then settled presenting a
    // success byte: the output no longer hashes to the digest the record
    // sits under.
    const attested = await attest(
      contract,
      ctx,
      respond(MPC_RESPONSE_SECRET, requestId, OutputKind.executed, OUTPUT_FALSE, ATTESTED_HEIGHT),
      OUTPUT_FALSE,
    );
    await expect(
      contract.circuits.completeDeposit(
        attested,
        requestId,
        OUTPUT_SUCCESS,
        MINT_NONCE,
        CALLER_RECIPIENT,
      ),
    ).rejects.toThrow(/Output does not match the attestation/);
  });

  it("closes a genuinely signed failed sweep without minting", async () => {
    const { contract, ctx, requestId } = await depositRequested();
    const queued = (
      await contract.circuits.queueAttestation0(
        ctx,
        respond(MPC_RESPONSE_SECRET, requestId, OutputKind.failed, OUTPUT_EMPTY, ATTESTED_HEIGHT),
        OUTPUT_EMPTY,
      )
    ).context;
    const flushed = await flush(contract, queued, [], [requestId]);

    const next = (
      await contract.circuits.completeDeposit(
        flushed,
        requestId,
        OUTPUT_IGNORED,
        MINT_NONCE,
        CALLER_RECIPIENT,
      )
    ).context;

    expect(next.callContext.currentQueryContext.effects.shieldedMints.size).toBe(0);
    const state = ledgerOf(next);
    expect(state.bidirectionalDepositMap.isEmpty()).toBe(true);
    expect(state.outputRequestBuffer.isEmpty()).toBe(true);
    expect(state.outputAttestationBuffer.isEmpty()).toBe(true);
    expect(state.evictionMap.isEmpty()).toBe(true);
    expect(state.depositArgsMap.isEmpty()).toBe(true);
  });

  it("queueAttestation1 rejects a genuinely signed id this vault never sent", async () => {
    const { contract, ctx } = await depositRequested();
    const unknownId = bytes(32, 0xab);
    await expect(
      contract.circuits.queueAttestation1(
        ctx,
        respond(
          MPC_RESPONSE_SECRET,
          unknownId,
          OutputKind.executed,
          OUTPUT_SUCCESS,
          ATTESTED_HEIGHT,
        ),
        OUTPUT_SUCCESS,
      ),
    ).rejects.toThrow(/Request not sent/);
  });

  it("claims once: a second claim for the same request rejects", async () => {
    const { contract, ctx, requestId } = await depositRequested();
    const attested = await attest(
      contract,
      ctx,
      respond(MPC_RESPONSE_SECRET, requestId, OutputKind.executed, OUTPUT_SUCCESS, ATTESTED_HEIGHT),
      OUTPUT_SUCCESS,
    );
    const next = (
      await contract.circuits.completeDeposit(
        attested,
        requestId,
        OUTPUT_SUCCESS,
        MINT_NONCE,
        CALLER_RECIPIENT,
      )
    ).context;
    await expect(
      contract.circuits.completeDeposit(
        next,
        requestId,
        OUTPUT_SUCCESS,
        MINT_NONCE,
        CALLER_RECIPIENT,
      ),
      // The first claim consumed the request's eviction entry and output entry.
    ).rejects.toThrow(/Request not sent/);
  });

  it("rejects a caller other than the original depositor, even one naming themselves recipient", async () => {
    // The output entry pins the DEPOSITOR's ownership commitment, and the
    // stranger's witness recomputes a different one.
    const { contract, ctx, requestId } = await depositRequested();
    const attested = await attest(
      contract,
      ctx,
      respond(MPC_RESPONSE_SECRET, requestId, OutputKind.executed, OUTPUT_SUCCESS, ATTESTED_HEIGHT),
      OUTPUT_SUCCESS,
    );
    await expect(
      contract.circuits.completeDeposit(
        await strangerContext("completeDeposit", attested),
        requestId,
        OUTPUT_SUCCESS,
        MINT_NONCE,
        OTHER_WALLET_RECIPIENT,
      ),
    ).rejects.toThrow(/Not the requester/);
  });
});

// ---- Withdraw fixtures ----

// Where the vault sends the ERC20 on withdraw.
const DEST_EVM = bytes(20, 0x77);

// The vault token colour for ERC20 at the simulated contract address, computed
// exactly as a wallet would: the compiled domain-separator circuit plus the
// runtime's rawTokenType (the off-chain twin of the in-circuit
// `tokenType(domainSep, kernel.self())`).
const VAULT_TOKEN_COLOR = hexToBytes(
  rawTokenType(pureCircuits.vaultTokenDomainSeparator(ERC20), VAULT_ADDRESS),
);

// The stdlib's shieldedBurnAddress() recipient: the all-zero coin public key.
// The burn-output assertions below are the lockstep check for this mirror.
const BURN_ADDRESS_BYTES = new Uint8Array(32);

/** A surrendered vault coin: fixed nonce, vault-token colour, given value. */
const vaultCoin = (value: bigint, color: Uint8Array = VAULT_TOKEN_COLOR) => ({
  nonce: bytes(32, 0x0c),
  color,
  value,
});

/**
 * A withdrawal's `startWithdraw` arguments: the input index, the
 * `WithdrawRequest` and the surrendered coin. The nonce and gas are the
 * vault's, so the caller passes neither.
 */
interface WithdrawCallArgs {
  inIndex: bigint;
  withdraw: { erc20Address: Uint8Array; amount: bigint; destEvmAddress: Uint8Array };
  coin: ReturnType<typeof vaultCoin>;
}

/**
 * Known-good withdraw call args, the base every test varies from.
 * Shared across tests: NEVER mutate. Build a variation as an explicit spread
 * of this base with the delta inline (see {@link WITHDRAW_REJECTION_CASES}).
 */
const VALID_WITHDRAW: WithdrawCallArgs = {
  inIndex: 11n,
  withdraw: { erc20Address: ERC20, amount: AMOUNT, destEvmAddress: DEST_EVM },
  coin: vaultCoin(AMOUNT),
};

// The vault's gas settings initialise() stores, which every withdrawal copies at start.
const DEFAULT_VAULT_GAS = {
  gasLimit: 100_000n,
  maxFeePerGas: 150_000_000_000n,
  maxPriorityFeePerGas: 1_000_000_000n,
};

/** Queue a withdrawal: startWithdraw with its args in circuit order. */
const queueWithdraw = (
  contract: Contract<VaultPrivateState>,
  ctx: CircuitContext<VaultPrivateState>,
  args: WithdrawCallArgs,
) => contract.circuits.startWithdraw(ctx, args.inIndex, args.withdraw, args.coin);

/** Queue, flush and send a withdrawal, returning the send's context and the request key. */
const withdraw = async (
  contract: Contract<VaultPrivateState>,
  ctx: CircuitContext<VaultPrivateState>,
  args: WithdrawCallArgs,
) => {
  const queued = (await queueWithdraw(contract, ctx, args)).context;
  const flushed = await flush(contract, queued, [args.inIndex], []);
  const outKey = flushedRequestKey(ledgerOf(flushed), Action.withdraw, args.inIndex);
  const sent = await contract.circuits.sendWithdraw(flushed, outKey);
  return { context: sent.context, outKey };
};

/** The zswap local state a circuit run produced, failing when there is none. */
const zswapState = (context: CircuitContext<VaultPrivateState>) => {
  const state = context.callContext.currentZswapLocalState;
  if (!state) {
    throw new Error("expected zswap local state on the circuit context");
  }
  return state;
};

// ---- Withdraw tests ----

describe("withdraw round-trip", () => {
  it("burns the coin and stores a vault-path event built from the flushed entry and its args", async () => {
    const { contract, ctx } = await deployInitialised();

    const { context: next, outKey } = await withdraw(contract, ctx, VALID_WITHDRAW);
    const state = next.callContext.currentQueryContext.state;

    const typedIndex = toSignBidirectionalEventIndex(ledger(state).bidirectionalWithdrawMap);
    const rawLedger = readSignetRequestsLedgerFromState(state, VAULT_WITHDRAW_REQUESTS_PATH);
    expect(typedIndex.size).toBe(1);
    expect(rawLedger.requestsIndex).toEqual(typedIndex);
    const [idHex, record] = first(typedIndex.entries(), "indexed withdraw request");

    // The notification names THIS vault and the bidirectionalWithdrawMap.
    const notificationEvent = first(
      decodeSignetLogEvents(next.events, SIGNET_ADDRESS),
      "signet notification event",
    );
    expect(notificationEvent.name).toBe(SignetEventName.SignBidirectionalEvent);
    const notificationPost = decodeSignBidirectionalEventNotificationPayload(
      notificationEvent.payload,
    );
    expect(requestIdHex(notificationPost.requestId)).toBe(idHex);
    expect(decodeSignBidirectionalNotification(notificationPost.event)).toEqual({
      version: 1,
      callerAddress: bytesToHex(VAULT_ADDRESS_BYTES),
      requestsPath: [1, 13],
    });

    // The vault's own account signs: the derivation path is the contract-fixed
    // 32-byte literal "vault", the nonce is the first one the flush assigned,
    // and the gas is the vault's setting copied at start.
    expect(record.sender).toEqual({ bytes: VAULT_ADDRESS_BYTES });
    expect(record.path).toEqual(asciiPadded("vault", 32));
    const { calldata, ...envelope } = record.txParams;
    expect(envelope).toEqual({
      to: ERC20,
      chainId: CHAIN_ID,
      nonce: 0n,
      ...DEFAULT_VAULT_GAS,
      value: 0n,
      accessListEntryCount: 0n,
      accessList: [],
    });
    expect(record.executionDest).toEqual(EXPECTED_ROUTING.executionDest);
    expect(record.keyVersion).toBe(MPC_KEY_VERSION);
    expect(record.algo).toBe(EXPECTED_ROUTING.algo);
    expect(record.signatureDest).toBe(EXPECTED_ROUTING.signatureDest);
    expect(record.params).toEqual(EXPECTED_ROUTING.params);
    expect(record.txParamType).toBe(TxParamType.evmType2);
    expect(record.outputDeserializationSchema).toEqual(
      EXPECTED_ROUTING.outputDeserializationSchema,
    );
    expect(record.respondSerializationSchema).toEqual(EXPECTED_ROUTING.respondSerializationSchema);

    // Contract-built calldata: transfer(destEvmAddress, amount).
    expect(calldata.is_some).toBe(true);
    expect(calldata.value.selector).toEqual(ERC20_TRANSFER_SELECTOR);
    expect(calldata.value.noWords).toBe(2n);
    expect(calldata.value.words).toHaveLength(2);
    expect(calldata.value.words[0]).toEqual(evmAddressAbiWord(DEST_EVM));
    expect(calldata.value.words[1]).toEqual(numericAbiWord(AMOUNT));

    expect(idHex).toBe(requestIdHex(calculateRequestId(record)));

    const { entry, lastSeen } = ledger(state).outputRequestBuffer.lookup(outKey);
    expect(entry).toEqual({
      action: Action.withdraw,
      nonceIsVault: true,
      evmNonce: 0n,
      inIndex: VALID_WITHDRAW.inIndex,
      commitment: pureCircuits.ownershipCommitment(VALID_WITHDRAW.inIndex, SECRET_KEY),
      argsHash: expect.any(Uint8Array) as Uint8Array,
    });
    expect(lastSeen).toBe(EVM_START_HEIGHT);
    expect(ledger(state).withdrawArgsMap.lookup(VALID_WITHDRAW.inIndex)).toEqual({
      request: VALID_WITHDRAW.withdraw,
      gas: DEFAULT_VAULT_GAS,
    });
    expect(ledger(state).evictionMap.lookup(requestIdBytes(idHex))).toEqual(outKey);
    expect(ledger(state).inputRequestBuffer.isEmpty()).toBe(true);
    expect(ledger(state).globalEvmNonce).toBe(1n);
  });

  it("start burns the surrendered coin: received by the vault, then paid in full to the burn address", async () => {
    const { contract, ctx } = await deployInitialised();

    const started = (await queueWithdraw(contract, ctx, VALID_WITHDRAW)).context;
    const zswap = zswapState(started);

    // The receive output's coin info must equal the spent coin's exactly: that
    // identity lets the transaction builder pair the two into a same-transaction
    // transient.
    expect(zswap.inputs).toHaveLength(1);
    const consumed = first(zswap.inputs, "consumed coin");
    expect(consumed.color).toEqual(VAULT_TOKEN_COLOR);
    expect(consumed.value).toBe(AMOUNT);

    expect(zswap.outputs).toHaveLength(2);
    const received = first(
      zswap.outputs.filter((output) => !output.recipient.is_left),
      "contract-owned receive output",
    );
    expect(received.recipient.right.bytes).toEqual(VAULT_ADDRESS_BYTES);
    expect(received.coinInfo).toEqual({
      nonce: consumed.nonce,
      color: consumed.color,
      value: consumed.value,
    });
    const burnOutput = first(
      zswap.outputs.filter((output) => output.recipient.is_left),
      "burn output",
    );
    expect(burnOutput.coinInfo.color).toEqual(VAULT_TOKEN_COLOR);
    expect(burnOutput.coinInfo.value).toBe(AMOUNT);
    expect(burnOutput.recipient.left.bytes).toEqual(BURN_ADDRESS_BYTES);
  });

  it("withdrawals across DIFFERENT ERC20 colours both land, at consecutive vault nonces", async () => {
    const { contract, ctx } = await deployInitialised();
    const otherErc20 = bytes(20, 0xab);
    const otherColor = hexToBytes(
      rawTokenType(pureCircuits.vaultTokenDomainSeparator(otherErc20), VAULT_ADDRESS),
    );

    const afterFirst = (await withdraw(contract, ctx, VALID_WITHDRAW)).context;
    const afterSecond = (
      await withdraw(contract, afterFirst, {
        inIndex: VALID_WITHDRAW.inIndex + 1n,
        withdraw: { erc20Address: otherErc20, amount: AMOUNT, destEvmAddress: DEST_EVM },
        coin: vaultCoin(AMOUNT, otherColor),
      })
    ).context;

    const index = toSignBidirectionalEventIndex(ledgerOf(afterSecond).bidirectionalWithdrawMap);
    expect([...index.values()].map(({ txParams }) => [txParams.to, txParams.nonce]).sort()).toEqual(
      [
        [ERC20, 0n],
        [otherErc20, 1n],
      ],
    );
    expect(ledgerOf(afterSecond).withdrawArgsMap.size()).toBe(2n);
  });
});

describe("vault nonces", () => {
  it("initialise leaves the vault nonce at 0", async () => {
    const { ctx } = await deployInitialised();
    expect(ledgerOf(ctx).globalEvmNonce).toBe(0n);
  });

  it("one flush assigns two identical withdrawals nonces 0 and 1 in slot order, and both move", async () => {
    const { contract, ctx } = await deployInitialised();
    const second = { ...VALID_WITHDRAW, inIndex: VALID_WITHDRAW.inIndex + 1n };
    const queuedFirst = (await queueWithdraw(contract, ctx, VALID_WITHDRAW)).context;
    const queuedBoth = (await queueWithdraw(contract, queuedFirst, second)).context;

    const flushed = await flush(contract, queuedBoth, [second.inIndex, VALID_WITHDRAW.inIndex], []);

    const state = ledgerOf(flushed);
    const nonceOf = (inIndex: bigint) =>
      state.outputRequestBuffer.lookup(flushedRequestKey(state, Action.withdraw, inIndex)).entry
        .evmNonce;
    expect(nonceOf(second.inIndex)).toBe(0n);
    expect(nonceOf(VALID_WITHDRAW.inIndex)).toBe(1n);
    expect(state.inputRequestBuffer.isEmpty()).toBe(true);
    expect(state.outputRequestBuffer.size()).toBe(2n);
    expect(state.globalEvmNonce).toBe(2n);
  });

  it("a deposit slot leaves the vault nonce unchanged and keeps the depositor's own nonce", async () => {
    const { contract, ctx } = await deployInitialised();
    const ownNonce = { ...VALID_DEPOSIT, evmNonce: 5n };
    const queued = (await queueDeposit(contract, ctx, ownNonce)).context;
    const outKey = queuedRequestKey(ledgerOf(queued), ownNonce.inIndex);

    const flushed = await flush(contract, queued, [ownNonce.inIndex], []);

    expect(ledgerOf(flushed).outputRequestBuffer.lookup(outKey).entry.evmNonce).toBe(5n);
    expect(ledgerOf(flushed).globalEvmNonce).toBe(0n);
  });

  it("a skipped slot burns no nonce: the withdrawal behind a missing index still gets nonce 0", async () => {
    const { contract, ctx } = await deployInitialised();
    const queued = (await queueWithdraw(contract, ctx, VALID_WITHDRAW)).context;
    const missingIndex = 999n;

    const skippedOnly = await flush(contract, queued, [missingIndex], []);
    expect(ledgerOf(skippedOnly).globalEvmNonce).toBe(0n);
    expect(ledgerOf(skippedOnly).inputRequestBuffer.member(VALID_WITHDRAW.inIndex)).toBe(true);

    const flushed = await flush(contract, queued, [missingIndex, VALID_WITHDRAW.inIndex], []);
    const state = ledgerOf(flushed);
    const outKey = flushedRequestKey(state, Action.withdraw, VALID_WITHDRAW.inIndex);
    expect(state.outputRequestBuffer.lookup(outKey).entry.evmNonce).toBe(0n);
    expect(state.globalEvmNonce).toBe(1n);
  });

  it("queuedRequestKey refuses a vault-signed request, whose key waits on its flush", async () => {
    const { contract, ctx } = await deployInitialised();
    const queued = (await queueWithdraw(contract, ctx, VALID_WITHDRAW)).context;
    expect(() => queuedRequestKey(ledgerOf(queued), VALID_WITHDRAW.inIndex)).toThrow(
      /vault-signed/,
    );
  });
});

/** One row of the withdraw rejection table: full inputs to expected error. */
interface WithdrawRejectionCase {
  /** Test name, completing the sentence "rejects <name>". */
  name: string;
  /** Complete call args passed to startWithdraw. */
  args: WithdrawCallArgs;
  /** Error startWithdraw must throw. */
  throws: RegExp;
}

const WITHDRAW_REJECTION_CASES: WithdrawRejectionCase[] = [
  {
    name: "a zero ERC20 address",
    args: {
      ...VALID_WITHDRAW,
      withdraw: { erc20Address: ZERO_ADDRESS, amount: AMOUNT, destEvmAddress: DEST_EVM },
    },
    throws: /ERC20 address cannot be zero/,
  },
  {
    name: "a zero destination address",
    args: {
      ...VALID_WITHDRAW,
      withdraw: { erc20Address: ERC20, amount: AMOUNT, destEvmAddress: ZERO_ADDRESS },
    },
    throws: /Destination address cannot be zero/,
  },
  {
    name: "a zero amount",
    args: {
      ...VALID_WITHDRAW,
      withdraw: { erc20Address: ERC20, amount: 0n, destEvmAddress: DEST_EVM },
      coin: vaultCoin(0n),
    },
    throws: /Amount must be positive/,
  },
  {
    name: "an amount above Uint<64> max (unrefundable)",
    args: {
      ...VALID_WITHDRAW,
      withdraw: { erc20Address: ERC20, amount: UINT64_MAX + 1n, destEvmAddress: DEST_EVM },
      coin: vaultCoin(UINT64_MAX + 1n),
    },
    throws: /Amount exceeds Uint<64> max/,
  },
  {
    name: "a coin that is not the vault token for this ERC20",
    args: { ...VALID_WITHDRAW, coin: vaultCoin(AMOUNT, bytes(32, 0x99)) },
    throws: /Coin is not the vault token for this ERC20/,
  },
  {
    name: "a coin whose value differs from the withdraw amount",
    args: { ...VALID_WITHDRAW, coin: vaultCoin(AMOUNT - 1n) },
    throws: /Coin value must equal the withdraw amount/,
  },
];

describe("withdraw validation", () => {
  it.each(WITHDRAW_REJECTION_CASES)("rejects $name", async ({ args, throws }) => {
    const { contract, ctx } = await deployInitialised();
    await expect(queueWithdraw(contract, ctx, args)).rejects.toThrow(throws);
  });

  it("rejects before initialise", async () => {
    const { contract, ctx } = await deployContract();
    await expect(queueWithdraw(contract, ctx, VALID_WITHDRAW)).rejects.toThrow(/Not initialised/);
  });

  it("rejects an index the input buffer holds", async () => {
    const { contract, ctx } = await deployInitialised();
    const queued = (await queueWithdraw(contract, ctx, VALID_WITHDRAW)).context;
    await expect(queueWithdraw(contract, queued, VALID_WITHDRAW)).rejects.toThrow(
      /Index already in use/,
    );
  });

  it("rejects an index the flush freed while its args stay in withdrawArgsMap", async () => {
    const { contract, ctx } = await deployInitialised();
    const queued = (await queueWithdraw(contract, ctx, VALID_WITHDRAW)).context;
    const flushed = await flush(contract, queued, [VALID_WITHDRAW.inIndex], []);
    expect(ledgerOf(flushed).inputRequestBuffer.member(VALID_WITHDRAW.inIndex)).toBe(false);
    await expect(queueWithdraw(contract, flushed, VALID_WITHDRAW)).rejects.toThrow(
      /Index already in use/,
    );
  });
});

describe("sendWithdraw", () => {
  it("is permissionless: a stranger sends the withdrawer's request as queued", async () => {
    const { contract, ctx } = await deployInitialised();
    const queued = (await queueWithdraw(contract, ctx, VALID_WITHDRAW)).context;
    const flushed = await flush(contract, queued, [VALID_WITHDRAW.inIndex], []);
    const outKey = flushedRequestKey(ledgerOf(flushed), Action.withdraw, VALID_WITHDRAW.inIndex);

    const sent = (
      await contract.circuits.sendWithdraw(await strangerContext("sendWithdraw", flushed), outKey)
    ).context;
    const index = toSignBidirectionalEventIndex(ledgerOf(sent).bidirectionalWithdrawMap);
    expect(index.size).toBe(1);
    const record = first(index.values(), "withdraw request");
    expect(record.path).toEqual(asciiPadded("vault", 32));
    expect(record.txParams.nonce).toBe(0n);
  });

  it("rejects a key the flush has not moved", async () => {
    const { contract, ctx } = await deployInitialised();
    const queued = (await queueWithdraw(contract, ctx, VALID_WITHDRAW)).context;
    await expect(contract.circuits.sendWithdraw(queued, bytes(32, 0x5a))).rejects.toThrow(
      /Request not flushed/,
    );
  });

  it("rejects a second send of the same request", async () => {
    const { contract, ctx } = await deployInitialised();
    const { context: sent, outKey } = await withdraw(contract, ctx, VALID_WITHDRAW);
    await expect(contract.circuits.sendWithdraw(sent, outKey)).rejects.toThrow(
      /Request already sent/,
    );
  });

  it("rejects a flushed deposit's key, and sendDeposit rejects a flushed withdrawal's", async () => {
    const { contract, ctx } = await deployInitialised();
    const queuedDeposit = (await queueDeposit(contract, ctx, VALID_DEPOSIT)).context;
    const depositKey = queuedRequestKey(ledgerOf(queuedDeposit), VALID_DEPOSIT.inIndex);
    const queuedBoth = (await queueWithdraw(contract, queuedDeposit, VALID_WITHDRAW)).context;
    const flushed = await flush(
      contract,
      queuedBoth,
      [VALID_DEPOSIT.inIndex, VALID_WITHDRAW.inIndex],
      [],
    );
    const withdrawKey = flushedRequestKey(
      ledgerOf(flushed),
      Action.withdraw,
      VALID_WITHDRAW.inIndex,
    );

    await expect(contract.circuits.sendWithdraw(flushed, depositKey)).rejects.toThrow(
      /Wrong action/,
    );
    await expect(contract.circuits.sendDeposit(flushed, withdrawKey)).rejects.toThrow(
      /Wrong action/,
    );
  });
});

/**
 * Deploy + initialise + withdraw(VALID_WITHDRAW): the arrange step of every
 * complete-withdraw test. Returns the sent withdrawal's request id (the single
 * withdraw map key) alongside the threaded context.
 */
const withdrawRequested = async () => {
  const { contract, ctx } = await deployInitialised();
  const { context: next } = await withdraw(contract, ctx, VALID_WITHDRAW);
  const index = toSignBidirectionalEventIndex(ledgerOf(next).bidirectionalWithdrawMap);
  const idHex = first(index.keys(), "withdraw request id");
  return { contract, ctx: next, requestId: requestIdBytes(idHex) };
};

/** Queue a 0-byte (failure) attestation and flush it: the arrange step before a settle. */
const attestFailure = async (
  contract: Contract<VaultPrivateState>,
  ctx: CircuitContext<VaultPrivateState>,
  attestation: RespondBidirectionalEvent,
): Promise<CircuitContext<VaultPrivateState>> => {
  const queued = (await contract.circuits.queueAttestation0(ctx, attestation, OUTPUT_EMPTY))
    .context;
  return flush(contract, queued, [], [attestation.requestId]);
};

/** The shielded mints a circuit run requested, as [token, amount] pairs. */
const shieldedMintsOf = (ctx: CircuitContext<VaultPrivateState>): [string, bigint][] => [
  ...ctx.callContext.currentQueryContext.effects.shieldedMints.entries(),
];

// The mint key completeWithdraw re-mints the surrendered ERC20's vault token under.
const VAULT_TOKEN_MINT_KEY = bytesToHex(pureCircuits.vaultTokenDomainSeparator(ERC20));

/** Arrange a flushed attestation of the given verdict for the requested withdrawal. */
interface WithdrawVerdictCase {
  /** Test name, completing the sentence "<name> and consumes the request". */
  name: string;
  /** The verdict the MPC attests. */
  outputKind: OutputKind;
  /** The output the MPC signs (empty under a failure kind). */
  signedOutput: Uint8Array;
  /** The output completeWithdraw is passed. */
  presentedOutput: Uint8Array;
  /** The mints completeWithdraw must request. */
  mints: [string, bigint][];
}

const WITHDRAW_VERDICT_CASES: WithdrawVerdictCase[] = [
  {
    name: "a transfer that returned true keeps the burn: mints nothing",
    outputKind: OutputKind.executed,
    signedOutput: OUTPUT_SUCCESS,
    presentedOutput: OUTPUT_SUCCESS,
    mints: [],
  },
  {
    name: "a transfer that returned false re-mints the surrendered amount",
    outputKind: OutputKind.executed,
    signedOutput: OUTPUT_FALSE,
    presentedOutput: OUTPUT_FALSE,
    mints: [[VAULT_TOKEN_MINT_KEY, AMOUNT]],
  },
  {
    name: "a reverted transfer (failed) re-mints the surrendered amount",
    outputKind: OutputKind.failed,
    signedOutput: OUTPUT_EMPTY,
    presentedOutput: OUTPUT_IGNORED,
    mints: [[VAULT_TOKEN_MINT_KEY, AMOUNT]],
  },
  {
    name: "a transfer whose nonce another transaction took (unviable) re-mints the surrendered amount",
    outputKind: OutputKind.unviable,
    signedOutput: OUTPUT_EMPTY,
    presentedOutput: OUTPUT_IGNORED,
    mints: [[VAULT_TOKEN_MINT_KEY, AMOUNT]],
  },
];

describe("completeWithdraw settle", () => {
  it.each(WITHDRAW_VERDICT_CASES)(
    "$name and consumes the request",
    async ({ outputKind, signedOutput, presentedOutput, mints }) => {
      const { contract, ctx, requestId } = await withdrawRequested();
      const attestation = respond(
        MPC_RESPONSE_SECRET,
        requestId,
        outputKind,
        signedOutput,
        ATTESTED_HEIGHT,
      );
      const attested =
        outputKind === OutputKind.executed
          ? await attest(contract, ctx, attestation, signedOutput)
          : await attestFailure(contract, ctx, attestation);

      const next = (
        await contract.circuits.completeWithdraw(attested, requestId, presentedOutput, MINT_NONCE)
      ).context;

      expect(shieldedMintsOf(next)).toEqual(mints);
      const state = ledgerOf(next);
      expect(state.bidirectionalWithdrawMap.isEmpty()).toBe(true);
      expect(state.withdrawArgsMap.isEmpty()).toBe(true);
      expect(state.outputRequestBuffer.isEmpty()).toBe(true);
      expect(state.outputAttestationBuffer.isEmpty()).toBe(true);
      expect(state.evictionMap.isEmpty()).toBe(true);
    },
  );

  it.each(WITHDRAW_VERDICT_CASES)(
    "rejects a caller other than the withdrawer when $name",
    async ({ outputKind, signedOutput, presentedOutput }) => {
      const { contract, ctx, requestId } = await withdrawRequested();
      const attestation = respond(
        MPC_RESPONSE_SECRET,
        requestId,
        outputKind,
        signedOutput,
        ATTESTED_HEIGHT,
      );
      const attested =
        outputKind === OutputKind.executed
          ? await attest(contract, ctx, attestation, signedOutput)
          : await attestFailure(contract, ctx, attestation);

      await expect(
        contract.circuits.completeWithdraw(
          await strangerContext("completeWithdraw", attested),
          requestId,
          presentedOutput,
          MINT_NONCE,
        ),
      ).rejects.toThrow(/Not the requester/);
    },
  );

  it("rejects a false output presented for a transfer attested as returning true", async () => {
    // Presenting the false byte would re-mint tokens that already left the vault.
    const { contract, ctx, requestId } = await withdrawRequested();
    const attested = await attest(
      contract,
      ctx,
      respond(MPC_RESPONSE_SECRET, requestId, OutputKind.executed, OUTPUT_SUCCESS, ATTESTED_HEIGHT),
      OUTPUT_SUCCESS,
    );
    await expect(
      contract.circuits.completeWithdraw(attested, requestId, OUTPUT_FALSE, MINT_NONCE),
    ).rejects.toThrow(/Output does not match the attestation/);
  });

  it.each([
    { name: "queueAttestation1", outputKind: OutputKind.executed, output: OUTPUT_SUCCESS },
    { name: "queueAttestation0", outputKind: OutputKind.failed, output: OUTPUT_EMPTY },
  ])(
    "$name refuses an attestation at or below the withdrawal's lastSeen",
    async ({ outputKind, output }) => {
      const { contract, ctx, requestId } = await withdrawRequested();
      const attestation = respond(
        MPC_RESPONSE_SECRET,
        requestId,
        outputKind,
        output,
        EVM_START_HEIGHT,
      );
      await expect(
        outputKind === OutputKind.executed
          ? contract.circuits.queueAttestation1(ctx, attestation, output)
          : contract.circuits.queueAttestation0(ctx, attestation, output),
      ).rejects.toThrow(/Stale attestation/);
    },
  );

  it("settles once: a second completeWithdraw for the same request rejects", async () => {
    const { contract, ctx, requestId } = await withdrawRequested();
    const attested = await attestFailure(
      contract,
      ctx,
      respond(MPC_RESPONSE_SECRET, requestId, OutputKind.failed, OUTPUT_EMPTY, ATTESTED_HEIGHT),
    );
    const next = (
      await contract.circuits.completeWithdraw(attested, requestId, OUTPUT_IGNORED, MINT_NONCE)
    ).context;
    await expect(
      contract.circuits.completeWithdraw(next, requestId, OUTPUT_IGNORED, MINT_NONCE),
    ).rejects.toThrow(/Request not sent/);
  });
});

describe("cross-action settle isolation", () => {
  it("completeWithdraw rejects a deposit's request id, and completeDeposit a withdrawal's", async () => {
    const { contract, ctx, requestId: depositId } = await depositRequested();
    const { context: withdrawn } = await withdraw(contract, ctx, VALID_WITHDRAW);
    const withdrawId = requestIdBytes(
      first(
        toSignBidirectionalEventIndex(ledgerOf(withdrawn).bidirectionalWithdrawMap).keys(),
        "withdraw request id",
      ),
    );
    const depositQueued = (
      await contract.circuits.queueAttestation1(
        withdrawn,
        respond(
          MPC_RESPONSE_SECRET,
          depositId,
          OutputKind.executed,
          OUTPUT_SUCCESS,
          ATTESTED_HEIGHT,
        ),
        OUTPUT_SUCCESS,
      )
    ).context;
    const bothQueued = (
      await contract.circuits.queueAttestation1(
        depositQueued,
        respond(
          MPC_RESPONSE_SECRET,
          withdrawId,
          OutputKind.executed,
          OUTPUT_SUCCESS,
          ATTESTED_HEIGHT,
        ),
        OUTPUT_SUCCESS,
      )
    ).context;
    const attested = await flush(contract, bothQueued, [], [depositId, withdrawId]);

    await expect(
      contract.circuits.completeWithdraw(attested, depositId, OUTPUT_SUCCESS, MINT_NONCE),
    ).rejects.toThrow(/Wrong action/);
    await expect(
      contract.circuits.completeDeposit(
        attested,
        withdrawId,
        OUTPUT_SUCCESS,
        MINT_NONCE,
        CALLER_RECIPIENT,
      ),
    ).rejects.toThrow(/Wrong action/);
  });
});

interface VaultCall {
  contractAddress: string;
  publicTranscript: unknown;
  initialQueryContext: { block: unknown; state: unknown };
  finalQueryContext: { effects: unknown };
}
const vaultCallOf = (run: { context: CircuitContext<VaultPrivateState> }): VaultCall => {
  const trace = run.context.callProofDataTrace as unknown as VaultCall[];
  for (let i = trace.length - 1; i >= 0; i--) {
    const call = trace[i];
    if (call?.contractAddress === VAULT_ADDRESS) return call;
  }
  throw new Error("no vault call in the proof-data trace");
};
const gasOf = (run: { context: CircuitContext<VaultPrivateState> }): Record<string, unknown> => {
  const gas = (run.context.gasCosts as Record<string, Record<string, unknown> | undefined>)[
    VAULT_ADDRESS
  ];
  if (!gas) throw new Error("no vault gas cost on the run");
  return gas;
};

const withHeadroom = (gas: Record<string, unknown>): Record<string, unknown> =>
  Object.fromEntries(Object.entries(gas).map(([k, v]) => [k, typeof v === "bigint" ? v * 8n : v]));

const replay = (
  state: unknown,
  run: { context: CircuitContext<VaultPrivateState> },
  headroom = false,
): string => {
  const call = vaultCallOf(run);
  const qc = new QueryContext(state as never, VAULT_ADDRESS);
  (qc as unknown as { block: unknown }).block = call.initialQueryContext.block;
  const gas = gasOf(run);
  const transcript = {
    gas: headroom ? withHeadroom(gas) : gas,
    effects: call.finalQueryContext.effects,
    program: call.publicTranscript,
  };
  try {
    qc.runTranscript(transcript as never, CostModel.initialCostModel());
    return "applied";
  } catch (e) {
    return "REJECTED: " + String((e as { message?: string }).message ?? e).slice(0, 160);
  }
};

describe("throughput: requests never pin shared state, only the flush does", () => {
  it("CONTROL: a queued deposit applies against the state it was built on", async () => {
    const { contract, ctx } = await deployInitialised();
    const builtOn = stateOf(ctx);
    const run = await queueDeposit(contract, ctx, VALID_DEPOSIT);
    expect(replay(builtOn, run)).toBe("applied");
  });

  it("two concurrent startDeposits from different callers both apply", async () => {
    const { contract, ctx } = await deployInitialised();
    const alice = await queueDeposit(contract, ctx, VALID_DEPOSIT);
    const stateAfterAlice = alice.context.callContext.currentQueryContext.state;
    const bobCtx = await strangerContext("startDeposit", ctx);
    const bob = await queueDeposit(contract, bobCtx, { ...VALID_DEPOSIT, inIndex: 2n });
    expect(replay(stateAfterAlice, bob, true)).toBe("applied");
  });

  it("a flush skips an identical repeat and still moves the rest of its batch", async () => {
    const { contract, ctx } = await deployInitialised();
    const afterFirst = (await deposit(contract, ctx, VALID_DEPOSIT)).context;
    const repeat = { ...VALID_DEPOSIT, inIndex: 2n };
    const other = { ...VALID_DEPOSIT, inIndex: 3n, evmNonce: VALID_DEPOSIT.evmNonce + 1n };
    const queuedRepeat = (await queueDeposit(contract, afterFirst, repeat)).context;
    const queuedBoth = (await queueDeposit(contract, queuedRepeat, other)).context;
    const otherKey = queuedRequestKey(ledgerOf(queuedBoth), other.inIndex);

    const flushed = await flush(contract, queuedBoth, [repeat.inIndex, other.inIndex], []);

    expect(ledgerOf(flushed).inputRequestBuffer.member(repeat.inIndex)).toBe(true);
    expect(ledgerOf(flushed).inputRequestBuffer.member(other.inIndex)).toBe(false);
    expect(ledgerOf(flushed).outputRequestBuffer.member(otherKey)).toBe(true);
  });

  it("two concurrent startWithdraws from different callers both apply", async () => {
    const { contract, ctx } = await deployInitialised();
    const alice = await queueWithdraw(contract, ctx, VALID_WITHDRAW);
    const stateAfterAlice = stateOf(alice.context);
    const bobCtx = await strangerContext("startWithdraw", ctx);
    const bob = await queueWithdraw(contract, bobCtx, {
      ...VALID_WITHDRAW,
      inIndex: VALID_WITHDRAW.inIndex + 1n,
    });
    expect(replay(stateAfterAlice, bob, true)).toBe("applied");
  });

  it("a deposit-only flush applies after a concurrent flush moved the vault nonce", async () => {
    const { contract, ctx } = await deployInitialised();
    const queuedDeposit = (await queueDeposit(contract, ctx, VALID_DEPOSIT)).context;
    const queuedBoth = (await queueWithdraw(contract, queuedDeposit, VALID_WITHDRAW)).context;
    const withdrawFlush = await contract.circuits.flushQueue(
      queuedBoth,
      flushSlots([VALID_WITHDRAW.inIndex], []),
    );
    const depositFlush = await contract.circuits.flushQueue(
      queuedBoth,
      flushSlots([VALID_DEPOSIT.inIndex], []),
    );
    expect(ledgerOf(withdrawFlush.context).globalEvmNonce).toBe(1n);
    expect(replay(stateOf(withdrawFlush.context), depositFlush, true)).toBe("applied");
  });

  it("two flushes that each move a withdrawal conflict on the vault nonce", async () => {
    const { contract, ctx } = await deployInitialised();
    const second = { ...VALID_WITHDRAW, inIndex: VALID_WITHDRAW.inIndex + 1n };
    const queuedFirst = (await queueWithdraw(contract, ctx, VALID_WITHDRAW)).context;
    const queuedBoth = (await queueWithdraw(contract, queuedFirst, second)).context;
    const firstFlush = await contract.circuits.flushQueue(
      queuedBoth,
      flushSlots([VALID_WITHDRAW.inIndex], []),
    );
    const secondFlush = await contract.circuits.flushQueue(
      queuedBoth,
      flushSlots([second.inIndex], []),
    );
    expect(replay(stateOf(firstFlush.context), secondFlush, true)).toMatch(/^REJECTED/);
  });
});

const DEFAULT_MAX_FEE_PER_GAS = 150_000_000_000n;
const DEFAULT_MAX_PRIORITY_FEE_PER_GAS = 1_000_000_000n;
const DEFAULT_WITHDRAW_GAS_LIMIT = 100_000n;
const DEFAULT_APPROVE_GAS_LIMIT = 100_000n;
const DEFAULT_SWAP_GAS_LIMIT = 700_000n;
const DEFAULT_SUPPLY_GAS_LIMIT = 500_000n;
const DEFAULT_REDEEM_GAS_LIMIT = 500_000n;

const NEW_MAX_FEE_PER_GAS = 750_000_000_000n;
const NEW_MAX_PRIORITY_FEE_PER_GAS = 3_000_000_000n;
const NEW_WITHDRAW_GAS_LIMIT = 111_000n;
const NEW_APPROVE_GAS_LIMIT = 122_000n;
const NEW_SWAP_GAS_LIMIT = 733_000n;
const NEW_SUPPLY_GAS_LIMIT = 544_000n;
const NEW_REDEEM_GAS_LIMIT = 555_000n;

interface GasParamArgs {
  maxFeePerGas: bigint;
  maxPriorityFeePerGas: bigint;
  withdrawGasLimit: bigint;
  approveGasLimit: bigint;
  swapGasLimit: bigint;
  supplyGasLimit: bigint;
  redeemGasLimit: bigint;
}

const NEW_GAS_PARAMS: GasParamArgs = {
  maxFeePerGas: NEW_MAX_FEE_PER_GAS,
  maxPriorityFeePerGas: NEW_MAX_PRIORITY_FEE_PER_GAS,
  withdrawGasLimit: NEW_WITHDRAW_GAS_LIMIT,
  approveGasLimit: NEW_APPROVE_GAS_LIMIT,
  swapGasLimit: NEW_SWAP_GAS_LIMIT,
  supplyGasLimit: NEW_SUPPLY_GAS_LIMIT,
  redeemGasLimit: NEW_REDEEM_GAS_LIMIT,
};

const setGasParams = (
  contract: Contract<VaultPrivateState>,
  ctx: Parameters<Contract<VaultPrivateState>["circuits"]["setGasParams"]>[0],
  args: GasParamArgs,
) =>
  contract.circuits.setGasParams(
    ctx,
    args.maxFeePerGas,
    args.maxPriorityFeePerGas,
    args.withdrawGasLimit,
    args.approveGasLimit,
    args.swapGasLimit,
    args.supplyGasLimit,
    args.redeemGasLimit,
  );

const envelopeOf = (
  map: Parameters<typeof toSignBidirectionalEventIndex>[0],
): { maxFeePerGas: bigint; maxPriorityFeePerGas: bigint; gasLimit: bigint } => {
  const index = toSignBidirectionalEventIndex(map);
  expect(index.size).toBe(1);
  const { txParams } = first(index.values(), "recorded request");
  return {
    maxFeePerGas: txParams.maxFeePerGas,
    maxPriorityFeePerGas: txParams.maxPriorityFeePerGas,
    gasLimit: txParams.gasLimit,
  };
};

describe("gas parameters: initialise defaults", () => {
  it("stores a fee ceiling and a gas limit per kind", async () => {
    const { ctx } = await deployInitialised();
    const state = ledger(ctx.callContext.currentQueryContext.state);

    expect(state.vaultMaxFeePerGas).toBe(DEFAULT_MAX_FEE_PER_GAS);
    expect(state.vaultMaxPriorityFeePerGas).toBe(DEFAULT_MAX_PRIORITY_FEE_PER_GAS);
    expect(state.vaultGasLimits.withdraw).toBe(DEFAULT_WITHDRAW_GAS_LIMIT);
    expect(state.vaultGasLimits.approve).toBe(DEFAULT_APPROVE_GAS_LIMIT);
    expect(state.vaultGasLimits.swap).toBe(DEFAULT_SWAP_GAS_LIMIT);
    expect(state.vaultGasLimits.supply).toBe(DEFAULT_SUPPLY_GAS_LIMIT);
    expect(state.vaultGasLimits.redeem).toBe(DEFAULT_REDEEM_GAS_LIMIT);
  });

  it("the default cap clears the highest base fee of the last year", async () => {
    const { ctx } = await deployInitialised();
    const state = ledger(ctx.callContext.currentQueryContext.state);

    expect(state.vaultMaxFeePerGas).toBeGreaterThan(100_000_000_000n);
    expect(state.vaultMaxFeePerGas * state.vaultGasLimits.swap).toBeLessThan(10n ** 18n);
  });

  it("the cap is at or above the tip, as EIP-1559 requires", async () => {
    const { ctx } = await deployInitialised();
    const state = ledger(ctx.callContext.currentQueryContext.state);

    expect(state.vaultMaxFeePerGas).toBeGreaterThanOrEqual(state.vaultMaxPriorityFeePerGas);
  });
});

describe("setGasParams", () => {
  it("is deployer-gated", async () => {
    const { contract, ctx } = await deployInitialised();
    const stranger = await strangerContext("setGasParams", ctx);

    await expect(setGasParams(contract, stranger, NEW_GAS_PARAMS)).rejects.toThrow(
      /Not the deployer/,
    );
  });

  it("leaves the stored values untouched when a non-deployer is rejected", async () => {
    const { contract, ctx } = await deployInitialised();
    const stranger = await strangerContext("setGasParams", ctx);

    await expect(setGasParams(contract, stranger, NEW_GAS_PARAMS)).rejects.toThrow();

    const state = ledger(ctx.callContext.currentQueryContext.state);
    expect(state.vaultMaxFeePerGas).toBe(DEFAULT_MAX_FEE_PER_GAS);
    expect(state.vaultGasLimits.swap).toBe(DEFAULT_SWAP_GAS_LIMIT);
  });

  it("rejects before initialise", async () => {
    const { contract, ctx } = await deployContract();

    await expect(setGasParams(contract, ctx, NEW_GAS_PARAMS)).rejects.toThrow(/Not initialised/);
  });

  it("the deployer updates every value", async () => {
    const { contract, ctx } = await deployInitialised();

    const next = (await setGasParams(contract, ctx, NEW_GAS_PARAMS)).context;
    const state = ledger(next.callContext.currentQueryContext.state);

    expect(state.vaultMaxFeePerGas).toBe(NEW_MAX_FEE_PER_GAS);
    expect(state.vaultMaxPriorityFeePerGas).toBe(NEW_MAX_PRIORITY_FEE_PER_GAS);
    expect(state.vaultGasLimits.withdraw).toBe(NEW_WITHDRAW_GAS_LIMIT);
    expect(state.vaultGasLimits.approve).toBe(NEW_APPROVE_GAS_LIMIT);
    expect(state.vaultGasLimits.swap).toBe(NEW_SWAP_GAS_LIMIT);
    expect(state.vaultGasLimits.supply).toBe(NEW_SUPPLY_GAS_LIMIT);
    expect(state.vaultGasLimits.redeem).toBe(NEW_REDEEM_GAS_LIMIT);
  });

  it("is repeatable: the fee envelope tracks the market, unlike one-shot initialise", async () => {
    const { contract, ctx } = await deployInitialised();

    const once = (await setGasParams(contract, ctx, NEW_GAS_PARAMS)).context;
    const twice = (
      await setGasParams(contract, once, { ...NEW_GAS_PARAMS, maxFeePerGas: 900_000_000_000n })
    ).context;

    expect(ledger(twice.callContext.currentQueryContext.state).vaultMaxFeePerGas).toBe(
      900_000_000_000n,
    );
  });

  it.each([
    ["a zero withdraw gas limit", { withdrawGasLimit: 0n }, /Gas limit must be positive/],
    ["a zero approve gas limit", { approveGasLimit: 0n }, /Gas limit must be positive/],
    ["a zero swap gas limit", { swapGasLimit: 0n }, /Gas limit must be positive/],
    ["a zero supply gas limit", { supplyGasLimit: 0n }, /Gas limit must be positive/],
    ["a zero redeem gas limit", { redeemGasLimit: 0n }, /Gas limit must be positive/],
    ["a zero fee cap", { maxFeePerGas: 0n }, /maxFeePerGas must be positive/],
    [
      "a tip above the cap",
      { maxFeePerGas: 1_000_000_000n, maxPriorityFeePerGas: 2_000_000_000n },
      /maxPriorityFeePerGas cannot exceed maxFeePerGas/,
    ],
  ] as const)("rejects %s", async (_name, delta, throws) => {
    const { contract, ctx } = await deployInitialised();

    await expect(setGasParams(contract, ctx, { ...NEW_GAS_PARAMS, ...delta })).rejects.toThrow(
      throws,
    );
  });
});

describe("gas parameters reach the constructed transaction", () => {
  it("sendWithdraw carries the updated fee envelope and the WITHDRAW gas limit", async () => {
    const { contract, ctx } = await deployInitialised();
    const configured = (await setGasParams(contract, ctx, NEW_GAS_PARAMS)).context;

    const next = (await withdraw(contract, configured, VALID_WITHDRAW)).context;

    expect(envelopeOf(ledgerOf(next).bidirectionalWithdrawMap)).toEqual({
      maxFeePerGas: NEW_MAX_FEE_PER_GAS,
      maxPriorityFeePerGas: NEW_MAX_PRIORITY_FEE_PER_GAS,
      gasLimit: NEW_WITHDRAW_GAS_LIMIT,
    });
  });

  it("a withdrawal keeps the gas it was queued with when setGasParams runs before its send", async () => {
    const { contract, ctx } = await deployInitialised();
    const queued = (await queueWithdraw(contract, ctx, VALID_WITHDRAW)).context;
    const flushed = await flush(contract, queued, [VALID_WITHDRAW.inIndex], []);
    const outKey = flushedRequestKey(ledgerOf(flushed), Action.withdraw, VALID_WITHDRAW.inIndex);
    const reconfigured = (await setGasParams(contract, flushed, NEW_GAS_PARAMS)).context;

    const sent = (await contract.circuits.sendWithdraw(reconfigured, outKey)).context;

    expect(envelopeOf(ledgerOf(sent).bidirectionalWithdrawMap)).toEqual({
      maxFeePerGas: DEFAULT_MAX_FEE_PER_GAS,
      maxPriorityFeePerGas: DEFAULT_MAX_PRIORITY_FEE_PER_GAS,
      gasLimit: DEFAULT_WITHDRAW_GAS_LIMIT,
    });
  });

  it("sendDeposit is UNAFFECTED: the deposit carries the CALLER's own gas arguments", async () => {
    const { contract, ctx } = await deployInitialised();
    const configured = (await setGasParams(contract, ctx, NEW_GAS_PARAMS)).context;

    const next = (await deposit(contract, configured, VALID_DEPOSIT)).context;

    expect(envelopeOf(ledgerOf(next).bidirectionalDepositMap)).toEqual({
      maxFeePerGas: VALID_DEPOSIT.maxFeePerGas,
      maxPriorityFeePerGas: VALID_DEPOSIT.maxPriorityFeePerGas,
      gasLimit: VALID_DEPOSIT.gasLimit,
    });
  });
});

describe("attested block heights", () => {
  it("initialise seals the start height as the last seen height", async () => {
    const { ctx } = await deployInitialised();
    expect(ledgerOf(ctx).globalLastSeen).toBe(EVM_START_HEIGHT);
  });

  it("queueAttestation1 refuses an attestation at or below the request's lastSeen", async () => {
    const { contract, ctx, requestId } = await depositRequested();
    await expect(
      contract.circuits.queueAttestation1(
        ctx,
        respond(
          MPC_RESPONSE_SECRET,
          requestId,
          OutputKind.executed,
          OUTPUT_SUCCESS,
          EVM_START_HEIGHT,
        ),
        OUTPUT_SUCCESS,
      ),
    ).rejects.toThrow(/Stale attestation/);
  });

  it("flushing an attestation raises the last seen height to its block", async () => {
    const { contract, ctx, requestId } = await depositRequested();
    const settledAt = 150n;
    const attested = await attest(
      contract,
      ctx,
      respond(MPC_RESPONSE_SECRET, requestId, OutputKind.executed, OUTPUT_SUCCESS, settledAt),
      OUTPUT_SUCCESS,
    );
    expect(ledgerOf(attested).globalLastSeen).toBe(settledAt);
  });

  it("a re-issued deposit cannot reuse the attestation of its first execution", async () => {
    const { contract, ctx, requestId } = await depositRequested();
    const settledAt = 150n;
    const attestation = respond(
      MPC_RESPONSE_SECRET,
      requestId,
      OutputKind.executed,
      OUTPUT_SUCCESS,
      settledAt,
    );
    const attested = await attest(contract, ctx, attestation, OUTPUT_SUCCESS);
    const settled = (
      await contract.circuits.completeDeposit(
        attested,
        requestId,
        OUTPUT_SUCCESS,
        MINT_NONCE,
        CALLER_RECIPIENT,
      )
    ).context;

    const { context: reissued, outKey } = await deposit(contract, settled, VALID_DEPOSIT);
    expect(ledgerOf(reissued).evictionMap.lookup(requestId)).toEqual(outKey);
    expect(ledgerOf(reissued).outputRequestBuffer.lookup(outKey).lastSeen).toBe(settledAt);
    await expect(
      contract.circuits.queueAttestation1(reissued, attestation, OUTPUT_SUCCESS),
    ).rejects.toThrow(/Stale attestation/);
  });

  it.each([
    { name: "attestation slot first", order: [FlushChannel.attestation, FlushChannel.request] },
    { name: "repeat slot first", order: [FlushChannel.request, FlushChannel.attestation] },
  ])(
    "a repeat queued while the first is open waits for it to settle ($name) and cannot reuse its attestation",
    async ({ order }) => {
      const { contract, ctx, requestId } = await depositRequested();
      const repeat = { ...VALID_DEPOSIT, inIndex: 2n };
      const settledAt = 150n;
      const attestation = respond(
        MPC_RESPONSE_SECRET,
        requestId,
        OutputKind.executed,
        OUTPUT_SUCCESS,
        settledAt,
      );
      const queuedRepeat = (await queueDeposit(contract, ctx, repeat)).context;
      const queuedBoth = (
        await contract.circuits.queueAttestation1(queuedRepeat, attestation, OUTPUT_SUCCESS)
      ).context;
      // Whatever the slot order, the first request is still open, so the
      // repeat's slot is skipped and the repeat stays queued.
      const slotFor = (channel: FlushChannel) =>
        channel === FlushChannel.request
          ? { channel, inIndex: repeat.inIndex, requestId: new Uint8Array(32) }
          : { channel, inIndex: 0n, requestId };
      const slots = [...order.map(slotFor), ...flushSlots([], []).slice(order.length)];
      const oneFlush = (await contract.circuits.flushQueue(queuedBoth, slots)).context;
      expect(ledgerOf(oneFlush).inputRequestBuffer.member(repeat.inIndex)).toBe(true);
      expect(ledgerOf(oneFlush).globalLastSeen).toBe(settledAt);

      const settled = (
        await contract.circuits.completeDeposit(
          oneFlush,
          requestId,
          OUTPUT_SUCCESS,
          MINT_NONCE,
          CALLER_RECIPIENT,
        )
      ).context;
      const outKey = queuedRequestKey(ledgerOf(settled), repeat.inIndex);
      const flushed = await flush(contract, settled, [repeat.inIndex], []);
      expect(ledgerOf(flushed).outputRequestBuffer.lookup(outKey).lastSeen).toBe(settledAt);
      const resent = (await contract.circuits.sendDeposit(flushed, outKey)).context;
      await expect(
        contract.circuits.queueAttestation1(resent, attestation, OUTPUT_SUCCESS),
      ).rejects.toThrow(/Stale attestation/);
    },
  );

  it("sendDeposit is permissionless: a stranger sends the depositor's request as queued", async () => {
    const { contract, ctx } = await deployInitialised();
    const queued = (await queueDeposit(contract, ctx, VALID_DEPOSIT)).context;
    const outKey = queuedRequestKey(ledgerOf(queued), VALID_DEPOSIT.inIndex);
    const flushed = await flush(contract, queued, [VALID_DEPOSIT.inIndex], []);

    const sent = (
      await contract.circuits.sendDeposit(await strangerContext("sendDeposit", flushed), outKey)
    ).context;
    const index = toSignBidirectionalEventIndex(ledgerOf(sent).bidirectionalDepositMap);
    expect(index.size).toBe(1);
    const record = first(index.values(), "deposit request");
    expect(record.path).toEqual(DEPLOYER_COMMITMENT);
    expect(record.txParams.nonce).toBe(VALID_DEPOSIT.evmNonce);
  });
});
