import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { evaluate } from "./kernel.ts";
import { checkScreeningFields, effectiveDecision, generateKeyPair, LEGACY_MAX_SEQ, makeSigner, makeVerifier, validateRejection, validateScreeningFields, verifyChain } from "./audit.ts";
import type { Entry } from "./audit.ts";
import { appendOverride, appendRecord, appendScreening, approveOverride, PENDING_MAX_AGE_MS, rejectOverride, requestOverride, rowsToEntries, StoreConflictError } from "./append.ts";
import type { AppendDeps, OverrideStore, PendingRequest, PendingStatus, PendingStore, StoreRow } from "./append.ts";

const REVIEWER = "11111111-2222-3333-4444-555555555555";
const APPROVER = "99999999-8888-7777-6666-000000000000";
const ALLOWED = `${REVIEWER},${APPROVER}`;
const DOC = "sha256:" + "ab".repeat(32);
const PASS = "SCREENING_PASS_PENDING_STANDARD_CONTROLS";
const REFS = { project_id: "FP127", doc_ref: "gcf:FP127:funding-proposal" };
const vectors: { id: string; input: Record<string, unknown> }[] = JSON.parse(readFileSync(new URL("../spec/vectors.json", import.meta.url), "utf8"));
const profile = (id: string) => vectors.find((v) => v.id === id)!.input;

class MemStore implements OverrideStore {
  rows: StoreRow[] = [];
  async getHead() { const l = this.rows[this.rows.length - 1]; return l ? { seq: l.seq, hash: l.hash } : null; }
  async readAll() { return structuredClone(this.rows); }
  async insert(row: StoreRow) {
    const last = this.rows[this.rows.length - 1];
    if (row.seq !== (last ? last.seq + 1 : 1) || row.prev_hash !== (last ? last.hash : "0".repeat(64))) throw new StoreConflictError("audit: position taken");
    this.rows.push(structuredClone(row));
  }
}
class MemPending implements PendingStore {
  m = new Map<string, PendingRequest>();
  async create(r: PendingRequest) { this.m.set(r.id, structuredClone(r)); }
  async get(id: string) { const r = this.m.get(id); return r ? structuredClone(r) : null; }
  async setStatus(id: string, from: PendingStatus, to: PendingStatus) {
    const r = this.m.get(id);
    if (!r || r.status !== from) return false;
    r.status = to;
    return true;
  }
}

const kp = await generateKeyPair();
const signer = await makeSigner("k1", kp.privateJwk);
const verifier = await makeVerifier({ k1: kp.publicJwk });
let clock = Date.UTC(2026, 10, 13, 1, 0, 0);
let idn = 0;
const mk = (store: MemStore, pending: MemPending) => ({
  store, pending, signer, verifier, evaluate: evaluate as unknown as AppendDeps["evaluate"], now: () => new Date(clock++), newId: () => `REQ-${++idn}`,
});

// Log: seq 1 TV1 (pass), 2 TV2 (T1 restriction), 3 TV5 (documentation hold).
async function seeded() {
  const store = new MemStore();
  const pending = new MemPending();
  for (const id of ["TV1", "TV2", "TV5"]) {
    const out = await appendScreening(mk(store, pending), { userId: REVIEWER, allowedUserIds: ALLOWED, body: { profile: profile(id), doc_hash: DOC, ...REFS } });
    assert.equal(out.ok, true);
  }
  return { store, pending };
}
const EV = ["watch:W-1001", "doc:sha256:" + "cd".repeat(32)];
const reqBody = (over: Record<string, unknown> = {}) => ({
  target_seq: 2, override_decision: PASS, justification_code: "FALSE_MATCH_CONFIRMED", authority_basis: "COMPLIANCE_OFFICER",
  consulted_evidence_ids: EV, note: "Registration number differs from the listed entity.", ...over,
});
const asReviewer = { userId: REVIEWER, allowedUserIds: ALLOWED };
const asApprover = { userId: APPROVER, allowedUserIds: ALLOWED };

// ---------------------------------------------------------------- project_id and doc_ref (vectors 1 to 7)

test("a screening written with project_id and doc_ref is accepted and appears in the signed record", async () => {
  const { store } = await seeded();
  const rec = rowsToEntries(store.rows)[0]!.record;
  assert.equal(rec["project_id"], "FP127");
  assert.equal(rec["doc_ref"], "gcf:FP127:funding-proposal");
});

