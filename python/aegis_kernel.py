"""MUSE Aegis reference kernel, gate and decision logic. Spec V4.1.

Independent Python implementation of ts/kernel.ts, used for cross-checking.
Only +, -, * on IEEE 754 binary64 floats; fixed order ((f_ground*f4)*f5)*f6.
"""
import math

SPEC_VERSION = "4.1"

# Provisional design parameters (spec Sections 4 and 5). Not validated.
W_GROUND = 0.40
W4 = 0.20
W5 = 0.15
W6 = 0.30
THETA_DOC = 0.25
THETA_STAB = 0.20
N_MIN = 10
TAU_REVIEW_MICRO = 750000
NEAR = 1e-6


def _check(val, allow_na, binary):
    """Returns ('ok', value) | ('na', None) | ('bad', reason)."""
    if val is None:
        return ("bad", "MISSING")
    if isinstance(val, str):
        if val == "INCOMPLETE":
            return ("bad", "INCOMPLETE")
        if val == "NA":
            return ("na", None) if allow_na else ("bad", "NA_NOT_ALLOWED")
        return ("bad", "INVALID_VALUE")
    if isinstance(val, bool) or not isinstance(val, (int, float)):
        return ("bad", "INVALID_VALUE")
    try:
        v = float(val)
    except OverflowError:
        return ("bad", "INVALID_VALUE")
    if not math.isfinite(v):
        return ("bad", "INVALID_VALUE")
    if v < 0 or v > 1:
        return ("bad", "OUT_OF_RANGE")
    if binary and v != 0 and v != 1:
        return ("bad", "NOT_BINARY")
    return ("ok", v)


def _is_nonneg_integer(val):
    if isinstance(val, bool) or not isinstance(val, (int, float)):
        return False
    try:
        f = float(val)
    except OverflowError:
        return False
    return math.isfinite(f) and f.is_integer() and f >= 0


def evaluate(p):
    incomplete, flags, reasons, triggers = [], [], [], []

    c1 = _check(p.get("x1"), False, False)
    c2 = _check(p.get("x2"), False, False)
    c4 = _check(p.get("x4"), True, False)
    c5 = _check(p.get("x5"), True, False)
    c6 = _check(p.get("x6"), False, True)
    for name, c in (("x1", c1), ("x2", c2), ("x4", c4), ("x5", c5), ("x6", c6)):
        if c[0] == "bad":
            incomplete.append(f"{name}:{c[1]}")

    x3 = p.get("x3")
    if x3 is not None and _check(x3, False, False)[0] == "bad":
        flags.append("X3_INVALID")
    if c4[0] == "na":
        flags.append("X4_NOT_APPLICABLE")
    if c5[0] == "na":
        flags.append("X5_NOT_APPLICABLE")

    n_ok, n = False, 0
    if c4[0] == "ok":
        cn = p.get("n_applicable")
        if cn is None:
            incomplete.append("n_applicable:MISSING")
        elif not _is_nonneg_integer(cn):
            incomplete.append("n_applicable:INVALID_VALUE")
        else:
            n_ok, n = True, float(cn)

    alert = p.get("alert_status")
    alert = "NONE" if alert is None else alert
    alert_ok = isinstance(alert, str) and alert in ("NONE", "UNVERIFIED", "CONFLICTING")
    if not alert_ok:
        incomplete.append("alert_status:INVALID_VALUE")

    small = False
    if c6[0] == "ok" and c6[1] == 1:
        triggers.append("T1")
    if c4[0] == "ok" and n_ok and c4[1] >= THETA_DOC:
        if n >= N_MIN:
            triggers.append("T2")
        else:
            small = True
    if alert_ok and alert != "NONE" and c6[0] == "ok" and c6[1] == 0:
        triggers.append("T3")

    psi = None
    micro = None
    if c2[0] == "ok" and c4[0] != "bad" and c5[0] != "bad" and c6[0] == "ok":
        f_g = 1 - W_GROUND * c2[1]
        f4 = 1 - W4 * c4[1] if c4[0] == "ok" else 1.0
        f5 = 1 - W5 * c5[1] if c5[0] == "ok" else 1.0
        f6 = 1 - W6 * c6[1]
        psi = ((f_g * f4) * f5) * f6
        micro = math.floor(psi * 1e6 + 0.5)

    near = False
    if psi is not None and abs(psi - 0.75) <= NEAR:
        near = True
    if c1[0] == "ok" and abs(c1[1] - THETA_STAB) <= NEAR:
        near = True
    if c4[0] == "ok" and abs(c4[1] - THETA_DOC) <= NEAR:
        near = True
    if near:
        flags.append("NEAR_THRESHOLD")

    if "T1" in triggers:
        decision = "RESTRICTION_RECOMMENDED_PENDING_AUTHORITY"
    elif "T3" in triggers:
        decision = "ALERT_VERIFICATION_REQUIRED"
    elif "T2" in triggers:
        decision = "DOCUMENTATION_HOLD_PENDING_REVIEW"
    elif incomplete or psi is None or micro is None or c1[0] != "ok":
        decision = "INCOMPLETE_INPUT_MANUAL_REVIEW"
    else:
        if micro < TAU_REVIEW_MICRO:
            reasons.append("LOW_SCORE")
        if c1[1] >= THETA_STAB:
            reasons.append("UNSTABLE_EXTRACTION")
        if small:
            reasons.append("SMALL_SAMPLE")
        decision = "FLAG_FOR_REVIEW" if reasons else "SCREENING_PASS_PENDING_STANDARD_CONTROLS"

    return {
        "spec_version": SPEC_VERSION,
        "psi": psi,
        "psi_micro": micro,
        "triggers": triggers,
        "reasons": reasons,
        "flags": flags,
        "incomplete_fields": incomplete,
        "decision": decision,
    }
