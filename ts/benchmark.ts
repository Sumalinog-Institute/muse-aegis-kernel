// MUSE Aegis: scoring the comparison between the plain AI judge and the pipeline (Phase 5).
// Pure functions. The known answers come from the scenarios' planted problems (spec/BENCHMARK.md). Matching a free-text issue
// reference to a planted problem is deliberately simple and strict about identifiers and lenient about wording; every run's
// raw findings are kept so a person can check any match.

import { nameTokens } from "./features.ts";
import type { IssueCategory, Level } from "./judge.ts";
import type { Draft } from "./screening.ts";

export interface Issue { category: IssueCategory; ref: string }
export interface ToleratedIssue { category: IssueCategory | "*"; ref: string }
export interface PlantedIssues { expected: Issue[]; tolerated: ToleratedIssue[] }

// ---------------------------------------------------------------- decisions to levels

const LEVEL_OF: Record<string, Level> = {
  SCREENING_PASS_PENDING_STANDARD_CONTROLS: "PASS",
  FLAG_FOR_REVIEW: "REVIEW",
  DOCUMENTATION_HOLD_PENDING_REVIEW: "REVIEW",
  INCOMPLETE_INPUT_MANUAL_REVIEW: "REVIEW",
  ALERT_VERIFICATION_REQUIRED: "ALERT",
  RESTRICTION_RECOMMENDED_PENDING_AUTHORITY: "RESTRICT",
};

export function levelOfDecision(decision: string): Level | null {
  return LEVEL_OF[decision] ?? null;
}

// ---------------------------------------------------------------- matching a found issue to a planted one

const STOP = new Set(["and", "the", "of", "for", "on", "in", "a", "an", "to"]);
const ID_LIKE = /^[A-Za-z]{1,4}-?[0-9][A-Za-z0-9-]*$/;

