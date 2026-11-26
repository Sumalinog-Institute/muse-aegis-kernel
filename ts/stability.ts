// MUSE Aegis: output instability x1 and consensus claims (Phase 3, step 4).
// The extractor is run k times at a declared temperature. Runs are aligned and compared, and x1 measures how much they
// disagree. The same k runs also give the consensus claim set used for x2.
//
// Alignment: a claim is identified by WHERE its value sits in the document (claim.at). The same figure found in two runs is the
// same claim even if the model words its subject, attribute or period differently, because wording drift is not unreliability.
// For each claim and run the label is its evidence status, or ABSENT if that run did not find it (the five labels of the paper).
// If a run proposes several claims for one figure, the most severe status is used (ties broken by key).
//
//   sigma_jsd = (disagreeing run pairs, summed over all claims) / (number of claims x number of run pairs)
//   (the Jensen-Shannon divergence in base 2 between two one-hot labels is 0 if equal and 1 if different)
//   sigma_sem = mean over run pairs of (1 - cosine(embedding_a, embedding_b)) / 2     [needs an embedder]
//   x1 = min(1, 0.5 sigma_jsd + 0.5 sigma_sem), or sigma_jsd alone in mode "jsd_only" (no embedder).
// The two modes are different scales and must not be pooled; the mode is returned with every result.

import { canonicalize } from "./jcs.ts";
import { computeX2, verifyClaims } from "./claims.ts";
import type { EvidenceStatus, Ledger, VerifiedClaim, X2Result } from "./claims.ts";
import { extractClaims, PROMPT_VERSION } from "./extract.ts";
import type { ExtractError, ExtractParams, GeminiDeps } from "./extract.ts";

export const STABILITY = { W_JSD: 0.5, W_SEM: 0.5, MIN_K: 2, MAX_K: 10, DEFAULT_K: 3, DEFAULT_TEMPERATURE: 0.7, MAX_TEMPERATURE: 2 } as const;

export type Embed = (texts: string[]) => Promise<number[][]>;

export type StabilityResult =
  | { x1: number; mode: "jsd_only" | "jsd_sem"; sigma_jsd: number; sigma_sem: number | null; k: number; claims_in_union: number; disagreeing_pairs: number }
  | { x1: "INCOMPLETE"; reason: string; k: number };

const SEVERITY: Record<EvidenceStatus, number> = { CONTRADICTED: 3, AMBIGUOUS_CONFLICT: 2, INSUFFICIENT_EVIDENCE: 1, SUPPORTED: 0 };

/** One claim per figure in a run: the most severe status wins; ties go to the smaller key, then the smaller value. */
export function byPosition(run: readonly VerifiedClaim[]): Map<number, VerifiedClaim> {
  const out = new Map<number, VerifiedClaim>();
  for (const it of run) {
    const cur = out.get(it.claim.at);
    if (!cur) { out.set(it.claim.at, it); continue; }
    const a = SEVERITY[it.status], b = SEVERITY[cur.status];
    const better = a !== b ? a > b : it.claim.key !== cur.claim.key ? it.claim.key < cur.claim.key : String(it.claim.value) < String(cur.claim.value);
    if (better) out.set(it.claim.at, it);
  }
  return out;
}

// ---------------------------------------------------------------- sigma_jsd

export function sigmaJsd(runs: readonly (readonly VerifiedClaim[])[]): { sigma: number; union: number; disagreements: number; pairs: number } {
  const k = runs.length;
  const maps = runs.map(byPosition);
  const union = new Set<number>();
  for (const m of maps) for (const at of m.keys()) union.add(at);
  const pairs = (k * (k - 1)) / 2;
  let disagreements = 0;
  for (const at of union) {
    for (let a = 0; a < k; a++) {
      for (let b = a + 1; b < k; b++) {
        const la = (maps[a] as Map<number, VerifiedClaim>).get(at)?.status ?? "ABSENT";
        const lb = (maps[b] as Map<number, VerifiedClaim>).get(at)?.status ?? "ABSENT";
        if (la !== lb) disagreements++; // one-hot labels differ: JSD (base 2) = 1
      }
    }
  }
  if (union.size === 0 || pairs === 0) return { sigma: 0, union: union.size, disagreements: 0, pairs };
  return { sigma: disagreements / (union.size * pairs), union: union.size, disagreements, pairs };
}

// ---------------------------------------------------------------- sigma_sem

/** The text that represents one run for embedding: its figures and their statuses, sorted, as canonical JSON. */
export function runText(run: readonly VerifiedClaim[]): string {
  return canonicalize([...byPosition(run).entries()].sort((x, y) => x[0] - y[0]).map(([at, it]) => [at, it.status]));
}

