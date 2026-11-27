// Evaluation of the browser path (ts/layout.ts + ts/tables.ts + ts/sections.ts) against the pdftotext path (Python reference):
// the same sections must be found and the same figures must appear. Input here is poppler's word boxes, not pdf.js output.
// Usage: [V=1] [SCALE=0.8] node --experimental-strip-types tools/phase5b/eval_layout.mjs <bbox dir> <excerpt dir>
import { layoutText } from "../../ts/layout.ts";
import { repairTables } from "../../ts/tables.ts";
import { cutSection } from "../../ts/sections.ts";
import { readFileSync, readdirSync, existsSync } from "node:fs";
const [B, E] = process.argv.slice(2); // B: word boxes from `pdftotext -bbox <pdf> <name>.html`; E: excerpts of the Python path (<id>/<kind>_excerpt.txt)
const dec = (s) => s.replace(/&lt;/g,"<").replace(/&gt;/g,">").replace(/&quot;/g,'"').replace(/&#39;/g,"'").replace(/&amp;/g,"&");
function pages(html) {
  const out = [];
  for (const pm of html.matchAll(/<page[^>]*>([\s\S]*?)<\/page>/g)) {
    const items = [];
    for (const m of pm[1].matchAll(/<word xMin="([\d.]+)" yMin="([\d.]+)" xMax="([\d.]+)" yMax="([\d.]+)">([\s\S]*?)<\/word>/g))
      items.push({ s: dec(m[5]), x: +m[1], y: +m[2], w: +m[3] - +m[1], h: +m[4] - +m[2] });
    out.push(items);
  }
  return out;
}
const figs = (t) => { const m = new Map(); for (const w of t.split(/\s+/)) if (/^\(?\d[\d,.]*%?\)?$/.test(w) && /\d{3}|\./.test(w)) m.set(w, (m.get(w) || 0) + 1); return m; };
const overlap = (a, b) => { let i = 0, ta = 0; for (const [k, v] of a) { ta += v; i += Math.min(v, b.get(k) || 0); } return ta ? i / ta : 1; };
const SCALE = process.env.SCALE ? +process.env.SCALE : undefined;
let sum = 0; let found = 0, same = 0, tot = 0;
for (const f of readdirSync(B)) {
  const name = f.replace(".html", ""); const [id, kind] = [name.replace(/_(proposal|apr)$/, ""), name.endsWith("_apr") ? "apr" : "proposal"];
  const txt = repairTables(layoutText(pages(readFileSync(`${B}/${f}`, "utf8")), SCALE)).text;
  const s = cutSection(txt, kind);
  const p = `${E}/${id}/${kind}_excerpt.txt`; const py = existsSync(p) ? readFileSync(p, "utf8") : null;
  tot++;
  const ok = (s !== null) === (py !== null);
  if (s && py) { found++; const o1 = overlap(figs(py), figs(s.text)), o2 = overlap(figs(s.text), figs(py)); if (process.env.V) console.log(name.padEnd(22), "TS chars", String(s.text.length).padStart(6), "PY chars", String(py.length).padStart(6), "figs PY->TS", o1.toFixed(2), "TS->PY", o2.toFixed(2)); sum += Math.min(o1, o2); if (o1 > 0.95 && o2 > 0.95) same++; }
  else if (process.env.V) console.log(name.padEnd(22), s ? "TS found, PY none" : py ? "PY found, TS NONE" : "both none");
}
console.log(process.env.SCALE, { tot, both_found: found, figures_agree_95: same, mean_overlap: +(sum / Math.max(1, found)).toFixed(4) });
{
  let extra = 0, missing = 0, total = 0;
  for (const f of readdirSync(B)) {
    const name = f.replace(".html", ""); const id = name.replace(/_(proposal|apr)$/, ""), kind = name.endsWith("_apr") ? "apr" : "proposal";
    const txt = repairTables(layoutText(pages(readFileSync(`${B}/${f}`, "utf8")), SCALE)).text; const s = cutSection(txt, kind);
    const p = `${E}/${id}/${kind}_excerpt.txt`; if (!s || !existsSync(p)) continue;
    const a = figs(readFileSync(p, "utf8")), b = figs(s.text);
    for (const [k, v] of b) { total += v; extra += Math.max(0, v - (a.get(k) || 0)); }
    for (const [k, v] of a) missing += Math.max(0, v - (b.get(k) || 0));
    for (const [k, v] of b) if (v > (a.get(k) || 0)) console.log("  only TS:", name, k);
  }
  console.log({ figures_in_TS: total, only_in_TS: extra, only_in_PY: missing });
}
