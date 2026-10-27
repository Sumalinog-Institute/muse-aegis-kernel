# MUSE Aegis instability x1 and consensus (Phase 3)

Reference code: `ts/stability.ts`. The extractor is run k times (default 3, at most 10) at a declared temperature (default 0.7).
The k runs give both x1 and the consensus claim set that feeds x2.

## Alignment

A claim is identified by **where its value sits in the document** (`claim.at`, recorded when the claim is accepted). The same figure found in
two runs is the same claim even if the model words its subject, attribute or period differently, because wording drift is not
unreliability. (Version 1 of this measure identified claims by their wording; the first live run gave x1 = 0.61 for three runs that
found the same six facts, which showed the flaw.) For each claim and run the label is its evidence status or `ABSENT`: the five labels
of the paper. If a run proposes several claims for one figure, the most severe status is used (ties broken by key, then value).

Wording still matters when it changes the verdict: a label that stops matching the claims ledger changes the status, and that disagreement
is counted.

## x1

- `sigma_jsd` = disagreeing run pairs (labels differ), summed over every figure found in any run, divided by (number of figures x number of run pairs).
  This is the mean base-2 Jensen-Shannon divergence between one-hot labels (0 if equal, 1 if different), written as one division of integers.
- `sigma_sem` = mean over run pairs of (1 - cosine of the run embeddings) / 2, where a run's text is its figures (positions) and statuses, sorted, as canonical JSON.
  Identical runs are at distance exactly 0. Needs an embedding function; none is connected in the prototype.
- `x1 = min(1, 0.5 sigma_jsd + 0.5 sigma_sem)` in mode `jsd_sem`; `x1 = sigma_jsd` in mode `jsd_only`. **The two modes are different scales
  and are never pooled**; the mode is recorded with every result.
- Fewer than k valid runs, or an embedding failure: `INCOMPLETE` (never 0).
- Decision effect: x1 >= 0.20 (provisional) withholds an automatic pass; it never lowers the score.

## Consensus

For each figure, count the labels over the k runs (a status, or ABSENT). A clear winner that is a status keeps the claim with that status.
A clear winner of ABSENT drops it. Any tie keeps it as `AMBIGUOUS_CONFLICT` (flag `RUN_TIE`).

## Limits

Temperature above 0 makes variation visible but is not a calibrated measure of reliability. k = 3 is a cheap default for demonstrations;
the paper's validation protocol uses k = 10. Statistics from three runs are coarse. A document whose claims are missed by every run
shows x1 = 0, so x1 measures consistency, not completeness; the coverage rule in x2 covers part of that gap.
