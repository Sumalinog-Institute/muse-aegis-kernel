// MUSE Aegis: assembling a screening and committing it after human review (Phase 3, step 5).
//
// Two steps, so that a person sees everything before anything is written:
//   1. prepareScreening: extract claims (k runs), compute x1..x6, run the kernel, and return a DRAFT with full details.
//      Nothing is written. The server then signs the draft with a secret MAC key (macDraft).
//   2. commitScreening: the reviewer approves. The server checks the MAC (the draft is exactly what it produced, for this
//      account, not too old, still consistent with the kernel), then appends a signed log entry holding the full details
//      and the review.
// The model's output is not repeatable, so the draft that was reviewed must be the one that is stored; the MAC guarantees that.
//
// Draft lifetime: 30 minutes by default (DRAFT_MAX_AGE_MS). A caller that keeps drafts in a review queue passes a longer
// maxAgeMs, never more than DRAFT_QUEUE_MAX_AGE_MS (14 days).
// Known limit: the MAC proves the server made the draft, not that it is used once. Within its lifetime the same approved
// draft could be committed twice by this module alone; both entries would carry the same draft MAC, so the repeat is visible
// in the log. A caller with a queue must make approval single-use (see spec/SCREENING.md).

import { canonicalize } from "./jcs.ts";
import { LEGACY_MAX_SEQ, validateScreeningFields } from "./audit.ts";
import { appendRecord, POLICY_VERSION } from "./append.ts";
import type { AppendDeps, AppendOutcome } from "./append.ts";
import { structuredFeatures } from "./features.ts";
import type { StructuredFeatures } from "./features.ts";
import { analyzeWithStability } from "./stability.ts";
import type { Embed, RunSummary, StabilityResult } from "./stability.ts";
import type { ExtractError, GeminiDeps } from "./extract.ts";
import { buildNotCheckedReport } from "./notchecked.ts";
import type { NotCheckedReport } from "./notchecked.ts";
import { validateProvenance } from "./provenance.ts";
import type { Provenance } from "./provenance.ts";
import type { Ledger, LedgerFact, X2Result } from "./claims.ts";

export const DRAFT_FORMAT_VERSION = 2;
export const DRAFT_MAX_AGE_MS = 30 * 60 * 1000;
export const DRAFT_QUEUE_MAX_AGE_MS = 14 * 24 * 60 * 60 * 1000;
const MAX_DRAFT_CHARS = 190000;
const MAX_NOTE_CHARS = 500;
const MIN_MAC_KEY_CHARS = 32;
const MAX_DOCUMENT_CHARS = 60000;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

type Rec = Record<string, unknown>;
const isRec = (v: unknown): v is Rec => typeof v === "object" && v !== null && !Array.isArray(v);

export interface ClaimDetail {
  subject: string; attribute: string; period: string; value: number | string; unit: string;
  status: string; quote: string; at: number; label: number | null; fact_ids: string[]; flags: string[];
}

export interface Draft {
  format_version: 2;
  created_at: string;
  actor_id: string;
  doc_hash: string;
  project_id: string;
  doc_ref: string;
  ledger_id: string;
  extractor_version: string;
  policy_version: string;
  profile: Rec;
  result: Rec;
  details: {
    inputs: { hashes: Record<string, string>; award_id: string | null; spend_snapshot_id: string | null; claims_snapshot_id: string; as_of: string | null };
    features: StructuredFeatures["details"];
    claims: { items: ClaimDetail[]; x2: X2Result; ledger_flags: string[] };
    stability: { result: StabilityResult; model: string; k: number; temperature: number; valid_runs: number; runs: RunSummary[]; usage: { prompt_tokens: number; output_tokens: number } };
    not_checked?: NotCheckedReport; // v1.1; absent in drafts and records made before it
    provenance?: Provenance; // v1.1; stated by the person screening, present only when given
  };
}

export interface ScreeningInputs {
  documentText: string;
  award: unknown;
  spendLedger: unknown;
  schedule: unknown;
  register: unknown;
  claimsLedger: unknown;
}

export type PrepareError = ExtractError | "BAD_PARAMS" | "BAD_INPUT" | "DRAFT_TOO_LARGE" | "KERNEL_ERROR";
export type PrepareResult = { ok: true; draft: Draft } | { ok: false; code: PrepareError; status: number | null; detail?: string };

export interface PrepareDeps extends GeminiDeps {
  embed?: Embed;
  now: () => Date;
  evaluate: (profile: Rec) => unknown;
}

