import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { evaluate } from "./kernel.ts";
import { computeX4, computeX5, namesMatch, nameTokens, screenWatchlist, structuredFeatures } from "./features.ts";

const BASE = new URL("../fixtures/grant-xx-nmf-0001-2026-014/", import.meta.url);
const read = (sc: string, f: string) => JSON.parse(readFileSync(new URL(`${sc}/${f}`, BASE), "utf8"));
const scenarios = readdirSync(BASE, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name).sort();

// ---------------------------------------------------------------- every scenario against the independent oracle

for (const sc of scenarios) {
  test(`scenario ${sc}: x4, x5 and screening equal the oracle's expected values exactly`, () => {
    const award = read(sc, "award.json"), ledger = read(sc, "spend_ledger.json"), sched = read(sc, "reporting_schedule.json");
    const register = read(sc, "register.json"), exp = read(sc, "expected.json");
    assert.deepEqual(computeX4(award, ledger), exp.x4);
    assert.deepEqual(computeX5(sched), exp.x5);
    assert.deepEqual(screenWatchlist(award, ledger, register), exp.screening);
  });
}

// ---------------------------------------------------------------- the whole chain, with decisions written by hand

const DECISIONS: Record<string, { decision: string; triggers: string[]; psi?: number; reasons?: string[] }> = {
  "s0-as-delivered": { decision: "ALERT_VERIFICATION_REQUIRED", triggers: ["T3"], psi: 0.7753 },
  "s1-clean": { decision: "SCREENING_PASS_PENDING_STANDARD_CONTROLS", triggers: [], psi: 0.9667 },
  "s2-documentation-gaps": { decision: "ALERT_VERIFICATION_REQUIRED", triggers: ["T2", "T3"] },
  "s3-confirmed-match": { decision: "RESTRICTION_RECOMMENDED_PENDING_AUTHORITY", triggers: ["T1"] },
  "s4-conflicting-match": { decision: "ALERT_VERIFICATION_REQUIRED", triggers: ["T3"] },
  "s5-mixed-currency": { decision: "ALERT_VERIFICATION_REQUIRED", triggers: ["T3"] },
  "s6-small-sample": { decision: "FLAG_FOR_REVIEW", triggers: [], psi: 0.7182, reasons: ["LOW_SCORE", "SMALL_SAMPLE"] },
  "s7-ledger-incomplete": { decision: "ALERT_VERIFICATION_REQUIRED", triggers: ["T3"] },
};

for (const sc of scenarios) {
  test(`scenario ${sc}: features feed the kernel and give the expected decision`, () => {
    const f = structuredFeatures(read(sc, "award.json"), read(sc, "spend_ledger.json"), read(sc, "reporting_schedule.json"), read(sc, "register.json"));
    const x2 = read(sc, "expected.json").claims.x2;
    const res = evaluate({ x1: 0, x2, x4: f.x4, x5: f.x5, x6: f.x6, n_applicable: f.n_applicable, alert_status: f.alert_status });
    const want = DECISIONS[sc] as (typeof DECISIONS)[string];
    assert.equal(res.decision, want.decision);
    assert.deepEqual(res.triggers, want.triggers);
    if (want.psi !== undefined) assert.ok(Math.abs((res.psi as number) - want.psi) < 5e-5, `psi ${res.psi}`);
    if (want.reasons) assert.deepEqual(res.reasons, want.reasons);
  });
}

test("incomplete structured inputs reach the kernel as INCOMPLETE, never as 0", () => {
  const sc = "s7-ledger-incomplete";
  const f = structuredFeatures(read(sc, "award.json"), read(sc, "spend_ledger.json"), read(sc, "reporting_schedule.json"), read(sc, "register.json"));
  assert.equal(f.x4, "INCOMPLETE");
  assert.equal(f.n_applicable, null);
  const res = evaluate({ x1: 0, x2: 0, x4: f.x4, x5: f.x5, x6: f.x6, n_applicable: f.n_applicable, alert_status: "NONE" });
  assert.equal(res.decision, "INCOMPLETE_INPUT_MANUAL_REVIEW");
  assert.ok(res.incomplete_fields.includes("x4:INCOMPLETE"));
});

