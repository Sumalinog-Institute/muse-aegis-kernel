import json
import os
import unittest

import aegis_audit as a
import aegis_override as o

HERE = os.path.dirname(os.path.abspath(__file__))
with open(os.path.join(HERE, "..", "spec", "vectors-v460.json")) as f:
    VECTORS = json.load(f)


class V460Vectors(unittest.TestCase):
    def test_all_vectors(self):
        self.assertGreaterEqual(len(VECTORS), 27)
        for v in VECTORS:
            with self.subTest(v["id"]):
                t = v["type"]
                if t == "fields":
                    got = o.validate_screening_fields(v["record"], v["seq"])
                elif t == "rejection":
                    got = o.validate_rejection(v["chain"], v["record"])
                elif t == "override":
                    got = o.validate_override(v["chain"], v["record"])
                else:
                    self.assertEqual(a.entry_hash(v["prev_hash"], v["seq"], v["record"]), v["expected"])
                    continue
                self.assertEqual(sorted(got), sorted(v["expected"]))


if __name__ == "__main__":
    unittest.main()