// ---------------------------------------------------------------- helpers

const enc = new TextEncoder();

function toHex(buf: ArrayBuffer): string {
  return Array.from(new Uint8Array(buf), (b) => b.toString(16).padStart(2, "0")).join("");
}

export async function sha256Hex(text: string): Promise<string> {
  return toHex(await crypto.subtle.digest("SHA-256", enc.encode(text)));
}

/** The reference ledger used to check claims. Validated strictly because it comes from outside. */
export function parseClaimsLedger(v: unknown): Ledger | null {
  if (!isRec(v) || typeof v["snapshot_id"] !== "string" || v["snapshot_id"].trim() === "" || v["snapshot_id"].length > 200) return null;
  if (typeof v["snapshot_date"] !== "string" || !ISO_DATE.test(v["snapshot_date"])) return null;
  const facts = v["facts"];
  if (!Array.isArray(facts) || facts.length > 500) return null;
  const out: LedgerFact[] = [];
  for (const f of facts) {
    if (!isRec(f)) return null;
    for (const name of ["id", "subject", "attribute", "period"]) {
      const t = f[name];
      if (typeof t !== "string" || t.trim() === "" || t.length > 200) return null;
    }
    if (typeof f["unit"] !== "string" || f["unit"].length > 200) return null;
    const val = f["value"];
    const okVal = (typeof val === "number" && Number.isFinite(val)) || (typeof val === "string" && val.length > 0 && val.length <= 200);
    if (!okVal) return null;
    for (const d of ["valid_from", "valid_to"]) {
      if (f[d] !== undefined && !(typeof f[d] === "string" && ISO_DATE.test(f[d] as string))) return null;
    }
    const al = f["subject_aliases"];
    if (al !== undefined && !(Array.isArray(al) && al.length <= 10 && al.every((a) => typeof a === "string" && a.trim() !== "" && a.length <= 200))) return null;
    out.push(f as unknown as LedgerFact);
  }
  return { snapshot_id: v["snapshot_id"], snapshot_date: v["snapshot_date"], facts: out };
}

function strOrNull(v: unknown, max = 100): string | null {
  return typeof v === "string" && v.length > 0 ? v.slice(0, max) : null;
}

// ---------------------------------------------------------------- step 1: prepare

