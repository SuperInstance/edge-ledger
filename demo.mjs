#!/usr/bin/env node
// demo.mjs — three fleet nodes sync envelopes into one edge store; a fork
// attempt is rejected loudly; the thin projection renders the board.
import { seal } from "./src/envelope.mjs";
import { EnvelopeStore } from "./src/store.mjs";
import { renderBoard } from "./src/projection.mjs";

const KEY = { key: process.env.EDGE_LEDGER_HMAC_KEY ?? "demo-key-not-for-production" };
const store = new EnvelopeStore();
const tips = {};

function push(node, kind, payload) {
  const env = seal({ node, seq: (tips[node]?.seq ?? 0) + 1, prevEnv: tips[node] ?? null, kind, payload, signer: KEY });
  const r = store.ingest(env, { key: KEY.key });
  tips[node] = env;
  return r;
}

push("snowball-main", "lane-heartbeat", { queue_tip: "exp021", blockers: ["casey-gated"] });
push("edge-watch", "receipt-batch", { schema: "quilt/cell-receipt@v1", receipts: [
  { schema: "quilt/cell-receipt@v1", receipt_id: "demo000000000001", parent: null, op: "DETECT", addr: "cells(9,0,15,3)", result: { kind: "component", mass: 128 } },
]});
push("syzygy-lattice", "state-delta", { op: "HYPOTH", addr: "rule/wide-structure", result: { name: "wide-structure", tally: 41 } });
push("snowball-main", "state-delta", { op: "SEAL", addr: "exp020", result: { pr: 26 } });
push("edge-watch", "lane-heartbeat", { queue_tip: "exp021", blockers: [] });

// a fork attempt: same node+seq, different body — must be rejected, quoted
const fork = seal({ node: "syzygy-lattice", seq: 1, kind: "state-delta", payload: { op: "HYPOTH", addr: "rule/rich-field", result: { name: "rich-field" } }, signer: KEY });
const fr = store.ingest(fork, { key: KEY.key });
console.log(`fork attempt @ syzygy-lattice#1 -> ${fr.ok ? "ACCEPTED (BUG)" : "REJECTED: " + fr.why}\n`);

console.log("fleet-state@v1 edge ledger — projected board:");
console.log(renderBoard(store));
console.log(`\nstore verify: ${JSON.stringify(store.verifyAll())}`);
console.log("the board is a pure projection of the envelopes. the envelopes are the truth.");
