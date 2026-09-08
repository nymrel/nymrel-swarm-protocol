# Nymrel Mesh delivery truth

Status: draft implementation contract
Control issue: `JalenBuildsHub/portfolio-control#253`

## Purpose

A sender-side success must never stand in for recipient observation, completed
work, or verified results. Nymrel Mesh therefore records one delivery receipt
for each `(message_id, recipient)` pair and advances it only when evidence for a
specific state exists.

This is the first native Nymrel Mesh slice. It extends the existing local,
zero-dependency Swarm Protocol without adding a hosted service or an external
runtime dependency.

## Non-collapsible states

| State | Evidence represented |
|---|---|
| `created` | A recipient-specific receipt was created for the message. |
| `accepted` | The sender outbox completed an exact-byte filesystem write. |
| `routed` | A concrete recipient mailbox was selected. |
| `deferred` | Delivery is intentionally delayed; it is neither delivered nor failed. |
| `delivered` | The recipient mailbox completed an exact-byte filesystem write. This does **not** mean the recipient runtime saw it. |
| `observed` | The recipient runtime read and successfully verified the envelope. |
| `acted` | An actor explicitly recorded action evidence. The mailbox never infers this state. |
| `verified` | An explicit verification transition closed the receipt successfully. |
| `delivery_unknown` | A pre-observation delivery operation had an ambiguous result. It must be reconciled explicitly. |
| `expired` | The delivery deadline passed without a later successful state. |
| `dead_lettered` | Delivery cannot continue and has been retained for inspection. |
| `revoked` | Current authority withdrew the delivery. |
| `rejected` | The delivery was refused before successful routing. |

`accepted`, `routed`, `delivered`, `observed`, `acted`, and `verified` are
separate facts. No state implies a later one, and proven delivery cannot be
downgraded to `delivery_unknown`.

## State graph

```text
created
  ├─ accepted
  │    ├─ routed ── delivered ── observed ── acted ── verified
  │    ├─ deferred ── routed
  │    └─ delivery_unknown ── explicit reconciliation
  ├─ rejected
  └─ revoked

Exceptional terminal states: expired, dead_lettered, revoked, rejected
Successful terminal state: verified
```

The implementation enforces an explicit transition allowlist. Backward
transitions and all transitions after a terminal state fail. Retrying the same
state is idempotent and does not append another history entry.

## Message identity and replay

A message ID is permanently bound to its exact serialized envelope bytes and
recipient set:

- replaying the exact same direct message is idempotent;
- the first receipt transition binds its sender and exact envelope digest, so an
  interrupted receipt-only write cannot later be claimed by different bytes;
- changing payload, sender, topic, recipient, checksum, or any other serialized
  byte under the same ID fails as an envelope conflict;
- a broadcast freezes its original recipient set on first send, so agents
  registered later do not silently become recipients during replay;
- a broadcast with no registered target fails before an outbox write or receipt
  is created;
- replay verifies that a receipt claiming `delivered` or later still has the
  exact recipient copy in inbox or archive, but an integrity failure does not
  rewrite historical delivery as unknown.

One per-message lock serializes receipt and mailbox reconciliation. Envelope
files are staged through an owner-only temporary file, flushed, and atomically
published by rename. This proves the local filesystem operation completed; it
does not claim storage survived device loss, controller-cache loss, or a power
failure beyond the operating system's durability guarantees.

## Recipient-specific receipts

A broadcast is not one delivery. It is a set of recipient-specific deliveries.
Each target receives an independent receipt, state, evidence chain, and terminal
result. One recipient observing a broadcast cannot advance any other
recipient's receipt.

## Evidence and reason boundaries

A transition can carry only this bounded evidence shape:

```json
{
  "kind": "mailbox_persisted",
  "reference": "mailbox://fable/inbox/message-id",
  "sha256": "optional lowercase SHA-256 digest"
}
```

Allowed evidence kinds are exported as `DELIVERY_EVIDENCE_KINDS`. Unknown fields
are rejected. The evidence object stores a reference and optional digest, not an
arbitrary response body, credential, prompt, OTP, session token, or tool output.

Free-form transition notes are not accepted. Optional operational context uses
the closed `DELIVERY_REASON_CODES` enum. Receipt, transition, and evidence
objects all reject unknown fields, preventing unreviewed data channels from
appearing inside the ledger.

## Integrity and custody

Each transition includes the prior transition hash and a deterministic SHA-256
hash over the receipt identity and transition fields. Receipt reads verify the
complete chain, canonical UTC timestamps, monotonic transition time, closed
object shapes, and the current head before returning data. Missing reads do not
create directories. Message and recipient identifiers are hashed before they
are used as storage paths, and receipt replacement uses an owner-only temporary
file, flush, and atomic rename.

This hash chain is **tamper-evident relative to a retained trusted head**. It is
not a digital signature, independent timestamp, human-identity proof, remote
attestation, confidentiality control, or external notarisation service. Those
claims require separate Nymrel Trust and Evidence layers.

## Mailbox integration

`FileMailboxManager.sendMessage()` advances each recipient through:

```text
created → accepted → routed → delivered
```

A successful return proves that the local recipient mailbox completed an
exact-byte write of the verified envelope. It does not claim that an agent read
the message.

`FileMailboxManager.receiveMessages()` advances a valid recipient message to
`observed`. A corrupt envelope is skipped and does not manufacture observation
evidence. Re-reading an unarchived message is idempotent. Recipient-side mailbox
evidence can reconcile a process interruption that occurred after persistence
but before the corresponding sender-side transition was recorded.

Legacy inbox messages without a delivery receipt remain readable and are not
silently assigned historical states.

## TypeScript and Python parity

Both implementations use the same state names, transition graph, evidence
kinds, reason codes, closed object shapes, and length-prefixed transition-hash
encoding. The shared deterministic test vector resolves to:

```text
afb4e0debaeca540d983b4e5e4b9f7ae11608a4509cbdb1e01baa369d66de140
```

A change to either implementation that breaks this vector fails its native test
suite. The focused local harness currently passes 24 Node tests and 24 Python
tests; repository CI on the exact pull-request head remains authoritative.

## Non-goals for this slice

This change does not implement:

- network transport or cross-machine replication;
- runtime identity authentication;
- model selection or provider routing;
- task authority or write authorization;
- node/session liveness;
- automatic retries, TTL processing, or dead-letter workers;
- proof that an observed message caused an external action;
- protected human handoff, passkeys, or Presence receipts;
- merges, deployments, registry publication, or production activation.

## Next contract

The next finite slice is a transport-neutral Nymrel task-authority envelope that
binds task scope, current writer generation, risk class, budget, expiry, allowed
actions, protected human gates, and required verification evidence. Delivery can
carry a reference to that authority, but communication alone must never grant it.
