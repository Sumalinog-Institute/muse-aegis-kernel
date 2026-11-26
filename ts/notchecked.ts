// MUSE Aegis v1.1: the "could not check" report. A screening result says what was found; this report says what was NOT checked,
// so a clean-looking result cannot hide a thin check. It is derived only from data the screening already holds (no model call),
// it is part of the sealed draft, and every line is plain language that a reviewer can read without the JSON.

import { requiredClaims } from "./claims.ts";
import type { Ledger, LedgerFact, VerifiedClaim, X2Result } from "./claims.ts";
import type { RunSummary } from "./stability.ts";

export const NOT_CHECKED_VERSION = 1;
const MAX_LISTED = 25; // an item list is cut here; the real count is always given

export interface NotCheckedReport {
  report_version: number;
  /** Figures found in the document that could not be compared with the ledger. */
  unmatched_claims: { subject: string; attribute: string; period: string; value: number | string; unit: string; at: number; reason: string }[];
  unmatched_claims_total: number;
  /** Ledger facts that no figure of the document was compared with. */
  ledger_facts_not_compared: { id: string; subject: string; attribute: string; period: string }[];
  ledger_facts_not_compared_total: number;
  ledger_facts_total: number;
  /** Quotes the model proposed that were refused because they could not be traced to the document (all runs together). */
  rejected: { total: number; by_reason: Record<string, number>; samples: { reason: string; quote: string }[] };
  coverage: { claims_found: number; claims_required: number; document_chars: number; enough: boolean };
  runs: { k: number; valid: number; failed_codes: string[] };
  /** Parts of the profile that could not be computed or do not apply ("NA" or incomplete). */
  profile_parts_not_computed: string[];
  /** One sentence for each thing that was not checked, in plain language. Empty only when nothing was left unchecked. */
  lines: string[];
}

export interface NotCheckedInput {
  ledger: Ledger;
  items: readonly VerifiedClaim[];
  x2: X2Result;
  runs: readonly RunSummary[];
  k: number;
  documentChars: number;
  profile: Record<string, unknown>;
}

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

export function buildNotCheckedReport(p: NotCheckedInput): NotCheckedReport {
  const unmatchedAll = p.items.filter((it) => it.status === "INSUFFICIENT_EVIDENCE");
  const reasonOf = (it: VerifiedClaim): string =>
    it.flags.includes("LEDGER_EMPTY") ? "LEDGER_EMPTY"
    : it.flags.includes("SCALE_UNCERTAIN") ? "SCALE_UNCERTAIN"
    : it.flags.includes("VALUE_TYPE_MISMATCH") ? "VALUE_TYPE_MISMATCH"
    : it.flags.includes("NO_CURRENT_OR_UNIT_MATCH") ? "NO_CURRENT_OR_UNIT_MATCH"
    : "NO_LEDGER_FACT";
  const unmatched = unmatchedAll.slice(0, MAX_LISTED).map((it) => ({
    subject: it.claim.subject, attribute: it.claim.attribute, period: it.claim.period, value: it.claim.value, unit: it.claim.unit, at: it.claim.at, reason: reasonOf(it),
  }));

  const compared = new Set<string>();
  for (const it of p.items) for (const id of it.fact_ids) compared.add(id);
  const notCompared: LedgerFact[] = p.ledger.facts.filter((f) => !compared.has(f.id));

  const byReason: Record<string, number> = {};
  const samples: { reason: string; quote: string }[] = [];
  let rejectedTotal = 0;
  for (const r of p.runs) {
    for (const [k, v] of Object.entries(r.rejected_reasons ?? {})) { byReason[k] = (byReason[k] ?? 0) + v; rejectedTotal += v; }
    for (const s of r.rejected_samples ?? []) if (samples.length < 8) samples.push({ reason: s.reason, quote: s.quote.slice(0, 160) });
  }

  const required = requiredClaims(p.documentChars);
  const found = p.x2.n_claims;
  const enough = p.x2.x2 !== "INCOMPLETE";
  const failed = p.runs.filter((r) => !r.ok).map((r) => r.code ?? "UNKNOWN");
  const valid = p.runs.filter((r) => r.ok).length;

  const notComputed: string[] = [];
  for (const [k, v] of Object.entries(p.profile)) {
    if (v === "NA" || v === "INCOMPLETE" || (typeof v === "object" && v !== null && (v as Record<string, unknown>)["x1"] === "INCOMPLETE")) notComputed.push(k);
  }

  const lines: string[] = [];
  if (!enough) {
    lines.push(found === 0
      ? "No figure could be traced to the document, so no factual check was made."
      : `Only ${plural(found, "figure was", "figures were")} found in the document; at least ${required} are needed for a document of this length, so the check is incomplete.`);
  }
  if (unmatchedAll.length > 0) lines.push(`${plural(unmatchedAll.length, "figure was", "figures were")} found in the document but could not be compared with the ledger (no matching ledger entry, or a different unit or period).`);
  const slips = unmatchedAll.filter((it) => it.flags.includes("SCALE_UNCERTAIN")).length;
  if (slips > 0) lines.push(`${plural(slips, "figure equals", "figures equal")} a ledger value except for a factor of 1,000, 1,000,000 or 1,000,000,000, so the unit or scale in the document is unclear; ${slips === 1 ? "it was" : "they were"} not counted as contradictions.`);
  if (notCompared.length > 0 && p.ledger.facts.length > 0) lines.push(`${notCompared.length} of ${p.ledger.facts.length} ledger entries were not compared with any figure of the document.`);
  if (rejectedTotal > 0) lines.push(`${plural(rejectedTotal, "quote", "quotes")} proposed by the model over ${plural(p.runs.length, "run", "runs")} could not be traced to the document and were left out.`);
  if (failed.length > 0) lines.push(`${plural(failed.length, "run", "runs")} of ${p.k} failed (${[...new Set(failed)].join(", ")}).`);
  if (notComputed.length > 0) lines.push(`These parts of the profile could not be computed or do not apply: ${notComputed.join(", ")}.`);

  return {
    report_version: NOT_CHECKED_VERSION,
    unmatched_claims: unmatched, unmatched_claims_total: unmatchedAll.length,
    ledger_facts_not_compared: notCompared.slice(0, MAX_LISTED).map((f) => ({ id: f.id, subject: f.subject, attribute: f.attribute, period: f.period })),
    ledger_facts_not_compared_total: notCompared.length, ledger_facts_total: p.ledger.facts.length,
    rejected: { total: rejectedTotal, by_reason: byReason, samples },
    coverage: { claims_found: found, claims_required: required, document_chars: p.documentChars, enough },
    runs: { k: p.k, valid, failed_codes: failed },
    profile_parts_not_computed: notComputed,
    lines,
  };
}
