import { test } from "node:test";
import assert from "node:assert/strict";
import { isEuropean, tidyPre, tidyPost, tidySummary, tidyMethod } from "./tidy.ts";

const pageWith = (head: string, body: string): string => `${head}\n${body}\nsome closing line`;

test("tidy: leader dots become spaces and the width is kept", () => {
  const r = tidyPre("Total  ……49,2…   million\nGuarantees  ..........  none");
  assert.equal(r.text, "Total    49,2    million\nGuarantees              none");
  assert.equal(r.report.leader_runs, 2);
  const prose = "medicinal, nutritional...etc. and (GCF, EU…) and 1.5 million";
  assert.equal(tidyPre(prose).text, prose);
});

test("tidy: a running header or footer on many pages is removed, other lines are not", () => {
  const pages = [1, 2, 3, 4, 5].map((n) => pageWith(`GREEN CLIMATE FUND FUNDING PROPOSAL | PAGE ${n} OF 63 B`, `Body text ${n} with Financial Instrument Amount`));
  const r = tidyPre(pages.join("\f"));
  assert.equal(r.report.running_lines, 5);
  assert.doesNotMatch(r.text, /PAGE \d/);
  assert.match(r.text, /Body text 3/);
});

test("tidy: a repeated mixed-case table header at the top of pages is kept, and short documents are not touched", () => {
  const withHeader = [1, 2, 3, 4].map((n) => pageWith("Financial Instrument     Amount     Currency", `row ${n}`)).join("\f");
  assert.equal(tidyPre(withHeader).report.running_lines, 0);
  const short = [1, 2].map((n) => pageWith(`PROPOSAL | PAGE ${n} OF 2`, "x")).join("\f");
  assert.equal(tidyPre(short).report.running_lines, 0);
});

test("tidy: a word split over two lines of one column is joined when the joined word is used elsewhere in the document", () => {
  const doc = [
    "Name of the Institution that receives funds and the currency of the grant.",
    "",
    "                  Name of",
    "                  Instituti        Tenor",
    "                  on",
  ].join("\n");
  const r = tidyPre(doc);
  assert.match(r.text, /Institution {1,}Tenor/);
  assert.doesNotMatch(r.text, /^\s+on$/m);
  assert.equal(r.report.joined_words, 1);
});

test("tidy: a split word on one line is joined too, but real words and unknown joins are left alone", () => {
  const doc = "Name of Instituti on here. Institution is used again. The Plan to act is a plan. Grantee s are not words.";
  const r = tidyPre(doc);
  assert.match(r.text, /Name of Institution here/);
  assert.match(r.text, /The Plan to act is a plan/);
  assert.match(r.text, /Grantee s are/);
});

test("tidy: decimal-comma numbers are rewritten only in a document that uses them, and the width is kept", () => {
  const eu = "Total 39 292 600,00 4 095 400,00 and later 4,10 and 5,0 and 0,80";
  const r = tidyPre(eu);
  assert.equal(r.text, "Total 39,292,600.00 4,095,400.00 and later 4.10 and 5.0 and 0.80");
  assert.equal(r.text.length, eu.length);
  assert.equal(r.report.european_numbers, 5);
  const en = "See pages 12,13 and 14,15. Total 1,234.56 and 78.90 and 5,000";
  assert.equal(isEuropean(en), false);
  assert.equal(tidyPre(en).text, en);
});

test("tidy: after the repair, empty brackets and wrapped prefixes are tidied", () => {
  assert.equal(tidyPost("( ) years (   ) % co- funding Non- governmental pre- and post-war"), "( ) years ( ) % co-funding Non-governmental pre- and post-war");
});

test("tidy: the summary names only what was done", () => {
  assert.equal(tidySummary({ leader_runs: 3, running_lines: 0, joined_words: 0, european_numbers: 0, duplicates: 0 }), "");
  assert.equal(tidySummary({ leader_runs: 0, running_lines: 4, joined_words: 2, european_numbers: 9, duplicates: 0 }), "9 decimal-comma numbers rewritten, 2 split words joined, 4 page header/footer lines removed");
});

test("tidy: the method text is short enough to sit in the provenance", () => {
  const m = tidyMethod({ leader_runs: 22, running_lines: 119, joined_words: 7, european_numbers: 167, duplicates: 3 });
  assert.equal(m, "tidy v2: 167 numbers, 7 words, 119 header lines, 3 doubles, 22 dot runs");
  assert.ok(m.length < 80);
});

test("tidy: a field text drawn twice is dropped once, and a decimal comma before a percent sign is always read as a decimal", () => {
  const r = tidyPre("IFAD GrantGrant Amount CreditCreditCreditCredit\nISDB Senior LoansSenior Loans 25 years Pricing: 12,5% and 0,75% and 1,234 trees; bookkeeping");
  assert.match(r.text, /^IFAD Grant {6}Amount/);
  assert.match(r.text, /Senior Loans {13}25 years Pricing: 12\.5% and 0\.75% and 1,234 trees; bookkeeping/);
  assert.match(r.text, /Credit {18}\n/);
  assert.equal(r.report.duplicates, 4);
  assert.equal(r.report.european_numbers, 2);
});
