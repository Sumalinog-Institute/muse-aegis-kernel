# PDF intake in the browser (v1.1)

Goal: let the operator screen a real GCF document without a command-line step. The PDF is read **on the operator's computer**; the file
is not uploaded (the same rule as the file fingerprint in the provenance block).

Pipeline, all in TypeScript and deterministic (no model call):
1. `ts/layout.ts`: positioned text pieces (from a PDF reader in the browser) are placed on a character grid, one line per text line, cells at
   their horizontal position, blank lines at large vertical gaps, a form feed at each new page. It looks like `pdftotext -layout`.
2. `ts/tables.ts`: table rows are repaired (port of `tools/phase5b/repair_tables.py`; output identical on 30 real documents, `tools/phase5b/parity_tables.mjs`).
3. `ts/sections.ts`: the financial section is cut with one rule set for all projects (port of `scripts/cut_excerpts_stage2.py`; identical on the same 30 documents).
4. The operator sees the text that will be screened and its source (provenance `text_method`), and can correct it before screening.

Evaluation of step 1 against the pdftotext path (`tools/phase5b/eval_layout.mjs`, 30 documents of the 15 tuning projects):
the same 27 sections are found (the 3 documents without a recognised section are the same in both paths); 621 figures in the excerpts,
**0 figures that the pdftotext path does not have**, 1 figure that it has and the browser path lacks. The grid pitch (0.8 x the median character
width) was chosen on these documents, where values from 0.7 to 0.9 gave the same result; it is a tuning choice and the test documents of the
held-out sample must not be used to change it.

Limits: the evaluation uses poppler's word boxes (`pdftotext -bbox`), not the output of the browser's PDF reader, which groups text differently, so
the browser path needs its own check on the same documents before real use. Scanned PDFs (images without text) give no text and are refused.
Documents that are not in the GCF templates give no section: the operator then pastes the text by hand, as today.

## First use on real PDFs (27 November 2026)

The first run of the browser reader on FP014, FP022 and FP046 showed three faults that the word-box evaluation had not shown, because
pdf.js returns text with the PDF's own wide word spacing: (1) the FP022 section was not found because the heading is written
"B.2.     Project      Financing         Information" and the rule needed single spaces; (2) the section heading in the row prefix kept
that spacing and was cut at 70 characters; (3) blank lines appeared between lines of one paragraph. Changes: the TypeScript section rules accept any
white space between the words of a heading (`\s+`); both readers (Python and TypeScript) collapse white space in the heading used as the row
prefix (table repair v6, still identical on 30 documents); the blank-line threshold of the layout renderer is 2.0 times the line pitch (the share of
blank lines then equals that of pdftotext: 0.12 against 0.13 on FP022). A second proxy for pdf.js items (pdfplumber words with font-size heights)
finds the section in all three documents. The frozen Python cutter of stage 2 is not changed; the TypeScript rules are the wider ones.

## Text tidy-up (27 November 2026, tidy v1, table repair v7)

The first real section (FP022) was found but read badly: figures wrapped in leader dots ("……49,2…"), words cut by narrow columns ("Instituti" /
"on", "Curren" / "cy"), the page header and footer inside table rows, and decimal commas ("39 292 600,00", "4,10"). `ts/tidy.ts` adds a
deterministic step before the table repair (`tidyPre`) and a small one after it (`tidyPost`). It changes how the text looks, not what the document
says, and counts what it did (shown to the operator; a short form goes into the provenance `text_method`).

1. **Leader dots.** A run of dots or "…" that stands alone or is fixed to a figure becomes spaces. An ellipsis inside a sentence stays.
2. **Running header and footer.** A line among the first or last three lines of a page that occurs on at least three pages and is either a "PAGE n OF m" line
   or (almost) all capitals is blanked. Mixed-case table headers repeated at the top of pages are kept.
3. **Split words.** Two parts are joined (same column on one of the next three lines, or one space apart) only if the first part is at least four letters and is not
   a word elsewhere in the document, the second is one to four lower-case letters (and not a frequent word of its own if longer than three), and the joined word is used in the document.
   Nothing is looked up in a dictionary and nothing is spelled "correctly": a misspelling in the document stays.
4. **Decimal commas.** If the document as a whole uses them (two or more space-grouped amounts such as "39 292 600,00", or clearly more decimal commas than decimal points),
   "39 292 600,00" is written "39,292,600.00" and "4,10" "4.10", with the same width. Other documents are not touched, so "12,13" in a list of pages is never changed.
5. **After the repair.** "(   )" becomes "( )", and "co- funding" becomes "co-funding".

One fault found on the way: after step 4 a figure such as "49.2 million" looked like a section number ("49.2" plus a word) and became a row prefix. Section numbers must now be
followed by a capital letter or a bracket (table repair v7, applied to both readers; still identical on 30 documents).

What it cannot do: the form fields of FP022 hold "49,2" and "39,3" (rounded values with dots around them); the exact amounts "49 188 000,00" and "39 292 600,00" are in the
budget table elsewhere in the document, not in this section. The reader shows what the document contains and does not supply digits it does not have.

Evaluation on the 15 tuning projects (30 documents, word boxes): the same 27 sections are found; the number of figures that appear only in the browser path is 7, of which 6 are decimal-comma
figures now written in English form (FP014, FP022) and 1 is a figure that the page header had split in the pdftotext path (FP092 APR 35,672,790.52). Tests: `ts/tidy.test.ts`.
