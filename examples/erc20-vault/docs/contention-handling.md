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
send, queue an attestation, complete) never conflict with the flush, and calls
for different requests never conflict with each other. All contention is
concentrated in the flush, where it is cheap to
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
Completion removes the entries it consumes from both output buffers. Each entry
lives under its own key, so writes by different users never collide.

| Ledger field              | Key                                  | Written by          | Removed by          |
| ------------------------- | ------------------------------------ | ------------------- | ------------------- |
| `inputRequestBuffer`      | a caller-chosen random index         | the start circuit   | the flush           |
| `outputRequestBuffer`     | the request key of the flushed entry | the flush           | the complete circuit |
| `inputAttestationBuffer`  | the request id                       | `queueAttestation*` | the flush           |
| `outputAttestationBuffer` | the request id                       | the flush           | the complete circuit |
| `evictionMap`             | the request id                       | the send circuit    | the complete circuit |

A request entry (`RequestBufferEntry`) has one size for every action. It
carries:

- **The action.**
- **The nonce.** `nonceIsVault` is `false` for a deposit: `evmNonce` is the
  depositor's own account nonce, taken verbatim.
- **The input index** it was queued under, which is public already.
- **An ownership commitment**, `ownershipCommitment(inIndex, secret key)`. The
  complete circuit recomputes it from the stored index and the caller's
  secret, so only the requester can complete.
- **An args hash**, committing to the action's own arguments.

The arguments themselves live in the action's own args map, keyed by the input
index: `depositArgsMap` holds each deposit's `DepositArgs` (the
`DepositRequest`, the MPC derivation path of the depositor's EVM account, and
the gas envelope). The start circuit writes them, the send and complete
circuits read them, and the complete circuit removes them. The flush never
touches them, so its cost does not grow with the actions the vault supports.
The start circuit refuses an index that either the input buffer or its args
map already holds.

The flush stores the entry in `outputRequestBuffer` together with the
`lastSeen` height at that moment, under the entry's **request key**
(`requestKey`): a hash of every buffered field that determines the EVM
transaction (the action, the nonce flag, the nonce and the args hash). It
deliberately leaves out the input index and the ownership commitment, so two
identical requests share one request key.

The entry and its arguments fix every byte of the EVM transaction, gas
included, so sending is permissionless and chooses nothing. The send never
writes to an output buffer. It records the request in the action's event map
and the request id in `evictionMap` (request id to request key), which is how
the queue and complete circuits find the entry from an attestation. A second
send of the same entry builds the same request id, which the event map already
holds, so each entry is sent exactly once.

An attestation record (`AttestationRecord`) holds the block height, the output
kind and the attestation digest, stored under its request id. It holds no
output: the complete circuit passes the serialised output again and checks it
against the digest, so one record type and one pair of buffers serve every
output width.

## The deposit lifecycle

A deposit takes six transactions from start to completion. Only the two
flushes touch shared state.

1. **Start.** The depositor calls `startDeposit` with a random input index,
   their account's nonce, the gas envelope and the `DepositRequest`. It writes
   the arguments into `depositArgsMap` and the entry into `inputRequestBuffer`.
2. **Flush the request.** A flush moves the entry to `outputRequestBuffer`
   under its request key and records the current `globalLastSeen` as its
   `lastSeen`.
3. **Send.** Anyone calls `sendDeposit` with the request key. It builds the
   sign bidirectional request from the entry and its arguments, records it in
   `bidirectionalDepositMap`, writes `evictionMap`, and notifies the MPC.
4. **Queue the attestation.** Once the MPC has attested the EVM outcome,
   anyone calls the queue circuit for the output's width (`queueAttestation1`
   for an executed transfer, `queueAttestation0` for a failed or unviable one).
   It verifies the MPC's signature, finds the entry through `evictionMap`,
   checks that the attestation's block height is above the entry's
   `lastSeen`, and writes the record into `inputAttestationBuffer` under the
   request id.
5. **Flush the attestation.** A flush moves the record to
   `outputAttestationBuffer` and raises `globalLastSeen` to its block height if
   that height is higher.
