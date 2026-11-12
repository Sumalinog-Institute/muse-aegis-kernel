// MUSE Aegis: appending a screening result to the audit log (Phase 2, step 3).
// Pure logic with injected dependencies (store, signer, verifier, kernel, clock), so it can be tested
// without a database and reused unchanged on any server. It never reads environment variables and
// never logs; the calling route supplies secrets and maps outcomes to HTTP responses.
//
// Order of work for one request: check the caller is allowed, validate the request, score it with the
// kernel, build the record, sign it, VERIFY the signature against the trusted public key, and only then
// write it. A write that loses a race with another writer is retried against the new head.

import { canonicalize } from "./jcs.ts";
import { LEGACY_MAX_SEQ, makeSigner, nextEntry, validateOverride, validateRejection, validateScreeningFields, verifyChain } from "./audit.ts";
import type { Entry, Signer, Verifier } from "./audit.ts";

export const POLICY_VERSION = "4.1";
const MAX_ATTEMPTS = 3;
const MAX_RECORD_JSON_CHARS = 20000;
const PROFILE_KEYS = ["x1", "x2", "x3", "x4", "x5", "x6", "n_applicable", "alert_status"] as const;
const BODY_KEYS = ["profile", "doc_hash", "project_id", "doc_ref", "ledger_id", "extractor_version"];
const DOC_HASH = /^sha256:[0-9a-f]{64}$/;

// ---------------------------------------------------------------- store contract

export interface StoreRow {
  seq: number;
  prev_hash: string;
  record_json: string;
  hash: string;
  key_id: string;
  signature: string;
}

export interface AuditStore {
  /** The latest entry's position and hash, or null when the log is empty. */
  getHead(): Promise<{ seq: number; hash: string } | null>;
  /** Writes one row. Must throw StoreConflictError when another writer got there first
   *  (duplicate seq, or the database's own "audit:" rule rejecting the position). */
  insert(row: StoreRow): Promise<void>;
}

export class StoreConflictError extends Error {}

export interface AppendDeps {
  store: AuditStore;
  signer: Signer;
  verifier: Verifier;
  /** The scoring kernel's evaluate function. */
  evaluate: (profile: Record<string, unknown>) => unknown;
  now: () => Date;
}

export type AppendOutcome =
  | { ok: true; entry: { seq: number; hash: string; key_id: string; decision: unknown; psi: unknown; timestamp: string } }
  | { ok: false; status: number; code: string; message: string };

function fail(status: number, code: string, message: string): AppendOutcome {
  return { ok: false, status, code, message };
}

// ---------------------------------------------------------------- configuration helpers

/** Builds the signer from server configuration, refusing to run unless the key matches the trusted list. */
export async function createSignerFromConfig(cfg: {
  privateJwkJson: string | undefined;
  keyId: string | undefined;
  trusted: Record<string, JsonWebKey>;
}): Promise<Signer> {
  if (!cfg.privateJwkJson) throw new Error("SERVER_MISCONFIGURED: signing key is not set");
  if (!cfg.keyId) throw new Error("SERVER_MISCONFIGURED: key id is not set");
  let jwk: JsonWebKey;
  try {
    jwk = JSON.parse(cfg.privateJwkJson) as JsonWebKey;
  } catch {
    throw new Error("SERVER_MISCONFIGURED: signing key is not valid JSON");
  }
  const trusted = cfg.trusted[cfg.keyId];
  if (!trusted) throw new Error("SERVER_MISCONFIGURED: key id is not in the trusted list");
  if (jwk.kty !== "EC" || jwk.crv !== "P-256" || typeof jwk.d !== "string") {
    throw new Error("SERVER_MISCONFIGURED: signing key must be a private P-256 key");
  }
  if (jwk.x !== trusted.x || jwk.y !== trusted.y) {
    throw new Error("SERVER_MISCONFIGURED: signing key does not match the trusted public key");
  }
  try {
    return await makeSigner(cfg.keyId, jwk);
  } catch {
    throw new Error("SERVER_MISCONFIGURED: signing key could not be loaded");
  }
}

