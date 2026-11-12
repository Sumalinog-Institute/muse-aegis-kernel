"""Writes spec/vectors-v460.json: fixed test vectors for the v4.6.0 rules (project_id and doc_ref, REJECTION, second approver).
The expected problem codes are typed in by hand from spec/AUDIT.md, not produced by either implementation. The three hash vectors carry
hashes computed once with python/aegis_audit.py; the TypeScript test recomputes them, so the two implementations check each other.
Run from the repository root: python3 tools/make_vectors_v460.py"""
import json
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "python"))
import aegis_audit as a  # noqa: E402

PASS = "SCREENING_PASS_PENDING_STANDARD_CONTROLS"
HOLD = "DOCUMENTATION_HOLD_PENDING_REVIEW"
RESTR = "RESTRICTION_RECOMMENDED_PENDING_AUTHORITY"
FP = {"project_id": "FP127", "doc_ref": "gcf:FP127:funding-proposal"}


def scr(seq, decision, psi, triggers=None, **extra):
    res = {"decision": decision, "psi": psi}
    if triggers is not None:
        res["triggers"] = triggers
    return {"seq": seq, "record": {"kind": "SCREENING", "result": res, **extra}}


CHAIN = [scr(1, PASS, 1.0), scr(2, RESTR, 0.9, ["T1"]), scr(3, HOLD, 0.95)]
EV = ["watch:W-1001", "doc:sha256:" + "cd" * 32]


def ov(**kw):
    rec = {"kind": "OVERRIDE", "target_seq": 2, "original_decision": RESTR, "original_psi": 0.9, "override_decision": PASS,
           "justification_code": "FALSE_MATCH_CONFIRMED", "authority_basis": "COMPLIANCE_OFFICER", "consulted_evidence_ids": EV,
           "note": "Registration number differs from the listed entity.", "reviewer_id": "USR-1", "policy_version": "4.1",
           "timestamp": "2026-11-13T01:00:00Z"}
    rec.update(kw)
    return rec


def rj(**kw):
    rec = {"kind": "REJECTION", "target_seq": 2, "rejected_decision": PASS, "reason_code": "EVIDENCE_INSUFFICIENT",
           "note": "The cited document does not show the claimed change.", "reviewer_id": "USR-1", "approver_id": "USR-2",
           "policy_version": "4.1", "timestamp": "2026-11-13T01:00:00Z"}
    rec.update(kw)
    return rec


V = []


def add(id, description, type, expected, **kw):
    V.append({"id": id, "description": description, "type": type, **kw, "expected": expected})


# 1 to 7: project_id and doc_ref
add("V1", "Valid project_id and doc_ref at seq 6", "fields", [], seq=6, record=dict(FP))
add("V2", "No project_id at seq 6", "fields", ["MISSING_PROJECT_ID"], seq=6, record={"doc_ref": FP["doc_ref"]})
add("V3", "No doc_ref at seq 6", "fields", ["MISSING_DOC_REF"], seq=6, record={"project_id": "FP127"})
add("V4", "doc_ref names another project", "fields", ["DOC_REF_PROJECT_MISMATCH"], seq=6,
    record={"project_id": "FP127", "doc_ref": "gcf:FP999:funding-proposal"})
add("V5a", "Space in project_id", "fields", ["BAD_PROJECT_ID"], seq=6, record={"project_id": "FP 127", "doc_ref": "gcf:FP127:x"})
add("V5b", "project_id of 65 characters", "fields", ["BAD_PROJECT_ID"], seq=6, record={"project_id": "x" * 65, "doc_ref": "gcf:" + "x" * 65 + ":d"})
add("V5c", "doc_ref with only two parts", "fields", ["BAD_DOC_REF"], seq=6, record={"project_id": "FP127", "doc_ref": "gcf:FP127"})
add("V5d", "doc_ref of 129 characters", "fields", ["BAD_DOC_REF"], seq=6, record={"project_id": "FP127", "doc_ref": "gcf:FP127:" + "x" * 119})
add("V6", "Nine unbroken digits in project_id", "fields", ["FIELD_PERSONAL_DATA"], seq=6,
    record={"project_id": "123456789", "doc_ref": "gcf:123456789:funding-proposal"})
