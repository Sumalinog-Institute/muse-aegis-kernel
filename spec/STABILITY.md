# MUSE Aegis instability x1 and consensus (Phase 3)

Reference code: `ts/stability.ts`. The extractor is run k times (default 3, at most 10) at a declared temperature (default 0.7).
The k runs give both x1 and the consensus claim set that feeds x2.

## Alignment

A claim's identity is (subject|attribute|period, value, unit). A claim missing from a run is labelled ABSENT in that run. A claim whose
value changes between runs counts as two claims, each absent in some runs. (The paper aligns by claim key; including the value means
a changed figure counts as disagreement, which is the intent.) Because verification is deterministic, a claim that is present always
has the same status, so two runs can only disagree about a claim by one having it and the other not.

## x1

- `sigma_jsd` = disagreeing run pairs, summed over every claim in any run, divided by (number of claims x number of run pairs).
  This is the mean base-2 Jensen-Shannon divergence between one-hot labels (0 if equal, 1 if different), written as one division of integers.
- `sigma_sem` = mean over run pairs of (1 - cosine of the run embeddings) / 2, where a run's text is its sorted claim identities as canonical JSON.
  Identical runs are at distance exactly 0. Needs an embedding function; none is connected in the prototype.
- `x1 = min(1, 0.5 sigma_jsd + 0.5 sigma_sem)` in mode `jsd_sem`; `x1 = sigma_jsd` in mode `jsd_only`. **The two modes are different scales
  and are never pooled**; the mode is recorded with every result.
- Fewer than k valid runs, or an embedding failure: `INCOMPLETE` (never 0).
- Decision effect: x1 >= 0.20 (provisional) withholds an automatic pass; it never lowers the score.

## Consensus

For each claim, count the runs where it is present (p) against absent (k - p). More present than absent: kept with its status.
An exact tie: kept as `AMBIGUOUS_CONFLICT` (flag `RUN_TIE`). Fewer present than absent: dropped.

## Limits

Temperature above 0 makes variation visible but is not a calibrated measure of reliability. k = 3 is a cheap default for demonstrations;
the paper's validation protocol uses k = 10. Statistics from three runs are coarse. A document whose claims are missed by every run
shows x1 = 0, so x1 measures consistency, not completeness; the coverage rule in x2 covers part of that gap.
