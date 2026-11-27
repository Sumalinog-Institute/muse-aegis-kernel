// Parity check: the TypeScript table reader (ts/tables.ts) must give exactly the text of the Python reference
// (tools/phase5b/repair_tables.py). Usage: node --experimental-strip-types tools/phase5b/parity_tables.mjs <dir with layout .txt files>
// The script runs the Python reference itself on each file and compares the two outputs.
import { repairTables } from "../../ts/tables.ts";
import { cutSection } from "../../ts/sections.ts";
import { readFileSync, readdirSync, mkdtempSync, mkdirSync, writeFileSync, existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const dir = process.argv[2];
if (!dir) { console.error("usage: parity_tables.mjs <dir>"); process.exit(2); }
const here = dirname(fileURLToPath(import.meta.url));
const tmp = mkdtempSync(join(tmpdir(), "parity-"));
let bad = 0, n = 0;
for (const f of readdirSync(dir).filter((x) => x.endsWith(".txt"))) {
  const out = join(tmp, f);
  execFileSync("python3", ["-I", join(here, "repair_tables.py"), join(dir, f), out]);
  n++;
  if (repairTables(readFileSync(join(dir, f), "utf8")).text !== readFileSync(out, "utf8")) { bad++; console.log("DIFFERS:", f); }
}
console.log(`tables: ${n} files, ${bad} differ`);

// Section cutting: the TypeScript cutter must find the same excerpt as spec/phase5b/stage2/scripts/cut_excerpts_stage2.py,
// run here on the repaired text (file names <project>_<proposal|apr>.txt).
const D = join(tmp, "D");
mkdirSync(join(D, "txt"), { recursive: true });
const ids = new Set();
for (const f of readdirSync(dir).filter((x) => /_(proposal|apr)\.txt$/.test(x))) {
  writeFileSync(join(D, "txt", f), repairTables(readFileSync(join(dir, f), "utf8")).text);
  ids.add(f.replace(/_(proposal|apr)\.txt$/, ""));
}
execFileSync("python3", ["-I", join(here, "../../spec/phase5b/stage2/scripts/cut_excerpts_stage2.py"), D, ...ids], { stdio: "ignore" });
let sn = 0, sbad = 0;
for (const f of readdirSync(join(D, "txt"))) {
  const m = /^(.*)_(proposal|apr)\.txt$/.exec(f);
  const got = cutSection(readFileSync(join(D, "txt", f), "utf8"), m[2]);
  const p = join(D, "excerpts", m[1], `${m[2]}_excerpt.txt`);
  const exp = existsSync(p) ? readFileSync(p, "utf8") : null;
  sn++;
  if ((got ? got.text + "\n" : null) !== exp) { sbad++; console.log("SECTION DIFFERS:", f); }
}
console.log(`sections: ${sn} documents, ${sbad} differ`);
process.exit(bad + sbad === 0 ? 0 : 1);
