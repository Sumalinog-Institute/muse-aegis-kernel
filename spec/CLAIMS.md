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

## Subject aliases (v1.1)

A ledger fact may list `subject_aliases`, other names for the same subject (at most 10, each up to 200 characters), for example `"subject": "GCF financing", "subject_aliases": ["GCF funding"]`. A claim whose subject, attribute and period match the fact under its own subject **or under any alias** is checked against that fact. Nothing else changes: the unit, the validity dates and the value comparison are the same, and a wrong value under an alias is still CONTRADICTED. Without aliases a correct claim under the document's own wording was reported as INSUFFICIENT_EVIDENCE, which lowered coverage. Aliases are written by the person who prepares the ledger, so they are part of the sealed ledger and visible in the record.

## Relaxed anchoring (v1.1, off by default)

Real PDF tables are extracted with cells from different lines interleaved, so a model that copies a table row often drops or skips some cell text. The default rule above then rejects the claim, and a document can end as `INCOMPLETE` although its figures are correct. v1.1 adds an optional second step, used only when the word-for-word match fails and only if the deployment turns it on:

- Every word of the quote (ignoring punctuation at the edges of words, never inside numbers) must occur in the document **in the same order**, with at most 6 other words between neighbours, in a stretch of at most 1,200 characters. A quote of fewer than 3 words must still match word for word.
- The value and the subject must be in the quote **and** in the matched stretch. A figure invented by the model, or one that lies only in the skipped words, is rejected.
- The evidence kept for the claim is the document's own text for that stretch, not the model's wording. The position of the value is the same as for an exact match.
- **Row context (v1.1, relaxed mode only).** The table reader puts the section heading and, where it finds one, the row label in front of each repaired row, for example `[B.2. Project Financing Information > (b) GCF financing to recipient] Total requested ... Amount: 26.91`. Models often leave that bracketed prefix out of the quote, so the subject was missing from the quote. In relaxed mode the subject may then be taken from the prefix of the line in which the quoted stretch lies. The value must still be in the quote and the matched stretch, and the evidence kept for the claim shows the prefix in square brackets, so a reviewer sees which context was used. The prefix is reader-added text derived from the document's own headings and row labels.
- Each claim accepted this way is reported (`relaxed`), and each run reports up to 8 rejected quotes with their reasons, so a person can see what was and was not checked.

Risk: in a table, a name and a figure from neighbouring rows can lie within 6 words of each other. Such a claim is still checked against the ledger and shown to the reviewer with the document's own text, but it is the reason why this step is tested on held-out documents before it is turned on.

## What this does not do

It does not decide whether the ledger itself is right, does not understand claims that cannot be expressed as
subject, attribute, period and value, and depends on the extractor finding the claims. A document with most of
its important statements missed from the claim list can still look clean if the few claims found are supported.
The coverage rule is a coarse guard against that, not a guarantee.
