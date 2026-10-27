// MUSE Aegis: structured features x4, x5, x6 and the alert status (Phase 3, step 3).
// Pure functions over plain data (no model, no I/O). Rules: spec/FEATURES.md. Inputs come from JSON files or a
// database, so they are validated at run time; anything unusable gives INCOMPLETE with a short reason code,
// never a silent 0. Money is handled in whole cents and each ratio is a single division of integers.

import { canonicalize } from "./jcs.ts";

export type Rec = Record<string, unknown>;

export interface Identifier { scheme: string; value: string }

// ---------------------------------------------------------------- small helpers

const ISO = /^(\d{4})-(\d{2})-(\d{2})$/;

function dayNumber(s: unknown): number | null {
  if (typeof s !== "string") return null;
  const m = ISO.exec(s);
  if (!m) return null;
  const y = Number(m[1]), mo = Number(m[2]), d = Number(m[3]);
  const t = Date.UTC(y, mo - 1, d);
  const back = new Date(t);
  if (back.getUTCFullYear() !== y || back.getUTCMonth() !== mo - 1 || back.getUTCDate() !== d) return null;
  return t / 86400000;
}

function isRec(v: unknown): v is Rec {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function toCents(v: unknown): number | null {
  if (typeof v !== "number" || !Number.isFinite(v) || v < 0) return null;
  const c = Math.round(v * 100);
  if (Math.abs(v * 100 - c) > 1e-6) return null; // more than two decimals: refuse instead of rounding
  return c;
}

function identifiers(v: unknown): Identifier[] | null {
  if (v === undefined) return [];
  if (!Array.isArray(v)) return null;
  const out: Identifier[] = [];
  for (const i of v) {
    if (!isRec(i) || typeof i["scheme"] !== "string" || typeof i["value"] !== "string") return null;
    out.push({ scheme: i["scheme"], value: i["value"] });
  }
  return out;
}

// ---------------------------------------------------------------- x4: documentation deficit

export type X4Result =
  | { x4: number; n_applicable: number; undocumented_value: number; applicable_value: number; undocumented_ids: string[]; pending_ids: string[]; flags: string[] }
  | { x4: "NA"; n_applicable: 0; flags: string[] }
  | { x4: "INCOMPLETE"; reason: string };

export function computeX4(awardU: unknown, ledgerU: unknown): X4Result {
  const bad = (reason: string): X4Result => ({ x4: "INCOMPLETE", reason });
  if (!isRec(awardU) || !isRec(ledgerU)) return bad("INVALID_INPUT");
  const pol = awardU["documentation_policy"];
  const dates = awardU["planned_dates"];
  const currency = awardU["currency"];
  if (!isRec(pol) || !isRec(dates) || typeof currency !== "string") return bad("INVALID_INPUT");
  const cure = pol["cure_days"];
  const excluded = pol["excluded_categories"];
  const required = pol["required_documents"];
  const start = dayNumber(dates["start"]);
  const end = dayNumber(dates["end"]);
  const asOf = dayNumber(ledgerU["as_of"]);
  if (typeof cure !== "number" || !Number.isInteger(cure) || cure < 0 || !Array.isArray(excluded) || !isRec(required) ||
      start === null || end === null || asOf === null) return bad("INVALID_INPUT");

  if (ledgerU["complete"] !== true) return bad("LEDGER_INCOMPLETE");
  const txs = ledgerU["transactions"];
  if (!Array.isArray(txs)) return bad("INVALID_INPUT");

  // De-duplicate by id: identical repeats count once, conflicting repeats make the ledger unusable.
  const flags: string[] = [];
  const seen = new Map<string, Rec>();
  for (const t of txs) {
    if (!isRec(t) || typeof t["id"] !== "string") return bad("INVALID_TRANSACTION");
    const prev = seen.get(t["id"]);
    if (prev) {
      let same = false;
      try { same = canonicalize(prev) === canonicalize(t); } catch { return bad("INVALID_TRANSACTION"); }
      if (!same) return bad("DUPLICATE_ID_CONFLICT");
      flags.push(`DUPLICATE_ID:${t["id"]}`);
      continue;
    }
    seen.set(t["id"], t);
  }

  const rows: { t: Rec; cents: number; day: number }[] = [];
  for (const t of seen.values()) {
    const cat = t["category"];
    const day = dayNumber(t["date"]);
    if (typeof cat !== "string" || day === null) return bad("INVALID_TRANSACTION");
    if (excluded.includes(cat) || day < start || day > end) continue;
    if (typeof t["currency"] !== "string") return bad("INVALID_TRANSACTION");
    if (t["currency"] !== currency) return bad("MIXED_CURRENCY");
    const cents = toCents(t["value"]);
    if (cents === null) return bad("INVALID_AMOUNT");
    if (!Array.isArray(required[cat]) || !(required[cat] as unknown[]).every((x) => typeof x === "string")) return bad("UNKNOWN_CATEGORY");
    if (!Array.isArray(t["documents"])) return bad("INVALID_TRANSACTION");
    rows.push({ t, cents, day });
  }

  if (rows.length === 0) return { x4: "NA", n_applicable: 0, flags };

  let applicable = 0, und = 0;
  const undIds: string[] = [];
  const pendIds: string[] = [];
  for (const { t, cents, day } of rows) {
    applicable += cents;
    const have = new Set<string>();
    for (const d of t["documents"] as unknown[]) {
      if (!isRec(d) || typeof d["type"] !== "string") return bad("INVALID_TRANSACTION");
      have.add(d["type"]);
    }
    const need = required[t["category"] as string] as string[];
    if (need.every((x) => have.has(x))) continue;
    if (asOf - day <= cure) pendIds.push(t["id"] as string);
    else { und += cents; undIds.push(t["id"] as string); }
  }
  return {
    x4: und / applicable,
    n_applicable: rows.length,
    undocumented_value: und / 100,
    applicable_value: applicable / 100,
    undocumented_ids: undIds,
    pending_ids: pendIds,
    flags,
  };
}

// ---------------------------------------------------------------- x5: reporting opacity

export type X5Result =
  | { x5: number; n_due: number; n_submitted: number; late: string[]; missing: string[] }
  | { x5: "NA" }
  | { x5: "INCOMPLETE"; reason: string };

export function computeX5(schedU: unknown): X5Result {
  const bad = (reason: string): X5Result => ({ x5: "INCOMPLETE", reason });
  if (!isRec(schedU)) return bad("INVALID_INPUT");
  const asOf = dayNumber(schedU["as_of"]);
  const reports = schedU["reports"];
  if (asOf === null || !Array.isArray(reports)) return bad("INVALID_INPUT");
  if (schedU["repository_complete"] !== true) return bad("REPOSITORY_INCOMPLETE");
  const parsed: { id: string; due: number; sub: number | null }[] = [];
  for (const r of reports) {
    if (!isRec(r) || typeof r["id"] !== "string") return bad("INVALID_REPORT");
    const due = dayNumber(r["due_date"]);
    if (due === null) return bad("INVALID_REPORT");
    let sub: number | null = null;
    if (r["submitted_date"] !== null && r["submitted_date"] !== undefined) {
      sub = dayNumber(r["submitted_date"]);
      if (sub === null) return bad("INVALID_REPORT");
    }
    parsed.push({ id: r["id"], due, sub });
  }
  const due = parsed.filter((r) => r.due < asOf);
  if (due.length === 0) return { x5: "NA" };
  const submitted = due.filter((r) => r.sub !== null && r.sub <= asOf);
  const late = submitted.filter((r) => (r.sub as number) > r.due).map((r) => r.id);
  const missing = due.filter((r) => !submitted.includes(r)).map((r) => r.id);
  return { x5: (due.length - submitted.length) / due.length, n_due: due.length, n_submitted: submitted.length, late, missing };
}

// ---------------------------------------------------------------- watch-list screening (x6, alert status)

const LEGAL_SUFFIXES = new Set(["ltd", "limited", "co", "company", "inc", "incorporated", "corp", "corporation", "llc", "plc", "gmbh", "sa", "fze"]);

export function nameTokens(name: string): Set<string> {
  const toks = name.normalize("NFKC").toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
  return new Set(toks.filter((t) => !LEGAL_SUFFIXES.has(t)));
}

function levenshtein(a: string, b: string): number {
  const A = Array.from(a), B = Array.from(b);
  let prev = Array.from({ length: B.length + 1 }, (_, i) => i);
  for (let i = 1; i <= A.length; i++) {
    const cur = [i];
    for (let j = 1; j <= B.length; j++) {
      cur.push(Math.min((prev[j] as number) + 1, (cur[j - 1] as number) + 1, (prev[j - 1] as number) + (A[i - 1] === B[j - 1] ? 0 : 1)));
    }
    prev = cur;
  }
  return prev[B.length] as number;
}

function tokMatch(a: string, b: string): boolean {
  return a === b || (Math.min(Array.from(a).length, Array.from(b).length) >= 5 && levenshtein(a, b) <= 1);
}

export type NameMatch = "EXACT" | "SIMILAR" | null;

export function namesMatch(a: string, b: string): NameMatch {
  const A = nameTokens(a), B = nameTokens(b);
  if (A.size === 0 || B.size === 0) return null;
  if (A.size === B.size && [...A].every((t) => B.has(t))) return "EXACT";
  const [short, long] = A.size <= B.size ? [A, B] : [B, A];
  if (long.size - short.size <= 1 && [...short].every((t) => [...long].some((u) => tokMatch(t, u)))) return "SIMILAR";
  return null;
}

function codePointCompare(a: string, b: string): number {
  const x = Array.from(a), y = Array.from(b);
  for (let i = 0; i < Math.min(x.length, y.length); i++) {
    const d = (x[i] as string).codePointAt(0)! - (y[i] as string).codePointAt(0)!;
    if (d !== 0) return d < 0 ? -1 : 1;
  }
  return x.length === y.length ? 0 : x.length < y.length ? -1 : 1;
}

export type AlertStatus = "NONE" | "UNVERIFIED" | "CONFLICTING";
export type X6Result =
  | { x6: 0 | 1; alert_status: AlertStatus; confirmed: [string, string][]; conflicting: [string, string][]; unverified: [string, string][] }
  | { x6: "INCOMPLETE"; reason: string };

export function screenWatchlist(awardU: unknown, ledgerU: unknown, registerU: unknown): X6Result {
  const bad = (reason: string): X6Result => ({ x6: "INCOMPLETE", reason });
  if (!isRec(awardU) || !isRec(ledgerU) || !isRec(registerU)) return bad("INVALID_INPUT");
  const rec = awardU["recipient_org"];
  const pol = awardU["documentation_policy"];
  const txs = ledgerU["transactions"];
  const entries = registerU["entries"];
  if (!isRec(rec) || typeof rec["name"] !== "string" || !isRec(pol) || !Array.isArray(pol["excluded_categories"]) ||
      !Array.isArray(txs) || !Array.isArray(entries)) return bad("INVALID_INPUT");
  const recIds = identifiers(rec["identifiers"]);
  if (recIds === null) return bad("INVALID_INPUT");

  const parties = new Map<string, Identifier[]>();
  const add = (name: string, ids: Identifier[]) => {
    const cur = parties.get(name) ?? [];
    for (const i of ids) if (!cur.some((c) => c.scheme === i.scheme && c.value === i.value)) cur.push(i);
    parties.set(name, cur);
  };
  add(rec["name"], recIds);
  for (const t of txs) {
    if (!isRec(t) || typeof t["category"] !== "string" || !isRec(t["receiver_org"]) || typeof t["receiver_org"]["name"] !== "string") return bad("INVALID_TRANSACTION");
    if ((pol["excluded_categories"] as unknown[]).includes(t["category"])) continue;
    const ids = identifiers(t["receiver_org"]["identifiers"]);
    if (ids === null) return bad("INVALID_TRANSACTION");
    add(t["receiver_org"]["name"], ids);
  }

  const watch: { uid: string; names: string[]; ids: Identifier[] }[] = [];
  for (const e of entries) {
    if (!isRec(e) || typeof e["uid"] !== "string" || typeof e["name"] !== "string") return bad("REGISTER_INVALID");
    const aliases = e["aliases"] === undefined ? [] : e["aliases"];
    const ids = identifiers(e["identifiers"]);
    if (!Array.isArray(aliases) || !aliases.every((a) => typeof a === "string") || ids === null) return bad("REGISTER_INVALID");
    watch.push({ uid: e["uid"], names: [e["name"], ...(aliases as string[])], ids });
  }

  const confirmed: [string, string][] = [];
  const conflicting: [string, string][] = [];
  const unverified: [string, string][] = [];
  const norm = (s: string) => s.trim().toUpperCase();
  for (const pname of [...parties.keys()].sort(codePointCompare)) {
    const pids = parties.get(pname) as Identifier[];
    for (const e of watch) {
      const idHit = pids.some((p) => e.ids.some((i) => p.scheme === i.scheme && norm(p.value) === norm(i.value)));
      const nm = e.names.some((x) => namesMatch(pname, x) !== null);
      if (idHit && nm) confirmed.push([pname, e.uid]);
      else if (idHit) conflicting.push([pname, e.uid]);
      else if (nm) unverified.push([pname, e.uid]);
    }
  }
  const x6: 0 | 1 = confirmed.length > 0 ? 1 : 0;
  const alert: AlertStatus = x6 === 1 ? "NONE" : conflicting.length > 0 ? "CONFLICTING" : unverified.length > 0 ? "UNVERIFIED" : "NONE";
  return { x6, alert_status: alert, confirmed, conflicting, unverified };
}

// ---------------------------------------------------------------- the parts of a kernel profile

export interface StructuredFeatures {
  x4: number | "NA" | "INCOMPLETE";
  x5: number | "NA" | "INCOMPLETE";
  x6: 0 | 1 | "INCOMPLETE";
  n_applicable: number | null;
  alert_status: AlertStatus;
  details: { x4: X4Result; x5: X5Result; screening: X6Result };
}

export function structuredFeatures(award: unknown, ledger: unknown, schedule: unknown, register: unknown): StructuredFeatures {
  const x4 = computeX4(award, ledger);
  const x5 = computeX5(schedule);
  const sc = screenWatchlist(award, ledger, register);
  return {
    x4: x4.x4,
    x5: x5.x5,
    x6: sc.x6,
    n_applicable: x4.x4 === "INCOMPLETE" ? null : x4.n_applicable,
    alert_status: sc.x6 === "INCOMPLETE" ? "NONE" : sc.alert_status,
    details: { x4, x5, screening: sc },
  };
}
