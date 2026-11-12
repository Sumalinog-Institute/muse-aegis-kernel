// MUSE Aegis audit log module (paper Section 9). Phase 2.
// Hash-chained, signed, append-only entries; a chain verifier; override validation.
// Pure functions over plain data. Uses only the standard Web Crypto API (SHA-256, ECDSA P-256),
// so it runs on Node 22+, Deno, browsers and edge runtimes. No I/O: persistence is the caller's job.
//
// Entry hash:  H_t = SHA-256( H_{t-1} (32 raw bytes) || UTF-8( JCS({ seq: t, record: record_t }) ) )
// with H_0 = 64 zeros (hex). Each entry is signed: signature = ECDSA-P256-SHA256 over the 32 raw
// bytes of H_t, encoded as base64 (IEEE P1363 r||s format).
//
// Format version 2 (spec v4.6.0): SCREENING records carry project_id and doc_ref; a REJECTION record kind exists.
//
// What this module does NOT do: authenticate people, store keys safely, or stop someone with write
// access from deleting the TAIL of the log. Tail deletion is detectable only against an external
// checkpoint (see VerifyOptions.expectedHead). See spec/AUDIT.md.

import { canonicalize } from "./jcs.ts";

export const AUDIT_FORMAT_VERSION = "2";
export const GENESIS_HASH = "0".repeat(64);

export interface Entry {
  seq: number;
  prev_hash: string;
  record: Record<string, unknown>;
  hash: string;
  key_id: string;
  signature: string;
}

export interface Signer {
  keyId: string;
  sign(data: Uint8Array): Promise<string>;
}

export type VerifyOutcome = "ok" | "bad" | "unknown_key";
export type Verifier = (keyId: string, data: Uint8Array, signatureB64: string) => Promise<VerifyOutcome>;

const enc = new TextEncoder();
const HEX64 = /^[0-9a-f]{64}$/;

function toHex(buf: ArrayBuffer): string {
  return Array.from(new Uint8Array(buf), (b) => b.toString(16).padStart(2, "0")).join("");
}

function fromHex(hex: string) {
  if (!HEX64.test(hex)) throw new TypeError("expected 64 lowercase hex characters");
  const out = new Uint8Array(32);
  for (let i = 0; i < 32; i++) out[i] = parseInt(hex.slice(2 * i, 2 * i + 2), 16);
  return out;
}

function toB64(buf: ArrayBuffer): string {
  let s = "";
  for (const b of new Uint8Array(buf)) s += String.fromCharCode(b);
  return btoa(s);
}

function fromB64(b64: string) {
  const s = atob(b64);
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}

function isPlainRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

// ---------------------------------------------------------------- hashing

export async function entryHash(prevHash: string, seq: number, record: unknown): Promise<string> {
  const prev = fromHex(prevHash);
  if (!Number.isSafeInteger(seq) || seq < 1) throw new TypeError("seq must be a positive safe integer");
  if (!isPlainRecord(record)) throw new TypeError("record must be a JSON object");
  const body = enc.encode(canonicalize({ seq, record }));
  const data = new Uint8Array(prev.length + body.length);
  data.set(prev, 0);
  data.set(body, prev.length);
  return toHex(await crypto.subtle.digest("SHA-256", data));
}

// ---------------------------------------------------------------- keys and signatures (ECDSA P-256)

export async function generateKeyPair(): Promise<{ privateJwk: JsonWebKey; publicJwk: JsonWebKey }> {
  const kp = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
  return {
    privateJwk: await crypto.subtle.exportKey("jwk", kp.privateKey),
    publicJwk: await crypto.subtle.exportKey("jwk", kp.publicKey),
  };
}

export async function makeSigner(keyId: string, privateJwk: JsonWebKey): Promise<Signer> {
  const key = await crypto.subtle.importKey("jwk", privateJwk, { name: "ECDSA", namedCurve: "P-256" }, false, ["sign"]);
  return {
    keyId,
    async sign(data: Uint8Array): Promise<string> {
      return toB64(await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, key, data as BufferSource));
    },
  };
}

export async function makeVerifier(publicKeys: Record<string, JsonWebKey>): Promise<Verifier> {
  const imported = new Map<string, CryptoKey>();
  for (const [id, jwk] of Object.entries(publicKeys)) {
    imported.set(id, await crypto.subtle.importKey("jwk", jwk, { name: "ECDSA", namedCurve: "P-256" }, false, ["verify"]));
  }
  return async (keyId, data, signatureB64) => {
    const key = imported.get(keyId);
    if (!key) return "unknown_key";
    try {
      const ok = await crypto.subtle.verify({ name: "ECDSA", hash: "SHA-256" }, key, fromB64(signatureB64), data as BufferSource);
      return ok ? "ok" : "bad";
    } catch {
      return "bad";
    }
  };
}

