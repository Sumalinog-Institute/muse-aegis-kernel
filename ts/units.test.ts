import { test } from "node:test";
import assert from "node:assert/strict";
import { isScaleSlip, parseUnit, sameScaled } from "./units.ts";
import { claimKey, verifyClaims } from "./claims.ts";
import type { Claim, Ledger } from "./claims.ts";
import { buildNotCheckedReport } from "./notchecked.ts";
import { computeX2 } from "./claims.ts";

test("parseUnit reads the base unit and the scale", () => {
  const cases: [string, string, number][] = [
    ["usd", "usd", 1], ["USD", "usd", 1], ["US$", "usd", 1], ["us dollars", "usd", 1], ["$", "usd", 1], ["euro", "eur", 1],
    ["million usd", "usd", 1e6], ["USD (million)", "usd", 1e6], ["USD millions", "usd", 1e6], ["usd m", "usd", 1e6], ["m USD", "usd", 1e6],
    ["in thousands of USD", "usd", 1e3], ["USD '000", "usd", 1e3], ["usd bn", "usd", 1e9], ["billion eur", "eur", 1e9],
    ["count", "count", 1], ["", "", 1], ["kg m", "kg m", 1], ["m", "m", 1], ["metres", "metres", 1],
  ];
  for (const [u, base, mult] of cases) assert.deepEqual(parseUnit(u), { base, mult }, u);
});

test("two scale words are not guessed", () => {
  assert.equal(parseUnit("million thousand usd").mult, 1);
});

test("sameScaled and isScaleSlip", () => {
  assert.equal(sameScaled(26.91 * 1e6, 26910000, true), true);
  assert.equal(sameScaled(1, 1.0000001, false), false);
  assert.equal(isScaleSlip(26.91, 26910000), true);
  assert.equal(isScaleSlip(26910000, 26.91), true);
  assert.equal(isScaleSlip(5, 50), false);
  assert.equal(isScaleSlip(0, 1000), false);
  assert.equal(isScaleSlip(-5, 5000), false);
});

const ledger = (unit: string, value: number): Ledger => ({
  snapshot_id: "L", snapshot_date: "2026-11-01",
  facts: [{ id: "F1", subject: "GCF financing", attribute: "committed amount", period: "total", value, unit }],
});
const claim = (value: number, unit: string): Claim => ({
  subject: "GCF financing", attribute: "committed amount", period: "total", value, unit, quote: "q",
  key: claimKey("GCF financing", "committed amount", "total"), at: 0, label: null,
});
const one = (l: Ledger, c: Claim) => verifyClaims([c], l).items[0]!;

test("a table in millions is SUPPORTED against a ledger in units, and the other way round", () => {
  assert.equal(one(ledger("usd", 26910000), claim(26.91, "million usd")).status, "SUPPORTED");
  assert.equal(one(ledger("million usd", 26.91), claim(26910000, "usd")).status, "SUPPORTED");
  assert.equal(one(ledger("usd", 26910000), claim(26910, "usd thousand")).status, "SUPPORTED");
});

test("a wrong figure on the same scale is still CONTRADICTED, a wrong figure after scaling too", () => {
  assert.equal(one(ledger("usd", 26910000), claim(26900000, "usd")).status, "CONTRADICTED");
  assert.equal(one(ledger("usd", 26910000), claim(26.5, "million usd")).status, "CONTRADICTED");
});

test("a figure that differs only by a factor of 1,000 is reported as scale uncertain, not contradicted", () => {
  const r = one(ledger("usd", 26910000), claim(26.91, "usd"));
  assert.equal(r.status, "INSUFFICIENT_EVIDENCE");
  assert.deepEqual(r.flags, ["SCALE_UNCERTAIN"]);
  const r2 = one(ledger("usd", 26910000), claim(26910000000, "usd"));
  assert.deepEqual(r2.flags, ["SCALE_UNCERTAIN"]);
});

test("different currencies or unrelated units still do not match", () => {
  assert.deepEqual(one(ledger("usd", 100), claim(100, "eur")).flags, ["NO_CURRENT_OR_UNIT_MATCH"]);
  assert.deepEqual(one(ledger("usd", 100), claim(100, "count")).flags, ["NO_CURRENT_OR_UNIT_MATCH"]);
});

test("the could-not-check report names a scale slip", () => {
  const items = verifyClaims([claim(26.91, "usd")], ledger("usd", 26910000)).items;
  const r = buildNotCheckedReport({ ledger: ledger("usd", 26910000), items, x2: computeX2(items, 1000), runs: [{ ok: true, claims: 1, rejected: 0 }], k: 1, documentChars: 1000, profile: {} });
  assert.equal(r.unmatched_claims[0]?.reason, "SCALE_UNCERTAIN");
  assert.ok(r.lines.some((l) => /factor of 1,000/.test(l) && /not counted as contradictions/.test(l)));
});
