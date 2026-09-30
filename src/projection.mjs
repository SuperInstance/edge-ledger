// src/projection.mjs — the thin layer. Boards are PURE functions over store
// envelopes; nothing here writes back. Recompute-from-store MUST equal the
// live board (pinned E4). This is the ActiveLedger doctrine across a network:
// envelopes are the truth, everything on screen is a projection.
import { sha256, canonical } from "./envelope.mjs";

// the fleet board: per node, last heartbeat/claim, receipt count, chain health.
export function fleetBoard(store) {
  const board = [];
  for (const [node, chain] of store.rows) {
    let receipts = 0, lastKind = null, lastSeq = 0, tips = [];
    for (const e of chain) {
      lastKind = e.kind; lastSeq = e.seq;
      if (e.kind === "receipt-batch") receipts += e.payload.receipts?.length ?? 0;
      if (e.tip) tips.push(e.tip);
    }
    const v = store.verifyAll();
    board.push({
      node,
      head_seq: lastSeq,
      head_kind: lastKind,
      receipts_carried: receipts,
      tip_trace: tips[tips.length - 1] ?? null,
      chain_ok: v.ok,
    });
  }
  return board.sort((a, b) => a.node.localeCompare(b.node));
}

// render the board as text — the same shape quilt-canvas-tui's fleet_board
// draws in the terminal, projected from the edge ledger instead of local
// sockets. One vocabulary, two substrates.
export function renderBoard(store) {
  const b = fleetBoard(store);
  const lines = ["node                seq  kind             rcpts  tip       chain", "-".repeat(74)];
  for (const r of b) {
    lines.push(
      `${r.node.padEnd(19)} ${String(r.head_seq).padStart(3)}  ${String(r.head_kind).padEnd(16)} ${String(r.receipts_carried).padStart(5)}  ${String(r.tip_trace ?? "-").padEnd(8)}  ${r.chain_ok ? "OK" : "BROKEN"}`
    );
  }
  return lines.join("\n");
}

export const boardHash = (store) => sha256(canonical(fleetBoard(store)));
