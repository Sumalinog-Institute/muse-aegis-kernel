# muse-aegis-kernel

Reference implementation of the MUSE Aegis scoring kernel, policy gate and decision mapping (spec V4.1), and of its signed audit log (see `spec/AUDIT.md`). Paper: "MUSE Aegis: Bounded Evaluation Kernels and Evidence-Linked Audit Workflows for AI-Assisted Compliance Screening". This repository covers Phases 1 and 2 of the prototype: the deterministic core and the audit log module. It contains no extraction pipeline, evidence checking or reviewer interface.

Status: reference code for a design proposal. The weights, thresholds and decision labels are provisional and have not been validated against real cases. The score is a screening index, not a finding of compliance or misconduct.

## Layout

| Path | Purpose |
|---|---|
| `ts/kernel.ts` | TypeScript kernel. Tested on Node 22; written to be portable to Deno and similar runtimes (not yet tested there). No dependencies. |
| `ts/jcs.ts` | RFC 8785 canonical JSON |
| `ts/audit.ts` | Hash-chained, signed audit entries, chain verifier, override validation |
| `ts/append.ts` | Appending a screening result to the log (injected store, signer and kernel) |
| `ts/verify.ts` | Reading back and verifying the whole log, with checkpoint and tamper simulations |
| `ts/trusted-keys.ts` | Public keys trusted to sign audit entries (same content as `spec/trusted-keys.json`) |
| `python/aegis_kernel.py` | Independent Python implementation of the kernel, used for cross-checking |
| `python/aegis_audit.py` | Independent Python implementation of canonical JSON and entry hashing |
| `spec/vectors.json` | 24 test vectors: TV1-TV9 from paper Section 9.2, EV1-EV15 edge cases |
| `spec/AUDIT.md` | Audit log format, rules and known limits |
| `spec/trusted-keys.json` | Public keys trusted to sign audit entries |
| `tools/` | Scripts that generate the test vectors and the random cross-check cases |
| `checkpoints.md` | Heads of the audit log recorded outside the database |

## Run the tests

```
node --experimental-strip-types --test ts/kernel.test.ts ts/audit.test.ts ts/append.test.ts ts/verify.test.ts
python3 -m unittest discover -s python -v
python3 tools/gen_crosscheck.py 50000
python3 tools/gen_audit_crosscheck.py 20000
node --experimental-strip-types --test ts/crosscheck.test.ts ts/audit_crosscheck.test.ts
```

Last verified run (GitHub Actions, one Linux platform): 83 TypeScript tests and 12 Python tests pass, plus 2 cross-check tests. 50,000 generated kernel cases agree bit for bit between the TypeScript and Python kernels, and 20,000 canonical-JSON cases and 20,000 entry hashes agree between the TypeScript and Python audit code.

## What the kernel does

`Psi = f_ground(x2) * (1 - 0.20 * x4) * (1 - 0.15 * x5) * (1 - 0.30 * x6)` with `f_ground = 1 - 0.40 * x2`. Range [0.2856, 1]. x1 (extractor instability) and x3 (boilerplate similarity) never enter Psi.

Gate triggers (they never read Psi): T1 confirmed breach (x6 = 1); T2 documentation deficit (x4 >= 0.25 and n_applicable >= 10); T3 unverified or conflicting alert while x6 = 0.

Decision precedence: T1, then T3, then T2, then incomplete input, then FLAG_FOR_REVIEW (Psi < 0.75, x1 >= 0.20, or small sample), otherwise SCREENING_PASS_PENDING_STANDARD_CONTROLS. The system recommends; a named human authority decides.

Missing, non-finite, out-of-range or INCOMPLETE inputs are never replaced by 0. NA is allowed only for x4 and x5, counts as a factor of 1, and is flagged.

## Reproducibility rules

- Only +, - and * on binary64 numbers, in the fixed order ((f_ground*f4)*f5)*f6. Do not reorder.
- Psi is compared with tau_review as floor(Psi*10^6 + 0.5) >= 750000 in both implementations.
- Any new implementation (Rust, Go, SQL, ...) must pass `spec/vectors.json` and the bitwise cross-check.
- Disable fused multiply-add contraction in compiled languages.

## Parameters (provisional)

W_GROUND 0.40, W4 0.20, W5 0.15, W6 0.30, THETA_DOC 0.25, THETA_STAB 0.20, N_MIN 10, TAU_REVIEW 0.75. Change them only together with the paper, the vectors and a new spec version.

## Audit log (Phase 2)

Canonical JSON, hash-chained signed entries, append logic, log verifier and override validation: see `spec/AUDIT.md`. Tested in CI, including tamper detection and a cross-check against an independent Python implementation. The database table, signing endpoint and verification page live in a separate private application repository and are not part of this repository.

## Not done yet

Extraction and evidence pipeline (Phase 3), reviewer workflow and override screens (Phase 4). The log's ordering and tamper-evidence are tested, but nothing here is validated on real cases.