// ---------------------------------------------------------------- appending

/** Builds the next entry for a chain. Pure: does not modify `chain` and does not persist anything. */
export async function nextEntry(chain: readonly Entry[], record: Record<string, unknown>, signer: Signer): Promise<Entry> {
  const last = chain.length > 0 ? chain[chain.length - 1] : null;
  const seq = last ? last.seq + 1 : 1;
  const prev_hash = last ? last.hash : GENESIS_HASH;
  const copy = structuredClone(record);
  const hash = await entryHash(prev_hash, seq, copy);
  const signature = await signer.sign(fromHex(hash));
  return { seq, prev_hash, record: copy, hash, key_id: signer.keyId, signature };
}

// ---------------------------------------------------------------- verification

export interface VerifyError {
  index: number; // 0-based position in the array that was checked
  seq: number | null;
  code: string;
  detail?: string;
}

export interface VerifyResult {
  ok: boolean;
  length: number;
  errors: VerifyError[];
}

export interface VerifyOptions {
  /** A trusted checkpoint kept OUTSIDE the log store: the head's seq and hash at some earlier time.
   *  Needed to detect deletion of the tail. */
  expectedHead?: { seq: number; hash: string };
}

export async function verifyChain(entries: readonly Entry[], verifier: Verifier, opts: VerifyOptions = {}): Promise<VerifyResult> {
  const errors: VerifyError[] = [];
  for (let i = 0; i < entries.length; i++) {
    const e = entries[i] as unknown;
    if (!isPlainRecord(e)) {
      errors.push({ index: i, seq: null, code: "BAD_FORMAT", detail: "entry is not an object" });
      continue;
    }
    const seq = typeof e["seq"] === "number" ? e["seq"] : null;
    const bad = typeof e["seq"] !== "number" || typeof e["prev_hash"] !== "string" || typeof e["hash"] !== "string" ||
      typeof e["key_id"] !== "string" || typeof e["signature"] !== "string" || !isPlainRecord(e["record"]);
    if (bad) {
      errors.push({ index: i, seq, code: "BAD_FORMAT" });
      continue;
    }
    const entry = e as unknown as Entry;
    if (entry.seq !== i + 1) {
      errors.push({ index: i, seq, code: "SEQ_MISMATCH", detail: `expected ${i + 1}` });
    }
    const expectedPrev = i === 0 ? GENESIS_HASH : (entries[i - 1] as Entry | undefined)?.hash;
    if (entry.prev_hash !== expectedPrev) {
      errors.push({ index: i, seq, code: "PREV_HASH_MISMATCH" });
    }
    let recomputed: string | null = null;
    try {
      recomputed = await entryHash(entry.prev_hash, entry.seq, entry.record);
    } catch (err) {
      errors.push({ index: i, seq, code: "BAD_FORMAT", detail: String(err) });
    }
    if (recomputed !== null && recomputed !== entry.hash) {
      errors.push({ index: i, seq, code: "HASH_MISMATCH" });
    }
    let sigOutcome: VerifyOutcome = "bad";
    try {
      sigOutcome = await verifier(entry.key_id, fromHex(entry.hash), entry.signature);
    } catch {
      sigOutcome = "bad";
    }
    if (sigOutcome === "unknown_key") errors.push({ index: i, seq, code: "UNKNOWN_KEY", detail: entry.key_id });
    else if (sigOutcome !== "ok") errors.push({ index: i, seq, code: "SIGNATURE_INVALID" });
  }
  const head = opts.expectedHead;
  if (head) {
    if (entries.length < head.seq) {
      errors.push({ index: entries.length, seq: null, code: "TRUNCATED", detail: `checkpoint seq ${head.seq}, log has ${entries.length}` });
    } else if ((entries[head.seq - 1] as Entry).hash !== head.hash) {
      errors.push({ index: head.seq - 1, seq: head.seq, code: "HEAD_MISMATCH" });
    }
  }
  return { ok: errors.length === 0, length: entries.length, errors };
}

// ---------------------------------------------------------------- overrides (paper Section 9.3)

