"""Sanity checks on the fictional grant fixtures. Stdlib only."""
import json
import os
import unittest

BASE = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "fixtures", "grant-xx-nmf-0001-2026-014")
SCEN = sorted(d for d in os.listdir(BASE) if os.path.isdir(os.path.join(BASE, d)))


def load(sc, name):
    with open(os.path.join(BASE, sc, name)) as f:
        return json.load(f)


class TestFixtures(unittest.TestCase):
    def test_eight_scenarios_with_all_files(self):
        self.assertEqual(len(SCEN), 8)
        for sc in SCEN:
            for n in ("award.json", "spend_ledger.json", "reporting_schedule.json", "register.json", "claims_ledger.json", "expected.json"):
                self.assertTrue(os.path.exists(os.path.join(BASE, sc, n)), (sc, n))
            self.assertTrue(os.path.exists(os.path.join(BASE, sc, "report.txt")))

    def test_award_arithmetic(self):
        a = load("s0-as-delivered", "award.json")
        self.assertEqual(sum(b["amount"] for b in a["budget_lines"]), a["amount_awarded"])
        self.assertEqual(sum(p["value"] for p in a["planned_disbursements"]), a["amount_awarded"])
        self.assertEqual(a["amount_disbursed_to_date"], 96000 + 72000)

    def test_everything_is_marked_fictional(self):
        self.assertTrue(load("s0-as-delivered", "award.json")["fictional"])
        self.assertTrue(load("s0-as-delivered", "register.json")["fictional"])
        a = load("s0-as-delivered", "award.json")
        self.assertTrue(a["funding_org"]["identifier"].startswith("XX-"))
        self.assertTrue(a["recipient_org"]["identifier"].startswith("XX-"))
        for sc in SCEN:
            for t in load(sc, "spend_ledger.json")["transactions"]:
                for i in t["receiver_org"]["identifiers"]:
                    self.assertTrue(i["scheme"].startswith("XX-"))
            for e in load(sc, "register.json")["entries"]:
                for i in e["identifiers"]:
                    self.assertTrue(i["scheme"].startswith("XX-"))

    def test_baseline_matches_hand_calculation(self):
        e = load("s0-as-delivered", "expected.json")
        self.assertEqual(e["x4"]["undocumented_value"], 17000.0)
        self.assertEqual(e["x4"]["applicable_value"], 164810.0)
        self.assertEqual(e["x4"]["n_applicable"], 33)
        self.assertEqual(e["x4"]["undocumented_ids"], ["TX-2026-013", "TX-2026-033"])
        self.assertEqual(e["x4"]["pending_ids"], ["TX-2026-018"])
        self.assertAlmostEqual(e["x4"]["x4"], 17000 / 164810, places=15)
        self.assertEqual((e["x5"]["n_due"], e["x5"]["n_submitted"], e["x5"]["late"], e["x5"]["missing"]), (3, 2, ["R2"], ["R3"]))
        self.assertAlmostEqual(e["x5"]["x5"], 1 / 3, places=15)
        self.assertEqual((e["screening"]["x6"], e["screening"]["alert_status"]), (0, "UNVERIFIED"))
        self.assertEqual(e["screening"]["unverified"], [["Northgate Supply Company", "W-1001"]])
        st = {c["subject"]: c["status"] for c in e["claims"]["claims"]}
        self.assertEqual(st, {"Personnel": "SUPPORTED", "Equipment": "SUPPORTED", "Training and workshops": "CONTRADICTED",
                              "Rent and utilities": "SUPPORTED", "Q2 financial and narrative report": "CONTRADICTED",
                              "beneficiaries": "INSUFFICIENT_EVIDENCE"})
        self.assertAlmostEqual(e["claims"]["x2"], 5 / 12, places=15)

    def test_scenarios_exercise_each_rule(self):
        ex = {sc: load(sc, "expected.json") for sc in SCEN}
        self.assertEqual(ex["s1-clean"]["x4"]["x4"], 0.0)
        self.assertEqual(ex["s1-clean"]["x5"]["x5"], 0.0)
        self.assertEqual(ex["s1-clean"]["screening"]["alert_status"], "NONE")
        self.assertGreaterEqual(ex["s2-documentation-gaps"]["x4"]["x4"], 0.25)
        self.assertGreaterEqual(ex["s2-documentation-gaps"]["x4"]["n_applicable"], 10)
        self.assertEqual(ex["s3-confirmed-match"]["screening"]["x6"], 1)
        self.assertEqual(ex["s4-conflicting-match"]["screening"]["alert_status"], "CONFLICTING")
        self.assertEqual(ex["s5-mixed-currency"]["x4"], {"x4": "INCOMPLETE", "reason": "MIXED_CURRENCY"})
        self.assertGreaterEqual(ex["s6-small-sample"]["x4"]["x4"], 0.25)
        self.assertLess(ex["s6-small-sample"]["x4"]["n_applicable"], 10)
        self.assertEqual(ex["s7-ledger-incomplete"]["x4"], {"x4": "INCOMPLETE", "reason": "LEDGER_INCOMPLETE"})

    def test_look_alike_names_do_not_raise_alerts(self):
        e = load("s0-as-delivered", "expected.json")["screening"]
        flagged = {p for p, _ in e["unverified"] + e["conflicting"] + e["confirmed"]}
        self.assertEqual(flagged, {"Northgate Supply Company"})

    def test_narrative_contains_the_wrong_statements_and_the_vague_one(self):
        text = open(os.path.join(BASE, "s0-as-delivered", "report.txt")).read()
        self.assertIn("6,500 USD on training and workshops", text)
        self.assertIn("submitted on 2026-07-30", text)
        self.assertIn("roughly twelve thousand dollars", text)


