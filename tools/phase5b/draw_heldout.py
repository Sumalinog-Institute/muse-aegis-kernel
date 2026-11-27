#!/usr/bin/env python3
"""Draw the held-out sample for the v1.1 test (recorded before any document is read).

Frame: every GCF funding proposal approved at B.43 or earlier (FP001-FP288, SAP001-SAP065), minus the 15 tuning projects.
The draw is an ordered random sample without replacement (random.Random(seed).sample), so the first n of a list are a random sample of size n and the
rest are the replacements, in order. Running this script again with the same seed gives the same lists.
"""
import hashlib, json, random, sys

SEED = 20261128
TUNING = {"FP014", "FP022", "FP046", "FP052", "FP069", "FP092", "FP095", "FP116", "FP125", "FP179", "FP183", "FP236", "FP248", "SAP005", "SAP043"}
FP_MAX, SAP_MAX = 288, 65          # FP289 and SAP066 are the first numbers of B.44 (25-28 March 2026)
N_FP, N_SAP = 24, 6                # the sample
R_FP, R_SAP = 36, 14               # replacements, used in order only if a project has no funding proposal or no annual report to read

def pool(prefix: str, top: int) -> list[str]:
    return [f"{prefix}{n:03d}" for n in range(1, top + 1) if f"{prefix}{n:03d}" not in TUNING]

def main() -> None:
    fp, sap = pool("FP", FP_MAX), pool("SAP", SAP_MAX)
    frame_hash = hashlib.sha256(("\n".join(fp + sap)).encode()).hexdigest()
    rf = random.Random(f"{SEED}-FP").sample(fp, N_FP + R_FP)
    rs = random.Random(f"{SEED}-SAP").sample(sap, N_SAP + R_SAP)
    out = {
        "seed": SEED, "frame": {"fp": f"FP001-FP{FP_MAX} minus tuning ({len(fp)} projects)", "sap": f"SAP001-SAP{SAP_MAX} minus tuning ({len(sap)} projects)", "sha256": frame_hash},
        "sample": {"fp": sorted(rf[:N_FP]), "sap": sorted(rs[:N_SAP])},
        "replacements_in_order": {"fp": rf[N_FP:], "sap": rs[N_SAP:]},
    }
    json.dump(out, sys.stdout, indent=1)
    print()

if __name__ == "__main__":
    main()
