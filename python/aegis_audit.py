"""Independent Python implementation of the audit log's canonical JSON (RFC 8785) and entry hash,
used to cross-check ts/jcs.ts and ts/audit.ts. Standard library only. Signatures are not
implemented here (they are tested in TypeScript)."""
import hashlib
import json
import math
from decimal import Decimal

GENESIS_HASH = "0" * 64
MAX_SAFE_INT = 2 ** 53


def es_number_str(x):
    """ECMAScript Number::toString for a finite double, as required by RFC 8785."""
    x = float(x)
    if not math.isfinite(x):
        raise ValueError("JCS: non-finite number")
    if x == 0:
        return "0"
    sign = "-" if x < 0 else ""
    d = Decimal(repr(abs(x)))
    _, digits, exp = d.as_tuple()
    s = "".join(map(str, digits)).rstrip("0") or "0"
    # value = int(digits) * 10**exp; strip trailing zeros of the digit string into the exponent
    stripped = len("".join(map(str, digits))) - len(s)
    k = len(s)
    n = k + exp + stripped  # value = 0.s * 10**n
    if k <= n <= 21:
        out = s + "0" * (n - k)
    elif 0 < n <= 21:
        out = s[:n] + "." + s[n:]
    elif -6 < n <= 0:
        out = "0." + "0" * (-n) + s
    else:
        e = n - 1
        es = ("+" if e >= 0 else "-") + str(abs(e))
        out = (s if k == 1 else s[0] + "." + s[1:]) + "e" + es
    return sign + out


def canonicalize(value):
    if value is None:
        return "null"
    if value is True:
        return "true"
    if value is False:
        return "false"
    if isinstance(value, int):
        if abs(value) > MAX_SAFE_INT:
            raise ValueError("JCS: integer outside the exactly representable range")
        return es_number_str(float(value))
    if isinstance(value, float):
        return es_number_str(value)
    if isinstance(value, str):
        return json.dumps(value, ensure_ascii=False)
    if isinstance(value, list):
        return "[" + ",".join(canonicalize(v) for v in value) + "]"
    if isinstance(value, dict):
        keys = sorted(value.keys(), key=lambda k: k.encode("utf-16-be"))
        return "{" + ",".join(json.dumps(k, ensure_ascii=False) + ":" + canonicalize(value[k]) for k in keys) + "}"
    raise TypeError("JCS: unsupported type " + type(value).__name__)


def entry_hash(prev_hash, seq, record):
    if len(prev_hash) != 64 or any(c not in "0123456789abcdef" for c in prev_hash):
        raise ValueError("prev_hash must be 64 lowercase hex characters")
    if not isinstance(seq, int) or isinstance(seq, bool) or seq < 1:
        raise ValueError("seq must be a positive integer")
    if not isinstance(record, dict):
        raise ValueError("record must be an object")
    body = canonicalize({"seq": seq, "record": record}).encode("utf-8")
    return hashlib.sha256(bytes.fromhex(prev_hash) + body).hexdigest()
