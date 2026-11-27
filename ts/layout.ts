// MUSE Aegis v1.1: layout text from positioned words. A PDF reader in the browser (pdf.js) returns pieces of text with their
// position on the page. This module places them on a character grid so that the result looks like `pdftotext -layout`: one
// line per text line, cells at their horizontal position, a blank line where the vertical gap is large, and a form feed at the
// start of each new page. The table reader (tables.ts) and the section cutter (sections.ts) then work on this text.
// Pure and deterministic; it knows nothing about pdf.js, so it can be tested with fixed input.

/** A piece of text with its box in PDF points. The origin is the TOP left of the page (y grows downwards). */
export interface TextItem { s: string; x: number; y: number; w: number; h: number }

const median = (xs: number[]): number => {
  if (xs.length === 0) return 0;
  const a = [...xs].sort((p, q) => p - q);
  const m = Math.floor(a.length / 2);
  return a.length % 2 === 1 ? (a[m] as number) : ((a[m - 1] as number) + (a[m] as number)) / 2;
};

export const LAYOUT = {
  CHAR_WIDTH_SCALE: 0.8, // grid pitch = this x the median width of a character
  LINE_TOLERANCE: 0.45, // items whose vertical centres differ by less than this x the median height share a line
  BLANK_LINE_GAP: 1.75, // a gap of more than this x the usual line pitch gives a blank line
  FALLBACK_CHAR_WIDTH: 5,
} as const;

/** The lines of one page. */
export function layoutPage(items: readonly TextItem[], charScale: number = LAYOUT.CHAR_WIDTH_SCALE): string[] {
  const its = items.filter((i) => i.s.trim() !== "" && i.w > 0);
  if (its.length === 0) return [];
  const widths = its.filter((i) => i.s.length >= 4).map((i) => i.w / i.s.length);
  const cw = (median(widths) || LAYOUT.FALLBACK_CHAR_WIDTH) * charScale;
  const tol = LAYOUT.LINE_TOLERANCE * (median(its.map((i) => i.h)) || 10);
  const x0 = Math.min(...its.map((i) => i.x));

  // group into lines by vertical centre
  const byY = [...its].sort((a, b) => a.y + a.h / 2 - (b.y + b.h / 2) || a.x - b.x);
  const rows: { yc: number; items: TextItem[] }[] = [];
  for (const it of byY) {
    const yc = it.y + it.h / 2;
    const row = rows[rows.length - 1];
    if (row !== undefined && yc - row.yc <= tol) { row.items.push(it); row.yc = row.items.reduce((t, i) => t + i.y + i.h / 2, 0) / row.items.length; }
    else rows.push({ yc, items: [it] });
  }
  const pitches = rows.slice(1).map((r, i) => r.yc - (rows[i] as { yc: number }).yc).filter((d) => d > 0);
  const pitch = [...pitches].sort((a, b) => a - b)[Math.floor((pitches.length - 1) / 4)] ?? 1; // a low quartile: pages with few lines still give the usual line pitch

  const out: string[] = [];
  rows.forEach((row, ri) => {
    if (ri > 0 && row.yc - (rows[ri - 1] as { yc: number }).yc > LAYOUT.BLANK_LINE_GAP * pitch) out.push("");
    let line = "";
    let prevEnd = -Infinity;
    for (const it of [...row.items].sort((a, b) => a.x - b.x)) {
      const target = Math.round((it.x - x0) / cw);
      if (line === "") line = " ".repeat(Math.max(0, target));
      else if (it.x - prevEnd < cw * 1.6) line += " "; // the next word of the same phrase: one space, whatever the grid says
      else line += " ".repeat(Math.max(1, target - line.length));
      line += it.s.trim();
      prevEnd = it.x + it.w;
    }
    out.push(line.replace(/\s+$/, ""));
  });
  return out;
}

/** The text of all pages; each page after the first starts with a form feed, as in pdftotext. */
export function layoutText(pages: readonly (readonly TextItem[])[], charScale: number = LAYOUT.CHAR_WIDTH_SCALE): string {
  return pages.map((p, i) => { const ls = layoutPage(p, charScale); if (i > 0 && ls.length > 0) ls[0] = "\f" + ls[0]; return ls.join("\n"); }).join("\n");
}
