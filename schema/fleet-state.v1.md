# fleet-state@v1 — the SuperInstance edge-ledger envelope schema

**Status: HEWN** (reference implementation pinned, see `test/edge.pins.mjs`).
**Date:** 2026-09-30. **Author lane:** snowball (quilt-canvas-tui identity plane,
syzygy-lattice receipts).

## Why this exists

The fleet's state discipline is already decided locally: `quilt/cell-receipt@v1`
records in hash-chained ledgers, HMAC-signed with a key outside the agent's
writable context, thin projections over append-only truth (ActiveLedger
doctrine: the ledger is the truth, views are projections). What the fleet
lacks is the **sync contract**: what a node writes when its truth must move
across a network. This schema is that contract. Every substrate detail
(EmDash, D1, KV, plain HTTP) is a replaceable projection of it — which is why
the schema is pinned FIRST and the ingest plugin is a trivial second step.

## The envelope

```json
{
  "schema":    "fleet-state@v1",
  "node":      "snowball-main",
  "seq":       12,
  "prev":      "<sha256-64hex of the canonical form of this node's previous envelope, null for genesis>",
  "tip":       "<receipt_id of the node's local ledger tip at seal time>",
  "kind":      "state-delta | receipt-batch | lane-heartbeat",
  "payload":   { "...kind-specific, see below..." },
  "sig":       null | "hmac-sha256:<64hex over canonical(schema|node|seq|prev|tip|kind|payload)>"
}
```

### Kinds
| kind | payload | use |
|---|---|---|
| `state-delta` | `{ "op": "...", "addr": "...", "result": {...} }` | a single ledger-grade mutation, same preimage as a fabric receipt |
| `receipt-batch` | `{ "schema": "quilt/cell-receipt@v1", "receipts": [ ... ] }` | N already-sealed local receipts, order preserved |
| `lane-heartbeat` | `{ "queue_tip": "...", "blockers": ["..."] }` | no state claims; liveness only. Heartbeats MUST NOT carry result-shaped fields (a heartbeat can never be mistaken for evidence) |

### Rules (the whole contract)
1. **Per-node chain.** `prev` binds the sha256 of the node's previous envelope
   canonical form. Envelopes from one node are a hash chain — the sync stream
   is tamper-evident exactly like the local ledger it mirrors.
2. **Monotonic seq.** `seq = prev.seq + 1` per node. Gaps, repeats, and
   regressions are REJECTED loudly, never repaired silently.
3. **Idempotent delivery.** A store acknowledges `(node, seq)` once. Exact
   redelivery (same hash) is an acked no-op. Same `seq`, different hash is a
   FORK and is rejected with the offending hash quoted — this is the
   double-spend shape and it must never merge quietly.
4. **Receipts ride verbatim.** `receipt-batch` envelopes carry
   `quilt/cell-receipt@v1` records unchanged; they are verified against the
   local receipt rules (content-bound `receipt_id`, parent linkage) on
   ingest, BEFORE the envelope is acked. A batch of bad receipts poisons the
   envelope.
5. **Signatures when keys exist.** `sig` is HMAC over the canonical
   concatenation, key from `EDGE_LEDGER_HMAC_KEY` (launcher env) or
   `EDGE_LEDGER_KEYFILE` (0400). Missing key → `sig: null` = **unsigned is a
   declared state**, never a hidden fail, never retro-backfilled. The chain
   rule is public; the signature is the difference between evidence and
   testimony (identity-plane doctrine, same as quilt-canvas-tui).
6. **Projections are derived.** A store renders boards (fleet status, lane
   queues, receipt browsers) by pure functions over envelopes. No projection
   writes back. Recompute-from-store MUST equal the live board (pinned).
7. **Bounded size.** Max envelope 64 KiB canonical. Overflow → paginate as
   `receipt-batch` with `part: i/n` fields inside payload; a partial page set
   ingests as nothing (all-or-nothing per page set).

### Canonical form
JSON with object keys sorted recursively, no whitespace, UTF-8. sha256 over
those bytes. Same rule as the fabric's stable-stringify, one level up.

## What this deliberately is NOT
- Not a CRDT. Conflicts are impossible by construction: one chain per node,
  last writer wins per `(node, seq)`, full history retained. Merge is a
  projection concern, never a write concern.
- Not a transport. HTTP, MCP, sneaker-net: the envelope is identical.
- Not a new receipt schema. Local truth stays `quilt/cell-receipt@v1`;
  this is only its travel shape.

## Marks
- Envelope + chain + idempotency + forks + sig: **HEWN** (pins E1–E5).
- D1/KV table DDL: **DRAWN** (mapping: one D1 table per node, row = envelope,
  indexed by seq; KV holds latest tip per node for fast projection boot).
- EmDash ingest plugin (manifest-gated Dynamic Worker): **DRAWN** — one
  evening once a live EmDash deploy exists; note MCP Bearer-auth issue
  emdash-cms/emdash#449 before wiring machine auth.
- x402 gating of envelopes: **SCARF** — real protocol, premature: nobody
  pays for our heartbeats yet. Revisit when a feed has a external consumer.
