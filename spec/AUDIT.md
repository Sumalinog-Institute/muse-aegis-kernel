# MUSE Aegis audit log, format and rules (Phase 2, format version 1)

Implements paper Section 9. Reference code: `ts/jcs.ts`, `ts/audit.ts`; independent Python check: `python/aegis_audit.py`.
This is a tamper-EVIDENT log, not a tamper-proof one.

## Entry

| Field | Meaning |
|---|---|
| `seq` | Position, starting at 1, no gaps |
| `prev_hash` | `hash` of entry `seq-1`; 64 zeros for entry 1 |
| `record` | The JSON object being logged (see record kinds) |
| `hash` | `SHA-256( prev_hash as 32 raw bytes || UTF-8( JCS({ "seq": seq, "record": record }) ) )`, lowercase hex |
| `key_id` | Which signing key was used |
| `signature` | ECDSA P-256 with SHA-256 over the 32 raw bytes of `hash`; base64 of the 64-byte r||s form |

JCS is RFC 8785 canonical JSON: sorted keys (UTF-16 order), ECMAScript number text, no whitespace.
Values JSON cannot represent (NaN, Infinity, undefined, dates, maps) and integers beyond 2^53 are rejected.
Algorithm choice: ECDSA P-256 is supported by the Web Crypto API on every major runtime, which keeps the module portable.
The paper does not fix an algorithm.

## Record kinds

`SCREENING`: `kind`, `doc_hash`, `input` (the feature profile given to the kernel), `result` (the kernel's output, unchanged),
`extractor_version`, `ledger_id`, `policy_version`, `timestamp` (ISO-8601 UTC).

`OVERRIDE` (from v4.5.0-spec): exactly these fields and no others:

| Field | Rule |
|---|---|
| `kind` | `OVERRIDE` |
| `target_seq` | `seq` of a SCREENING entry |
| `original_decision`, `original_psi` | Must equal what the target recorded (copied by the server) |
| `override_decision` | A known decision label, different from the original |
| `justification_code` | One of the list below |
| `authority_basis` | One of the list below |
| `consulted_evidence_ids` | Array of at most 20 distinct typed references (below); may be empty only for a stricter or equal-rank outcome |
| `note` | Required text, 1 to 500 characters (counted as Unicode characters), no personal data |
| `reviewer_id` | The account that made the override (filled by the server, never taken from the request) |
| `policy_version`, `timestamp` | Filled by the server |
| `approver_id` | Optional; see the second-approver rule |

Justification codes: `FALSE_MATCH_CONFIRMED`, `SUPPORTING_DOCUMENTATION_VERIFIED`, `EXTRACTION_ERROR_CORRECTED`, `SOURCE_DATA_ERROR`,
`AUTHORIZED_POLICY_EXCEPTION`, `ESCALATED_ON_NEW_INFORMATION`, `MATCH_CONFIRMED_ON_NEW_EVIDENCE`.
Authority basis: `DESIGNATED_REVIEWER`, `COMPLIANCE_OFFICER`, `COMMITTEE_DECISION`.
Typed evidence references: `watch:<id>` (a watch-list entry), `doc:sha256:<64 lowercase hex>` (a document), `claim:<id>`, `ledger:<id>`
(ids are 1 to 64 characters from letters, digits, `.`, `_`, `-`), `entry:<seq>` (an earlier log entry).
The original SCREENING entry is never edited; an override is a new entry that points at it.

## Verification (`verifyChain`) reports

| Code | Meaning |
|---|---|
| `BAD_FORMAT` | Entry is malformed |
| `SEQ_MISMATCH` | Position or `seq` is wrong (deleted, reordered or duplicated entry) |
| `PREV_HASH_MISMATCH` | Link to the previous entry is broken |
| `HASH_MISMATCH` | Recorded content does not match its hash (content edited) |
| `SIGNATURE_INVALID` | Signature does not verify under the claimed key |
| `UNKNOWN_KEY` | `key_id` is not a trusted key |
| `TRUNCATED` / `HEAD_MISMATCH` | Only with an external checkpoint (`expectedHead`): the end of the log was removed or replaced |

## Override rules (`validateOverride`)

- Only the fields listed above are accepted; any other field is refused. All required fields are present; `timestamp` is ISO-8601 UTC;
  `override_decision` is a known decision label; the justification code, authority basis and evidence references are valid.
- The note is 1 to 500 characters. The validator also refuses an email address or a run of nine or more digits in the note
  (`NOTE_PERSONAL_DATA`). This is a guard against slips, not proof that a note has no personal data; the reviewer is responsible for it.
- `target_seq` must be a SCREENING entry; `original_decision` and `original_psi` must equal what that entry recorded.
- The override must change the decision.
- **One override per screening.** A second override of the same screening is refused (`ALREADY_OVERRIDDEN`), and the writer re-checks this
  against the latest log if it loses a race for the next position. To change a decision again, the process needs a new screening.
- Favourable override (less restrictive outcome): `consulted_evidence_ids` must be non-empty.
- Favourable override of a confirmed-breach case (trigger T1) or of a `RESTRICTION_RECOMMENDED_PENDING_AUTHORITY` decision:
  `approver_id` is required and must differ from `reviewer_id`. The write route (`appendOverride`) accepts no `approver_id` from the
  request, so such an override is refused until a separate approval step exists.
- `effectiveDecision(chain, seq)` returns the latest override's decision if one exists, else the original.

## Writing an override (`appendOverride`)

The request carries only `target_seq`, `override_decision`, `justification_code`, `authority_basis`, `consulted_evidence_ids` and `note`;
any other field is refused. The route checks the account against the allow-list, reads the whole log, requires it to verify
(otherwise nothing is written), copies the original decision and score from the target, sets `reviewer_id` to the signed-in account,
sets `policy_version` and `timestamp`, runs `validateOverride`, and writes the signed entry. Answers: 400 invalid, 404 unknown target,
409 already overridden, 500 log does not verify, 503 busy.
`appendRecord` still accepts only SCREENING records.

## What this does NOT provide

- **Tail deletion.** Someone who can delete the last entries leaves a valid shorter chain. Detection needs a checkpoint
  (latest `seq` and `hash`) stored somewhere the log's writers cannot change. Decide where, and write the head there regularly.
- **Identity and authority.** The module checks what an override record says, not that the person really holds that role. `authority_basis` is the reviewer's own claim.
- **Key safety.** Whoever holds the private key can sign new entries. Keys must live outside the log store, with
  restricted access, rotation and revocation. A trusted `key_id` to public-key list must be kept separately.
- **Concurrency and storage.** The caller must make `seq` unique in the database and reject updates and deletes.
- **Real-world time.** `timestamp` is whatever the caller supplied; it is not trusted time.