function isAllowed(userId: string, allowedCsv: string | undefined): boolean | "unset" {
  if (allowedCsv === undefined) return "unset";
  const list = allowedCsv.split(",").map((s) => s.trim()).filter((s) => s !== "");
  if (list.length === 0) return "unset";
  return list.includes(userId);
}

// ---------------------------------------------------------------- request validation

function validateBody(body: unknown):
  | { ok: true; profile: Record<string, unknown>; docHash: string; projectId: string; docRef: string; ledgerId: string; extractorVersion: string }
  | { ok: false; message: string } {
  if (typeof body !== "object" || body === null || Array.isArray(body)) return { ok: false, message: "body must be a JSON object" };
  const b = body as Record<string, unknown>;
  for (const k of Object.keys(b)) {
    if (!BODY_KEYS.includes(k)) return { ok: false, message: `unknown field: ${k.slice(0, 40)}` };
  }
  const docHash = b["doc_hash"];
  if (typeof docHash !== "string" || !DOC_HASH.test(docHash)) {
    return { ok: false, message: "doc_hash must look like sha256:<64 lowercase hex characters>" };
  }
  // New entries always carry both references (the legacy exemption applies only to entries written before v4.6.0).
  const refProblems = validateScreeningFields({ project_id: b["project_id"], doc_ref: b["doc_ref"] }, LEGACY_MAX_SEQ + 1);
  if (refProblems.length > 0) return { ok: false, message: `project_id and doc_ref are required and must be valid (${refProblems.join(", ")})` };
  const ledgerId = b["ledger_id"] === undefined ? "none" : b["ledger_id"];
  const extractorVersion = b["extractor_version"] === undefined ? "manual-entry" : b["extractor_version"];
  for (const [name, v] of [["ledger_id", ledgerId], ["extractor_version", extractorVersion]] as const) {
    if (typeof v !== "string" || v.trim() === "" || v.length > 100) return { ok: false, message: `${name} must be a text of 1 to 100 characters` };
  }
  const raw = b["profile"];
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return { ok: false, message: "profile must be a JSON object" };
  const p = raw as Record<string, unknown>;
  const profile: Record<string, unknown> = {};
  for (const k of Object.keys(p)) {
    if (!(PROFILE_KEYS as readonly string[]).includes(k)) return { ok: false, message: `unknown profile field: ${k.slice(0, 40)}` };
    const v = p[k];
    if (v === null || v === undefined) continue;
    if (typeof v === "number") {
      if (!Number.isFinite(v)) return { ok: false, message: `profile.${k} is not a finite number` };
    } else if (typeof v === "string") {
      if (v.length > 50) return { ok: false, message: `profile.${k} is too long` };
    } else {
      return { ok: false, message: `profile.${k} must be a number, a short text, or null` };
    }
    profile[k] = v;
  }
  return { ok: true, profile, docHash, projectId: b["project_id"] as string, docRef: b["doc_ref"] as string, ledgerId: ledgerId as string, extractorVersion: extractorVersion as string };
}

function hexToBytes(hex: string) {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(2 * i, 2 * i + 2), 16);
  return out;
}

// ---------------------------------------------------------------- the append operation

export async function appendScreening(
  deps: AppendDeps,
  req: { userId: string; allowedUserIds: string | undefined; body: unknown },
): Promise<AppendOutcome> {
  if (typeof req.userId !== "string" || req.userId === "" || req.userId.length > 100) {
    return fail(401, "UNAUTHORIZED", "sign-in required");
  }
  const allowed = isAllowed(req.userId, req.allowedUserIds);
  if (allowed === "unset") return fail(500, "SERVER_MISCONFIGURED", "the server is not configured");
  if (!allowed) return fail(403, "FORBIDDEN", "this account may not write to the audit log");

  const v = validateBody(req.body);
  if (!v.ok) return fail(400, "BAD_REQUEST", v.message);

  let result: unknown;
  try {
    result = deps.evaluate(v.profile);
  } catch {
    return fail(500, "KERNEL_ERROR", "scoring failed");
  }

  const record: Record<string, unknown> = {
    kind: "SCREENING",
    doc_hash: v.docHash,
    project_id: v.projectId,
    doc_ref: v.docRef,
    input: v.profile,
    result,
    extractor_version: v.extractorVersion,
    ledger_id: v.ledgerId,
    policy_version: POLICY_VERSION,
    timestamp: deps.now().toISOString(),
    actor_id: req.userId,
  };

  return writeRecord(deps, record, MAX_RECORD_JSON_CHARS);
}

