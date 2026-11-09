"""Generates tools/override_crosscheck_cases.jsonl: random override records checked against small random chains,
with the problem codes computed by the Python implementation (python/aegis_override.py).
ts/override_crosscheck.test.ts replays them through validateOverride in TypeScript and requires the same set of codes."""
import json
import os
import random
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "python"))
import aegis_override as o  # noqa: E402

N = int(sys.argv[1]) if len(sys.argv) > 1 else 5000
r = random.Random(20261110)
DECISIONS = list(o.DECISION_RANK)
PSIS = [0.0, 0.1, 0.77533472887972, 0.5, 1.0, 0.123456789]
EVIDENCE = ["watch:W-1001", "doc:sha256:" + "ab" * 32, "claim:C-7", "ledger:L.2", "entry:3", "entry:0", "watch:", "W-1", "doc:sha256:xyz",
            "doc:sha256:" + "AB" * 32, "claim:" + "x" * 65, "", 5, None, "watch:bad id"]
NOTES = ["Registration number differs from the listed entity.", "x", " ", "", "a" * 500, "a" * 501, "é" * 500, "😀" * 500, "😀" * 501,
         "contact me at a.b@example.org", "passport 123 456 789", "ref 1234 5678", "id 12345678 only", "plain text with 8 digits 12345678",
         None, 7]
STRS = ["USR-1", "USR-2", "", "  ", None, 3]


def screening(seq):
    d = r.choice(DECISIONS)
    res = {"decision": d, "psi": r.choice(PSIS)}
    if r.random() < 0.5:
        res["triggers"] = r.sample(["T1", "T2", "T3"], r.randint(0, 2))
    return {"seq": seq, "record": {"kind": "SCREENING", "result": res}}


def make_chain():
    chain = []
    for i in range(1, r.randint(1, 5) + 1):
        chain.append(screening(i))
    for _ in range(r.randint(0, 2)):
        seq = len(chain) + 1
        if r.random() < 0.7:
            chain.append({"seq": seq, "record": {"kind": "OVERRIDE", "target_seq": r.randint(1, len(chain))}})
        else:
            chain.append({"seq": seq, "record": {"kind": "OTHER"}})
    return chain


def valid_for(chain):
    t = r.choice(chain)
    res = t["record"].get("result", {})
    return {
        "kind": "OVERRIDE", "target_seq": t["seq"], "original_decision": res.get("decision", "X"), "original_psi": res.get("psi", 0.0),
        "override_decision": r.choice(DECISIONS), "justification_code": r.choice(o.JUSTIFICATION_CODES),
        "authority_basis": r.choice(o.AUTHORITY_BASES), "consulted_evidence_ids": r.sample(EVIDENCE[:5], r.randint(0, 3)),
        "note": "Reviewed the registration documents.", "reviewer_id": "USR-1", "policy_version": "4.1",
        "timestamp": "2026-11-10T01:02:03Z",
    }


def mutate(rec):
    k = r.choice(["justification_code", "authority_basis", "note", "reviewer_id", "approver_id", "consulted_evidence_ids", "target_seq",
                  "original_decision", "original_psi", "override_decision", "timestamp", "kind", "extra", "drop"])
    if k == "justification_code":
        rec[k] = r.choice(o.JUSTIFICATION_CODES + ["MANUAL_DOCUMENT_VERIFIED", "", None])
    elif k == "authority_basis":
        rec[k] = r.choice(o.AUTHORITY_BASES + ["Compliance reviewer", "", None])
    elif k == "note":
        rec[k] = r.choice(NOTES)
    elif k in ("reviewer_id", "approver_id"):
        rec[k] = r.choice(STRS)
    elif k == "consulted_evidence_ids":
        rec[k] = r.choice([[r.choice(EVIDENCE) for _ in range(r.randint(0, 4))], "watch:W-1", None, ["entry:1"] * 2,
                           ["watch:W-%d" % i for i in range(r.randint(18, 22))]])
    elif k == "target_seq":
        rec[k] = r.choice([0, 1, 2, 99, "1", None, 1.5, True])
    elif k in ("original_decision", "override_decision"):
        rec[k] = r.choice(DECISIONS + ["MADE_UP", "constructor", "", None])
    elif k == "original_psi":
        rec[k] = r.choice(PSIS + [None, "0.5"])
    elif k == "timestamp":
        rec[k] = r.choice(["yesterday", "2026-11-10T01:02:03+00:00", "2026-11-10T01:02:03.5Z", "2026-11-10T01:02:03Z\n", None])
    elif k == "kind":
        rec[k] = r.choice(["SCREENING", "", None])
    elif k == "extra":
        rec[r.choice(["status", "approved_by", "x" * 60, "__proto__"])] = "v"
    else:
        rec.pop(r.choice([f for f in o.OVERRIDE_FIELDS if f in rec]), None)


out = os.path.join(os.path.dirname(__file__), "override_crosscheck_cases.jsonl")
with open(out, "w") as f:
    for _ in range(N):
        chain = make_chain()
        rec = valid_for(chain)
        for _ in range(r.choice([0, 0, 1, 1, 2, 3])):
            mutate(rec)
        f.write(json.dumps({"chain": chain, "record": rec, "problems": o.validate_override(chain, rec)}) + "\n")
print(N, "cases written to", out)
