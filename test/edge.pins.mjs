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
import { merkleRoot, inclusionProof, verifyProof, EMPTY_ROOT } from "../src/merkle.mjs";

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

// --- frontier shard: Merkle receipt batches (PAM arXiv 2605.11032 inspired) ---

test("E6 merkleRoot is deterministic with pinned edge cases", () => {
  const leaves = ["aa".repeat(32), "bb".repeat(32), "cc".repeat(32), "dd".repeat(32)];
  assert.equal(merkleRoot([]), EMPTY_ROOT);
  assert.equal(merkleRoot(["aa".repeat(32)]), "aa".repeat(32), "single leaf IS the root");
  assert.equal(merkleRoot(leaves), merkleRoot([...leaves]), "deterministic");
  assert.notEqual(merkleRoot(leaves), merkleRoot([leaves[1], leaves[0], leaves[2], leaves[3]]), "order matters");
});

test("E7 inclusion proofs verify for every leaf of an odd tree; tampering fails", () => {
  const leaves = Array.from({ length: 5 }, (_, i) => createHash("sha256").update(`leaf${i}`).digest("hex"));
  const root = merkleRoot(leaves);
  for (let i = 0; i < 5; i++) {
    const p = inclusionProof(leaves, i);
    assert.ok(verifyProof(root, leaves[i], p), `leaf ${i} proves against the root`);
    assert.ok(p.length <= 3, `leaf ${i}: O(log n) proof size (${p.length} steps for n=5)`);
  }
  const forged = createHash("sha256").update("leaf9").digest("hex");
  assert.equal(verifyProof(root, forged, inclusionProof(leaves, 2)), false, "foreign leaf fails");
  const good = inclusionProof(leaves, 1);
  good[0].sibling = good[0].sibling.replace(/^../, "ff");
  assert.equal(verifyProof(root, leaves[1], good), false, "spliced proof fails");
});

test("E8 sealed envelope with merkle_root: ingest gates on it; selective disclosure verifies against the sealed root", () => {
  const mk = (op, addr, result, parent) => ({
    schema: "quilt/cell-receipt@v1",
    receipt_id: localReceiptId(op, addr, result, parent),
    parent, op, addr, result,
  });
  const rs = [];
  let parent = null;
  for (let i = 0; i < 6; i++) { const r = mk("TICK", `C${i}`, { n: i }, parent); rs.push(r); parent = r.receipt_id; }
  const root = merkleRoot(rs.map((r) => r.receipt_id));
  const store = new EnvelopeStore();
  const good = seal({ node: "gpu-lane", seq: 1, kind: "receipt-batch", payload: { schema: "quilt/cell-receipt@v1", merkle_root: root, receipts: rs }, signer: KEY });
  assert.equal(store.ingest(good, { key: KEY.key }).ok, true);
  // selective disclosure: a consumer gets leaf #4 + its proof — NOT the batch
  const leaf4 = rs[4].receipt_id;
  const proof4 = inclusionProof(rs.map((r) => r.receipt_id), 4);
  assert.ok(verifyProof(good.payload.merkle_root, leaf4, proof4), "one leaf + O(log n) bytes proves membership in the sealed batch");
  // a lying batch: swapped receipts under a root computed for the true set
  const lying = seal({ node: "gpu-lane", seq: 2, prevEnv: good, kind: "receipt-batch", payload: { schema: "quilt/cell-receipt@v1", merkle_root: root, receipts: [rs[0], rs[1], rs[2], rs[3], rs[5], rs[4]] }, signer: KEY });
  const r = store.ingest(lying, { key: KEY.key });
  assert.equal(r.ok, false);
  assert.match(r.why, /merkle_root mismatch/);
});
