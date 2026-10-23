"""Writes spec/vectors.json. Expected values are typed in by hand from the paper (Section 9.2) and
from the decision rules; they are NOT computed by the kernel, so the tests check the kernel
against the specification rather than against itself."""
import json

BASE = {"x1": 0, "x2": 0, "x3": 0, "x4": 0, "x5": 0, "x6": 0, "n_applicable": 40, "alert_status": "NONE"}
PASS = "SCREENING_PASS_PENDING_STANDARD_CONTROLS"
T1 = "RESTRICTION_RECOMMENDED_PENDING_AUTHORITY"
T2 = "DOCUMENTATION_HOLD_PENDING_REVIEW"
T3 = "ALERT_VERIFICATION_REQUIRED"
FLAG = "FLAG_FOR_REVIEW"
INC = "INCOMPLETE_INPUT_MANUAL_REVIEW"


def v(id_, desc, delta, psi, decision, triggers=(), reasons=(), flags_include=(), incomplete=None, drop=()):
    inp = dict(BASE)
    inp.update(delta)
    for k in drop:
        inp.pop(k, None)
    exp = {"psi": psi, "decision": decision, "triggers": list(triggers), "reasons": list(reasons)}
    if flags_include:
        exp["flags_include"] = list(flags_include)
    if incomplete is not None:
        exp["incomplete_fields"] = incomplete
    return {"id": id_, "description": desc, "input": inp, "expected": exp}


vectors = [
    v("TV1", "All clear", {}, 1.0, PASS),
    v("TV2", "Confirmed breach (T1)", {"x1": 0.012, "x3": 0.05, "x4": 0.02, "x6": 1}, 0.6972, T1, ["T1"]),
    v("TV3", "Worst case", {"x1": 1, "x2": 1, "x4": 1, "x5": 1, "x6": 1}, 0.2856, T1, ["T1", "T2"]),
    v("TV4", "Unstable extraction withholds a pass", {"x1": 0.5, "x2": 0.2, "x4": 0.1, "x5": 0.1}, 0.8881, FLAG, [], ["UNSTABLE_EXTRACTION"]),
    v("TV5", "Non-compensability: high psi, documentation trigger", {"x4": 0.25}, 0.95, T2, ["T2"], [], ["NEAR_THRESHOLD"]),
    v("TV6", "Clean pass", {"x1": 0.1, "x2": 0.1, "x4": 0.05}, 0.9504, PASS),
    v("TV7", "Small sample cannot fire T2", {"x4": 0.5, "n_applicable": 4}, 0.9, FLAG, [], ["SMALL_SAMPLE"]),
    v("TV8", "Unverified alert (T3)", {"alert_status": "UNVERIFIED"}, 1.0, T3, ["T3"]),
    v("TV9", "Low score", {"x2": 0.8, "x4": 0.1, "x5": 0.2}, 0.6464, FLAG, [], ["LOW_SCORE"]),
    v("EV1", "T1 takes precedence over INCOMPLETE x2", {"x2": "INCOMPLETE", "x6": 1}, None, T1, ["T1"], [], [], ["x2:INCOMPLETE"]),
    v("EV2", "x4 and x5 not applicable are factors of 1", {"x4": "NA", "x5": "NA"}, 1.0, PASS, [], [], ["X4_NOT_APPLICABLE", "X5_NOT_APPLICABLE"]),
    v("EV3", "Invalid string value", {"x2": "abc"}, None, INC, [], [], [], ["x2:INVALID_VALUE"]),
    v("EV4", "Out-of-range value", {"x2": 1.2}, None, INC, [], [], [], ["x2:OUT_OF_RANGE"]),
    v("EV5", "x6 must be 0 or 1", {"x6": 0.5}, None, INC, [], [], [], ["x6:NOT_BINARY"]),
    v("EV6", "x4 = theta_doc with N = N_min fires T2", {"x4": 0.25, "n_applicable": 10}, 0.95, T2, ["T2"]),
    v("EV7", "x4 = theta_doc with N = N_min - 1 is small sample", {"x4": 0.25, "n_applicable": 9}, 0.95, FLAG, [], ["SMALL_SAMPLE"]),
    v("EV8", "psi exactly at tau_review passes", {"x2": 0.625}, 0.75, PASS, [], [], ["NEAR_THRESHOLD"]),
    v("EV9", "x1 exactly at theta_stab withholds a pass", {"x1": 0.2}, 1.0, FLAG, [], ["UNSTABLE_EXTRACTION"], ["NEAR_THRESHOLD"]),
    v("EV10", "x1 INCOMPLETE blocks a pass", {"x1": "INCOMPLETE"}, 1.0, INC, [], [], [], ["x1:INCOMPLETE"]),
    v("EV11", "T2 takes precedence over INCOMPLETE x2", {"x2": "INCOMPLETE", "x4": 0.5}, None, T2, ["T2"], [], [], ["x2:INCOMPLETE"]),
    v("EV12", "T3 takes precedence over T2", {"x4": 0.5, "alert_status": "CONFLICTING"}, 0.9, T3, ["T2", "T3"]),
    v("EV13", "Missing x5 is never treated as 0", {}, None, INC, [], [], [], ["x5:MISSING"], drop=("x5",)),
    v("EV14", "Numeric x4 requires n_applicable", {"x4": 0.1}, 0.98, INC, [], [], [], ["n_applicable:MISSING"], drop=("n_applicable",)),
    v("EV15", "Invalid x3 is flagged but never blocks", {"x3": 7}, 1.0, PASS, [], [], ["X3_INVALID"]),
]

with open("spec/vectors.json", "w") as f:
    json.dump(vectors, f, indent=1)
print(len(vectors), "vectors written")
