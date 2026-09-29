# erc20-vault porting spec

This file is the complete brief for porting the erc20-vault's remaining actions
onto the new contention pattern. An agent picking up one task reads sections 1
to 4 in full, then does exactly one task from section 5, following the
workflow in section 6. Nothing in a previous conversation is assumed.

## Progress

The integrator ticks a box when that work is merged and its integration
criteria pass, noting the commit. Task agents never edit this list. The next
task is the first unticked one whose dependencies are ticked.

- [x] Deposit rebuilt on the flush pattern, unit, integration and e2e tests
      ported (`f28cffe`, `80624ce`, `ed73a12`)
- [x] Review fixes: false-returning deposits close, the SDK flush carries the
      caller's items and skips twins (`384392b`)
- [x] Pattern settled: gas at start, permissionless sends, per-action args
      maps, attestations keyed by request id, one complete per action
      (`fa0fcef`)
- [x] Deposit e2e green on the settled pattern (all 20 e2e tests, fresh vault
      `7ec6c4b6…0a436f`)
- [x] **P0** Vault nonces and withdraw (`7091e42`, all 46 e2e tests on a
      fresh vault, full-width flushes accepted: see 1.5)
- [ ] **P1a** Approvals (router and stata)
- [ ] **P1b** Nonce replacement
- [ ] **P2a** Swap
- [ ] **P2b** Supply
- [ ] **P3** Redeem
- [ ] **S1** Contract unit test sweep
- [ ] **S2** SDK flush tests
- [ ] **S3** Live concurrency and time budget
- [ ] **S4** Documentation sweep

## 1. Context

### 1.1 What is going on

The erc20-vault is a Midnight (Compact) contract that moves ERC20 value
between an EVM chain and shielded tokens on Midnight. The Signet MPC network
signs and executes the EVM side, then posts a signed attestation of the
outcome back to Midnight.

The vault was rebuilt around one contention rule: all state shared between
requests is read and written only by a permissionless `flushQueue` circuit,
and every other circuit touches only ledger keys belonging to its own request.
The rebuild started from scratch with deposit only. Deposit is finished and
green end to end. Your job is to port the other actions from the old contract
onto the new pattern, one action per task.

This is a new build. There is no deployed vault to stay compatible with, no
migration, and no old name, layout or behaviour to preserve.

### 1.2 Where things are

| What | Path |
| --- | --- |
| The branch everything lands on | `refactor-contention-handling`, cut from an earlier head of `align-with-protocol-spec` |
| The integrator's worktree for that branch | `/Users/bernard/Projects/github.com/sig-net/midnight-examples-refactor-contention-handling` |
| The primary checkout (read and create worktrees only, never edit) | `/Users/bernard/Projects/github.com/sig-net/midnight-examples` |
| The new contract | `examples/erc20-vault/contract/src/erc20-vault.compact` |
| The published SDK flush helpers | `examples/erc20-vault/contract/src/vault-queue.ts` |
| The SDK export surface, including ledger path constants | `examples/erc20-vault/contract/src/index.ts` |
| Ledger reads | `examples/erc20-vault/contract/src/vault-ledger.ts` |
| Contract unit tests | `examples/erc20-vault/contract/tests/erc20-vault.test.ts`, `ledger-paths.test.ts` |
| Integration flows (the TS that drives each action) | `examples/erc20-vault/integration-tests/src/flows/` |
| e2e specs, and their pinned run order | `examples/erc20-vault/integration-tests/tests/`, `integration-tests/vitest.config.ts` |
| The design doc for the pattern | `examples/erc20-vault/docs/contention-handling.md` |
| The OLD implementation, the source of truth for every action's behaviour | The live `align-with-protocol-spec` worktree on disc, read in place: `/Users/bernard/Projects/github.com/sig-net/midnight-examples-align-with-protocol-spec`. Read only, never edit it |
| The OLD contract | `<old worktree>/examples/erc20-vault/contract/src/erc20-vault.compact` |
| The OLD unit tests | `<old worktree>/examples/erc20-vault/contract/tests/erc20-vault.test.ts` |
| The OLD flows and e2e specs | `<old worktree>/examples/erc20-vault/integration-tests/src/flows/` and `<old worktree>/examples/erc20-vault/integration-tests/tests/` |

`<old worktree>` below always means that path. What is on disc there wins
over any commit, including one named elsewhere in this repo's history.

### 1.3 Read these first, in this order

1. `AGENTS.md` and `CLAUDE.md` at the repo root: workspace rules that apply
   to every change (pinned dependencies, no dead code, JSDoc on every export,
   a browser-safe contract package, table-driven tests, no emitted JS).
2. `examples/erc20-vault/docs/contention-handling.md`: the pattern, its
   invariants and its costs. It is current and describes the contract exactly.
3. `examples/erc20-vault/contract/src/erc20-vault.compact`, top to bottom. The
   Deposit section is the template every action copies.
4. `examples/erc20-vault/contract/src/vault-queue.ts`: how clients flush.
5. The deposit flows: `integration-tests/src/flows/start-deposit.ts`,
   `complete-deposit.ts`, `deposit-round-trip.ts`, `vault-queue.ts`.
6. `/Users/bernard/Projects/github.com/sig-net/midnight-examples-refactor-contention-handling/porting-packs/knowledge.md`,
   when it exists: how the current code, tests and flows fit together, as
   learned by the agents before you.
7. Your task's port pack,
   `/Users/bernard/Projects/github.com/sig-net/midnight-examples-refactor-contention-handling/porting-packs/<task>.md`
   (for example `P2a.md`). It holds the old contract's declarations for your
   action verbatim, and the exact line ranges of the old unit test blocks,
   flows and e2e specs to port. Read those ranges in the old worktree. Both
   files live only in the integrator's worktree and are read only. You may
   research beyond them whenever they leave a question open.

