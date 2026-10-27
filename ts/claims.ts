// MUSE Aegis: typed claims, anchoring, deterministic verification against a reference ledger, and x2.
// Phase 3, step 1. Pure functions, no I/O, no model calls. A model (or a person) proposes RawClaims; everything
// after that is plain code, so the result for a given document, claim list and ledger is always the same.
//
// Trust model: a proposed claim is accepted only if (1) its quote really occurs in the document, (2) its stated
// value and its subject really occur inside that quote, and (3) the value can be read unambiguously. This stops invented claims
// and makes the evidence for every claim traceable to a place in the document. The subject must be named in the quote too.

export type EvidenceStatus = "SUPPORTED" | "CONTRADICTED" | "INSUFFICIENT_EVIDENCE" | "AMBIGUOUS_CONFLICT";

export interface RawClaim {
  subject: string;
  attribute: string;
  period: string;
  value_text: string; // the value exactly as written in the document
  unit: string; // e.g. "USD", "KRW", "%", "count", "date", or ""
  quote: string; // an exact passage from the document that states the claim
}

export interface Claim {
  subject: string;
  attribute: string;
  period: string;
  value: number | string;
  unit: string;
  quote: string;
  key: string; // normalized subject|attribute|period
}

export type RejectReason =
  | "NOT_AN_OBJECT" | "EMPTY_FIELD" | "TOO_LONG" | "QUOTE_NOT_IN_DOCUMENT" | "VALUE_NOT_IN_QUOTE" | "SUBJECT_NOT_IN_QUOTE" | "TOO_MANY_CLAIMS";

export interface Rejected {
  index: number;
  reason: RejectReason;
}

export interface LedgerFact {
  id: string;
  subject: string;
  attribute: string;
  period: string;
  value: number | string;
  unit: string;
  valid_from?: string; // ISO date, inclusive
  valid_to?: string; // ISO date, inclusive
}

export interface Ledger {
  snapshot_id: string;
  snapshot_date: string; // ISO date (YYYY-MM-DD)
  facts: LedgerFact[];
}

export interface VerifiedClaim {
  claim: Claim;
  occurrences: number;
  status: EvidenceStatus;
  fact_ids: string[];
  flags: string[];
}

export const LIMITS = {
  MAX_CLAIMS: 200,
  MAX_FIELD_CHARS: 200,
  MAX_QUOTE_CHARS: 500,
  MIN_CLAIMS_PER_1000_CHARS: 0.2, // provisional coverage threshold
} as const;

export const STATUS_WEIGHTS_HALVES = { CONTRADICTED: 2, AMBIGUOUS_CONFLICT: 1, INSUFFICIENT_EVIDENCE: 1, SUPPORTED: 0 } as const;

// ---------------------------------------------------------------- normalization

export function normalizeText(s: string): string {
  return s.normalize("NFKC").trim().replace(/\s+/g, " ").toLowerCase();
}

export function claimKey(subject: string, attribute: string, period: string): string {
  return `${normalizeText(subject)}|${normalizeText(attribute)}|${normalizeText(period)}`;
}

const NUMBER_TEXT = /^[$€£¥₩]?\s*(-?(?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d+)?)\s*%?$/;

/** Reads a value as written. Plain numbers (with thousands commas, an optional leading currency symbol or a
 *  trailing %) become numbers; anything else becomes normalized text. Wording such as "12 thousand" stays text,
 *  so it will not match a numeric ledger value and is reported, never silently converted. */
export function parseValue(valueText: string): number | string {
  const t = valueText.normalize("NFKC").trim();
  const m = NUMBER_TEXT.exec(t);
  if (m && m[1] !== undefined) {
    const n = Number(m[1].replace(/,/g, ""));
    if (Number.isFinite(n)) return n;
  }
  return normalizeText(t);
}

// ---------------------------------------------------------------- anchoring

type FieldResult = { ok: true; val: string } | { ok: false; reason: "EMPTY_FIELD" | "TOO_LONG" };

