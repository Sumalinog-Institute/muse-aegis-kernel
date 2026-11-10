# muse-aegis-kernel

Reference implementation of MUSE Aegis: the scoring kernel, policy gate and decision mapping (spec V4.1), the signed audit log, and the first slice of document screening (claim extraction, structured features, review before writing). Paper: "MUSE Aegis: Bounded Evaluation Kernels and Evidence-Linked Audit Workflows for AI-Assisted Compliance Screening". This repository covers Phases 1 to 3 of the prototype and the code-level parts of the later phases. It contains no user interface and no real data: the application (login, database, endpoints, screens) lives in a separate private repository.

Status: reference code for a design proposal. The weights, thresholds and decision labels are provisional and have not been validated against real cases. The score is a screening index, not a finding of compliance or misconduct. The extraction has been run live only on made-up documents.

## Layout

| Path | Purpose |
|---|---|
| `ts/kernel.ts` | Scoring kernel, gate and decisions. No dependencies. |
| `ts/jcs.ts`, `ts/audit.ts` | RFC 8785 canonical JSON; hash-chained signed entries, verifier, override rules and validation |
| `ts/append.ts`, `ts/verify.ts` | Appending screening and override entries to the log; reading back and verifying the whole log |
| `ts/claims.ts`, `ts/extract.ts` | Typed claims anchored to the document and checked against a ledger; the model prompt and Gemini client |
| `ts/features.ts` | Structured features x4, x5 and watch-list screening (x6, alert status) |
| `ts/stability.ts` | Instability x1 and consensus claims from repeated runs |
| `ts/screening.ts` | Prepare a screening draft, protect it with a MAC, commit it after review (maximum draft age is a parameter, see below) |
| `ts/trusted-keys.ts` | Public keys trusted to sign audit entries |
| `python/` | Independent Python implementations (audit hashing, override rules) used for cross-checking, and fixture checks |
| `spec/` | Specs: `AUDIT.md`, `CLAIMS.md`, `EXTRACT.md`, `FEATURES.md`, `STABILITY.md`, `SCREENING.md`; test vectors; trusted keys |
| `fixtures/` | A fictional grant (all invented) in eight scenarios, with expected values from an independent oracle |
| `tools/` | Generators for the vectors, the fixtures and the random cross-check cases |
| `checkpoints.md` | Heads of the audit log, recorded outside the database |

## Run the tests

```
node --experimental-strip-types --test ts/kernel.test.ts ts/audit.test.ts ts/append.test.ts ts/verify.test.ts ts/claims.test.ts ts/extract.test.ts ts/features.test.ts ts/stability.test.ts ts/screening.test.ts ts/override.test.ts ts/judge.test.ts ts/benchmark.test.ts
python3 -m unittest discover -s python -v
python3 tools/gen_crosscheck.py 50000
python3 tools/gen_audit_crosscheck.py 20000
python3 tools/gen_features_crosscheck.py 3000
python3 tools/gen_override_crosscheck.py 20000
node --experimental-strip-types --test ts/crosscheck.test.ts ts/audit_crosscheck.test.ts ts/features_crosscheck.test.ts ts/override_crosscheck.test.ts
```

Last verified run (GitHub Actions, one Linux platform, 10 November 2026): 254 TypeScript tests and 29 Python tests pass, plus four cross-check tests: 50,000 kernel cases agree bit for bit between TypeScript and Python; 20,000 canonical-JSON cases and 20,000 entry hashes agree; 15,000 random feature and name-matching cases equal an independent Python oracle; 20,000 random override cases give the same problem codes in TypeScript and in an independent Python implementation. The application repository has its own tests, which are not counted here.

## What the kernel does

`Psi = f_ground(x2) * (1 - 0.20 * x4) * (1 - 0.15 * x5) * (1 - 0.30 * x6)` with `f_ground = 1 - 0.40 * x2`. Range [0.2856, 1]. x1 (extractor instability) and x3 (boilerplate similarity) never enter Psi.

Gate triggers (they never read Psi): T1 confirmed breach (x6 = 1); T2 documentation deficit (x4 >= 0.25 and n_applicable >= 10); T3 unverified or conflicting alert while x6 = 0.

Decision precedence: T1, then T3, then T2, then incomplete input, then FLAG_FOR_REVIEW (Psi < 0.75, x1 >= 0.20, or small sample), otherwise SCREENING_PASS_PENDING_STANDARD_CONTROLS. The system recommends; a named human authority decides.

Missing, non-finite, out-of-range or INCOMPLETE inputs are never replaced by 0. NA is allowed only for x4 and x5, counts as a factor of 1, and is flagged.

## Screening flow (Phase 3)

A model proposes typed claims; plain code keeps only those traceable to the document (quote, value and subject must appear) and checks them against a ledger. Three model-free features (x4, x5, x6) come from structured data. Instability x1 comes from repeated runs. A draft with full details is prepared, a person approves it, and a signed entry is appended. See `spec/SCREENING.md`.

## Saved drafts and review queue (Phase 4, from v4.5.0-spec)

A deployment may save prepared drafts server-side so that a person can review and approve them later. The rules in `spec/SCREENING.md` are: the maximum draft age at approval is a parameter (default 30 minutes, the original behaviour; a deployment that queues drafts may set up to 14 days); a draft can be committed only once; at approval the draft's policy version, extractor version and snapshot identifiers are compared with the latest prepared screening for the same award, and a missing or different value refuses the approval; only the preparer can approve; a rejection is a workflow status on the draft and is not part of the signed record. The stored format of audit entries did not change. The queue itself, with its screens and database table, is in the private application repository.

## Provisional parameters

W_GROUND 0.40, W4 0.20, W5 0.15, W6 0.30, THETA_DOC 0.25, THETA_STAB 0.20, N_MIN 10, TAU_REVIEW 0.75, cure window 30 days, claim coverage 0.2 per 1,000 characters, k = 3 runs at temperature 0.7, maximum draft age 30 minutes (up to 14 days for queued drafts). Change them only together with the paper, the vectors and a new spec version.

## Phases

| Phase | What | Status |
|---|---|---|
| 1 | Scoring kernel and gate | Done (v4.1.0-spec) |
| 2 | Signed, hash-chained audit log | Done (v4.2.0-spec) |
| 3 | Document screening | Done (v4.3.0-spec) |
| 4 | Reviewer workflow and override screens | In progress: review queue and saved drafts built and tested in the application; override rules and write route in this repository (v4.5.0-spec); override screens not yet built |
| 5 | Comparison against a plain AI judge | Done on synthetic data, 112 runs (v4.4.0-spec); a version on real documents is planned |
| 6 | Hardening and deployment | Not done |
| 7 | Pilot with independently labeled real cases | Not done |

## Not done yet

Override screens (Phase 4), second-approver step for overrides of restrictions, the real-document version of the Phase 5 comparison, hardening and deployment (Phase 6), and a pilot with independently labeled real cases (Phase 7). Rejections are not yet recorded in the signed log. Nothing here is validated on real cases.
