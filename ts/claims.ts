// MUSE Aegis: typed claims, anchoring, deterministic verification against a reference ledger, and x2.
// Phase 3, step 1. Pure functions, no I/O, no model calls. A model (or a person) proposes RawClaims; everything
// after that is plain code, so the result for a given document, claim list and ledger is always the same.
//
// Trust model: a proposed claim is accepted only if (1) its quote really occurs in the document, (2) its stated
// value and its subject really occur inside that quote, and (3) the value can be read unambiguously. This stops invented claims
// and makes the evidence for every claim traceable to a place in the document. The subject must be named in the quote too.

import { isScaleSlip, parseUnit, sameScaled, scaled } from "./units.ts";

export type EvidenceStatus = "SUPPORTED" | "CONTRADICTED" | "INSUFFICIENT_EVIDENCE" | "AMBIGUOUS_CONFLICT";

export interface RawClaim {
  subject: string;
  attribute: string;
  period: string;
  value_text: string; // the value exactly as written in the document
  unit: string; // e.g. "USD", "KRW", "%", "count", "date", or ""
  quote: string; // an exact passage from the document that states the claim
  label_id?: number | null; // optional: the number of a preferred ledger label this claim is about
}

export interface Claim {
  subject: string;
  attribute: string;
  period: string;
  value: number | string;
  unit: string;
  quote: string;
  key: string; // normalized subject|attribute|period
  at: number; // position of the value in the normalized document: the same figure keeps the same position across runs
  label: number | null; // the preferred ledger label that was used for subject, attribute and period, if any
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
  /** v1.1: other names for the same subject (for example "GCF funding" for "GCF financing"). A claim under any of these names matches this fact. */
  subject_aliases?: string[];
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

const TYPO: Record<string, string> = { "\u2018": "'", "\u2019": "'", "\u02bc": "'", "\u201a": "'", "\u201c": '"', "\u201d": '"', "\u2010": "-", "\u2011": "-", "\u2012": "-", "\u2013": "-", "\u2014": "-", "\u2212": "-", "\u00a0": " ", "\u200b": "", "\u00ad": "" };

/** Folds typographic variants (curly quotes, dashes, the minus sign, no-break and zero-width spaces) and accents, one character at a
 *  time, so the text keeps its length except where a zero-width character is dropped. Matching text this way can only make two
 *  spellings of one name equal ("Côte d’Ivoire" and "Cote d'Ivoire"); it never changes a digit. */
export function foldText(s: string): string {
  let out = "";
  for (const c of s.normalize("NFKC")) {
    const t = TYPO[c];
    if (t !== undefined) { out += t; continue; }
    if (c.charCodeAt(0) > 0x7f) {
      const d = c.normalize("NFD");
      if (d.length > 1 && /^\p{M}+$/u.test(d.slice(1)) && /^[A-Za-z]$/.test(d[0] as string)) { out += d[0]; continue; }
    }
    out += c;
  }
  return out;
}

/** Text as compared in anchoring: folded, white space collapsed, lower case. */
const norm = (s: string): string => foldText(s).replace(/\s+/g, " ").toLowerCase();

export function normalizeText(s: string): string {
  return foldText(s).trim().replace(/\s+/g, " ").toLowerCase();
}

/** The keys under which a ledger fact can be matched: its own subject and each alias of it. */
export function factKeys(f: LedgerFact): string[] {
  return [f.subject, ...(Array.isArray(f.subject_aliases) ? f.subject_aliases : [])].map((s) => claimKey(s, f.attribute, f.period));
}

export function claimKey(subject: string, attribute: string, period: string): string {
  return `${normalizeText(subject)}|${normalizeText(attribute)}|${normalizeText(period)}`;
}

const NUMBER_TEXT = /^[$€£¥₩]?\s*(-?(?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d+)?)\s*%?$/;

/** Reads a value as written. Plain numbers (with thousands commas, an optional leading currency symbol or a
 *  trailing %) become numbers; anything else becomes normalized text. Wording such as "12 thousand" stays text,
 *  so it will not match a numeric ledger value and is reported, never silently converted. */
export function parseValue(valueText: string): number | string {
  const t = foldText(valueText).trim();
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

// ---------------------------------------------------------------- relaxed anchoring (v1.1)

export const RELAXED = {
  MIN_TOKENS: 3, // a shorter quote must match word for word
  MAX_GAP_TOKENS: 6, // words of the document that may lie between two consecutive words of the quote
  MAX_SPAN_CHARS: 1200, // the matched stretch of the document may not be longer than this
} as const;

/** True when `sub` occurs in `text` as whole words: the characters next to it are not letters or digits ("vendor a" is not in "vendor ab"). */
export function hasWholeWord(text: string, sub: string): boolean {
  if (sub === "") return false;
  const isWordChar = (c: string | undefined): boolean => c !== undefined && /[\p{L}\p{N}]/u.test(c);
  const first = [...sub][0];
  const last = [...sub].at(-1);
  for (let at = text.indexOf(sub); at >= 0; at = text.indexOf(sub, at + 1)) {
    const before = at > 0 ? text[at - 1] : undefined;
    const after = text[at + sub.length];
    if ((!isWordChar(first) || !isWordChar(before)) && (!isWordChar(last) || !isWordChar(after))) return true;
  }
  return false;
}

/** Index of the first place where `v` stands in `text` as a whole figure, or -1: a figure that begins or ends with a digit may not be cut out of a
 *  longer figure ("0" and "15" are not in "15,000", "12,000" is not in "12,000.50"). Values that are not figures are searched as plain text. */
export function indexOfWholeNumber(text: string, v: string): number {
  if (v === "") return -1;
  const dig = (c: string | undefined): boolean => c !== undefined && c >= "0" && c <= "9";
  const startsDigit = dig(v[0]);
  const endsDigit = dig(v[v.length - 1]);
  for (let at = text.indexOf(v); at >= 0; at = text.indexOf(v, at + 1)) {
    const b = text[at - 1], b2 = text[at - 2], a = text[at + v.length], a2 = text[at + v.length + 1];
    const badBefore = startsDigit && (dig(b) || ((b === "," || b === ".") && dig(b2)));
    const badAfter = endsDigit && (dig(a) || ((a === "," || a === ".") && dig(a2)));
    if (!badBefore && !badAfter) return at;
  }
  return -1;
}

export interface AnchorOptions {
  /** v1.1, off by default: the value must stand in the quote as a whole figure, not as a piece of a longer one. */
  wholeNumberValue?: boolean;
  /** v1.1, off by default: the subject must occur in the quote as whole words, so "Vendor A" does not match a quote about "Vendor AB". */
  wholeWordSubject?: boolean;
  /** v1.1: if the quote is not found word for word, accept it when all its words occur in order within one short stretch of the document. */
  relaxed?: boolean;
}

export interface RejectedSample {
  index: number;
  reason: RejectReason;
  quote: string; // the model's quote, cut to 160 characters, so a rejection can be understood
}

const edgePunct = /^[\s"'“”‘’()\[\]{}<>|;:!?…·•*,.\-–—]+|[\s"'“”‘’()\[\]{}<>|;:!?…·•*,.\-–—]+$/g;
function tokenKey(t: string): string {
  return t.replace(edgePunct, "");
}

/** Finds `quote` in `doc` (both already normalized: one space between words, lower case).
 *  Returns the start and end of the document text that matched, or null.
 *  Exact: the quote occurs word for word. Ordered: every word of the quote occurs in the same order, with at most
 *  MAX_GAP_TOKENS other words between neighbours, so that a table row whose cells were split across lines can still be traced.
 *  The first match in the document wins, the same as for an exact match. */
export function locateQuote(doc: string, quote: string): { start: number; end: number; mode: "exact" | "ordered" } | null {
  const at = doc.indexOf(quote);
  if (at >= 0) return { start: at, end: at + quote.length, mode: "exact" };
  const qt = quote.split(" ").map(tokenKey).filter((t) => t !== "");
  if (qt.length < RELAXED.MIN_TOKENS) return null;
  const words: { key: string; start: number; end: number }[] = [];
  let pos = 0;
  for (const w of doc.split(" ")) {
    const k = tokenKey(w);
    if (k !== "") words.push({ key: k, start: pos, end: pos + w.length });
    pos += w.length + 1;
  }
  const first = qt[0] as string;
  for (let i = 0; i < words.length; i++) {
    if ((words[i] as { key: string }).key !== first) continue;
    let j = i, ok = true;
    for (let q = 1; q < qt.length && ok; q++) {
      let found = -1;
      for (let g = 1; g <= RELAXED.MAX_GAP_TOKENS + 1 && j + g < words.length; g++) {
        if ((words[j + g] as { key: string }).key === qt[q]) { found = j + g; break; }
      }
      if (found < 0) ok = false;
      else j = found;
    }
    if (!ok) continue;
    const start = (words[i] as { start: number }).start, end = (words[j] as { end: number }).end;
    if (end - start <= RELAXED.MAX_SPAN_CHARS) return { start, end, mode: "ordered" };
  }
  return null;
}

/** v1.1 (relaxed mode only): the section context that the table reader puts in front of a repaired row, as in
 *  "[E.1. GCF financing > (b) Requested amount] Morocco Grants ...". Returns, for every such line, where it lies in the
 *  normalized document and its context text. The context comes from the document's own headings and row labels. */
function rowContexts(documentText: string, doc: string): { start: number; end: number; context: string }[] {
  const out: { start: number; end: number; context: string }[] = [];
  let from = 0;
  for (const raw of documentText.split("\n")) {
    const line = norm(raw).trim();
    if (line === "") continue;
    const at = doc.indexOf(line, from);
    if (at < 0) continue;
    from = at + line.length;
    const m = /^\[([^\]]{1,160})\]/.exec(line);
    if (m) out.push({ start: at, end: at + line.length, context: m[1] as string });
  }
  return out;
}

/** Keeps only claims that can be traced to the document. `proposed` is untrusted input (for example model output). */
export function anchorClaims(
  documentText: string,
  proposed: unknown[],
  labels?: readonly { subject: string; attribute: string; period: string }[],
  options?: AnchorOptions,
): { claims: Claim[]; rejected: Rejected[]; relaxed: number[]; samples: RejectedSample[] } {
  const claims: Claim[] = [];
  const rejected: Rejected[] = [];
  const relaxed: number[] = []; // indexes of proposed claims accepted by the relaxed match (v1.1 only)
  const samples: RejectedSample[] = []; // up to 8 rejected quotes, to explain why claims were rejected
  const relaxedOn = options?.relaxed === true;
  const reject = (index: number, reason: RejectReason, raw?: unknown) => {
    rejected.push({ index, reason });
    const qv = typeof raw === "object" && raw !== null && !Array.isArray(raw) ? (raw as Record<string, unknown>)["quote"] : undefined;
    if (samples.length < 8 && typeof qv === "string") samples.push({ index, reason, quote: qv.slice(0, 160) });
  };
  const doc = norm(documentText);
  const contexts = relaxedOn ? rowContexts(documentText, doc) : [];
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
    const q = norm(quote);
    const loc = relaxedOn ? locateQuote(doc, q) : (doc.includes(q) ? { start: doc.indexOf(q), end: doc.indexOf(q) + q.length, mode: "exact" as const } : null);
    if (!loc) {
      reject(index, "QUOTE_NOT_IN_DOCUMENT", raw);
      return;
    }
    // The value and the subject must be in the quote and also lie inside the text of the document that the quote was matched to.
    const span = doc.slice(loc.start, loc.end);
    const v = norm(valueText);
    const whole = options?.wholeNumberValue === true;
    if (whole ? indexOfWholeNumber(q, v) < 0 || indexOfWholeNumber(span, v) < 0 : !q.includes(v) || !span.includes(v)) {
      reject(index, "VALUE_NOT_IN_QUOTE", raw);
      return;
    }
    // The subject must be named in the quote, so a label cannot be attached to a figure that belongs to someone else.
    const sub = norm(subject);
    let inContext = false;
    let ctx = "";
    const has = (t: string): boolean => (options?.wholeWordSubject === true ? hasWholeWord(t, sub) : t.includes(sub));
    if (!has(q) || !has(span)) {
      // v1.1: a row that the table reader prefixed with its section heading and row label may take its subject from that
      // context, because the model often leaves the bracketed prefix out of its quote. The claim then shows the prefix.
      const row = relaxedOn ? contexts.find((c) => c.start <= loc.start && loc.start < c.end) : undefined;
      if (row && sub !== "" && has(row.context)) { inContext = true; ctx = row.context; }
      else {
        reject(index, "SUBJECT_NOT_IN_QUOTE", raw);
        return;
      }
    }
    if (loc.mode === "ordered") relaxed.push(index);
    // A claim may pick one of the preferred ledger labels by number. The labels are then used exactly as the ledger writes them, so
    // wording drift cannot stop a claim from matching its ledger fact. The label's subject must still be named in the quote;
    // otherwise the pick is ignored and the model's own wording is used.
    let useLabel: number | null = null;
    const pick = r["label_id"];
    if (labels && typeof pick === "number" && Number.isInteger(pick) && pick >= 0 && pick < labels.length) {
      const lab = labels[pick] as { subject: string; attribute: string; period: string };
      if (span.includes(normalizeText(lab.subject)) || (inContext && ctx.includes(normalizeText(lab.subject)))) useLabel = pick;
    }
    const lab = useLabel === null ? null : (labels as readonly { subject: string; attribute: string; period: string }[])[useLabel];
    const fs = lab ? lab.subject : subject, fa = lab ? lab.attribute : attribute, fp = lab ? lab.period : period;
    claims.push({
      subject: fs, attribute: fa, period: fp,
      value: parseValue(valueText),
      unit: normalizeText(unitRaw),
      quote: inContext ? `[${ctx}] ${span}` : loc.mode === "ordered" ? span : quote, // relaxed match: the evidence is the document's own text
      key: claimKey(fs, fa, fp),
      at: loc.start + (whole ? indexOfWholeNumber(span, v) : span.indexOf(v)),
      label: useLabel,
    });
  });
  return { claims, rejected, relaxed, samples };
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
    const cu = parseUnit(claim.unit);
    const sameKey = current.filter((f) => factKeys(f).includes(claim.key));
    // v1.1: units are compared as a base unit plus a scale ("million usd" is usd with a multiplier of 1e6)
    const matching = sameKey.filter((f) => parseUnit(f.unit).base === cu.base);
    let status: EvidenceStatus;
    if (matching.length === 0) {
      status = "INSUFFICIENT_EVIDENCE";
      if (ledger.facts.length === 0) flags.push("LEDGER_EMPTY");
      else if (ledger.facts.some((f) => factKeys(f).includes(claim.key))) flags.push("NO_CURRENT_OR_UNIT_MATCH");
    } else {
      const on = (f: LedgerFact) => { const fu = parseUnit(f.unit); return { v: scaled(f.value, fu.mult), involved: fu.mult !== 1 || cu.mult !== 1 }; };
      const cv = scaled(claim.value, cu.mult);
      const distinct: { raw: number | string; n: number | null; involved: boolean }[] = [];
      for (const f of matching) {
        const o = on(f);
        const same = distinct.some((d) => (d.n !== null && o.v !== null ? sameScaled(d.n, o.v, d.involved || o.involved) : d.n === null && o.v === null && sameValue(d.raw, f.value)));
        if (!same) distinct.push({ raw: f.value, n: o.v, involved: o.involved });
      }
      const only = distinct[0] as { raw: number | string; n: number | null; involved: boolean };
      if (distinct.length > 1) status = "AMBIGUOUS_CONFLICT";
      else if (typeof only.raw !== typeof claim.value) {
        // A number cannot be compared with text (for example "12 thousand" against 12000): report it, do not guess.
        status = "INSUFFICIENT_EVIDENCE";
        flags.push("VALUE_TYPE_MISMATCH");
      } else if (only.n !== null && cv !== null) {
        if (sameScaled(cv, only.n, only.involved)) status = "SUPPORTED";
        else if (isScaleSlip(cv, only.n)) {
          // The figure equals the ledger value except for a factor of 1,000, 1,000,000 or 1,000,000,000: the document's unit or
          // scale is unclear (for example a table in millions read as units). Report it as unchecked, never as a contradiction.
          status = "INSUFFICIENT_EVIDENCE";
          flags.push("SCALE_UNCERTAIN");
        } else status = "CONTRADICTED";
      } else status = sameValue(claim.value, only.raw) ? "SUPPORTED" : "CONTRADICTED";
    }
    items.push({ claim, occurrences, status, fact_ids: matching.map((f) => f.id), flags });
  }
  return { items, ledgerFlags };
}

