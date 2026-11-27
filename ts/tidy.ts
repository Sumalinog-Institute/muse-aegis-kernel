// MUSE Aegis v1.1: tidy-up of layout text from a PDF, before and after the table repair (tables.ts). Deterministic, no model
// calls. The steps change how the text LOOKS, not what the document says; each one is counted in the report so the operator can
// see what was done. Column positions are kept: a step that changes a width pads with spaces.
//
//   1. Leader dots: form fields print "……49,2…". Runs of dots or "…" are not data; they become spaces.
//   2. Running headers and footers: lines that open or close many pages ("GREEN CLIMATE FUND FUNDING PROPOSAL | PAGE 5 OF 63 B")
//      are blanked, so they do not end up inside table rows.
//   3. Split words: a narrow column wraps a word ("Instituti" / "on", "Curren" / "cy"). The two parts are joined only when the
//      first part is not a word anywhere else in the document and the joined word is.
//   4. European numbers: "26 996 000,00" and "4,10" are written as 26,996,000.00 and 4.10 (same width) when the document as a
//      whole uses decimal commas. A document that does not is left alone, so "12,13" in a list of pages is never changed.
//   5. After the repair: empty brackets "(   )" get one space, "co- funding" becomes "co-funding".

export interface TidyReport { leader_runs: number; running_lines: number; joined_words: number; european_numbers: number }

const SPACED_DEC = /(?<![\d,.])\d{1,3}(?: \d{3})+,\d{2}(?![\d,])/g;
const ANY_DEC = /(?<![\d,.])(\d{1,3}(?: \d{3})+|\d+),(\d{1,2})(?![\d,])/g;
const ENGLISH_DEC = /(?<![\d,])\d{1,3}(?:,\d{3})*\.\d{1,2}(?![\d.])/g;

const letters = (w: string): string => { const m = /^[^\p{L}]*(\p{L}+)[^\p{L}]*$/u.exec(w); return m ? (m[1] as string).toLowerCase() : ""; };

/** The document uses decimal commas: at least two space-grouped amounts with ",dd", or clearly more decimal commas than points. */
export function isEuropean(text: string): boolean {
  const strong = (text.match(SPACED_DEC) ?? []).length;
  if (strong >= 2) return true;
  const weak = (text.match(ANY_DEC) ?? []).length;
  const english = (text.match(ENGLISH_DEC) ?? []).length;
  return weak >= 6 && weak > 2 * english;
}

