# muse-aegis-kernel

Reference implementation of the MUSE Aegis scoring kernel, policy gate and decision mapping, spec V4.1
(paper: "MUSE Aegis: Bounded Evaluation Kernels and Evidence-Linked Audit Workflows for AI-Assisted
Compliance Screening"). This is Phase 1 of the prototype: the deterministic core only. There is no
extraction, evidence checking, audit log or user interface yet.

Status: reference code for a design proposal. The weights, thresholds and decision labels are provisional
and have not been validated against real cases. The score is a screening index, not a finding of
compliance or misconduct.

## Layout

| Path | Purpose |
|---|---|
| `ts/kernel.ts` | TypeScript kernel. Tested on Node 22; written to be portable to Deno and similar runtimes (not yet tested there). No dependencies. |
| `python/aegis_kernel.py` | Independent Python implementation used for cross-checking |
| `spec/vectors.json` | 24 test vectors: TV1-TV9 from paper Section 9.2, EV1-EV15 edge cases |
| `tools/make_vectors.py` | Writes `vectors.json` (expected values typed from the spec, not computed by the kernel) |
| `tools/gen_crosscheck.py` | Generates random cases for the bitwise cross-check |

## Run the tests

```
node --experimental-strip-types --test ts/kernel.test.ts      # vectors + property tests
python3 -m unittest discover -s python -v                     # same tests in Python
python3 tools/gen_crosscheck.py 50000                         # writes tools/crosscheck_cases.jsonl
node --experimental-strip-types --test ts/crosscheck.test.ts  # TS must match Python bit for bit
```

Last verified run: all 30 TypeScript tests and 5 Python tests pass, and 50,000 generated cases agree
bit for bit between the two implementations.

## What the kernel does

Psi = f_ground(x2) * (1 - 0.20 * x4) * (1 - 0.15 * x5) * (1 - 0.30 * x6) with f_ground = 1 - 0.40 * x2. Range [0.2856, 1]. x1 (extractor instability) and x3 (boilerplate similarity) never enter Psi.

Gate triggers (they never read Psi): T1 confirmed breach (x6 = 1); T2 documentation deficit
(x4 >= 0.25 and n_applicable >= 10); T3 unverified or conflicting alert while x6 = 0.

Decision precedence: T1, then T3, then T2, then incomplete input, then FLAG_FOR_REVIEW (Psi < 0.75,
x1 >= 0.20, or small sample), otherwise SCREENING_PASS_PENDING_STANDARD_CONTROLS. The system recommends;
a named human authority decides.

Missing, non-finite, out-of-range or INCOMPLETE inputs are never replaced by 0. NA is allowed only
for x4 and x5, counts as a factor of 1, and is flagged.

## Reproducibility rules

- Only +, - and * on binary64 numbers, in the fixed order ((f_ground*f4)*f5)*f6. Do not reorder.
- Psi is compared with tau_review as floor(Psi*10^6 + 0.5) >= 750000 in both implementations.
- Any new implementation (Rust, Go, SQL, ...) must pass `spec/vectors.json` and the bitwise cross-check.
- Disable fused multiply-add contraction in compiled languages.

## Parameters (provisional)

W_GROUND 0.40, W4 0.20, W5 0.15, W6 0.30, THETA_DOC 0.25, THETA_STAB 0.20, N_MIN 10, TAU_REVIEW 0.75.
Change them only together with the paper, the vectors and a new spec version.

## Not done yet

Hash-chained signed audit log (Phase 2), extraction and evidence pipeline (Phase 3), reviewer
workflow (Phase 4), tagged release and LICENSE. Choose a license before publishing.
