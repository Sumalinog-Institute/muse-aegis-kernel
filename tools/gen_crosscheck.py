"""Generates tools/crosscheck_cases.jsonl: random inputs (valid, NA, INCOMPLETE, invalid, missing)
with the Python kernel's outputs, including the exact IEEE 754 bit pattern of psi.
ts/crosscheck.test.ts replays them through the TypeScript kernel and demands bitwise equality."""
import json
import os
import random
import struct
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "python"))
import aegis_kernel as k  # noqa: E402

N = int(sys.argv[1]) if len(sys.argv) > 1 else 50000
r = random.Random(20261020)


def bits(x):
    return None if x is None else struct.pack(">d", x).hex()


def rand_component(allow_na, binary):
    u = r.random()
    if u < 0.02:
        return "INCOMPLETE"
    if u < 0.04:
        return "NA" if allow_na else "NA"
    if u < 0.06:
        return r.choice([-0.1, 1.5, "abc", None, 1e9])
    if binary:
        return r.choice([0, 1, 0, 0, 0.5 if r.random() < 0.02 else 0])
    return r.random()


out = os.path.join(os.path.dirname(__file__), "crosscheck_cases.jsonl")
with open(out, "w") as f:
    for _ in range(N):
        inp = {
            "x1": rand_component(False, False), "x2": rand_component(False, False),
            "x3": rand_component(False, False), "x4": rand_component(True, False),
            "x5": rand_component(True, False), "x6": rand_component(False, True),
            "n_applicable": r.choice([None, 0, 3, 9, 10, 11, 40, 100, -1, 2.5]) if r.random() < 0.2 else r.randint(0, 80),
            "alert_status": r.choice(["NONE"] * 8 + ["UNVERIFIED", "CONFLICTING", "bogus"]),
        }
        for key in list(inp):
            if r.random() < 0.01:
                del inp[key]
        res = k.evaluate(inp)
        rec = {"input": inp, "psi_bits": bits(res["psi"]), "decision": res["decision"], "triggers": res["triggers"],
               "reasons": res["reasons"], "flags": res["flags"], "incomplete_fields": res["incomplete_fields"],
               "psi_micro": res["psi_micro"]}
        f.write(json.dumps(rec) + "\n")
print(N, "cases written to", out)
