// RFC 8785 JSON Canonicalization Scheme (JCS) for plain JSON values.
// Pure function, no dependencies, no I/O. Used to serialize audit records before hashing.
//
// Rules implemented:
//  - Object keys are sorted by UTF-16 code units (the default JavaScript string sort).
//  - Numbers use the ECMAScript Number-to-string algorithm (what JSON.stringify produces).
//  - Strings use the minimal JSON escaping that JSON.stringify produces.
//  - No insignificant whitespace.
// Anything JSON cannot represent (NaN, Infinity, undefined, functions, Date, Map, ...) is rejected
// with an error instead of being silently dropped or converted, so two records never canonicalize
// to the same bytes by accident.

export function canonicalize(value: unknown): string {
  if (value === null) return "null";
  const t = typeof value;
  if (t === "boolean") return value ? "true" : "false";
  if (t === "number") {
    if (!Number.isFinite(value as number)) throw new TypeError("JCS: non-finite number");
    return JSON.stringify(value);
  }
  if (t === "string") return JSON.stringify(value);
  if (Array.isArray(value)) {
    const parts: string[] = [];
    for (let i = 0; i < value.length; i++) {
      if (!(i in value)) throw new TypeError("JCS: sparse arrays are not allowed");
      parts.push(canonicalize(value[i]));
    }
    return "[" + parts.join(",") + "]";
  }
  if (t === "object") {
    const proto = Object.getPrototypeOf(value);
    if (proto !== Object.prototype && proto !== null) {
      throw new TypeError("JCS: only plain objects are allowed");
    }
    const obj = value as Record<string, unknown>;
    const keys = Object.keys(obj).sort();
    return "{" + keys.map((k) => JSON.stringify(k) + ":" + canonicalize(obj[k])).join(",") + "}";
  }
  throw new TypeError(`JCS: unsupported type ${t}`);
}
