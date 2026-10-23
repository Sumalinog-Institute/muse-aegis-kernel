// MUSE Aegis reference kernel, gate and decision logic. Spec V4.1.
// Pure functions, no dependencies, no I/O. Runs on Node 22+, Deno and Supabase Edge Functions.
//
// Reproducibility notes (spec Section 6):
//  - Only +, -, * on IEEE 754 binary64 numbers (JavaScript Number); no exp or other Math library
//    calls except Math.floor and Math.abs, which are exact.
//  - Fixed evaluation order: ((f_ground * f4) * f5) * f6. Do not reorder or "simplify".
//  - JavaScript never fuses multiply-add and never uses extended-precision intermediates.

export const SPEC_VERSION = "4.1";

// Provisional design parameters (spec Sections 4 and 5). Not validated.
export const PARAMS = {
  W_GROUND: 0.40,
  W4: 0.20,
  W5: 0.15,
  W6: 0.30,
  THETA_DOC: 0.25,
  THETA_STAB: 0.20,
  N_MIN: 10,
  TAU_REVIEW_MICRO: 750000, // tau_review = 0.75 expressed in millionths
  NEAR: 1e-6,
} as const;

export interface Profile {
  x1?: unknown; // extractor instability: number in [0,1] | "INCOMPLETE"
  x2?: unknown; // evidence-grounding deficit
  x3?: unknown; // boilerplate similarity (triage only, never affects decisions)
  x4?: unknown; // documentation deficit: number | "NA" | "INCOMPLETE"
  x5?: unknown; // reporting opacity: number | "NA" | "INCOMPLETE"
  x6?: unknown; // confirmed statutory breach: 0 or 1
  n_applicable?: unknown; // integer count of applicable disbursements (needed when x4 is a number)
  alert_status?: unknown; // "NONE" | "UNVERIFIED" | "CONFLICTING"
}

export interface Result {
  spec_version: string;
  psi: number | null;
  psi_micro: number | null; // floor(psi * 1e6 + 0.5), used for the tau_review comparison
  triggers: string[]; // subset of T1, T2, T3, always in this order
  reasons: string[]; // review reasons when decision is FLAG_FOR_REVIEW
  flags: string[]; // informational flags
  incomplete_fields: string[];
  decision: string;
}

type Checked = { kind: "ok"; v: number } | { kind: "na" } | { kind: "bad"; reason: string };

function check(val: unknown, allowNA: boolean, binary: boolean): Checked {
  if (val === undefined || val === null) return { kind: "bad", reason: "MISSING" };
  if (val === "INCOMPLETE") return { kind: "bad", reason: "INCOMPLETE" };
  if (val === "NA") return allowNA ? { kind: "na" } : { kind: "bad", reason: "NA_NOT_ALLOWED" };
  if (typeof val !== "number" || !Number.isFinite(val)) return { kind: "bad", reason: "INVALID_VALUE" };
  if (val < 0 || val > 1) return { kind: "bad", reason: "OUT_OF_RANGE" };
  if (binary && val !== 0 && val !== 1) return { kind: "bad", reason: "NOT_BINARY" };
  return { kind: "ok", v: val };
}

