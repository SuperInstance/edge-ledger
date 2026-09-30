// src/merkle.mjs — Merkle receipt batches for fleet-state@v1.
// Frontier upgrade inspired by Portable Agent Memory (arXiv 2605.11032):
// content-addressable entries + Merkle-DAG provenance. Our receipts were
// already content-addressed (receipt_id = sha256 of canonical content, farma-
// tested); this adds the DAG half — batch roots + inclusion proofs, so a
// consumer can verify ONE receipt's membership in a sealed batch with
// O(log n) bytes instead of the whole batch. GPU-note: leaf hashing is
// embarrassingly parallel; a batch of a million receipts parallelizes across
// lanes trivially (root reduction is the only serial tail).
import { createHash } from "node:crypto";

const H = (buf) => createHash("sha256").update(buf).digest(); // raw bytes
const unhex = (h) => Buffer.from(h, "hex");
const hex = (b) => b.toString("hex");

export const EMPTY_ROOT = hex(H(Buffer.alloc(0)));

// deterministic binary Merkle root over hex-digest leaves; odd levels
// duplicate the last node (Bitcoin convention — pinned in E6).
export function merkleRoot(leaves) {
  if (!leaves.length) return EMPTY_ROOT;
  let level = leaves.map((l) => unhex(l.length % 64 === 0 ? l : H(Buffer.from(String(l), "utf8"))));
  while (level.length > 1) {
    const next = [];
    for (let i = 0; i < level.length; i += 2) {
      const a = level[i], b = level[i + 1] ?? level[i];
      next.push(H(Buffer.concat([a, b])));
    }
    level = next;
  }
  return hex(level[0]);
}

// inclusion proof: [{sibling: hex, isRight: bool}] from leaf up to root.
export function inclusionProof(leaves, index) {
  if (index < 0 || index >= leaves.length) throw new RangeError(`index ${index} out of ${leaves.length}`);
  let level = leaves.map((l) => (l.length % 64 === 0 ? l : hex(H(Buffer.from(String(l), "utf8")))));
  let idx = index;
  const proof = [];
  while (level.length > 1) {
    const isRight = idx % 2 === 1;
    const sib = isRight ? idx - 1 : (idx + 1 < level.length ? idx + 1 : idx); // odd count: sibling is the duplicate
    proof.push({ sibling: level[sib], isRight });
    idx = idx >> 1;
    const next = [];
    for (let i = 0; i < level.length; i += 2) {
      const a = level[i], b = level[i + 1] ?? level[i];
      next.push(hex(H(Buffer.concat([unhex(a), unhex(b)]))));
    }
    level = next;
  }
  return proof;
}

export function verifyProof(root, leaf, proof) {
  let h = leaf.length % 64 === 0 ? unhex(leaf) : H(Buffer.from(String(leaf), "utf8"));
  for (const { sibling, isRight } of proof) {
    h = isRight ? H(Buffer.concat([unhex(sibling), h])) : H(Buffer.concat([h, unhex(sibling)]));
  }
  return hex(h) === root;
}