export async function prepareScreening(
  deps: PrepareDeps,
  p: { apiKey: string; model: string; actorId: string; projectId: string; docRef: string; inputs: ScreeningInputs; k?: number; temperature?: number; maxDraftChars?: number; relaxedAnchor?: boolean; provenance?: unknown },
): Promise<PrepareResult> {
  const bad = (code: PrepareError): PrepareResult => ({ ok: false, code, status: null });
  const inp = p.inputs;
  if (typeof p.actorId !== "string" || p.actorId === "" || p.actorId.length > 100) return bad("BAD_PARAMS");
  // New entries always carry both references (the legacy exemption applies only to entries written before v4.6.0).
  if (validateScreeningFields({ project_id: p.projectId, doc_ref: p.docRef }, LEGACY_MAX_SEQ + 1).length > 0) return bad("BAD_PARAMS");
  if (typeof inp.documentText !== "string" || inp.documentText.trim() === "" || inp.documentText.length > MAX_DOCUMENT_CHARS) return bad("BAD_INPUT");
  let provenance: Provenance | undefined;
  if (p.provenance !== undefined) {
    const v = validateProvenance(p.provenance, deps.now().toISOString().slice(0, 10));
    if (!v.ok) return bad("BAD_PARAMS");
    provenance = v.value;
  }
  const claimsLedger = parseClaimsLedger(inp.claimsLedger);
  if (!claimsLedger) return bad("BAD_INPUT");
  if (![inp.award, inp.spendLedger, inp.schedule, inp.register].every(isRec)) return bad("BAD_INPUT");

  const hashes: Record<string, string> = {};
  try {
    hashes["award"] = await sha256Hex(canonicalize(inp.award));
    hashes["spend_ledger"] = await sha256Hex(canonicalize(inp.spendLedger));
    hashes["schedule"] = await sha256Hex(canonicalize(inp.schedule));
    hashes["register"] = await sha256Hex(canonicalize(inp.register));
    hashes["claims_ledger"] = await sha256Hex(canonicalize(claimsLedger));
  } catch {
    return bad("BAD_INPUT");
  }

  const features = structuredFeatures(inp.award, inp.spendLedger, inp.schedule, inp.register);
  const analysis = await analyzeWithStability(deps, {
    apiKey: p.apiKey, model: p.model, documentText: inp.documentText, ledger: claimsLedger,
    ...(p.k !== undefined ? { k: p.k } : {}), ...(p.temperature !== undefined ? { temperature: p.temperature } : {}),
    ...(p.relaxedAnchor === true ? { relaxedAnchor: true } : {}),
  });
  if (!analysis.ok) return { ok: false, code: analysis.code, status: analysis.status, ...(analysis.detail !== undefined ? { detail: analysis.detail } : {}) };

  const profile: Rec = {
    x1: analysis.stability.x1,
    x2: analysis.consensus.x2.x2,
    x4: features.x4,
    x5: features.x5,
    x6: features.x6,
    n_applicable: features.n_applicable,
    alert_status: features.alert_status,
  };
  let result: unknown;
  try {
    result = deps.evaluate(profile);
  } catch {
    return bad("KERNEL_ERROR");
  }
  if (!isRec(result)) return bad("KERNEL_ERROR");

  const award = inp.award as Rec;
  const spend = inp.spendLedger as Rec;
  const draft: Draft = {
    format_version: DRAFT_FORMAT_VERSION,
    created_at: deps.now().toISOString(),
    actor_id: p.actorId,
    doc_hash: "sha256:" + (await sha256Hex(inp.documentText)),
    project_id: p.projectId,
    doc_ref: p.docRef,
    ledger_id: strOrNull(spend["snapshot_id"]) ?? "unknown",
    extractor_version: analysis.extractor_version,
    policy_version: POLICY_VERSION,
    profile,
    result,
    details: {
      inputs: {
        hashes,
        award_id: strOrNull(award["identifier"]),
        spend_snapshot_id: strOrNull(spend["snapshot_id"]),
        claims_snapshot_id: claimsLedger.snapshot_id,
        as_of: strOrNull(spend["as_of"], 10),
      },
      features: features.details,
      claims: {
        items: analysis.consensus.items.map((it) => ({
          subject: it.claim.subject, attribute: it.claim.attribute, period: it.claim.period, value: it.claim.value, unit: it.claim.unit,
          status: it.status, quote: it.claim.quote, at: it.claim.at, label: it.claim.label, fact_ids: it.fact_ids, flags: it.flags,
        })),
        x2: analysis.consensus.x2,
        ledger_flags: analysis.consensus.ledger_flags,
      },
      ...(provenance !== undefined ? { provenance } : {}),
      not_checked: buildNotCheckedReport({
        ledger: claimsLedger, items: analysis.consensus.items, x2: analysis.consensus.x2, runs: analysis.runs, k: analysis.k,
        documentChars: inp.documentText.length, provenanceRecorded: provenance !== undefined, profile: { x1: analysis.stability.x1, x2: analysis.consensus.x2.x2, x4: features.x4, x5: features.x5, x6: features.x6 },
      }),
      stability: {
        result: analysis.stability, model: p.model, k: analysis.k, temperature: analysis.temperature,
        valid_runs: analysis.valid_runs, runs: analysis.runs, usage: analysis.usage,
      },
    },
  };
  try {
    if (canonicalize(draft).length > (p.maxDraftChars ?? MAX_DRAFT_CHARS)) return bad("DRAFT_TOO_LARGE");
  } catch {
    return bad("BAD_INPUT");
  }
  return { ok: true, draft };
}

// ---------------------------------------------------------------- the MAC

