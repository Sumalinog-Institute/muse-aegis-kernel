import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { evaluate } from "./kernel.ts";
import { prepareScreening } from "./screening.ts";
import type { PrepareDeps } from "./screening.ts";
import { issuesFromDraft, levelOfDecision, mean, refMatches, scoreIssues, sd, summarizeDraft, summarizeGroup, summarizeRuns } from "./benchmark.ts";
import type { Issue, PlantedIssues, RunRecord } from "./benchmark.ts";

const bundle = JSON.parse(readFileSync(new URL("../fixtures/grant-xx-nmf-0001-2026-014/benchmark-bundle.json", import.meta.url), "utf8"));
const sc = (id: string) => bundle.scenarios.find((s: { id: string }) => s.id === id);

// ---------------------------------------------------------------- matching

test("identifiers must match whole; names and subjects match by shared words", () => {
  const yes: [string, string][] = [
    ["R2", "R2"], ["Report R2 was late", "R2"], ["r2", "R2"], ["TX-2026-013", "TX-2026-013"], ["tx-2026-013 (tablets)", "TX-2026-013"],
    ["Training", "Training and workshops"], ["training and workshops spending", "Training and workshops"], ["Q2 report", "Q2 financial and narrative report"],
    ["Northgate Supply", "Northgate Supply Company"], ["NORTHGATE SUPPLY CO.", "Northgate Supply Company"],
    ["Supply", "Northgate Supply Company"], // lenient by design: half of the distinctive words is enough, which can only favour the judge
  ];
  for (const [f, e] of yes) assert.equal(refMatches(f, e), true, `${f} / ${e}`);
  const no: [string, string][] = [
    ["R25", "R2"], ["R2x", "R2"], ["TX-2026-0130", "TX-2026-013"], ["TX-2026-01", "TX-2026-013"], ["Equipment", "Training and workshops"],
    ["Rent and utilities", "Training and workshops"], ["the report", "Q2 financial and narrative report"],
    ["", "R2"], ["R2", ""], ["Alliance", "Northgate Supply Company"],
    ["Q2 budget", "Q2 plan"], // half the words match, but only a short one: not enough
  ];
  for (const [f, e] of no) assert.equal(refMatches(f, e), false, `${f} / ${e}`);
});

const truth: PlantedIssues = {
  expected: [
    { category: "MISSING_DOCUMENT", ref: "TX-2026-013" }, { category: "REPORT_LATE", ref: "R2" },
    { category: "WATCHLIST_MATCH", ref: "Northgate Supply Company" }, { category: "NARRATIVE_MISMATCH", ref: "Training and workshops" },
  ],
  tolerated: [{ category: "MISSING_DOCUMENT", ref: "TX-2026-018" }, { category: "*", ref: "beneficiaries" }],
};
const is = (category: Issue["category"], ref: string): Issue => ({ category, ref });

test("scoring: a perfect list, a partial list, false alarms, tolerated mentions and repeats", () => {
  const perfect = scoreIssues(truth.expected, truth);
  assert.deepEqual([perfect.recall, perfect.precision, perfect.false_alarms.length, perfect.missed.length], [1, 1, 0, 0]);
  const partial = scoreIssues([is("MISSING_DOCUMENT", "TX-2026-013"), is("REPORT_LATE", "R2")], truth);
  assert.deepEqual([partial.recall, partial.precision, partial.missed.length], [0.5, 1, 2]);
  const noisy = scoreIssues([is("MISSING_DOCUMENT", "TX-2026-013"), is("MISSING_DOCUMENT", "TX-2026-099"), is("REPORT_MISSING", "R9")], truth);
  assert.deepEqual([noisy.recall, noisy.false_alarms.length, noisy.precision], [0.25, 2, 1 / 3]);
  // tolerated items (a pending invoice, an unverifiable statement) are neither found problems nor false alarms
  const tol = scoreIssues([is("MISSING_DOCUMENT", "TX-2026-018"), is("OTHER", "beneficiaries"), is("NARRATIVE_MISMATCH", "250 beneficiaries")], truth);
  assert.deepEqual([tol.recall, tol.false_alarms.length, tol.precision], [0, 0, null]);
  // the same finding twice counts once
  const twice = scoreIssues([is("REPORT_LATE", "R2"), is("REPORT_LATE", "r2")], truth);
  assert.deepEqual([twice.matched.length, twice.false_alarms.length], [1, 0]);
  // a false alarm repeated is still one false alarm
  assert.equal(scoreIssues([is("OTHER", "unrelated thing"), is("OTHER", "Unrelated Thing")], truth).false_alarms.length, 1);
  // an OTHER category is accepted for the right record; a wrong specific category is not
  assert.equal(scoreIssues([is("OTHER", "TX-2026-013")], truth).recall, 0.25);
  assert.equal(scoreIssues([is("REPORT_LATE", "TX-2026-013")], truth).recall, 0);
  // nothing planted: recall is undefined, anything counted is a false alarm
  const clean = scoreIssues([is("REPORT_LATE", "R2")], { expected: [], tolerated: [] });
  assert.deepEqual([clean.recall, clean.false_alarms.length, clean.precision], [null, 1, 0]);
  assert.deepEqual(scoreIssues([], { expected: [], tolerated: [] }), { recall: null, matched: [], missed: [], false_alarms: [], precision: null });
});

