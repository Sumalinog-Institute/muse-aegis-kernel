# Phase 5b stage 1 input builder (as run 2026-11-20). Paths below are the author session paths; edit ATT and SP to rebuild elsewhere.
"""Phase 5b stage 1: build pipeline inputs from IATI CSV + excerpts. Deterministic, no model calls."""
import csv, json, sys, os, hashlib
csv.field_size_limit(sys.maxsize)
ATT = "/mnt/user-data/attachments/b67f8cb1-50b1-5904-862f-040d9e047c30/"
SP = "/tmp/claude-0/-home-claude/b67f8cb1-50b1-5904-862f-040d9e047c30/scratchpad/p5b/stage1/"
OUT = sys.argv[1]
ASOF = "2026-11-04"
PROJ = {"FP001":"2ef0813d-FP001.csv","FP083":"35ce25ec-FP083.csv","FP130":"68ec14d9-fp130.csv","FP137":"044e4cfd-FP137-2.csv",
 "FP005":"557075bf-gcf-fp005.csv","FP008":"1102a0b3-gcf-fp008.csv","FP053":"54cbd01e-gcf-fp053.csv","FP288":"56e055b0-gcf-fp288.csv",
 "SAP003":"742a1c2f-SAP003.csv","SAP039":"732fad96-gcf-sap039.csv"}
def w(p, o):
    os.makedirs(os.path.dirname(p), exist_ok=True)
    open(p, "w", encoding="utf-8").write(json.dumps(o, indent=1, ensure_ascii=False) + "\n")
for pid, fn in PROJ.items():
    rows = list(csv.DictReader(open(ATT + fn, encoding="utf-8"))); top = rows[0]; K = "/iati-activities/iati-activity"
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
    facts = [{"id": "IF1", "subject": "GCF funding", "attribute": "committed amount", "period": "total", "value": award["amount_awarded"], "unit": cur},
             {"id": "IF2", "subject": "GCF funding", "attribute": "cumulative disbursement", "period": "total", "value": sum(x["v"] for x in disb), "unit": cur}]
    claims = {"snapshot_id": f"P5B-{pid}-CLAIMS", "snapshot_date": ASOF, "facts": facts}
    d = f"{OUT}/{pid}/"
    for n, o in (("award", award), ("spend_ledger", ledger), ("reporting_schedule", sched), ("register", reg), ("claims_ledger", claims)): w(d + n + ".json", o)
    rep = ""
    for lab, f in (("PROPOSAL EXCERPT", "proposal_excerpt.txt"), ("ANNUAL PERFORMANCE REPORT EXCERPT", "apr_excerpt.txt")):
        fp = SP + pid + "/" + f
        rep += f"=== {lab} ===\n" + (open(fp, encoding="utf-8").read().strip() if os.path.exists(fp) else "(not available for this project)") + "\n\n"
    open(d + "report.txt", "w", encoding="utf-8").write(rep)
    print(pid, "tx", len(tx), "gcf", award["amount_awarded"], "disb", facts[1]["value"], "chars", len(rep))
