import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { evaluate } from "./kernel.ts";
import { canonicalize } from "./jcs.ts";
import { generateKeyPair, makeSigner, makeVerifier, verifyChain } from "./audit.ts";
import type { Signer } from "./audit.ts";
import { TRUSTED_KEYS } from "./trusted-keys.ts";
import { appendScreening, createSignerFromConfig, rowsToEntries, StoreConflictError } from "./append.ts";
import type { AppendDeps, AuditStore, StoreRow } from "./append.ts";

const DOC = "sha256:" + "ab".repeat(32);
const USER = "11111111-2222-3333-4444-555555555555";
const goodBody = () => ({ profile: { x1: 0.012, x2: 0, x3: 0.05, x4: 0.02, x5: 0, x6: 1, n_applicable: 40, alert_status: "NONE" }, doc_hash: DOC });

// In-memory store that applies the same rules as the database triggers.
class MemStore implements AuditStore {
  rows: StoreRow[] = [];
  failNext = 0; // number of upcoming inserts to reject as conflicts
  breakWith: Error | null = null;
  async getHead() {
    const last = this.rows[this.rows.length - 1];
    return last ? { seq: last.seq, hash: last.hash } : null;
  }
  async insert(row: StoreRow) {
    if (this.breakWith) throw this.breakWith;
    if (this.failNext > 0) { this.failNext--; throw new StoreConflictError("audit: simulated conflict"); }
    const last = this.rows[this.rows.length - 1];
    const wantSeq = last ? last.seq + 1 : 1;
    const wantPrev = last ? last.hash : "0".repeat(64);
    if (row.seq !== wantSeq || row.prev_hash !== wantPrev) throw new StoreConflictError("audit: position taken");
    this.rows.push(structuredClone(row));
  }
}

const kp = await generateKeyPair();
const signer = await makeSigner("k1", kp.privateJwk);
const verifier = await makeVerifier({ k1: kp.publicJwk });
const kernel = evaluate as unknown as (p: Record<string, unknown>) => unknown;
let tick = 0;
const deps = (store: MemStore, over: Partial<AppendDeps> = {}): AppendDeps => ({
  store, signer, verifier, evaluate: kernel, now: () => new Date(Date.UTC(2026, 9, 23, 12, 0, tick++)), ...over,
});
const req = (body: unknown, over: Record<string, unknown> = {}) => ({ userId: USER, allowedUserIds: USER, body, ...over }) as { userId: string; allowedUserIds: string | undefined; body: unknown };

test("happy path: entries are chained, signed, canonical, and verify", async () => {
  const store = new MemStore();
  const a = await appendScreening(deps(store), req(goodBody()));
  const b = await appendScreening(deps(store), req({ ...goodBody(), ledger_id: "ledger-1" }));
  assert.equal(a.ok && a.entry.seq, 1);
  assert.equal(b.ok && b.entry.seq, 2);
  assert.equal(a.ok && a.entry.decision, "RESTRICTION_RECOMMENDED_PENDING_AUTHORITY");
  assert.equal(store.rows[1]?.prev_hash, store.rows[0]?.hash);
  const entries = rowsToEntries(store.rows);
  assert.equal((await verifyChain(entries, verifier)).ok, true);
  const rec = entries[0]?.record as Record<string, unknown>;
  assert.equal(rec["actor_id"], USER);
  assert.equal(rec["policy_version"], "4.1");
  assert.equal(rec["extractor_version"], "manual-entry");
  assert.equal(rec["doc_hash"], DOC);
  assert.match(String(rec["timestamp"]), /^2026-10-23T12:00:0\d\.000Z$/);
});

test("the kernel's output in the log equals running the kernel directly", async () => {
  const store = new MemStore();
  await appendScreening(deps(store), req(goodBody()));
  const rec = JSON.parse(store.rows[0]?.record_json ?? "{}");
  assert.deepEqual(rec.result, JSON.parse(JSON.stringify(evaluate(goodBody().profile))));
});

