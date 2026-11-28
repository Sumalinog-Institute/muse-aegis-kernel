"""Held-out test: choose the excerpt of each document and write report.txt inputs. Rule fixed before any result (28 Nov 2026):
1. The frozen browser reader's section is used when it found one.
2. Exception: if the reader's section is shorter than 1,000 characters and the reference section (pdftotext -layout + the stage 2 cut rules) is at least 3 times longer,
   the reference section is used (the reader returned a table-of-contents entry).
3. If the reader found no section, the reference section is used when it exists ("fallback").
4. If neither found one, the document has no excerpt ("(not available for this project)").
Usage: python3 -I build_heldout_excerpts.py <rd dir (reader json per document)> <pdf dir with <P>_<kind>*.pdf links> <out excerpt dir> <manifest out> <P>.."""
import json, os, re, subprocess, sys, hashlib, glob, importlib.util
RD, PDFS, OUT, MAN, *PROJ = sys.argv[1:]
spec = importlib.util.spec_from_file_location("stage2cut", os.path.join(os.path.dirname(os.path.abspath(__file__)), "../../spec/phase5b/stage2/scripts/cut_excerpts_stage2.py"))
src = open(spec.origin).read().split("meta = {}")[0].replace("D = sys.argv[1]; PROJ = sys.argv[2:]", "")
ns = {"re": re, "os": os, "sys": sys, "json": json, "hashlib": hashlib}; exec(src, ns)
cut, RULES = ns["cut"], ns["RULES"]
man = []
for p in PROJ:
    for kind in ("proposal", "apr"):
        r = json.load(open(f"{RD}/{p}_{kind}.json"))
        pdf = glob.glob(f"{PDFS}/{p}_{kind}*.pdf")[0]
        txt = subprocess.run(["pdftotext", "-layout", pdf, "-"], capture_output=True, text=True, errors="replace").stdout
        open("/tmp/_ref.txt", "w").write(txt)
        ref = cut("/tmp/_ref.txt", RULES[kind]); ref_txt = ref[2] if ref else None
        rd_txt = r["text"] if r["ok"] else None
        how, use = "none", None
        if rd_txt and not (len(rd_txt) < 1000 and ref_txt and len(ref_txt) >= 3 * len(rd_txt)): how, use = "reader", rd_txt
        elif ref_txt: how, use = ("reference (reader section too short)" if rd_txt else "reference (reader found none)"), ref_txt
        d = f"{OUT}/{p}/"; os.makedirs(d, exist_ok=True)
        fn = d + ("proposal_excerpt.txt" if kind == "proposal" else "apr_excerpt.txt")
        if os.path.exists(fn): os.remove(fn)
        if use: open(fn, "w").write(use.strip() + "\n")
        man.append({"project": p, "kind": kind, "pdf": os.path.basename(pdf), "pdf_sha256": hashlib.sha256(open(pdf, "rb").read()).hexdigest(), "pages": r["pages"],
                    "reader": ("section %d chars" % len(rd_txt)) if rd_txt else r["problem"], "reference": ("section %d chars" % len(ref_txt)) if ref_txt else "not found",
                    "used": how, "chars": len(use) if use else 0, "excerpt_sha256": hashlib.sha256((use.strip() + "\n").encode()).hexdigest() if use else None, "tidy": r["tidy"]})
json.dump(man, open(MAN, "w"), indent=1)
from collections import Counter; print(Counter((m["kind"], m["used"]) for m in man))
