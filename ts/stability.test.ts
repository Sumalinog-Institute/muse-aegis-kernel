import { test } from "node:test";
import assert from "node:assert/strict";
import { evaluate } from "./kernel.ts";
import { anchorClaims, verifyClaims } from "./claims.ts";
import type { Claim, EvidenceStatus, Ledger, VerifiedClaim } from "./claims.ts";
import type { GeminiDeps } from "./extract.ts";
import { analyzeWithStability, byPosition, combineX1, consensusItems, runText, sigmaJsd, sigmaSem, STABILITY } from "./stability.ts";
import type { Embed } from "./stability.ts";

const KEY = "AIzaSyTEST_KEY_DO_NOT_LEAK_0123456789";
const DOC = `Quarterly progress note (made-up example for testing).
In 2026-Q2 the project disbursed 12,000 USD to Vendor A for training.
The annual audit report was submitted on 2026-03-15.
In 2026-Q2 the project paid 8,000 USD to Vendor B for equipment.
The project reached 250 beneficiaries in 2026.`;
const CLAIMS = [
  { subject: "Vendor A", attribute: "disbursed amount", period: "2026-Q2", value_text: "12,000", unit: "USD", quote: "the project disbursed 12,000 USD to Vendor A" },
  { subject: "audit report", attribute: "submitted on", period: "2026", value_text: "2026-03-15", unit: "date", quote: "The annual audit report was submitted on 2026-03-15" },
  { subject: "Vendor B", attribute: "disbursed amount", period: "2026-Q2", value_text: "8,000", unit: "USD", quote: "the project paid 8,000 USD to Vendor B" },
  { subject: "beneficiaries", attribute: "number reached", period: "2026", value_text: "250", unit: "count", quote: "reached 250 beneficiaries in 2026" },
];
const ledger: Ledger = {
  snapshot_id: "L1", snapshot_date: "2026-10-26",
  facts: [
    { id: "F1", subject: "Vendor A", attribute: "disbursed amount", period: "2026-Q2", value: 12000, unit: "USD" },
    { id: "F2", subject: "audit report", attribute: "submitted on", period: "2026", value: "2026-03-20", unit: "date" },
    { id: "F3", subject: "Vendor B", attribute: "disbursed amount", period: "2026-Q2", value: 8000, unit: "USD" },
    { id: "F4", subject: "Vendor B", attribute: "disbursed amount", period: "2026-Q2", value: 9500, unit: "USD" },
  ],
};

function fake(replies: (Response | Error)[]): { deps: GeminiDeps; bodies: unknown[]; count: () => number } {
  const bodies: unknown[] = [];
  let i = 0;
  const fetchFn = (async (_url: string, init: RequestInit) => {
    bodies.push(JSON.parse(String(init.body)));
    const r = replies[Math.min(i++, replies.length - 1)] as Response | Error;
    if (r instanceof Error) throw r;
    return r.clone();
  }) as unknown as typeof fetch;
  return { deps: { fetchFn, sleep: async () => {} }, bodies, count: () => i };
}
const ok = (claims: unknown[]) =>
  new Response(JSON.stringify({ candidates: [{ finishReason: "STOP", content: { parts: [{ text: JSON.stringify({ claims }) }] } }], usageMetadata: { promptTokenCount: 100, candidatesTokenCount: 50 } }), { status: 200 });
const http = (status: number) => new Response("{}", { status });
const params = (over: Record<string, unknown> = {}) => ({ apiKey: KEY, model: "gemini-test", documentText: DOC, ledger, maxRetries: 2, ...over });

// items for the pure functions: figure i sits at position i x 100 in the document
const claimOf = (i: number, value: number | string = i, label = "s" + i): Claim => ({ subject: label, attribute: "a", period: "p", value, unit: "usd", quote: "q", key: `${label}|a|p`, at: i * 100 });
const item = (i: number, status: EvidenceStatus = "SUPPORTED", label = "s" + i): VerifiedClaim => ({ claim: claimOf(i, i, label), occurrences: 1, status, fact_ids: [], flags: [] });