test("an account that is not on the allow-list cannot write", async () => {
  const store = new MemStore();
  const r = await appendScreening(deps(store), req(goodBody(), { allowedUserIds: "someone-else, another" }));
  assert.deepEqual([r.ok, !r.ok && r.status, !r.ok && r.code], [false, 403, "FORBIDDEN"]);
  assert.equal(store.rows.length, 0);
});

test("fails closed when the allow-list is not configured", async () => {
  for (const unset of [undefined, "", "  , "]) {
    const store = new MemStore();
    const r = await appendScreening(deps(store), req(goodBody(), { allowedUserIds: unset }));
    assert.deepEqual([r.ok, !r.ok && r.status], [false, 500]);
    assert.equal(store.rows.length, 0);
  }
});

test("a missing or malformed user id is unauthorized", async () => {
  const store = new MemStore();
  for (const uid of ["", "x".repeat(101)]) {
    const r = await appendScreening(deps(store), req(goodBody(), { userId: uid }));
    assert.deepEqual([r.ok, !r.ok && r.status], [false, 401]);
  }
  assert.equal(store.rows.length, 0);
});

test("bad requests are rejected and nothing is stored", async () => {
  const store = new MemStore();
  const bad: unknown[] = [
    null, [], "text", 5,
    { ...goodBody(), extra: 1 },
    { ...goodBody(), doc_hash: "sha256:xyz" },
    { ...goodBody(), doc_hash: undefined },
    { ...goodBody(), ledger_id: "" },
    { ...goodBody(), extractor_version: "x".repeat(101) },
    { ...goodBody(), profile: null },
    { ...goodBody(), profile: [] },
    { ...goodBody(), profile: { x1: 0, bogus: 1 } },
    { ...goodBody(), profile: { x1: true } },
    { ...goodBody(), profile: { x1: { a: 1 } } },
    { ...goodBody(), profile: { x1: [1] } },
    { ...goodBody(), profile: { x1: "x".repeat(51) } },
    { ...goodBody(), profile: JSON.parse('{"x1": 1e999}') },
  ];
  for (const b of bad) {
    const r = await appendScreening(deps(store), req(b));
    assert.deepEqual([r.ok, !r.ok && r.status, !r.ok && r.code], [false, 400, "BAD_REQUEST"], JSON.stringify(b)?.slice(0, 80));
  }
  assert.equal(store.rows.length, 0);
});

test("an incomplete profile is still recorded, as an incomplete-input decision", async () => {
  const store = new MemStore();
  const r = await appendScreening(deps(store), req({ profile: { x1: 0, x2: "INCOMPLETE", x4: 0, x5: 0, x6: 0, n_applicable: 40 }, doc_hash: DOC }));
  assert.equal(r.ok && r.entry.decision, "INCOMPLETE_INPUT_MANUAL_REVIEW");
  assert.equal(store.rows.length, 1);
});

test("a lost race is retried against the new head", async () => {
  const store = new MemStore();
  store.failNext = 1;
  const r = await appendScreening(deps(store), req(goodBody()));
  assert.equal(r.ok && r.entry.seq, 1);
  assert.equal(store.rows.length, 1);
});

test("gives up with a busy error after repeated conflicts and stores nothing", async () => {
  const store = new MemStore();
  store.failNext = 99;
  const r = await appendScreening(deps(store), req(goodBody()));
  assert.deepEqual([r.ok, !r.ok && r.status, !r.ok && r.code], [false, 503, "CONFLICT"]);
  assert.equal(store.rows.length, 0);
});

test("concurrent appends both succeed with distinct, consecutive positions", async () => {
  const store = new MemStore();
  const results = await Promise.all([1, 2, 3].map(() => appendScreening(deps(store), req(goodBody()))));
  assert.equal(results.every((r) => r.ok), true);
  assert.deepEqual(store.rows.map((r) => r.seq), [1, 2, 3]);
  assert.equal((await verifyChain(rowsToEntries(store.rows), verifier)).ok, true);
});

test("storage errors do not leak details", async () => {
  const store = new MemStore();
  store.breakWith = new Error("connection string postgres://secret@host");
  const r = await appendScreening(deps(store), req(goodBody()));
  assert.deepEqual([r.ok, !r.ok && r.status, !r.ok && r.code], [false, 500, "STORE_ERROR"]);
  assert.equal(JSON.stringify(r).includes("secret"), false);
});

