# MUSE Aegis screening flow and log record (Phase 3, step 5)

Reference code: `ts/screening.ts` (and `appendRecord` in `ts/append.ts`).

## Two steps, so a person sees everything before anything is written

1. **Prepare** (`prepareScreening`): runs the extractor k times, computes x1 (stability), x2 (claims against the claims ledger),
   x4, x5, x6 and the alert status (structured data), runs the kernel, and returns a **draft** with full details. Nothing is written.
   The server adds a MAC (HMAC-SHA256 with a server secret of at least 32 characters) over the draft's canonical JSON.
2. **Commit** (`commitScreening`): the reviewer approves, with an optional note (at most 500 characters). The server checks that the
   draft's MAC is valid (so it is exactly what the server produced), that it belongs to the same account, that it is under 30 minutes
   old (and not from the future), and that the kernel still gives the same decision and score for its profile. It then appends a signed
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
- `stability`: x1 with its mode and parts, the model, k, temperature, a summary of each run, and token usage.
- `review`: decision (APPROVED), reviewer, review time, note, the draft's creation time and its MAC.

Records of this kind may be up to 200,000 characters; older plain records are limited to 20,000.

## Limits

- The MAC proves the server made the draft, not that it is committed once. Within its 30-minute life the same approved draft could be
  committed twice; both entries carry the same draft MAC, so a repeat is visible.
- A reviewer can approve or discard, not edit claims. A wrong claim means discard and prepare again.
- The reviewer's approval means "I reviewed the claims, features and decision", not that the underlying facts are true.
