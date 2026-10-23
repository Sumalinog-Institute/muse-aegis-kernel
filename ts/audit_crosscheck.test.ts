import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { canonicalize } from "./jcs.ts";
import { entryHash } from "./audit.ts";

const path = new URL("../tools/audit_crosscheck_cases.jsonl", import.meta.url);

test("TypeScript and Python agree on canonical JSON and entry hashes", { skip: !existsSync(path) }, async () => {
  const lines = readFileSync(path, "utf8").trim().split("\n");
  let canon = 0;
  let hashes = 0;
  for (const [i, line] of lines.entries()) {
    const rec = JSON.parse(line);
    if (rec.type === "canon") {
      assert.equal(canonicalize(rec.value), rec.canonical, `canonical text differs at case ${i}`);
      canon++;
    } else {
      assert.equal(await entryHash(rec.prev, rec.seq, rec.record), rec.hash, `hash differs at case ${i}`);
      hashes++;
    }
  }
  console.log(`checked ${canon} canonical-JSON cases and ${hashes} entry hashes`);
});
