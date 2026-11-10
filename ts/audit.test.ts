import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { canonicalize } from "./jcs.ts";
import {
  GENESIS_HASH, entryHash, generateKeyPair, makeSigner, makeVerifier, nextEntry, verifyChain,
  validateOverride, effectiveDecision,
} from "./audit.ts";
import type { Entry } from "./audit.ts";
import { evaluate } from "./kernel.ts";

const NUMBER_CASES: [string, string][] = [
  ["0000000000000000", "0"], ["8000000000000000", "0"], ["0000000000000001", "5e-324"],
  ["8000000000000001", "-5e-324"], ["7fefffffffffffff", "1.7976931348623157e+308"],
  ["ffefffffffffffff", "-1.7976931348623157e+308"], ["4340000000000000", "9007199254740992"],
  ["c340000000000000", "-9007199254740992"], ["4430000000000000", "295147905179352830000"],
  ["44b52d02c7e14af5", "9.999999999999997e+22"], ["44b52d02c7e14af6", "1e+23"],
  ["44b52d02c7e14af7", "1.0000000000000001e+23"], ["444b1ae4d6e2ef4e", "999999999999999700000"],
  ["444b1ae4d6e2ef4f", "999999999999999900000"], ["444b1ae4d6e2ef50", "1e+21"],
  ["3eb0c6f7a0b5ed8c", "9.999999999999997e-7"], ["3eb0c6f7a0b5ed8d", "0.000001"],
  ["41b3de4355555553", "333333333.3333332"], ["41b3de4355555554", "333333333.33333325"],
  ["41b3de4355555555", "333333333.3333333"], ["41b3de4355555556", "333333333.3333334"],
  ["41b3de4355555557", "333333333.33333343"], ["becbf647612f3696", "-0.0000033333333333333333"],
  ["43143ff3c1cb0959", "1424953923781206.2"],
];

function fromBits(hex: string): number {
  const dv = new DataView(new ArrayBuffer(8));
  dv.setBigUint64(0, BigInt("0x" + hex), false);
  return dv.getFloat64(0, false);
}

// ---------------------------------------------------------------- canonical JSON

test("JCS number formatting matches RFC 8785 Appendix B style cases", () => {
  for (const [bits, expected] of NUMBER_CASES) assert.equal(canonicalize(fromBits(bits)), expected, bits);
});

test("JCS sorts keys by UTF-16 code units, not code points", () => {
  assert.equal(canonicalize({ "\ue000": 1, "\u{1F600}": 2 }), '{"\u{1F600}":2,"\ue000":1}');
});

test("JCS rejects values JSON cannot represent", () => {
  for (const bad of [NaN, Infinity, undefined, () => 1, new Date(), new Map(), 10n, { a: undefined }, [undefined]]) {
    assert.throws(() => canonicalize(bad), TypeError);
  }
});

test("golden vector: same canonical text and hash as the Python implementation", async () => {
  const rec = { kind: "SCREENING", x: [0.012, 0, 40], ok: true, s: "\u00e9\u{1F600}", n: null };
  assert.equal(canonicalize(rec), '{"kind":"SCREENING","n":null,"ok":true,"s":"\u00e9\u{1F600}","x":[0.012,0,40]}');
  assert.equal(await entryHash(GENESIS_HASH, 1, rec), "bdc2e277d53a52a951426c132254432e3e63284292921d77c196643b56b1c5c1");
});

test("hash ignores key order but depends on position and predecessor", async () => {
  assert.equal(await entryHash(GENESIS_HASH, 1, { a: 1, b: 2 }), await entryHash(GENESIS_HASH, 1, { b: 2, a: 1 }));
  assert.notEqual(await entryHash(GENESIS_HASH, 1, { a: 1 }), await entryHash(GENESIS_HASH, 2, { a: 1 }));
  assert.notEqual(await entryHash(GENESIS_HASH, 1, { a: 1 }), await entryHash("1".repeat(64), 1, { a: 1 }));
});

// ---------------------------------------------------------------- fixtures

const vectors = JSON.parse(readFileSync(new URL("../spec/vectors.json", import.meta.url), "utf8"));
const kp = await generateKeyPair();
const attackerKp = await generateKeyPair();
const signer = await makeSigner("k1", kp.privateJwk);
const verifier = await makeVerifier({ k1: kp.publicJwk });