test("an entry that does not verify under the trusted key is never written", async () => {
  const store = new MemStore();
  const evil: Signer = { keyId: "k1", sign: async () => "AAAA" };
  const r = await appendScreening(deps(store, { signer: evil }), req(goodBody()));
  assert.deepEqual([r.ok, !r.ok && r.status, !r.ok && r.code], [false, 500, "SIGNING_FAILED"]);
  assert.equal(store.rows.length, 0);
  const other = await generateKeyPair();
  const wrongSigner = await makeSigner("k1", other.privateJwk); // right id, wrong key
  const r2 = await appendScreening(deps(store, { signer: wrongSigner }), req(goodBody()));
  assert.equal(!r2.ok && r2.code, "SIGNING_FAILED");
  assert.equal(store.rows.length, 0);
});

test("a stored row that was altered is caught on read-back", async () => {
  const store = new MemStore();
  await appendScreening(deps(store), req(goodBody()));
  await appendScreening(deps(store), req(goodBody()));
  const edited = structuredClone(store.rows);
  const first = edited[0] as StoreRow;
  first.record_json = first.record_json.replace("RESTRICTION_RECOMMENDED_PENDING_AUTHORITY", "SCREENING_PASS_PENDING_STANDARD_CONTROLS");
  assert.equal((await verifyChain(rowsToEntries(edited), verifier)).ok, false);
  const nonCanonical = structuredClone(store.rows);
  (nonCanonical[0] as StoreRow).record_json = " " + (nonCanonical[0] as StoreRow).record_json;
  assert.throws(() => rowsToEntries(nonCanonical), /NON_CANONICAL_RECORD/);
});

test("stored text is exactly the canonical form", async () => {
  const store = new MemStore();
  await appendScreening(deps(store), req(goodBody()));
  const text = store.rows[0]?.record_json ?? "";
  assert.equal(canonicalize(JSON.parse(text)), text);
});

// ---------------------------------------------------------------- signer configuration

const trusted = { "aegis-test": kp.publicJwk };
const privJson = JSON.stringify(kp.privateJwk);

test("signer config: accepts the matching private key", async () => {
  const s = await createSignerFromConfig({ privateJwkJson: privJson, keyId: "aegis-test", trusted });
  assert.equal(s.keyId, "aegis-test");
});

test("signer config: refuses unset, malformed, public-only, mismatched and untrusted keys, without leaking the key", async () => {
  const other = await generateKeyPair();
  const cases: [string, Parameters<typeof createSignerFromConfig>[0]][] = [
    ["unset key", { privateJwkJson: undefined, keyId: "aegis-test", trusted }],
    ["unset id", { privateJwkJson: privJson, keyId: undefined, trusted }],
    ["not json", { privateJwkJson: "not json {", keyId: "aegis-test", trusted }],
    ["public only", { privateJwkJson: JSON.stringify(kp.publicJwk), keyId: "aegis-test", trusted }],
    ["different key", { privateJwkJson: JSON.stringify(other.privateJwk), keyId: "aegis-test", trusted }],
    ["id not trusted", { privateJwkJson: privJson, keyId: "unknown-id", trusted }],
  ];
  for (const [label, cfg] of cases) {
    await assert.rejects(() => createSignerFromConfig(cfg), (e: Error) => {
      assert.match(e.message, /^SERVER_MISCONFIGURED/, label);
      assert.equal(e.message.includes(String(kp.privateJwk.d)), false, label + ": leaked private key");
      return true;
    });
  }
});

test("the real trusted-keys list matches spec/trusted-keys.json", () => {
  const spec = JSON.parse(readFileSync(new URL("../spec/trusted-keys.json", import.meta.url), "utf8"));
  const fromSpec = Object.fromEntries(spec.keys.map((k: { key_id: string; public_jwk: unknown }) => [k.key_id, k.public_jwk]));
  assert.deepEqual(TRUSTED_KEYS, fromSpec);
});
