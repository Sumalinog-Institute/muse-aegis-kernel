import { test } from "node:test";
import assert from "node:assert/strict";
import { evaluate } from "./kernel.ts";
import { generateKeyPair, makeSigner, makeVerifier } from "./audit.ts";
import { appendScreening, StoreConflictError } from "./append.ts";
import type { AuditStore, StoreRow } from "./append.ts";
import { loadAll, verifyLog, SIMULATIONS } from "./verify.ts";
import type { AuditReader } from "./verify.ts";

const DOC = "sha256:" + "cd".repeat(32);
const USER = "11111111-2222-3333-4444-555555555555";

class MemStore implements AuditStore, AuditReader {
  rows: StoreRow[] = [];
  async getHead() { const l = this.rows[this.rows.length - 1]; return l ? { seq: l.seq, hash: l.hash } : null; }
  async insert(row: StoreRow) {
    const l = this.rows[this.rows.length - 1];
    if (row.seq !== (l ? l.seq + 1 : 1) || row.prev_hash !== (l ? l.hash : "0".repeat(64))) throw new StoreConflictError("audit: position taken");
    this.rows.push(structuredClone(row));
  }
  async getPage(afterSeq: number, limit: number) { return structuredClone(this.rows.filter((r) => r.seq > afterSeq).slice(0, limit)); }
}

const kp = await generateKeyPair();
const signer = await makeSigner("k1", kp.privateJwk);
const verifier = await makeVerifier({ k1: kp.publicJwk });
const kernel = evaluate as unknown as (p: Record<string, unknown>) => unknown;

async function filled(n: number): Promise<MemStore> {
  const store = new MemStore();
  for (let i = 0; i < n; i++) {
    const body = { profile: { x1: 0.1, x2: i / 10, x4: 0, x5: 0, x6: i % 3 === 0 ? 1 : 0, n_applicable: 40 }, doc_hash: DOC, ledger_id: "TEST" };
    const r = await appendScreening({ store, signer, verifier, evaluate: kernel, now: () => new Date(Date.UTC(2026, 9, 24, 8, 0, i)) }, { userId: USER, allowedUserIds: USER, body });
    assert.equal(r.ok, true);
  }
  return store;
}
const codes = (r: { errors: { code: string }[] }) => new Set(r.errors.map((e) => e.code));

test("a clean log verifies and reports its head and recent entries", async () => {
  const store = await filled(5);
  const r = await verifyLog(store, verifier);
  assert.equal(r.ok, true);
  assert.equal(r.length, 5);
  assert.deepEqual(r.head, { seq: 5, hash: store.rows[4]?.hash });
  assert.equal(r.recent.length, 5);
  const first = r.recent[0];
  assert.equal(first?.kind, "SCREENING");
  assert.equal(first?.ledger_id, "TEST");
  assert.equal(first?.actor_id, USER);
  assert.equal(first?.decision, "RESTRICTION_RECOMMENDED_PENDING_AUTHORITY");
  assert.equal(r.simulated, null);
});

test("an empty log is valid and has no head", async () => {
  const r = await verifyLog(new MemStore(), verifier);
  assert.deepEqual([r.ok, r.length, r.head], [true, 0, null]);
});

test("each simulation is detected, with the expected codes, and never touches the stored log", async () => {
  const store = await filled(5);
  const before = structuredClone(store.rows);
  const expected: Record<string, string[]> = {
    edit: ["HASH_MISMATCH"],
    delete: ["SEQ_MISMATCH", "PREV_HASH_MISMATCH"],
    reorder: ["SEQ_MISMATCH"],
    signature: ["SIGNATURE_INVALID"],
    truncate: ["TRUNCATED"],
  };
  for (const sim of SIMULATIONS) {
    const r = await verifyLog(store, verifier, { simulate: sim });
    assert.equal(r.ok, false, sim);
    assert.equal(r.simulated, sim);
    for (const c of expected[sim] ?? []) assert.ok(codes(r).has(c), `${sim} should report ${c}, got ${[...codes(r)]}`);
    assert.deepEqual(store.rows, before, `${sim} modified the stored log`);
  }
  assert.equal((await verifyLog(store, verifier)).ok, true); // real log still clean afterwards
});

test("simulations need at least two entries", async () => {
  const r = await verifyLog(await filled(1), verifier, { simulate: "edit" });
  assert.equal(r.ok, false);
  assert.ok(codes(r).has("NEED_TWO_ENTRIES"));
  assert.ok(codes(await verifyLog(await filled(2), verifier, { simulate: "delete" })).has("SEQ_MISMATCH"));
});