### 1.4 Toolchain and commands

- Compact toolchain `0.33.0-rc.2` (`compact update 0.33.0-rc.2`). The compile
  scripts pass `--feature-zkir-v3`, which is mandatory for this stack.
- Run `yarn install` from the repo root, never inside a member.
- `yarn compile` regenerates `src/managed/` without zk keys. It DELETES any
  existing `keys/`, so the deploy tests that need keys then skip.
- `yarn compile:erc20-vault:zk` generates the proving keys (about 10 minutes).
  Only the integrator needs it.
- The gate every change must pass, from the repo root:
  `yarn format:check && yarn lint && yarn build && yarn test`.
  `yarn lint` and `yarn build` read `src/managed/`, so compile first.
- Read each ledger field's compiled path with
  `python3 -c "import json;[print(f['name'],f['index']) for f in json.load(open('examples/erc20-vault/contract/src/managed/erc20-vault/compiler/contract-info.json'))['ledger']]"`.

### 1.5 Knowledge that lives nowhere else

These were learned the hard way while building deposit. Treat them as facts.

- **Why the flush runs in the fallible section (error 231).** The node refuses
  a transaction when proof checking plus the guaranteed section takes longer
  than `max(15 ms, 2 µs per byte)`: error 231, `FeeCalculation.OutsideTimeToDismiss`.
  midnight-js places a call's whole transcript in one section before the wallet
  adds its fee payment, which adds about 3.8 ms and 3.3 kB. So a small flush
  stayed in the guaranteed section and the fee pushed it over. `kernel.checkpoint()`
  does not compile under `--feature-zkir-v3`. The fix lives in
  `vault-queue.ts` `submitFlush`: it builds the call by hand with the whole
  transcript in the fallible section. A flush that loses a race then lands as
  `FailFallible`, pays its fee, and `flushUntil` retries it.
- **The flush's time budget.** The flush's work runs in the fallible section,
  so the node's limit counts only the proof check and the fee payment: the
  cost of an empty flush of the same circuit. After P0 that is 12.56 ms of the
  15.02 ms allowed (it was about 12.3 ms before the vault-nonce branch). Full
  10-slot flushes of withdraw requests, deposit requests or attestations are
  all accepted. Anything that makes the flush circuit bigger must be
  re-measured. To measure: prove and balance a flush transaction, call
  `tx.cost(LedgerParameters.initialParameters(), true)` (it throws, naming the
  exact dismiss time and the limit), then `facade.revertTransaction(tx)` to
  release the DUST it held.
- **Ledger paths move whenever a field is added.** The compiler chunks the
  ledger tree and puts the last 15 fields in the last chunk, so adding any
  field shifts where chunk 0 ends and moves the path of every field. Each send
  circuit's MPC notification carries its event map's path as a hand-written
  vector (`[chunk, offset, 0, 0]`), and `index.ts` exports it as a constant. After any
  ledger change: recompile, read `contract-info.json`, and update every
  notification vector, every exported path constant and every row of
  `ledger-paths.test.ts`. A stale vector does not fail to compile. The MPC
  simply never answers, so the per-map path test is the tripwire. Resolve
  path conflicts on merge by recompiling, never by editing numbers by hand.
- **Grep for literal paths.** e2e specs have hard-coded paths before. Use the
  exported constants everywhere, and grep the integration tests for `[0, 0]`
  style literals after any path change.
- **Never trust the attestation event's `digest` field.**
  `verifyRespondBidirectionalEventV1` recomputes the digest from the request
  id, height, kind and the output you pass, and never reads the event's
  `digest`. The queue circuit must store the digest it computed. Storing the
  event's field would let a caller swap in a digest over a different output
  and mint for a transfer that returned false.
- **A one-variant enum in a hashed struct breaks proving.** It compiles to a
  field element the ledger parses as zero bytes, and the proof server rejects
  the proof ("Inputs did not match alignment"). Keep every such enum at two or
  more variants. That is why `Action` has `reserved` today.
- **Compact quirks.** `event` is a reserved word. An early `return;` works in a
  circuit returning `[]`. Top-level declarations can reference each other in
  any order.
- **Class realms.** compact-js wants the runtime's `ContractState` class, and
  the ledger's `ContractCallPrototype` wants the ledger's own
  `ContractOperation`. Round-trip through bytes
  (`ContractState.deserialize(raw.serialize())`) to cross between them.
- **The e2e drain step.** Several specs "drain" the vault's EVM account by
  signing with its key directly (`integration-tests/src/fakenet-vault-account.ts`).
  That spends a vault nonce the contract never assigned, so the helper puts the
  nonce back with `anvil_setNonce`. Keep that property in anything new that
  signs from the vault account.
