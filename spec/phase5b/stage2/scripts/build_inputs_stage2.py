"""Phase 5b stage 2 (same logic and mapping v2 as tools/phase5b/build_inputs.py; only the project list and paths differ): build pipeline inputs from IATI CSV + excerpts. Deterministic, no model calls."""
import csv, json, sys, os, hashlib
csv.field_size_limit(sys.maxsize)
IATI = "/home/claude/p5b_stage2/iati/"
SP = "/home/claude/p5b_stage2/excerpts/"
OUT = sys.argv[1]
ASOF = "2026-11-04"   # same as-of date as stage 1 (frozen mapping v2)
PROJ = {k: k + ".csv" for k in sys.argv[2:]}
def w(p, o):
    os.makedirs(os.path.dirname(p), exist_ok=True)
    open(p, "w", encoding="utf-8").write(json.dumps(o, indent=1, ensure_ascii=False) + "\n")
for pid, fn in PROJ.items():
    rows = list(csv.DictReader(open(IATI + fn, encoding="utf-8-sig"))); top = rows[0]; K = "/iati-activities/iati-activity"
    cur = top.get("@default-currency") or "USD"
    dates, tx = {}, []
    if top.get("/activity-date@iso-date"): dates[top["/activity-date@type"]] = top["/activity-date@iso-date"]
    for r in rows[1:]:
        if r[K] == "/activity-date": dates[r["/activity-date@type"]] = r["/activity-date@iso-date"]
        elif r[K] == "/transaction":
            t = r["/transaction/transaction-type@code"]; desc = r["/transaction/description/narrative"]
            tx.append({"t": t, "desc": desc, "date": r["/transaction/transaction-date@iso-date"], "v": float(r["/transaction/value"] or 0),
                       "cur": r["/transaction/value@currency"] or cur, "prov": r["/transaction/provider-org/narrative"], "recv": r["/transaction/receiver-org/narrative"]})
    gcf = [x for x in tx if x["t"] == "2" and "gcf" in x["desc"].lower()]
    disb = [x for x in tx if x["t"] == "3"]
    recv = (disb or gcf or tx or [{"recv": top["/reporting-org/narrative"]}])[0]["recv"] or top["/reporting-org/narrative"]
    start = dates.get("2") or dates.get("1"); end = dates.get("4") or dates.get("3")
    award = {"identifier": top["/iati-identifier"], "title": top["/title/narrative"], "currency": cur,
             "amount_awarded": sum(x["v"] for x in gcf), "award_date": min([x["date"] for x in gcf] or [start or ASOF]),
             "funding_org": {"identifier": "XM-DAC-41317", "name": "Green Climate Fund"},
             "recipient_org": {"identifier": top["/reporting-org@ref"], "name": recv},
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
    # Mapping v2 (2026-11-21): the same IATI facts, each written once per unit form a document may use.
    # Added only when lossless: "usd" and "count" for the full number (a bare table number gets either label from the model);
    # "million usd" only when the value is an exact multiple of 10,000 (so a two-decimal figure in a document equals it exactly).
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
    for n, o in (("award", award), ("spend_ledger", ledger), ("reporting_schedule", sched), ("register", reg), ("claims_ledger", claims)): w(d + n + ".json", o)
    rep = ""
    for lab, f in (("PROPOSAL EXCERPT", "proposal_excerpt.txt"), ("ANNUAL PERFORMANCE REPORT EXCERPT", "apr_excerpt.txt")):
        fp = SP + pid + "/" + f
        rep += f"=== {lab} ===\n" + (open(fp, encoding="utf-8").read().strip() if os.path.exists(fp) else "(not available for this project)") + "\n\n"
    open(d + "report.txt", "w", encoding="utf-8").write(rep)
    print(pid, "tx", len(tx), "gcf", award["amount_awarded"], "disb", facts[1]["value"], "chars", len(rep))