test("new screenings without, or with bad, project_id or doc_ref are refused", async () => {
  const store = new MemStore();
  const pending = new MemPending();
  const base = { profile: profile("TV1"), doc_hash: DOC };
  const bads: Record<string, unknown>[] = [
    base, { ...base, project_id: "FP127" }, { ...base, doc_ref: "gcf:FP127:funding-proposal" },
    { ...base, project_id: "FP127", doc_ref: "gcf:FP999:funding-proposal" },
    { ...base, project_id: "FP 127", doc_ref: "gcf:FP127:funding-proposal" },
    { ...base, project_id: "x".repeat(65), doc_ref: "gcf:FP127:funding-proposal" },
    { ...base, project_id: "FP127", doc_ref: "gcf:FP127" },
    { ...base, project_id: "FP127", doc_ref: "gcf:FP127:" + "x".repeat(130) },
    { ...base, project_id: "123456789", doc_ref: "gcf:123456789:funding-proposal" },
    { ...base, project_id: 5, doc_ref: "gcf:5:x" },
  ];
  for (const body of bads) {
    const out = await appendScreening(mk(store, pending), { ...asReviewer, body });
    assert.equal(out.ok, false, JSON.stringify(body));
    assert.equal(!out.ok && out.status, 400);
  }
  assert.equal(store.rows.length, 0);
});

test("validateScreeningFields: problem codes, and the legacy exemption for seq 1 to LEGACY_MAX_SEQ only", () => {
  assert.deepEqual(validateScreeningFields({}, LEGACY_MAX_SEQ), []);
  assert.deepEqual(validateScreeningFields({}, LEGACY_MAX_SEQ + 1), ["MISSING_PROJECT_ID", "MISSING_DOC_REF"]);
  assert.deepEqual(validateScreeningFields({ project_id: "FP1" }, LEGACY_MAX_SEQ + 1), ["MISSING_DOC_REF"]);
  assert.deepEqual(validateScreeningFields({ project_id: "FP1", doc_ref: "gcf:FP2:x" }, 9), ["DOC_REF_PROJECT_MISMATCH"]);
  assert.deepEqual(validateScreeningFields({ project_id: "FP 1", doc_ref: "gcf:FP1:x" }, 9), ["BAD_PROJECT_ID"]);
  assert.deepEqual(validateScreeningFields({ project_id: "FP1", doc_ref: "gcf:FP1" }, 9), ["BAD_DOC_REF"]);
  assert.deepEqual(validateScreeningFields({ project_id: "123456789", doc_ref: "gcf:123456789:x" }, 9), ["FIELD_PERSONAL_DATA"]);
  assert.deepEqual(validateScreeningFields({ project_id: "FP127", doc_ref: "iati:FP127:feed:XM-DAC-1-2-3" }, 9), []);
  // a legacy entry that does carry the fields must still carry valid ones
  assert.deepEqual(validateScreeningFields({ project_id: "bad id" }, 1), ["BAD_PROJECT_ID"]);
});

test("checkScreeningFields accepts legacy entries without the fields and finds later entries that lack them; verifyChain is unaffected", async () => {
  const chain: Entry[] = [];
  let prev = "0".repeat(64);
  const { nextEntry } = await import("./audit.ts");
  for (let i = 1; i <= LEGACY_MAX_SEQ + 2; i++) {
    const rec: Record<string, unknown> = { kind: "SCREENING", result: { decision: PASS, psi: 0 } };
    if (i === LEGACY_MAX_SEQ + 1) Object.assign(rec, REFS);
    const e = await nextEntry(chain, rec, signer);
    chain.push(e);
    prev = e.hash;
  }
  assert.equal(prev.length, 64);
  assert.deepEqual(checkScreeningFields(chain), [{ seq: LEGACY_MAX_SEQ + 2, code: "MISSING_PROJECT_ID" }, { seq: LEGACY_MAX_SEQ + 2, code: "MISSING_DOC_REF" }]);
  assert.equal((await verifyChain(chain, verifier)).ok, true);
});

test("appendRecord (reviewed drafts) also requires valid project_id and doc_ref", async () => {
  const store = new MemStore();
  const pending = new MemPending();
  const rec = { kind: "SCREENING", doc_hash: DOC, result: { decision: PASS, psi: 0 }, actor_id: REVIEWER, timestamp: "2026-11-13T01:00:00Z", extractor_version: "x", ledger_id: "L", policy_version: "4.1" };
  assert.equal((await appendRecord(mk(store, pending), asReviewer, rec)).ok, false);
  assert.equal((await appendRecord(mk(store, pending), asReviewer, { ...rec, ...REFS })).ok, true);
});

// ---------------------------------------------------------------- rejections (vector 8)