export function evaluate(p: Profile): Result {
  const incomplete: string[] = [];
  const flags: string[] = [];
  const reasons: string[] = [];
  const triggers: string[] = [];

  const c1 = check(p.x1, false, false);
  const c2 = check(p.x2, false, false);
  const c4 = check(p.x4, true, false);
  const c5 = check(p.x5, true, false);
  const c6 = check(p.x6, false, true);
  const named: [string, Checked][] = [["x1", c1], ["x2", c2], ["x4", c4], ["x5", c5], ["x6", c6]];
  for (const [name, c] of named) {
    if (c.kind === "bad") incomplete.push(`${name}:${c.reason}`);
  }

  // x3 is a triage signal: validated, logged, never used in a decision.
  if (p.x3 !== undefined && p.x3 !== null) {
    if (check(p.x3, false, false).kind === "bad") flags.push("X3_INVALID");
  }
  if (c4.kind === "na") flags.push("X4_NOT_APPLICABLE");
  if (c5.kind === "na") flags.push("X5_NOT_APPLICABLE");

  // n_applicable is required only when x4 is a number.
  let nOk = false;
  let n = 0;
  if (c4.kind === "ok") {
    const cn = p.n_applicable;
    if (cn === undefined || cn === null) incomplete.push("n_applicable:MISSING");
    else if (typeof cn !== "number" || !Number.isInteger(cn) || cn < 0) incomplete.push("n_applicable:INVALID_VALUE");
    else { nOk = true; n = cn; }
  }

  const alertRaw = p.alert_status === undefined || p.alert_status === null ? "NONE" : p.alert_status;
  const alertOk = alertRaw === "NONE" || alertRaw === "UNVERIFIED" || alertRaw === "CONFLICTING";
  if (!alertOk) incomplete.push("alert_status:INVALID_VALUE");

  // Gate triggers (never read psi).
  let small = false;
  if (c6.kind === "ok" && c6.v === 1) triggers.push("T1");
  if (c4.kind === "ok" && nOk && c4.v >= PARAMS.THETA_DOC) {
    if (n >= PARAMS.N_MIN) triggers.push("T2");
    else small = true;
  }
  if (alertOk && alertRaw !== "NONE" && c6.kind === "ok" && c6.v === 0) triggers.push("T3");

  // Kernel: computed only when its four components are valid (NA counts as a factor of 1).
  let psi: number | null = null;
  let micro: number | null = null;
  if (c2.kind === "ok" && c4.kind !== "bad" && c5.kind !== "bad" && c6.kind === "ok") {
    const fG = 1 - PARAMS.W_GROUND * c2.v;
    const f4 = c4.kind === "ok" ? 1 - PARAMS.W4 * c4.v : 1;
    const f5 = c5.kind === "ok" ? 1 - PARAMS.W5 * c5.v : 1;
    const f6 = 1 - PARAMS.W6 * c6.v;
    psi = ((fG * f4) * f5) * f6;
    micro = Math.floor(psi * 1e6 + 0.5);
  }

  // Near-threshold flag (spec Section 6, Level 3).
  let near = false;
  if (psi !== null && Math.abs(psi - 0.75) <= PARAMS.NEAR) near = true;
  if (c1.kind === "ok" && Math.abs(c1.v - PARAMS.THETA_STAB) <= PARAMS.NEAR) near = true;
  if (c4.kind === "ok" && Math.abs(c4.v - PARAMS.THETA_DOC) <= PARAMS.NEAR) near = true;
  if (near) flags.push("NEAR_THRESHOLD");

  // Decision mapping. Precedence: T1 > T3 > T2 > INCOMPLETE > FLAG / PASS.
  let decision: string;
  if (triggers.includes("T1")) decision = "RESTRICTION_RECOMMENDED_PENDING_AUTHORITY";
  else if (triggers.includes("T3")) decision = "ALERT_VERIFICATION_REQUIRED";
  else if (triggers.includes("T2")) decision = "DOCUMENTATION_HOLD_PENDING_REVIEW";
  else if (incomplete.length > 0 || psi === null || micro === null || c1.kind !== "ok") {
    decision = "INCOMPLETE_INPUT_MANUAL_REVIEW";
  } else {
    if (micro < PARAMS.TAU_REVIEW_MICRO) reasons.push("LOW_SCORE");
    if (c1.v >= PARAMS.THETA_STAB) reasons.push("UNSTABLE_EXTRACTION");
    if (small) reasons.push("SMALL_SAMPLE");
    decision = reasons.length > 0 ? "FLAG_FOR_REVIEW" : "SCREENING_PASS_PENDING_STANDARD_CONTROLS";
  }

  return {
    spec_version: SPEC_VERSION,
    psi,
    psi_micro: micro,
    triggers,
    reasons,
    flags,
    incomplete_fields: incomplete,
    decision,
  };
}
