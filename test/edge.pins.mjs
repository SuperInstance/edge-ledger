// test/edge.pins.mjs — FAIL-first pins for fleet-state@v1.
// E1 seal determinism + sig round-trip
// E2 per-node chain verifies; spliced/forged envelope caught
// E3 idempotent redelivery no-ops; same-seq fork rejected with hashes quoted
// E4 projection is pure: recompute-from-store equals live board; mutate store, board changes
// E5 receipt-batch rides quilt/cell-receipt@v1 records verbatim and they re-verify locally
import { test } from "node:test";
import assert from "node:assert/strict";
import { seal, verifyChain, verifySig, canonical, sha256 } from "../src/envelope.mjs";
import { EnvelopeStore } from "../src/store.mjs";
import { fleetBoard, boardHash } from "../src/projection.mjs";
import { createHash } from "node:crypto";

const KEY = { key: "edge-test-key-outside-the-process" };
const stable = (o) => {
  if (o === null || typeof o !== "object") return JSON.stringify(o);
  if (Array.isArray(o)) return "[" + o.map(stable).join(",") + "]";
  const keys = Object.keys(o).sort();
  return "{" + keys.map((k) => JSON.stringify(k) + ":" + stable(o[k])).join(",") + "}";
};
// local re-derivation of the receipt rule syzygy-lattice/quilt-canvas-tui seal by
const localReceiptId = (op, addr, result, parent) =>
  createHash("sha256").update(stable({ op, addr, result, parent }), "utf8").digest("hex").slice(0, 16);

test("E1 seal is deterministic; sig verifies; tamper fails", () => {
  const a = seal({ node: "n1", seq: 1, kind: "lane-heartbeat", payload: { queue_tip: "x" }, signer: KEY });
  const b = seal({ node: "n1", seq: 1, kind: "lane-heartbeat", payload: { queue_tip: "x" }, signer: KEY });
  assert.deepEqual(a, b);
  assert.equal(sha256(canonical(a)), sha256(canonical(b)));
  assert.equal(verifySig(a, KEY.key).ok, true);
  const forged = { ...a, payload: { queue_tip: "y" } }; // same sig, tampered body
  assert.equal(verifySig(forged, KEY.key).ok, false);
  const unsigned = seal({ node: "n1", seq: 1, kind: "lane-heartbeat", payload: { queue_tip: "x" }, signer: null });
  assert.equal(unsigned.sig, null);
  assert.deepEqual(verifySig(unsigned, null), { ok: true, mode: "unsigned" });
});

test("E2 per-node chain verifies; splice caught", () => {
  const e1 = seal({ node: "n1", seq: 1, kind: "lane-heartbeat", payload: {}, signer: KEY });
  const e2 = seal({ node: "n1", seq: 2, prevEnv: e1, kind: "state-delta", payload: { op: "BIND", addr: "A1", result: { created: true } }, signer: KEY });
  const e3 = seal({ node: "n1", seq: 3, prevEnv: e2, kind: "lane-heartbeat", payload: {}, signer: KEY });
  assert.deepEqual(verifyChain([e1, e2, e3]), { ok: true, len: 3, tip: sha256(canonical(e3)) });
  const spliced = [e1, { ...e2, payload: { op: "BIND", addr: "A1", result: { created: false } } }, e3];
  assert.equal(verifyChain(spliced).ok, false, "edited middle envelope breaks linkage at e3");
});

test("E3 idempotent redelivery no-ops; fork rejected loudly", () => {
  const store = new EnvelopeStore();
  const e1 = seal({ node: "n1", seq: 1, kind: "lane-heartbeat", payload: {}, signer: KEY });
  assert.equal(store.ingest(e1, { key: KEY.key }).ok, true);
  const again = store.ingest(e1, { key: KEY.key });
  assert.deepEqual(again, { ok: true, dedup: true, why: "exact redelivery, acked no-op" });
  const fork = seal({ node: "n1", seq: 1, kind: "state-delta", payload: { op: "EFFECT", addr: "B2", result: {} }, signer: KEY });
  const r = store.ingest(fork, { key: KEY.key });
  assert.equal(r.ok, false);
  assert.match(r.why, /FORK at n1#1/);
  const gap = seal({ node: "n1", seq: 3, kind: "lane-heartbeat", payload: {}, signer: KEY });
  const g = store.ingest(gap, { key: KEY.key });
  assert.equal(g.ok, false);
  assert.match(g.why, /seq gap/);
});

test("E4 projection is pure and store-derived", () => {
  const store = new EnvelopeStore();
  let prev = null;
  for (let i = 1; i <= 4; i++) {
    const env = seal({ node: "edge-watch", seq: i, prevEnv: prev, kind: i % 2 ? "lane-heartbeat" : "state-delta", payload: i % 2 ? {} : { op: "TICK", addr: `C${i}`, result: { n: i } }, signer: KEY });
    store.ingest(env, { key: KEY.key });
    prev = env;
  }
  const h1 = boardHash(store);
  assert.equal(boardHash(store), h1, "recompute-from-store is deterministic");
  const board = fleetBoard(store);
  assert.equal(board.length, 1);
  assert.equal(board[0].head_seq, 4);
  assert.equal(board[0].chain_ok, true);
  // mutate the store (splice an envelope) — the board MUST change
  store.rows.get("edge-watch")[1].payload.result = { n: 999 };
  assert.notEqual(boardHash(store), h1, "mutated store yields a different board");
});

test("E5 receipt-batch carries quilt/cell-receipt@v1 verbatim; local re-verify gates ingest", () => {
  // seal two receipts the way syzygy-lattice's VisionLedger does
  const r1 = { schema: "quilt/cell-receipt@v1", receipt_id: localReceiptId("DETECT", "cells(9,0,15,3)", { kind: "component", mass: 128 }, null), parent: null, op: "DETECT", addr: "cells(9,0,15,3)", result: { kind: "component", mass: 128 } };
  const r2 = { schema: "quilt/cell-receipt@v1", receipt_id: localReceiptId("SEGMENT", "bands", { high: 10 }, r1.receipt_id), parent: r1.receipt_id, op: "SEGMENT", addr: "bands", result: { high: 10 } };
  const receiptCheck = (payload) => {
    let parent = null;
    for (const r of payload.receipts) {
      const want = localReceiptId(r.op, r.addr, r.result, parent);
      if (r.schema !== "quilt/cell-receipt@v1" || r.receipt_id !== want || r.parent !== parent) return { ok: false, why: `receipt ${r.receipt_id} fails local rules` };
      parent = r.receipt_id;
    }
    return { ok: true };
  };
  const store = new EnvelopeStore();
  const good = seal({ node: "syzygy-lattice", seq: 1, kind: "receipt-batch", payload: { schema: "quilt/cell-receipt@v1", receipts: [r1, r2] }, signer: KEY });
  assert.equal(store.ingest(good, { key: KEY.key, receiptCheck }).ok, true);
  const badReceipts = [r1, { ...r2, result: { high: 999 } }]; // edited content, old id (FARMA shape)
  const bad = seal({ node: "syzygy-lattice", seq: 2, prevEnv: good, kind: "receipt-batch", payload: { schema: "quilt/cell-receipt@v1", receipts: badReceipts }, signer: KEY });
  const r = store.ingest(bad, { key: KEY.key, receiptCheck });
  assert.equal(r.ok, false);
  assert.match(r.why, /receipt-batch rejected/);
});
