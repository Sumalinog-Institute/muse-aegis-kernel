# MUSE Aegis structured features (Phase 3, proposed rules)

These are the proposed rules for x4, x5 and x6 (and the alert status), computed from structured data with no model
involved. The fictional grant in `fixtures/` carries expected values produced by an independent Python oracle
(`tools/make_fictional_grant.py`); the TypeScript implementation must reproduce them exactly.
All parameters are provisional.

## Inputs

- **Award**: currency, planned start and end dates, documentation policy (cure days, excluded categories, required
  document types per category).
- **Spend ledger** (IATI-style expenditure records): id, date, category, receiver organisation (name, identifiers), value,
  currency, documents (type, reference, date); plus `as_of` and an attestation `complete`.
- **Reporting schedule**: reports with due dates and submission dates; `as_of`; attestation `repository_complete`.
- **Watch list**: entries with name, aliases, identifiers.

## x4: documentation deficit (value-weighted)

1. If the ledger is not attested complete: `INCOMPLETE` (never 0).
2. Records with the same id and identical content count once (flag `DUPLICATE_ID`). Same id with different content: `INCOMPLETE`.
3. Excluded categories (for example bank charges) and records outside the award period are not applicable.
4. Any applicable record in another currency than the award: `INCOMPLETE` (`MIXED_CURRENCY`).
5. A record is documented when every document type required for its category is present.
6. An undocumented record counts as undocumented only if it is older than the cure window (30 days). A younger one is pending: it stays in the denominator but not in the numerator.
7. `x4 = undocumented value / applicable value`, computed in whole minor units (cents) with one division. `n_applicable` = number of applicable records. No applicable records: `NA`.

## x5: reporting opacity

1. Repository not attested complete: `INCOMPLETE`.
2. A report is due when its due date is before `as_of`. No due reports: `NA`.
3. A report counts as submitted when it has a submission date on or before `as_of` (late counts as submitted, and is flagged).
4. `x5 = (due - submitted) / due`, one division of integers.

## x6 and alert status: watch-list screening

Parties screened: the recipient and every payee on applicable records.
Names are compared after NFKC, lower-casing, punctuation removal and dropping legal-form words (ltd, co, company, inc, ...):

- `EXACT`: the same set of words.
- `SIMILAR`: the word counts differ by at most one and every word of the shorter name matches a word of the longer one (equal, or one edit apart when the word has at least 5 letters).

For each party and each watch-list entry (name or alias):

| Identifier match | Name match | Result |
|---|---|---|
| yes | yes | CONFIRMED: `x6 = 1` |
| yes | no | CONFLICTING alert (an identifier hit with a different name is not trusted automatically) |
| no | yes | UNVERIFIED alert |
| no | no | nothing |

Overall: any CONFIRMED gives `x6 = 1`; otherwise CONFLICTING, then UNVERIFIED, then NONE. Alerts need a person to resolve them.

## Input checks (all three calculators)

Inputs are validated at run time. A value that cannot be used gives `INCOMPLETE` with a reason code, never 0:
`INVALID_INPUT`, `INVALID_TRANSACTION`, `INVALID_REPORT`, `REGISTER_INVALID`, `INVALID_AMOUNT` (an amount that is negative, not a number,
or has more than two decimals, so nothing is silently rounded), `UNKNOWN_CATEGORY` (a category with no documentation rule),
`DUPLICATE_ID_CONFLICT`, `MIXED_CURRENCY`, `LEDGER_INCOMPLETE`, `REPOSITORY_INCOMPLETE`. Dates must be real calendar dates (YYYY-MM-DD).

## Limits

Name matching is a coarse deterministic rule, not entity resolution: it will miss transliterations and aliases not on the
list, and will raise alerts for innocent look-alikes. That is why alerts go to a person.