test("real tampering in storage is detected", async () => {
  const store = await filled(4);
  const row = store.rows[1] as StoreRow;
  row.record_json = row.record_json.replace("TEST", "TESX");
  const r = await verifyLog(store, verifier);
  assert.equal(r.ok, false);
  assert.ok(codes(r).has("HASH_MISMATCH"));
  assert.equal(r.errors.find((e) => e.code === "HASH_MISMATCH")?.seq, 2);
});

test("deleting the tail is invisible alone and detected with a saved checkpoint", async () => {
  const store = await filled(5);
  const head = { seq: 5, hash: store.rows[4]?.hash as string };
  store.rows.pop();
  assert.equal((await verifyLog(store, verifier)).ok, true); // the honest limit
  const r = await verifyLog(store, verifier, { expectedHead: head });
  assert.equal(r.ok, false);
  assert.ok(codes(r).has("TRUNCATED"));
  const empty = await verifyLog(new MemStore(), verifier, { expectedHead: head });
  assert.ok(codes(empty).has("TRUNCATED"));
});

test("a checkpoint that matches the real head passes; a different hash at that position fails", async () => {
  const store = await filled(3);
  assert.equal((await verifyLog(store, verifier, { expectedHead: { seq: 3, hash: store.rows[2]?.hash as string } })).ok, true);
  assert.equal((await verifyLog(store, verifier, { expectedHead: { seq: 3, hash: "f".repeat(64) } })).ok, false);
  assert.equal((await verifyLog(store, verifier, { expectedHead: { seq: 2, hash: store.rows[1]?.hash as string } })).ok, true);
});

test("malformed checkpoints and simulation names are rejected", async () => {
  const store = await filled(2);
  for (const h of [{ seq: 0, hash: "a".repeat(64) }, { seq: 1.5, hash: "a".repeat(64) }, { seq: 1, hash: "xyz" }, { seq: 1, hash: "A".repeat(64) }]) {
    assert.ok(codes(await verifyLog(store, verifier, { expectedHead: h })).has("BAD_CHECKPOINT"));
  }
  const bad = await verifyLog(store, verifier, { simulate: "explode" as never });
  assert.ok(codes(bad).has("BAD_SIMULATION"));
});

test("a non-canonical or unreadable stored row is reported with its position", async () => {
  const store = await filled(3);
  (store.rows[1] as StoreRow).record_json = " " + (store.rows[1] as StoreRow).record_json;
  const r = await verifyLog(store, verifier);
  assert.equal(r.ok, false);
  assert.deepEqual(r.errors.map((e) => [e.seq, e.code]), [[2, "UNREADABLE_ROW"]]);
});

test("entries signed with an untrusted key are flagged", async () => {
  const store = await filled(3);
  const only = await makeVerifier({ other: kp.publicJwk });
  const r = await verifyLog(store, only);
  assert.ok(codes(r).has("UNKNOWN_KEY"));
});

test("paging loads every row in order, however small the pages", async () => {
  const store = await filled(7);
  for (const pageSize of [1, 2, 3, 7, 8, 500]) {
    const { rows } = await loadAll(store, { pageSize });
    assert.deepEqual(rows.map((r) => r.seq), [1, 2, 3, 4, 5, 6, 7], `pageSize ${pageSize}`);
  }
});

test("a server that returns fewer rows than requested does not cause a silent partial load", async () => {
  const store = await filled(7);
  const capped: AuditReader = { getPage: async (after, limit) => store.getPage(after, Math.min(limit, 3)) };
  const { rows } = await loadAll(capped, { pageSize: 500 });
  assert.deepEqual(rows.map((r) => r.seq), [1, 2, 3, 4, 5, 6, 7]);
  const r = await verifyLog(capped, verifier);
  assert.equal(r.ok, true);
  assert.equal(r.length, 7);
  assert.deepEqual(r.head, { seq: 7, hash: store.rows[6]?.hash });
});

test("a reader that does not advance, or an oversized log, ends safely", async () => {
  const stuck: AuditReader = { getPage: async () => [{ seq: 1, prev_hash: "", record_json: "{}", hash: "", key_id: "", signature: "" }] };
  assert.equal((await loadAll(stuck, { pageSize: 1 })).stalled, true);
  const big = await loadAll(await filled(5), { pageSize: 2, maxEntries: 4 });
  assert.equal(big.tooMany, true);
  const oversized = await verifyLog({ getPage: (await filled(5)).getPage.bind(await filled(5)) }, verifier);
  assert.equal(oversized.ok, true); // under the default limit, so normal
});

test("the report never includes signatures or key material", async () => {
  const store = await filled(3);
  const text = JSON.stringify(await verifyLog(store, verifier, { simulate: "edit" }));
  for (const r of store.rows) assert.equal(text.includes(r.signature), false);
  assert.equal(text.includes(String(kp.privateJwk.d)), false);
});
