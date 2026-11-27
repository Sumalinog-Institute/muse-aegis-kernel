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