// ---------------------------------------------------------------- x4 rules

const baseAward = () => read("s0-as-delivered", "award.json");
const baseLedger = () => read("s0-as-delivered", "spend_ledger.json");

test("x4: hand-checked numbers for the baseline", () => {
  const r = computeX4(baseAward(), baseLedger());
  assert.ok("n_applicable" in r && r.n_applicable === 33);
  assert.equal((r as { undocumented_value: number }).undocumented_value, 17000);
  assert.equal((r as { applicable_value: number }).applicable_value, 164810);
  assert.equal(r.x4, 17000 / 164810);
  assert.deepEqual((r as { undocumented_ids: string[] }).undocumented_ids, ["TX-2026-013", "TX-2026-033"]);
  assert.deepEqual((r as { pending_ids: string[] }).pending_ids, ["TX-2026-018"]);
  assert.deepEqual((r as { flags: string[] }).flags, ["DUPLICATE_ID:TX-2026-016"]);
});

test("x4: the cure window boundary is inclusive (30 days pending, 31 days undocumented)", () => {
  const mk = (date: string) => {
    const l = baseLedger();
    l.transactions = [{ id: "T1", type: "expenditure", date, category: "equipment", receiver_org: { name: "V", identifiers: [] }, value: 100, currency: "USD", documents: [] }];
    return computeX4(baseAward(), l) as { undocumented_ids: string[]; pending_ids: string[] };
  };
  assert.deepEqual([mk("2026-09-26").pending_ids, mk("2026-09-26").undocumented_ids], [["T1"], []]); // 30 days
  assert.deepEqual([mk("2026-09-25").pending_ids, mk("2026-09-25").undocumented_ids], [[], ["T1"]]); // 31 days
});

test("x4: no applicable records is NA, not 0", () => {
  const l = baseLedger();
  l.transactions = l.transactions.filter((t: { category: string }) => t.category === "bank_charges");
  assert.deepEqual(computeX4(baseAward(), l), { x4: "NA", n_applicable: 0, flags: [] });
  l.transactions = [];
  assert.equal(computeX4(baseAward(), l).x4, "NA");
});

test("x4: records outside the award period are ignored", () => {
  const l = baseLedger();
  l.transactions = [{ ...l.transactions[0], id: "OLD", date: "2025-06-01", documents: [] }, l.transactions[10]];
  const r = computeX4(baseAward(), l);
  assert.ok("n_applicable" in r && r.n_applicable === 1);
});

test("x4: unusable inputs give INCOMPLETE with a reason", () => {
  const A = baseAward;
  const L = baseLedger;
  const cases: [string, unknown, unknown, string][] = [
    ["null award", null, L(), "INVALID_INPUT"], ["array ledger", A(), [], "INVALID_INPUT"],
    ["not attested", A(), { ...L(), complete: false }, "LEDGER_INCOMPLETE"],
    ["complete as string", A(), { ...L(), complete: "true" }, "LEDGER_INCOMPLETE"],
    ["bad as_of", A(), { ...L(), as_of: "2026-13-40" }, "INVALID_INPUT"],
    ["transactions not a list", A(), { ...L(), transactions: {} }, "INVALID_INPUT"],
    ["transaction without id", A(), { ...L(), transactions: [{ category: "travel" }] }, "INVALID_TRANSACTION"],
  ];
  for (const [label, a, l, reason] of cases) assert.deepEqual(computeX4(a, l), { x4: "INCOMPLETE", reason }, label);
  const withTx = (over: Record<string, unknown>) => {
    const l = L();
    l.transactions = [{ ...l.transactions[10], id: "Z", ...over }];
    return computeX4(A(), l);
  };
  assert.deepEqual(withTx({ value: 10.005 }), { x4: "INCOMPLETE", reason: "INVALID_AMOUNT" });
  assert.deepEqual(withTx({ value: -5 }), { x4: "INCOMPLETE", reason: "INVALID_AMOUNT" });
  assert.deepEqual(withTx({ value: "12" }), { x4: "INCOMPLETE", reason: "INVALID_AMOUNT" });
  assert.deepEqual(withTx({ category: "mystery" }), { x4: "INCOMPLETE", reason: "UNKNOWN_CATEGORY" });
  assert.deepEqual(withTx({ date: "yesterday" }), { x4: "INCOMPLETE", reason: "INVALID_TRANSACTION" });
  assert.deepEqual(withTx({ documents: "none" }), { x4: "INCOMPLETE", reason: "INVALID_TRANSACTION" });
  assert.deepEqual(withTx({ currency: "KRW" }), { x4: "INCOMPLETE", reason: "MIXED_CURRENCY" });
  const dup = L();
  dup.transactions = [dup.transactions[10], { ...dup.transactions[10], value: 1 }];
  assert.deepEqual(computeX4(A(), dup), { x4: "INCOMPLETE", reason: "DUPLICATE_ID_CONFLICT" });
});

