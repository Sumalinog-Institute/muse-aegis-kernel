// MUSE Aegis v1.1: repair of table rows in layout text (the text of a PDF with the page layout kept, as `pdftotext -layout`
// writes it). TypeScript port of tools/phase5b/repair_tables.py; the two must give identical output (parity test on real
// documents in tools/phase5b/parity_tables.mjs). Deterministic, no model calls. See that file for the method.
//
// In narrow table columns a cell wraps over several lines, so one figure such as 26,964,532.92 is stored as '26,964,532.9' and
// '2' two lines further down, and the cells of one row are spread over 3 to 5 lines. Only table-like blocks are rewritten;
// other text is not changed. A rewritten row is ONE line, prefixed with the last section heading (and, where found, the row
// label) in square brackets. The prefix is reader-added context taken from the document's own headings and labels.

const CELL_G = /\S+(?: {1,2}\S+)*/g;
const CELL_START = /^\S+(?: {1,2}\S+)*/;
const NUM_FULL = /^(?:\d{1,3}(?:,\d{3})*(?:\.\d{2})?%?|\d+(?:\.\d{2})?%?)$/;
const NUM_BROKEN = /^(?:\d{1,3}(?:,\d{1,2}|(?:,\d{3})*\.\d)|\d{1,3}(?:,\d{3})*,\d{1,2}|\d{1,3}(?:,\d{3})+\.)$/;
const NUM_LIKE = /^\(?\d[\d,.]*%?\)?$/;
const HEADING = /^\s*((?:[A-Z]\.\d{1,2}\.?|[A-Z]\.|\d{1,2}\.\d{1,2}\.?)\s+[A-Za-z(\[].*?)\s*$/;
const SHORT_WORDS = new Set(["of", "in", "to", "on", "by", "at", "as", "an", "or", "is", "it", "be", "no", "vs", "and", "the"]);
const HEADER_WORDS = /committed|disburs|expenditur|amount|instrument|currency|tenor|pricing|mitigatio|adaptatio|country|co-financier/gi;
const FIGURE = /^[(\[]?\d[\d,.]*%?[)\]]?$/;

const words = (s: string): string[] => s.split(/\s+/).filter((w) => w !== "");
const coWrap = (s: string): string => s.replace(/\b(Co)- (?=[a-z])/g, "$1-");
const isHeading = (l: string): RegExpExecArray | null => {
  const m = HEADING.exec(l);
  return m && words(l).length <= 14 && !/\d{1,3},\d{3}/.test(l) ? m : null;
};

function tableLike(lines: string[]): boolean {
  if (lines.length > 14) return false;
  let nums = 0;
  let gaps = 0;
  for (const l of lines) {
    for (const w of words(l)) if (NUM_LIKE.test(w)) nums++;
    gaps = Math.max(gaps, (l.match(/\S {4,}\S/g) ?? []).length);
  }
  return nums >= 1 && (gaps >= 2 || (gaps >= 1 && lines.length >= 2 && lines.length <= 4 && lines.every((l) => l.trim().length <= 90)));
}

function joinFragments(parts: string[]): string[] {
  const out: string[] = [];
  for (const p of parts) {
    if (out.length > 0) {
      const prev = out[out.length - 1] as string;
      const last = prev.split(" ").pop() as string;
      const first = p.split(" ")[0] as string;
      const glue = (): void => {
        out[out.length - 1] = prev + first;
        const rest = p.slice(first.length).trimStart();
        if (rest !== "") out.push(rest);
      };
      if (NUM_BROKEN.test(last) && /^\d{1,3}$/.test(first) && NUM_FULL.test(last + first)) { glue(); continue; }
      if (/^[A-Za-z]{4,}$/.test(last) && /^[a-z]{1,2}$/.test(first) && !SHORT_WORDS.has(first) && last !== last.toLowerCase()) { glue(); continue; }
      if (/^[A-Z]{4,}$/.test(last) && /^[A-Z]$/.test(first)) { glue(); continue; }
    }
    out.push(p);
  }
  return out;
}

interface Cell { line: number; s: number; e: number; text: string }
interface Column { s: number; e: number; members: Cell[]; parts: string[] }

function columns(lines: string[]): Column[] {
  const cells: Cell[] = [];
  lines.forEach((l, i) => { for (const m of l.matchAll(CELL_G)) cells.push({ line: i, s: m.index as number, e: (m.index as number) + m[0].length, text: m[0] }); });
  const cols: Column[] = [];
  const order = [...cells].sort((a, b) => a.s - b.s || a.line - b.line);
  for (const c of order) {
    let best: Column | undefined;
    let bestOv = 0;
    for (const col of cols) {
      if (col.members.some((m) => m.line === c.line)) continue;
      const ov = Math.min(c.e, col.e + 1) - Math.max(c.s, col.s - 1);
      if (ov > bestOv) { best = col; bestOv = ov; }
    }
    if (best === undefined) cols.push({ s: c.s, e: c.e, members: [c], parts: [] });
    else { best.members.push(c); best.s = Math.min(best.s, c.s); best.e = Math.max(best.e, c.e); }
  }
  cols.sort((a, b) => (a.s + a.e) / 2 - (b.s + b.e) / 2);
  for (const col of cols) col.parts = joinFragments([...col.members].sort((a, b) => a.line - b.line).map((m) => m.text));
  return cols;
}

type HeaderLabels = { s: number; e: number; label: string }[];

function headerLabels(lines: string[]): HeaderLabels {
  const out: HeaderLabels = [];
  for (const col of columns(lines)) {
    const label = col.parts.join(" ").trim();
    if (label !== "" && label.length <= 45 && !FIGURE.test(label)) out.push({ s: col.s, e: col.e, label });
  }
  return out;
}

function isHeader(lines: string[]): boolean {
  if (lines.length > 8) return false;
  const text = lines.join(" ");
  if (words(text).some((w) => w.length > 3 && w.includes(",") && FIGURE.test(w))) return false;
  return new Set((text.match(HEADER_WORDS) ?? []).map((w) => w.toLowerCase())).size >= 2;
}

function marginLabel(lines: string[]): string {
  let k = -1;
  let first: RegExpExecArray | null = null;
  for (let i = 0; i < lines.length; i++) {
    const l0 = lines[i] as string;
    const m = l0.startsWith("    ") ? null : CELL_START.exec(l0.trimStart());
    if (m && /^\([a-h]\)/.test(m[0])) { k = i; first = m; break; }
  }
  if (first === null) return "";
  const parts = [first[0]];
  for (const l of lines.slice(k + 1)) {
    if (l.startsWith("     ")) continue;
    const m = CELL_START.exec(l.trimStart());
    if (!m || m[0].startsWith("(") || FIGURE.test(words(m[0])[0] as string)) break;
    parts.push(m[0]);
  }
  return parts.length <= 6 ? coWrap(parts.join(" ")) : "";
}

function repairBlock(lines: string[], header: HeaderLabels | null): string {
  const row: string[] = [];
  for (const col of columns(lines)) {
    for (let part of col.parts) {
      if (header && FIGURE.test(part)) {
        let best: string | undefined;
        let bestOv = 0;
        for (const h of header) {
          const ov = Math.min(col.e, h.e + 3) - Math.max(col.s, h.s - 3);
          if (ov > bestOv) { best = h.label; bestOv = ov; }
        }
        if (best !== undefined) part = `${best}: ${part}`;
      }
      row.push(part);
    }
  }
  return coWrap(row.join(" "));
}

export function repairTables(text: string): { text: string; blocks: number } {
  const out: string[] = [];
  let block: string[] = [];
  let n = 0;
  let heading = "";
  let header: HeaderLabels | null = null;
  let label = "";
  let fresh = false;

  const split = (lines: string[]): string[][] => {
    const segs: string[][] = [];
    let cur: string[] = [];
    for (const l of lines) {
      const isHead = isHeading(l) !== null;
      const isRow = lines.length > 14 && /^\s*\((?:[ivx]+|[a-z])\)\s/.test(l);
      const isLabel = /^ {0,2}\([a-h]\)\s/.test(l) && cur.some((x) => words(x).some((w) => NUM_LIKE.test(w)));
      if ((isHead || isRow || isLabel) && cur.length > 0) { segs.push(cur); cur = []; }
      cur.push(l);
    }
    if (cur.length > 0) segs.push(cur);
    return segs;
  };

  const flushOne = (b: string[]): void => {
    if (b.length === 0) return;
    // heading lines in front of a table stay as they are, so the section cutter and the reader still see them
    for (;;) {
      const first = b[0];
      if (first === undefined) return;
      const m = isHeading(first);
      if (m === null || tableLike([first])) break;
      out.push(b.shift() as string);
      heading = m[1] as string; header = null; label = "";
    }
    if (b.length === 0) return;
    if (tableLike(b)) {
      const own = marginLabel(b);
      // a label is carried only to a total row or an enumerated row, which belong to the label above them
      const carried = !own && (fresh || /^\s*(?:Total\b|\((?:[ivx]+)\))/.test(b[0] as string)) ? label : "";
      fresh = false;
      if (own) label = own;
      const r = repairBlock(b, header);
      const pre = heading !== "" ? heading.slice(0, 70) + (carried !== "" ? " > " + carried : "") : carried;
      out.push((pre !== "" ? `[${pre}] ` : "") + r);
      n++;
    } else {
      out.push(...b);
      const own = marginLabel(b);
      if (own) { label = own; fresh = true; }
      if (isHeader(b)) header = headerLabels(b);
      for (const l of b) {
        const m = isHeading(l);
        if (m) { heading = m[1] as string; header = null; label = ""; }
      }
    }
  };
  const flush = (): void => {
    if (block.length === 0) return;
    const segs = split(block);
    block = [];
    for (const sg of segs) flushOne(sg);
  };

  for (const l of text.split("\n")) {
    if (l.trim() === "") { flush(); out.push(l); } else block.push(l);
  }
  flush();
  return { text: out.join("\n"), blocks: n };
}