test("decisions map to four levels", () => {
  assert.equal(levelOfDecision("SCREENING_PASS_PENDING_STANDARD_CONTROLS"), "PASS");
  for (const d of ["FLAG_FOR_REVIEW", "DOCUMENTATION_HOLD_PENDING_REVIEW", "INCOMPLETE_INPUT_MANUAL_REVIEW"]) assert.equal(levelOfDecision(d), "REVIEW");
  assert.equal(levelOfDecision("ALERT_VERIFICATION_REQUIRED"), "ALERT");
  assert.equal(levelOfDecision("RESTRICTION_RECOMMENDED_PENDING_AUTHORITY"), "RESTRICT");
  assert.equal(levelOfDecision("SOMETHING_ELSE"), null);
});

// ---------------------------------------------------------------- the pipeline over every scenario

const claimsFor = (narrative: string): unknown[] => {
  const out: unknown[] = [];
  const labels: Record<string, string> = { personnel: "Personnel", equipment: "Equipment", "training and workshops": "Training and workshops", "rent and utilities": "Rent and utilities" };
  for (const line of narrative.split("\n")) {
    let m = /spent ([\d,]+) USD on (personnel|equipment|training and workshops|rent and utilities)/.exec(line);
    if (m) out.push({ subject: labels[m[2] as string], attribute: "amount spent", period: "2026-Q2", value_text: m[1], unit: "USD", quote: line.trim() });
    m = /report was submitted on (\d{4}-\d{2}-\d{2})/.exec(line);
    if (m) out.push({ subject: "Q2 financial and narrative report", attribute: "submitted on", period: "2026", value_text: m[1], unit: "date", quote: line.trim() });
    m = /reached (\d+) beneficiaries/.exec(line);
    if (m) out.push({ subject: "beneficiaries", attribute: "number reached", period: "2026", value_text: m[1], unit: "count", quote: line.trim() });
  }
  return out;
};
const okReply = (claims: unknown[]) =>
  new Response(JSON.stringify({ candidates: [{ finishReason: "STOP", content: { parts: [{ text: JSON.stringify({ claims }) }] } }], usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 1 } }), { status: 200 });
async function prepare(id: string) {
  const s = sc(id);
  const claims = claimsFor(s.inputs.documentText);
  const fetchFn = (async () => okReply(claims)) as unknown as typeof fetch;
  const deps = { fetchFn, sleep: async () => {}, now: () => new Date(Date.UTC(2026, 9, 27)), evaluate: evaluate as unknown as PrepareDeps["evaluate"] } as PrepareDeps;
  const r = await prepareScreening(deps, { apiKey: "AIzaSyTEST_KEY_DO_NOT_LEAK_0123456789", model: "m", actorId: "u", inputs: s.inputs });
  if (!r.ok) throw new Error("prepare failed " + r.code);
  return r.draft;
}

const RECALL: Record<string, number | null> = { "s0-as-delivered": 1, "s1-clean": null, "s2-documentation-gaps": 1, "s3-confirmed-match": 1, "s4-conflicting-match": 1, "s5-mixed-currency": 5 / 7, "s6-small-sample": 1, "s7-ledger-incomplete": 5 / 7 };

for (const s of bundle.scenarios) {
  test(`pipeline on ${s.id}: the problems it reports are scored against the planted ones`, async () => {
    const draft = await prepare(s.id);
    const found = issuesFromDraft(draft);
    const score = scoreIssues(found, s.planted);
    assert.equal(score.recall, RECALL[s.id], `recall ${s.id}`);
    assert.equal(score.false_alarms.length, 0, `false alarms ${s.id}: ${JSON.stringify(score.false_alarms)}`);
    const sum = summarizeDraft(draft);
    assert.equal(sum.decision, draft.result["decision"]);
    assert.equal(sum.level, levelOfDecision(sum.decision));
    assert.equal(sum.score, typeof draft.result["psi"] === "number" ? (draft.result["psi"] as number) * 100 : null);
    assert.deepEqual(sum.issues, found);
  });
}

test("pipeline: baseline issues and levels, hand-listed", async () => {
  const s0 = summarizeDraft(await prepare("s0-as-delivered"));
  assert.deepEqual(s0.issues, [
    { category: "MISSING_DOCUMENT", ref: "TX-2026-013" }, { category: "MISSING_DOCUMENT", ref: "TX-2026-033" },
    { category: "REPORT_LATE", ref: "R2" }, { category: "REPORT_MISSING", ref: "R3" },
    { category: "WATCHLIST_MATCH", ref: "Northgate Supply Company" },
    { category: "NARRATIVE_MISMATCH", ref: "Training and workshops" }, { category: "NARRATIVE_MISMATCH", ref: "Q2 financial and narrative report" },
  ]);
  assert.equal(s0.level, "ALERT");
  assert.ok(Math.abs((s0.score as number) - 77.53) < 0.01);
  assert.equal(summarizeDraft(await prepare("s1-clean")).level, "PASS");
  assert.equal(summarizeDraft(await prepare("s3-confirmed-match")).level, "RESTRICT");
  assert.deepEqual(summarizeDraft(await prepare("s1-clean")).issues, []);
});

