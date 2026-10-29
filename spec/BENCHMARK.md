# Comparison: plain AI judge versus the pipeline (Phase 5)

Reference code: `ts/judge.ts`, `ts/benchmark.ts`. Data: the eight synthetic scenarios in `fixtures/` (`benchmark-bundle.json`).
This is a demonstration on invented cases with known answers. It says nothing about effectiveness on real cases.

## The question

Given the same case, how steady is each approach across repeated runs, and does it notice the problems that were planted in the case?

## The two methods

- **Plain judge.** One model call. The prompt (`JUDGE_SYSTEM_PROMPT`) is meant to be fair, not a strawman: it states the funder's policy, explains
  how to check documents, reports, the watch list and the report's statements, and asks for a score (0 to 100), a level (PASS, REVIEW, ALERT,
  RESTRICT) and a list of issues in a fixed format. It receives the same material the pipeline receives (records, schedule, watch list, the
  funder's reference figures, the report), written out as text. There is no claim extraction, ledger matching or kernel.
- **Pipeline.** The Phase 3 screening: claims extracted over k = 3 runs at temperature 0.7, structured features, kernel. No MAC is made and nothing is written to the log.

Both use the same model and the same temperature (default 0.7).

## What is measured

1. **Spread.** Standard deviation (n - 1) and range of the score over the repeats, per scenario. Scores are on different scales (the judge is asked for 0 to 100; the pipeline's score is Psi x 100), so spread is compared and the level is not.
2. **Decision agreement.** The share of repeats that give the most common level. The pipeline's six decisions map to four levels: PASS; REVIEW (flag, documentation hold, incomplete input); ALERT; RESTRICT.
3. **Planted problems found (recall)** and **false alarms.** Each scenario has a list of planted problems (`planted.expected`) and a list of things that are fine to mention (`planted.tolerated`, for example an invoice still inside the grace period, a repeated export row, or a statement that cannot be checked). A found issue matches a planted one if its category agrees (or is OTHER) and its reference matches: identifiers must appear whole (R2 does not match R25); names and subjects match when at least half of their distinctive words appear, including one of five or more letters. Matching is lenient on wording, which can only favour the judge. Anything found that is neither planted nor tolerated is a false alarm.
4. **The severe case.** In `s3-confirmed-match` (a confirmed watch-list match) a run is a miss if the level is PASS or the score is 75 or more.
5. **The clean case.** In `s1-clean` (no problems) a run is a false alarm if the level is ALERT or RESTRICT.

## Known limits

- The pipeline defines the policy it is scored against, so its decisions are not scored as "right"; only spread, agreement, problems found, and the two extreme cases are compared.
- The judge prompt matters. A better prompt, or a stronger model, might do better; the prompt is published so others can try.
- The planted problems are few and simple. Eight scenarios and a handful of repeats show a pattern, not a statistic.
- In `s5-mixed-currency` and `s7-ledger-incomplete` the pipeline refuses to compute the documentation measure and sends the case to a person, so it does not list the missing documents (recall 5 of 7). This is intended behaviour and counts against it here.
- The free tier of the model service is unreliable; failed runs are counted and excluded from the statistics.
- The raw findings of every run are kept so any match can be checked by a person.