// ---------------------------------------------------------------- sigma_jsd

test("sigma_jsd: identical runs give 0, and the closed forms hold", () => {
  const all = [item(1), item(2)];
  assert.deepEqual(sigmaJsd([all, all, all]), { sigma: 0, union: 2, disagreements: 0, pairs: 3 });
  // one figure found in 2 of 3 runs: 2 disagreeing pairs of 3
  assert.equal(sigmaJsd([[item(1)], [item(1)], []]).sigma, 2 / 3);
  // plus a figure found in every run: union 2, still 2 disagreeing pairs, 2 / (2 x 3)
  assert.equal(sigmaJsd([[item(1), item(2)], [item(1), item(2)], [item(2)]]).sigma, 1 / 3);
  // nothing found in any run: stable, so 0 (x2 will report the coverage failure separately)
  assert.equal(sigmaJsd([[], [], []]).sigma, 0);
});

test("sigma_jsd: different wording for the same figure is NOT disagreement; a different status is", () => {
  const worded = [[item(1, "SUPPORTED", "Vendor A")], [item(1, "SUPPORTED", "the vendor")], [item(1, "SUPPORTED", "Project")]];
  assert.deepEqual(sigmaJsd(worded), { sigma: 0, union: 1, disagreements: 0, pairs: 3 });
  // the same figure judged SUPPORTED, SUPPORTED, INSUFFICIENT_EVIDENCE: 2 of 3 pairs differ
  const flipped = [[item(1, "SUPPORTED")], [item(1, "SUPPORTED")], [item(1, "INSUFFICIENT_EVIDENCE")]];
  assert.equal(sigmaJsd(flipped).sigma, 2 / 3);
  // three different statuses: all 3 pairs differ
  assert.equal(sigmaJsd([[item(1, "SUPPORTED")], [item(1, "CONTRADICTED")], [item(1, "INSUFFICIENT_EVIDENCE")]]).sigma, 1);
});

test("one claim per figure in a run: the most severe status wins, ties by key", () => {
  const m = byPosition([item(1, "SUPPORTED", "b"), item(1, "CONTRADICTED", "z"), item(2, "SUPPORTED", "x"), item(2, "SUPPORTED", "a")]);
  assert.deepEqual([...m.entries()].map(([at, it]) => [at, it.status, it.claim.subject]), [[100, "CONTRADICTED", "z"], [200, "SUPPORTED", "a"]]);
});

test("sigma_jsd: equals the closed form for random runs, and stays in [0,1]", () => {
  let seed = 11;
  const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
  const statuses: EvidenceStatus[] = ["SUPPORTED", "CONTRADICTED", "INSUFFICIENT_EVIDENCE", "AMBIGUOUS_CONFLICT"];
  for (let t = 0; t < 2000; t++) {
    const k = 2 + Math.floor(rnd() * 8);
    const nFigures = 1 + Math.floor(rnd() * 6);
    const runs = Array.from({ length: k }, () => Array.from({ length: nFigures }, (_, i) => i).filter(() => rnd() < 0.6).map((i) => item(i, statuses[Math.floor(rnd() * 4)] as EvidenceStatus)));
    const r = sigmaJsd(runs);
    let d = 0;
    const figures = new Set(runs.flat().map((x) => x.claim.at));
    for (const at of figures) {
      const labels = runs.map((run) => run.find((x) => x.claim.at === at)?.status ?? "ABSENT");
      for (let a = 0; a < k; a++) for (let b = a + 1; b < k; b++) if (labels[a] !== labels[b]) d++;
    }
    assert.equal(r.disagreements, d);
    assert.ok(r.sigma >= 0 && r.sigma <= 1);
  }
});

// ---------------------------------------------------------------- consensus

