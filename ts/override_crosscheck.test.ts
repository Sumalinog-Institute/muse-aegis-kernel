import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { validateOverride } from "./audit.ts";
import type { Entry } from "./audit.ts";

const path = new URL("../tools/override_crosscheck_cases.jsonl", import.meta.url);

test("TypeScript and Python agree on override validation", { skip: !existsSync(path) }, () => {
  const lines = readFileSync(path, "utf8").trim().split("\n");
  const seen = new Set<string>();
  for (const [i, line] of lines.entries()) {
    const c = JSON.parse(line) as { chain: Entry[]; record: Record<string, unknown>; problems: string[] };
    const ts = validateOverride(c.chain, c.record);
    assert.deepEqual([...ts].sort(), [...c.problems].sort(), `problem codes differ at case ${i}`);
    for (const p of ts) seen.add(p.split(":")[0] ?? p);
  }
  console.log(`checked ${lines.length} override cases; codes seen: ${[...seen].sort().join(", ")}`);
});
