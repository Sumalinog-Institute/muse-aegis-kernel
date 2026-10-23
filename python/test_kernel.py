import json
import os
import random
import unittest

import aegis_kernel as k

HERE = os.path.dirname(os.path.abspath(__file__))
with open(os.path.join(HERE, "..", "spec", "vectors.json")) as f:
    VECTORS = json.load(f)


def random_profile(r):
    return {
        "x1": r.random(), "x2": r.random(), "x3": r.random(), "x4": r.random(), "x5": r.random(),
        "x6": 1 if r.random() < 0.3 else 0,
        "n_applicable": int(r.random() * 60),
        "alert_status": "NONE",
    }


class TestVectors(unittest.TestCase):
    def test_vectors(self):
        for vec in VECTORS:
            with self.subTest(vec["id"]):
                res = k.evaluate(vec["input"])
                e = vec["expected"]
                self.assertEqual(res["decision"], e["decision"])
                self.assertEqual(res["triggers"], e["triggers"])
                self.assertEqual(res["reasons"], e["reasons"])
                if e["psi"] is None:
                    self.assertIsNone(res["psi"])
                else:
                    self.assertLessEqual(abs(res["psi"] - e["psi"]), 5e-5)
                for fl in e.get("flags_include", []):
                    self.assertIn(fl, res["flags"])
                if "incomplete_fields" in e:
                    self.assertEqual(res["incomplete_fields"], e["incomplete_fields"])


class TestProperties(unittest.TestCase):
    def test_extremes(self):
        self.assertEqual(k.evaluate({"x1": 0, "x2": 0, "x4": 0, "x5": 0, "x6": 0, "n_applicable": 40})["psi"], 1)
        worst = k.evaluate({"x1": 1, "x2": 1, "x4": 1, "x5": 1, "x6": 1, "n_applicable": 40})["psi"]
        self.assertLess(abs(worst - 0.2856), 1e-12)

    def test_bounds(self):
        r = random.Random(12345)
        for _ in range(100000):
            psi = k.evaluate(random_profile(r))["psi"]
            self.assertTrue(0.2856 - 1e-12 <= psi <= 1)

    def test_monotone(self):
        r = random.Random(777)
        for _ in range(20000):
            p = random_profile(r)
            base = k.evaluate(p)["psi"]
            for key in ("x2", "x4", "x5"):
                q = dict(p)
                q[key] = min(1.0, p[key] + r.random() * 0.5)
                self.assertLessEqual(k.evaluate(q)["psi"], base)
            q6 = dict(p)
            q6["x6"] = 1
            self.assertLessEqual(k.evaluate(q6)["psi"], base)

    def test_x1_x3_do_not_change_psi(self):
        r = random.Random(99)
        for _ in range(20000):
            p = random_profile(r)
            q = dict(p, x1=r.random(), x3=r.random())
            self.assertEqual(k.evaluate(q)["psi"], k.evaluate(p)["psi"])


if __name__ == "__main__":
    unittest.main()