test("consensus: majority present is kept, minority is dropped, a tie becomes AMBIGUOUS_CONFLICT", () => {
  const ids = (xs: VerifiedClaim[]) => xs.map((x) => [x.claim.subject, x.status]);
  assert.deepEqual(ids(consensusItems([[item(1), item(2)], [item(1)], [item(1), item(3)]])), [["s1", "SUPPORTED"]]); // 2 and 3 are in 1 of 3
  assert.deepEqual(ids(consensusItems([[item(1), item(2)], [item(1), item(2)], [item(1)]])), [["s1", "SUPPORTED"], ["s2", "SUPPORTED"]]);
  assert.deepEqual(ids(consensusItems([[item(1)], []])), [["s1", "AMBIGUOUS_CONFLICT"]]); // 1 of 2
  assert.deepEqual(ids(consensusItems([[item(1)], [item(1)], [], []])), [["s1", "AMBIGUOUS_CONFLICT"]]); // 2 of 4
  assert.deepEqual(ids(consensusItems([[item(1)], [], [], []])), []);
  assert.deepEqual(consensusItems([[], [], []]), []);
  assert.ok(consensusItems([[item(1)], []])[0]?.flags.includes("RUN_TIE"));
});

test("consensus: runs that word a figure differently still agree; runs that judge it differently follow the majority", () => {
  const worded = consensusItems([[item(1, "SUPPORTED", "Vendor A")], [item(1, "SUPPORTED", "the vendor")], [item(1, "SUPPORTED", "Project")]]);
  assert.deepEqual(worded.map((x) => [x.claim.subject, x.status]), [["Vendor A", "SUPPORTED"]]); // first run's wording
  const majority = consensusItems([[item(1, "SUPPORTED")], [item(1, "SUPPORTED")], [item(1, "CONTRADICTED")]]);
  assert.deepEqual(majority.map((x) => x.status), ["SUPPORTED"]);
  const tie = consensusItems([[item(1, "SUPPORTED")], [item(1, "CONTRADICTED")], []]);
  assert.deepEqual(tie.map((x) => [x.status, x.flags.includes("RUN_TIE")]), [["AMBIGUOUS_CONFLICT", true]]);
  const absentWins = consensusItems([[item(1, "SUPPORTED")], [item(1, "CONTRADICTED")], [], []]);
  assert.deepEqual(absentWins, []);
});

// ---------------------------------------------------------------- sigma_sem and the combined x1

test("sigma_sem: identical vectors 0, opposite vectors 1, bad vectors are refused", () => {
  assert.deepEqual(sigmaSem([[1, 0], [1, 0], [1, 0]]), { sigma: 0 });
  assert.deepEqual(sigmaSem([[1, 0], [-1, 0]]), { sigma: 1 });
  assert.deepEqual(sigmaSem([[1, 0], [0, 1]]), { sigma: 0.5 });
  assert.deepEqual(sigmaSem([[0.1, 0.2, 0.7], [0.1, 0.2, 0.7]]), { sigma: 0 }); // identical, even when the cosine would round
  assert.deepEqual(sigmaSem([[1, 0]]), { error: "TOO_FEW_VECTORS" });
  for (const bad of [[[1, 0], [1]], [[1, 0], [NaN, 1]], [[0, 0], [1, 0]], [[], []], [[1, 0], [Infinity, 1]]]) {
    assert.deepEqual(sigmaSem(bad), { error: "EMBEDDING_INVALID" });
  }
});

test("x1: jsd_only is sigma_jsd; jsd_sem is the 0.5 / 0.5 mix, capped at 1", () => {
  assert.deepEqual(combineX1(0.25, null), { x1: 0.25, mode: "jsd_only" });
  assert.deepEqual(combineX1(0.25, 0.5), { x1: 0.375, mode: "jsd_sem" });
  assert.deepEqual(combineX1(1, 1), { x1: 1, mode: "jsd_sem" });
  assert.equal(STABILITY.W_JSD + STABILITY.W_SEM, 1);
});

// ---------------------------------------------------------------- end to end with simulated replies

