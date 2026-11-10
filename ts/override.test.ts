import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { evaluate } from "./kernel.ts";
import { effectiveDecision, generateKeyPair, makeSigner, makeVerifier, verifyChain } from "./audit.ts";
import { appendOverride, appendScreening, rowsToEntries, StoreConflictError } from "./append.ts";
import type { AppendDeps, OverrideStore, StoreRow } from "./append.ts";

const USER = "11111111-2222-3333-4444-555555555555";
const DOC = "sha256:" + "ab".repeat(32);
const PASS = "SCREENING_PASS_PENDING_STANDARD_CONTROLS";
const vectors: { id: string; input: Record<string, unknown> }[] = JSON.parse(readFileSync(new URL("../spec/vectors.json", import.meta.url), "utf8"));
const profile = (id: string) => vectors.find((v) => v.id === id)!.input;

class MemStore implements OverrideStore {
  rows: StoreRow[] = [];
  beforeInsert: (() => Promise<void>) | null = null;
  async getHead() {
    const last = this.rows[this.rows.length - 1];
    return last ? { seq: last.seq, hash: last.hash } : null;
  }
  async readAll() { return structuredClone(this.rows); }
  async insert(row: StoreRow) {
    if (this.beforeInsert) { const f = this.beforeInsert; this.beforeInsert = null; await f(); }
    const last = this.rows[this.rows.length - 1];
    if (row.seq !== (last ? last.seq + 1 : 1) || row.prev_hash !== (last ? last.hash : "0".repeat(64))) throw new StoreConflictError("audit: position taken");
    this.rows.push(structuredClone(row));
  }
}

const kp = await generateKeyPair();
const signer = await makeSigner("k1", kp.privateJwk);
const verifier = await makeVerifier({ k1: kp.publicJwk });
let tick = 0;
const deps = (store: MemStore): AppendDeps & { store: OverrideStore } => ({
  store, signer, verifier, evaluate: evaluate as unknown as AppendDeps["evaluate"], now: () => new Date(Date.UTC(2026, 10, 10, 1, 0, tick++)),
});

// Builds a log: seq 1 TV1 (pass), 2 TV2 (T1 restriction), 3 TV5 (documentation hold), 4 TV8 (alert).
async function seeded() {
  const store = new MemStore();
  for (const id of ["TV1", "TV2", "TV5", "TV8"]) {
    const out = await appendScreening(deps(store), { userId: USER, allowedUserIds: USER, body: { profile: profile(id), doc_hash: DOC } });
    assert.equal(out.ok, true);
  }
  return store;
}
const EV = ["watch:W-1001", "doc:sha256:" + "cd".repeat(32)];
const body = (over: Record<string, unknown> = {}) => ({
  target_seq: 3, override_decision: PASS, justification_code: "SUPPORTING_DOCUMENTATION_VERIFIED", authority_basis: "DESIGNATED_REVIEWER",
  consulted_evidence_ids: EV, note: "Supporting documents received and checked.", ...over,
});
const call = (store: MemStore, b: unknown, over: Record<string, unknown> = {}) =>
  appendOverride(deps(store), { userId: USER, allowedUserIds: USER, body: b, ...over } as { userId: string; allowedUserIds: string | undefined; body: unknown });

test("an override is written as a new signed entry; the server fills in reviewer, policy version, time and the original values", async () => {
  const store = await seeded();
  const out = await call(store, body());
  assert.equal(out.ok && out.entry.seq, 5);
  const entries = rowsToEntries(store.rows);
  assert.equal((await verifyChain(entries, verifier)).ok, true);
  const rec = entries[4]!.record;
  assert.equal(rec["kind"], "OVERRIDE");
  assert.equal(rec["reviewer_id"], USER);
  assert.equal(rec["policy_version"], "4.1");
  assert.equal(rec["original_decision"], "DOCUMENTATION_HOLD_PENDING_REVIEW");
  assert.equal(rec["original_psi"], 0.95);
  assert.equal(typeof rec["timestamp"], "string");
  assert.deepEqual(effectiveDecision(entries, 3), { decision: PASS, overridden: true, override_seq: 5 });
  assert.equal(effectiveDecision(entries, 4).overridden, false);
});

test("a second override of the same screening is refused (409), and so is a second attempt after a refusal for other reasons", async () => {
  const store = await seeded();
  assert.equal((await call(store, body())).ok, true);
  const again = await call(store, body({ override_decision: "ALERT_VERIFICATION_REQUIRED" }));
  assert.deepEqual([again.ok, !again.ok && again.status, !again.ok && again.message], [false, 409, "ALREADY_OVERRIDDEN"]);
  assert.equal(store.rows.length, 5);
});

test("lowering a restriction or T1 case is blocked: no second approver can be supplied", async () => {
  const store = await seeded();
  const out = await call(store, body({ target_seq: 2, override_decision: "FLAG_FOR_REVIEW" }));
  assert.deepEqual([out.ok, !out.ok && out.status, !out.ok && out.message], [false, 400, "SECOND_APPROVER_REQUIRED"]);
  const withApprover = await call(store, body({ target_seq: 2, override_decision: "FLAG_FOR_REVIEW", approver_id: "someone" }));
  assert.deepEqual([withApprover.ok, !withApprover.ok && withApprover.code], [false, "BAD_REQUEST"]);
  assert.equal(store.rows.length, 4);
});

