// MUSE Aegis v1.1: document provenance. The record already holds the fingerprint of the screened TEXT (doc_hash) and a typed
// label (doc_ref). Provenance adds where the document came from and how the text was made from it. It is STATED by the person
// who screens: Aegis does not fetch the address, so it cannot prove that the address served that file. The file fingerprint is
// what makes the statement checkable later: anyone who obtains the file can compare its SHA-256 with the one in the record.

export interface Provenance {
  source_url?: string; // https address the document was retrieved from, without query string or fragment
  retrieved_on?: string; // ISO date YYYY-MM-DD
  file_sha256?: string; // SHA-256 of the original file (for example the PDF), 64 lower-case hex characters
  text_method?: string; // how the screened text was made, for example "pdftotext -layout + table repair v5, section cut v1"
}

export type ProvenanceProblem = "BAD_PROVENANCE" | "BAD_SOURCE_URL" | "BAD_RETRIEVED_ON" | "BAD_FILE_SHA256" | "BAD_TEXT_METHOD";

const KEYS = ["source_url", "retrieved_on", "file_sha256", "text_method"] as const;
const MAX_URL = 500;
const MAX_METHOD = 200;
const CONTROL = /[\u0000-\u001f\u007f]/;

function validUrl(s: string): boolean {
  if (s.length > MAX_URL || /\s/.test(s) || CONTROL.test(s)) return false;
  let u: URL;
  try { u = new URL(s); } catch { return false; }
  // https only; no credentials, no query string and no fragment (these can carry tokens or personal data)
  return u.protocol === "https:" && u.username === "" && u.password === "" && u.search === "" && u.hash === "" && u.hostname.includes(".");
}

/** Checks a provenance block. Returns the cleaned block or the problems. `today` is an ISO date (the server's date). */
export function validateProvenance(u: unknown, today: string): { ok: true; value: Provenance } | { ok: false; problems: ProvenanceProblem[] } {
  if (typeof u !== "object" || u === null || Array.isArray(u)) return { ok: false, problems: ["BAD_PROVENANCE"] };
  const r = u as Record<string, unknown>;
  const problems: ProvenanceProblem[] = [];
  if (Object.keys(r).some((k) => !(KEYS as readonly string[]).includes(k))) problems.push("BAD_PROVENANCE");
  const out: Provenance = {};
  const put = (k: (typeof KEYS)[number], bad: ProvenanceProblem, ok: (s: string) => boolean) => {
    const v = r[k];
    if (v === undefined) return;
    if (typeof v !== "string" || !ok(v)) { problems.push(bad); return; }
    out[k] = v;
  };
  put("source_url", "BAD_SOURCE_URL", validUrl);
  put("retrieved_on", "BAD_RETRIEVED_ON", (s) => /^\d{4}-\d{2}-\d{2}$/.test(s) && s >= "2000-01-01" && s <= today && !Number.isNaN(Date.parse(s + "T00:00:00Z")) && new Date(s + "T00:00:00Z").toISOString().startsWith(s));
  put("file_sha256", "BAD_FILE_SHA256", (s) => /^[0-9a-f]{64}$/.test(s));
  put("text_method", "BAD_TEXT_METHOD", (s) => s.trim() !== "" && s.length <= MAX_METHOD && !CONTROL.test(s));
  if (Object.keys(out).length === 0 && problems.length === 0) problems.push("BAD_PROVENANCE");
  return problems.length > 0 ? { ok: false, problems } : { ok: true, value: out };
}
