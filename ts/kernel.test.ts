import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { evaluate, PARAMS } from "./kernel.ts";
import type { Profile } from "./kernel.ts";

const vectors = JSON.parse(readFileSync(new URL("../spec/vectors.json", import.meta.url), "utf8"));

// Seeded PRNG (mulberry32) so property tests are reproducible.
function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function randomProfile(r: () => number): Profile {
  return {
    x1: r(), x2: r(), x3: r(), x4: r(), x5: r(),
    x6: r() < 0.3 ? 1 : 0,
    n_applicable: Math.floor(r() * 60),
    alert_status: "NONE",
  };
}

for (const vec of vectors) {
  test(`vector ${vec.id}: ${vec.description}`, () => {
    const res = evaluate(vec.input);
    const e = vec.expected;
    assert.equal(res.decision, e.decision);
    assert.deepEqual(res.triggers, e.triggers);
    assert.deepEqual(res.reasons, e.reasons);
    if (e.psi === null) assert.equal(res.psi, null);
    else {
      assert.notEqual(res.psi, null);
      assert.ok(Math.abs((res.psi as number) - e.psi) <= 5e-5, `psi ${res.psi} vs ${e.psi}`);
    }
    if (e.flags_include) for (const f of e.flags_include) assert.ok(res.flags.includes(f), `missing flag ${f}`);
    if (e.incomplete_fields) assert.deepEqual(res.incomplete_fields, e.incomplete_fields);
  });
}

test("extremes: all zeros gives exactly 1; all ones is within 1e-12 of 0.2856", () => {
  const zero = evaluate({ x1: 0, x2: 0, x4: 0, x5: 0, x6: 0, n_applicable: 40 });
  assert.equal(zero.psi, 1);
  const worst = evaluate({ x1: 1, x2: 1, x4: 1, x5: 1, x6: 1, n_applicable: 40 });
  assert.ok(Math.abs((worst.psi as number) - 0.2856) < 1e-12);
});

test("property: Psi stays within [0.2856, 1] for 100000 random valid profiles", () => {
  const r = rng(12345);
  for (let i = 0; i < 100000; i++) {
    const psi = evaluate(randomProfile(r)).psi as number;
    assert.ok(psi >= 0.2856 - 1e-12 && psi <= 1, `out of bounds: ${psi}`);
  }
});

test("property: Psi is non-increasing in x2, x4, x5, x6 (exact comparison)", () => {
  const r = rng(777);
  for (let i = 0; i < 20000; i++) {
    const p = randomProfile(r);
    const base = evaluate(p).psi as number;
    for (const k of ["x2", "x4", "x5"] as const) {
      const q = { ...p };
      q[k] = Math.min(1, (p[k] as number) + r() * 0.5);
      assert.ok((evaluate(q).psi as number) <= base, `not monotone in ${k}`);
    }
    const q6 = { ...p, x6: 1 };
    assert.ok((evaluate(q6).psi as number) <= base);
  }
});

test("property: x1 and x3 never change Psi", () => {
  const r = rng(99);
  for (let i = 0; i < 20000; i++) {
    const p = randomProfile(r);
    const q = { ...p, x1: r(), x3: r() };
    assert.equal(evaluate(q).psi, evaluate(p).psi);
  }
});

test("property: gate triggers do not depend on x1, x2, x3, x5", () => {
  const r = rng(2024);
  for (let i = 0; i < 20000; i++) {
    const p = randomProfile(r);
    const q = { ...p, x1: r(), x2: r(), x3: r(), x5: r() };
    assert.deepEqual(evaluate(q).triggers, evaluate(p).triggers);
  }
});

test("parameters match the paper", () => {
  assert.equal(PARAMS.THETA_DOC, 0.25);
  assert.equal(PARAMS.THETA_STAB, 0.2);
  assert.equal(PARAMS.N_MIN, 10);
  assert.equal(PARAMS.TAU_REVIEW_MICRO, 750000);
});
