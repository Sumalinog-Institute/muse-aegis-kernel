import struct
import unittest

import aegis_audit as a

# (IEEE 754 bit pattern, expected canonical text), modelled on RFC 8785 Appendix B.
NUMBER_CASES = [
    ("0000000000000000", "0"),
    ("8000000000000000", "0"),
    ("0000000000000001", "5e-324"),
    ("8000000000000001", "-5e-324"),
    ("7fefffffffffffff", "1.7976931348623157e+308"),
    ("ffefffffffffffff", "-1.7976931348623157e+308"),
    ("4340000000000000", "9007199254740992"),
    ("c340000000000000", "-9007199254740992"),
    ("4430000000000000", "295147905179352830000"),
    ("44b52d02c7e14af5", "9.999999999999997e+22"),
    ("44b52d02c7e14af6", "1e+23"),
    ("44b52d02c7e14af7", "1.0000000000000001e+23"),
    ("444b1ae4d6e2ef4e", "999999999999999700000"),
    ("444b1ae4d6e2ef4f", "999999999999999900000"),
    ("444b1ae4d6e2ef50", "1e+21"),
    ("3eb0c6f7a0b5ed8c", "9.999999999999997e-7"),
    ("3eb0c6f7a0b5ed8d", "0.000001"),
    ("41b3de4355555553", "333333333.3333332"),
    ("41b3de4355555554", "333333333.33333325"),
    ("41b3de4355555555", "333333333.3333333"),
    ("41b3de4355555556", "333333333.3333334"),
    ("41b3de4355555557", "333333333.33333343"),
    ("becbf647612f3696", "-0.0000033333333333333333"),
    ("43143ff3c1cb0959", "1424953923781206.2"),
]

# Golden vector: the same constants and expected hash are asserted in ts/audit.test.ts.
GOLDEN_RECORD = {"kind": "SCREENING", "x": [0.012, 0, 40], "ok": True, "s": "\u00e9\U0001F600", "n": None}
GOLDEN_CANONICAL = '{"kind":"SCREENING","n":null,"ok":true,"s":"\u00e9\U0001F600","x":[0.012,0,40]}'


class TestCanonical(unittest.TestCase):
    def test_numbers(self):
        for bits, expected in NUMBER_CASES:
            x = struct.unpack(">d", bytes.fromhex(bits))[0]
            self.assertEqual(a.es_number_str(x), expected, bits)

    def test_key_order_is_utf16(self):
        # U+E000 sorts AFTER U+1F600 in UTF-16 code units (surrogates 0xD83D < 0xE000), unlike code points.
        self.assertEqual(a.canonicalize({"\ue000": 1, "\U0001F600": 2}), '{"\U0001F600":2,"\ue000":1}')

    def test_golden_canonical(self):
        self.assertEqual(a.canonicalize(GOLDEN_RECORD), GOLDEN_CANONICAL)

    def test_rejects_nonfinite_and_unknown_types(self):
        for bad in (float("nan"), float("inf"), {1, 2}, 2 ** 60):
            with self.assertRaises((ValueError, TypeError)):
                a.canonicalize(bad)

    def test_key_order_independence(self):
        h1 = a.entry_hash(a.GENESIS_HASH, 1, {"a": 1, "b": 2})
        h2 = a.entry_hash(a.GENESIS_HASH, 1, {"b": 2, "a": 1})
        self.assertEqual(h1, h2)

    def test_hash_depends_on_position(self):
        r = {"a": 1}
        self.assertNotEqual(a.entry_hash(a.GENESIS_HASH, 1, r), a.entry_hash(a.GENESIS_HASH, 2, r))
        self.assertNotEqual(a.entry_hash(a.GENESIS_HASH, 1, r), a.entry_hash("1" * 64, 1, r))

    def test_golden_hash(self):
        self.assertEqual(a.entry_hash(a.GENESIS_HASH, 1, GOLDEN_RECORD),
                         "bdc2e277d53a52a951426c132254432e3e63284292921d77c196643b56b1c5c1")


if __name__ == "__main__":
    unittest.main()