const chainFor = async () => rowsToEntries((await seeded()).store.rows);
const rej = (over: Record<string, unknown> = {}) => ({
  kind: "REJECTION", target_seq: 2, rejected_decision: PASS, reason_code: "EVIDENCE_INSUFFICIENT", note: "The cited document does not show the claimed change.",
  reviewer_id: REVIEWER, approver_id: APPROVER, policy_version: "4.1", timestamp: "2026-11-13T01:00:00Z", ...over,
});

test("validateRejection: a valid record passes; each rule has its own problem code", async () => {
  const chain = await chainFor();
  assert.deepEqual(validateRejection(chain, rej()), []);
  assert.deepEqual(validateRejection(chain, rej({ approver_id: REVIEWER })), ["APPROVER_SAME_AS_REVIEWER"]);
  assert.deepEqual(validateRejection(chain, rej({ reason_code: "BECAUSE" })), ["BAD_REASON_CODE"]);
  assert.deepEqual(validateRejection(chain, rej({ extra: 1 })), ["UNKNOWN_FIELD:extra"]);
  assert.deepEqual(validateRejection(chain, rej({ note: "mail a@b.org" })), ["NOTE_PERSONAL_DATA"]);
  assert.deepEqual(validateRejection(chain, rej({ target_seq: 99 })), ["TARGET_NOT_FOUND"]);
  assert.deepEqual(validateRejection(chain, rej({ rejected_decision: "MADE_UP" })), ["BAD_DECISION"]);
  assert.deepEqual(validateRejection(chain, rej({ rejected_decision: "RESTRICTION_RECOMMENDED_PENDING_AUTHORITY" })), ["NO_CHANGE"]);
});

test("a REJECTION may not target an OVERRIDE or a missing entry, and does not change the decision in force", async () => {
  const { store, pending } = await seeded();
  const d = mk(store, pending);
  assert.equal((await appendOverride(d, { ...asReviewer, body: { ...reqBody({ target_seq: 3 }), consulted_evidence_ids: EV } })).ok, true); // seq 4, an override
  const chain = rowsToEntries(store.rows);
  assert.deepEqual(validateRejection(chain, rej({ target_seq: 4 })), ["TARGET_NOT_SCREENING"]);
  assert.equal(effectiveDecision(chain, 2).overridden, false);
});

// ---------------------------------------------------------------- second approver (vector 11), expiry, races

test("a T1 override is refused on the direct route, accepted through request and approval, and approver_id is set by the server", async () => {
  const { store, pending } = await seeded();
  const d = mk(store, pending);
  const direct = await appendOverride(d, { ...asReviewer, body: reqBody() });
  assert.equal(direct.ok, false);
  assert.match(!direct.ok ? direct.message : "", /SECOND_APPROVER_REQUIRED/);
  const asked = await requestOverride(d, { ...asReviewer, body: reqBody() });
  assert.equal(asked.ok, true);
  assert.equal(store.rows.length, 3, "a request writes nothing to the signed log");
  const id = asked.ok ? asked.request_id : "";
  const done = await approveOverride(d, { ...asApprover, requestId: id });
  assert.equal(done.ok, true);
  const entries = rowsToEntries(store.rows);
  assert.equal((await verifyChain(entries, verifier)).ok, true);
  const rec = entries[3]!.record;
  assert.equal(rec["kind"], "OVERRIDE");
  assert.equal(rec["reviewer_id"], REVIEWER);
  assert.equal(rec["approver_id"], APPROVER);
  assert.deepEqual(effectiveDecision(entries, 2), { decision: PASS, overridden: true, override_seq: 4 });
  assert.equal((await pending.get(id))!.status, "APPROVED");
});

test("the requester cannot approve or reject their own request; the request stays open", async () => {
  const { store, pending } = await seeded();
  const d = mk(store, pending);
  const asked = await requestOverride(d, { ...asReviewer, body: reqBody() });
  const id = asked.ok ? asked.request_id : "";
  const a = await approveOverride(d, { ...asReviewer, requestId: id });
  assert.deepEqual([a.ok, !a.ok && a.status, !a.ok && a.code], [false, 403, "APPROVER_SAME_AS_REVIEWER"]);
  const r = await rejectOverride(d, { ...asReviewer, requestId: id, reasonCode: "OTHER", note: "x" });
  assert.equal(r.ok, false);
  assert.equal((await pending.get(id))!.status, "PENDING");
  assert.equal(store.rows.length, 3);
});

test("requests that need no approver, or are invalid, are not queued", async () => {
  const { store, pending } = await seeded();
  const d = mk(store, pending);
  const a = await requestOverride(d, { ...asReviewer, body: reqBody({ target_seq: 3 }) });
  assert.deepEqual([a.ok, !a.ok && a.code], [false, "NO_APPROVER_NEEDED"]);
  const b = await requestOverride(d, { ...asReviewer, body: reqBody({ consulted_evidence_ids: [] }) });
  assert.equal(b.ok, false);
  assert.equal(pending.m.size, 0);
});