- **Rerunning an e2e spec after it failed mid-request.** The rerun queues the
  identical request (same nonce, amount and gas), which is a twin of the open
  one and never moves. Resume the open request with the spec's resume variable
  (for example `DEPOSIT_REQUEST_ID=<id>`, printed in the spec's banners)
  instead. A start flow must wait for its own entry to leave
  `inputRequestBuffer`, never for its request key to appear in
  `outputRequestBuffer`, which an open twin already satisfies.
- **Old e2e specs understate the vault's gas.** They budgeted vault
  transactions with the `ERC20_TRANSFER_*` constants, which describe a
  deposit's caller-chosen gas. The vault signs at its own settings, five times
  higher by default. Budget vault-signed preflights with `vaultGasEnvelope`.
- **Unfunded test identities** cannot pay for a queue or flush transaction.
  Arrange those steps with the funded session.
- **The proof server** needs a 16 GB Docker VM and still gets OOM-killed after
  serving many proofs. The fakenet MPC stand-in proves its posts through the
  same server. Never restart it while the responder is mid-post.
- **The e2e skill** (`.claude/skills/e2e/SKILL.md`) is useful for stack
  bring-up, redeploys and reading failures, but its spec list and test counts
  describe the old suite. The pinned order in `integration-tests/vitest.config.ts`
  is the truth.
- **macOS shell.** zsh does not word-split `$var`, BSD `sed` has no `\b` (use
  `perl`), and `timeout` does not exist.

### 1.6 House rules

- **Writing style** in everything you write (code comments, docs, commit
  messages, test names, log strings): no em dashes, no semicolons in prose,
  never start a sentence with "Because", British English spelling.
- **Comments state what is.** Never "previously", "the old X", "no longer",
  "instead of". A comment earns its place only by stating something the code
  cannot show: an invariant, a cross-file contract, a failure mode.
- **No dead code.** Delete what nothing reaches.
- **Dependencies** are pinned exact versions, installed from the repo root.
  Ask before adding one, and never install anything globally.
- **Never commit or push** unless told to. Task agents hand back a branch with
  uncommitted or locally committed work as section 6 says. Only the integrator
  pushes.
- **Ask the user** before any contract design change this spec does not
  already decide.

## 2. The pattern

### 2.1 The six steps

Every action, without exception, runs the same six steps. No action adds a
step, skips one, or adds action-specific logic to the shared machinery.

1. **Start** (`startX`): the requester queues the request under a random input
   index they choose. It writes the action's arguments to the action's args
   map and a fixed-size entry to `inputRequestBuffer`.
2. **Flush the request** (`flushQueue`): moves the entry to
   `outputRequestBuffer` under its request key, stamping `lastSeen`. For a
   vault-signed request it also assigns the vault's next EVM nonce.
3. **Send** (`sendX`): anyone builds the EVM transaction from the entry and
   its arguments, records it in the action's event map, maps the request id
   to the request key in `evictionMap`, and notifies the MPC.
4. **Queue the attestation** (`queueAttestationN`): anyone submits the MPC's
   signed attestation for the output width `N`. It is verified and stored in
   `inputAttestationBuffer` under the request id.
5. **Flush the attestation** (`flushQueue`): moves the record to
   `outputAttestationBuffer` and folds its height into `globalLastSeen`.
6. **Complete** (`completeX`): the requester consumes the request and its
   attestation and branches on the verdict: executed (check the output
   against the digest, then act on the result) or failed/unviable (the
   failure path, which re-mints whatever start burned).

### 2.2 The shared machinery (the Request queue section)

These already exist and every action reuses them unchanged. Only Phase 0
changes this section.

- `Action` enum, `GasParams`, `RequestBufferEntry`, `OutputRequestEntry`,
  `AttestationRecord`, `FlushChannel`, `FlushSlot`.
- Ledger: `globalLastSeen`, `inputRequestBuffer`, `outputRequestBuffer`,
  `inputAttestationBuffer`, `outputAttestationBuffer`, `evictionMap`.
- `ownershipCommitment(inIndex, sk)`, `requestKey(entry)`.
- `flushQueue`, `flushRequest`, `flushAttestation`.
- `recordAttestation`, `queueAttestation0`, `queueAttestation1`.
- `settleRequest(requestId, action)`: the common part of every complete. It
  checks the request was sent and is open, the action matches, the
  attestation is flushed and not stale, and the caller owns the request. Then
  it removes the `evictionMap` entry, the output attestation and the output
  entry, and returns the entry and the record.

### 2.3 The action section template

Each action is one section of the contract, appended after the previous
action's section, holding everything that action owns and nothing else. Copy
the Deposit section's shape exactly:

```compact
// ==== <Action> ======================================================================
// <The EVM transaction in one line, who signs it, where its nonce and gas come from.>

export struct <X>Request { ... }            // what the caller asks for, named per section 2.6

export struct <X>Args {
  request: <X>Request;
  gas: GasParams;                           // deposit alone also carries `path`
}

// Compiled path for MPC notification: [c, o] (read from managed/erc20-vault/compiler/contract-info.json).
export ledger bidirectional<X>Map: SignBidirectionalEventMapV1<EvmType2TxParams<W, 0, 0>, O, R>;

// inIndex -> the arguments of the <action> queued under it, from start to complete.
export ledger <x>ArgsMap: Map<Uint<64>, <X>Args>;

circuit <x>ArgsHash(args: <X>Args): Bytes<32> {
  return upgradeFromTransient(transientHash<[Bytes<32>, <X>Args]>([
    pad(32, "vault:<x>:args"),
    args
  ]));
}

export circuit start<X>(inIndex: Uint<64>, ...): [] { ... }
export circuit send<X>(outKey: Bytes<32>): [] { ... }
export circuit complete<X>(requestId: RequestId, serializedOutput: Bytes<N>, mintNonce: Bytes<32>, ...): [] { ... }
```

### 2.4 Step checklists

**Start**, in this order:

1. `requireInitialised();`
2. Validate the request (non-zero addresses, positive amounts, amounts at most
   `Uint<64>` max wherever the complete will mint them).
3. The gate, if the action has one:
   `assert(userCommitment(callerSecretKey()) == deployer, "Not the deployer");`
4. If the action surrenders a coin: check its colour
   (`tokenType(vaultTokenDomainSeparator(erc20), kernel.self())`) and value,
   then `receiveShielded(disclose(coin)); sendImmediateShielded(disclose(coin), shieldedBurnAddress(), disclose(coin).value);`
5. `assert(!inputRequestBuffer.member(i) && !<x>ArgsMap.member(i), "Index already in use");`
   The args map check matters: the flush frees the index in the input buffer
   while the args still sit under it.
6. Build the args, including `gas`. A user-signed action takes gas as an
   argument. A vault-signed action copies it from config:
   `GasParams { gasLimit: vaultGasLimits.<x>, maxFeePerGas: vaultMaxFeePerGas, maxPriorityFeePerGas: vaultMaxPriorityFeePerGas }`.
7. Insert the args into `<x>ArgsMap`, then the entry into `inputRequestBuffer`
   with `action`, `nonceIsVault`, `evmNonce` (0 for vault-signed, the flush
   assigns it), `inIndex`, `commitment: ownershipCommitment(inIndex, callerSecretKey())`
   and `argsHash: <x>ArgsHash(args)`.

**Send**, in this order:

1. `requireInitialised();`
2. `assert(outputRequestBuffer.member(key), "Request not flushed");`, then read
   the entry and `assert(entry.action == Action.<x>, "Wrong action");`
3. `const args = <x>ArgsMap.lookup(entry.inIndex);`
4. Build the `EvmType2TxParams` from the entry (`nonce: entry.evmNonce`) and
   the args (`args.gas.*`, the addresses and amounts). The derivation path is
   `args.path` for deposit and `pad(32, "vault")` for every vault-signed action.
5. `constructSignBidirectionalEventV1`, then the request id with the matching
   `calculateEvmType2RequestIdV1<...>`.
6. `assert(!bidirectional<X>Map.member(requestId), "Request already sent");`,
   then insert into the event map and `evictionMap.insert(requestId, key);`.
7. `signetSigner.signBidirectional(requestId, constructSignBidirectionalEventNotificationV1(kernel.self(), 2 as Uint<8>, [c, o, 0, 0] as Vector<4, Uint<8>>))`
   with the event map's compiled path.

No gate, no argument besides the key: the entry and args fix every byte.

**Complete**, in this order:

1. `requireInitialised();`
2. `const settled = settleRequest(disclose(requestId), Action.<x>);`
3. Look up and remove the args from `<x>ArgsMap`, assert the event map holds
   the request (`"Request event missing"`) and remove it.
4. `if (record.outputKind == OutputKind.executed) { ... } else { ... }`
   - Executed: `assert(calculateSignetAttestationDigestV1<N>(requestId, record.blockHeight, record.outputKind, output) == record.digest, "Output does not match the attestation");`
     then deserialise the output and act on it.
   - Otherwise (failed or unviable): the failure path. The output is ignored.
     A caller passes `N` zero bytes.
5. Every mint takes a caller-chosen random `mintNonce`. Two mints in one
   circuit take two nonces and assert they differ.

### 2.5 Vault-signed requests (Phase 0 builds this)

- A new ledger cell `globalEvmNonce: Uint<64>`, read and written ONLY by
  `flushRequest`. It starts at 0 and `initialise` does not set it: every
  deployment derives a fresh vault EVM account from its contract address, so
  its first nonce is 0.
- In `flushRequest`, for an entry with `nonceIsVault == true`: set the entry's
  `evmNonce` to `globalEvmNonce` BEFORE computing the request key, and
  increment `globalEvmNonce` only once the entry actually moves (after the
  twin check passes). Assign-then-increment gives the first vault request
  nonce 0.
- A vault-signed request's request key includes its assigned nonce, so such
  requests never collide and never wait as twins.
- Sends are permissionless, so any flushed vault request can always be sent.
  No set of "unsent nonces" exists and none is needed.
- **The SDK side is already built** (`contract/src/vault-queue.ts`).
  `queuedRequestKey` works for caller-signed entries only and throws for a
  vault-signed one, whose key covers a nonce only the flush assigns. Read a
  vault-signed request's key after its flush with
  `flushedRequestKey(state, Action.<x>, inIndex)`. `movableItems` never treats
  a vault-signed request as a twin. A port changes nothing in this file.

### 2.6 Naming

- Types and circuits follow the pattern names: `Action`, `RequestBufferEntry`,
  `FlushSlot`, `GasParams`, `<X>Request`, `<X>Args`, `start<X>`, `send<X>`,
  `complete<X>`, `bidirectional<X>Map`, `<x>ArgsMap`, `<x>ArgsHash`.
- Request structs, exactly: `DepositRequest { erc20Address, amount }`,
  `WithdrawRequest { erc20Address, amount, destEvmAddress }`,
  `SwapRequest { erc20AddressIn, erc20AddressOut, fee: Uint<128>, amountOut, amountInMaximum }`,
  `SupplyRequest { amount }`, `RedeemRequest { shares }`,
  `ApproveRequest { erc20Address, spender }`. Amounts are `Uint<128>`,
  addresses `Bytes<20>`.
- One event map per action. The two approvals share one action, one event map
  and one args map, as they build the same transaction.
- SDK path constants: `VAULT_<X>_REQUESTS_PATH` in `index.ts`, one per event map.

## 3. The actions

Every row below is a behaviour to preserve from the old contract, re-expressed
in the six steps. Where this table and the old contract disagree, this table
wins.

| Action | Start (who, args) | Burns at start | Nonce, gas | EVM transaction | Event map type | Complete, executed | Complete, failed or unviable |
| --- | --- | --- | --- | --- | --- | --- | --- |
| deposit (done) | anyone: `inIndex, evmNonce, gas, DepositRequest` | nothing | caller's, caller's | `transfer(vaultEvmAddress, amount)` on `erc20Address`, path `userCommitment` | `<2,0,0>, 34, 34` | width 1: mint `amount` to `recipient` (or caller) if true, else close | close |
| withdraw | anyone holding the coin: `inIndex, WithdrawRequest, coin` | the vault coin of `erc20Address`, value `amount` | vault's, `vaultGasLimits.withdraw` | `transfer(destEvmAddress, amount)` on `erc20Address` | `<2,0,0>, 34, 34` | width 1: close if true, re-mint `amount` to caller if false | re-mint `amount` to caller |
| approve (router) | deployer: `inIndex, erc20Address` | nothing | vault's, `vaultGasLimits.approve` | `approve(uniswapRouter, unlimitedAllowance())` on `erc20Address` | `<2,0,0>, 34, 34` (shared) | width 1: close | close |
| approve (stata) | deployer: `inIndex` | nothing | vault's, `vaultGasLimits.approve` | `approve(stataToken, unlimitedAllowance())` on `stataUnderlying` | shared with router | width 1: close | close |
| replaceNonce | deployer: `inIndex, evmNonce` | nothing | the deployer's `evmNonce` (`nonceIsVault: false`), vault fee settings with gas limit 21000 | zero-value self-transfer to `vaultEvmAddress`, no calldata | `<2,0,0>, 34, 34` | width: see P1b | close |
| swap | anyone holding the coin: `inIndex, SwapRequest, coin` | the vault coin of `erc20AddressIn`, value `amountInMaximum` | vault's, `vaultGasLimits.swap` | `exactOutputSingle` on `uniswapRouter`, selector `0x5023b4df`, 7 words: in, out, fee, `vaultEvmAddress`, amountOut, amountInMaximum, 0 | `<7,0,0>, 38, 37` | width 8: mint `amountOut` of `erc20AddressOut` and the change `amountInMaximum - amountIn` of `erc20AddressIn`, two distinct nonces | re-mint `amountInMaximum` of `erc20AddressIn` |
| supply | anyone holding the coin: `inIndex, SupplyRequest, coin` | the vault coin of `stataUnderlying`, value `amount` | vault's, `vaultGasLimits.supply` | `deposit(amount, vaultEvmAddress)` on `stataToken`, selector `0x6e553f65` | `<2,0,0>, 36, 35` | width 8: mint the attested `shares` of `stataToken` | re-mint `amount` of `stataUnderlying` |
| redeem | anyone holding the coin: `inIndex, RedeemRequest, coin` | the vault coin of `stataToken`, value `shares` | vault's, `vaultGasLimits.redeem` | `redeem(shares, vaultEvmAddress, vaultEvmAddress)` on `stataToken`, selector `0xba087652`, 3 words | `<3,0,0>, 36, 35` | width 8: mint the attested `assets` of `stataUnderlying` | re-mint `shares` of `stataToken` |

Schemas and decoded outputs come from the old contract verbatim:
`vaultResponseSchema` (bool, width 1), `swapOutputSchema`/`swapRespondSchema`
with `ExactOutputSingleReturnValue { amountIn: Uint<64> }`,
`supplyOutputSchema`/`supplyRespondSchema` with `DepositReturnValue { shares: Uint<64> }`,
`redeemOutputSchema`/`redeemRespondSchema` with `RedeemReturnValue { assets: Uint<64> }`,
`unlimitedAllowance()`. Each schema and return struct lives in its action's
section, except `vaultResponseSchema` and `VaultResponse`, which several actions share
and stay in Configuration.

Every complete re-mints to `left(ownPublicKey())`, the caller, except
deposit's success mint, which takes an optional `recipient`. Every complete is
requester-gated through `settleRequest` in every branch, success included, the
approvals and replaceNonce by the deployer who started them.

The address fields each start asserts non-zero: withdraw `erc20Address` and
`destEvmAddress`, the router approval `erc20Address`, swap `erc20AddressIn` and
`erc20AddressOut`. Supply, redeem and the stata approval take no address: the
contract fixes theirs.

The widths 8 need `queueAttestation8`. Whichever task first needs it adds it
to the Request queue section with exactly this code, so two parallel copies
merge as one:

```compact
// Queues an attestation with an 8-byte output (a uint64 return value). The output is
// needed here, as the signed digest binds the height to it and the flush trusts the
// height it folds.
export circuit queueAttestation8(
  respondBidirectionalEvent: RespondBidirectionalEventV1,
  serializedOutput: Bytes<8>
): [] {
  requireInitialised();
  const attestation = disclose(respondBidirectionalEvent);
  const output = disclose(serializedOutput);
  assert(
    verifyRespondBidirectionalEventV1<8>(output, attestation, mpcResponseKey),
    "Invalid attestation signature"
  );
  const digest = calculateSignetAttestationDigestV1<8>(
    attestation.requestId, attestation.blockHeight, attestation.outputKind, output
  );
  recordAttestation(attestation, digest);
}
```

## 4. Caveats: deliberate choices that look wrong

Do not "fix" any of these. Do not add any of the "never add" items.

**Deliberate:**

- **The MPC is trusted completely.** Add no defence against a faulty or
  malicious MPC: no second-attestation handling, no settled-request registry,
  no cross-checks of one attestation against another.
- **The `lastSeen` bound is not MPC distrust.** It stops an honest attestation
  of an earlier identical transaction from settling a later identical
  request. It applies to every action, is checked at queue and again at
  complete, and stays even where it can never fire.
- **The admin (deployer) is trusted.** Admin-set gas values and the nonce a
  replacement names are not validated beyond the basics. This is why
  replaceNonce needs no check against `globalEvmNonce`, and why the flush has
  no action-specific branch. The danger is the admin's to manage, and the
  contract says so in the warning P1b puts on `startReplaceNonce`.
- **The queue circuits take the full output.** The digest binds the height to
  the output, and the flush trusts the height it folds. Hash-only queueing
  would let anyone push `globalLastSeen` to `2^64 - 1` and brick the vault.
- **The queue circuit recomputes the digest** even though the event carries
  one. See 1.5.
- **Sends are permissionless and take only the key.** Gas is fixed at start.
- **Completes are requester-gated in every branch**, success included.
- **Asserts that cannot fire today stay** ("Request not open", "Request event
  missing", "Wrong action" and the like). They guard invariants the next
  action could break.
- **`Action.reserved`** is padding for the two-variant rule. Remove it only
  when a second real variant lands (Phase 0).
- **Only the flush inserts into output buffers.** Complete may remove.
- **Identical deposits wait as twins.** An identical repeat of an open request
  stays in the input buffer and never settles. That is correct.
- **No gas bump and no cancel.** Known costs, documented in the design doc.
  Porting does not add either.
- **No backwards compatibility.** Rename, reorder and re-layout freely.
  Ledger paths change on every port.

**Never add:**

- **Settle views** (the old `*SettleViews` maps). The output entry and the
  args map hold everything a complete needs.
- **Binders** (`approveRouterBinder`, `approveStataBinder`). Every action uses
  a caller-chosen random `inIndex`.
- **An unflushed counter** or any "flush must take every waiting item" rule.
  Every start would then conflict with every flush.
- **A shared event map across actions** (except the two approvals).
- **Separate refund circuits.** One `completeX` handles every verdict.
- **Gas arguments on a send**, or any gate on a send.
- **Any read or write of `globalLastSeen` or `globalEvmNonce` outside
  `flushQueue`.**

## 5. Tasks

Every task ends on an offline gate the task agent can prove, then an
integration step the integrator runs on the one shared stack. A task agent
never starts, stops or uses the docker stack (section 6).

Each port task includes, for its action:

- **Contract:** its section per 2.3 and 2.4, its `Action` variant, and
  `queueAttestationN` if the width is new.
- **SDK:** `VAULT_<X>_REQUESTS_PATH` in `index.ts`, and the new maps in
  `vault-ledger.ts` `printVaultState`.
- **Paths:** the regenerated path constants, notification vectors and
  `ledger-paths.test.ts` rows (see 1.5). Bump the chunk-shape tests there
  just enough to pass. The final sweep decides their fate.
- **Deploy:** the provable circuit count in `deploy/tests/deploy-vault.test.ts`.
- **Unit tests:** the old describe blocks ported to the new circuits, plus
  new cases for anything the table in section 3 makes new.
- **Flows:** `start-<x>.ts` and `complete-<x>.ts`, ported from the old flows
  and shaped like the deposit and withdraw flows. Add `<x>-round-trip.ts` only
  when a spec calls it: an unused flow is dead code.
- **e2e:** the spec, added to the pinned order in
  `integration-tests/vitest.config.ts`.
- **Design doc:** any change to `docs/contention-handling.md` the port makes
  true.

**Offline success criteria, common to every task:**

1. The gate passes from the repo root:
   `yarn compile && yarn format:check && yarn lint && yarn build && yarn test`.
2. `ledger-paths.test.ts` has one row per event map, and each send circuit's
   notification vector equals its map's compiled path.
3. The unit tests cover, for the action:
   - start: every validation, "Index already in use", "Not initialised", and
     the gate if it has one
   - flush: the entry moves, with the assigned nonce for a vault-signed action
   - send: permissionless (sent from a stranger's context), "Request not
     flushed", "Wrong action", "Request already sent"
   - queue: at the action's width
   - complete: every verdict branch with its exact mints (count and amounts
     read from `effects.shieldedMints`), "Not the requester", "Stale
     attestation" and "Output does not match the attestation"
   - every argument field reaching the constructed EVM transaction.
4. `grep -n "SettleView\|Binder\|unflushed\|refund[A-Z]" examples/erc20-vault/contract/src/erc20-vault.compact`
   returns nothing.
5. No new ESLint disables, no `any`, JSDoc on every new export.
6. **Mutation check:** for each new branch or assert in the contract, break it
   on purpose, confirm a unit test fails, then restore it and recompile. The
   hand-back lists what was broken and which test caught it.

**Integration criteria, common to every task (the integrator runs these):**

1. After merging, a fresh deploy (zk keygen, deploy, initialise) succeeds.
2. The task's e2e spec passes, and so does every spec that passed before the
   merge, in one full-suite run.

### Phase 0 (serial, alone on the stack): vault nonces and withdraw

**P0. Build the vault-signed machinery and port withdraw.**

- **Depends on:** nothing. Nothing else starts until P0 is merged.
- **Port from:**
  - The old contract: `startWithdraw`, `sendWithdraw`, `completeWithdraw`,
    `refundWithdraw`.
  - The old flows `start-withdraw.ts` and `complete-withdraw.ts`.
  - The old unit tests: "withdraw round-trip", "withdraw validation",
    "completeWithdraw settle", "refundWithdraw settle", the withdraw rows of
    "gas parameters reach the constructed transaction", "cross-kind settle
    isolation".
  - The old e2e: the withdraw half of `happy-day-e2e.test.ts`,
    `deposit-withdrawal-failure-refund.test.ts`, `bearer-transfer.test.ts`.
- **Work:**
  1. Add `globalEvmNonce` and the `flushRequest` branch per 2.5.
  2. Replace `Action.reserved` with `Action.withdraw`.
  3. Complete the Withdraw section (its types and args map exist already).
  4. Hoist `flushDepositAttestation` out of `complete-deposit.ts` into
     `flows/queue-attestation.ts` as `queueAndFlushAttestation(context, outcome)`,
     used by deposit and withdraw (withdraw is its second consumer, and the
     deposit name stops being true). It picks `queueAttestation0` or `1` from
     the output's length. The first width-8 port widens it. Update every
     caller, including `deposit-round-trip.ts`.
  5. Port the three e2e specs. The withdraw failure path re-mints through
     `completeWithdraw`.
  6. Update `docs/contention-handling.md`: the Vault-signed requests section
     describes what now exists, not a plan.
- **Extra offline criteria:**
  - A unit test flushes two withdrawals in one flush and sees nonces 0 and 1
    in order.
  - A unit test shows a deposit slot leaves `globalEvmNonce` unchanged.
  - A unit test shows a skipped slot (missing index) leaves `globalEvmNonce`
    unchanged.
- **Extra integration criteria:**
  - Measure the dismiss time of a full 10-slot flush of withdraw entries with
    the recipe in 1.5, and record the number in the hand-back. If it exceeds
    the limit, reduce `FLUSH_WIDTH` (contract vector and SDK constant
    together) and record the new width's number.
  - Record the same measurement for 10 deposit entries.

### Phase 1 (two agents in parallel)

**P1a. Approvals (router and stata, one action).**

- **Depends on:** P0.
- **Port from:**
  - The old contract: `approveRouter`, `approveStata`, `sendApprove`,
    `sendApproveRouter`, `sendApproveStata`, `unlimitedAllowance`.
  - The old flows `approve-router.ts` and `approve-stata.ts`.
  - The old unit tests: "approveRouter", "approveStata", the approve rows of
    the gas block.
- **Work:**
  - `Action.approve`, `ApproveRequest`, `ApproveArgs`,
    `bidirectionalApproveMap`, `approveArgsMap`.
  - Two deployer-gated starts: `startApproveRouter(inIndex, erc20Address)`
    and `startApproveStata(inIndex)`. The spender is always contract-fixed.
  - One `sendApprove(outKey)`.
  - One `completeApprove(requestId, serializedOutput: Bytes<1>)`, which mints
    nothing on any verdict.
  - An e2e step that approves before the swap and supply specs need it. Put
    it at the start of the specs that need it, or as its own spec pinned
    before them.
- **Extra offline criteria:**
  - Starting either approval from a stranger's context fails with
    "Not the deployer".
  - `completeApprove` from a stranger's context fails with
    "Not the requester".

**P1b. Nonce replacement.**

- **Depends on:** P0.
- **Port from:**
  - The old contract: `adminReplaceEvmNonce`.
  - The old flow `admin-replace-evm-nonce.ts`.
  - The old unit test block "adminReplaceEvmNonce".
  - The old e2e `admin-replace-nonce-e2e.test.ts`. It needs an ARCHIVE
    Sepolia RPC: the fakenet bisects account nonces over history.
- **Work:**
  - `Action.replaceNonce`.
  - A deployer-gated `startReplaceNonce(inIndex, evmNonce)` with
    `nonceIsVault: false`, carrying this comment verbatim above it:

    ```compact
    // ⚠️ EMERGENCY USE ONLY. THIS CAN LOSE USER FUNDS. ⚠️
    // Replaces the vault account's transaction at evmNonce with a zero-value
    // self-transfer, to unstick the account when that transaction can never be
    // mined. Every nonce the flush assigns belongs to a user's request, and the
    // replacement takes it: that request's own transaction can then never
    // execute. Before calling this the deployer must be certain the original
    // transaction is not in flight ANYWHERE, including mempools they cannot see:
    // a replacement racing a live transaction decides which of the two mines.
    // The replaced request can then settle only through an unviable attestation.
    // If none is ever posted, whatever it surrendered at start stays burned.
    ```
  - `sendReplaceNonce(outKey)` building the zero-value self-transfer with
    path "vault".
  - `completeReplaceNonce`, which closes on any verdict.
  - Its own event map and args map (the args hold only `gas`).
- **Open question to settle with evidence first:** what the MPC attests for an
  executed zero-value self-transfer under the bool respond schema (empty
  output? executed or failed?). Find it in the fakenet responder source
  (`ghcr.io/sig-net/fakenet`, built from `sig-net/solana-signet-program`) or by
  observation. Choose `completeReplaceNonce`'s width and the queue circuit
  from that. If the answer implies a different transaction or schema, stop
  and ask the user.
- **Extra integration criterion:** the replaced request (a withdraw whose
  nonce was replaced) completes through its failure branch and re-mints.

### Phase 2 (two agents in parallel)

**P2a. Swap.**

- **Depends on:** P1a, since the router must be approved for `erc20AddressIn`.
- **Port from:**
  - The old contract: `startSwap`, `sendSwap`, `completeSwap`, `refundSwap`,
    the swap schemas and `ExactOutputSingleReturnValue`.
  - The old flows `start-swap.ts`, `complete-swap.ts`, `swap-round-trip.ts`,
    and `src/evm-swap.ts`.
  - The old unit tests "swap round-trip", "completeSwap settle",
    "refundSwap settle".
  - The old e2e `swap-e2e.test.ts` and `swap-refund-e2e.test.ts`.
- **Work:** per the table in section 3. Adds `queueAttestation8` if it is
  absent, and widens `queueAndFlushAttestation` to width 8 if not yet done.
- **Extra offline criteria:**
  - `completeSwap` asserts `changeNonce != mintNonce`.
  - An exact spend mints a zero-value change coin, as before.

**P2b. Supply.**

- **Depends on:** P1a, since stata must be approved.
- **Port from:**
  - The old contract: `startSupply`, `sendSupply`, `completeSupply`,
    `refundSupply`, the supply schemas and `DepositReturnValue`.
  - The old flows `start-supply.ts`, `complete-supply.ts`,
    `supply-round-trip.ts`, and `src/evm-stata.ts`.
  - The old unit tests "supply round-trip", "completeSupply settle", the
    supply half of "refundSupply / refundRedeem settle".
  - The old e2e: the supply half of `supply-redeem-e2e.test.ts`, and
    `supply-refund-e2e.test.ts`.
- **Work:** per the table in section 3. Adds `queueAttestation8` if it is
  absent, and widens `queueAndFlushAttestation` to width 8 if not yet done.

### Phase 3

**P3. Redeem.**

- **Depends on:** P2b, since it redeems supplied shares.
- **Port from:**
  - The old contract: `startRedeem`, `sendRedeem`, `completeRedeem`,
    `refundRedeem`, the redeem schemas and `RedeemReturnValue`.
  - The old flows `start-redeem.ts`, `complete-redeem.ts`,
    `redeem-round-trip.ts`.
  - The old unit tests "redeem round-trip", "completeRedeem settle", the
    redeem half of the refund block.
  - The old e2e: the redeem half of `supply-redeem-e2e.test.ts`, and
    `redeem-refund-e2e.test.ts`.
- **Work:** per the table in section 3.

### Phase 4 (the sweep, after every action is merged)

**S1. Contract unit test sweep.**

- A table-driven contention matrix. Build each user circuit and each flush
  against one shared state, apply one, replay the other on top. Assert:
  - every user circuit applies after a concurrent flush and vice versa
  - two flushes carrying a common item conflict
  - a request-only flush conflicts after a height-raising flush
  - a twin-skipping flush conflicts after the open request completes.
  Negative rows must show the harness rejecting.
- The complete-time "Stale attestation" check hit directly, not the
  queue-time one.
- Every assert still untested.
- Flush behaviour:
  - slots naming missing entries
  - the same slot twice in one flush
  - two twins in one flush
  - an attestation below `globalLastSeen` leaving it unchanged
  - the over-width error in `flushSlots`.
- Decide the chunk-shape tests in `ledger-paths.test.ts`: keep the per-map
  path rows, and drop or rewrite the rest with the user.

**S2. SDK flush tests.** Unit tests for `vault-queue.ts`:

- `movableItems` selection: `first` ahead of the rest, open-key and in-batch
  twins left out, the width cap.
- `flushPending` submitting nothing when nothing would move.
- `flushUntil` retrying a `FailFallible` and throwing on anything else.

**S3. Live concurrency and time budget.**

- An e2e spec with two funded wallets and two competing flushers. It asserts
  that user transactions never fail, and that at least one flush loses a race
  and is retried.
- An integration test that measures the full-width flush's dismiss time and
  fails well before the node's limit.
- The benchmark specs (`benchmark`, `vault-queue-e2e`,
  `vault-queue-benchmark` in the old worktree): port or delete, with the user.
- Check the CI workflow's spec list.

**S4. Documentation sweep, scope confirmed with the user first:**

- the flow pages under `examples/erc20-vault/docs/`
- the actor map diagram
- the vault README's e2e prose
- `.env.example` comments
- the e2e skill's spec list and counts.

## 6. Parallel workflow

### 6.1 Roles

- **Integrator (one session):**
  - Owns `refactor-contention-handling`, the shared docker stack and the
    proof server.
  - Reviews and merges each task branch, runs the integration criteria, and
    pushes.
  - Runs Phase 0 itself, or supervises it, as it needs the stack.
- **Task agents (at most two at once):**
  - Each works one task in its own worktree.
  - Never touches the stack.
  - Hands back when the offline criteria pass.

### 6.2 Starting a task

From the primary checkout, create a sibling worktree on a new branch off the
integrator's latest pushed branch:

```bash
git -C /Users/bernard/Projects/github.com/sig-net/midnight-examples fetch origin
```

```bash
git -C /Users/bernard/Projects/github.com/sig-net/midnight-examples worktree add --no-track /Users/bernard/Projects/github.com/sig-net/midnight-examples-port-<action> -b port-<action> origin/refactor-contention-handling
```

Then, inside the new worktree: `yarn install`, then `yarn compile`. Work only
in that worktree. Never edit the primary checkout or the integrator's
worktree.

### 6.3 What a task agent may and may not do

- **May:** edit, compile without zk, run the offline gate, read anything in
  the old worktree, read `porting-packs/` in the integrator's worktree, and
  commit locally on its own branch.
- **May not:**
  - run `docker`, `yarn compile:erc20-vault:zk` or any e2e
  - touch `.env`
  - push
  - compile in another worktree
  - change the Request queue section beyond the verbatim
    `queueAttestation8` (P0 alone builds there)
  - change another action's section.

### 6.4 Handing back

The task agent ends with:

- its branch name and worktree path
- the offline gate output (the per-package test counts)
- the list of old describe blocks, flows and specs it ported, and any it did
  not, with the reason
- every decision it made that this spec did not dictate
- any open question it hit.

### 6.5 Integrating

For each handed-back task, the integrator:

1. Reviews the diff against sections 2 to 4.
2. Merges it into `refactor-contention-handling`. On conflicts in ledger
   paths, the `Action` enum or the deploy circuit count, it recompiles and
   rederives. It never hand-merges numbers.
3. Runs the full offline gate.
4. Redeploys (comments out `MIDNIGHT_VAULT_CONTRACT_ADDRESS` in `.env`, then
   runs the suite in the background) and runs the full e2e suite once.
5. Records the result, commits and pushes when the user says so, and tells
   the other running agent to rebase.

Parallel pairs touch separate action sections. Their only shared edits are
the `Action` enum, `queueAttestation8`, `index.ts`, `vault-ledger.ts`, the
ledger path test, the deploy circuit count and the e2e run order. All of
these resolve mechanically.
