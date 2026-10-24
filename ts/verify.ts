// MUSE Aegis: verifying the stored audit log (Phase 2, step 4).
// Pure logic with an injected reader. It never writes anything. "Simulations" modify an in-memory COPY
// of the loaded entries to show what the verifier reports for each kind of tampering; the stored log is
// never touched.

import { verifyChain } from "./audit.ts";
import type { Entry, Verifier } from "./audit.ts";
import { rowsToEntries } from "./append.ts";
import type { StoreRow } from "./append.ts";

export interface AuditReader {
  /** Rows with seq greater than afterSeq, in ascending seq order, at most `limit` of them. */
  getPage(afterSeq: number, limit: number): Promise<StoreRow[]>;
}

export const SIMULATIONS = ["edit", "delete", "reorder", "signature", "truncate"] as const;
export type Simulation = (typeof SIMULATIONS)[number];

export interface EntrySummary {
  seq: number;
  timestamp: string | null;
  kind: string | null;
  decision: string | null;
  psi: number | null;
  ledger_id: string | null;
  actor_id: string | null;
  key_id: string;
  hash_short: string;
}

export interface ReportError {
  seq: number | null;
  code: string;
  detail?: string;
}

export interface VerifyReport {
  ok: boolean;
  length: number;
  head: { seq: number; hash: string } | null;
  errors: ReportError[];
  simulated: Simulation | null;
  recent: EntrySummary[];
}

const HEX64 = /^[0-9a-f]{64}$/;
const RECENT_LIMIT = 50;

export async function loadAll(
  reader: AuditReader,
  opts: { pageSize?: number; maxEntries?: number } = {},
): Promise<{ rows: StoreRow[]; tooMany: boolean; stalled: boolean }> {
  const pageSize = opts.pageSize ?? 500;
  const maxEntries = opts.maxEntries ?? 100000;
  const rows: StoreRow[] = [];
  let after = 0;
  for (;;) {
    const page = await reader.getPage(after, pageSize);
    if (page.length === 0) break;
    const last = page[page.length - 1] as StoreRow;
    if (!(last.seq > after)) return { rows, tooMany: false, stalled: true }; // a reader that does not advance
    rows.push(...page);
    after = last.seq;
    if (rows.length >= maxEntries) return { rows, tooMany: true, stalled: false };
    if (page.length < pageSize) break;
  }
  return { rows, tooMany: false, stalled: false };
}

function str(v: unknown): string | null {
  return typeof v === "string" ? v : null;
}

function summarize(e: Entry): EntrySummary {
  const rec = e.record;
  const result = (typeof rec["result"] === "object" && rec["result"] !== null ? rec["result"] : {}) as Record<string, unknown>;
  const kind = str(rec["kind"]);
  return {
    seq: e.seq,
    timestamp: str(rec["timestamp"]),
    kind,
    decision: kind === "OVERRIDE" ? str(rec["override_decision"]) : str(result["decision"]),
    psi: typeof result["psi"] === "number" ? result["psi"] : null,
    ledger_id: str(rec["ledger_id"]),
    actor_id: str(rec["actor_id"]),
    key_id: e.key_id,
    hash_short: e.hash.slice(0, 8) + "…" + e.hash.slice(-8),
  };
}

function applySimulation(entries: Entry[], sim: Simulation): { entries: Entry[]; expectedHead?: { seq: number; hash: string } } {
  const copy = structuredClone(entries);
  const n = copy.length;
  switch (sim) {
    case "edit": {
      const target = copy[Math.floor(n / 2)] as Entry;
      target.record["note"] = "edited after the fact";
      return { entries: copy };
    }
    case "delete": {
      copy.splice(n > 2 ? 1 : 0, 1);
      return { entries: copy };
    }
    case "reorder": {
      const a = copy[0] as Entry;
      const b = copy[1] as Entry;
      copy[0] = b;
      copy[1] = a;
      return { entries: copy };
    }
    case "signature": {
      (copy[n - 1] as Entry).signature = (copy[0] as Entry).signature;
      return { entries: copy };
    }
    case "truncate": {
      const head = { seq: (copy[n - 1] as Entry).seq, hash: (copy[n - 1] as Entry).hash };
      copy.pop();
      return { entries: copy, expectedHead: head }; // as if a checkpoint of the real head had been saved elsewhere
    }
  }
}

export async function verifyLog(
  reader: AuditReader,
  verifier: Verifier,
  opts: { expectedHead?: { seq: number; hash: string } | undefined; simulate?: Simulation | undefined } = {},
): Promise<VerifyReport> {
  const empty = (errors: ReportError[]): VerifyReport => ({ ok: false, length: 0, head: null, errors, simulated: null, recent: [] });

  if (opts.expectedHead) {
    const h = opts.expectedHead;
    if (!Number.isSafeInteger(h.seq) || h.seq < 1 || typeof h.hash !== "string" || !HEX64.test(h.hash)) {
      return empty([{ seq: null, code: "BAD_CHECKPOINT", detail: "checkpoint needs a positive seq and a 64-character lowercase hex hash" }]);
    }
  }
  if (opts.simulate !== undefined && !(SIMULATIONS as readonly string[]).includes(opts.simulate)) {
    return empty([{ seq: null, code: "BAD_SIMULATION" }]);
  }

  const { rows, tooMany, stalled } = await loadAll(reader);
  if (stalled) return empty([{ seq: null, code: "READER_STALLED" }]);
  if (tooMany) return empty([{ seq: null, code: "TOO_MANY_ENTRIES" }]);

  let entries: Entry[];
  try {
    entries = rowsToEntries(rows);
  } catch (err) {
    // Find which row is unreadable so the report can point at it.
    const errors: ReportError[] = [];
    for (const r of rows) {
      try { rowsToEntries([r]); } catch (e) {
        errors.push({ seq: r.seq, code: "UNREADABLE_ROW", detail: e instanceof Error ? e.message.slice(0, 60) : "unreadable" });
      }
    }
    if (errors.length === 0) errors.push({ seq: null, code: "UNREADABLE_ROW", detail: String(err).slice(0, 60) });
    return { ok: false, length: rows.length, head: null, errors, simulated: null, recent: [] };
  }

  const real = entries[entries.length - 1];
  const head = real ? { seq: real.seq, hash: real.hash } : null;
  const recent = entries.slice(-RECENT_LIMIT).map(summarize);

  let toCheck = entries;
  let expectedHead = opts.expectedHead;
  if (opts.simulate !== undefined) {
    if (entries.length < 2) {
      return { ok: false, length: entries.length, head, errors: [{ seq: null, code: "NEED_TWO_ENTRIES", detail: "add at least two entries to simulate tampering" }], simulated: null, recent };
    }
    const sim = applySimulation(entries, opts.simulate);
    toCheck = sim.entries;
    if (sim.expectedHead) expectedHead = sim.expectedHead;
  }

  const res = await verifyChain(toCheck, verifier, expectedHead ? { expectedHead } : {});
  return {
    ok: res.ok,
    length: entries.length,
    head,
    errors: res.errors.map((e) => ({ seq: e.seq, code: e.code, ...(e.detail !== undefined ? { detail: e.detail } : {}) })),
    simulated: opts.simulate ?? null,
    recent,
  };
}