test("three identical runs: x1 is 0, the consensus is the full claim set, and x2 is as for a single run", async () => {
  const f = fake([ok(CLAIMS), ok(CLAIMS), ok(CLAIMS)]);
  const r = await analyzeWithStability(f.deps, params());
  assert.equal(r.ok, true);
  if (!r.ok) return;
  assert.deepEqual([r.k, r.valid_runs, r.stability.x1], [3, 3, 0]);
  assert.equal(r.stability.x1 === 0 && "mode" in r.stability && r.stability.mode, "jsd_only");
  assert.equal(r.consensus.items.length, 4);
  assert.equal(r.consensus.x2.x2, 0.5); // 1 contradicted, 1 ambiguous, 1 insufficient of 4... see statuses below
  const by = Object.fromEntries(r.consensus.items.map((i) => [i.claim.subject, i.status]));
  assert.deepEqual(by, { "Vendor A": "SUPPORTED", "audit report": "CONTRADICTED", "Vendor B": "AMBIGUOUS_CONFLICT", beneficiaries: "INSUFFICIENT_EVIDENCE" });
  assert.deepEqual(r.usage, { prompt_tokens: 300, output_tokens: 150 });
  assert.equal(r.extractor_version, "gemini:gemini-test:prompt-v2:stab-k3-t0.7");
  assert.equal(f.count(), 3);
});

test("the declared temperature is sent with every run", async () => {
  const f = fake([ok(CLAIMS), ok(CLAIMS)]);
  await analyzeWithStability(f.deps, params({ k: 2, temperature: 0.4 }));
  for (const b of f.bodies as { generationConfig: { temperature: number } }[]) assert.equal(b.generationConfig.temperature, 0.4);
  assert.equal(f.bodies.length, 2);
});

test("without a declared temperature the default of 0.7 is sent, and k defaults to 3", async () => {
  const f = fake([ok(CLAIMS), ok(CLAIMS), ok(CLAIMS)]);
  const r = await analyzeWithStability(f.deps, params());
  for (const b of f.bodies as { generationConfig: { temperature: number } }[]) assert.equal(b.generationConfig.temperature, STABILITY.DEFAULT_TEMPERATURE);
  assert.equal(STABILITY.DEFAULT_TEMPERATURE, 0.7);
  assert.deepEqual([f.bodies.length, r.ok && r.k, r.ok && r.temperature], [3, 3, 0.7]);
});

test("one run misses a claim: x1 is 1/6, and the claim stays in the consensus (present in 2 of 3)", async () => {
  const r = await analyzeWithStability(fake([ok(CLAIMS), ok(CLAIMS), ok(CLAIMS.slice(0, 3))]).deps, params());
  assert.equal(r.ok, true);
  if (!r.ok) return;
  // 4 claims in the union, the missing one has 2 disagreeing pairs of 3: 2 / (4 x 3)
  assert.equal(r.stability.x1, 2 / 12);
  assert.equal(r.consensus.items.length, 4);
  assert.deepEqual(r.runs.map((x) => x.claims), [4, 4, 3]);
});

test("a claim seen in only one run of three is left out of the consensus", async () => {
  const r = await analyzeWithStability(fake([ok(CLAIMS), ok(CLAIMS.slice(0, 3)), ok(CLAIMS.slice(0, 3))]).deps, params());
  assert.equal(r.ok && r.consensus.items.length, 3);
  assert.equal(r.ok && r.stability.x1, 2 / 12);
});

test("with an embedder the mode is jsd_sem and x1 mixes both parts", async () => {
  const toy: Embed = async (texts) => texts.map((t) => { const v = Array(32).fill(0.001); for (let i = 0; i + 2 < t.length; i++) v[(t.charCodeAt(i) * 31 + t.charCodeAt(i + 1) * 7 + t.charCodeAt(i + 2)) % 32] += 1; return v; });
  const stable = await analyzeWithStability({ ...fake([ok(CLAIMS), ok(CLAIMS), ok(CLAIMS)]).deps, embed: toy }, params());
  assert.deepEqual(stable.ok && [stable.stability.x1, "mode" in stable.stability && stable.stability.mode], [0, "jsd_sem"]);
  const unstable = await analyzeWithStability({ ...fake([ok(CLAIMS), ok(CLAIMS), ok(CLAIMS.slice(0, 2))]).deps, embed: toy }, params());
  assert.equal(unstable.ok, true);
  if (!unstable.ok || unstable.stability.x1 === "INCOMPLETE") return assert.fail("expected a number");
  const s = unstable.stability;
  assert.ok(s.sigma_sem !== null && s.sigma_sem > 0 && s.sigma_sem <= 1);
  assert.equal(s.x1, Math.min(1, 0.5 * s.sigma_jsd + 0.5 * (s.sigma_sem as number)));
  assert.ok(s.x1 > 0 && s.x1 <= 1);
});