export function sigmaSem(vectors: readonly number[][]): { sigma: number } | { error: string } {
  const k = vectors.length;
  if (k < 2) return { error: "TOO_FEW_VECTORS" };
  const dim = (vectors[0] as number[]).length;
  if (dim === 0) return { error: "EMBEDDING_INVALID" };
  for (const v of vectors) {
    if (!Array.isArray(v) || v.length !== dim || !v.every((x) => typeof x === "number" && Number.isFinite(x))) return { error: "EMBEDDING_INVALID" };
  }
  const norm = vectors.map((v) => Math.sqrt(v.reduce((s, x) => s + x * x, 0)));
  if (norm.some((n) => n === 0)) return { error: "EMBEDDING_INVALID" };
  let total = 0;
  let pairs = 0;
  for (let a = 0; a < k; a++) {
    for (let b = a + 1; b < k; b++) {
      pairs++;
      const va = vectors[a] as number[];
      const vb = vectors[b] as number[];
      if (va.every((x, i) => x === vb[i])) continue; // identical runs are at distance exactly 0 (no rounding noise)
      let dot = 0;
      for (let i = 0; i < dim; i++) dot += va[i]! * vb[i]!;
      const cos = Math.max(-1, Math.min(1, dot / ((norm[a] as number) * (norm[b] as number))));
      total += (1 - cos) / 2;
    }
  }
  return { sigma: total / pairs };
}

export function combineX1(sj: number, ss: number | null): { x1: number; mode: "jsd_only" | "jsd_sem" } {
  if (ss === null) return { x1: sj, mode: "jsd_only" };
  return { x1: Math.min(1, STABILITY.W_JSD * sj + STABILITY.W_SEM * ss), mode: "jsd_sem" };
}

// ---------------------------------------------------------------- consensus

/** For each figure, the label (status or ABSENT) that most runs agree on. A clear winner that is a status keeps the claim with
 *  that status; a clear winner of ABSENT drops it; any tie keeps it as AMBIGUOUS_CONFLICT (flag RUN_TIE). */
export function consensusItems(runs: readonly (readonly VerifiedClaim[])[]): VerifiedClaim[] {
  const maps = runs.map(byPosition);
  const order: number[] = [];
  const seen = new Set<number>();
  for (const m of maps) for (const at of m.keys()) if (!seen.has(at)) { seen.add(at); order.push(at); }
  const out: VerifiedClaim[] = [];
  for (const at of order) {
    const labels = maps.map((m) => m.get(at)?.status ?? "ABSENT");
    const counts = new Map<string, number>();
    for (const l of labels) counts.set(l, (counts.get(l) ?? 0) + 1);
    const best = Math.max(...counts.values());
    const winners = [...counts.entries()].filter(([, c]) => c === best).map(([l]) => l);
    if (winners.length === 1) {
      const w = winners[0] as string;
      if (w === "ABSENT") continue;
      const run = labels.indexOf(w as EvidenceStatus | "ABSENT");
      out.push({ ...(maps[run] as Map<number, VerifiedClaim>).get(at) as VerifiedClaim, occurrences: 1 });
    } else {
      const run = labels.findIndex((l) => l !== "ABSENT");
      const base = (maps[run] as Map<number, VerifiedClaim>).get(at) as VerifiedClaim;
      out.push({ ...base, occurrences: 1, status: "AMBIGUOUS_CONFLICT", flags: [...base.flags, "RUN_TIE"] });
    }
  }
  return out;
}

// ---------------------------------------------------------------- the orchestration

export interface RunFigure { at: number; status: string; subject: string; attribute: string; period: string; label: number | null }

export interface RunSummary {
  ok: boolean;
  code?: ExtractError;
  claims: number;
  rejected: number;
  rejected_reasons?: Record<string, number>;
  relaxed?: number; // claims accepted only by the relaxed match (v1.1); absent when the relaxed match is off
  rejected_samples?: { reason: string; quote: string }[]; // up to 8 rejected quotes, to explain why claims were rejected
  figures?: RunFigure[]; // what this run found, so a disagreement between runs can be traced (at most 60 per run)
}

export type StabilityAnalysis =
  | {
      ok: true;
      extractor_version: string;
      k: number;
      temperature: number;
      valid_runs: number;
      runs: RunSummary[];
      usage: { prompt_tokens: number; output_tokens: number };
      consensus: { items: VerifiedClaim[]; ledger_flags: string[]; x2: X2Result };
      stability: StabilityResult;
    }
  | { ok: false; code: ExtractError | "BAD_PARAMS"; status: number | null; detail?: string };