add("V6b", "Hyphenated IATI code in doc_ref is fine", "fields", [], seq=6,
    record={"project_id": "FP127", "doc_ref": "iati:FP127:feed:XM-DAC-1-2-3"})
add("V7a", "Legacy entry (seq 5) without the fields", "fields", [], seq=5, record={})
add("V7b", "Legacy entry that carries an invalid project_id", "fields", ["BAD_PROJECT_ID"], seq=1, record={"project_id": "bad id"})
add("V7c", "First position after the legacy range needs both fields", "fields", ["MISSING_PROJECT_ID", "MISSING_DOC_REF"], seq=6, record={})

# 8: rejections
add("V8a", "Valid rejection", "rejection", [], chain=CHAIN, record=rj())
add("V8b", "Approver equals reviewer", "rejection", ["APPROVER_SAME_AS_REVIEWER"], chain=CHAIN, record=rj(approver_id="USR-1"))
add("V8c", "Unknown reason code", "rejection", ["BAD_REASON_CODE"], chain=CHAIN, record=rj(reason_code="BECAUSE"))
add("V8d", "Rejection targeting an OVERRIDE entry", "rejection", ["TARGET_NOT_SCREENING"],
    chain=CHAIN + [{"seq": 4, "record": ov(target_seq=3, original_decision=HOLD, original_psi=0.95)}], record=rj(target_seq=4))
add("V8e", "Extra field", "rejection", ["UNKNOWN_FIELD:status"], chain=CHAIN, record=rj(status="x"))

# 9: after a rejection a new override is accepted; after an override a second is refused
add("V9a", "New override after a rejection is accepted (second approver supplied)", "override", [],
    chain=CHAIN + [{"seq": 4, "record": rj()}], record=ov(approver_id="USR-2"))
add("V9b", "Second override of the same screening is still refused", "override", ["ALREADY_OVERRIDDEN"],
    chain=CHAIN + [{"seq": 4, "record": ov(approver_id="USR-2")}], record=ov(approver_id="USR-2"))
add("V9c", "A rejection of an already overridden screening is refused", "rejection", ["ALREADY_OVERRIDDEN"],
    chain=CHAIN + [{"seq": 4, "record": ov(approver_id="USR-2")}], record=rj())

# 11: second approver
add("V11a", "Favourable override of a T1 case without approver", "override", ["SECOND_APPROVER_REQUIRED"], chain=CHAIN, record=ov())
add("V11b", "Same with a different approver", "override", [], chain=CHAIN, record=ov(approver_id="USR-2"))
add("V11c", "Same with approver equal to reviewer", "override", ["APPROVER_SAME_AS_REVIEWER"], chain=CHAIN, record=ov(approver_id="USR-1"))

# 12: hashes of the new record shapes
prev = "00" * 32
hash_records = [
    {"kind": "SCREENING", "doc_hash": "sha256:" + "ab" * 32, **FP, "input": {"x1": 0}, "result": {"decision": PASS, "psi": 1.0},
     "extractor_version": "manual-entry", "ledger_id": "none", "policy_version": "4.1", "timestamp": "2026-11-13T01:00:00Z", "actor_id": "USR-1"},
    rj(),
    ov(approver_id="USR-2"),
]
prev_hash = "0" * 64
for i, rec in enumerate(hash_records, start=1):
    h = a.entry_hash(prev_hash, i, rec)
    V.append({"id": "V12-%d" % i, "description": "Entry hash of a %s record (format version 2)" % rec["kind"], "type": "hash",
              "seq": i, "prev_hash": prev_hash, "record": rec, "expected": h})
    prev_hash = h

with open("spec/vectors-v460.json", "w") as f:
    json.dump(V, f, indent=1, ensure_ascii=False)
    f.write("\n")
print(len(V), "vectors written")