test("a stricter override needs no evidence", async () => {
  const store = await seeded();
  const out = await call(store, body({ target_seq: 1, override_decision: "DOCUMENTATION_HOLD_PENDING_REVIEW", consulted_evidence_ids: [], justification_code: "ESCALATED_ON_NEW_INFORMATION" }));
  assert.equal(out.ok, true);
});

test("the caller cannot set server-filled or unknown fields", async () => {
  const store = await seeded();
  for (const extra of [{ reviewer_id: "x" }, { policy_version: "9" }, { timestamp: "2026-01-01T00:00:00Z" }, { original_decision: PASS }, { original_psi: 1 }, { kind: "OVERRIDE" }, { whatever: 1 }]) {
    const out = await call(store, body(extra));
    assert.deepEqual([out.ok, !out.ok && out.code], [false, "BAD_REQUEST"], JSON.stringify(extra));
  }
  for (const bad of [null, [], "x", 5]) assert.equal((await call(store, bad)).ok, false);
  assert.equal(store.rows.length, 4);
});

test("bad lists, notes and evidence are refused with the problem codes", async () => {
  const store = await seeded();
  const cases: [Record<string, unknown>, string][] = [
    [{ justification_code: "MANUAL_DOCUMENT_VERIFIED" }, "BAD_JUSTIFICATION_CODE"],
    [{ authority_basis: "Boss" }, "BAD_AUTHORITY_BASIS"],
    [{ note: "" }, "MISSING_FIELD:note"],
    [{ note: "x".repeat(501) }, "NOTE_TOO_LONG"],
    [{ note: "write to me at a@b.org" }, "NOTE_PERSONAL_DATA"],
    [{ consulted_evidence_ids: ["EV-1"] }, "BAD_EVIDENCE_LIST"],
    [{ consulted_evidence_ids: [] }, "EVIDENCE_REQUIRED"],
    [{ override_decision: "DOCUMENTATION_HOLD_PENDING_REVIEW" }, "NO_CHANGE"],
    [{ override_decision: "MADE_UP" }, "BAD_DECISION"],
  ];
  for (const [over, code] of cases) {
    const out = await call(store, body(over));
    assert.deepEqual([out.ok, !out.ok && out.status, !out.ok && out.message], [false, 400, code], code);
  }
  const missing = await call(store, body({ target_seq: 99 }));
  assert.deepEqual([missing.ok, !missing.ok && missing.status], [false, 404]);
  assert.equal(store.rows.length, 4);
});

test("only allow-listed, signed-in accounts can write overrides", async () => {
  const store = await seeded();
  assert.deepEqual(await call(store, body(), { userId: "" }), { ok: false, status: 401, code: "UNAUTHORIZED", message: "sign-in required" });
  const other = await call(store, body(), { userId: "someone-else" });
  assert.deepEqual([other.ok, !other.ok && other.status], [false, 403]);
  const unset = await call(store, body(), { allowedUserIds: undefined });
  assert.deepEqual([unset.ok, !unset.ok && unset.status], [false, 500]);
  assert.equal(store.rows.length, 4);
});

test("a log that does not verify is not extended", async () => {
  const store = await seeded();
  const row = store.rows[2]!;
  row.record_json = row.record_json.replace("DOCUMENTATION_HOLD_PENDING_REVIEW", PASS);
  const out = await call(store, body());
  assert.deepEqual([out.ok, !out.ok && out.status, !out.ok && out.code], [false, 500, "CHAIN_INVALID"]);
  assert.equal(store.rows.length, 4);
});

test("losing the race to another writer is retried against the new log; a competing override of the same screening is then refused", async () => {
  const plain = await seeded();
  plain.beforeInsert = async () => {
    // another writer appends an unrelated screening first
    await appendScreening(deps(plain), { userId: USER, allowedUserIds: USER, body: { profile: profile("TV1"), doc_hash: DOC } });
  };
  const retried = await call(plain, body());
  assert.equal(retried.ok && retried.entry.seq, 6);

  const racing = await seeded();
  racing.beforeInsert = async () => {
    const other = await call(racing, body({ override_decision: "ALERT_VERIFICATION_REQUIRED" }));
    assert.equal(other.ok, true);
  };
  const lost = await call(racing, body());
  assert.deepEqual([lost.ok, !lost.ok && lost.status, !lost.ok && lost.message], [false, 409, "ALREADY_OVERRIDDEN"]);
  assert.equal(racing.rows.length, 5);
  assert.equal((await verifyChain(rowsToEntries(racing.rows), verifier)).ok, true);
});

test("the target must exist and must be a screening entry", async () => {
  const store = await seeded();
  assert.equal((await call(store, body())).ok, true); // entry 5 is now an override
  const ov = await call(store, body({ target_seq: 5 }));
  assert.deepEqual([ov.ok, !ov.ok && ov.status, !ov.ok && ov.message], [false, 400, "TARGET_NOT_SCREENING"]);
  const none = await call(store, body({ target_seq: "3" }));
  assert.equal(none.ok, false);
});
