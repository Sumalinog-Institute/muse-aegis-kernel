import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { evaluate } from "./kernel.ts";
import { canonicalize } from "./jcs.ts";
import { generateKeyPair, makeSigner, makeVerifier, verifyChain } from "./audit.ts";
import { appendRecord, rowsToEntries, StoreConflictError } from "./append.ts";
import type { AuditStore, StoreRow } from "./append.ts";
import { verifyLog } from "./verify.ts";
import type { AuditReader } from "./verify.ts";
import { buildRecord, checkDraft, commitScreening, DRAFT_QUEUE_MAX_AGE_MS, macDraft, parseClaimsLedger, prepareScreening, sha256Hex } from "./screening.ts";
import type { Draft, PrepareDeps } from "./screening.ts";

const BASE = new URL("../fixtures/grant-xx-nmf-0001-2026-014/", import.meta.url);
const scenarios = readdirSync(BASE, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name).sort();
const json = (sc: string, f: string) => JSON.parse(readFileSync(new URL(`${sc}/${f}`, BASE), "utf8"));
const text = (sc: string) => readFileSync(new URL(`${sc}/report.txt`, BASE), "utf8");

const KEY = "AIzaSyTEST_KEY_DO_NOT_LEAK_0123456789";
const MAC_KEY = "m".repeat(48);
const USER = "11111111-2222-3333-4444-555555555555";
const kernel = evaluate as unknown as (p: Record<string, unknown>) => unknown;

/** The claims a careful model would propose for a scenario's narrative, with exact quotes. */
function modelClaims(narrative: string): unknown[] {
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
}

const okReply = (claims: unknown[]) =>
  new Response(JSON.stringify({ candidates: [{ finishReason: "STOP", content: { parts: [{ text: JSON.stringify({ claims }) }] } }], usageMetadata: { promptTokenCount: 100, candidatesTokenCount: 50 } }), { status: 200 });
const http = (s: number) => new Response("{}", { status: s });

function fakeModel(replies: Response[]) {
  let i = 0;
  const calls: unknown[] = [];
  const fetchFn = (async (_u: string, init: RequestInit) => { calls.push(JSON.parse(String(init.body))); return (replies[Math.min(i++, replies.length - 1)] as Response).clone(); }) as unknown as typeof fetch;
  return { fetchFn, calls: () => calls.length };
}

let clock = Date.UTC(2026, 9, 27, 12, 0, 0);
const deps = (replies: Response[], over: Partial<PrepareDeps> = {}) => {
  const m = fakeModel(replies);
  return { d: { fetchFn: m.fetchFn, sleep: async () => {}, now: () => new Date(clock), evaluate: kernel, ...over } as PrepareDeps, calls: m.calls };
};
const same3 = (c: unknown[]) => [okReply(c), okReply(c), okReply(c)];

function inputs(sc: string) {
  return { documentText: text(sc), award: json(sc, "award.json"), spendLedger: json(sc, "spend_ledger.json"), schedule: json(sc, "reporting_schedule.json"), register: json(sc, "register.json"), claimsLedger: json(sc, "claims_ledger.json") };
}
const prep = (sc: string, over: Record<string, unknown> = {}, replies?: Response[]) => {
  const { d, calls } = deps(replies ?? same3(modelClaims(text(sc))));
  return prepareScreening(d, { apiKey: KEY, model: "gemini-test", actorId: USER, projectId: "FP001", docRef: "gcf:FP001:funding-proposal", inputs: inputs(sc), ...over }).then((r) => ({ r, calls }));
};

class MemStore implements AuditStore, AuditReader {
  rows: StoreRow[] = [];
  async getHead() { const l = this.rows[this.rows.length - 1]; return l ? { seq: l.seq, hash: l.hash } : null; }
  async insert(row: StoreRow) {
    const l = this.rows[this.rows.length - 1];
    if (row.seq !== (l ? l.seq + 1 : 1) || row.prev_hash !== (l ? l.hash : "0".repeat(64))) throw new StoreConflictError("audit: position taken");
    this.rows.push(structuredClone(row));
  }
  async getPage(after: number, limit: number) { return structuredClone(this.rows.filter((r) => r.seq > after).slice(0, limit)); }
}
const kp = await generateKeyPair();
const signer = await makeSigner("k1", kp.privateJwk);
const verifier = await makeVerifier({ k1: kp.publicJwk });
const appendDeps = (store: MemStore) => ({ store, signer, verifier, evaluate: kernel, now: () => new Date(clock) });