/** Signs and stores one record, retrying when another writer got the position first. */
async function writeRecord(deps: AppendDeps, record: Record<string, unknown>, maxChars: number, maxAttempts: number = MAX_ATTEMPTS): Promise<AppendOutcome> {
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    let head: { seq: number; hash: string } | null;
    try {
      head = await deps.store.getHead();
    } catch {
      return fail(500, "STORE_ERROR", "the log could not be read");
    }
    const stub: Entry[] = head ? [{ seq: head.seq, prev_hash: "", record: {}, hash: head.hash, key_id: "", signature: "" }] : [];

    let entry: Entry;
    let recordJson: string;
    try {
      entry = await nextEntry(stub, record, deps.signer);
      recordJson = canonicalize(entry.record);
    } catch {
      return fail(400, "BAD_REQUEST", "the request contains values that cannot be recorded");
    }
    if (recordJson.length > maxChars) return fail(400, "BAD_REQUEST", "the record is too large");

    // Never write an entry that does not verify under the trusted public key.
    const sig = await deps.verifier(entry.key_id, hexToBytes(entry.hash), entry.signature);
    if (sig !== "ok") return fail(500, "SIGNING_FAILED", "the entry could not be signed correctly");

    try {
      await deps.store.insert({
        seq: entry.seq,
        prev_hash: entry.prev_hash,
        record_json: recordJson,
        hash: entry.hash,
        key_id: entry.key_id,
        signature: entry.signature,
      });
    } catch (err) {
      if (err instanceof StoreConflictError && attempt < maxAttempts) continue; // lost a race: re-read the head and retry
      if (err instanceof StoreConflictError) return fail(503, "CONFLICT", "the log is busy, please try again");
      return fail(500, "STORE_ERROR", "the entry could not be saved");
    }

    const result = record["result"];
    const res = (typeof result === "object" && result !== null ? result : {}) as Record<string, unknown>;
    return {
      ok: true,
      entry: { seq: entry.seq, hash: entry.hash, key_id: entry.key_id, decision: res["decision"] ?? record["override_decision"] ?? record["rejected_decision"], psi: res["psi"] ?? record["original_psi"], timestamp: String(record["timestamp"]) },
    };
  }
  return fail(503, "CONFLICT", "the log is busy, please try again");
}

// ---------------------------------------------------------------- appending a prepared record

export const MAX_DETAILED_RECORD_CHARS = 200000;

/** Appends a SCREENING record that was prepared elsewhere (for example a reviewed draft with full details).
 *  The caller must already have checked that the content is genuine; this checks who may write and the record's shape. */
export async function appendRecord(
  deps: AppendDeps,
  req: { userId: string; allowedUserIds: string | undefined },
  record: Record<string, unknown>,
  opts: { maxChars?: number } = {},
): Promise<AppendOutcome> {
  if (typeof req.userId !== "string" || req.userId === "" || req.userId.length > 100) {
    return fail(401, "UNAUTHORIZED", "sign-in required");
  }
  const allowed = isAllowed(req.userId, req.allowedUserIds);
  if (allowed === "unset") return fail(500, "SERVER_MISCONFIGURED", "the server is not configured");
  if (!allowed) return fail(403, "FORBIDDEN", "this account may not write to the audit log");
  const result = record["result"];
  const ok =
    record["kind"] === "SCREENING" &&
    typeof record["doc_hash"] === "string" && DOC_HASH.test(record["doc_hash"]) &&
    typeof result === "object" && result !== null && !Array.isArray(result) &&
    typeof (result as Record<string, unknown>)["decision"] === "string" &&
    record["actor_id"] === req.userId &&
    typeof record["timestamp"] === "string" &&
    typeof record["extractor_version"] === "string" && typeof record["ledger_id"] === "string" && typeof record["policy_version"] === "string" &&
    validateScreeningFields(record, LEGACY_MAX_SEQ + 1).length === 0;
  if (!ok) return fail(400, "BAD_REQUEST", "the record is not a valid screening record for this account");
  const maxChars = Math.min(opts.maxChars ?? MAX_DETAILED_RECORD_CHARS, 500000);
  return writeRecord(deps, record, maxChars);
}