function stripLeaders(text: string, rep: TidyReport): string {
  // A run of dots is a leader only when it stands alone or is fixed to a figure ("……49,2…"). An ellipsis inside a sentence
  // ("nutritional...etc.", "(GCF, EU…)") is the author's and stays.
  return text.replace(/\S+/g, (tok) => {
    if (/^[….]+$/.test(tok) && (tok.includes("…") || tok.length >= 3)) { rep.leader_runs++; return " ".repeat(tok.length); }
    const m = /^([….]*)(\(?[\d][^….]*?)([….]*)$/.exec(tok);
    if (m && ((m[1] as string).length > 0 || (m[3] as string).length > 0) && /…|\.{3}/.test((m[1] as string) + (m[3] as string))) {
      rep.leader_runs++;
      return " ".repeat((m[1] as string).length) + (m[2] as string) + " ".repeat((m[3] as string).length);
    }
    return tok;
  });
}

function runningLines(text: string, rep: TidyReport): string {
  const pages = text.split("\f").map((p) => p.split("\n"));
  if (pages.length < 4) return text;
  const key = (l: string): string => l.trim().replace(/\s+/g, " ").replace(/\d+/g, "#").replace(/ [A-Z]$/, "");
  const edges = (lines: string[]): number[] => {
    const idx = lines.map((l, i) => (l.trim() === "" ? -1 : i)).filter((i) => i >= 0);
    return [...new Set([...idx.slice(0, 3), ...idx.slice(-3)])];
  };
  const seen = new Map<string, number>();
  for (const lines of pages) for (const k of new Set(edges(lines).map((i) => key(lines[i] as string)))) seen.set(k, (seen.get(k) ?? 0) + 1);
  const need = 3;
  const running = (k: string): boolean => {
    if (k.length < 8 || k.length > 150 || (seen.get(k) ?? 0) < need) return false;
    const letterChars = k.replace(/[^A-Za-z]/g, "");
    const upper = letterChars.replace(/[^A-Z]/g, "").length;
    return /\bPAGE #/i.test(k) || (letterChars.length >= 6 && upper / letterChars.length >= 0.8);
  };
  for (const lines of pages) for (const i of edges(lines)) {
    if (running(key(lines[i] as string))) { lines[i] = ""; rep.running_lines++; }
  }
  return pages.map((p) => p.join("\n")).join("\f");
}

function vocabulary(text: string): Map<string, number> {
  const v = new Map<string, number>();
  for (const w of text.split(/\s+/)) { const l = letters(w); if (l !== "") v.set(l, (v.get(l) ?? 0) + 1); }
  return v;
}

function joinSplitWords(text: string, rep: TidyReport): string {
  const vocab = vocabulary(text);
  const known = (joined: string): boolean => vocab.has(joined) || vocab.has(joined + "s");
  const fragment = (a: string): boolean => a.length >= 4 && (vocab.get(a) ?? 0) <= 1;
  const ok = (a: string, b: string): boolean => fragment(a) && /^\p{Ll}{1,4}$/u.test(b) && (b.length <= 3 || (vocab.get(b) ?? 0) <= 2) && known(a + b);
  const pages = text.split("\f").map((p) => p.split("\n"));
  for (const lines of pages) {
    for (let i = 0; i < lines.length; i++) {
      // 1. the second part follows on the same line after one space
      lines[i] = (lines[i] as string).replace(/(\p{L}+) (\p{Ll}{1,4})(?![\p{L}])/gu, (m, a: string, b: string) => {
        if (!ok(a.toLowerCase(), b)) return m;
        rep.joined_words++; return a + b;
      });
      // 2. the second part is in the same column on one of the next three lines
      const line = lines[i] as string;
      for (const m of [...line.matchAll(/\p{L}{4,}/gu)]) {
        const a = m[0].toLowerCase();
        if (!fragment(a)) continue;
        const s = m.index as number;
        const e = s + m[0].length;
        for (let j = i + 1; j <= Math.min(lines.length - 1, i + 3); j++) {
          const hit = [...(lines[j] as string).matchAll(/\p{Ll}{1,4}(?![\p{L}])/gu)].find((b) => (b.index as number) >= s - 2 && (b.index as number) <= e && (b.index === 0 || /\s/.test((lines[j] as string)[(b.index as number) - 1] as string)) && ok(a, b[0]));
          if (!hit) continue;
          const cur = lines[i] as string;
          const at = cur.indexOf(m[0], s);
          if (at !== s) break;
          const pad = Math.min(hit[0].length, (cur.slice(e).match(/^ */) as RegExpMatchArray)[0].length - 1);
          lines[i] = cur.slice(0, e) + hit[0] + cur.slice(e + Math.max(0, pad));
          lines[j] = (lines[j] as string).slice(0, hit.index as number) + " ".repeat(hit[0].length) + (lines[j] as string).slice((hit.index as number) + hit[0].length);
          rep.joined_words++;
          break;
        }
      }
    }
  }
  return pages.map((p) => p.join("\n")).join("\f");
}

function europeanNumbers(text: string, rep: TidyReport): string {
  if (!isEuropean(text)) return text;
  return text.replace(ANY_DEC, (_m, int: string, dec: string) => { rep.european_numbers++; return `${int.replace(/ /g, ",")}.${dec}`; });
}

/** Before the table repair. */
export function tidyPre(text: string): { text: string; report: TidyReport } {
  const report: TidyReport = { leader_runs: 0, running_lines: 0, joined_words: 0, european_numbers: 0 };
  let t = stripLeaders(text, report);
  t = runningLines(t, report);
  t = joinSplitWords(t, report);
  t = europeanNumbers(t, report);
  return { text: t, report };
}

/** After the table repair. */
export function tidyPost(text: string): string {
  return text
    .replace(/\(\s{2,}\)/g, "( )")
    .replace(/\b((?:[Cc]o|[Nn]on|[Rr]e|[Pp]re|[Pp]ost|[Ss]ub|[Ii]nter|[Mm]ulti|[Cc]ross))- (?!(?:and|or|to)\b)(?=[a-z])/g, "$1-");
}

/** One-line summary for the method text, or "" when nothing was changed. */
export function tidySummary(r: TidyReport): string {
  const parts: string[] = [];
  if (r.european_numbers > 0) parts.push(`${r.european_numbers} decimal-comma numbers rewritten`);
  if (r.joined_words > 0) parts.push(`${r.joined_words} split words joined`);
  if (r.running_lines > 0) parts.push(`${r.running_lines} page header/footer lines removed`);
  return parts.join(", ");
}

/** Short form for the provenance `text_method` (which is limited to 200 characters). */
export function tidyMethod(r: TidyReport): string {
  return `tidy v1: ${r.european_numbers} numbers, ${r.joined_words} words, ${r.running_lines} header lines, ${r.leader_runs} dot runs`;
}
