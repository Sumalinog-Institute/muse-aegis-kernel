# Held-out test of the v1.1 pipeline: protocol (written 28 November 2026, before any held-out document was read)

## What is frozen
The extractor, the scoring and the reader are frozen at these commits and are not changed until the held-out results are recorded:
- kernel `muse-aegis-kernel` main at `e6d09d2ed6beb901c9f66dd6ac7e18b1d40c9b1e`
- app `aegis-score` main at `e5ed9ca67658c5b9befb4d1b7f59da0efd503303`
- model google/gemini-3.1-flash-lite, k = 3, temperature 0.7 (as in the app); the matching options `wholeWordSubject` and `wholeNumberValue` stay off; the extraction prompt is unchanged.
Known weaknesses are not fixed before the test and are reported as limits of v1.1: a model can obey an injected instruction (adversarial pack a3), a report that leaves out figures can still pass (a4), and the
score does not treat a contradicted figure as a trigger (a2). See `spec/phase5b/v1.1/ADVERSARIAL.md`.

## Frame and draw
Every GCF funding proposal approved at B.43 or earlier (FP001-FP288, SAP001-SAP065; FP289 and SAP066 open B.44, 25-28 March 2026), minus the 15 tuning projects
(FP014, FP022, FP046, FP052, FP069, FP092, FP095, FP116, FP125, FP179, FP183, FP236, FP248, SAP005, SAP043). The highest numbers checked on 28 November 2026 against GCF/B.46/02 (FP328 and SAP074 are B.46 approvals).
`tools/phase5b/draw_heldout.py` (seed 20261128, ordered random sample without replacement; the output is in `heldout_draw.json` and the script reproduces it exactly) gives 24 FP and 6 SAP projects,
plus ordered replacements (36 FP, 14 SAP). The draw is not repeated and is not changed by hand.

## Replacement rule
A project is replaced by the next unused project of its list (FP or SAP) only if its funding proposal PDF or its latest annual performance report PDF cannot be obtained from the GCF website, or has no
readable text (a scan). Each replacement is recorded with the reason. A project is never replaced because its documents look hard to read or its result is disliked.

## What is recorded for each project
Source address, retrieval date and SHA-256 of each PDF (the Screen page's provenance fields); the reader's output for the financial section; the ledger built from GCF's public data under the same rules as stage 2;
the pipeline and judge results; and the reviewers' labels where a flag needs one. Tuning documents are never reused.
