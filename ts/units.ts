// MUSE Aegis v1.1: units and scale. A table that says "million USD" over its columns gives 26.91 where the ledger holds
// 26,910,000 USD. Matching units word for word treats these as different units (the figure is then not compared at all) and
// matching values without the scale would call it a contradiction. This module reads the unit into a base unit and a
// multiplier so that both can be compared on one scale, and detects a difference that is exactly a power of 1,000.

export interface ParsedUnit {
  base: string; // the unit without any scale word, currencies in one spelling (usd, eur)
  mult: number; // 1, 1e3, 1e6 or 1e9
}

const SCALE_WORDS: Record<string, number> = {
  thousand: 1e3, thousands: 1e3, "000": 1e3, "000s": 1e3,
  million: 1e6, millions: 1e6, mil: 1e6,
  billion: 1e9, billions: 1e9,
};
const SCALE_ABBREVIATIONS: Record<string, number> = { k: 1e3, m: 1e6, mn: 1e6, mm: 1e6, b: 1e9, bn: 1e9 }; // only next to a currency
const CURRENCY: Record<string, string> = {
  "us$": "usd", "$": "usd", usd: "usd", "us dollar": "usd", "us dollars": "usd", dollar: "usd", dollars: "usd",
  "€": "eur", eur: "eur", euro: "eur", euros: "eur",
};
const FILLER = new Set(["of", "in", "the", "amount", "amounts", "figures"]);

export function parseUnit(unit: string): ParsedUnit {
  const t = unit.normalize("NFKC").toLowerCase().replace(/['’`]000/g, " 000").replace(/[(),;:]/g, " ").replace(/\s+/g, " ").trim();
  let tokens = t === "" ? [] : t.split(" ");
  // "us dollar(s)" is two words for one currency
  tokens = tokens.reduce<string[]>((out, w, i) => {
    if (w === "us" && (tokens[i + 1] === "dollar" || tokens[i + 1] === "dollars")) out.push("usd");
    else if ((w === "dollar" || w === "dollars") && tokens[i - 1] === "us") return out;
    else out.push(CURRENCY[w] ?? w);
    return out;
  }, []).filter((w) => !FILLER.has(w));
  const rest: string[] = [];
  const scales: number[] = [];
  for (const w of tokens) {
    const word = SCALE_WORDS[w];
    if (word !== undefined) scales.push(word);
    else rest.push(w);
  }
  if (scales.length === 0 && rest.length > 1 && rest.some((w) => w === "usd" || w === "eur")) {
    // abbreviations such as "usd m" or "m usd" count only next to a currency
    const keep: string[] = [];
    for (const w of rest) {
      const ab = SCALE_ABBREVIATIONS[w];
      if (ab !== undefined) scales.push(ab);
      else keep.push(w);
    }
    if (keep.length === 0) return { base: tokens.join(" "), mult: 1 }; // nothing but abbreviations: not a scale
    rest.length = 0;
    rest.push(...keep);
  }
  if (scales.length > 1) return { base: tokens.join(" "), mult: 1 }; // two scale words: do not guess
  return { base: rest.join(" "), mult: scales[0] ?? 1 };
}

/** The value on the base scale, or null for text. */
export function scaled(value: number | string, mult: number): number | null {
  return typeof value === "number" ? value * mult : null;
}

/** Equal on one scale. Exact when no scale is involved; a relative tolerance of 1e-9 absorbs floating point error otherwise. */
export function sameScaled(a: number, b: number, scaledInvolved: boolean): boolean {
  if (!scaledInvolved) return a === b;
  return Math.abs(a - b) <= 1e-9 * Math.max(Math.abs(a), Math.abs(b));
}

/** True when a and b differ only by a factor of 1,000, 1,000,000 or 1,000,000,000 (in either direction). */
export function isScaleSlip(a: number, b: number): boolean {
  if (a === 0 || b === 0 || a < 0 !== b < 0) return false;
  const ratio = Math.max(Math.abs(a), Math.abs(b)) / Math.min(Math.abs(a), Math.abs(b));
  return [1e3, 1e6, 1e9].some((p) => Math.abs(ratio - p) <= 1e-9 * p);
}
