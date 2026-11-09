import unittest

import aegis_override as o

H = "ab" * 32


def screening(seq, decision, psi=0.5, triggers=None):
    res = {"decision": decision, "psi": psi}
    if triggers is not None:
        res["triggers"] = triggers
    return {"seq": seq, "record": {"kind": "SCREENING", "result": res}}


CHAIN = [
    screening(1, "SCREENING_PASS_PENDING_STANDARD_CONTROLS", 0.1),
    screening(2, "RESTRICTION_RECOMMENDED_PENDING_AUTHORITY", 0.9, ["T1"]),
    screening(3, "ALERT_VERIFICATION_REQUIRED", 0.77533472887972),
]


def ov(seq=3, **kw):
    res = CHAIN[seq - 1]["record"]["result"]
    rec = {
        "kind": "OVERRIDE", "target_seq": seq, "original_decision": res["decision"], "original_psi": res["psi"],
        "override_decision": "SCREENING_PASS_PENDING_STANDARD_CONTROLS", "justification_code": "FALSE_MATCH_CONFIRMED",
        "authority_basis": "COMPLIANCE_OFFICER", "consulted_evidence_ids": ["watch:W-1001", "doc:sha256:" + H],
        "note": "Registration number differs from the listed entity.", "reviewer_id": "USR-1", "policy_version": "4.1",
        "timestamp": "2026-11-10T01:02:03Z",
    }
    rec.update(kw)
    return {k: v for k, v in rec.items() if v is not None}


class OverrideTests(unittest.TestCase):
    def test_valid(self):
        self.assertEqual(o.validate_override(CHAIN, ov()), [])

    def test_lists(self):
        self.assertEqual(o.validate_override(CHAIN, ov(justification_code="OTHER")), ["BAD_JUSTIFICATION_CODE"])
        self.assertEqual(o.validate_override(CHAIN, ov(authority_basis="Boss")), ["BAD_AUTHORITY_BASIS"])

    def test_extra_field_and_note(self):
        self.assertEqual(o.validate_override(CHAIN, ov(status="x")), ["UNKNOWN_FIELD:status"])
        self.assertIn("MISSING_FIELD:note", o.validate_override(CHAIN, ov(note=None)))
        self.assertEqual(o.validate_override(CHAIN, ov(note="a" * 501)), ["NOTE_TOO_LONG"])
        self.assertEqual(o.validate_override(CHAIN, ov(note="mail a@b.org")), ["NOTE_PERSONAL_DATA"])

    def test_evidence(self):
        self.assertEqual(o.validate_override(CHAIN, ov(consulted_evidence_ids=["EV-1"])), ["BAD_EVIDENCE_LIST"])
        self.assertEqual(o.validate_override(CHAIN, ov(consulted_evidence_ids=[])), ["EVIDENCE_REQUIRED"])

    def test_second_approver_for_t1(self):
        r = ov(2, override_decision="FLAG_FOR_REVIEW")
        self.assertEqual(o.validate_override(CHAIN, r), ["SECOND_APPROVER_REQUIRED"])
        self.assertEqual(o.validate_override(CHAIN, dict(r, approver_id="USR-1")), ["APPROVER_SAME_AS_REVIEWER"])
        self.assertEqual(o.validate_override(CHAIN, dict(r, approver_id="USR-2")), [])

    def test_once_only(self):
        chain = CHAIN + [{"seq": 4, "record": ov()}]
        self.assertEqual(o.validate_override(chain, ov(override_decision="FLAG_FOR_REVIEW")), ["ALREADY_OVERRIDDEN"])

    def test_targets(self):
        self.assertEqual(o.validate_override(CHAIN, ov(target_seq=9)), ["TARGET_NOT_FOUND"])


if __name__ == "__main__":
    unittest.main()
