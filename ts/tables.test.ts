import { test } from "node:test";
import assert from "node:assert/strict";
import { repairTables } from "./tables.ts";

// Fixture and expected output come from the Python reference (tools/phase5b/repair_tables.py).
const DOC = "B.2. Project Financing Information\n\n                                    Committed Amount      Disbursed Amount\nMorocco   Grants   USD              26,964,532.9          30,001,600\n                                    2\n                                    \n(b) GCF                  Options     Amount\n     (iii) Equity        Equity     20.7\nfinancing to\nrecipient\n     Total requested     26.91      million USD\n(c) Co-\nfinancing to\nrecipient\n  Grant         14.00       12,5\n                            00\n\nPlain paragraph with a figure 12,345 and nothing else.\n";
const EXPECTED = "B.2. Project Financing Information\n\n[B.2. Project Financing Information] Morocco Grants USD Committed Amount 26,964,532.92 Disbursed Amount 30,001,600\n                                    \n[B.2. Project Financing Information] (b) GCF (iii) Equity financing to recipient Total requested Options Equity 26.91 Amount 20.7 million USD\n[B.2. Project Financing Information] (c) Co-financing to recipient Grant 14.00 12,500\n\nPlain paragraph with a figure 12,345 and nothing else.\n";

test("tables: repair gives the same text as the Python reference", () => {
  const r = repairTables(DOC);
  assert.equal(r.text, EXPECTED);
  assert.equal(r.blocks, 3);
});

test("tables: text outside table blocks is not changed, and an empty input stays empty", () => {
  const prose = "Plain paragraph with a figure 12,345 and nothing else.\n\nSecond paragraph.";
  assert.equal(repairTables(prose).text, prose);
  assert.equal(repairTables("").text, "");
});

test("tables: a wrapped figure is joined, a label in a tall cell is carried to the total row", () => {
  const out = repairTables(DOC).text;
  assert.match(out, /Committed Amount 26,964,532\.92/);
  assert.match(out, /\[B\.2\. Project Financing Information\] \(c\) Co-financing to recipient Grant 14\.00 12,500/);
});

test("tables: a figure such as '49.2 million' is not a section heading", () => {
  const doc = "B.2. Project Financing Information\n\n      Total project financing      49.2        million\n      GCF financing                39.3        million\n";
  const out = repairTables(doc).text;
  assert.doesNotMatch(out, /\[49\.2/);
  assert.match(out, /\[B\.2\. Project Financing Information\]/);
});
