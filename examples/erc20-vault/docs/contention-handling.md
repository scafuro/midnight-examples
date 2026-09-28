# Contention handling

Many users drive the vault at once, and every Midnight transaction is proven
against the ledger state its prover saw. When a transaction reaches the chain,
each value it read must still hold. If another transaction changed one of those
values in between, the later transaction fails and has to be re-proven against
the new state. Two transactions that only touch different keys of the same map
never conflict. Two transactions that both read a single shared cell and one of
them writes it always can.

Some vault state is genuinely shared by every request. The vault's rule is
that such state has exactly one writer: `flushQueue`. Every other circuit works
only on entries keyed by its own request, so the circuits users call (start,
send, queue an attestation, settle) never conflict with each other or with the
flush. All contention is concentrated in the flush, where it is cheap to
handle: a flush carries no user funds or secrets, anyone may submit one, and a
flush that loses a race is simply rebuilt from the new state and resubmitted.
The price of a lost race is the losing flush's fee.

## The shared cells

| Cell             | Read and written by              | Holds                                                            |
| ---------------- | -------------------------------- | ---------------------------------------------------------------- |
| `globalLastSeen` | `flushQueue` (and `initialise`)  | the highest block height of any attestation the flush has folded |

`globalLastSeen` is the safety bound every settlement checks: an attestation
settles a request only if it comes from a block strictly above every height the
vault had seen when it accepted that request (see
[The last seen height](#the-last-seen-height)). `initialise` sets it to the
current EVM height.

Requests signed by the vault's own EVM account add a second flush-only cell,
the vault's next EVM nonce (see [Vault-signed requests](#vault-signed-requests)).

## Buffers

Requests and attestations each pass through a pair of buffers: an input buffer
that users write to and an output buffer that only the flush inserts into.
Settlement removes the entries it consumes from both output buffers. Each entry
lives under its own key, so writes by different users never collide.

| Ledger field              | Key                                   | Written by         | Removed by        |
| ------------------------- | ------------------------------------- | ------------------ | ----------------- |
| `inputRequestBuffer`      | a caller-chosen random index          | `startDeposit`     | the flush         |
| `outputRequestBuffer`     | the request key of the flushed entry  | the flush          | settlement        |
| `inputAttestationBuffer`  | the attestation digest                | `queueAttestation*` | the flush        |
| `outputAttestationBuffer` | the attestation digest                | the flush          | settlement        |
| `evictionMap`             | the request id                        | `sendDeposit`      | settlement        |
| `sentRequestKeys`         | the request key                       | `sendDeposit`      | settlement        |

A request entry (`RequestBufferEntry`) carries:

- **The action and its arguments.** A deposit's `DepositArgs` hold the
  `DepositRequest` (token and amount) and the MPC derivation path of the
  depositor's EVM account.
- **The nonce.** `nonceIsVault` is `false` for a deposit: `evmNonce` is the
  depositor's own account nonce, taken verbatim.
- **The input index** it was queued under, which is public already.
- **An ownership commitment**, `ownershipCommitment(inIndex, secret key)`. Send
  and settle recompute it from the stored index and the caller's secret, so
  only the requester can send or settle.

The gas envelope is not part of the entry: the send chooses it, as the account
that pays the gas is the requester's.

The flush stores the entry in `outputRequestBuffer` together with the
`lastSeen` height at that moment, under the entry's **request key**
(`requestKey`): a hash of every buffered field that determines the EVM
transaction (the action, the nonce flag, the nonce and the action's
arguments). It deliberately leaves out the input index and the ownership
commitment, so two identical requests share one request key.

The send never writes to an output buffer. It records the request id it
produced in `evictionMap` (request id to request key), which is how the queue
and settle circuits find the entry from an attestation, and adds the request
key to `sentRequestKeys`, which makes each entry sendable exactly once.

An attestation record (`AttestationRecord`) holds the request id, block height
and output kind, stored under its digest. It holds no output: settlement
passes the serialised output again and checks it against the digest, so one
record type and one pair of buffers serve every output width.

## The deposit lifecycle

A deposit takes six transactions from start to settlement. Only the two
flushes touch shared state.

1. **Start.** The depositor calls `startDeposit` with a random input index,
   their account's nonce and the `DepositRequest`. It writes the entry into
   `inputRequestBuffer`.
2. **Flush the request.** A flush moves the entry to `outputRequestBuffer`
   under its request key and records the current `globalLastSeen` as its
   `lastSeen`.
3. **Send.** The depositor calls `sendDeposit` with the request key and the gas
   envelope. It builds the sign bidirectional request, records it in
   `bidirectionalDepositMap`, writes `evictionMap` and `sentRequestKeys`, and
   notifies the MPC.
4. **Queue the attestation.** Once the MPC has attested the EVM outcome,
   anyone calls the queue circuit for the output's width (`queueAttestation1`
   for an executed transfer, `queueAttestation0` for a failed or unviable one).
   It verifies the MPC's signature, finds the entry through `evictionMap`,
   checks that the attestation's block height is above the entry's
   `lastSeen`, and writes the record into `inputAttestationBuffer` under its
   digest.
5. **Flush the attestation.** A flush moves the record to
   `outputAttestationBuffer` and raises `globalLastSeen` to its block height if
   that height is higher.
6. **Settle.** The depositor calls `completeDeposit` with the request id, the
   digest and the serialised output, or `closeFailedDeposit` with the request
   id and the digest. Settlement checks that the record names the request id,
   that its block height is strictly above the entry's `lastSeen`, that its
   verdict fits the circuit (executed for a complete, failed or unviable for a
   close) and that the caller owns the entry. `completeDeposit` also checks
   that the output hashes to the digest. Settlement then removes the request's
   event, its `evictionMap` and `sentRequestKeys` entries, the attestation and
   the output entry, and `completeDeposit` mints the deposited amount.

## The flush

`flushQueue` takes a vector of 10 slots. Each slot names a channel and a key:

- **Request slot.** Moves one entry from `inputRequestBuffer` to
  `outputRequestBuffer`, recording `globalLastSeen` as its `lastSeen`.
- **Attestation slot.** Moves one record from `inputAttestationBuffer` to
  `outputAttestationBuffer` and folds its block height into `globalLastSeen`.
- **Empty slot.** Does nothing, so a flush with fewer than 10 waiting items is
  still a valid call.

A slot whose key is not in its input buffer does nothing. So does a request
slot whose twin (an entry with the same request key) is still open: the twin
stays in `inputRequestBuffer`, and a later flush moves it once the open request
settles. The twin check comes before the entry is removed from the input
buffer, as a skipped slot is part of a transaction that succeeds and commits
whatever the slot already did. Nothing a user queues can therefore make a flush
fail.

Slots run in order, so within one flush a request slot placed after an
attestation slot sees that attestation's height in its `lastSeen`.

Flushing is permissionless, and a flush carries whichever waiting items its
caller chooses. A flusher can leave an item out, but it cannot stop anyone
else flushing it, and a user whose request is waiting can always flush it
themselves. The flush does not have to take every waiting item: a rule forcing
it to would make it read a count that every start writes, and every start would
then conflict with every flush.

Two flushes built against the same state conflict on `globalLastSeen`. One of
them lands, and the other is rebuilt and resubmitted. Only the flusher ever
retries. Users' own transactions never fail because of a flush.

The SDK's `flushPending` submits every flush with its whole transcript in the
transaction's fallible section, which runs after the fee is paid. Before taking
a fee, a node must be able to reject a transaction cheaply: it refuses one
whose proof check plus guaranteed section takes longer than
`max(15 ms, 2 µs per byte)`. midnight-js chooses the section before the wallet
adds its fee payment, so on its own it leaves a one-item flush in the
guaranteed section, where the payment then pushes it past that limit. In the
fallible section only the proof check and the payment count. The same choice
means a flush that loses a race still lands, as a failed fallible section, and
pays its fee.

## The last seen height

An MPC attestation names a request id and the height of the finalised EVM
block that settled it. The vault must never settle a request with an
attestation that describes anything other than that request's own
transaction. The `lastSeen` check is how the vault guarantees it for every
request, whatever its action: an attestation settles an entry only if its
block height is strictly greater than the entry's `lastSeen`. It is the
pattern for consuming MPC attestations safely, and the vault applies it
without exception.

The guarantee rests on three orderings the design enforces:

- **An attestation is consumed only after its height is folded.** Settlement
  reads from `outputAttestationBuffer`, which only the flush fills, and the
  flush raises `globalLastSeen` as it does.
- **An entry's bound is taken when it is flushed.** Its `lastSeen` is
  `globalLastSeen` at that moment, so it is at least the height of every
  attestation the vault had folded before accepting the request.
- **An identical request waits for the first to close.** The request key
  keeps an identical second request in `inputRequestBuffer` until the first is
  settled, and settling needs the first request's attestation to be folded.
  So the second request's `lastSeen` is at least that attestation's height,
  and replaying the first attestation against it fails.

A deposit shows why this matters. Its EVM transaction is determined by the
depositor (their derived account, their nonce, their token and amount, and the
gas they choose), so an identical second deposit can produce the identical
request id. The MPC would observe the same finalised transaction and issue
exactly the attestation that settled the first deposit. The `lastSeen` check
rejects it.

A real attestation for a new request always passes: its transaction is signed
only after the entry was flushed, so it lands in a block strictly above every
height the flush had seen.

## Why the queue takes the full output

The MPC signs one digest over the request id, block height, output kind,
output length and the raw serialised output together
(`calculateSignetAttestationDigestV1` in `@sig-net/midnight`). A signature
check against the digest alone proves the MPC signed something, but not which
block height it signed: recovering that needs the output. Without it, anyone
could pair a real digest and signature with an arbitrary height, and the flush
would fold that height into `globalLastSeen`. A height of `2^64 - 1` would stop
every later request from ever settling.

So each queue circuit takes the output at its exact width and recomputes the
digest before recording anything. Compact cannot export a width-generic
circuit, so there is one queue circuit per output width the vault uses. Only
the record's storage is width-independent.

## Invariants the circuits keep

- **Only the flush writes shared state.** No circuit other than `flushQueue`
  and `initialise` reads or writes `globalLastSeen`.
- **Only the flush inserts into an output buffer.** Send writes
  `evictionMap` and `sentRequestKeys`, and settlement only removes.
- **A request is sent at most once.** `sendDeposit` refuses a request key in
  `sentRequestKeys`. The gas is chosen at send, so a second send of the same
  entry would carry a different request id at the same nonce, and closing the
  entry with one of the two attestations could leave the other unsettleable.
- **An attestation settles at most once.** Settlement removes the output
  entry, the `evictionMap` entry and the attestation, and fails when any of
  them is absent. Attestations are public and stay validly signed forever, so
  anything less would let one be queued and settled again.
- **Only attestations for sent, open requests are queued.** The queue circuits
  find the entry through `evictionMap` and check its `lastSeen`, which keeps
  junk and stale attestations out of the flush's slots.
- **Queued attestations never overwrite each other.** Both attestation buffers
  are keyed by digest, and queueing refuses a digest either already holds.
- **Sending costs only the requester.** `sendDeposit` is requester-gated, as the
  depositor's own account pays whatever gas the send chooses.

## Vault-signed requests

Requests signed by the vault's own EVM account (withdraw, swap, supply, redeem
and the approvals) need the account's next nonce, and no two may get the same
one. That nonce is the second shared cell, and it follows the same rule: the
flush is its only reader and writer.

- **A request slot assigns it.** An entry with `nonceIsVault` set takes the
  current vault nonce, and the flush then increments it. Assigning before
  incrementing matters: the first vault request must receive the account's
  next unused nonce, or every later vault transaction waits behind a nonce no
  request ever uses.
- **Such requests never collide.** Each carries a nonce the flush assigned
  once, so their request keys are unique.
- **A stuck nonce is replaced through the flush.** A replacement names an
  already-issued nonce, and its flush slot checks it against the current vault
  nonce, never reading the cell outside the flush.

## Costs

- **Latency.** Settling needs a second flush after the MPC attests, so a round
  trip is six Midnight transactions.
- **Flush throughput.** Every request uses two flush slots over its life, one
  for its entry and one for its attestation, so a 10-slot flush carries the
  equivalent of 5 complete requests.
- **Serial flushes.** Flushes built against the same state conflict, so they
  land one after another, and throughput is bounded by the flush width and the
  flush rate, not by the number of users.
- **No gas bump.** A request is sent once, so a deposit sent with too little gas
  to be mined stays pending until the network fee falls to meet it.
