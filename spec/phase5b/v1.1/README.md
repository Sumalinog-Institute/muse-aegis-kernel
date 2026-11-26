# Phase 5b v1.1 tuning log (8 projects that ended incomplete in every stage 2 run)

Purpose: find out why half of the pipeline runs on real GCF documents ended `INCOMPLETE_INPUT_MANUAL_REVIEW`, and fix it.
These 8 projects (FP022, FP046, FP069, FP095, FP116, FP125, FP179, FP183) are now a **tuning set**. Results here are not test results.
A fresh held-out sample is needed to measure the fixed pipeline (see the plan in the paper's future work).

| Run | Change | Pipeline runs complete (of 40) |
|---|---|---|
| stage 2 (frozen v1) | none | 0 |
| run 1 | relaxed quote match (ordered words) | 0 |
| run 2 | table repair v1 (wrapped cells joined) | 10 |
| run 3 | table repair v2 (column clustering, section heading in front of each row, ledger label "GCF financing") | 30 |

Runs 4 and 5 use all 15 stage 2 projects (the 8 above plus the 7 that worked before), to check for regressions (75 pipeline runs each):

| Run | Change | Incomplete runs (of 75) |
|---|---|---|
| run 4 | table repair v3 (column header labels, segmentation at headings and enumerated rows) | 8 (FP052 4, FP046 2, FP022 1, SAP043 1) |
| run 5 | table repair v4 (row labels in tall cells, label carry) | 14 (FP052 5, SAP043 5, FP092 4): **worse** |

Run 5 causes: the model leaves the bracketed row prefix out of its quote, so the subject is missing (all 50 rejections for FP052);
a figure such as `76,038,273.46` is split into `76,038,273.` and `46` in FP092; a heading rule mistook `67.774 Options` for a section
heading. Fixes for run 6: subject taken from the row context (`spec/CLAIMS.md`), heading rule limited to section-style numbers.
FP052 had 4 to 5 supported claims in each run before the repair, so run 4 and 5 are regressions to remove.

| Run | Change | Incomplete runs (of 75) |
|---|---|---|
| run 6 | row-context subject (relaxed mode), heading rule fix | 12 (FP052 5, SAP043 5, FP092 2) |
| run 7 | table repair v5: trailing-dot figures joined (`76,038,273.` + `46`), "Co- financing" wrap joined; SAP043 ledger given the document's wording "GCF funding" as a second subject (tuning only) | **4** (FP092 3, SAP043 1) |

Run 7 is the best state reached on the 15 tuning projects: 71 of 75 runs complete. The 4 remaining incomplete runs have no rejected
quotes: the model proposed only 2 to 4 claims from a document with about 20 figures, so the coverage rule correctly reports that it
did not check enough. That is extraction variability, not a reader defect. FP052 annual report table 3.3 never names the fund, so
its claims are correctly rejected. Tuning on these projects stops here; they can no longer serve as a fair test.
Still to do: ledger subject aliases (a proper replacement for the SAP043 workaround), unit and column checks for the new flags.

Cause found: in narrow table columns a cell wraps over several lines in `pdftotext -layout` output, so a figure such as
26,964,532.92 is stored as `26,964,532.9` and `2` on different lines. The AI rebuilt the figure correctly, but the document
text no longer contained it, so the word-for-word anchor check rejected the claim. See `tools/phase5b/repair_tables.py`.

Not yet solved:
- FP095 and FP183 proposal tables (B.2) put instrument names and amounts in separate blocks, which the reader does not join.
- FP046 and FP095 annual reports have no financial section, so no excerpt is cut.
- **Completeness is not correctness.** Run 3 has 21 flagged runs. Reading the contradicted claims shows many compare different
  quantities (for example the table's "Committed Amount" to subprojects against the fund's approved commitment, or the
  "Cumulative Expenditure" column against fund disbursements). These are mapping artefacts until a reviewer decides otherwise.
  Header-aware column labelling and comparable ledger attributes are the next step.

Files: `tuning_summary.json` (counts per run and project, bundle SHA-256). The raw result files are kept by the author.
