import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { entryHash, validateOverride, validateRejection, validateScreeningFields } from "./audit.ts";
import type { Entry } from "./audit.ts";

type Vec = { id: string; type: "fields" | "rejection" | "override" | "hash"; seq?: number; prev_hash?: string; chain?: Entry[]; record: Record<string, unknown>; expected: string[] | string };
const vectors: Vec[] = JSON.parse(readFileSync(new URL("../spec/vectors-v460.json", import.meta.url), "utf8"));

for (const v of vectors) {
  test(`v4.6.0 vector ${v.id}`, async () => {
    if (v.type === "fields") assert.deepEqual(validateScreeningFields(v.record, v.seq as number).sort(), [...(v.expected as string[])].sort());
    else if (v.type === "rejection") assert.deepEqual(validateRejection(v.chain as Entry[], v.record).sort(), [...(v.expected as string[])].sort());
    else if (v.type === "override") assert.deepEqual(validateOverride(v.chain as Entry[], v.record).sort(), [...(v.expected as string[])].sort());
    else assert.equal(await entryHash(v.prev_hash as string, v.seq as number, v.record), v.expected);
  });
}
