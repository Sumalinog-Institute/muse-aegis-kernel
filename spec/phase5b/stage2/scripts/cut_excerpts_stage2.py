"""Phase 5b stage 2: one rule set for all projects (no per-project rules). Text from `pdftotext -layout`.
Proposal: 'B.2. Project Financing Information' .. 'B.3.'  (older template), else '(C.) FINANCING INFORMATION' .. 'C.3-9 / D.1'.
APR: 'Section 3: Financial Information' .. 'Section 4' (CY2024 form) or 'FINANCIAL INFORMATION' .. 'E.4-9 / F / G' (2025 form).
Of all heading hits, only a section that ends at its end heading is accepted; of those the longest is used (skips table-of-contents hits). Cap 14000 characters."""
import re, os, sys, json, hashlib
D = sys.argv[1]; PROJ = sys.argv[2:]
RULES = {
 "proposal": [(r"^\s*B\.2\.\s*Project Financing Information", r"^\s*B\.3\."),
              (r"^\s*(C\.\s*)?FINANCING INFORMATION\s*$", r"^\s*(C\.[3-9]\b|D\.1\b)")],
 "apr": [(r"^(APR CY2024 )?(\[APR CY2024\] )?\.?\s*Section 3: Financial Information", r"^(APR CY2024 )?Section 4"),
         (r"^\s*FINANCIAL INFORMATION\s*$", r"^\s*(E\.[4-9]\.|F\.\s?\d|Section F|SECTION F|G\.\s?\d)")]}
def cut(path, rules, cap=14000):
    lines = open(path, errors="replace").read().split("\n")
    best = None
    for sr, er in rules:
        for s in [i for i,l in enumerate(lines) if re.search(sr,l,re.I)]:
            e = next((i for i in range(s+1,len(lines)) if re.search(er,lines[i],re.I)), None)
            note = ""
            if e is None or sum(len(x)+1 for x in lines[s:e]) > cap:
                tot=0; e2=s
                while e2 < len(lines) and tot < cap: tot += len(lines[e2])+1; e2 += 1
                e = e2; note = "capped"
            txt = "\n".join(lines[s:e])
            key=(note!='capped',len(txt))
            if best is None or key > best[5]: best = (s+1, e, txt, note, sr, key)
    return best if best and best[3] != 'capped' else None   # a section that never reaches its end heading is not accepted
meta = {}
for k in PROJ:
    d = os.path.join(D, "excerpts", k); os.makedirs(d, exist_ok=True)
    m = {"project": k}
    for kind in ("proposal","apr"):
        p = os.path.join(D, "txt", f"{k}_{kind}.txt")
        if not os.path.exists(p): m[kind] = {"status":"no document"}; continue
        r = cut(p, RULES[kind])
        if not r: m[kind] = {"status":"NOT FOUND"}; continue
        s,e,txt,note = r[:4]
        open(os.path.join(d,f"{kind}_excerpt.txt"),"w").write(txt+"\n")
        m[kind] = {"status":"ok","lines":[s,e],"chars":len(txt),"note":note,"sha256":hashlib.sha256((txt+"\n").encode()).hexdigest()}
    meta[k] = m
    print(k, {kk:(v.get("status"),v.get("chars"),v.get("lines"),v.get("note")) for kk,v in m.items() if kk!="project"})
json.dump(meta, open(os.path.join(D,"excerpts","meta_batch1.json"),"w"), indent=1)
