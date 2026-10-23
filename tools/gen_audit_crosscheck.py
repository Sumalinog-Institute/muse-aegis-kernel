"""Generates tools/audit_crosscheck_cases.jsonl: random JSON values with their RFC 8785 canonical text,
and random chain entries with their hashes, all computed by the Python implementation.
ts/audit_crosscheck.test.ts replays them through the TypeScript implementation and requires
identical canonical text and identical hashes."""
import json
import math
import os
import random
import struct
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "python"))
import aegis_audit as a  # noqa: E402

N = int(sys.argv[1]) if len(sys.argv) > 1 else 20000
r = random.Random(20261023)

SPECIAL = [0.0, -0.0, 1e21, 1e-7, 1e-6, 123456789012345680000.0, 1e22, 5e-324, 1.7976931348623157e308,
           0.1, 0.2, 0.30000000000000004, 100.0, 1e100, 4.35, 9007199254740993.0]


def rand_float():
    u = r.random()
    if u < 0.15:
        return r.choice(SPECIAL)
    if u < 0.5:
        return round(r.uniform(-1e6, 1e6), r.randint(0, 12))
    while True:
        x = struct.unpack(">d", struct.pack(">Q", r.getrandbits(64)))[0]
        if math.isfinite(x):
            return x


def rand_codepoint():
    u = r.random()
    if u < 0.4:
        return r.randint(0x20, 0x7E)
    if u < 0.5:
        return r.randint(0x00, 0x1F)
    if u < 0.6:
        return r.randint(0x7F, 0xFF)
    if u < 0.85:
        while True:
            c = r.randint(0x100, 0xFFFF)
            if not 0xD800 <= c <= 0xDFFF:
                return c
    return r.randint(0x10000, 0x10FFFF)


def rand_str():
    return "".join(chr(rand_codepoint()) for _ in range(r.randint(0, 8)))


def rand_value(depth=0):
    u = r.random()
    if depth >= 3 or u < 0.5:
        k = r.random()
        if k < 0.15:
            return None
        if k < 0.25:
            return r.random() < 0.5
        if k < 0.45:
            return r.randint(-10 ** 9, 10 ** 9)
        if k < 0.7:
            return rand_float()
        return rand_str()
    if u < 0.75:
        return [rand_value(depth + 1) for _ in range(r.randint(0, 4))]
    return {rand_str(): rand_value(depth + 1) for _ in range(r.randint(0, 4))}


def rand_record():
    return {rand_str(): rand_value(1) for _ in range(r.randint(1, 5))}


out = os.path.join(os.path.dirname(__file__), "audit_crosscheck_cases.jsonl")
with open(out, "w") as f:
    for _ in range(N):
        v = rand_value()
        f.write(json.dumps({"type": "canon", "value": v, "canonical": a.canonicalize(v)}) + "\n")
    for _ in range(N):
        rec = rand_record()
        prev = "".join(r.choice("0123456789abcdef") for _ in range(64))
        seq = r.randint(1, 10 ** 6)
        f.write(json.dumps({"type": "hash", "prev": prev, "seq": seq, "record": rec,
                            "hash": a.entry_hash(prev, seq, rec)}) + "\n")
print(2 * N, "cases written to", out)
