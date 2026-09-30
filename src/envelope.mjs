// src/envelope.mjs — fleet-state@v1 envelopes: seal, canonicalize, verify.
// The sync contract: one hash chain PER NODE, monotonic seq, HMAC sig when a
// key exists, unsigned declared otherwise. Chain rule is public; the
// signature is the difference between evidence and testimony.
import { createHash, createHmac } from "node:crypto";
import { readFileSync, statSync } from "node:fs";

export const SCHEMA = "fleet-state@v1";
export const KINDS = ["state-delta", "receipt-batch", "lane-heartbeat"];
const MAX_BYTES = 64 * 1024;

export const canonical = (o) => {
  if (o === null || typeof o !== "object") return JSON.stringify(o);
  if (Array.isArray(o)) return "[" + o.map(canonical).join(",") + "]";
  const keys = Object.keys(o).sort();
  return "{" + keys.map((k) => JSON.stringify(k) + ":" + canonical(o[k])).join(",") + "}";
};

export const sha256 = (s) => createHash("sha256").update(s, "utf8").digest("hex");

export function loadKey() {
  const env = process.env.EDGE_LEDGER_HMAC_KEY;
  if (env) return env;
  const file = process.env.EDGE_LEDGER_KEYFILE;
  if (file) {
    try {
      const st = statSync(file);
      if (st.mode & 0o077) {
        process.stderr.write(`edge-ledger: refusing group/other-writable keyfile ${file}\n`);
        return null;
      }
      return readFileSync(file, "utf8").trim();
    } catch { return null; }
  }
  return null;
}

// seal one envelope. signer = {key} | null (from loadKey). prevEnv = the
// node's previous sealed envelope | null (genesis).
export function seal({ node, seq, prevEnv = null, tip = null, kind, payload, signer = null }) {
  if (!KINDS.includes(kind)) throw new Error(`unknown kind: ${kind}`);
  if (prevEnv && seq !== prevEnv.seq + 1) throw new Error(`seq gap: ${prevEnv.seq} -> ${seq}`);
  const prev = prevEnv ? sha256(canonical(prevEnv)) : null;
  const env = { schema: SCHEMA, node, seq, prev, tip, kind, payload }; // no sig key: the signed text never mentions the signature
  const bytes = canonical(env);
  if (bytes.length > MAX_BYTES) throw new Error(`envelope exceeds ${MAX_BYTES} bytes (${bytes.length})`);
  if (signer?.key) env.sig = "hmac-sha256:" + createHmac("sha256", signer.key).update(bytes, "utf8").digest("hex");
  else env.sig = null; // unsigned is a declared state, never an absent key
  return env;
}

export function verifySig(env, key) {
  if (env.sig === null) return { ok: true, mode: "unsigned" };
  if (!key) return { ok: false, why: "signed envelope presented with no key to verify" };
  const { sig, ...core } = env;
  const want = "hmac-sha256:" + createHmac("sha256", key).update(canonical(core), "utf8").digest("hex");
  return sig === want ? { ok: true, mode: "signed" } : { ok: false, why: "signature mismatch" };
}

// chain-verify a node's ordered envelopes: seq monotonic, prev linkage exact.
export function verifyChain(envs) {
  let prev = null, prevSeq = 0;
  for (let i = 0; i < envs.length; i++) {
    const e = envs[i];
    if (e.schema !== SCHEMA) return { ok: false, at: i, why: `schema ${e.schema}` };
    if (e.seq !== prevSeq + 1) return { ok: false, at: i, why: `seq ${e.seq} after ${prevSeq}` };
    if (e.prev !== prev) return { ok: false, at: i, why: `prev linkage broken at seq ${e.seq}` };
    prev = sha256(canonical(e)); prevSeq = e.seq;
  }
  return { ok: true, len: envs.length, tip: prev };
}