// ---------------------------------------------------------------- appending an override

export interface OverrideStore extends AuditStore {
  /** Every row of the log, in order. */
  readAll(): Promise<StoreRow[]>;
}

export const OVERRIDE_BODY_KEYS = ["target_seq", "override_decision", "justification_code", "authority_basis", "consulted_evidence_ids", "note"];

/** Appends an OVERRIDE entry for a reviewer. The caller supplies only the decision and its reasons; the server fills in
 *  the reviewer (the signed-in account), the policy version, the time, and the original decision and score copied from the
 *  target entry. A second approver cannot be supplied through this route: an override that needs one goes through
 *  requestOverride and approveOverride (below). The whole check is repeated if another writer takes the position first. */
export async function appendOverride(
  deps: AppendDeps & { store: OverrideStore },
  req: { userId: string; allowedUserIds: string | undefined; body: unknown },
): Promise<AppendOutcome> {
  if (typeof req.userId !== "string" || req.userId === "" || req.userId.length > 100) {
    return fail(401, "UNAUTHORIZED", "sign-in required");
  }
  const allowed = isAllowed(req.userId, req.allowedUserIds);
  if (allowed === "unset") return fail(500, "SERVER_MISCONFIGURED", "the server is not configured");
  if (!allowed) return fail(403, "FORBIDDEN", "this account may not write to the audit log");

  const b = req.body;
  if (typeof b !== "object" || b === null || Array.isArray(b)) return fail(400, "BAD_REQUEST", "body must be a JSON object");
  const body = b as Record<string, unknown>;
  for (const k of Object.keys(body)) {
    if (!OVERRIDE_BODY_KEYS.includes(k)) return fail(400, "BAD_REQUEST", `unknown field: ${k.slice(0, 40)}`);
  }

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    let entries: Entry[];
    try {
      entries = rowsToEntries(await deps.store.readAll());
    } catch {
      return fail(500, "STORE_ERROR", "the log could not be read");
    }
    const check = await verifyChain(entries, deps.verifier);
    if (!check.ok) return fail(500, "CHAIN_INVALID", "the log does not verify, so nothing was written");

    const target = entries.find((e) => e.seq === body["target_seq"]);
    if (!target) return fail(404, "OVERRIDE_REJECTED", "TARGET_NOT_FOUND");
    if (target.record["kind"] !== "SCREENING") return fail(400, "OVERRIDE_REJECTED", "TARGET_NOT_SCREENING");
    const result = target.record["result"];
    const res = (typeof result === "object" && result !== null ? result : {}) as Record<string, unknown>;
    const record: Record<string, unknown> = {
      kind: "OVERRIDE",
      target_seq: body["target_seq"],
      original_decision: res["decision"],
      original_psi: res["psi"],
      override_decision: body["override_decision"],
      justification_code: body["justification_code"],
      authority_basis: body["authority_basis"],
      consulted_evidence_ids: body["consulted_evidence_ids"],
      note: body["note"],
      reviewer_id: req.userId,
      policy_version: POLICY_VERSION,
      timestamp: deps.now().toISOString(),
    };
    for (const k of Object.keys(record)) if (record[k] === undefined) delete record[k];

    const problems = validateOverride(entries, record);
    if (problems.length > 0) {
      const status = problems.includes("ALREADY_OVERRIDDEN") ? 409 : 400;
      return fail(status, "OVERRIDE_REJECTED", problems.join(", "));
    }
    const out = await writeRecord(deps, record, MAX_RECORD_JSON_CHARS, 1);
    if (out.ok || out.code !== "CONFLICT") return out;
  }
  return fail(503, "CONFLICT", "the log is busy, please try again");
}