async function hmacKey(key: string): Promise<CryptoKey | null> {
  if (typeof key !== "string" || key.length < MIN_MAC_KEY_CHARS) return null;
  return crypto.subtle.importKey("raw", enc.encode(key), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
}

/** MAC of the draft's canonical text, as 64 hex characters. Throws if the key is too short. */
export async function macDraft(draft: Draft, key: string): Promise<string> {
  const k = await hmacKey(key);
  if (!k) throw new Error("MAC_KEY_TOO_SHORT");
  return toHex(await crypto.subtle.sign("HMAC", k, enc.encode(canonicalize(draft))));
}

function sameText(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
}

export type CheckError = "BAD_DRAFT" | "BAD_MAC" | "EXPIRED" | "WRONG_ACTOR" | "STALE_DRAFT" | "SERVER_MISCONFIGURED";

export async function checkDraft(
  draftU: unknown,
  macU: unknown,
  key: string,
  ctx: { now: Date; actorId: string; evaluate: (profile: Rec) => unknown; maxAgeMs?: number },
): Promise<{ ok: true; draft: Draft } | { ok: false; code: CheckError }> {
  if (!(await hmacKey(key))) return { ok: false, code: "SERVER_MISCONFIGURED" };
  if (!isRec(draftU) || draftU["format_version"] !== DRAFT_FORMAT_VERSION || typeof macU !== "string" || !/^[0-9a-f]{64}$/.test(macU)) {
    return { ok: false, code: "BAD_DRAFT" };
  }
  const draft = draftU as unknown as Draft;
  let expected: string;
  try {
    expected = await macDraft(draft, key);
  } catch {
    return { ok: false, code: "BAD_DRAFT" };
  }
  if (!sameText(expected, macU)) return { ok: false, code: "BAD_MAC" };
  if (draft.actor_id !== ctx.actorId) return { ok: false, code: "WRONG_ACTOR" };
  const requested = ctx.maxAgeMs;
  const maxAge = typeof requested === "number" && Number.isFinite(requested) && requested > 0 ? Math.min(requested, DRAFT_QUEUE_MAX_AGE_MS) : DRAFT_MAX_AGE_MS;
  const created = Date.parse(draft.created_at);
  const age = ctx.now.getTime() - created;
  if (!Number.isFinite(created) || age < -5 * 60 * 1000 || age > maxAge) return { ok: false, code: "EXPIRED" };
  // The deterministic part must still agree with the kernel (guards against a code change between preparing and committing).
  let again: unknown;
  try {
    again = ctx.evaluate(draft.profile);
  } catch {
    return { ok: false, code: "STALE_DRAFT" };
  }
  if (!isRec(again) || again["decision"] !== draft.result["decision"] || again["psi"] !== draft.result["psi"]) return { ok: false, code: "STALE_DRAFT" };
  return { ok: true, draft };
}

// ---------------------------------------------------------------- step 2: commit

export function buildRecord(draft: Draft, review: { note: string; reviewedAt: string; mac: string }): Rec {
  return {
    kind: "SCREENING",
    format_version: DRAFT_FORMAT_VERSION,
    doc_hash: draft.doc_hash,
    project_id: draft.project_id,
    doc_ref: draft.doc_ref,
    input: draft.profile,
    result: draft.result,
    extractor_version: draft.extractor_version,
    ledger_id: draft.ledger_id,
    policy_version: draft.policy_version,
    timestamp: review.reviewedAt,
    actor_id: draft.actor_id,
    details: {
      ...draft.details,
      review: { decision: "APPROVED", reviewer: draft.actor_id, reviewed_at: review.reviewedAt, note: review.note, draft_created_at: draft.created_at, draft_mac: review.mac },
    },
  };
}

export async function commitScreening(
  deps: AppendDeps,
  req: { userId: string; allowedUserIds: string | undefined; macKey: string; draft: unknown; mac: unknown; note: unknown; maxAgeMs?: number },
): Promise<AppendOutcome> {
  const fail = (status: number, code: string, message: string): AppendOutcome => ({ ok: false, status, code, message });
  if (typeof req.note !== "string" || req.note.length > MAX_NOTE_CHARS) return fail(400, "BAD_REQUEST", `the review note must be text of at most ${MAX_NOTE_CHARS} characters`);
  const c = await checkDraft(req.draft, req.mac, req.macKey, {
    now: deps.now(), actorId: req.userId,
    evaluate: deps.evaluate as (profile: Rec) => unknown,
    ...(req.maxAgeMs !== undefined ? { maxAgeMs: req.maxAgeMs } : {}),
  });
  if (!c.ok) {
    if (c.code === "SERVER_MISCONFIGURED") return fail(500, "SERVER_MISCONFIGURED", "the server is not configured");
    if (c.code === "WRONG_ACTOR") return fail(403, "FORBIDDEN", "this draft belongs to another account");
    if (c.code === "EXPIRED") return fail(400, "EXPIRED", "the draft is too old, please prepare it again");
    if (c.code === "STALE_DRAFT") return fail(409, "STALE_DRAFT", "the draft no longer matches the scoring rules, please prepare it again");
    return fail(400, c.code, "the draft was changed or did not come from this server");
  }
  const record = buildRecord(c.draft, { note: req.note, reviewedAt: deps.now().toISOString(), mac: req.mac as string });
  return appendRecord(deps, { userId: req.userId, allowedUserIds: req.allowedUserIds }, record);
}