function field(v: unknown, max: number): FieldResult {
  if (typeof v !== "string") return { ok: false, reason: "EMPTY_FIELD" };
  const t = v.trim();
  if (t === "") return { ok: false, reason: "EMPTY_FIELD" };
  if (t.length > max) return { ok: false, reason: "TOO_LONG" };
  return { ok: true, val: t };
}

/** Keeps only claims that can be traced to the document. `proposed` is untrusted input (for example model output). */
export function anchorClaims(documentText: string, proposed: unknown[]): { claims: Claim[]; rejected: Rejected[] } {
  const claims: Claim[] = [];
  const rejected: Rejected[] = [];
  const doc = documentText.normalize("NFKC").replace(/\s+/g, " ").toLowerCase();
  proposed.forEach((raw, index) => {
    if (claims.length >= LIMITS.MAX_CLAIMS) {
      rejected.push({ index, reason: "TOO_MANY_CLAIMS" });
      return;
    }
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
      rejected.push({ index, reason: "NOT_AN_OBJECT" });
      return;
    }
    const r = raw as Record<string, unknown>;
    const parts = [
      field(r["subject"], LIMITS.MAX_FIELD_CHARS),
      field(r["attribute"], LIMITS.MAX_FIELD_CHARS),
      field(r["period"], LIMITS.MAX_FIELD_CHARS),
      field(r["value_text"], LIMITS.MAX_FIELD_CHARS),
      field(r["quote"], LIMITS.MAX_QUOTE_CHARS),
    ];
    const bad = parts.find((p) => !p.ok);
    if (bad && !bad.ok) {
      rejected.push({ index, reason: bad.reason });
      return;
    }
    const [subject, attribute, period, valueText, quote] = parts.map((p) => (p.ok ? p.val : "")) as [string, string, string, string, string];
    const unitRaw = r["unit"];
    if (typeof unitRaw !== "string") {
      rejected.push({ index, reason: "EMPTY_FIELD" });
      return;
    }
    if (unitRaw.length > LIMITS.MAX_FIELD_CHARS) {
      rejected.push({ index, reason: "TOO_LONG" });
      return;
    }
    const q = quote.normalize("NFKC").replace(/\s+/g, " ").toLowerCase();
    if (!doc.includes(q)) {
      rejected.push({ index, reason: "QUOTE_NOT_IN_DOCUMENT" });
      return;
    }
    const v = valueText.normalize("NFKC").replace(/\s+/g, " ").toLowerCase();
    if (!q.includes(v)) {
      rejected.push({ index, reason: "VALUE_NOT_IN_QUOTE" });
      return;
    }
    // The subject must be named in the quote, so a label cannot be attached to a figure that belongs to someone else.
    const sub = subject.normalize("NFKC").replace(/\s+/g, " ").toLowerCase();
    if (!q.includes(sub)) {
      rejected.push({ index, reason: "SUBJECT_NOT_IN_QUOTE" });
      return;
    }
    claims.push({
      subject, attribute, period,
      value: parseValue(valueText),
      unit: normalizeText(unitRaw),
      quote,
      key: claimKey(subject, attribute, period),
    });
  });
  return { claims, rejected };
}

// ---------------------------------------------------------------- verification against the ledger

function isoDate(s: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(s);
}

function isCurrent(f: LedgerFact, snapshotDate: string): boolean {
  if (f.valid_from !== undefined && isoDate(f.valid_from) && snapshotDate < f.valid_from) return false;
  if (f.valid_to !== undefined && isoDate(f.valid_to) && snapshotDate > f.valid_to) return false;
  return true;
}

function sameValue(a: number | string, b: number | string): boolean {
  if (typeof a === "number" && typeof b === "number") return a === b;
  if (typeof a === "string" && typeof b === "string") return normalizeText(a) === normalizeText(b);
  return false; // a number never equals text
}