// ---------------------------------------------------------------- every scenario, from document to signed log entry

const EXPECT: Record<string, { decision: string; triggers: string[] }> = {
  "s0-as-delivered": { decision: "ALERT_VERIFICATION_REQUIRED", triggers: ["T3"] },
  "s1-clean": { decision: "SCREENING_PASS_PENDING_STANDARD_CONTROLS", triggers: [] },
  "s2-documentation-gaps": { decision: "ALERT_VERIFICATION_REQUIRED", triggers: ["T2", "T3"] },
  "s3-confirmed-match": { decision: "RESTRICTION_RECOMMENDED_PENDING_AUTHORITY", triggers: ["T1"] },
  "s4-conflicting-match": { decision: "ALERT_VERIFICATION_REQUIRED", triggers: ["T3"] },
  "s5-mixed-currency": { decision: "ALERT_VERIFICATION_REQUIRED", triggers: ["T3"] },
  "s6-small-sample": { decision: "FLAG_FOR_REVIEW", triggers: [] },
  "s7-ledger-incomplete": { decision: "ALERT_VERIFICATION_REQUIRED", triggers: ["T3"] },
};

for (const sc of scenarios) {
  test(`scenario ${sc}: prepare, review, commit and verify`, async () => {
    const exp = json(sc, "expected.json");
    const { r, calls } = await prep(sc);
    assert.equal(r.ok, true);
    if (!r.ok) return;
    const d = r.draft;
    assert.equal(calls(), 3); // k = 3 runs
    // the profile equals the independent oracle's features
    assert.equal(d.profile["x2"], exp.claims.x2);
    assert.equal(d.profile["x1"], 0);
    assert.equal(d.profile["x4"], exp.x4.x4);
    assert.equal(d.profile["x5"], exp.x5.x5);
    assert.equal(d.profile["x6"], exp.screening.x6);
    assert.equal(d.profile["alert_status"], exp.screening.alert_status);
    assert.equal(d.result["decision"], EXPECT[sc]?.decision);
    assert.deepEqual(d.result["triggers"], EXPECT[sc]?.triggers);
    assert.equal(d.doc_hash, "sha256:" + (await sha256Hex(text(sc))));
    assert.deepEqual(d.details.claims.items.map((i) => i.status), exp.claims.claims.map((c: { status: string }) => c.status));

    // the server protects the draft; the reviewer approves; the entry is written and the log verifies
    const mac = await macDraft(d, MAC_KEY);
    const store = new MemStore();
    clock += 60_000;
    const out = await commitScreening(appendDeps(store), { userId: USER, allowedUserIds: USER, macKey: MAC_KEY, draft: structuredClone(d), mac, note: "Checked the quotes against the report." });
    assert.equal(out.ok, true);
    assert.equal(out.ok && out.entry.decision, EXPECT[sc]?.decision);
    const entries = rowsToEntries(store.rows);
    assert.equal((await verifyChain(entries, verifier)).ok, true);
    const rec = entries[0]?.record as Record<string, unknown>;
    const details = rec["details"] as Record<string, unknown>;
    assert.deepEqual(Object.keys(details).sort(), ["claims", "features", "inputs", "not_checked", "review", "stability"]);
    const nc = details["not_checked"] as Record<string, unknown>;
    assert.equal(nc["report_version"], 1);
    assert.ok(Array.isArray(nc["lines"]));
    assert.deepEqual(rec["input"], d.profile);
    assert.deepEqual(rec["result"], d.result);
    assert.equal((details["review"] as Record<string, unknown>)["draft_mac"], mac);
    assert.equal((details["review"] as Record<string, unknown>)["note"], "Checked the quotes against the report.");
    assert.equal(rec["actor_id"], USER);
    // the verification screen's reader understands the richer record
    const report = await verifyLog(store, verifier);
    assert.equal(report.ok, true);
    assert.equal(report.recent[0]?.decision, EXPECT[sc]?.decision);
  });
}

