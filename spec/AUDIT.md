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

`OVERRIDE`: `kind`, `target_seq`, `original_decision`, `original_psi`, `reviewer_id`, `authority_basis`, `justification_code`,
`consulted_evidence_ids` (array of strings), `override_decision`, `policy_version`, `timestamp`, optional `approver_id`.
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

- All required fields present; `timestamp` is ISO-8601 UTC; `override_decision` is a known decision label.
- `target_seq` must be a SCREENING entry; `original_decision` and `original_psi` must equal what that entry recorded.
- The override must change the decision.
- Favourable override (less restrictive outcome): `consulted_evidence_ids` must be non-empty.
- Favourable override of a confirmed-breach case (trigger T1): `approver_id` is required and must differ from `reviewer_id`.
- `effectiveDecision(chain, seq)` returns the latest override's decision if one exists, else the original.

## What this does NOT provide

- **Tail deletion.** Someone who can delete the last entries leaves a valid shorter chain. Detection needs a checkpoint
  (latest `seq` and `hash`) stored somewhere the log's writers cannot change. Decide where, and write the head there regularly.
- **Identity and authority.** The module checks what an override record says, not that the person really holds that role.
- **Key safety.** Whoever holds the private key can sign new entries. Keys must live outside the log store, with
  restricted access, rotation and revocation. A trusted `key_id` to public-key list must be kept separately.
- **Concurrency and storage.** The caller must make `seq` unique in the database and reject updates and deletes.
- **Real-world time.** `timestamp` is whatever the caller supplied; it is not trusted time.
