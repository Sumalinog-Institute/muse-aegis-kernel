// MUSE Aegis v1.1: cutting the financial section out of a GCF funding proposal or annual performance report (layout text, after
// the table repair). TypeScript port of spec/phase5b/stage2/scripts/cut_excerpts_stage2.py: one rule set for all projects, no
// per-project rules. A section is accepted only when it ends at its end heading (this skips table-of-contents hits); of the
// accepted sections the longest is used. A section that never reaches its end heading, or is longer than the cap, is not accepted.

export type DocumentKind = "proposal" | "apr";
export const SECTION_CAP = 14000;

const RULES: Record<DocumentKind, [RegExp, RegExp][]> = {
  proposal: [
    [/^\s*B\.2\.\s*Project\s+Financing\s+Information/i, /^\s*B\.3\./i],
    [/^\s*(C\.\s*)?FINANCING\s+INFORMATION\s*$/i, /^\s*(C\.[3-9]\b|D\.1\b)/i],
  ],
  apr: [
    [/^(APR CY2024\s+)?(\[APR CY2024\]\s+)?\.?\s*Section\s+3:\s*Financial\s+Information/i, /^(APR CY2024\s+)?Section\s+4/i],
    [/^\s*FINANCIAL\s+INFORMATION\s*$/i, /^\s*(E\.[4-9]\.|F\.\s?\d|Section\s+F|G\.\s?\d)/i],
  ],
};

export interface Section { text: string; first_line: number; end_line: number }

/** The financial section of a document, or null when none is found. Line numbers are 1-based (first) and exclusive (end). */
export function cutSection(layoutText: string, kind: DocumentKind, cap = SECTION_CAP): Section | null {
  const lines = layoutText.split("\n");
  let best: { first: number; end: number; text: string; key: [boolean, number] } | null = null;
  let bestCapped = false;
  for (const [startRe, endRe] of RULES[kind]) {
    for (let s = 0; s < lines.length; s++) {
      if (!startRe.test(lines[s] as string)) continue;
      let e = -1;
      for (let i = s + 1; i < lines.length; i++) if (endRe.test(lines[i] as string)) { e = i; break; }
      let capped = false;
      const size = (a: number, b: number) => lines.slice(a, b).reduce((t, x) => t + x.length + 1, 0);
      if (e < 0 || size(s, e) > cap) {
        let tot = 0;
        let e2 = s;
        while (e2 < lines.length && tot < cap) { tot += (lines[e2] as string).length + 1; e2++; }
        e = e2; capped = true;
      }
      const text = lines.slice(s, e).join("\n");
      const key: [boolean, number] = [!capped, text.length];
      if (best === null || key[0] > best.key[0] || (key[0] === best.key[0] && key[1] > best.key[1])) { best = { first: s + 1, end: e, text, key }; bestCapped = capped; }
    }
  }
  return best !== null && !bestCapped ? { text: best.text, first_line: best.first, end_line: best.end } : null;
}

/** The text screened for a project: one marked excerpt per document found. Empty sections are left out. */
export function buildDocumentText(excerpts: { proposal?: string | null; apr?: string | null }): string {
  const parts: string[] = [];
  if (excerpts.proposal) parts.push("=== PROPOSAL EXCERPT ===\n" + excerpts.proposal.replace(/^\n+|\n+$/g, ""));
  if (excerpts.apr) parts.push("=== ANNUAL PERFORMANCE REPORT EXCERPT ===\n" + excerpts.apr.replace(/^\n+|\n+$/g, ""));
  return parts.join("\n\n");
}