// ---------------------------------------------------------------- the draft's content

test("the draft records inputs by hash, the claims with their quotes, the features and the stability runs", async () => {
  const { r } = await prep("s0-as-delivered");
  assert.equal(r.ok, true);
  if (!r.ok) return;
  const d = r.draft;
  assert.deepEqual(Object.keys(d.details.inputs.hashes).sort(), ["award", "claims_ledger", "register", "schedule", "spend_ledger"]);
  for (const h of Object.values(d.details.inputs.hashes)) assert.match(h, /^[0-9a-f]{64}$/);
  const i = inputs("s0-as-delivered");
  assert.deepEqual(d.details.inputs.hashes, {
    award: await sha256Hex(canonicalize(i.award)), spend_ledger: await sha256Hex(canonicalize(i.spendLedger)), schedule: await sha256Hex(canonicalize(i.schedule)),
    register: await sha256Hex(canonicalize(i.register)), claims_ledger: await sha256Hex(canonicalize(parseClaimsLedger(i.claimsLedger))),
  });
  assert.equal(d.details.inputs.award_id, "XX-NMF-0001-2026-014");
  assert.equal(d.details.inputs.as_of, "2026-10-26");
  assert.equal(d.extractor_version, "gemini:gemini-test:prompt-v2:stab-k3-t0.7");
  const runs = d.details.stability.runs;
  assert.equal(runs.length, 3);
  const exp = json("s0-as-delivered", "expected.json").claims.claims.map((c: { status: string }) => c.status).sort();
  for (const run of runs) assert.deepEqual(run.figures?.map((f) => f.status).sort(), exp); // each run's findings are kept, run by run
  assert.deepEqual(runs[0]?.rejected_reasons, {});
  assert.deepEqual([d.details.stability.k, d.details.stability.valid_runs, d.details.stability.usage], [3, 3, { prompt_tokens: 300, output_tokens: 150 }]);
  assert.equal(d.details.stability.result.x1, 0);
  const training = d.details.claims.items.find((i) => i.subject === "Training and workshops");
  assert.equal(training?.status, "CONTRADICTED");
  assert.match(training?.quote ?? "", /6,500 USD on training and workshops/);
  assert.equal(d.details.features.x4.x4, 17000 / 164810);
  assert.equal(d.policy_version, "4.1");
  assert.equal(JSON.stringify(d).includes(KEY), false);
});

test("the hashes identify the exact inputs: changing one input changes its hash only", async () => {
  const a = await prep("s0-as-delivered");
  const b = await prep("s1-clean");
  assert.ok(a.r.ok && b.r.ok);
  if (!a.r.ok || !b.r.ok) return;
  assert.notEqual(a.r.draft.details.inputs.hashes["spend_ledger"], b.r.draft.details.inputs.hashes["spend_ledger"]);
  assert.equal(a.r.draft.details.inputs.hashes["register"], b.r.draft.details.inputs.hashes["register"]);
});

// ---------------------------------------------------------------- failures while preparing

test("bad inputs are refused before any model call", async () => {
  const cases: Record<string, unknown>[] = [
    { documentText: "" }, { documentText: "x".repeat(60001) }, { documentText: 5 }, { claimsLedger: null }, { claimsLedger: { snapshot_id: "", snapshot_date: "2026-01-01", facts: [] } },
    { claimsLedger: { snapshot_id: "x", snapshot_date: "soon", facts: [] } }, { award: null }, { spendLedger: [] }, { schedule: "x" }, { register: 7 },
  ];
  for (const over of cases) {
    const { d, calls } = deps(same3(modelClaims(text("s0-as-delivered"))));
    const r = await prepareScreening(d, { apiKey: KEY, model: "m", actorId: USER, projectId: "FP001", docRef: "gcf:FP001:funding-proposal", inputs: { ...inputs("s0-as-delivered"), ...over } });
    assert.deepEqual([r.ok, !r.ok && r.code], [false, "BAD_INPUT"], JSON.stringify(Object.keys(over)));
    assert.equal(calls(), 0);
  }
  const { d } = deps([]);
  assert.deepEqual(await prepareScreening(d, { apiKey: KEY, model: "m", actorId: "", projectId: "FP001", docRef: "gcf:FP001:funding-proposal", inputs: inputs("s0-as-delivered") }), { ok: false, code: "BAD_PARAMS", status: null });
});