function screening(vec: { input: Record<string, unknown> }, i: number): Record<string, unknown> {
  return {
    kind: "SCREENING",
    doc_hash: "sha256:" + String(i).padStart(64, "0"),
    input: vec.input,
    result: evaluate(vec.input),
    extractor_version: "test-extractor",
    ledger_id: "test-ledger",
    policy_version: "4.1",
    timestamp: `2026-10-23T10:0${i}:00Z`,
  };
}

async function buildChain(): Promise<Entry[]> {
  const chain: Entry[] = [];
  for (let i = 0; i < 6; i++) chain.push(await nextEntry(chain, screening(vectors[i], i), signer)); // TV1..TV6
  return chain;
}

const chain = await buildChain();
const codes = (r: { errors: { code: string }[] }) => new Set(r.errors.map((e) => e.code));
const clone = <T,>(x: T): T => structuredClone(x);

// ---------------------------------------------------------------- chain and tamper detection

test("an untouched chain verifies", async () => {
  const r = await verifyChain(chain, verifier);
  assert.equal(r.ok, true);
  assert.equal(r.length, 6);
  assert.equal(chain[0].prev_hash, GENESIS_HASH);
  assert.equal(chain[1].prev_hash, chain[0].hash);
});

test("nextEntry does not modify its inputs", async () => {
  const rec = screening(vectors[0], 0);
  const before = clone(rec);
  const c: Entry[] = [];
  const e = await nextEntry(c, rec, signer);
  assert.deepEqual(rec, before);
  assert.equal(c.length, 0);
  rec.kind = "CHANGED";
  assert.equal(e.record.kind, "SCREENING");
});

test("tamper: editing a recorded decision is detected", async () => {
  const c = clone(chain);
  (c[2].record.result as Record<string, unknown>).decision = "SCREENING_PASS_PENDING_STANDARD_CONTROLS";
  const r = await verifyChain(c, verifier);
  assert.equal(r.ok, false);
  assert.ok(codes(r).has("HASH_MISMATCH"));
});

test("tamper: deleting a middle entry is detected", async () => {
  const c = clone(chain);
  c.splice(2, 1);
  const r = await verifyChain(c, verifier);
  assert.equal(r.ok, false);
  assert.ok(codes(r).has("SEQ_MISMATCH"));
  assert.ok(codes(r).has("PREV_HASH_MISMATCH"));
});

test("tamper: reordering entries is detected", async () => {
  const c = clone(chain);
  [c[1], c[2]] = [c[2], c[1]];
  const r = await verifyChain(c, verifier);
  assert.equal(r.ok, false);
  assert.ok(codes(r).has("SEQ_MISMATCH"));
});

test("tamper: replaying a duplicate entry is detected", async () => {
  const c = clone(chain);
  c.splice(3, 0, clone(c[1]));
  const r = await verifyChain(c, verifier);
  assert.equal(r.ok, false);
  assert.ok(codes(r).has("SEQ_MISMATCH"));
});

test("tamper: swapping in another entry's signature is detected", async () => {
  const c = clone(chain);
  c[2].signature = c[1].signature;
  const r = await verifyChain(c, verifier);
  assert.equal(r.ok, false);
  assert.ok(codes(r).has("SIGNATURE_INVALID"));
});

test("tamper: editing a record and recomputing every hash without the key is detected", async () => {
  const forged: Entry[] = clone(chain.slice(0, 2));
  const attacker = await makeSigner("k1", attackerKp.privateJwk); // claims to be k1 but holds another key
  const edited = clone(chain[2].record);
  (edited.result as Record<string, unknown>).decision = "SCREENING_PASS_PENDING_STANDARD_CONTROLS";
  forged.push(await nextEntry(forged, edited, attacker));
  for (let i = 3; i < 6; i++) forged.push(await nextEntry(forged, clone(chain[i].record), attacker));
  const r = await verifyChain(forged, verifier);
  assert.equal(r.ok, false);
  assert.ok(codes(r).has("SIGNATURE_INVALID"));
  assert.equal(r.errors.some((e) => e.index < 2), false); // untouched prefix still verifies
});

test("tamper: entries signed under an unknown key id are flagged", async () => {
  const c = clone(chain.slice(0, 2));
  const evil = await makeSigner("evil", attackerKp.privateJwk);
  c.push(await nextEntry(c, clone(chain[2].record), evil));
  const r = await verifyChain(c, verifier);
  assert.ok(codes(r).has("UNKNOWN_KEY"));
});

