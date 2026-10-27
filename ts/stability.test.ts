import { test } from "node:test";
import assert from "node:assert/strict";
import { evaluate } from "./kernel.ts";
import { anchorClaims, verifyClaims } from "./claims.ts";
import type { Claim, Ledger, VerifiedClaim } from "./claims.ts";
import type { GeminiDeps } from "./extract.ts";
import { analyzeWithStability, claimId, combineX1, consensusItems, runText, sigmaJsd, sigmaSem, STABILITY } from "./stability.ts";
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

// items for the pure functions
const claimOf = (i: number, value: number | string = i): Claim => ({ subject: "s" + i, attribute: "a", period: "p", value, unit: "usd", quote: "q", key: `s${i}|a|p` });
const item = (i: number, value: number | string = i): VerifiedClaim => ({ claim: claimOf(i, value), occurrences: 1, status: "SUPPORTED", fact_ids: [], flags: [] });

// ---------------------------------------------------------------- sigma_jsd

test("sigma_jsd: identical runs give 0, and the closed forms hold", () => {
  const all = [item(1), item(2)];
  assert.deepEqual(sigmaJsd([all, all, all]), { sigma: 0, union: 2, disagreements: 0, pairs: 3 });
  // one claim present in 2 of 3 runs: 2 disagreeing pairs of 3
  assert.equal(sigmaJsd([[item(1)], [item(1)], []]).sigma, 2 / 3);
  // plus a claim present in every run: union 2, still 2 disagreeing pairs, 2 / (2 x 3)
  assert.equal(sigmaJsd([[item(1), item(2)], [item(1), item(2)], [item(2)]]).sigma, 1 / 3);
  // nothing found in any run: stable, so 0 (x2 will report the coverage failure separately)
  assert.equal(sigmaJsd([[], [], []]).sigma, 0);
  // a changed value is two claims, each absent in some runs: 2 x (1 x 2) + ... = 4 disagreements of 2 x 3
  const r = sigmaJsd([[item(1, 12000)], [item(1, 12000)], [item(1, 13000)]]);
  assert.deepEqual([r.union, r.disagreements, r.sigma], [2, 4, 4 / 6]);
});

test("sigma_jsd: equals the closed form p(k-p) for random runs, and stays in [0,1]", () => {
  let seed = 11;
  const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
  for (let t = 0; t < 2000; t++) {
    const k = 2 + Math.floor(rnd() * 8);
    const nClaims = 1 + Math.floor(rnd() * 6);
    const runs = Array.from({ length: k }, () => Array.from({ length: nClaims }, (_, i) => i).filter(() => rnd() < 0.6).map((i) => item(i)));
    const r = sigmaJsd(runs);
    const union = new Set(runs.flat().map((x) => claimId(x.claim)));
    let d = 0;
    for (const id of union) {
      const p = runs.filter((run) => run.some((x) => claimId(x.claim) === id)).length;
      d += p * (k - p);
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
  assert.equal(r.extractor_version, "gemini:gemini-test:prompt-v1:stab-k3-t0.7");
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

test("claim identity and run text are stable and order-independent", () => {
  const a = item(1), b = item(2);
  assert.equal(runText([a, b]), runText([b, a]));
  const { claims } = anchorClaims(DOC, [CLAIMS[0]]);
  const v1 = verifyClaims(claims, ledger).items;
  assert.equal(claimId((claims[0] as Claim)), claimId((v1[0] as VerifiedClaim).claim));
});
