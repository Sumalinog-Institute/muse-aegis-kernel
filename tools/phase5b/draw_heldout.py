#!/usr/bin/env python3
"""Draw the held-out sample for the v1.1 test (recorded before any held-out document is read). Version 2, 28 November 2026.

Frame: the stage 2 pool (spec/phase5b/stage2/stage2_draw_order.csv: every GCF activity in the IATI list, which the ledger needs, minus the 40 projects of
stage 1 and the pilot draw), restricted to projects approved at B.43 or earlier (FP001-FP288, SAP001-SAP065), minus the 15 stage 2 projects and minus the
projects that stage 2 found to have no published annual performance report (stage2_skip_list.csv).
The draw is an ordered random sample without replacement (random.Random(seed).sample), so the first n of a list are a random sample of size n and the
rest are the replacements, in order. Running this script again gives the same lists.
(Version 1 used FP001-FP288 and SAP001-SAP065 without the IATI condition and without the 40 earlier projects: 11 of its 30 projects were such projects. It was voided before any
document was read; see HELDOUT_PROTOCOL.md.)
"""
import csv, hashlib, json, os, random, re, sys

ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "..")
S2 = os.path.join(ROOT, "spec", "phase5b", "stage2")
SEED = 20261128
FP_MAX, SAP_MAX = 288, 65          # FP289 and SAP066 are the first numbers of B.44 (25-28 March 2026)
N_FP, N_SAP = 24, 6                # the sample
R_FP, R_SAP = 36, 14               # replacements, used in order only if a project has no funding proposal or no annual report to read

def codes(path: str) -> list[str]:
    return [r["code"] for r in csv.DictReader(open(path, encoding="utf-8"))]

def number(code: str) -> int:
    return int(re.sub(r"\D", "", code))

def main() -> None:
    pool = codes(os.path.join(S2, "stage2_draw_order.csv"))
    used = set(codes(os.path.join(S2, "stage2_sample.csv"))) | set(codes(os.path.join(S2, "stage2_skip_list.csv")))
    frame = sorted(c for c in pool if c not in used and ((c.startswith("FP") and number(c) <= FP_MAX) or (c.startswith("SAP") and number(c) <= SAP_MAX)))
    fp = [c for c in frame if c.startswith("FP")]
    sap = [c for c in frame if c.startswith("SAP")]
    frame_hash = hashlib.sha256(("\n".join(frame)).encode()).hexdigest()
    rf = random.Random(f"{SEED}-FP").sample(fp, N_FP + R_FP)
    rs = random.Random(f"{SEED}-SAP").sample(sap, N_SAP + R_SAP)
    out = {
        "version": 2, "seed": SEED,
        "frame": {"fp": len(fp), "sap": len(sap), "sha256": frame_hash},
        "sample": {"fp": sorted(rf[:N_FP]), "sap": sorted(rs[:N_SAP])},
        "replacements_in_order": {"fp": rf[N_FP:], "sap": rs[N_SAP:]},
    }
    json.dump(out, sys.stdout, indent=1)
    print()

if __name__ == "__main__":
    main()