test("limitation: deleting the TAIL is invisible without an external checkpoint, and caught with one", async () => {
  const truncated = clone(chain.slice(0, 4));
  assert.equal((await verifyChain(truncated, verifier)).ok, true); // honest about the limit
  const head = { seq: chain[5].seq, hash: chain[5].hash };
  const r = await verifyChain(truncated, verifier, { expectedHead: head });
  assert.equal(r.ok, false);
  assert.ok(codes(r).has("TRUNCATED"));
  const wrongHead = await verifyChain(clone(chain), verifier, { expectedHead: { seq: 6, hash: "f".repeat(64) } });
  assert.ok(codes(wrongHead).has("HEAD_MISMATCH"));
});

// ---------------------------------------------------------------- overrides

const PASS = "SCREENING_PASS_PENDING_STANDARD_CONTROLS";
const DOC_HOLD = "DOCUMENTATION_HOLD_PENDING_REVIEW";
const T1_DECISION = "RESTRICTION_RECOMMENDED_PENDING_AUTHORITY";

function override(target: Entry, extra: Record<string, unknown> = {}): Record<string, unknown> {
  const result = target.record.result as Record<string, unknown>;
  return {
    kind: "OVERRIDE",
    target_seq: target.seq,
    original_decision: result.decision,
    original_psi: result.psi,
    reviewer_id: "USR-REVIEW-1",
    authority_basis: "COMPLIANCE_OFFICER",
    justification_code: "SUPPORTING_DOCUMENTATION_VERIFIED",
    consulted_evidence_ids: ["doc:sha256:" + "cd".repeat(32)],
    note: "Registration documents reviewed; the entity differs from the listed one.",
    override_decision: PASS,
    policy_version: "4.1",
    timestamp: "2026-10-23T12:00:00Z",
    ...extra,
  };
}

test("fixtures have the decisions the override tests rely on", () => {
  assert.equal((chain[4].record.result as Record<string, unknown>).decision, DOC_HOLD); // TV5
  assert.equal((chain[1].record.result as Record<string, unknown>).decision, T1_DECISION); // TV2
  assert.equal((chain[0].record.result as Record<string, unknown>).decision, PASS); // TV1
});

test("override: a documented favourable override is accepted", () => {
  assert.deepEqual(validateOverride(chain, override(chain[4])), []);
});

test("override: favourable without evidence is rejected", () => {
  assert.deepEqual(validateOverride(chain, override(chain[4], { consulted_evidence_ids: [] })), ["EVIDENCE_REQUIRED"]);
});

test("override: relaxing a confirmed-breach case needs a distinct second approver", () => {
  const base = override(chain[1], { override_decision: "FLAG_FOR_REVIEW" });
  assert.deepEqual(validateOverride(chain, base), ["SECOND_APPROVER_REQUIRED"]);
  assert.deepEqual(validateOverride(chain, { ...base, approver_id: "USR-REVIEW-1" }), ["APPROVER_SAME_AS_REVIEWER"]);
  assert.deepEqual(validateOverride(chain, { ...base, approver_id: "USR-APPROVE-2" }), []);
});

test("override: a stricter override is allowed without evidence", () => {
  const r = override(chain[0], { override_decision: DOC_HOLD, consulted_evidence_ids: [] });
  assert.deepEqual(validateOverride(chain, r), []);
});

test("override: wrong original values, missing target, bad targets and no-ops are rejected", () => {
  assert.ok(validateOverride(chain, override(chain[4], { original_decision: PASS })).includes("ORIGINAL_DECISION_MISMATCH"));
  assert.ok(validateOverride(chain, override(chain[4], { original_psi: 0.123 })).includes("ORIGINAL_PSI_MISMATCH"));
  assert.deepEqual(validateOverride(chain, override(chain[4], { target_seq: 99 })), ["TARGET_NOT_FOUND"]);
  assert.ok(validateOverride(chain, override(chain[4], { override_decision: DOC_HOLD })).includes("NO_CHANGE"));
  assert.ok(validateOverride(chain, override(chain[4], { override_decision: "MADE_UP" })).includes("BAD_DECISION"));
  assert.ok(validateOverride(chain, override(chain[4], { reviewer_id: "" })).includes("MISSING_FIELD:reviewer_id"));
  assert.ok(validateOverride(chain, override(chain[4], { timestamp: "yesterday" })).includes("BAD_TIMESTAMP"));
});

