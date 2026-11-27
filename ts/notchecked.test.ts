import { test } from "node:test";
import assert from "node:assert/strict";
import { buildNotCheckedReport } from "./notchecked.ts";
import { claimKey, computeX2 } from "./claims.ts";
import type { Claim, Ledger, VerifiedClaim } from "./claims.ts";
import type { RunSummary } from "./stability.ts";

const claim = (over: Partial<Claim> = {}): Claim => ({
  subject: "GCF financing", attribute: "committed amount", period: "total", value: 100, unit: "usd", quote: "q",
  key: claimKey("GCF financing", "committed amount", "total"), at: 5, label: null, ...over,
});
const item = (status: VerifiedClaim["status"], over: Partial<VerifiedClaim> = {}, c: Partial<Claim> = {}): VerifiedClaim =>
  ({ claim: claim(c), occurrences: 1, status, fact_ids: [], flags: [], ...over });
const ledger = (n: number): Ledger => ({
  snapshot_id: "L", snapshot_date: "2026-11-01",
  facts: Array.from({ length: n }, (_, i) => ({ id: `F${i + 1}`, subject: "GCF financing", attribute: "committed amount", period: "total", value: 100, unit: "usd" })),
});
const okRun = (over: Partial<RunSummary> = {}): RunSummary => ({ ok: true, claims: 2, rejected: 0, ...over });

test("a complete, fully compared screening has no lines", () => {
  const items = [item("SUPPORTED", { fact_ids: ["F1"] }), item("SUPPORTED", { fact_ids: ["F2"] }, { period: "2026" })];
  const r = buildNotCheckedReport({ ledger: ledger(2), items, x2: computeX2(items, 1000), runs: [okRun(), okRun(), okRun()], k: 3, documentChars: 1000, profile: { x1: 0.1, x2: 0, x4: 0.1, x5: 0.1, x6: 0 } });
  assert.deepEqual(r.lines, []);
  assert.equal(r.ledger_facts_not_compared_total, 0);
  assert.equal(r.coverage.enough, true);
});

test("unmatched figures, uncompared ledger entries, rejected quotes, failed runs and NA parts are each reported", () => {
  const items = [item("INSUFFICIENT_EVIDENCE", { flags: ["NO_CURRENT_OR_UNIT_MATCH"] }), item("SUPPORTED", { fact_ids: ["F1"] })];
  const runs: RunSummary[] = [
    okRun({ rejected: 3, rejected_reasons: { SUBJECT_NOT_IN_QUOTE: 2, VALUE_NOT_IN_QUOTE: 1 }, rejected_samples: [{ reason: "SUBJECT_NOT_IN_QUOTE", quote: "x".repeat(300) }] }),
    { ok: false, code: "EMPTY_RESPONSE", claims: 0, rejected: 0 },
  ];
  const r = buildNotCheckedReport({ ledger: ledger(3), items, x2: computeX2(items, 1000), runs, k: 3, documentChars: 1000, profile: { x1: "INCOMPLETE", x2: 0.5, x4: "NA", x5: 0.1, x6: 0 } });
  assert.equal(r.unmatched_claims_total, 1);
  assert.equal(r.unmatched_claims[0]?.reason, "NO_CURRENT_OR_UNIT_MATCH");
  assert.equal(r.ledger_facts_not_compared_total, 2);
  assert.equal(r.rejected.total, 3);
  assert.equal(r.rejected.samples[0]?.quote.length, 160);
  assert.deepEqual(r.runs.failed_codes, ["EMPTY_RESPONSE"]);
  assert.deepEqual(r.profile_parts_not_computed, ["x1", "x4"]);
  assert.equal(r.lines.length, 5);
  assert.ok(r.lines.some((l) => /could not be compared with the ledger/.test(l)));
  assert.ok(r.lines.some((l) => /2 of 3 ledger entries/.test(l)));
});