// Higher rank = more restrictive outcome. An override to a LOWER rank is "favourable".
export const DECISION_RANK: Readonly<Record<string, number>> = {
  SCREENING_PASS_PENDING_STANDARD_CONTROLS: 0,
  FLAG_FOR_REVIEW: 1,
  INCOMPLETE_INPUT_MANUAL_REVIEW: 1,
  DOCUMENTATION_HOLD_PENDING_REVIEW: 2,
  ALERT_VERIFICATION_REQUIRED: 3,
  RESTRICTION_RECOMMENDED_PENDING_AUTHORITY: 4,
};

export const JUSTIFICATION_CODES: readonly string[] = [
  "FALSE_MATCH_CONFIRMED", "SUPPORTING_DOCUMENTATION_VERIFIED", "EXTRACTION_ERROR_CORRECTED", "SOURCE_DATA_ERROR",
  "AUTHORIZED_POLICY_EXCEPTION", "ESCALATED_ON_NEW_INFORMATION", "MATCH_CONFIRMED_ON_NEW_EVIDENCE",
];
export const AUTHORITY_BASES: readonly string[] = ["DESIGNATED_REVIEWER", "COMPLIANCE_OFFICER", "COMMITTEE_DECISION"];
export const OVERRIDE_FIELDS: readonly string[] = [
  "kind", "target_seq", "original_decision", "original_psi", "override_decision", "justification_code", "authority_basis",
  "consulted_evidence_ids", "note", "reviewer_id", "approver_id", "policy_version", "timestamp",
];
export const MAX_OVERRIDE_NOTE_CHARS = 500;
export const MAX_EVIDENCE_IDS = 20;

const OVERRIDE_REQUIRED_STRINGS = [
  "reviewer_id", "authority_basis", "justification_code", "original_decision", "override_decision", "policy_version", "timestamp",
];
const ISO_UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/;
// Typed evidence references: a watch-list entry, a document hash, a claim, a ledger fact, or an earlier log entry.
const EVIDENCE_ID = /^(watch:[A-Za-z0-9._-]{1,64}|doc:sha256:[0-9a-f]{64}|claim:[A-Za-z0-9._-]{1,64}|ledger:[A-Za-z0-9._-]{1,64}|entry:[1-9][0-9]*)$/;
// A light screen for obvious personal data in the note (an email address, or a run of 9 or more digits). It is a
// guard against slips, not a privacy guarantee: the reviewer remains responsible for the note's content.
const NOTE_EMAIL = /[^\s@]+@[^\s@]+\.[^\s@]+/;
const NOTE_LONG_NUMBER = /[0-9](?:[ -]?[0-9]){8,}/;

/** Returns a list of problem codes; an empty list means the override record is acceptable to append.
 *  This checks the record's content against the log. It cannot check that the person really holds the
 *  claimed authority: that needs an identity and permissions system outside this module. */