test("x4: a different currency on an excluded or out-of-period record does not matter", () => {
  const l = baseLedger();
  l.transactions = [{ ...l.transactions[10], id: "A" }, { ...l.transactions[10], id: "B", category: "bank_charges", currency: "KRW" }, { ...l.transactions[10], id: "C", date: "2024-01-01", currency: "EUR" }];
  assert.ok("n_applicable" in computeX4(baseAward(), l));
});

// ---------------------------------------------------------------- x5 rules

test("x5: hand-checked numbers and boundaries", () => {
  const s = (reports: unknown[], over: Record<string, unknown> = {}) => computeX5({ as_of: "2026-10-26", repository_complete: true, reports, ...over });
  const R = (id: string, due: string, sub: string | null) => ({ id, name: id, due_date: due, submitted_date: sub });
  assert.deepEqual(s([R("a", "2026-10-25", null)]), { x5: 1, n_due: 1, n_submitted: 0, late: [], missing: ["a"] });
  assert.deepEqual(s([R("a", "2026-10-26", null)]), { x5: "NA" }); // due on the day is not yet overdue
  assert.deepEqual(s([]), { x5: "NA" });
  assert.deepEqual(s([R("a", "2026-10-01", "2026-10-02"), R("b", "2026-10-01", "2026-09-30")]), { x5: 0, n_due: 2, n_submitted: 2, late: ["a"], missing: [] });
  assert.equal((s([R("a", "2026-10-01", "2026-11-05")]) as { x5: number }).x5, 1); // a submission dated after as_of does not count
  assert.deepEqual(s([R("a", "2026-10-01", null)], { repository_complete: false }), { x5: "INCOMPLETE", reason: "REPOSITORY_INCOMPLETE" });
  assert.deepEqual(s([{ id: "a", due_date: "soon" }]), { x5: "INCOMPLETE", reason: "INVALID_REPORT" });
  assert.deepEqual(computeX5(null), { x5: "INCOMPLETE", reason: "INVALID_INPUT" });
  assert.equal((s([R("a", "2026-01-01", "2026-01-01"), R("b", "2026-02-01", null), R("c", "2026-03-01", null)]) as { x5: number }).x5, 2 / 3);
});

// ---------------------------------------------------------------- name matching and screening

test("name matching: exact, similar, and look-alikes that must not match", () => {
  const m = namesMatch;
  assert.equal(m("Northgate Supply Company", "Northgate Supply Co."), "EXACT");
  assert.equal(m("NORTHGATE  supply, Ltd", "northgate supply"), "EXACT");
  assert.equal(m("Delta Harbour Logistics Company", "Delta Harbor Logistics Co."), "SIMILAR");
  assert.equal(m("Ｎｏｒｔｈｇａｔｅ Supply", "Northgate Supply Inc"), "EXACT"); // full-width letters
  assert.equal(m("Corvane Electronics Inc", "Corvane Trading FZE"), null);
  assert.equal(m("Lindqvist Training Partners", "Lindqvist Capital Holdings"), null);
  assert.equal(m("Meridian Field Services Ltd", "Meridian Fieldworks Trading Co."), null);
  assert.equal(m("Café", "Cafe"), null); // too short for a one-letter tolerance
  assert.equal(m("", "Anything"), null);
  assert.equal(m("Ltd Co Inc", "Ltd"), null); // only legal words
  assert.deepEqual([...nameTokens("Pinewood Print & Copy Ltd")].sort(), ["copy", "pinewood", "print"]);
});

