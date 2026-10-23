import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { evaluate } from "./kernel.ts";

const path = new URL("../tools/crosscheck_cases.jsonl", import.meta.url);

function bits(x: number | null): string | null {
  if (x === null) return null;
  const dv = new DataView(new ArrayBuffer(8));
  dv.setFloat64(0, x, false);
  return dv.getBigUint64(0, false).toString(16).padStart(16, "0");
}

test("TypeScript and Python kernels agree bit for bit on generated cases", { skip: !existsSync(path) }, () => {
  const lines = readFileSync(path, "utf8").trim().split("\n");
  for (const [i, line] of lines.entries()) {
    const rec = JSON.parse(line);
    const res = evaluate(rec.input);
    assert.equal(bits(res.psi), rec.psi_bits, `psi bits differ at case ${i}`);
    assert.equal(res.psi_micro, rec.psi_micro, `psi_micro differs at case ${i}`);
    assert.equal(res.decision, rec.decision, `decision differs at case ${i}`);
    assert.deepEqual(res.triggers, rec.triggers, `triggers differ at case ${i}`);
    assert.deepEqual(res.reasons, rec.reasons, `reasons differ at case ${i}`);
    assert.deepEqual(res.flags, rec.flags, `flags differ at case ${i}`);
    assert.deepEqual(res.incomplete_fields, rec.incomplete_fields, `incomplete differ at case ${i}`);
  }
  console.log(`checked ${lines.length} cases`);
});
