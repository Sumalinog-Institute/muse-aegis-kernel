# MUSE Aegis claims and verification (Phase 3, step 1)

Reference code: `ts/claims.ts`. This replaces, for the prototype, the NLI-probability verifier described in paper
Section 7.2 with **typed claims checked by deterministic matching**. The NLI mode remains a possible future option.
A model (or a person) only PROPOSES claims; every later step is plain code.

## A claim

| Field | Meaning |
|---|---|
| `subject`, `attribute`, `period` | What the claim is about, for example "Vendor A", "disbursed amount", "2026-Q2". Together they form the key. |
| `value_text` | The value exactly as written in the document |
| `unit` | For example `USD`, `KRW`, `%`, `count`, `date`, or empty |
| `quote` | An exact passage from the document that states the claim |
| `label_id` | Optional: the number of a preferred ledger label the claim is about, or null |

## Acceptance (anchoring)

A proposed claim is accepted only if all of these hold, otherwise it is rejected with a reason and reported:
1. Every field is present and within the length limits (200 characters; quote 500). At most 200 claims per document.
2. The `quote` occurs in the document (compared after Unicode NFKC normalization, collapsed whitespace and lower-casing).
3. The `value_text` occurs inside the quote, and so does the `subject` (so a label cannot be attached to a figure that belongs to someone else).
4. The value is read as a number only if it is plain digits with optional thousands commas, a decimal part, a leading currency symbol or a trailing `%`. Anything else ("12 thousand") stays text and is never silently converted.

**Picking a ledger label.** When preferred labels are offered (numbered, from the claims ledger) and a claim gives a valid `label_id` (an integer in range) whose subject is named in the claim's quote, the ledger's own subject, attribute and period replace the model's wording, so wording drift cannot stop a claim from matching its ledger fact. Otherwise the pick is ignored and the model's own wording is used (which usually will not match, giving INSUFFICIENT_EVIDENCE). A pick never relaxes the other checks.

Each accepted claim also records `label` (the number that was used, or null) and `at`: the position of its value in the normalized document, used to align the same figure across runs.

Rejected reasons: `NOT_AN_OBJECT`, `EMPTY_FIELD`, `TOO_LONG`, `QUOTE_NOT_IN_DOCUMENT`, `VALUE_NOT_IN_QUOTE`, `SUBJECT_NOT_IN_QUOTE`, `TOO_MANY_CLAIMS`.

## The reference ledger

A list of facts `{id, subject, attribute, period, value, unit, valid_from?, valid_to?}` plus a snapshot id and snapshot date.
Facts outside their validity window on the snapshot date are stale: ignored, and reported.

## Statuses (mutually exclusive)

For each distinct claim (same key, value and unit count once), using current facts with the same key and unit:

| Situation | Status |
|---|---|
| No matching current fact (empty ledger, stale only, unit differs, no such key) | `INSUFFICIENT_EVIDENCE` (with a flag saying why) |
| Matching facts disagree with each other | `AMBIGUOUS_CONFLICT` |
| One distinct value, number compared with text | `INSUFFICIENT_EVIDENCE` with flag `VALUE_TYPE_MISMATCH` |
| One distinct value, equal to the claim | `SUPPORTED` |
| One distinct value, different from the claim | `CONTRADICTED` |

## x2

`x2 = (N_contradicted + 0.5 N_ambiguous + 0.5 N_insufficient) / N_claims`, computed as an exact fraction of integers.
If there are no claims, or fewer than `max(1, ceil(0.2 x document_characters / 1000))` (provisional), x2 is `INCOMPLETE`
(`UNCHECKED_COVERAGE_FAILURE` or `LOW_CLAIM_COVERAGE`), never 0, and the kernel routes the case to manual review.

## What this does not do

It does not decide whether the ledger itself is right, does not understand claims that cannot be expressed as
subject, attribute, period and value, and depends on the extractor finding the claims. A document with most of
its important statements missed from the claim list can still look clean if the few claims found are supported.
The coverage rule is a coarse guard against that, not a guarantee.
