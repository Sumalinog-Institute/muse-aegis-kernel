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
