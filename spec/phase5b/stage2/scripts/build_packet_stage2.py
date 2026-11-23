"""Phase 5b stage 2: build the blind reading packet (method key kept apart). Order of issues shuffled with seed 20261121."""
import json, csv, random, re, sys, hashlib
iss = json.load(open("results/stage2_issues_private.json"))
rng = random.Random(20261121)
order = list(range(len(iss))); rng.shuffle(order)
def where(t):
    w = []
    tl = t.lower()
    if "proposal" in tl: w.append("Funding proposal, financing section (B.2 or C.1)")
    if "annual" in tl or "apr" in tl or "annual performance" in tl:
        sec = sorted(set(re.findall(r"\bE\.[1-9]\b", t)))
        w.append("Annual Performance Report, financial section" + (" " + "/".join(sec) if sec else " (E.1 / E.2 or Section 3)"))
    ids = sorted(set(re.findall(r"IATI-\d{3}", t)))
    if ids or re.search(r"fund'?s? record|reference|transaction|iati|records", tl):
        w.append("Reference sheet" + (" (" + ", ".join(ids) + ")" if ids else ""))
    return "; ".join(w) or "Reference sheet and the document sections for this project"
rows, key = [], {}
for n, i in enumerate(order, 1):
    x = iss[i]; rid = f"S{n:03d}"
    rows.append([rid, x["project"], x["text"], where(x["text"]), "", ""])
    key[rid] = {"key": x["key"], "origin": x["origin"], "n_members": x["n_members"], "n_runs": x["n_runs"], "category": x["category"]}
with open("/home/claude/send/stage2_reading_packet.csv", "w", newline="", encoding="utf-8-sig") as f:
    w = csv.writer(f); w.writerow(["id", "project", "issue", "where to look", "label (Supported / Not supported / Unclear)", "one-line reason"]); w.writerows(rows)
json.dump(key, open("/home/claude/p5b_private_key_stage2.json", "w"), indent=1)
# reference sheets
L = ["# Reference sheets (IATI records) for the stage 2 projects", "",
     "Amounts in USD. These are the \"fund's records\", \"reference records\" or \"transaction records\" that the issues mention. They are not in the document excerpts. Dates are the record dates.", ""]
for p in sorted({r[1] for r in rows}):
    aw = json.load(open(f"/home/claude/p5b_inputs_stage2/{p}/award.json")); led = json.load(open(f"/home/claude/p5b_inputs_stage2/{p}/spend_ledger.json"))
    L += [f"## {p}: {aw['title']}", "", "| Record | Date | Type | Amount | Description | Provider |", "|---|---|---|---|---|---|"]
    g = c = d = 0
    for t in led["transactions"]:
        kind = "Disbursement" if t["category"] == "iati_disbursement" else "Commitment"
        L.append(f"| {t['id']} | {t['date']} | {kind} | {t['value']:,.2f} | {t['description']} | {t['provider_org']} |")
        if kind == "Disbursement": d += t["value"]
        elif "co-fin" in t["description"].lower(): c += t["value"]
        elif "gcf" in t["description"].lower(): g += t["value"]
    L += ["", f"Totals: GCF commitment {g:,.2f}; co-financing commitment {c:,.2f}; disbursements {d:,.2f}.", ""]
open("/home/claude/send/stage2_reference_sheets.md", "w", encoding="utf-8").write("\n".join(L))
print(len(rows), "issues in packet")