// ---------------------------------------------------------------- second approver: requests, approval, rejection (spec v4.6.0)

export const PENDING_MAX_AGE_MS = 14 * 24 * 60 * 60 * 1000;
export type PendingStatus = "PENDING" | "APPROVED" | "REJECTED" | "EXPIRED";

/** An override request waiting for a second account. It lives OUTSIDE the signed log: it is not an override until approved. */
export interface PendingRequest {
  id: string;
  target_seq: number;
  override_decision: string;
  justification_code: string;
  authority_basis: string;
  consulted_evidence_ids: string[];
  note: string;
  reviewer_id: string;
  created_at: string;
  status: PendingStatus;
}

export interface PendingStore {
  create(req: PendingRequest): Promise<void>;
  get(id: string): Promise<PendingRequest | null>;
  /** Changes the status only if it is currently `from`; returns whether it changed. This is what stops two approvers
   *  (or an approver and a rejecter) from both acting on one request. */
  setStatus(id: string, from: PendingStatus, to: PendingStatus): Promise<boolean>;
}

type ApprovalDeps = AppendDeps & { store: OverrideStore; pending: PendingStore; newId: () => string };

export type RequestOutcome =
  | { ok: true; request_id: string; expires_at: string }
  | { ok: false; status: number; code: string; message: string };

function gate(userId: unknown, allowedUserIds: string | undefined): AppendOutcome | null {
  if (typeof userId !== "string" || userId === "" || userId.length > 100) return fail(401, "UNAUTHORIZED", "sign-in required");
  const allowed = isAllowed(userId, allowedUserIds);
  if (allowed === "unset") return fail(500, "SERVER_MISCONFIGURED", "the server is not configured");
  if (!allowed) return fail(403, "FORBIDDEN", "this account may not write to the audit log");
  return null;
}

async function readVerifiedChain(deps: AppendDeps & { store: OverrideStore }): Promise<{ ok: true; entries: Entry[] } | { ok: false; out: AppendOutcome }> {
  let entries: Entry[];
  try {
    entries = rowsToEntries(await deps.store.readAll());
  } catch {
    return { ok: false, out: fail(500, "STORE_ERROR", "the log could not be read") };
  }
  const check = await verifyChain(entries, deps.verifier);
  if (!check.ok) return { ok: false, out: fail(500, "CHAIN_INVALID", "the log does not verify, so nothing was written") };
  return { ok: true, entries };
}

function overrideRecordFrom(entries: Entry[], target_seq: unknown, f: {
  override_decision: unknown; justification_code: unknown; authority_basis: unknown; consulted_evidence_ids: unknown; note: unknown;
}, reviewerId: string, approverId: string | null, now: Date): Record<string, unknown> | AppendOutcome {
  const target = entries.find((e) => e.seq === target_seq);
  if (!target) return fail(404, "OVERRIDE_REJECTED", "TARGET_NOT_FOUND");
  if (target.record["kind"] !== "SCREENING") return fail(400, "OVERRIDE_REJECTED", "TARGET_NOT_SCREENING");
  const result = target.record["result"];
  const res = (typeof result === "object" && result !== null ? result : {}) as Record<string, unknown>;
  const record: Record<string, unknown> = {
    kind: "OVERRIDE",
    target_seq,
    original_decision: res["decision"],
    original_psi: res["psi"],
    override_decision: f.override_decision,
    justification_code: f.justification_code,
    authority_basis: f.authority_basis,
    consulted_evidence_ids: f.consulted_evidence_ids,
    note: f.note,
    reviewer_id: reviewerId,
    ...(approverId !== null ? { approver_id: approverId } : {}),
    policy_version: POLICY_VERSION,
    timestamp: now.toISOString(),
  };
  for (const k of Object.keys(record)) if (record[k] === undefined) delete record[k];
  return record;
}

const isOutcome = (x: Record<string, unknown> | AppendOutcome): x is AppendOutcome => "ok" in x && typeof x["ok"] === "boolean";

