"""Independent Python implementation of the override rules (spec/AUDIT.md, "Override rules"), used to cross-check
validateOverride in ts/audit.ts. Standard library only. `chain` is a list of entries shaped like the TypeScript Entry
({"seq": int, "record": dict, ...}); only seq and record are read."""
import re

DECISION_RANK = {
    "SCREENING_PASS_PENDING_STANDARD_CONTROLS": 0,
    "FLAG_FOR_REVIEW": 1,
    "INCOMPLETE_INPUT_MANUAL_REVIEW": 1,
    "DOCUMENTATION_HOLD_PENDING_REVIEW": 2,
    "ALERT_VERIFICATION_REQUIRED": 3,
    "RESTRICTION_RECOMMENDED_PENDING_AUTHORITY": 4,
}
JUSTIFICATION_CODES = [
    "FALSE_MATCH_CONFIRMED", "SUPPORTING_DOCUMENTATION_VERIFIED", "EXTRACTION_ERROR_CORRECTED", "SOURCE_DATA_ERROR",
    "AUTHORIZED_POLICY_EXCEPTION", "ESCALATED_ON_NEW_INFORMATION", "MATCH_CONFIRMED_ON_NEW_EVIDENCE",
]
AUTHORITY_BASES = ["DESIGNATED_REVIEWER", "COMPLIANCE_OFFICER", "COMMITTEE_DECISION"]
OVERRIDE_FIELDS = [
    "kind", "target_seq", "original_decision", "original_psi", "override_decision", "justification_code", "authority_basis",
    "consulted_evidence_ids", "note", "reviewer_id", "approver_id", "policy_version", "timestamp",
]
REQUIRED_STRINGS = ["reviewer_id", "authority_basis", "justification_code", "original_decision", "override_decision",
                    "policy_version", "timestamp"]
ISO_UTC = re.compile(r"[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(\.[0-9]+)?Z")
EVIDENCE_ID = re.compile(
    r"(watch:[A-Za-z0-9._-]{1,64}|doc:sha256:[0-9a-f]{64}|claim:[A-Za-z0-9._-]{1,64}|ledger:[A-Za-z0-9._-]{1,64}|entry:[1-9][0-9]*)")
NOTE_EMAIL = re.compile(r"[^\s@]+@[^\s@]+\.[^\s@]+")
NOTE_LONG_NUMBER = re.compile(r"[0-9](?:[ -]?[0-9]){8,}")
MAX_NOTE = 500
MAX_EVIDENCE = 20


_MISSING = object()


def _is_str(v):
    return isinstance(v, str)


def _blank(v):
    return not _is_str(v) or v.strip() == ""


def _safe_int(v):
    return isinstance(v, int) and not isinstance(v, bool) and abs(v) <= 2 ** 53 - 1


def validate_override(chain, record):
    problems = []
    if record.get("kind") != "OVERRIDE":
        problems.append("KIND_NOT_OVERRIDE")
    for k in record:
        if k not in OVERRIDE_FIELDS:
            problems.append("UNKNOWN_FIELD:" + k[:40])
    for f in REQUIRED_STRINGS:
        if _blank(record.get(f)):
            problems.append("MISSING_FIELD:" + f)
    ts = record.get("timestamp")
    if _is_str(ts) and not ISO_UTC.fullmatch(ts):
        problems.append("BAD_TIMESTAMP")
    jc = record.get("justification_code")
    if _is_str(jc) and jc not in JUSTIFICATION_CODES:
        problems.append("BAD_JUSTIFICATION_CODE")
    ab = record.get("authority_basis")
    if _is_str(ab) and ab not in AUTHORITY_BASES:
        problems.append("BAD_AUTHORITY_BASIS")
    note = record.get("note")
    if _blank(note):
        problems.append("MISSING_FIELD:note")
    elif len(note) > MAX_NOTE:
        problems.append("NOTE_TOO_LONG")
    elif NOTE_EMAIL.search(note) or NOTE_LONG_NUMBER.search(note):
        problems.append("NOTE_PERSONAL_DATA")
    if "approver_id" in record and _blank(record["approver_id"]):
        problems.append("MISSING_FIELD:approver_id")
    if not _safe_int(record.get("target_seq")):
        problems.append("MISSING_FIELD:target_seq")
    ev = record.get("consulted_evidence_ids")
    if not (isinstance(ev, list) and len(ev) <= MAX_EVIDENCE and all(_is_str(x) and EVIDENCE_ID.fullmatch(x) for x in ev)
            and len(set(ev)) == len(ev)):
        problems.append("BAD_EVIDENCE_LIST")
    od = record.get("override_decision")
    if _is_str(od) and od not in DECISION_RANK:
        problems.append("BAD_DECISION")
    if problems:
        return problems

    target = next((e for e in chain if e["seq"] == record["target_seq"]), None)
    if target is None:
        return ["TARGET_NOT_FOUND"]
    if target["record"].get("kind") != "SCREENING":
        return ["TARGET_NOT_SCREENING"]
    result = target["record"].get("result")
    if not isinstance(result, dict):
        return ["TARGET_NOT_SCREENING"]

    if any(e["record"].get("kind") == "OVERRIDE" and e["record"].get("target_seq") == record["target_seq"] for e in chain):
        problems.append("ALREADY_OVERRIDDEN")
    if record["original_decision"] != result.get("decision"):
        problems.append("ORIGINAL_DECISION_MISMATCH")
    if record.get("original_psi") != result.get("psi"):
        problems.append("ORIGINAL_PSI_MISMATCH")

    frm = DECISION_RANK.get(result.get("decision"))
    to = DECISION_RANK[od]
    if od == result.get("decision"):
        problems.append("NO_CHANGE")
    if frm is not None and to < frm:
        if len(ev) == 0:
            problems.append("EVIDENCE_REQUIRED")
        triggers = result.get("triggers") if isinstance(result.get("triggers"), list) else []
        if "T1" in triggers or result.get("decision") == "RESTRICTION_RECOMMENDED_PENDING_AUTHORITY":
            approver = record.get("approver_id")
            if _blank(approver):
                problems.append("SECOND_APPROVER_REQUIRED")
            elif approver == record["reviewer_id"]:
                problems.append("APPROVER_SAME_AS_REVIEWER")
    return problems


