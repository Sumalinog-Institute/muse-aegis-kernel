import { test } from "node:test";
import assert from "node:assert/strict";
import { validateProvenance } from "./provenance.ts";
import { buildNotCheckedReport } from "./notchecked.ts";
import { computeX2 } from "./claims.ts";

const TODAY = "2026-11-27";
const good = { source_url: "https://www.greenclimate.fund/document/example-proposal", retrieved_on: "2026-11-20", file_sha256: "a".repeat(64), text_method: "pdftotext -layout + table repair v5, section cut v1" };

test("a complete block is accepted unchanged, and so is a block with one field", () => {
  const r = validateProvenance(good, TODAY);
  assert.deepEqual(r.ok && r.value, good);
  assert.equal(validateProvenance({ retrieved_on: "2026-11-27" }, TODAY).ok, true);
});

test("addresses must be https, without credentials, query string or fragment", () => {
  for (const u of ["http://example.org/a.pdf", "https://user:pw@example.org/a.pdf", "https://example.org/a.pdf?token=1", "https://example.org/a.pdf#p3", "ftp://x.org/a", "not a url", "https://localhost/a", "https://example.org/a b.pdf", "https://example.org/" + "x".repeat(500)]) {
    const r = validateProvenance({ source_url: u }, TODAY);
    assert.deepEqual(!r.ok && r.problems, ["BAD_SOURCE_URL"], u);
  }
});

test("dates must be real, not in the future and not before 2000", () => {
  for (const d of ["2026-11-28", "2026-02-30", "1999-12-31", "20-11-2026", "yesterday"]) {
    const r = validateProvenance({ retrieved_on: d }, TODAY);
    assert.deepEqual(!r.ok && r.problems, ["BAD_RETRIEVED_ON"], d);
  }
});

test("fingerprints must be 64 lower-case hex characters; the method must be plain text", () => {
  assert.deepEqual((validateProvenance({ file_sha256: "A".repeat(64) }, TODAY) as { problems: string[] }).problems, ["BAD_FILE_SHA256"]);
  assert.deepEqual((validateProvenance({ file_sha256: "a".repeat(63) }, TODAY) as { problems: string[] }).problems, ["BAD_FILE_SHA256"]);
  assert.deepEqual((validateProvenance({ text_method: "  " }, TODAY) as { problems: string[] }).problems, ["BAD_TEXT_METHOD"]);
  assert.deepEqual((validateProvenance({ text_method: "a\nb" }, TODAY) as { problems: string[] }).problems, ["BAD_TEXT_METHOD"]);
});

test("unknown fields, empty blocks and non-objects are refused", () => {
  for (const u of [{}, { other: 1 }, { ...good, extra: "x" }, null, "x", [], 5]) assert.equal(validateProvenance(u, TODAY).ok, false);
});

test("the report names a missing provenance only when it was asked about", () => {
  const items = [] as never[];
  const base = { ledger: { snapshot_id: "L", snapshot_date: "2026-11-01", facts: [] }, items, x2: computeX2([], 1000), runs: [], k: 1, documentChars: 1000, profile: {} };
  assert.ok(buildNotCheckedReport({ ...base, provenanceRecorded: false }).lines.some((l) => /No source address/.test(l)));
  assert.ok(!buildNotCheckedReport({ ...base, provenanceRecorded: true }).lines.some((l) => /No source address/.test(l)));
  assert.ok(!buildNotCheckedReport(base).lines.some((l) => /No source address/.test(l)));
});