class TestBundle(unittest.TestCase):
    def test_bundle_matches_the_scenario_files(self):
        with open(os.path.join(BASE, "benchmark-bundle.json")) as f:
            bundle = json.load(f)
        self.assertEqual([s["id"] for s in bundle["scenarios"]], SCEN)
        for s in bundle["scenarios"]:
            sc = s["id"]
            self.assertEqual(s["inputs"]["award"], load(sc, "award.json"))
            self.assertEqual(s["inputs"]["spendLedger"], load(sc, "spend_ledger.json"))
            self.assertEqual(s["inputs"]["schedule"], load(sc, "reporting_schedule.json"))
            self.assertEqual(s["inputs"]["register"], load(sc, "register.json"))
            self.assertEqual(s["inputs"]["claimsLedger"], load(sc, "claims_ledger.json"))
            self.assertEqual(s["inputs"]["documentText"], open(os.path.join(BASE, sc, "report.txt")).read())
            self.assertEqual(s["planted"], load(sc, "expected.json")["planted_issues"])

    def test_planted_problems_for_the_baseline_and_the_clean_case(self):
        e = load("s0-as-delivered", "expected.json")["planted_issues"]
        self.assertEqual([(i["category"], i["ref"]) for i in e["expected"]], [
            ("MISSING_DOCUMENT", "TX-2026-013"), ("MISSING_DOCUMENT", "TX-2026-033"), ("REPORT_LATE", "R2"), ("REPORT_MISSING", "R3"),
            ("WATCHLIST_MATCH", "Northgate Supply Company"), ("NARRATIVE_MISMATCH", "Training and workshops"),
            ("NARRATIVE_MISMATCH", "Q2 financial and narrative report")])
        q2 = [i for i in e["expected"] if i["ref"].startswith("Q2")][0]
        self.assertEqual(q2.get("aliases"), ["R2"])  # the report may be referred to by its schedule id
        self.assertIn({"category": "MISSING_DOCUMENT", "ref": "TX-2026-018"}, e["tolerated"])  # still inside the grace period
        self.assertIn({"category": "DUPLICATE_RECORD", "ref": "TX-2026-016"}, e["tolerated"])  # a repeated export row is a data note
        self.assertEqual(load("s1-clean", "expected.json")["planted_issues"]["expected"], [])
        self.assertIn("WATCHLIST_MATCH", [i["category"] for i in load("s3-confirmed-match", "expected.json")["planted_issues"]["expected"]])

    def test_the_answer_key_is_not_in_the_inputs(self):
        with open(os.path.join(BASE, "benchmark-bundle.json")) as f:
            text = f.read()
        self.assertNotIn("planted_issues", text)
        for s in json.loads(text)["scenarios"]:
            self.assertNotIn("planted", json.dumps(s["inputs"]).lower())


if __name__ == "__main__":
    unittest.main()
