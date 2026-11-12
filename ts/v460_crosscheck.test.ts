import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { validateRejection, validateScreeningFields } from "./audit.ts";
import type { Entry } from "./audit.ts";

const path = new URL("../tools/v460_crosscheck_cases.jsonl", import.meta.url);

test("TypeScript and Python agree on project/document field checks and on rejection validation", { skip: !existsSync(path) }, () => {
  const lines = readFileSync(path, "utf8").trim().split("\n");
  const seen = new Set<string>();
  for (const [i, line] of lines.entries()) {
    const c = JSON.parse(line) as { kind: string; seq?: number; chain?: Entry[]; record: Record<string, unknown>; problems: string[] };
    const ts = c.kind === "fields" ? validateScreeningFields(c.record, c.seq as number) : validateRejection(c.chain as Entry[], c.record);
    assert.deepEqual([...ts].sort(), [...c.problems].sort(), `problem codes differ at case ${i} (${c.kind})`);
    for (const p of ts) seen.add(p.split(":")[0] ?? p);
  }
  console.log(`checked ${lines.length} cases; codes seen: ${[...seen].sort().join(", ")}`);
});