test("model failures are reported, and nothing is drafted", async () => {
  const r = await prep("s0-as-delivered", {}, [http(401)]);
  assert.deepEqual(r.r, { ok: false, code: "AUTH_FAILED", status: 401 });
  const r2 = await prep("s0-as-delivered", { k: 1 });
  assert.deepEqual(r2.r, { ok: false, code: "BAD_PARAMS", status: null });
});

test("if one of the runs fails, x1 is INCOMPLETE and the case goes to a person (unless a trigger applies)", async () => {
  const c = modelClaims(text("s1-clean"));
  const { r } = await prep("s1-clean", {}, [okReply(c), http(503), http(503), http(503), okReply(c)]);
  assert.equal(r.ok, true);
  if (!r.ok) return;
  assert.equal(r.draft.profile["x1"], "INCOMPLETE");
  assert.equal(r.draft.result["decision"], "INCOMPLETE_INPUT_MANUAL_REVIEW");
});

test("a model that finds no claims gives a coverage failure, not x2 = 0", async () => {
  const { r } = await prep("s1-clean", {}, same3([]));
  assert.equal(r.ok, true);
  if (!r.ok) return;
  assert.equal(r.draft.profile["x2"], "INCOMPLETE");
  assert.equal(r.draft.result["decision"], "INCOMPLETE_INPUT_MANUAL_REVIEW");
});

test("an oversized draft is refused", async () => {
  const { r } = await prep("s0-as-delivered", { maxDraftChars: 500 });
  assert.deepEqual(r, { ok: false, code: "DRAFT_TOO_LARGE", status: null });
});

test("an unstable extraction (runs disagree) shows in x1 and withholds a pass", async () => {
  const c = modelClaims(text("s1-clean"));
  const { r } = await prep("s1-clean", {}, [okReply(c), okReply(c.slice(0, 2)), okReply(c.slice(0, 2))]);
  assert.equal(r.ok, true);
  if (!r.ok) return;
  assert.ok((r.draft.profile["x1"] as number) >= 0.2);
  assert.equal(r.draft.result["decision"], "FLAG_FOR_REVIEW");
  assert.deepEqual(r.draft.result["reasons"], ["UNSTABLE_EXTRACTION"]);
});

// ---------------------------------------------------------------- the MAC and the commit rules

async function draftAndMac(): Promise<{ d: Draft; mac: string }> {
  const { r } = await prep("s1-clean");
  if (!r.ok) throw new Error("prepare failed");
  return { d: r.draft, mac: await macDraft(r.draft, MAC_KEY) };
}
const commit = (d: unknown, mac: unknown, over: Record<string, unknown> = {}, store = new MemStore()) =>
  commitScreening(appendDeps(store), { userId: USER, allowedUserIds: USER, macKey: MAC_KEY, draft: d, mac, note: "ok", ...over });

test("a draft that was changed after it was prepared is refused", async () => {
  const { d, mac } = await draftAndMac();
  for (const edit of [
    (x: Draft) => { x.result["decision"] = "RESTRICTION_RECOMMENDED_PENDING_AUTHORITY"; },
    (x: Draft) => { x.profile["x2"] = 0; },
    (x: Draft) => { x.details.claims.items[0]!.quote = "a different quote"; },
    (x: Draft) => { x.details.claims.items[0]!.status = x.details.claims.items[0]!.status === "SUPPORTED" ? "CONTRADICTED" : "SUPPORTED"; },
    (x: Draft) => { x.doc_hash = "sha256:" + "0".repeat(64); },
    (x: Draft) => { x.created_at = new Date(clock + 1000).toISOString(); },
  ]) {
    const copy = structuredClone(d);
    edit(copy);
    const store = new MemStore();
    const out = await commit(copy, mac, {}, store);
    assert.deepEqual([out.ok, !out.ok && out.code], [false, "BAD_MAC"]);
    assert.equal(store.rows.length, 0);
  }
});