export function validateOverride(chain: readonly Entry[], record: Record<string, unknown>): string[] {
  const problems: string[] = [];
  if (record["kind"] !== "OVERRIDE") problems.push("KIND_NOT_OVERRIDE");
  for (const k of Object.keys(record)) {
    if (!OVERRIDE_FIELDS.includes(k)) problems.push(`UNKNOWN_FIELD:${k.slice(0, 40)}`);
  }
  for (const f of OVERRIDE_REQUIRED_STRINGS) {
    const v = record[f];
    if (typeof v !== "string" || v.trim() === "") problems.push(`MISSING_FIELD:${f}`);
  }
  if (typeof record["timestamp"] === "string" && !ISO_UTC.test(record["timestamp"])) problems.push("BAD_TIMESTAMP");
  if (typeof record["justification_code"] === "string" && !JUSTIFICATION_CODES.includes(record["justification_code"])) problems.push("BAD_JUSTIFICATION_CODE");
  if (typeof record["authority_basis"] === "string" && !AUTHORITY_BASES.includes(record["authority_basis"])) problems.push("BAD_AUTHORITY_BASIS");
  const note = record["note"];
  if (typeof note !== "string" || note.trim() === "") problems.push("MISSING_FIELD:note");
  else if ([...note].length > MAX_OVERRIDE_NOTE_CHARS) problems.push("NOTE_TOO_LONG");
  else if (NOTE_EMAIL.test(note) || NOTE_LONG_NUMBER.test(note)) problems.push("NOTE_PERSONAL_DATA");
  if (record["approver_id"] !== undefined && (typeof record["approver_id"] !== "string" || record["approver_id"].trim() === "")) {
    problems.push("MISSING_FIELD:approver_id");
  }
  if (!Number.isSafeInteger(record["target_seq"])) problems.push("MISSING_FIELD:target_seq");
  const ev = record["consulted_evidence_ids"];
  if (!Array.isArray(ev) || ev.length > MAX_EVIDENCE_IDS || !ev.every((x) => typeof x === "string" && EVIDENCE_ID.test(x)) || new Set(ev).size !== ev.length) {
    problems.push("BAD_EVIDENCE_LIST");
  }
  if (typeof record["override_decision"] === "string" && !Object.hasOwn(DECISION_RANK, record["override_decision"])) problems.push("BAD_DECISION");
  if (problems.length > 0) return problems;

  const target = chain.find((e) => e.seq === record["target_seq"]);
  if (!target) return ["TARGET_NOT_FOUND"];
  if (target.record["kind"] !== "SCREENING") return ["TARGET_NOT_SCREENING"];
  const result = target.record["result"] as Record<string, unknown> | undefined;
  if (!result) return ["TARGET_NOT_SCREENING"];

  if (chain.some((e) => e.record["kind"] === "OVERRIDE" && e.record["target_seq"] === record["target_seq"])) problems.push("ALREADY_OVERRIDDEN");
  if (record["original_decision"] !== result["decision"]) problems.push("ORIGINAL_DECISION_MISMATCH");
  if (record["original_psi"] !== result["psi"]) problems.push("ORIGINAL_PSI_MISMATCH");

  const from = DECISION_RANK[result["decision"] as string];
  const to = DECISION_RANK[record["override_decision"] as string];
  if (record["override_decision"] === result["decision"]) problems.push("NO_CHANGE");

  const evidence = record["consulted_evidence_ids"] as string[];
  if (from !== undefined && to !== undefined && to < from) {
    // Favourable override: evidence is required, and a second approver if the original was a confirmed breach.
    if (evidence.length === 0) problems.push("EVIDENCE_REQUIRED");
    const triggers = Array.isArray(result["triggers"]) ? (result["triggers"] as unknown[]) : [];
    if (triggers.includes("T1") || result["decision"] === "RESTRICTION_RECOMMENDED_PENDING_AUTHORITY") {
      const approver = record["approver_id"];
      if (typeof approver !== "string" || approver.trim() === "") problems.push("SECOND_APPROVER_REQUIRED");
      else if (approver === record["reviewer_id"]) problems.push("APPROVER_SAME_AS_REVIEWER");
    }
  }
  return problems;
}

// ---------------------------------------------------------------- project and document references (spec v4.6.0)

/** Entries with seq up to this value were written before v4.6.0 and may lack project_id and doc_ref.
 *  From the next position on both are required. Set to the head seq of the live log at the time of the bump. */
export const LEGACY_MAX_SEQ = 5;
const PROJECT_ID = /^[A-Za-z0-9._-]{1,64}$/;
const DOC_REF = /^[A-Za-z0-9._:-]{1,128}$/;
// Project identifiers and IATI codes use hyphens, so only an unbroken run of digits counts as a possible personal number here.
const FIELD_LONG_NUMBER = /[0-9]{9,}/;

/** Problem codes for the project_id and doc_ref of a SCREENING record at position `seq`.
 *  The fields may be absent only for legacy entries (seq <= LEGACY_MAX_SEQ). An empty list means acceptable. */
export function validateScreeningFields(record: Record<string, unknown>, seq: number): string[] {
  const problems: string[] = [];
  const legacy = seq <= LEGACY_MAX_SEQ;
  const pid = record["project_id"];
  const dref = record["doc_ref"];
  let pidOk = false;
  if (pid === undefined) {
    if (!legacy) problems.push("MISSING_PROJECT_ID");
  } else if (typeof pid !== "string" || !PROJECT_ID.test(pid)) {
    problems.push("BAD_PROJECT_ID");
  } else {
    pidOk = true;
  }
  if (dref === undefined) {
    if (!legacy) problems.push("MISSING_DOC_REF");
  } else if (typeof dref !== "string" || !DOC_REF.test(dref)) {
    problems.push("BAD_DOC_REF");
  } else {
    const parts = dref.split(":");
    if (parts.length < 3 || parts[0] === "" || parts[1] === "" || parts[2] === "") problems.push("BAD_DOC_REF");
    else if (pidOk && parts[1] !== pid) problems.push("DOC_REF_PROJECT_MISMATCH");
  }
  if ((typeof pid === "string" && FIELD_LONG_NUMBER.test(pid)) || (typeof dref === "string" && FIELD_LONG_NUMBER.test(dref))) {
    problems.push("FIELD_PERSONAL_DATA");
  }
  return problems;
}

