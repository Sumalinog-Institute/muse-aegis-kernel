import { test } from "node:test";
import assert from "node:assert/strict";
import { layoutPage, layoutText } from "./layout.ts";
import type { TextItem } from "./layout.ts";
import { repairTables } from "./tables.ts";
import { buildDocumentText, cutSection } from "./sections.ts";

// Fixed-width fake font: every character is 6 points wide, a line is 12 points high, lines are 14 points apart.
const W = 6, H = 12, P = 14;
const it = (s: string, col: number, row: number, page = 0): TextItem => ({ s, x: 40 + col * W, y: 50 + row * P + page * 0, w: s.length * W, h: H });

test("layout: words of one line are placed by position, with one space inside a phrase", () => {
  const lines = layoutPage([it("Morocco", 0, 0), it("Grants", 8, 0), it("USD", 30, 0), it("26,964,532.92", 40, 0)], 1);
  assert.deepEqual(lines, ["Morocco Grants" + " ".repeat(16) + "USD" + " ".repeat(7) + "26,964,532.92"]);
});

test("layout: a large vertical gap gives a blank line, and lines are ordered top to bottom", () => {
  const lines = layoutPage([it("second", 0, 1), it("first", 0, 0), it("far below", 0, 5)], 1);
  assert.deepEqual(lines, ["first", "second", "", "far below"]);
});

test("layout: pages are joined with a form feed at the start of the next page", () => {
  const t = layoutText([[it("page one", 0, 0)], [it("page two", 0, 0)]], 1);
  assert.equal(t, "page one\n\fpage two");
});

test("layout: empty and blank items are ignored", () => {
  assert.deepEqual(layoutPage([it("  ", 0, 0), it("", 2, 0)]), []);
});

test("end to end: a wrapped figure in a table is read back as one figure and the section is cut", () => {
  const page: TextItem[] = [
    it("B.2.", 0, 0), it("Project", 5, 0), it("Financing", 13, 0), it("Information", 23, 0),
    it("Morocco", 0, 2), it("Grants", 8, 2), it("26,964,532.9", 40, 2),
    it("2", 40, 3),
    it("Total", 0, 6), it("26.91", 40, 6), it("million", 50, 6), it("USD", 58, 6),
    it("B.3.", 0, 11), it("Next", 5, 11),
  ];
  const text = repairTables(layoutText([page], 1)).text;
  const s = cutSection(text, "proposal");
  assert.ok(s);
  assert.match(s.text, /Morocco Grants 26,964,532\.92/);
  assert.equal(buildDocumentText({ proposal: s.text, apr: null }).startsWith("=== PROPOSAL EXCERPT ===\nB.2."), true);
});

test("sections: nothing found gives null, a capped section is not accepted, the longest complete one wins", () => {
  assert.equal(cutSection("no headings here", "proposal"), null);
  assert.equal(cutSection("B.2. Project Financing Information\n" + "x\n".repeat(9000), "proposal"), null);
  const doc = ["B.2. Project Financing Information", "contents", "B.3. Next", "filler", "B.2. Project Financing Information", "a long line of real content", "another long line of real content", "B.3. Next"].join("\n");
  assert.equal(cutSection(doc, "proposal")?.first_line, 5);
});