6. **Complete.** The depositor calls `completeDeposit` with the request id, the
   serialised output, a mint nonce and an optional recipient. It checks that
   the record's block height is strictly above the entry's `lastSeen` and that
   the caller owns the entry, then removes the request's event, its arguments,
   its `evictionMap` entry, the attestation and the output entry. It then
   branches on the verdict:
   - **Executed:** it checks that the output hashes to the record's digest,
     and mints the deposited amount when the attested transfer returned true.
     A transfer that returned false only closes the request.
   - **Failed or unviable:** nothing was surrendered, so it only closes the
     request, and the output it was passed is ignored.

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
fail. A complete can still make a flush built before it fail: a flush that
skipped a twin read the open entry the complete removes, so that flush is
rebuilt, like any flush that loses a race.

Slots run in order, so within one flush a request slot placed after an
attestation slot sees that attestation's height in its `lastSeen`.

Flushing is permissionless, and a flush carries whichever waiting items its
caller chooses. A flusher can leave an item out, but it cannot stop anyone
else flushing it, and a user whose request is waiting can always flush it
themselves. The flush does not have to take every waiting item: a rule forcing
it to would make it read a count that every start writes, and every start would
then conflict with every flush.

Two flushes built against the same state conflict when they carry a common
item, or when one raises `globalLastSeen` and the other read it (every slot
that moves an item reads it). One of them lands, and the other is rebuilt and
resubmitted. Only the flusher ever retries. Users' own transactions never fail
because of a flush.

The SDK's `flushPending` fills the slots from the ledger, up to 10 items: the
items its caller names first, then queued attestations, then queued requests,
each in ledger order. It leaves out a request whose twin is open, or whose
request key an earlier request in the batch already takes, as the flush would
skip it, and it submits nothing when no item would move. So another user's
waiting repeats cannot fill a caller's flush, and `flushUntil` puts the items
the caller waits for into every flush it submits.

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

- **An attestation is consumed only after its height is folded.** The
  complete circuit reads from `outputAttestationBuffer`, which only the flush
  fills, and the flush raises `globalLastSeen` as it does.
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
rejects it. An identical repeat of a deposit therefore never settles: it shares
the first deposit's nonce, which the first deposit's transaction consumed, so
every attestation of it describes a block the vault has already folded.

A real attestation for a new request passes: its transaction is signed only
after the entry was flushed, so it lands in a block strictly above every height
the flush had seen. One case does not pass. A deposit names the depositor's own
nonce, and when another transaction consumed that nonce before the flush, the
MPC attests the request unviable at that transaction's block, which can lie at
or below the entry's `lastSeen`. Such a deposit stays open, with nothing lost,
as a deposit surrenders nothing at start.

The vault trusts the MPC: it attests each request id once, at the height of
the finalised block holding the transaction the attestation describes, as the
Signet protocol defines it.

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
- **Only the flush inserts into an output buffer.** Send writes the event map
  and `evictionMap`, and the complete circuit only removes.
- **The flush never touches arguments.** An action's arguments go into its
  args map at start and leave it at complete, so the flush moves a small entry
  of one size whatever the action.
- **A request is sent at most once.** The entry and its arguments fix the
  whole EVM transaction, so a second send builds the same request id, and the
  send refuses an id the action's event map already holds.
- **An attestation settles at most once.** The complete circuit removes the
  output entry, the `evictionMap` entry and the attestation, and fails when
  any of them is absent. Attestations are public and stay validly signed
  forever, so anything less would let one be queued and settled again.
- **Only attestations for sent, open requests are queued.** The queue circuits
  find the entry through `evictionMap` and check its `lastSeen`, which keeps
  junk and stale attestations out of the flush's slots.
- **Queued attestations never overwrite each other.** Both attestation buffers
  are keyed by request id, and queueing refuses a request id either already
  holds.
- **Sending is permissionless.** The send chooses nothing: the requester fixed
  the gas at start, so whoever sends only pays the Midnight fee.

## Vault-signed requests

The contract does not carry these requests yet. This section is the design
they follow.

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
- **Serial flushes.** Concurrent flushes of the same waiting items conflict
  (see [The flush](#the-flush)), so under load flushes land one after another,
  and throughput is bounded by the flush width and the flush rate, not by the
  number of users.
- **No gas bump.** A request's gas is fixed at start, so a deposit queued with
  too little gas to be mined stays pending until the network fee falls to meet
  it.
- **No cancel.** No circuit closes an open request without an attestation that
  passes the bound. A request that is sent but never mined, or attested stale,
  stays in `outputRequestBuffer`, and it keeps its identical repeats in
  `inputRequestBuffer`.