// ---------------------------------------------------------------- x2

export type X2Result =
  | { x2: number; counts: Record<EvidenceStatus, number>; n_claims: number }
  | { x2: "INCOMPLETE"; reason: "UNCHECKED_COVERAGE_FAILURE" | "LOW_CLAIM_COVERAGE"; counts: Record<EvidenceStatus, number>; n_claims: number };

/** The fewest claims a document of this length must yield before x2 is computed. */
export function requiredClaims(documentChars: number): number {
  return Math.max(1, Math.ceil((LIMITS.MIN_CLAIMS_PER_1000_CHARS * documentChars) / 1000));
}

/** x2 = (N_contradicted + 0.5 N_ambiguous + 0.5 N_insufficient) / N_claims, computed as an exact fraction
 *  of integers so there is a single division. Zero or implausibly few claims is a coverage failure, never 0. */
export function computeX2(items: readonly VerifiedClaim[], documentChars: number): X2Result {
  const counts: Record<EvidenceStatus, number> = { SUPPORTED: 0, CONTRADICTED: 0, INSUFFICIENT_EVIDENCE: 0, AMBIGUOUS_CONFLICT: 0 };
  for (const it of items) counts[it.status]++;
  const n = items.length;
  if (n === 0) return { x2: "INCOMPLETE", reason: "UNCHECKED_COVERAGE_FAILURE", counts, n_claims: n };
  const required = requiredClaims(documentChars);
  if (n < required) return { x2: "INCOMPLETE", reason: "LOW_CLAIM_COVERAGE", counts, n_claims: n };
  const halves =
    STATUS_WEIGHTS_HALVES.CONTRADICTED * counts.CONTRADICTED +
    STATUS_WEIGHTS_HALVES.AMBIGUOUS_CONFLICT * counts.AMBIGUOUS_CONFLICT +
    STATUS_WEIGHTS_HALVES.INSUFFICIENT_EVIDENCE * counts.INSUFFICIENT_EVIDENCE;
  return { x2: halves / (2 * n), counts, n_claims: n };
}