test("wrong key, malformed MAC and malformed draft are refused", async () => {
  const { d, mac } = await draftAndMac();
  const wrongKey = await macDraft(d, "w".repeat(48));
  for (const [dr, m, code] of [[d, wrongKey, "BAD_MAC"], [d, "xyz", "BAD_DRAFT"], [d, 5, "BAD_DRAFT"], [null, mac, "BAD_DRAFT"], [{ ...d, format_version: 1 }, mac, "BAD_DRAFT"]] as const) {
    const out = await commit(dr, m);
    assert.deepEqual([out.ok, !out.ok && out.code], [false, code]);
  }
  const short = await commit(d, mac, { macKey: "too short" });
  assert.deepEqual([short.ok, !short.ok && short.status, !short.ok && short.code], [false, 500, "SERVER_MISCONFIGURED"]);
  await assert.rejects(() => macDraft(d, "short"), /MAC_KEY_TOO_SHORT/);
});

test("a draft is refused if it is too old, from the future, or belongs to another account", async () => {
  const { d, mac } = await draftAndMac();
  const saved = clock;
  clock = Date.parse(d.created_at) + 31 * 60 * 1000;
  assert.deepEqual([(await commit(d, mac)).ok, "code" in (await commit(d, mac)) && (await commit(d, mac) as { code: string }).code], [false, "EXPIRED"]);
  clock = Date.parse(d.created_at) + 29 * 60 * 1000;
  assert.equal((await commit(d, mac)).ok, true);
  clock = Date.parse(d.created_at) - 10 * 60 * 1000;
  assert.equal(((await commit(d, mac)) as { code: string }).code, "EXPIRED");
  clock = saved;
  const other = await commitScreening(appendDeps(new MemStore()), { userId: "someone-else", allowedUserIds: "someone-else", macKey: MAC_KEY, draft: d, mac, note: "" });
  assert.deepEqual([other.ok, !other.ok && other.status, !other.ok && other.code], [false, 403, "FORBIDDEN"]);
});

test("a queue can keep drafts longer by passing maxAgeMs, up to 14 days; bad values fall back to 30 minutes", async () => {
  const { d, mac } = await draftAndMac();
  const saved = clock;
  const DAY = 24 * 60 * 60 * 1000;
  const at = (ms: number) => { clock = Date.parse(d.created_at) + ms; };
  at(13 * DAY);
  assert.equal(((await commit(d, mac)) as { code: string }).code, "EXPIRED"); // default stays 30 minutes
  assert.equal((await commit(d, mac, { maxAgeMs: DRAFT_QUEUE_MAX_AGE_MS })).ok, true);
  at(15 * DAY);
  assert.equal(((await commit(d, mac, { maxAgeMs: DRAFT_QUEUE_MAX_AGE_MS })) as { code: string }).code, "EXPIRED");
  assert.equal(((await commit(d, mac, { maxAgeMs: 365 * DAY })) as { code: string }).code, "EXPIRED"); // capped at 14 days
  at(45 * 60 * 1000);
  for (const bad of [Number.NaN, -1, 0, Infinity, "9999999999", null]) {
    assert.equal(((await commit(d, mac, { maxAgeMs: bad })) as { code: string }).code, "EXPIRED", String(bad));
  }
  clock = saved;
});

test("a draft that no longer matches the scoring rules is refused as stale", async () => {
  const { d } = await draftAndMac();
  const odd = structuredClone(d);
  odd.result["decision"] = "FLAG_FOR_REVIEW"; // inconsistent with its own profile, but correctly MACed by the server
  const out = await commit(odd, await macDraft(odd, MAC_KEY));
  assert.deepEqual([out.ok, !out.ok && out.status, !out.ok && out.code], [false, 409, "STALE_DRAFT"]);
});

test("the review note must be short text; accounts off the allow-list cannot commit", async () => {
  const { d, mac } = await draftAndMac();
  for (const note of ["x".repeat(501), 5, null, undefined]) {
    const out = await commit(d, mac, { note });
    assert.deepEqual([out.ok, !out.ok && out.code], [false, "BAD_REQUEST"]);
  }
  assert.equal((await commit(d, mac, { note: "" })).ok, true);
  const off = await commit(d, mac, { allowedUserIds: "someone-else" });
  assert.deepEqual([off.ok, !off.ok && off.status], [false, 403]);
  const unset = await commit(d, mac, { allowedUserIds: undefined });
  assert.deepEqual([unset.ok, !unset.ok && unset.status], [false, 500]);
});

