import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { computeX4, computeX5, namesMatch, screenWatchlist } from "./features.ts";

const path = new URL("../tools/features_crosscheck_cases.jsonl", import.meta.url);

test("TypeScript features equal the independent Python oracle on random cases", { skip: !existsSync(path) }, () => {
  const lines = readFileSync(path, "utf8").trim().split("\n");
  const n: Record<string, number> = {};
  for (const [i, line] of lines.entries()) {
    const c = JSON.parse(line);
    n[c.type] = (n[c.type] ?? 0) + 1;
    if (c.type === "x4") assert.deepEqual(computeX4(c.award, c.ledger), c.expected, `x4 case ${i}`);
    else if (c.type === "x5") assert.deepEqual(computeX5(c.schedule), c.expected, `x5 case ${i}`);
    else if (c.type === "screen") assert.deepEqual(screenWatchlist(c.award, c.ledger, c.register), c.expected, `screen case ${i}`);
    else assert.equal(namesMatch(c.a, c.b), c.expected, `names case ${i}: ${JSON.stringify([c.a, c.b])}`);
  }
  console.log(`checked ${JSON.stringify(n)}`);
});