function esc(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function words(s: string): Set<string> {
  return new Set([...nameTokens(s)].filter((t) => !STOP.has(t)));
}

export function refMatches(found: string, expected: string): boolean {
  const e = expected.trim(), f = found.trim();
  if (e === "" || f === "") return false;
  if (ID_LIKE.test(e)) {
    // identifiers must appear whole: R2 matches "R2" but not "R25"
    return new RegExp(`(^|[^a-z0-9-])${esc(e.toLowerCase())}($|[^a-z0-9-])`).test(f.toLowerCase());
  }
  const E = words(e), F = words(f);
  if (E.size === 0) return false;
  const shared = [...E].filter((t) => F.has(t));
  return shared.length / E.size >= 0.5 && shared.some((t) => Array.from(t).length >= 5);
}

function categoryOk(found: IssueCategory, wanted: IssueCategory | "*"): boolean {
  return wanted === "*" || found === wanted || found === "OTHER";
}

export interface RunScore {
  recall: number | null; // share of planted problems found; null if there are none
  matched: Issue[];
  missed: Issue[];
  false_alarms: Issue[]; // found issues that are neither planted nor tolerated
  precision: number | null; // matched planted / (matched planted + false alarms); null if nothing countable was found
}

export function scoreIssues(found: readonly Issue[], truth: PlantedIssues): RunScore {
  const matchedIdx = new Set<number>();
  const falseAlarms: Issue[] = [];
  const seen = new Set<string>();
  for (const f of found) {
    const key = `${f.category}|${f.ref.trim().toLowerCase()}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const hit = truth.expected.findIndex((e) => categoryOk(f.category, e.category) && refMatches(f.ref, e.ref));
    if (hit >= 0) { matchedIdx.add(hit); continue; }
    if (truth.tolerated.some((t) => categoryOk(f.category, t.category) && refMatches(f.ref, t.ref))) continue;
    falseAlarms.push(f);
  }
  const matched = truth.expected.filter((_, i) => matchedIdx.has(i));
  const missed = truth.expected.filter((_, i) => !matchedIdx.has(i));
  const counted = matched.length + falseAlarms.length;
  return {
    recall: truth.expected.length === 0 ? null : matched.length / truth.expected.length,
    matched, missed, false_alarms: falseAlarms,
    precision: counted === 0 ? null : matched.length / counted,
  };
}

// ---------------------------------------------------------------- the pipeline's side

type Rec = Record<string, unknown>;
const isRec = (v: unknown): v is Rec => typeof v === "object" && v !== null && !Array.isArray(v);

/** The problems a draft reports, in the same vocabulary as the judge's issues. Nothing is invented: each comes from a computed feature. */
export function issuesFromDraft(draft: Draft): Issue[] {
  const out: Issue[] = [];
  const f = draft.details.features;
  const x4 = f.x4 as Rec;
  if (typeof x4["x4"] === "number") {
    for (const id of (x4["undocumented_ids"] as string[]) ?? []) out.push({ category: "MISSING_DOCUMENT", ref: id });
  }
  const x5 = f.x5 as Rec;
  if (typeof x5["x5"] === "number") {
    for (const id of (x5["late"] as string[]) ?? []) out.push({ category: "REPORT_LATE", ref: id });
    for (const id of (x5["missing"] as string[]) ?? []) out.push({ category: "REPORT_MISSING", ref: id });
  }
  const sc = f.screening as Rec;
  if (isRec(sc) && sc["x6"] !== "INCOMPLETE") {
    const parties: string[] = [];
    for (const g of ["confirmed", "conflicting", "unverified"]) {
      for (const pair of (sc[g] as [string, string][]) ?? []) if (!parties.includes(pair[0])) parties.push(pair[0]);
    }
    for (const p of parties) out.push({ category: "WATCHLIST_MATCH", ref: p });
  }
  for (const c of draft.details.claims.items) if (c.status === "CONTRADICTED") out.push({ category: "NARRATIVE_MISMATCH", ref: c.subject });
  return out;
}

export interface PipelineSummary {
  decision: string;
  level: Level | null;
  psi: number | null;
  score: number | null; // psi x 100, only for comparing spread
  triggers: string[];
  profile: Rec;
  issues: Issue[];
}

export function summarizeDraft(draft: Draft): PipelineSummary {
  const psi = typeof draft.result["psi"] === "number" ? (draft.result["psi"] as number) : null;
  return {
    decision: String(draft.result["decision"]),
    level: levelOfDecision(String(draft.result["decision"])),
    psi,
    score: psi === null ? null : psi * 100,
    triggers: Array.isArray(draft.result["triggers"]) ? (draft.result["triggers"] as string[]) : [],
    profile: draft.profile,
    issues: issuesFromDraft(draft),
  };
}

// ---------------------------------------------------------------- statistics over repeated runs

export function mean(xs: readonly number[]): number | null {
  return xs.length === 0 ? null : xs.reduce((a, b) => a + b, 0) / xs.length;
}

/** Sample standard deviation (n - 1); 0 for a single value. */
export function sd(xs: readonly number[]): number | null {
  if (xs.length === 0) return null;
  if (xs.length === 1) return 0;
  const m = mean(xs) as number;
  return Math.sqrt(xs.reduce((a, x) => a + (x - m) ** 2, 0) / (xs.length - 1));
}

export type Method = "judge" | "pipeline";

export interface RunRecord {
  scenario: string;
  method: Method;
  repeat: number;
  ok: boolean;
  code?: string;
  score: number | null;
  level: Level | null;
  found: Issue[];
  recall: number | null;
  false_alarms: number;
}

export interface GroupSummary {
  scenario: string;
  method: Method;
  runs: number;
  failed: number;
  score: { mean: number; sd: number; min: number; max: number; range: number } | null;
  levels: Record<string, number>;
  modal_level: Level | null;
  agreement: number | null; // share of runs with the most common level
  recall: number | null; // mean over runs; null when the scenario has no planted problems
  false_alarms: number; // mean per run
}

const LEVEL_ORDER: Level[] = ["PASS", "REVIEW", "ALERT", "RESTRICT"];

export function summarizeGroup(scenario: string, method: Method, runs: readonly RunRecord[]): GroupSummary {
  const ok = runs.filter((r) => r.ok);
  const scores = ok.map((r) => r.score).filter((s): s is number => s !== null);
  const levels: Record<string, number> = {};
  for (const r of ok) if (r.level) levels[r.level] = (levels[r.level] ?? 0) + 1;
  let modal: Level | null = null;
  for (const l of LEVEL_ORDER) if ((levels[l] ?? 0) > (levels[modal ?? ""] ?? 0)) modal = l;
  const withLevel = ok.filter((r) => r.level !== null).length;
  const recalls = ok.map((r) => r.recall).filter((x): x is number => x !== null);
  return {
    scenario, method, runs: ok.length, failed: runs.length - ok.length,
    score: scores.length ? { mean: mean(scores) as number, sd: sd(scores) as number, min: Math.min(...scores), max: Math.max(...scores), range: Math.max(...scores) - Math.min(...scores) } : null,
    levels, modal_level: modal,
    agreement: modal && withLevel ? (levels[modal] as number) / withLevel : null,
    recall: mean(recalls),
    false_alarms: ok.length ? (mean(ok.map((r) => r.false_alarms)) as number) : 0,
  };
}

export interface BenchmarkSummary {
  groups: GroupSummary[];
  overall: Record<Method, { scenarios: number; mean_sd: number | null; mean_range: number | null; mean_agreement: number | null; mean_recall: number | null; false_alarms_per_run: number | null; runs: number; failed: number }>;
  severe: Record<Method, { scenario: string; runs: number; misses: number } | null>;
  clean: Record<Method, { scenario: string; runs: number; false_alarm_runs: number } | null>;
}

export const SEVERE_SCENARIO = "s3-confirmed-match";
export const CLEAN_SCENARIO = "s1-clean";
export const HIGH_SCORE = 75; // a score at or above this counts as "looks fine" (the pipeline's own review line is 0.75)

export function summarizeRuns(runs: readonly RunRecord[]): BenchmarkSummary {
  const keys = [...new Set(runs.map((r) => `${r.scenario}\u0000${r.method}`))].sort();
  const groups = keys.map((k) => {
    const [scenario, method] = k.split("\u0000") as [string, Method];
    return summarizeGroup(scenario, method, runs.filter((r) => r.scenario === scenario && r.method === method));
  });
  const methods: Method[] = ["judge", "pipeline"];
  const num = (xs: (number | null | undefined)[]) => mean(xs.filter((x): x is number => typeof x === "number"));
  const overall = {} as BenchmarkSummary["overall"];
  const severe = {} as BenchmarkSummary["severe"];
  const clean = {} as BenchmarkSummary["clean"];
  for (const m of methods) {
    const g = groups.filter((x) => x.method === m);
    overall[m] = {
      scenarios: g.length,
      mean_sd: num(g.map((x) => x.score?.sd)), mean_range: num(g.map((x) => x.score?.range)),
      mean_agreement: num(g.map((x) => x.agreement)), mean_recall: num(g.map((x) => x.recall)),
      false_alarms_per_run: g.length ? num(g.map((x) => x.false_alarms)) : null,
      runs: g.reduce((a, x) => a + x.runs, 0), failed: g.reduce((a, x) => a + x.failed, 0),
    };
    const sr = runs.filter((r) => r.method === m && r.scenario === SEVERE_SCENARIO && r.ok);
    severe[m] = sr.length ? { scenario: SEVERE_SCENARIO, runs: sr.length, misses: sr.filter((r) => r.level === "PASS" || (r.score !== null && r.score >= HIGH_SCORE)).length } : null;
    const cr = runs.filter((r) => r.method === m && r.scenario === CLEAN_SCENARIO && r.ok);
    clean[m] = cr.length ? { scenario: CLEAN_SCENARIO, runs: cr.length, false_alarm_runs: cr.filter((r) => r.level === "ALERT" || r.level === "RESTRICT").length } : null;
  }
  return { groups, overall, severe, clean };
}