test("a failing or invalid embedder makes x1 INCOMPLETE, never 0", async () => {
  const mk = (embed: Embed) => analyzeWithStability({ ...fake([ok(CLAIMS), ok(CLAIMS), ok(CLAIMS)]).deps, embed }, params());
  const thrown = await mk(async () => { throw new Error("boom " + KEY); });
  assert.deepEqual(thrown.ok && thrown.stability, { x1: "INCOMPLETE", reason: "EMBEDDING_FAILED", k: 3 });
  const wrong = await mk(async () => [[1, 0], [1], [1, 0]]);
  assert.deepEqual(wrong.ok && wrong.stability, { x1: "INCOMPLETE", reason: "EMBEDDING_INVALID", k: 3 });
  assert.equal(JSON.stringify(thrown).includes(KEY), false);
});

test("if a run fails, x1 is INCOMPLETE (fewer than k valid runs) but the consensus still uses the valid runs", async () => {
  const f = fake([ok(CLAIMS), http(503), http(503), http(503), ok(CLAIMS)]);
  const r = await analyzeWithStability(f.deps, params());
  assert.equal(r.ok, true);
  if (!r.ok) return;
  assert.deepEqual(r.stability, { x1: "INCOMPLETE", reason: "FEWER_THAN_K_VALID_RUNS", k: 3 });
  assert.equal(r.valid_runs, 2);
  assert.deepEqual(r.runs.map((x) => [x.ok, x.code]), [[true, undefined], [false, "SERVER_ERROR"], [true, undefined]]);
  assert.equal(r.consensus.x2.x2, 0.5);
});

test("when every run fails the result is an error code; a client error stops after the first run", async () => {
  const all = await analyzeWithStability(fake([http(503)]).deps, params());
  assert.deepEqual(all, { ok: false, code: "SERVER_ERROR", status: 503 });
  const f = fake([http(401)]);
  const auth = await analyzeWithStability(f.deps, params());
  assert.deepEqual(auth, { ok: false, code: "AUTH_FAILED", status: 401 });
  assert.equal(f.count(), 1);
});

test("bad parameters are refused before any request", async () => {
  for (const over of [{ k: 1 }, { k: 11 }, { k: 2.5 }, { k: NaN }, { temperature: -0.1 }, { temperature: 2.5 }, { temperature: NaN }]) {
    const f = fake([ok(CLAIMS)]);
    const r = await analyzeWithStability(f.deps, params(over));
    assert.deepEqual(r, { ok: false, code: "BAD_PARAMS", status: null });
    assert.equal(f.count(), 0);
  }
});

test("x1 reaches the kernel: a clearly unstable extraction withholds a pass", async () => {
  const r = await analyzeWithStability(fake([ok(CLAIMS), ok(CLAIMS.slice(0, 2)), ok(CLAIMS.slice(0, 2))]).deps, params());
  assert.equal(r.ok, true);
  if (!r.ok || r.stability.x1 === "INCOMPLETE") return assert.fail("expected a number");
  assert.ok(r.stability.x1 >= 0.2, `x1 ${r.stability.x1}`); // 2 claims in 1 of 3 runs: 4 / (4 x 3) = 1/3
  const res = evaluate({ x1: r.stability.x1, x2: 0, x4: 0, x5: 0, x6: 0, n_applicable: 40 });
  assert.equal(res.decision, "FLAG_FOR_REVIEW");
  assert.deepEqual(res.reasons, ["UNSTABLE_EXTRACTION"]);
});

