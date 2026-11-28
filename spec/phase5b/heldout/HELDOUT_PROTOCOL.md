# Held-out test of the v1.1 pipeline: protocol (written 28 November 2026, before any held-out document was read)

## What is frozen
The extractor, the scoring and the reader are frozen at these commits and are not changed until the held-out results are recorded:
- kernel `muse-aegis-kernel` main at `e6d09d2ed6beb901c9f66dd6ac7e18b1d40c9b1e`
- app `aegis-score` main at `e5ed9ca67658c5b9befb4d1b7f59da0efd503303`
- model google/gemini-3.1-flash-lite, k = 3, temperature 0.7 (as in the app); the matching options `wholeWordSubject` and `wholeNumberValue` stay off; the extraction prompt is unchanged.
Known weaknesses are not fixed before the test and are reported as limits of v1.1: a model can obey an injected instruction (adversarial pack a3), a report that leaves out figures can still pass (a4), and the
score does not treat a contradicted figure as a trigger (a2). See `spec/phase5b/v1.1/ADVERSARIAL.md`.

## Frame and draw (version 2, 28 November 2026)
The frame is the stage 2 pool (`spec/phase5b/stage2/stage2_draw_order.csv`: every GCF activity in the IATI list, because the ledger is built from the activity's IATI data, minus the 40 projects of stage 1 and
the pilot draw), restricted to projects approved at B.43 or earlier (FP001-FP288, SAP001-SAP065; FP289 and SAP066 open B.44, 25-28 March 2026), minus the 15 stage 2 projects and minus the 6 projects that stage 2 found to
have no published annual performance report. 222 FP and 51 SAP projects remain. The highest numbers were checked on 28 November 2026 against GCF/B.46/02 (FP328 and SAP074 are B.46 approvals).
`tools/phase5b/draw_heldout.py` (seed 20261128, ordered random sample without replacement; the output is in `heldout_draw.json` and the script reproduces it exactly) gives 24 FP and 6 SAP projects,
plus ordered replacements (36 FP, 14 SAP). The draw is not repeated and is not changed by hand.

## Correction: version 1 of the draw is void
The first draw (merged earlier the same day, kept as `heldout_draw_VOID_v1.json`) used FP001-FP288 and SAP001-SAP065 minus the 15 tuning projects only. It left out two conditions that the stage 2 protocol already
had: no project from the 40 projects of stage 1 and the pilot draw, and only projects with IATI data. Eleven of its 30 projects were such projects (FP005, FP006, FP007, FP047, FP079, FP083, FP163, FP186, FP253, FP266, SAP016).
The error was found by comparing the draw with the stage 2 pool before any held-out document had been read or any result produced. The same seed was used for the corrected frame, so the correction does not choose a new seed.

## Replacement rule
A project is replaced by the next unused project of its list (FP or SAP) only if its funding proposal PDF or its latest annual performance report PDF cannot be obtained from the GCF website, or has no
readable text (a scan). Each replacement is recorded with the reason. A project is never replaced because its documents look hard to read or its result is disliked.

## What is recorded for each project
Source address, retrieval date and SHA-256 of each PDF (the Screen page's provenance fields); the reader's output for the financial section; the ledger built from GCF's public data under the same rules as stage 2;
the pipeline and judge results; and the reviewers' labels where a flag needs one. Tuning documents are never reused.

## Run settings and excerpt rule (fixed 28 November 2026, before any run)
- Page: Phase 5b of the app. Bundle: `phase5b-heldout-bundle.json` (30 projects; its SHA-256 is shown on the page and must equal the value in the pull request). Judge prompt hash as in stage 2.
- Both methods (judge and pipeline), 3 repeats each as the page does; "Relaxed quote match" ON (the v1.1 setting used from tuning run 6 onward); "Pipeline only" OFF. Results are downloaded once, hashed, and not rerun.
- Excerpt rule: see `tools/phase5b/build_heldout_excerpts.py`. The frozen reader's section is used when it found one; a reference section (pdftotext + stage 2 rules) only when the reader found none or only a contents entry (under 1,000 characters while the reference is at least 3 times longer). Projects whose document has no financial section keep the placeholder text.
- Final sample and replacements: `final_sample.json`, `REPLACEMENTS.md`, `documents_manifest.json` (SHA-256 of all 60 documents).