export async function analyzeWithStability(
  deps: GeminiDeps & { embed?: Embed },
  p: ExtractParams & { ledger: Ledger; k?: number; temperature?: number },
): Promise<StabilityAnalysis> {
  const k = p.k ?? STABILITY.DEFAULT_K;
  const temperature = p.temperature ?? STABILITY.DEFAULT_TEMPERATURE;
  if (!Number.isInteger(k) || k < STABILITY.MIN_K || k > STABILITY.MAX_K) return { ok: false, code: "BAD_PARAMS", status: null };
  if (typeof temperature !== "number" || !Number.isFinite(temperature) || temperature < 0 || temperature > STABILITY.MAX_TEMPERATURE) {
    return { ok: false, code: "BAD_PARAMS", status: null };
  }
  const labels = p.labels ?? p.ledger.facts.map((f) => ({ subject: f.subject, attribute: f.attribute, period: f.period }));

  const summaries: RunSummary[] = [];
  const itemRuns: VerifiedClaim[][] = [];
  let ledgerFlags: string[] = [];
  let firstFailure: { code: ExtractError; status: number | null; detail?: string } | null = null;
  const usage = { prompt_tokens: 0, output_tokens: 0 };

  for (let i = 0; i < k; i++) {
    const e = await extractClaims(deps, { ...p, temperature, labels });
    if (!e.ok) {
      summaries.push({ ok: false, code: e.code, claims: 0, rejected: 0 });
      firstFailure ??= { code: e.code, status: e.status, ...(e.detail !== undefined ? { detail: e.detail } : {}) };
      if (e.code === "EMPTY_DOCUMENT" || e.code === "DOCUMENT_TOO_LARGE" || e.code === "AUTH_FAILED" || e.code === "MODEL_NOT_FOUND" || e.code === "BAD_REQUEST") break; // repeating cannot help
      continue;
    }
    const v = verifyClaims(e.claims, p.ledger);
    if (itemRuns.length === 0) ledgerFlags = v.ledgerFlags;
    itemRuns.push(v.items);
    const reasons: Record<string, number> = {};
    for (const r of e.rejected) reasons[r.reason] = (reasons[r.reason] ?? 0) + 1;
    const figures: RunFigure[] = [...byPosition(v.items).values()].sort((x, y) => x.claim.at - y.claim.at).slice(0, 60)
      .map((it) => ({ at: it.claim.at, status: it.status, subject: it.claim.subject, attribute: it.claim.attribute, period: it.claim.period, label: it.claim.label }));
    summaries.push({
      ok: true, claims: e.claims.length, rejected: e.rejected.length, rejected_reasons: reasons, figures,
      ...(p.relaxedAnchor === true ? { relaxed: e.relaxed.length } : {}),
      ...(e.samples.length > 0 ? { rejected_samples: e.samples.map((x) => ({ reason: x.reason, quote: x.quote })) } : {}),
    });
    usage.prompt_tokens += e.usage.prompt_tokens ?? 0;
    usage.output_tokens += e.usage.output_tokens ?? 0;
  }

  if (itemRuns.length === 0) {
    const f = firstFailure ?? { code: "EMPTY_RESPONSE" as ExtractError, status: null };
    return { ok: false, code: f.code, status: f.status, ...("detail" in f && f.detail !== undefined ? { detail: f.detail } : {}) };
  }

  const consensus = consensusItems(itemRuns);
  const x2 = computeX2(consensus, p.documentText.length);

  let stability: StabilityResult;
  if (itemRuns.length < k) {
    stability = { x1: "INCOMPLETE", reason: "FEWER_THAN_K_VALID_RUNS", k };
  } else {
    const sj = sigmaJsd(itemRuns);
    let ss: number | null = null;
    let failed: string | null = null;
    if (deps.embed) {
      try {
        const vectors = await deps.embed(itemRuns.map(runText));
        const r = sigmaSem(vectors);
        if ("error" in r) failed = r.error;
        else ss = r.sigma;
      } catch {
        failed = "EMBEDDING_FAILED";
      }
    }
    if (failed !== null) stability = { x1: "INCOMPLETE", reason: failed, k };
    else {
      const c = combineX1(sj.sigma, ss);
      stability = { x1: c.x1, mode: c.mode, sigma_jsd: sj.sigma, sigma_sem: ss, k, claims_in_union: sj.union, disagreeing_pairs: sj.disagreements };
    }
  }

  return {
    ok: true,
    extractor_version: `gemini:${p.model}:prompt-v${PROMPT_VERSION}:stab-k${k}-t${temperature}`,
    k,
    temperature,
    valid_runs: itemRuns.length,
    runs: summaries,
    usage,
    consensus: { items: consensus, ledger_flags: ledgerFlags, x2 },
    stability,
  };
}