test("only allow-listed accounts can approve", async () => {
  const { store, pending } = await seeded();
  const d = mk(store, pending);
  const asked = await requestOverride(d, { ...asReviewer, body: reqBody() });
  const out = await approveOverride(d, { userId: "stranger", allowedUserIds: ALLOWED, requestId: asked.ok ? asked.request_id : "" });
  assert.deepEqual([out.ok, !out.ok && out.status], [false, 403]);
});

test("a request older than 14 days expires and cannot be approved", async () => {
  const { store, pending } = await seeded();
  const d = mk(store, pending);
  const asked = await requestOverride(d, { ...asReviewer, body: reqBody() });
  const id = asked.ok ? asked.request_id : "";
  clock += PENDING_MAX_AGE_MS + 1000;
  const out = await approveOverride(d, { ...asApprover, requestId: id });
  assert.deepEqual([out.ok, !out.ok && out.status, !out.ok && out.code], [false, 410, "REQUEST_EXPIRED"]);
  assert.equal((await pending.get(id))!.status, "EXPIRED");
  assert.equal(store.rows.length, 3);
});

test("rejection: written to the signed log, the request closes, and a new request is then possible; after an override a second is still refused", async () => {
  const { store, pending } = await seeded();
  const d = mk(store, pending);
  const id1 = (await requestOverride(d, { ...asReviewer, body: reqBody() }) as { request_id: string }).request_id;
  const bad = await rejectOverride(d, { ...asApprover, requestId: id1, reasonCode: "BECAUSE", note: "x" });
  assert.equal(bad.ok, false);
  assert.equal((await pending.get(id1))!.status, "PENDING", "a refused rejection reopens the request");
  const out = await rejectOverride(d, { ...asApprover, requestId: id1, reasonCode: "EVIDENCE_INSUFFICIENT", note: "The cited document does not show the claimed change." });
  assert.equal(out.ok, true);
  const entries = rowsToEntries(store.rows);
  assert.equal((await verifyChain(entries, verifier)).ok, true);
  const rec = entries[3]!.record;
  assert.equal(rec["kind"], "REJECTION");
  assert.equal(rec["reviewer_id"], REVIEWER);
  assert.equal(rec["approver_id"], APPROVER);
  assert.equal(rec["rejected_decision"], PASS);
  assert.equal(effectiveDecision(entries, 2).overridden, false);
  assert.equal((await pending.get(id1))!.status, "REJECTED");
  // closed requests cannot be acted on again
  const again = await approveOverride(d, { ...asApprover, requestId: id1 });
  assert.deepEqual([again.ok, !again.ok && again.status], [false, 409]);
  // a new request is possible, and once approved a second override of the same screening is refused
  const id2 = (await requestOverride(d, { ...asReviewer, body: reqBody() }) as { request_id: string }).request_id;
  assert.equal((await approveOverride(d, { ...asApprover, requestId: id2 })).ok, true);
  const third = await requestOverride(d, { ...asReviewer, body: reqBody({ override_decision: "ALERT_VERIFICATION_REQUIRED" }) });
  assert.equal(third.ok, false);
});

test("two approvers cannot both act on one request", async () => {
  const { store, pending } = await seeded();
  const d = mk(store, pending);
  const id = (await requestOverride(d, { ...asReviewer, body: reqBody() }) as { request_id: string }).request_id;
  const a = await approveOverride(d, { ...asApprover, requestId: id });
  const b = await rejectOverride(d, { userId: "third", allowedUserIds: `${ALLOWED},third`, requestId: id, reasonCode: "OTHER", note: "late" });
  assert.equal(a.ok, true);
  assert.deepEqual([b.ok, !b.ok && b.status], [false, 409]);
  assert.equal(store.rows.length, 4);
});

test("a log that does not verify is not extended by an approval, and the request is reopened", async () => {
  const { store, pending } = await seeded();
  const d = mk(store, pending);
  const id = (await requestOverride(d, { ...asReviewer, body: reqBody() }) as { request_id: string }).request_id;
  const row = store.rows[0]!;
  store.rows[0] = { ...row, record_json: row.record_json.replace("FP127", "FP128") };
  const out = await approveOverride(d, { ...asApprover, requestId: id });
  assert.deepEqual([out.ok, !out.ok && out.code], [false, "CHAIN_INVALID"]);
  assert.equal((await pending.get(id))!.status, "PENDING");
});