test("a repeated commit of the same approved draft is visible: both entries carry the same draft MAC", async () => {
  const { d, mac } = await draftAndMac();
  const store = new MemStore();
  await commit(d, mac, {}, store);
  await commit(d, mac, {}, store);
  const macs = rowsToEntries(store.rows).map((e) => ((e.record["details"] as Record<string, Record<string, unknown>>)["review"] as Record<string, unknown>)["draft_mac"]);
  assert.deepEqual(macs, [mac, mac]);
});

// ---------------------------------------------------------------- appendRecord's own guards and the ledger parser

test("appendRecord accepts only well-formed SCREENING records for the caller", async () => {
  const { d, mac } = await draftAndMac();
  const good = buildRecord(d, { note: "n", reviewedAt: new Date(clock).toISOString(), mac });
  const ad = appendDeps(new MemStore());
  const req = { userId: USER, allowedUserIds: USER };
  assert.equal((await appendRecord(ad, req, good)).ok, true);
  const bads: Record<string, unknown>[] = [
    { ...good, kind: "OVERRIDE" }, { ...good, doc_hash: "sha256:xyz" }, { ...good, actor_id: "someone-else" }, { ...good, result: [] },
    { ...good, result: {} }, { ...good, timestamp: 5 }, { ...good, extractor_version: undefined },
  ];
  for (const b of bads) {
    const out = await appendRecord(appendDeps(new MemStore()), req, b);
    assert.deepEqual([out.ok, !out.ok && out.code], [false, "BAD_REQUEST"]);
  }
  const small = await appendRecord(appendDeps(new MemStore()), req, good, { maxChars: 1000 });
  assert.deepEqual([small.ok, !small.ok && small.code], [false, "BAD_REQUEST"]);
});

test("parseClaimsLedger accepts the fixtures and refuses malformed ledgers", () => {
  for (const sc of scenarios) assert.ok(parseClaimsLedger(json(sc, "claims_ledger.json")));
  const base = json("s0-as-delivered", "claims_ledger.json");
  const mutate = (f: (l: Record<string, unknown>) => void) => { const l = structuredClone(base); f(l); return l; };
  const facts = (l: Record<string, unknown>) => l["facts"] as Record<string, unknown>[];
  assert.equal(parseClaimsLedger(mutate((l) => { facts(l)[0]!["value"] = true; })), null);
  assert.equal(parseClaimsLedger(mutate((l) => { facts(l)[0]!["subject"] = ""; })), null);
  assert.equal(parseClaimsLedger(mutate((l) => { facts(l)[0]!["valid_to"] = "later"; })), null);
  assert.equal(parseClaimsLedger(mutate((l) => { l["facts"] = Array(501).fill(facts(l)[0]); })), null);
  assert.equal(parseClaimsLedger(mutate((l) => { facts(l)[0]!["value"] = Infinity; })), null);
  assert.equal(parseClaimsLedger([]), null);
});

test("provenance: stated provenance is sealed into the draft details, a bad block is refused, and a missing one is reported", async () => {
  const p = { source_url: "https://www.greenclimate.fund/document/example", retrieved_on: "2026-10-01", file_sha256: "b".repeat(64), text_method: "pasted by hand" };
  const withP = await prep("s1-clean", { provenance: p });
  assert.equal(withP.r.ok, true);
  if (withP.r.ok) {
    assert.deepEqual(withP.r.draft.details.provenance, p);
    assert.ok(!(withP.r.draft.details.not_checked?.lines ?? []).some((l) => /No source address/.test(l)));
  }
  const without = await prep("s1-clean");
  if (without.r.ok) {
    assert.equal(without.r.draft.details.provenance, undefined);
    assert.ok((without.r.draft.details.not_checked?.lines ?? []).some((l) => /No source address/.test(l)));
  }
  const bad = await prep("s1-clean", { provenance: { source_url: "http://insecure.example.org/a" } });
  assert.deepEqual(bad.r, { ok: false, code: "BAD_PARAMS", status: null });
});