/** A reviewer asks for an override that needs a second approver (a favourable override of a confirmed breach or of a restriction
 *  pending authority). Nothing is written to the signed log. Overrides that need no approver go through appendOverride. */
export async function requestOverride(
  deps: ApprovalDeps,
  req: { userId: string; allowedUserIds: string | undefined; body: unknown },
): Promise<RequestOutcome> {
  const g = gate(req.userId, req.allowedUserIds);
  if (g && !g.ok) return g;
  const b = req.body;
  if (typeof b !== "object" || b === null || Array.isArray(b)) return fail(400, "BAD_REQUEST", "body must be a JSON object") as RequestOutcome;
  const body = b as Record<string, unknown>;
  for (const k of Object.keys(body)) {
    if (!OVERRIDE_BODY_KEYS.includes(k)) return fail(400, "BAD_REQUEST", `unknown field: ${k.slice(0, 40)}`) as RequestOutcome;
  }
  const chain = await readVerifiedChain(deps);
  if (!chain.ok) return chain.out as RequestOutcome;
  const rec = overrideRecordFrom(chain.entries, body["target_seq"], body as never, req.userId, null, deps.now());
  if (isOutcome(rec)) return rec as RequestOutcome;
  const problems = validateOverride(chain.entries, rec);
  if (!problems.includes("SECOND_APPROVER_REQUIRED")) {
    if (problems.length > 0) return fail(problems.includes("ALREADY_OVERRIDDEN") ? 409 : 400, "OVERRIDE_REJECTED", problems.join(", ")) as RequestOutcome;
    return fail(400, "NO_APPROVER_NEEDED", "this override needs no second approver; use the direct override route") as RequestOutcome;
  }
  const others = problems.filter((p) => p !== "SECOND_APPROVER_REQUIRED");
  if (others.length > 0) return fail(others.includes("ALREADY_OVERRIDDEN") ? 409 : 400, "OVERRIDE_REJECTED", others.join(", ")) as RequestOutcome;

  const created = deps.now();
  const id = deps.newId();
  try {
    await deps.pending.create({
      id,
      target_seq: body["target_seq"] as number,
      override_decision: body["override_decision"] as string,
      justification_code: body["justification_code"] as string,
      authority_basis: body["authority_basis"] as string,
      consulted_evidence_ids: body["consulted_evidence_ids"] as string[],
      note: body["note"] as string,
      reviewer_id: req.userId,
      created_at: created.toISOString(),
      status: "PENDING",
    });
  } catch {
    return fail(500, "STORE_ERROR", "the request could not be saved") as RequestOutcome;
  }
  return { ok: true, request_id: id, expires_at: new Date(created.getTime() + PENDING_MAX_AGE_MS).toISOString() };
}

/** Looks up a request for an approver and claims it (PENDING -> `to`). Returns the request, or an outcome to send back. */
async function claimRequest(deps: ApprovalDeps, userId: string, requestId: unknown, to: "APPROVED" | "REJECTED"): Promise<PendingRequest | AppendOutcome> {
  if (typeof requestId !== "string" || requestId === "" || requestId.length > 100) return fail(400, "BAD_REQUEST", "request_id is required");
  let r: PendingRequest | null;
  try {
    r = await deps.pending.get(requestId);
  } catch {
    return fail(500, "STORE_ERROR", "the request could not be read");
  }
  if (!r) return fail(404, "REQUEST_NOT_FOUND", "no such request");
  if (r.status !== "PENDING") return fail(409, "REQUEST_CLOSED", `the request is already ${r.status}`);
  if (deps.now().getTime() - Date.parse(r.created_at) > PENDING_MAX_AGE_MS) {
    await deps.pending.setStatus(r.id, "PENDING", "EXPIRED");
    return fail(410, "REQUEST_EXPIRED", "the request is too old");
  }
  if (userId === r.reviewer_id) return fail(403, "APPROVER_SAME_AS_REVIEWER", "the approver must be a different account");
  let claimed: boolean;
  try {
    claimed = await deps.pending.setStatus(r.id, "PENDING", to);
  } catch {
    return fail(500, "STORE_ERROR", "the request could not be updated");
  }
  if (!claimed) return fail(409, "REQUEST_CLOSED", "the request was just handled by someone else");
  return r;
}