test("too few figures: the report says how many were found and how many are needed", () => {
  const items = [item("SUPPORTED", { fact_ids: ["F1"] })];
  const x2 = computeX2(items, 20000);
  assert.equal(x2.x2, "INCOMPLETE");
  const r = buildNotCheckedReport({ ledger: ledger(1), items, x2, runs: [okRun()], k: 1, documentChars: 20000, profile: { x2: "INCOMPLETE" } });
  assert.equal(r.coverage.enough, false);
  assert.match(r.lines[0] ?? "", /Only 1 figure was found .* at least 4 are needed/);
  const none = buildNotCheckedReport({ ledger: ledger(1), items: [], x2: computeX2([], 20000), runs: [okRun()], k: 1, documentChars: 20000, profile: {} });
  assert.match(none.lines[0] ?? "", /No figure could be traced/);
});

test("long lists are cut but the real totals are kept", () => {
  const items = Array.from({ length: 40 }, (_, i) => item("INSUFFICIENT_EVIDENCE", {}, { period: `p${i}` }));
  const r = buildNotCheckedReport({ ledger: ledger(60), items, x2: computeX2(items, 1000), runs: [okRun()], k: 1, documentChars: 1000, profile: {} });
  assert.equal(r.unmatched_claims.length, 25);
  assert.equal(r.unmatched_claims_total, 40);
  assert.equal(r.ledger_facts_not_compared.length, 25);
  assert.equal(r.ledger_facts_not_compared_total, 60);
});

test("a document that states two different values for the same figure is reported, whichever one matches the ledger", () => {
  const items = [
    item("CONTRADICTED", { fact_ids: ["F1"] }, { value: 150 }),
    item("SUPPORTED", { fact_ids: ["F1"] }, { value: 100 }),
    item("SUPPORTED", { fact_ids: ["F2"] }, { subject: "Other", key: claimKey("Other", "committed amount", "total"), value: 5 }),
  ];
  const r = buildNotCheckedReport({ ledger: ledger(2), items, x2: computeX2(items, 1000), runs: [okRun(), okRun(), okRun()], k: 3, documentChars: 1000, profile: { x1: 0.1, x2: 0.3, x4: 0.1, x5: 0.1, x6: 0 } });
  assert.equal(r.document_conflicts_total, 1);
  assert.deepEqual(r.document_conflicts[0]?.values, [150, 100]);
  assert.match(r.lines[0] ?? "", /different values for the same figure in 1 place \(first: GCF financing, committed amount, total: 150 and 100\)/);
  const clean = buildNotCheckedReport({ ledger: ledger(2), items: items.slice(1), x2: computeX2(items.slice(1), 1000), runs: [okRun(), okRun(), okRun()], k: 3, documentChars: 1000, profile: { x1: 0.1, x2: 0, x4: 0.1, x5: 0.1, x6: 0 } });
  assert.equal(clean.document_conflicts_total, 0);
});

test("figures that no claim covers are counted, so a document cut down to one claim shows what was left out", () => {
  const doc = "Spent 27,000 USD on personnel in 2026-Q2 (TX-2026-016). Spent 9,800 USD on equipment. 250 beneficiaries, 12% overhead, 3.5 million. Then 1,000,000 USD.";
  const items = [item("CONTRADICTED", { fact_ids: ["F1"] }, { value: 1000000, quote: "Then 1,000,000 USD." })];
  const r = buildNotCheckedReport({ ledger: ledger(2), items, x2: computeX2(items, 1000), runs: [okRun(), okRun(), okRun()], k: 3, documentChars: 1000, documentText: doc, profile: { x1: 0, x2: 1, x4: 0, x5: 0, x6: 0 } });
  assert.equal(r.figures?.total, 6); // 27,000  9,800  250  12%  3.5  1,000,000 (the year, the quarter and the identifier are not figures)
  assert.equal(r.figures?.covered, 1);
  assert.equal(r.figures?.uncovered_total, 5);
  assert.match(r.lines.join(" "), /1 of 6 figures in the document were turned into claims; 5 were not checked \(for example 27,000; 9,800; 250\)/);
  const none = buildNotCheckedReport({ ledger: ledger(2), items, x2: computeX2(items, 1000), runs: [okRun()], k: 1, documentChars: 1000, profile: { x1: 0, x2: 1, x4: 0, x5: 0, x6: 0 } });
  assert.equal(none.figures, undefined);
});
