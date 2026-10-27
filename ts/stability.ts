// MUSE Aegis: output instability x1 and consensus claims (Phase 3, step 4).
// The extractor is run k times at a declared temperature. Claims are aligned across runs, and x1 measures how much
// the runs disagree. The same k runs also give the consensus claim set used for x2.
//
// Alignment: a claim's identity is (subject|attribute|period, value, unit). A claim that is missing from a run is
// labelled ABSENT in that run; a claim whose value changes between runs counts as two claims, each absent in some
// runs. Because the verifier is deterministic, a present claim always has the same status, so the only possible
// disagreement between two runs about a claim is present versus ABSENT.
//
//   sigma_jsd = (disagreeing run pairs, summed over all claims) / (number of claims x number of run pairs)
//   (the Jensen-Shannon divergence in base 2 between two one-hot labels is 0 if equal and 1 if different)
//   sigma_sem = mean over run pairs of (1 - cosine(embedding_a, embedding_b)) / 2     [needs an embedder]
//   x1 = min(1, 0.5 sigma_jsd + 0.5 sigma_sem), or sigma_jsd alone in mode "jsd_only" (no embedder).
// The two modes are different scales and must not be pooled; the mode is returned with every result.

import { canonicalize } from "./jcs.ts";
import { computeX2, verifyClaims } from "./claims.ts";
import type { Claim, Ledger, VerifiedClaim, X2Result } from "./claims.ts";
import { extractClaims, PROMPT_VERSION } from "./extract.ts";
import type { ExtractError, ExtractParams, GeminiDeps } from "./extract.ts";

export const STABILITY = { W_JSD: 0.5, W_SEM: 0.5, MIN_K: 2, MAX_K: 10, DEFAULT_K: 3, DEFAULT_TEMPERATURE: 0.7, MAX_TEMPERATURE: 2 } as const;

export type Embed = (texts: string[]) => Promise<number[][]>;

export type StabilityResult =
  | { x1: number; mode: "jsd_only" | "jsd_sem"; sigma_jsd: number; sigma_sem: number | null; k: number; claims_in_union: number; disagreeing_pairs: number }
  | { x1: "INCOMPLETE"; reason: string; k: number };

export function claimId(c: Claim): string {
  return JSON.stringify([c.key, c.value, c.unit]);
}

// ---------------------------------------------------------------- sigma_jsd

export function sigmaJsd(runs: readonly (readonly VerifiedClaim[])[]): { sigma: number; union: number; disagreements: number; pairs: number } {
  const k = runs.length;
  const sets = runs.map((r) => new Set(r.map((it) => claimId(it.claim))));
  const union = new Set<string>();
  for (const s of sets) for (const id of s) union.add(id);
  const pairs = (k * (k - 1)) / 2;
  let disagreements = 0;
  for (const id of union) {
    for (let a = 0; a < k; a++) {
      for (let b = a + 1; b < k; b++) {
        const inA = (sets[a] as Set<string>).has(id);
        const inB = (sets[b] as Set<string>).has(id);
        if (inA !== inB) disagreements++; // one-hot labels differ: JSD (base 2) = 1
      }
    }
  }
  if (union.size === 0 || pairs === 0) return { sigma: 0, union: union.size, disagreements: 0, pairs };
  return { sigma: disagreements / (union.size * pairs), union: union.size, disagreements, pairs };
}

// ---------------------------------------------------------------- sigma_sem

/** The text that represents one run for embedding: its sorted claim identities as canonical JSON. */
export function runText(run: readonly VerifiedClaim[]): string {
  return canonicalize(run.map((it) => claimId(it.claim)).sort());
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

/** Claims present in more runs than they are absent from, in order of first appearance. An exact tie (for example
 *  1 of 2 runs) is kept as AMBIGUOUS_CONFLICT; a claim present in fewer runs than it is absent from is dropped. */
export function consensusItems(runs: readonly (readonly VerifiedClaim[])[]): VerifiedClaim[] {
  const n = runs.length;
  const order: string[] = [];
  const first = new Map<string, VerifiedClaim>();
  const count = new Map<string, number>();
  for (const run of runs) {
    for (const it of run) {
      const id = claimId(it.claim);
      if (!first.has(id)) { first.set(id, it); order.push(id); }
      count.set(id, (count.get(id) ?? 0) + 1);
    }
  }
  const out: VerifiedClaim[] = [];
  for (const id of order) {
    const p = count.get(id) as number;
    const base = first.get(id) as VerifiedClaim;
    if (p > n - p) out.push({ ...base, occurrences: 1 });
    else if (p === n - p) out.push({ ...base, occurrences: 1, status: "AMBIGUOUS_CONFLICT", flags: [...base.flags, "RUN_TIE"] });
  }
  return out;
}

// ---------------------------------------------------------------- the orchestration

export interface RunSummary {
  ok: boolean;
  code?: ExtractError;
  claims: number;
  rejected: number;
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
  | { ok: false; code: ExtractError | "BAD_PARAMS"; status: number | null };

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
  let firstFailure: { code: ExtractError; status: number | null } | null = null;
  const usage = { prompt_tokens: 0, output_tokens: 0 };

  for (let i = 0; i < k; i++) {
    const e = await extractClaims(deps, { ...p, temperature, labels });
    if (!e.ok) {
      summaries.push({ ok: false, code: e.code, claims: 0, rejected: 0 });
      firstFailure ??= { code: e.code, status: e.status };
      if (e.code === "EMPTY_DOCUMENT" || e.code === "DOCUMENT_TOO_LARGE" || e.code === "AUTH_FAILED" || e.code === "MODEL_NOT_FOUND" || e.code === "BAD_REQUEST") break; // repeating cannot help
      continue;
    }
    const v = verifyClaims(e.claims, p.ledger);
    if (itemRuns.length === 0) ledgerFlags = v.ledgerFlags;
    itemRuns.push(v.items);
    summaries.push({ ok: true, claims: e.claims.length, rejected: e.rejected.length });
    usage.prompt_tokens += e.usage.prompt_tokens ?? 0;
    usage.output_tokens += e.usage.output_tokens ?? 0;
  }

  if (itemRuns.length === 0) {
    const f = firstFailure ?? { code: "EMPTY_RESPONSE" as ExtractError, status: null };
    return { ok: false, code: f.code, status: f.status };
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