test("screening: the four outcomes of the rule table", () => {
  const award = baseAward();
  const mk = (payee: string, ids: unknown[], entry: Record<string, unknown>) => {
    const l = baseLedger();
    l.transactions = [{ ...l.transactions[10], id: "P", receiver_org: { name: payee, identifiers: ids } }];
    return screenWatchlist(award, l, { entries: [{ uid: "W1", type: "entity", aliases: [], ...entry }] }) as { x6: number; alert_status: string };
  };
  const id = [{ scheme: "XX-REG", value: "Q-1" }];
  assert.deepEqual(pick(mk("Acme Trading", id, { name: "Acme Trading Co.", identifiers: id })), [1, "NONE"]);
  assert.deepEqual(pick(mk("Acme Trading", id, { name: "Zeta Mining", identifiers: id })), [0, "CONFLICTING"]);
  assert.deepEqual(pick(mk("Acme Trading", [], { name: "Acme Trading Co.", identifiers: id })), [0, "UNVERIFIED"]);
  assert.deepEqual(pick(mk("Acme Trading", id, { name: "Zeta Mining", identifiers: [{ scheme: "XX-REG", value: "Q-2" }] })), [0, "NONE"]);
  assert.deepEqual(pick(mk("Acme Trading", [{ scheme: "XX-REG", value: " q-1 " }], { name: "Acme Trading", identifiers: id })), [1, "NONE"]); // identifier text is normalised
  assert.deepEqual(pick(mk("Acme Trading", [{ scheme: "OTHER", value: "Q-1" }], { name: "Zeta Mining", identifiers: id })), [0, "NONE"]); // a different scheme is not a match
  assert.deepEqual(pick(mk("Acme Trading", [], { name: "Zeta Mining", aliases: ["Acme Trading Ltd"], identifiers: [] })), [0, "UNVERIFIED"]); // alias
});

function pick(r: { x6: number; alert_status: string }): [number, string] {
  return [r.x6, r.alert_status];
}

test("screening: the recipient is screened too, and excluded categories are not", () => {
  const award = baseAward();
  const l = baseLedger();
  l.transactions = [{ ...l.transactions[10], id: "P", category: "bank_charges", receiver_org: { name: "Zeta Mining", identifiers: [] } }];
  const reg = { entries: [{ uid: "W1", name: "Zeta Mining", identifiers: [] }, { uid: "W2", name: "Brightwater Neighbourhood Alliance", identifiers: [] }] };
  const r = screenWatchlist(award, l, reg) as { unverified: [string, string][] };
  assert.deepEqual(r.unverified, [["Brightwater Neighbourhood Alliance", "W2"]]);
});

test("screening: broken inputs give INCOMPLETE", () => {
  const A = baseAward(), L = baseLedger();
  assert.deepEqual(screenWatchlist(A, L, { entries: [{ uid: 1 }] }), { x6: "INCOMPLETE", reason: "REGISTER_INVALID" });
  assert.deepEqual(screenWatchlist(A, L, { entries: "x" }), { x6: "INCOMPLETE", reason: "INVALID_INPUT" });
  assert.deepEqual(screenWatchlist(A, L, null), { x6: "INCOMPLETE", reason: "INVALID_INPUT" });
  assert.deepEqual(screenWatchlist(A, { ...L, transactions: [{ category: "travel" }] }, { entries: [] }), { x6: "INCOMPLETE", reason: "INVALID_TRANSACTION" });
});