test("run text is stable and order-independent, and ignores wording", () => {
  const a = item(1), b = item(2);
  assert.equal(runText([a, b]), runText([b, a]));
  assert.equal(runText([item(1, "SUPPORTED", "x")]), runText([item(1, "SUPPORTED", "totally different words")]));
  assert.notEqual(runText([item(1, "SUPPORTED")]), runText([item(1, "CONTRADICTED")]));
});

test("every claim that anchorClaims accepts carries the position of its value, the same across runs", () => {
  const first = anchorClaims(DOC, [CLAIMS[0]]).claims[0] as Claim;
  const reworded = anchorClaims(DOC, [{ ...CLAIMS[0], subject: "Vendor A", attribute: "payment", period: "Q2 2026", quote: "disbursed 12,000 USD to Vendor A" }]).claims[0] as Claim;
  assert.equal(first.at, reworded.at); // different quote span and labels, same figure, same position
  assert.equal(DOC.toLowerCase().replace(/\s+/g, " ").slice(first.at, first.at + 6), "12,000");
  const other = anchorClaims(DOC, [CLAIMS[2]]).claims[0] as Claim;
  assert.notEqual(first.at, other.at);
  void verifyClaims;
});

test("the live finding: runs that word a claim differently but reach the same verdict give x1 = 0", async () => {
  // The beneficiaries figure has no ledger counterpart, so any wording gives INSUFFICIENT_EVIDENCE. The live run showed the model
  // using different subjects and attributes for it from run to run; that must not count as instability.
  const reword = (i: number) => CLAIMS.map((c) => (c.subject !== "beneficiaries" ? c : [
    c,
    { ...c, subject: "project", attribute: "number of beneficiaries", period: "2026", quote: "The project reached 250 beneficiaries in 2026" },
    { ...c, attribute: "people reached", period: "year 2026", unit: "persons" },
  ][i]));
  const r = await analyzeWithStability(fake([ok(reword(0)), ok(reword(1)), ok(reword(2))]).deps, params());
  assert.equal(r.ok, true);
  if (!r.ok) return;
  assert.equal(r.stability.x1, 0);
  assert.equal(r.consensus.items.length, 4);
  assert.equal(r.consensus.items.find((i) => i.claim.at === (r.consensus.items.find((x) => x.status === "INSUFFICIENT_EVIDENCE") as { claim: { at: number } }).claim.at)?.status, "INSUFFICIENT_EVIDENCE");
});

test("wording that changes the verdict is real instability: one run labels the figure so it no longer matches the ledger", async () => {
  const other = CLAIMS.map((c, i) => (i === 0 ? { ...c, subject: "the project", quote: "the project disbursed 12,000 USD to Vendor A" } : c));
  const r = await analyzeWithStability(fake([ok(CLAIMS), ok(CLAIMS), ok(other)]).deps, params());
  assert.equal(r.ok, true);
  if (!r.ok || r.stability.x1 === "INCOMPLETE") return assert.fail("expected a number");
  // Vendor A's figure is SUPPORTED in two runs and INSUFFICIENT_EVIDENCE in one: 2 of 3 pairs, over 4 figures x 3 pairs
  assert.equal(r.stability.x1, 2 / 12);
  assert.equal(r.consensus.items.find((i) => i.claim.subject === "Vendor A")?.status, "SUPPORTED");
});

test("each run's findings are kept, so a disagreement between runs can be traced afterwards", async () => {
  const r = await analyzeWithStability(fake([ok(CLAIMS), ok(CLAIMS.slice(0, 3)), ok(CLAIMS)]).deps, params());
  assert.equal(r.ok, true);
  if (!r.ok) return;
  assert.deepEqual(r.runs.map((x) => x.figures?.length), [4, 3, 4]);
  const f = r.runs[0]?.figures as { at: number; status: string; subject: string; label: number | null }[];
  assert.deepEqual(f.map((x) => x.subject), ["Vendor A", "audit report", "Vendor B", "beneficiaries"]);
  assert.deepEqual(f.map((x) => x.status), ["SUPPORTED", "CONTRADICTED", "AMBIGUOUS_CONFLICT", "INSUFFICIENT_EVIDENCE"]);
  assert.ok(f.every((x, i) => i === 0 || (f[i - 1] as { at: number }).at < x.at)); // in document order
  assert.deepEqual(r.runs[1]?.rejected_reasons, {});
});

