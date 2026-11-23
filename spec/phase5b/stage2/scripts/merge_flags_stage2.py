"""Phase 5b stage 2: merge judge flags (and pipeline contradicted claims) into distinct issues. Deterministic; no model calls.
Rule (set before reading any stage 2 flag): inside one project, two flags are the same issue if their sets of figures
(numbers, 'X million' read as X*1e6, figures below 1,000 ignored) share at least two figures or have Jaccard >= 0.5;
flags with fewer than 2 figures merge when their word sets (letters only, stop words dropped) have Jaccard >= 0.6.
Pipeline origin: each distinct contradicted claim (project, subject, attribute, value). The pipeline's UNSTABLE_EXTRACTION reason is a process reason, not a statement about the documents, and is reported but not read."""
import json, re, sys, collections, random, hashlib
res, out = sys.argv[1], sys.argv[2]
recs = json.load(open(res))["records"]
STOP = set("the a an of in to and or for is are was were that this which with by on as at from be it its not does do than their there has have had amount total state states while but reported report records record fund funds stated shows show".split())
def figs(t):
    s = set()
    for m in re.finditer(r"(\d[\d,]*(?:\.\d+)?)\s*(million)?", t, re.I):
        try: v = float(m.group(1).replace(",", ""))
        except ValueError: continue
        if m.group(2): v *= 1e6
        if v >= 1000: s.add(round(v, 2))
    return s
def words(t): return {w for w in re.findall(r"[a-z]+", t.lower()) if w not in STOP and len(w) > 2}
items = []
for r in recs:
    if r["method"] == "judge":
        for f in r["flags"]:
            txt = (f["ref"] + ": " + f["detail"]).strip()
            items.append({"project": r["project_id"], "origin": "judge", "repeat": r["repeat"], "category": f["category"], "text": txt})
cl = {}
for r in recs:
    if r["method"] == "pipeline":
        for c in r["pipeline"]["claims"]:
            if c["status"] == "CONTRADICTED":
                k = (r["project_id"], c["subject"], c["attribute"], c["value"], c["unit"])
                cl.setdefault(k, {"project": r["project_id"], "origin": "pipeline", "repeat": [], "category": "CONTRADICTED_CLAIM",
                    "text": f"{c['subject']} {c['attribute']}: the document line \"{' '.join(c['quote'].split())[:160]}\" was read as {c['value']:,} {'million USD' if c['unit'] == 'million usd' else c['unit'].upper()}, which conflicts with the reference record."})["repeat"].append(r["repeat"])
for v in cl.values(): v["repeat"] = v["repeat"][0]; items.append(v)
par = list(range(len(items)))
def find(i):
    while par[i] != i: par[i] = par[par[i]]; i = par[i]
    return i
F = [figs(i["text"]) for i in items]; W = [words(i["text"]) for i in items]
for i in range(len(items)):
    for j in range(i):
        if items[i]["project"] != items[j]["project"] or items[i]["origin"] != items[j]["origin"]: continue
        a, b = F[i], F[j]
        if len(a) >= 2 and len(b) >= 2:
            ok = len(a & b) >= 2 or len(a & b) / len(a | b) >= 0.5
        elif a or b:
            ok = bool(a & b) and len(a | b) <= 2
        else:
            ok = len(W[i] & W[j]) / max(1, len(W[i] | W[j])) >= 0.6
        if ok: par[find(i)] = find(j)
groups = collections.defaultdict(list)
for i in range(len(items)): groups[find(i)].append(i)
issues = []
for g in groups.values():
    mem = [items[i] for i in g]
    rep = sorted(mem, key=lambda m: (len(m["text"]) // 40, m["text"]))[len(mem) // 2]   # median-length member, ties by text
    issues.append({"project": mem[0]["project"], "origin": mem[0]["origin"], "n_members": len(mem), "n_runs": len({m["repeat"] for m in mem}),
                   "category": rep["category"], "text": rep["text"], "members": [m["text"] for m in mem]})
issues.sort(key=lambda x: (x["project"], x["origin"], x["text"]))
for k, x in enumerate(issues, 1): x["key"] = f"K{k:03d}"
json.dump(issues, open(out, "w"), indent=1)
print("flags", len(items), "distinct issues", len(issues), collections.Counter(x["origin"] for x in issues))
print(collections.Counter(x["project"] for x in issues))