# ---------------------------------------------------------------- project and document references (spec v4.6.0)

LEGACY_MAX_SEQ = 5
PROJECT_ID = re.compile(r"[A-Za-z0-9._-]{1,64}")
DOC_REF = re.compile(r"[A-Za-z0-9._:-]{1,128}")
FIELD_LONG_NUMBER = re.compile(r"[0-9]{9,}")


def validate_screening_fields(record, seq):
    """Problem codes for project_id and doc_ref of a SCREENING record at position seq (absent only for legacy entries)."""
    problems = []
    legacy = seq <= LEGACY_MAX_SEQ
    pid = record.get("project_id", _MISSING)
    dref = record.get("doc_ref", _MISSING)
    pid_ok = False
    if pid is _MISSING:
        if not legacy:
            problems.append("MISSING_PROJECT_ID")
    elif not _is_str(pid) or not PROJECT_ID.fullmatch(pid):
        problems.append("BAD_PROJECT_ID")
    else:
        pid_ok = True
    if dref is _MISSING:
        if not legacy:
            problems.append("MISSING_DOC_REF")
    elif not _is_str(dref) or not DOC_REF.fullmatch(dref):
        problems.append("BAD_DOC_REF")
    else:
        parts = dref.split(":")
        if len(parts) < 3 or parts[0] == "" or parts[1] == "" or parts[2] == "":
            problems.append("BAD_DOC_REF")
        elif pid_ok and parts[1] != pid:
            problems.append("DOC_REF_PROJECT_MISMATCH")
    if (_is_str(pid) and FIELD_LONG_NUMBER.search(pid)) or (_is_str(dref) and FIELD_LONG_NUMBER.search(dref)):
        problems.append("FIELD_PERSONAL_DATA")
    return problems


# ---------------------------------------------------------------- rejections (spec v4.6.0)

REJECTION_REASON_CODES = ["EVIDENCE_INSUFFICIENT", "AUTHORITY_NOT_SHOWN", "JUSTIFICATION_UNCLEAR", "OTHER"]
REJECTION_FIELDS = ["kind", "target_seq", "rejected_decision", "reason_code", "note", "reviewer_id", "approver_id",
                    "policy_version", "timestamp"]
REJECTION_REQUIRED_STRINGS = ["reviewer_id", "approver_id", "reason_code", "rejected_decision", "policy_version", "timestamp"]


def validate_rejection(chain, record):
    problems = []
    if record.get("kind") != "REJECTION":
        problems.append("KIND_NOT_REJECTION")
    for k in record:
        if k not in REJECTION_FIELDS:
            problems.append("UNKNOWN_FIELD:" + k[:40])
    for f in REJECTION_REQUIRED_STRINGS:
        if _blank(record.get(f)):
            problems.append("MISSING_FIELD:" + f)
    ts = record.get("timestamp")
    if _is_str(ts) and not ISO_UTC.fullmatch(ts):
        problems.append("BAD_TIMESTAMP")
    rc = record.get("reason_code")
    if _is_str(rc) and rc not in REJECTION_REASON_CODES:
        problems.append("BAD_REASON_CODE")
    note = record.get("note")
    if _blank(note):
        problems.append("MISSING_FIELD:note")
    elif len(note) > MAX_NOTE:
        problems.append("NOTE_TOO_LONG")
    elif NOTE_EMAIL.search(note) or NOTE_LONG_NUMBER.search(note):
        problems.append("NOTE_PERSONAL_DATA")
    if not _safe_int(record.get("target_seq")):
        problems.append("MISSING_FIELD:target_seq")
    rd = record.get("rejected_decision")
    if _is_str(rd) and rd not in DECISION_RANK:
        problems.append("BAD_DECISION")
    if problems:
        return problems

    target = next((e for e in chain if e["seq"] == record["target_seq"]), None)
    if target is None:
        return ["TARGET_NOT_FOUND"]
    if target["record"].get("kind") != "SCREENING":
        return ["TARGET_NOT_SCREENING"]
    result = target["record"].get("result")
    if not isinstance(result, dict):
        return ["TARGET_NOT_SCREENING"]
    if any(e["record"].get("kind") == "OVERRIDE" and e["record"].get("target_seq") == record["target_seq"] for e in chain):
        problems.append("ALREADY_OVERRIDDEN")
    if rd == result.get("decision"):
        problems.append("NO_CHANGE")
    if record["approver_id"] == record["reviewer_id"]:
        problems.append("APPROVER_SAME_AS_REVIEWER")
    return problems
