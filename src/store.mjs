// src/store.mjs — the envelope store. D1-shaped: append-only, one row per
// envelope, idempotent acks, forks rejected loudly. A JSONL file is the
// reference substrate; the schema binds rows, not the engine underneath.
import { canonical, sha256, verifyChain, verifySig, SCHEMA } from "./envelope.mjs";
import { merkleRoot } from "./merkle.mjs";
import { appendFileSync, readFileSync } from "node:fs";

export class EnvelopeStore {
  constructor(path = null) {
    this.path = path;
    this.rows = new Map(); // node -> [env, ...] in seq order
    if (path) {
      try {
        for (const line of readFileSync(path, "utf8").split("\n")) {
          if (!line.trim()) continue;
          const env = JSON.parse(line);
          if (!this.rows.has(env.node)) this.rows.set(env.node, []);
          this.rows.get(env.node).push(env);
        }
      } catch { /* empty store */ }
    }
  }
  nodeChain(node) { return this.rows.get(node) ?? []; }
  tip(node) { const c = this.nodeChain(node); return c.length ? c[c.length - 1] : null; }

  // ingest with the three contract rules: chain linkage, idempotency, fork rejection.
  // receiptCheck: optional fn(batchPayload) -> {ok, why?} applied to receipt-batch kinds BEFORE ack.
  ingest(env, { key = null, receiptCheck = null } = {}) {
    if (env.schema !== SCHEMA) return { ok: false, why: `bad schema ${env.schema}` };
    const chain = this.nodeChain(env.node);
    const dup = chain.find((e) => e.seq === env.seq);
    if (dup) {
      const same = sha256(canonical(dup)) === sha256(canonical(env));
      return same
        ? { ok: true, dedup: true, why: "exact redelivery, acked no-op" }
        : { ok: false, why: `FORK at ${env.node}#${env.seq}: stored ${sha256(canonical(dup)).slice(0, 12)} vs offered ${sha256(canonical(env)).slice(0, 12)}` };
    }
    const tip = this.tip(env.node);
    if (tip && env.seq !== tip.seq + 1) return { ok: false, why: `seq gap: expected ${tip.seq + 1}, got ${env.seq}` };
    if (!tip && env.seq !== 1) return { ok: false, why: `genesis seq must be 1, got ${env.seq}` };
    if (tip && env.prev !== sha256(canonical(tip))) return { ok: false, why: "prev does not match stored tip" };
    const sig = verifySig(env, key);
    if (!sig.ok) return { ok: false, why: sig.why };
    if (env.kind === "receipt-batch") {
      if (receiptCheck) {
        const chk = receiptCheck(env.payload);
        if (!chk.ok) return { ok: false, why: `receipt-batch rejected: ${chk.why}` };
      }
      if (env.payload.merkle_root) { // frontier (PAM-inspired): batch root must match the receipts carried
        const want = merkleRoot(env.payload.receipts.map((r) => r.receipt_id));
        if (want !== env.payload.merkle_root)
          return { ok: false, why: `merkle_root mismatch: envelope claims ${env.payload.merkle_root.slice(0, 12)}, receipts hash to ${want.slice(0, 12)}` };
      }
    }
    if (!this.rows.has(env.node)) this.rows.set(env.node, []);
    this.rows.get(env.node).push(env);
    this.#flush(env);
    return { ok: true, dedup: false };
  }

  #flush(env) {
    if (!this.path) return;
    appendFileSync(this.path, canonical(env) + "\n"); // append-only: the ingested row, nothing else
  }

  verifyAll() {
    for (const [node, chain] of this.rows) {
      const v = verifyChain(chain);
      if (!v.ok) return { ok: false, node, ...v };
    }
    return { ok: true, nodes: this.rows.size };
  }
}