/** Checks project_id and doc_ref across a whole chain. Kept separate from verifyChain, which stays purely cryptographic. */
export function checkScreeningFields(chain: readonly Entry[]): { seq: number; code: string }[] {
  const out: { seq: number; code: string }[] = [];
  for (const e of chain) {
    if (e.record["kind"] !== "SCREENING") continue;
    for (const code of validateScreeningFields(e.record, e.seq)) out.push({ seq: e.seq, code });
  }
  return out;
}

// ---------------------------------------------------------------- rejections (spec v4.6.0)

export const REJECTION_REASON_CODES: readonly string[] = ["EVIDENCE_INSUFFICIENT", "AUTHORITY_NOT_SHOWN", "JUSTIFICATION_UNCLEAR", "OTHER"];
export const REJECTION_FIELDS: readonly string[] = [
  "kind", "target_seq", "rejected_decision", "reason_code", "note", "reviewer_id", "approver_id", "policy_version", "timestamp",
];
const REJECTION_REQUIRED_STRINGS = ["reviewer_id", "approver_id", "reason_code", "rejected_decision", "policy_version", "timestamp"];

/** Problem codes for a REJECTION record: an approver's refusal of a pending override request.
 *  A rejection never changes the decision in force and does not use up the one-override-per-screening rule. */
export function validateRejection(chain: readonly Entry[], record: Record<string, unknown>): string[] {
  const problems: string[] = [];
  if (record["kind"] !== "REJECTION") problems.push("KIND_NOT_REJECTION");
  for (const k of Object.keys(record)) {
    if (!REJECTION_FIELDS.includes(k)) problems.push(`UNKNOWN_FIELD:${k.slice(0, 40)}`);
  }
  for (const f of REJECTION_REQUIRED_STRINGS) {
    const v = record[f];
    if (typeof v !== "string" || v.trim() === "") problems.push(`MISSING_FIELD:${f}`);
  }
  if (typeof record["timestamp"] === "string" && !ISO_UTC.test(record["timestamp"])) problems.push("BAD_TIMESTAMP");
  if (typeof record["reason_code"] === "string" && !REJECTION_REASON_CODES.includes(record["reason_code"])) problems.push("BAD_REASON_CODE");
  const note = record["note"];
  if (typeof note !== "string" || note.trim() === "") problems.push("MISSING_FIELD:note");
  else if ([...note].length > MAX_OVERRIDE_NOTE_CHARS) problems.push("NOTE_TOO_LONG");
  else if (NOTE_EMAIL.test(note) || NOTE_LONG_NUMBER.test(note)) problems.push("NOTE_PERSONAL_DATA");
  if (!Number.isSafeInteger(record["target_seq"])) problems.push("MISSING_FIELD:target_seq");
  if (typeof record["rejected_decision"] === "string" && !Object.hasOwn(DECISION_RANK, record["rejected_decision"])) problems.push("BAD_DECISION");
  if (problems.length > 0) return problems;

  const target = chain.find((e) => e.seq === record["target_seq"]);
  if (!target) return ["TARGET_NOT_FOUND"];
  if (target.record["kind"] !== "SCREENING") return ["TARGET_NOT_SCREENING"];
  const result = target.record["result"] as Record<string, unknown> | undefined;
  if (!result) return ["TARGET_NOT_SCREENING"];

  if (chain.some((e) => e.record["kind"] === "OVERRIDE" && e.record["target_seq"] === record["target_seq"])) problems.push("ALREADY_OVERRIDDEN");
  if (record["rejected_decision"] === result["decision"]) problems.push("NO_CHANGE");
  if (record["approver_id"] === record["reviewer_id"]) problems.push("APPROVER_SAME_AS_REVIEWER");
  return problems;
}

/** The decision in force for a screening entry: the latest override targeting it, else the original.
 *  The original entry is never changed; this only reads the chain. */
export function effectiveDecision(chain: readonly Entry[], seq: number): { decision: string; overridden: boolean; override_seq: number | null } {
  const target = chain.find((e) => e.seq === seq);
  if (!target || target.record["kind"] !== "SCREENING") throw new RangeError("no SCREENING entry with that seq");
  const original = (target.record["result"] as Record<string, unknown>)["decision"] as string;
  let latest: Entry | null = null;
  for (const e of chain) {
    if (e.record["kind"] === "OVERRIDE" && e.record["target_seq"] === seq) latest = e;
  }
  if (!latest) return { decision: original, overridden: false, override_seq: null };
  return { decision: latest.record["override_decision"] as string, overridden: true, override_seq: latest.seq };
}