// ---------------------------------------------------------------- statistics

test("mean and sample standard deviation", () => {
  assert.equal(mean([]), null);
  assert.equal(mean([1, 2, 3, 4]), 2.5);
  assert.equal(sd([]), null);
  assert.equal(sd([5]), 0);
  assert.equal(sd([2, 4, 4, 4, 5, 5, 7, 9]), Math.sqrt(32 / 7));
  assert.equal(sd([3, 3, 3]), 0);
});

const run = (scenario: string, method: "judge" | "pipeline", repeat: number, score: number | null, level: RunRecord["level"], extra: Partial<RunRecord> = {}): RunRecord =>
  ({ scenario, method, repeat, ok: true, score, level, found: [], recall: 1, false_alarms: 0, ...extra });

test("group summary: spread, level agreement, failures and recall", () => {
  const g = summarizeGroup("s0", "judge", [
    run("s0", "judge", 1, 60, "ALERT"), run("s0", "judge", 2, 70, "ALERT"), run("s0", "judge", 3, 80, "REVIEW", { recall: 0.5, false_alarms: 2 }),
    { scenario: "s0", method: "judge", repeat: 4, ok: false, code: "TIMEOUT", score: null, level: null, found: [], recall: null, false_alarms: 0 },
  ]);
  assert.deepEqual([g.runs, g.failed], [3, 1]);
  assert.deepEqual(g.score, { mean: 70, sd: 10, min: 60, max: 80, range: 20 });
  assert.deepEqual([g.levels, g.modal_level, g.agreement], [{ ALERT: 2, REVIEW: 1 }, "ALERT", 2 / 3]);
  assert.equal(g.recall, (1 + 1 + 0.5) / 3);
  assert.equal(g.false_alarms, 2 / 3);
  const empty = summarizeGroup("s0", "pipeline", []);
  assert.deepEqual([empty.runs, empty.score, empty.modal_level, empty.agreement, empty.recall, empty.false_alarms], [0, null, null, null, null, 0]);
});

test("benchmark summary: overall numbers, the severe case and the clean case", () => {
  const runs: RunRecord[] = [
    run("s3-confirmed-match", "judge", 1, 40, "RESTRICT"), run("s3-confirmed-match", "judge", 2, 85, "PASS"), run("s3-confirmed-match", "judge", 3, 78, "REVIEW"),
    run("s1-clean", "judge", 1, 90, "PASS"), run("s1-clean", "judge", 2, 55, "ALERT"),
    run("s3-confirmed-match", "pipeline", 1, 61, "RESTRICT"), run("s3-confirmed-match", "pipeline", 2, 61, "RESTRICT"),
    run("s1-clean", "pipeline", 1, 96.7, "PASS"), run("s1-clean", "pipeline", 2, 96.7, "PASS"),
  ];
  const s = summarizeRuns(runs);
  assert.equal(s.groups.length, 4);
  assert.deepEqual(s.severe.judge, { scenario: "s3-confirmed-match", runs: 3, misses: 2 }); // a PASS, and a review with a high score
  assert.deepEqual(s.severe.pipeline, { scenario: "s3-confirmed-match", runs: 2, misses: 0 });
  assert.deepEqual(s.clean.judge, { scenario: "s1-clean", runs: 2, false_alarm_runs: 1 });
  assert.deepEqual(s.clean.pipeline, { scenario: "s1-clean", runs: 2, false_alarm_runs: 0 });
  assert.equal(s.overall.pipeline.mean_sd, 0);
  assert.equal(s.overall.pipeline.mean_range, 0);
  assert.equal(s.overall.pipeline.mean_agreement, 1);
  assert.ok((s.overall.judge.mean_sd as number) > 10);
  assert.deepEqual([s.overall.judge.runs, s.overall.pipeline.runs, s.overall.judge.failed], [5, 4, 0]);
  const none = summarizeRuns([]);
  assert.deepEqual([none.groups.length, none.severe.judge, none.clean.pipeline, none.overall.judge.mean_sd], [0, null, null, null]);
});

test("failed runs are excluded from the statistics and counted", () => {
  const runs: RunRecord[] = [
    run("s0", "judge", 1, 50, "ALERT"),
    { scenario: "s0", method: "judge", repeat: 2, ok: false, code: "RATE_LIMITED", score: null, level: null, found: [], recall: null, false_alarms: 0 },
  ];
  const s = summarizeRuns(runs);
  assert.deepEqual([s.overall.judge.runs, s.overall.judge.failed, s.groups[0]?.score?.sd], [1, 1, 0]);
});