const isRequest = (x: PendingRequest | AppendOutcome): x is PendingRequest => "reviewer_id" in x;

/** A second account approves a pending request. The server sets approver_id from the signed-in account, repeats every check
 *  against the log as it is now, and only then writes the OVERRIDE entry. If the write fails the request is reopened. */
export async function approveOverride(
  deps: ApprovalDeps,
  req: { userId: string; allowedUserIds: string | undefined; requestId: unknown },
): Promise<AppendOutcome> {
  const g = gate(req.userId, req.allowedUserIds);
  if (g) return g;
  const r = await claimRequest(deps, req.userId, req.requestId, "APPROVED");
  if (!isRequest(r)) return r;
  let out: AppendOutcome = fail(503, "CONFLICT", "the log is busy, please try again");
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const chain = await readVerifiedChain(deps);
    if (!chain.ok) { out = chain.out; break; }
    const rec = overrideRecordFrom(chain.entries, r.target_seq, r, r.reviewer_id, req.userId, deps.now());
    if (isOutcome(rec)) { out = rec; break; }
    const problems = validateOverride(chain.entries, rec);
    if (problems.length > 0) { out = fail(problems.includes("ALREADY_OVERRIDDEN") ? 409 : 400, "OVERRIDE_REJECTED", problems.join(", ")); break; }
    out = await writeRecord(deps, rec, MAX_RECORD_JSON_CHARS, 1);
    if (out.ok || out.code !== "CONFLICT") break;
  }
  if (!out.ok) await deps.pending.setStatus(r.id, "APPROVED", "PENDING");
  return out;
}

/** A second account refuses a pending request; the refusal is written to the signed log as a REJECTION entry. */
export async function rejectOverride(
  deps: ApprovalDeps,
  req: { userId: string; allowedUserIds: string | undefined; requestId: unknown; reasonCode: unknown; note: unknown },
): Promise<AppendOutcome> {
  const g = gate(req.userId, req.allowedUserIds);
  if (g) return g;
  const r = await claimRequest(deps, req.userId, req.requestId, "REJECTED");
  if (!isRequest(r)) return r;
  let out: AppendOutcome = fail(503, "CONFLICT", "the log is busy, please try again");
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const chain = await readVerifiedChain(deps);
    if (!chain.ok) { out = chain.out; break; }
    const rec: Record<string, unknown> = {
      kind: "REJECTION",
      target_seq: r.target_seq,
      rejected_decision: r.override_decision,
      reason_code: req.reasonCode,
      note: req.note,
      reviewer_id: r.reviewer_id,
      approver_id: req.userId,
      policy_version: POLICY_VERSION,
      timestamp: deps.now().toISOString(),
    };
    for (const k of Object.keys(rec)) if (rec[k] === undefined) delete rec[k];
    const problems = validateRejection(chain.entries, rec);
    if (problems.length > 0) { out = fail(problems.includes("ALREADY_OVERRIDDEN") ? 409 : 400, "REJECTION_REFUSED", problems.join(", ")); break; }
    out = await writeRecord(deps, rec, MAX_RECORD_JSON_CHARS, 1);
    if (out.ok || out.code !== "CONFLICT") break;
  }
  if (!out.ok) await deps.pending.setStatus(r.id, "REJECTED", "PENDING");
  return out;
}

// ---------------------------------------------------------------- reading rows back

/** Converts stored rows into Entry objects for verifyChain. Throws if a row's text is not the canonical
 *  form of its own content (which would mean it was stored or altered in a non-canonical way). */
export function rowsToEntries(rows: readonly StoreRow[]): Entry[] {
  return rows.map((r) => {
    const parsed: unknown = JSON.parse(r.record_json);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) throw new Error("NON_OBJECT_RECORD");
    if (canonicalize(parsed) !== r.record_json) throw new Error("NON_CANONICAL_RECORD");
    return { seq: r.seq, prev_hash: r.prev_hash, record: parsed as Record<string, unknown>, hash: r.hash, key_id: r.key_id, signature: r.signature };
  });
}
