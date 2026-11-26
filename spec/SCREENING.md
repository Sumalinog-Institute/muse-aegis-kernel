# MUSE Aegis screening flow and log record (Phase 3, step 5)

Reference code: `ts/screening.ts` (and `appendRecord` in `ts/append.ts`).

## Two steps, so a person sees everything before anything is written

1. **Prepare** (`prepareScreening`): runs the extractor k times, computes x1 (stability), x2 (claims against the claims ledger),
   x4, x5, x6 and the alert status (structured data), runs the kernel, and returns a **draft** with full details. Nothing is written.
   The server adds a MAC (HMAC-SHA256 with a server secret of at least 32 characters) over the draft's canonical JSON.
2. **Commit** (`commitScreening`): the reviewer approves, with an optional note (at most 500 characters). The server checks that the
   draft's MAC is valid (so it is exactly what the server produced), that it belongs to the same account, that it is not older than the maximum draft age
   (default 30 minutes; at most 14 days for a deployment that keeps drafts in a queue; a missing or invalid value means 30 minutes) and not from the future (up to 5 minutes of clock skew allowed), and that the kernel still gives the same decision and score for its profile. It then appends a signed
   entry. Rejecting a draft needs no call: it is simply not committed.

Model output is not repeatable, so the draft that was reviewed must be the one stored; the MAC guarantees it.

## The log record (kind SCREENING, format version 2)

Top level: `doc_hash` (SHA-256 of the document text), `input` (the profile given to the kernel), `result` (the kernel output),
`extractor_version` (model, prompt version, number of runs and temperature), `ledger_id`, `policy_version`, `timestamp`, `actor_id`.

`details`:
- `inputs`: SHA-256 hashes of the five input files (award, spend ledger, reporting schedule, watch list, claims ledger), plus ids and the as-of date.
  The inputs themselves are not stored, so the exact inputs can be proved later by re-hashing them.
- `features`: the full results for x4 (values, undocumented and pending records), x5 (late and missing reports) and the watch-list screening (hits).
- `claims`: every consensus claim with its status, exact quote and matching ledger fact ids; x2 with its counts; ledger flags.
- `stability`: x1 with its mode and parts, the model, k, temperature, token usage, and for each run what it found (position, status, wording and label of each figure, plus the reasons any proposals were rejected), so a disagreement between runs can be traced.
- `not_checked` (v1.1; absent in older records): the "could not check" report, derived only from what the screening already holds. It lists the figures that could not be compared with the ledger, the ledger entries that no figure was compared with, how many model quotes were refused because they could not be traced to the document (by reason, with up to 8 samples), the claim count against the number required for this document length, failed runs, and profile parts that could not be computed, and gives each as a plain-language sentence in `lines`. Long lists are cut at 25 items and the real totals are always given. An empty `lines` means nothing was left unchecked by these rules; it does not mean the document is correct.
- `review`: decision (APPROVED), reviewer, review time, note, the draft's creation time and its MAC.

Records of this kind may be up to 200,000 characters; older plain records are limited to 20,000.

## Limits

- The MAC proves the server made the draft, not that it is committed once. This module alone would allow the same approved draft to be
  committed twice within its life; both entries would carry the same draft MAC, so a repeat is visible. A deployment that saves drafts
  must make approval single-use (an atomic status change from pending to approved in the same transaction as the signed append).

## Saved drafts (from v4.5.0-spec, for deployments with a review queue)

1. The maximum draft age is a parameter (`maxAgeMs` on `commitScreening` and `checkDraft`): default 30 minutes, upper bound 14 days.
2. A draft can be committed once. Enforcing this is the deployment's job (see Limits).
3. At approval the draft's `policy_version`, `extractor_version` and snapshot identifiers (`award_id`, `spend_snapshot_id`,
   `claims_snapshot_id`, `as_of`) are compared with the latest prepared screening for the same award; a missing or different value
   refuses the approval. This shows the draft is not older than another prepared screening; it does not prove the snapshots are the
   authoritative current ones, because no such source exists yet.
4. Only the account that prepared a draft can approve it (unchanged).
5. Rejecting a draft is a workflow status with a reason, not a signed record. No audit entry kind exists for it.
- A reviewer can approve or discard, not edit claims. A wrong claim means discard and prepare again.
- The reviewer's approval means "I reviewed the claims, features and decision", not that the underlying facts are true.