export function verifyClaims(claims: readonly Claim[], ledger: Ledger): { items: VerifiedClaim[]; ledgerFlags: string[] } {
  const ledgerFlags: string[] = [];
  const current = ledger.facts.filter((f) => isCurrent(f, ledger.snapshot_date));
  if (ledger.facts.length === 0) ledgerFlags.push("LEDGER_EMPTY");
  else if (current.length === 0) ledgerFlags.push("STALE_EVIDENCE_ONLY");
  else if (current.length < ledger.facts.length) ledgerFlags.push("SOME_EVIDENCE_STALE");

  // Identical claims (same key, value and unit) count once.
  const groups = new Map<string, { claim: Claim; occurrences: number }>();
  for (const c of claims) {
    const id = JSON.stringify([c.key, c.value, c.unit]);
    const g = groups.get(id);
    if (g) g.occurrences++;
    else groups.set(id, { claim: c, occurrences: 1 });
  }

  const items: VerifiedClaim[] = [];
  for (const { claim, occurrences } of groups.values()) {
    const flags: string[] = [];
    const matching = current.filter((f) => claimKey(f.subject, f.attribute, f.period) === claim.key && normalizeText(f.unit) === claim.unit);
    let status: EvidenceStatus;
    if (matching.length === 0) {
      status = "INSUFFICIENT_EVIDENCE";
      if (ledger.facts.length === 0) flags.push("LEDGER_EMPTY");
      else if (ledger.facts.some((f) => claimKey(f.subject, f.attribute, f.period) === claim.key)) flags.push("NO_CURRENT_OR_UNIT_MATCH");
    } else {
      const distinct: (number | string)[] = [];
      for (const f of matching) if (!distinct.some((d) => sameValue(d, f.value))) distinct.push(f.value);
      const only = distinct[0] as number | string;
      if (distinct.length > 1) status = "AMBIGUOUS_CONFLICT";
      else if (typeof only !== typeof claim.value) {
        // A number cannot be compared with text (for example "12 thousand" against 12000): report it, do not guess.
        status = "INSUFFICIENT_EVIDENCE";
        flags.push("VALUE_TYPE_MISMATCH");
      } else status = sameValue(claim.value, only) ? "SUPPORTED" : "CONTRADICTED";
    }
    items.push({ claim, occurrences, status, fact_ids: matching.map((f) => f.id), flags });
  }
  return { items, ledgerFlags };
}

// ---------------------------------------------------------------- x2

export type X2Result =
  | { x2: number; counts: Record<EvidenceStatus, number>; n_claims: number }
  | { x2: "INCOMPLETE"; reason: "UNCHECKED_COVERAGE_FAILURE" | "LOW_CLAIM_COVERAGE"; counts: Record<EvidenceStatus, number>; n_claims: number };

/** x2 = (N_contradicted + 0.5 N_ambiguous + 0.5 N_insufficient) / N_claims, computed as an exact fraction
 *  of integers so there is a single division. Zero or implausibly few claims is a coverage failure, never 0. */
export function computeX2(items: readonly VerifiedClaim[], documentChars: number): X2Result {
  const counts: Record<EvidenceStatus, number> = { SUPPORTED: 0, CONTRADICTED: 0, INSUFFICIENT_EVIDENCE: 0, AMBIGUOUS_CONFLICT: 0 };
  for (const it of items) counts[it.status]++;
  const n = items.length;
  if (n === 0) return { x2: "INCOMPLETE", reason: "UNCHECKED_COVERAGE_FAILURE", counts, n_claims: n };
  const required = Math.max(1, Math.ceil((LIMITS.MIN_CLAIMS_PER_1000_CHARS * documentChars) / 1000));
  if (n < required) return { x2: "INCOMPLETE", reason: "LOW_CLAIM_COVERAGE", counts, n_claims: n };
  const halves =
    STATUS_WEIGHTS_HALVES.CONTRADICTED * counts.CONTRADICTED +
    STATUS_WEIGHTS_HALVES.AMBIGUOUS_CONFLICT * counts.AMBIGUOUS_CONFLICT +
    STATUS_WEIGHTS_HALVES.INSUFFICIENT_EVIDENCE * counts.INSUFFICIENT_EVIDENCE;
  return { x2: halves / (2 * n), counts, n_claims: n };
}
