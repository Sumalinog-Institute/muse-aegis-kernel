#!/usr/bin/env python3
"""Compare author and independent reviewer labels (Phase 7).

Usage:
  python3 compare_labels.py --author A.csv --reviewer-a RA.csv --reviewer-b RB.csv [--key stage2_method_key.json]

Label columns are found by name ('label' prefix). Labels are normalised to
supported / not supported / unclear. Prints agreement, Cohen's kappa for each
pair, the reviewer majority (ties and three-way splits go to the author as
tie-breaker), and, if --key is given, the share of the plain judge's issues
supported under each labelling. Stdlib only.
"""
import argparse, csv, json, math, collections

def norm(s):
    s = (s or "").strip().lower().replace("_", " ")
    if s.startswith("support"): return "supported"
    if s.startswith("not"): return "not supported"
    if s.startswith("unclear"): return "unclear"
    return ""

def load(path):
    rows = list(csv.DictReader(open(path, encoding="utf-8-sig")))
    col = next(c for c in rows[0] if c.lower().strip().startswith("label"))
    out = {}
    for r in rows:
        if r["id"].startswith("S"):
            out[r["id"]] = norm(r[col])
    return out

def kappa(a, b, ids):
    ids = [i for i in ids if a[i] and b[i]]
    n = len(ids)
    po = sum(a[i] == b[i] for i in ids) / n
    ca, cb = collections.Counter(a[i] for i in ids), collections.Counter(b[i] for i in ids)
    pe = sum(ca[k] * cb[k] for k in set(ca) | set(cb)) / (n * n)
    return po, (po - pe) / (1 - pe) if pe < 1 else float("nan"), n

def wilson(k, n, z=1.96):
    if n == 0: return (float("nan"),) * 2
    p = k / n; d = 1 + z * z / n
    c = (p + z * z / (2 * n)) / d
    h = z * math.sqrt(p * (1 - p) / n + z * z / (4 * n * n)) / d
    return c - h, c + h

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--author", required=True)
    ap.add_argument("--reviewer-a", required=True)
    ap.add_argument("--reviewer-b", required=True)
    ap.add_argument("--key")
    a = ap.parse_args()
    au, ra, rb = load(a.author), load(a.reviewer_a), load(a.reviewer_b)
    ids = sorted(set(au) & set(ra) & set(rb))
    print(f"issues compared: {len(ids)}")
    for name, x, y in (("reviewer A vs reviewer B", ra, rb), ("author vs reviewer A", au, ra), ("author vs reviewer B", au, rb)):
        po, k, n = kappa(x, y, ids)
        print(f"{name}: agreement {po:.3f}, kappa {k:.3f}, n={n}")
    maj = {}
    for i in ids:
        if ra[i] == rb[i]: maj[i] = ra[i]
        else: maj[i] = au[i]
    split = [i for i in ids if ra[i] != rb[i]]
    print(f"reviewers disagree on {len(split)} issues (author tie-break): {split}")
    diff = [i for i in ids if maj[i] != au[i]]
    print(f"final label differs from author's label on {len(diff)} issues: {diff}")
    if a.key:
        key = json.load(open(a.key))
        for name, lab in (("author", au), ("reviewer A", ra), ("reviewer B", rb), ("reviewer majority", maj)):
            j = [i for i in ids if key.get(i, {}).get("origin") == "judge"]
            s = sum(lab[i] == "supported" for i in j)
            lo, hi = wilson(s, len(j))
            print(f"plain judge supported under {name}: {s}/{len(j)} = {s/len(j):.3f} (Wilson95 {lo:.3f} to {hi:.3f})")
        # Baseline: the plain judge asked five times, keeping only issues raised in at least n of the 5 frozen repeats
        # (n >= 3 is a majority of five). No new run is needed: the number of repeats is in the method key.
        print("plain judge, issues kept by repeat agreement (label: reviewer majority):")
        for n in (1, 2, 3, 4, 5):
            kept = [i for i in ids if key.get(i, {}).get("origin") == "judge" and key[i].get("n_runs", 0) >= n]
            if not kept: continue
            s = sum(maj[i] == "supported" for i in kept)
            lo, hi = wilson(s, len(kept))
            print(f"  raised in >= {n} of 5 repeats: {len(kept)} issues, supported {s} = {s/len(kept):.3f} (Wilson95 {lo:.3f} to {hi:.3f})")
        p = [i for i in ids if key.get(i, {}).get("origin") == "pipeline"]
        print(f"pipeline issues: {len(p)}; labels (majority): {[maj[i] for i in p]}")

if __name__ == "__main__":
    main()
