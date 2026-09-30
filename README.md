# edge-ledger

**fleet-state@v1 — the SuperInstance fleet's sync contract.** Edge-native,
schema-first, substrate-agnostic. Part of the SuperInstance fleet; answers the
captain's 2026-09-30 mandate to integrate the stack holistically (EmDash-era
architecture, evaluated and cut to its load-bearing core).

## The one-paragraph doctrine

Every node already keeps local truth the same way: `quilt/cell-receipt@v1`
records in a hash chain, HMAC-signed with a key outside the agent's writable
context (see `quilt-canvas-tui/bridge/signing.mjs`, `syzygy-lattice`). What the
fleet lacked was the **travel shape** — what a node writes when its truth must
cross a network. This repo pins that shape: the `fleet-state@v1` envelope
(`schema/fleet-state.v1.md`), a reference implementation, and FAIL-first pins.
EmDash, D1, KV, plain HTTP — every substrate is a replaceable projection of the
schema. **The schema is the product; the plugin is plumbing.**

## Run it

```sh
node demo.mjs                        # 3 nodes sync; a fork is rejected; board renders
node --test test/edge.pins.mjs       # 5 pins (E1–E5)
```

No dependencies. Node ≥ 18.

## What is HEWN / DRAWN / SCARF

| shard | mark | notes |
|---|---|---|
| envelope schema + per-node chain + seq rule | HEWN | E1, E2 |
| idempotent ingest + loud fork rejection | HEWN | E3 |
| pure projections (fleet board) | HEWN | E4 |
| receipt-batch interop with `quilt/cell-receipt@v1` | HEWN | E5 — farma-shaped edits rejected at ingest |
| Merkle receipt batches: root gating + O(log n) inclusion proofs | HEWN | E6–E8 — PAM (arXiv 2605.11032) inspired; selective disclosure against the sealed root |
| HMAC signatures, key outside process | HEWN | E1 — `EDGE_LEDGER_HMAC_KEY` / `EDGE_LEDGER_KEYFILE` |
| D1/KV table DDL | DRAWN | one D1 table per node; KV holds tips for fast boot |
| EmDash ingest plugin (manifest-gated Dynamic Worker) | DRAWN | one evening once a live EmDash exists; note emdash-cms/emdash#449 (MCP Bearer 500) |
| x402 envelope gating | SCARF | real protocol, premature — no external consumer pays for heartbeats |
| AT Protocol schema sync | SCARF | proposal said AT Proto; reality is EmDash's decentralized plugin registry. Cited both sides. |

## Doctrine carried in from the fleet

- Chain rule public; signature is the difference between evidence and testimony.
- Unsigned is a declared state (`sig: null`), never a hidden fail, never retro-backfilled.
- Projections never write back. Recompute-from-store MUST equal the live board.
- Not a CRDT: one chain per node, last-writer-wins per `(node, seq)`, full
  history retained. Merge is a projection concern, never a write concern.

## License

MIT.
