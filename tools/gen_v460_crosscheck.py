"""Generates tools/v460_crosscheck_cases.jsonl: random SCREENING field checks (project_id, doc_ref at a given seq) and random REJECTION
records checked against small random chains, with the problem codes computed by the Python implementation (python/aegis_override.py).
ts/v460_crosscheck.test.ts replays them through validateScreeningFields and validateRejection in TypeScript and requires the same codes."""
import json
import os
import random
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "python"))
import aegis_override as o  # noqa: E402

N = int(sys.argv[1]) if len(sys.argv) > 1 else 5000
r = random.Random(20261113)
DECISIONS = list(o.DECISION_RANK)
PIDS = ["FP127", "FP001", "a", "A.b_c-d", "x" * 64, "x" * 65, "", " ", "FP 127", "FP127\n", "é", "😀", "123456789", "12345678", "FP-123456789",
        "12-345-678-9", "a:b", None, 5, True]
DREFS = ["gcf:FP127:funding-proposal", "gcf:FP001:apr-2024", "iati:FP127:feed:XM-DAC-1-2-3", "gcf:FP127", "gcf::x", ":FP127:x", "a:b:",
         "gcf:FP127:" + "x" * 120, "gcf:FP127:" + "x" * 130, "", "gcf:FP 127:x", "gcf:123456789:x", "gcf:FP127:123456789", None, 5, ["x"], "gcf:FP127:x\n"]
STRS = ["USR-1", "USR-2", "", "  ", None, 3]
NOTES = ["The cited document does not show the claimed change.", "x", " ", "", "a" * 500, "a" * 501, "😀" * 501, "mail a@b.org",
         "id 123 456 789", None, 7]
CODES = o.REJECTION_REASON_CODES + ["BECAUSE", "", None, 5]
SEQS = [1, 2, 3, 4, 5, 6, 7, 20, 0, -1]


def field_case():
    rec = {}
    if r.random() < 0.8:
        rec["project_id"] = r.choice(PIDS)
    if r.random() < 0.8:
        rec["doc_ref"] = r.choice(DREFS)
    if r.random() < 0.5 and "project_id" in rec and isinstance(rec["project_id"], str):
        rec["doc_ref"] = "gcf:%s:funding-proposal" % rec["project_id"]
    seq = r.choice(SEQS)
    return {"kind": "fields", "seq": seq, "record": rec, "problems": o.validate_screening_fields(rec, seq)}


def make_chain():
    chain = []
    for i in range(1, r.randint(1, 5) + 1):
        res = {"decision": r.choice(DECISIONS), "psi": 0.5}
        chain.append({"seq": i, "record": {"kind": "SCREENING", "result": res}})
    for _ in range(r.randint(0, 2)):
        seq = len(chain) + 1
        k = r.choice(["OVERRIDE", "REJECTION", "OTHER"])
        chain.append({"seq": seq, "record": {"kind": k, "target_seq": r.randint(1, seq - 1)}})
    return chain


def rejection_case():
    chain = make_chain()
    t = r.choice(chain)
    res = t["record"].get("result", {})
    rec = {"kind": "REJECTION", "target_seq": t["seq"], "rejected_decision": r.choice(DECISIONS), "reason_code": r.choice(o.REJECTION_REASON_CODES),
           "note": "The cited document does not show the claimed change.", "reviewer_id": "USR-1", "approver_id": "USR-2",
           "policy_version": "4.1", "timestamp": "2026-11-13T01:00:00Z"}
    for _ in range(r.choice([0, 0, 1, 1, 2, 3])):
        k = r.choice(["reason_code", "note", "reviewer_id", "approver_id", "target_seq", "rejected_decision", "timestamp", "kind", "extra", "drop", "same"])
        if k == "reason_code":
            rec[k] = r.choice(CODES)
        elif k == "note":
            rec[k] = r.choice(NOTES)
        elif k in ("reviewer_id", "approver_id"):
            rec[k] = r.choice(STRS)
        elif k == "target_seq":
            rec[k] = r.choice([0, 1, 2, 99, "1", None, 1.5, True])
        elif k == "rejected_decision":
            rec[k] = r.choice(DECISIONS + ["MADE_UP", "constructor", "", None])
        elif k == "timestamp":
            rec[k] = r.choice(["yesterday", "2026-11-10T01:02:03+00:00", "2026-11-10T01:02:03.5Z", "2026-11-10T01:02:03Z\n", None])
        elif k == "kind":
            rec[k] = r.choice(["OVERRIDE", "", None])
        elif k == "extra":
            rec[r.choice(["status", "approved_by", "x" * 60, "__proto__"])] = "v"
        elif k == "same":
            rec["approver_id"] = rec.get("reviewer_id", "USR-1")
        else:
            present = [f for f in o.REJECTION_FIELDS if f in rec]
            if present:
                rec.pop(r.choice(present), None)
    rec = {k: v for k, v in rec.items() if v is not None or r.random() < 0.3}
    return {"kind": "rejection", "chain": chain, "record": rec, "problems": o.validate_rejection(chain, rec)}


out = os.path.join(os.path.dirname(__file__), "v460_crosscheck_cases.jsonl")
with open(out, "w") as f:
    for i in range(N):
        f.write(json.dumps(field_case() if i % 2 == 0 else rejection_case()) + "\n")
print(N, "cases written to", out)
