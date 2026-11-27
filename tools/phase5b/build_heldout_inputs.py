"""Held-out test: build pipeline inputs (ledgers) from the GCF IATI activities file. Deterministic, no model calls.
Same logic and frozen mapping v2 as spec/phase5b/stage2/scripts/build_inputs_stage2.py; only the source differs (one XML file, not one CSV per project).
Usage: python3 -I build_heldout_inputs.py <saved gcf-activities file> <draw json> <out dir> [excerpt dir]
The browser-saved copy has unescaped '&' and one '<' in text; step 0 escapes them (no other change) so the file parses."""
import re, json, sys, os, hashlib
import xml.etree.ElementTree as ET
SRC, DRAW, OUT = sys.argv[1], sys.argv[2], sys.argv[3]
SP = sys.argv[4] if len(sys.argv) > 4 else None
ASOF = "2026-11-04"   # frozen mapping v2 as-of date, same as stage 1 and 2
raw = open(SRC, "rb").read()
print("source sha256", hashlib.sha256(raw).hexdigest())
s = raw.decode("utf-8")
if s.startswith("This XML file does not appear"): s = s.split("\n", 1)[1]
s = re.sub(r'&(?!(amp|lt|gt|quot|apos|#\d+|#x[0-9a-fA-F]+);)', '&amp;', s)
s = re.sub(r'<(?![A-Za-z/?!])', '&lt;', s)
root = ET.fromstring(s.encode("utf-8"))
acts = {a.findtext("iati-identifier").split("-")[-1].upper(): a for a in root}
def tx_(a, p): return (a.findtext(p) or "").strip()
def w(p, o):
    os.makedirs(os.path.dirname(p), exist_ok=True)
    open(p, "w", encoding="utf-8").write(json.dumps(o, indent=1, ensure_ascii=False) + "\n")
draw = json.load(open(DRAW)); codes = draw["sample"]["fp"] + draw["sample"]["sap"]
for pid in codes:
    a = acts[pid]; cur = a.get("default-currency") or "USD"
    dates = {d.get("type"): d.get("iso-date") for d in a.findall("activity-date")}
    tx = []
    for t in a.findall("transaction"):
        v = t.find("value")
        tx.append({"t": t.find("transaction-type").get("code"), "desc": tx_(t, "description/narrative"), "date": t.find("transaction-date").get("iso-date"),
                   "v": float((v.text or "0").strip() or 0), "cur": v.get("currency") or cur,
                   "prov": tx_(t, "provider-org/narrative"), "recv": tx_(t, "receiver-org/narrative")})
    rorg = a.find("reporting-org"); rname = tx_(a, "reporting-org/narrative")
    gcf = [x for x in tx if x["t"] == "2" and "gcf" in x["desc"].lower()]
    disb = [x for x in tx if x["t"] == "3"]
    recv = (disb or gcf or tx or [{"recv": rname}])[0]["recv"] or rname
    start = dates.get("2") or dates.get("1"); end = dates.get("4") or dates.get("3")
    award = {"identifier": a.findtext("iati-identifier"), "title": tx_(a, "title/narrative"), "currency": cur,
             "amount_awarded": sum(x["v"] for x in gcf), "award_date": min([x["date"] for x in gcf] or [start or ASOF]),
             "funding_org": {"identifier": "XM-DAC-41317", "name": "Green Climate Fund"},
             "recipient_org": {"identifier": rorg.get("ref"), "name": recv},
             "planned_dates": {"start": start, "end": end or ASOF},
             "documentation_policy": {"cure_days": 30, "excluded_categories": ["iati_disbursement", "iati_commitment"], "required_documents": {}}}
    ledger = {"snapshot_id": f"P5B-{pid}-SPEND", "as_of": ASOF, "currency": cur, "complete": True,
              "transactions": [{"id": f"IATI-{i+1:03d}", "type": "expenditure", "date": x["date"],
                 "category": "iati_disbursement" if x["t"] == "3" else "iati_commitment", "description": x["desc"],
                 "provider_org": x["prov"], "receiver_org": {"name": x["recv"], "identifiers": []}, "value": x["v"], "currency": x["cur"], "documents": []}
                 for i, x in enumerate(tx)]}
    sched = {"as_of": ASOF, "repository_complete": True, "reports": []}
    reg = {"name": "none screened (Phase 5b)", "entries": []}
    cofin = sum(x["v"] for x in tx if x["t"] == "2" and "co-fin" in x["desc"].lower())
    base = [("GCF funding", "committed amount", "total", award["amount_awarded"]),
            ("GCF funding", "cumulative disbursement", "total", sum(x["v"] for x in disb)),
            ("Co-financing", "committed amount", "total", cofin)]
    facts, n = [], 0
    for subj, attr, per, val in base:
        if not val: continue
        forms = [("usd", val), ("count", val)]
        if val % 10000 == 0: forms.append(("million usd", round(val / 1e6, 2)))
        for unit, v in forms:
            n += 1; facts.append({"id": f"IF{n}", "subject": subj, "attribute": attr, "period": per, "value": v, "unit": unit})
    claims = {"snapshot_id": f"P5B-{pid}-CLAIMS", "snapshot_date": ASOF, "facts": facts}
    d = f"{OUT}/{pid}/"
    for nm, o in (("award", award), ("spend_ledger", ledger), ("reporting_schedule", sched), ("register", reg), ("claims_ledger", claims)): w(d + nm + ".json", o)
    if SP:
        rep = ""
        for lab, f in (("PROPOSAL EXCERPT", "proposal_excerpt.txt"), ("ANNUAL PERFORMANCE REPORT EXCERPT", "apr_excerpt.txt")):
            fp = SP + pid + "/" + f
            rep += f"=== {lab} ===\n" + (open(fp, encoding="utf-8").read().strip() if os.path.exists(fp) else "(not available for this project)") + "\n\n"
        open(d + "report.txt", "w", encoding="utf-8").write(rep)
    print(pid, "tx", len(tx), "committed", award["amount_awarded"], "disbursed", sum(x["v"] for x in disb), "cofin", cofin, "facts", len(facts))