test("override: appended as a new entry; the original stays in the log and the chain still verifies", async () => {
  const originalEntry = clone(chain[4]);
  assert.deepEqual(effectiveDecision(chain, 5), { decision: DOC_HOLD, overridden: false, override_seq: null });
  const ov = override(chain[4]);
  assert.deepEqual(validateOverride(chain, ov), []);
  const extended = [...chain, await nextEntry(chain, ov, signer)];
  assert.equal((await verifyChain(extended, verifier)).ok, true);
  assert.deepEqual(extended[4], originalEntry); // original entry untouched
  assert.deepEqual(effectiveDecision(extended, 5), { decision: PASS, overridden: true, override_seq: 7 });
  // an override cannot itself be overridden by pointing at it
  assert.deepEqual(validateOverride(extended, override(chain[4], { target_seq: 7 })), ["TARGET_NOT_SCREENING"]);
});

test("override: only the approved justification codes and authority bases are accepted", () => {
  for (const c of ["FALSE_MATCH_CONFIRMED", "SUPPORTING_DOCUMENTATION_VERIFIED", "EXTRACTION_ERROR_CORRECTED", "SOURCE_DATA_ERROR",
    "AUTHORIZED_POLICY_EXCEPTION", "ESCALATED_ON_NEW_INFORMATION", "MATCH_CONFIRMED_ON_NEW_EVIDENCE"]) {
    assert.deepEqual(validateOverride(chain, override(chain[4], { justification_code: c })), [], c);
  }
  for (const a of ["DESIGNATED_REVIEWER", "COMPLIANCE_OFFICER", "COMMITTEE_DECISION"]) {
    assert.deepEqual(validateOverride(chain, override(chain[4], { authority_basis: a })), [], a);
  }
  assert.deepEqual(validateOverride(chain, override(chain[4], { justification_code: "MANUAL_DOCUMENT_VERIFIED" })), ["BAD_JUSTIFICATION_CODE"]);
  assert.deepEqual(validateOverride(chain, override(chain[4], { authority_basis: "Compliance reviewer" })), ["BAD_AUTHORITY_BASIS"]);
});

test("override: extra fields are refused", () => {
  assert.deepEqual(validateOverride(chain, override(chain[4], { status: "done" })), ["UNKNOWN_FIELD:status"]);
});

test("override: the note is required, at most 500 characters, and free of obvious personal data", () => {
  assert.ok(validateOverride(chain, override(chain[4], { note: "" })).includes("MISSING_FIELD:note"));
  assert.ok(validateOverride(chain, override(chain[4], { note: undefined })).includes("MISSING_FIELD:note"));
  assert.deepEqual(validateOverride(chain, override(chain[4], { note: "a".repeat(500) })), []);
  assert.deepEqual(validateOverride(chain, override(chain[4], { note: "\u{1F600}".repeat(500) })), []); // counted in characters
  assert.deepEqual(validateOverride(chain, override(chain[4], { note: "a".repeat(501) })), ["NOTE_TOO_LONG"]);
  assert.deepEqual(validateOverride(chain, override(chain[4], { note: "call a.b@example.org" })), ["NOTE_PERSONAL_DATA"]);
  assert.deepEqual(validateOverride(chain, override(chain[4], { note: "passport 123 456 789" })), ["NOTE_PERSONAL_DATA"]);
});

test("override: evidence ids must be typed, unique and at most 20", () => {
  const ok = ["watch:W-1001", "doc:sha256:" + "ab".repeat(32), "claim:C-7", "ledger:L.2", "entry:3"];
  assert.deepEqual(validateOverride(chain, override(chain[4], { consulted_evidence_ids: ok })), []);
  for (const bad of [["EV-100"], ["watch:"], ["doc:sha256:xyz"], ["entry:0"], ["watch:W-1", "watch:W-1"], [5], "watch:W-1",
    Array.from({ length: 21 }, (_, i) => `watch:W-${i}`)]) {
    assert.deepEqual(validateOverride(chain, override(chain[4], { consulted_evidence_ids: bad })), ["BAD_EVIDENCE_LIST"], JSON.stringify(bad).slice(0, 40));
  }
});

test("override: a screening can be overridden once", async () => {
  const extended = [...chain, await nextEntry(chain, override(chain[4]), signer)];
  assert.deepEqual(validateOverride(extended, override(chain[4], { override_decision: "ALERT_VERIFICATION_REQUIRED" })), ["ALREADY_OVERRIDDEN"]);
});

test("override: decision names that are only inherited object properties are refused", () => {
  assert.ok(validateOverride(chain, override(chain[4], { override_decision: "constructor" })).includes("BAD_DECISION"));
});