test("picking ledger labels by number removes the label-drift instability seen live; without the pick, the drift shows in x1", async () => {
  // labels in ledger order: 0 Vendor A, 1 audit report, 2 Vendor B (deduplicated), 3 not used.
  const drift = (claim: Record<string, unknown>, pick: number | null) => ({ ...claim, attribute: "reported item", period: "this period", label_id: pick });
  const stableRuns = [
    CLAIMS.map((c, i) => ({ ...c, label_id: i < 3 ? i : null })), // run 1 uses the ledger's own words through the label numbers
    CLAIMS.map((c, i) => drift(c, i < 3 ? i : null)), // runs 2 and 3 word attribute and period freely but still pick the numbers
    CLAIMS.map((c, i) => drift(c, i < 3 ? i : null)),
  ];
  const withPicks = await analyzeWithStability(fake(stableRuns.map(ok)).deps, params());
  assert.equal(withPicks.ok, true);
  if (!withPicks.ok) return;
  assert.equal(withPicks.stability.x1, 0);
  assert.deepEqual(withPicks.consensus.items.map((i) => i.status).sort(), ["AMBIGUOUS_CONFLICT", "CONTRADICTED", "INSUFFICIENT_EVIDENCE", "SUPPORTED"]);
  // the same freely worded runs WITHOUT the picks: the figures that have ledger facts stop matching in those runs
  const noPicks = [CLAIMS, CLAIMS.map((c) => drift(c, null)), CLAIMS.map((c) => drift(c, null))];
  const without = await analyzeWithStability(fake(noPicks.map(ok)).deps, params());
  assert.equal(without.ok, true);
  if (!without.ok || without.stability.x1 === "INCOMPLETE") return assert.fail("expected a number");
  assert.ok(without.stability.x1 > 0.2, `x1 ${without.stability.x1}`); // 3 figures with ledger facts differ in 2 of 3 runs
  assert.equal(without.consensus.items.filter((i) => i.status === "INSUFFICIENT_EVIDENCE").length, 4); // the majority of runs no longer match the ledger
});

test("v1.1: with the relaxed match on, the version says so, runs report how many claims it accepted, and rejected quotes are sampled", async () => {
  const skipped = { subject: "Vendor A", attribute: "disbursed amount", period: "2026-Q2", value_text: "12,000", unit: "USD", quote: "the project disbursed 12,000 to Vendor A" };
  const bad = { ...skipped, quote: "we sent 12,000 USD to Vendor A on a Tuesday" };
  const f = fake([ok([skipped, bad]), ok([skipped, bad]), ok([skipped, bad])]);
  const r = await analyzeWithStability(f.deps, params({ relaxedAnchor: true }));
  assert.equal(r.ok, true);
  if (!r.ok) return;
  assert.equal(r.extractor_version, "gemini:gemini-test:prompt-v2:stab-k3-t0.7:relaxed-anchor");
  const run = r.runs[0] as { claims: number; rejected: number; relaxed?: number; rejected_samples?: { reason: string; quote: string }[] };
  assert.deepEqual([run.claims, run.rejected, run.relaxed], [1, 1, 1]);
  assert.equal(run.rejected_samples?.[0]?.quote, bad.quote);
  const off = await analyzeWithStability(fake([ok([skipped]), ok([skipped]), ok([skipped])]).deps, params());
  assert.equal(off.ok && (off.runs[0] as { claims: number }).claims, 0, "without the switch the skipped-word quote is rejected");
  assert.equal(off.ok && "relaxed" in (off.runs[0] as object), false);
});
