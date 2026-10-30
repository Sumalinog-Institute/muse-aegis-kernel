"""Writes fixtures/grant-xx-nmf-0001-2026-014/<scenario>/*.json and report.txt.

EVERYTHING HERE IS FICTIONAL. Organisation identifiers use the prefix XX- (the ISO 3166 'user-assigned' code),
so none can collide with a real organisation. Field names follow public data standards where they exist
(360Giving grant fields; IATI-style transactions with provider and receiver organisations); the watch list is
modelled on the general shape of public sanctions lists (name, aliases, identifiers, programme, listing date).

The expected values in expected.json come from an INDEPENDENT Python oracle in this file, using the proposed rules
in spec/FEATURES.md. The TypeScript implementation built later must reproduce them.
"""
import copy
import json
import os
import re
import unicodedata
from fractions import Fraction

OUT = os.path.join(os.path.dirname(__file__), "..", "fixtures", "grant-xx-nmf-0001-2026-014")
AS_OF = "2026-10-26"
CURE_DAYS = 30
LEGAL_SUFFIXES = {"ltd", "limited", "co", "company", "inc", "incorporated", "corp", "corporation", "llc", "plc", "gmbh", "sa", "fze"}

# ---------------------------------------------------------------- base data

AWARD = {
    "fictional": True,
    "identifier": "XX-NMF-0001-2026-014",
    "title": "Neighbourhood Digital Skills and Safe Spaces",
    "description": "Fictional grant: digital skills workshops and safe community spaces for young people (all names and numbers are invented).",
    "currency": "USD",
    "amount_awarded": 240000,
    "award_date": "2025-12-10",
    "funding_org": {"identifier": "XX-NMF-0001", "name": "Northern Meridian Fund"},
    "recipient_org": {"identifier": "XX-BWA-0420", "name": "Brightwater Neighbourhood Alliance",
                      "identifiers": [{"scheme": "XX-REG", "value": "BW-20418"}]},
    "planned_dates": {"start": "2026-01-01", "end": "2026-12-31"},
    "planned_disbursements": [
        {"date": "2026-01-15", "value": 96000, "note": "on signing"},
        {"date": "2026-07-15", "value": 72000, "note": "after Q1 report approved"},
        {"date": "2026-10-15", "value": 72000, "note": "after Q2 report and mid-term evaluation approved"},
    ],
    "amount_disbursed_to_date": 168000,
    "budget_lines": [
        {"category": "personnel", "label": "Personnel", "amount": 120000},
        {"category": "equipment", "label": "Equipment", "amount": 30000},
        {"category": "training", "label": "Training and workshops", "amount": 36000},
        {"category": "travel", "label": "Travel", "amount": 10000},
        {"category": "rent_utilities", "label": "Rent and utilities", "amount": 24000},
        {"category": "subcontract", "label": "Subcontracts", "amount": 20000},
    ],
    "documentation_policy": {
        "cure_days": CURE_DAYS,
        "excluded_categories": ["bank_charges"],
        "required_documents": {
            "personnel": ["payroll_record"],
            "equipment": ["invoice", "receipt"],
            "training": ["invoice"],
            "travel": ["receipt"],
            "rent_utilities": ["invoice"],
            "subcontract": ["contract", "invoice"],
        },
    },
}
CATEGORY_LABEL = {b["category"]: b["label"] for b in AWARD["budget_lines"]}


def tx(i, date, category, desc, payee, value, docs, ids=None):
    return {
        "id": f"TX-2026-{i:03d}", "type": "expenditure", "date": date, "category": category, "description": desc,
        "provider_org": "XX-BWA-0420",
        "receiver_org": {"name": payee, "identifiers": ids or []},
        "value": value, "currency": "USD",
        "documents": [{"type": t, "ref": f"{t[:3].upper()}-{i:03d}", "date": date} for t in docs],
    }


def base_transactions():
    t = []
    n = 1
    for m in range(1, 11):  # personnel, monthly
        t.append(tx(n, f"2026-{m:02d}-28" if m < 10 else "2026-10-25", "personnel", f"Staff salaries, month {m}",
                    "Brightwater payroll account", 9000, ["payroll_record"]))
        n += 1
    t.append(tx(11, "2026-02-12", "equipment", "Laptop set (12 units)", "Halden Office Supplies Ltd", 7800, ["invoice", "receipt"], [{"scheme": "XX-REG", "value": "HOS-1130"}]))
    t.append(tx(12, "2026-03-20", "equipment", "Projector and audio kit", "Halden Office Supplies Ltd", 4200, ["invoice", "receipt"], [{"scheme": "XX-REG", "value": "HOS-1130"}]))
    t.append(tx(13, "2026-05-18", "equipment", "Tablets for workshops (8 units)", "Corvane Electronics Inc", 9800, ["receipt"], [{"scheme": "XX-REG", "value": "CE-9051"}]))  # invoice missing
    t.append(tx(14, "2026-03-05", "training", "Facilitator fees, Q1 workshop series", "Lindqvist Training Partners", 4500, ["invoice"]))
    t.append(tx(15, "2026-06-10", "training", "Workshop materials, Q2", "Pinewood Print & Copy", 1700, ["invoice"]))
    t.append(tx(16, "2026-06-25", "training", "Facilitator fees, Q2 workshop series", "Lindqvist Training Partners", 4500, ["invoice"]))
    t.append(copy.deepcopy(t[-1]))  # the export repeats TX-2026-016 (same id, same content)
    t.append(tx(18, "2026-10-14", "training", "Facilitator fees, Q3 workshop series", "Lindqvist Training Partners", 4500, []))  # within the cure window
    t.append(tx(19, "2026-08-18", "training", "Printed community guides", "Northgate Supply Company", 2300, ["invoice"]))
    t.append(tx(20, "2026-04-22", "travel", "Regional coordination meeting travel", "Various staff reimbursements", 1850, ["receipt"]))
    t.append(tx(21, "2026-08-09", "travel", "Site visit transport", "Various staff reimbursements", 960, ["receipt"]))
    n = 22
    for m in range(1, 11):  # rent, monthly
        t.append(tx(n, f"2026-{m:02d}-03", "rent_utilities", f"Premises rent, month {m}", "Dockside Property Management", 1600, ["invoice"]))
        n += 1
    t.append(tx(32, "2026-04-02", "subcontract", "Community mapping survey", "Meridian Field Services Ltd", 6500, ["contract", "invoice"], [{"scheme": "XX-REG", "value": "MFS-5521"}]))
    t.append(tx(33, "2026-07-20", "subcontract", "Safe-space audit and volunteer training", "Meridian Field Services Ltd", 7200, ["contract"], [{"scheme": "XX-REG", "value": "MFS-5521"}]))  # invoice missing
    t.append(tx(34, "2026-09-04", "subcontract", "Evaluation design support", "Coastal Evaluation Partners", 3000, ["contract", "invoice"]))
    t.append(tx(35, "2026-03-31", "bank_charges", "Bank charges, Q1", "Harbour Savings Bank", 45, []))
    return t


REPORTS = [
    {"id": "R1", "name": "Q1 financial and narrative report", "due_date": "2026-04-30", "submitted_date": "2026-04-28"},
    {"id": "R2", "name": "Q2 financial and narrative report", "due_date": "2026-07-31", "submitted_date": "2026-08-06"},
    {"id": "R3", "name": "Mid-term evaluation report", "due_date": "2026-09-15", "submitted_date": None},
    {"id": "R4", "name": "Q3 financial and narrative report", "due_date": "2026-10-31", "submitted_date": None},
    {"id": "R5", "name": "Annual audit report", "due_date": "2027-03-31", "submitted_date": None},
]

REGISTER = {
    "fictional": True,
    "name": "Consolidated Watchlist (fictional)",
    "entries": [
        {"uid": "W-1001", "type": "entity", "name": "Northgate Supply Co.", "aliases": ["Northgate Supplies"], "identifiers": [{"scheme": "XX-REG", "value": "NS-44021"}], "programme": "FICTIONAL-PROGRAMME-A", "listed_date": "2025-06-02"},
        {"uid": "W-1002", "type": "entity", "name": "Delta Harbour Logistics Co.", "aliases": [], "identifiers": [{"scheme": "XX-REG", "value": "DH-77120"}], "programme": "FICTIONAL-PROGRAMME-A", "listed_date": "2025-09-18"},
        {"uid": "W-1003", "type": "entity", "name": "Corvane Trading FZE", "aliases": [], "identifiers": [{"scheme": "XX-REG", "value": "CT-2207"}], "programme": "FICTIONAL-PROGRAMME-B", "listed_date": "2024-11-21"},
        {"uid": "W-1004", "type": "individual", "name": "Marta Oyelaran-Quist", "aliases": ["M. Oyelaran Quist"], "birth_year": 1971, "identifiers": [], "programme": "FICTIONAL-PROGRAMME-B", "listed_date": "2025-02-11"},
        {"uid": "W-1005", "type": "entity", "name": "Lindqvist Capital Holdings", "aliases": [], "identifiers": [{"scheme": "XX-REG", "value": "LC-8810"}], "programme": "FICTIONAL-PROGRAMME-A", "listed_date": "2025-03-30"},
        {"uid": "W-1006", "type": "entity", "name": "Meridian Fieldworks Trading Co.", "aliases": [], "identifiers": [{"scheme": "XX-REG", "value": "MF-3090"}], "programme": "FICTIONAL-PROGRAMME-B", "listed_date": "2025-07-07"},
    ],
}

# The grantee's own narrative (the document the extractor reads). Two statements are wrong, on purpose.
NARRATIVE = """Brightwater Neighbourhood Alliance: Q2 2026 progress report (fictional).

In 2026-Q2 the Alliance spent 27,000 USD on personnel.
In 2026-Q2 the Alliance spent 9,800 USD on equipment.
In 2026-Q2 the Alliance spent 6,500 USD on training and workshops.
In 2026-Q2 the Alliance spent 4,800 USD on rent and utilities.
The Q2 financial and narrative report was submitted on 2026-07-30.
The Alliance reached 250 beneficiaries in 2026.
We also spent roughly twelve thousand dollars on community outreach.
"""

# The claims a careful extractor should find in a narrative (the vague outreach sentence is deliberately NOT one of them).
LABELS = {"personnel": "Personnel", "equipment": "Equipment", "training and workshops": "Training and workshops", "rent and utilities": "Rent and utilities"}


def claims_from_narrative(text):
    out = []
    for m in re.finditer(r"spent ([\d,]+) USD on (personnel|equipment|training and workshops|rent and utilities)", text):
        out.append((LABELS[m.group(2)], "amount spent", "2026-Q2", int(m.group(1).replace(",", "")), "usd"))
    for m in re.finditer(r"report was submitted on (\d{4}-\d{2}-\d{2})", text):
        out.append(("Q2 financial and narrative report", "submitted on", "2026", m.group(1), "date"))
    for m in re.finditer(r"reached (\d+) beneficiaries", text):
        out.append(("beneficiaries", "number reached", "2026", int(m.group(1)), "count"))
    return out


# ---------------------------------------------------------------- oracle (independent of the TypeScript code)


def cents(v):
    return int(round(v * 100))


def days_between(a, b):
    from datetime import date
    y1, m1, d1 = map(int, a.split("-"))
    y2, m2, d2 = map(int, b.split("-"))
    return (date(y2, m2, d2) - date(y1, m1, d1)).days


def lev(a, b):
    prev = list(range(len(b) + 1))
    for i, ca in enumerate(a, 1):
        cur = [i]
        for j, cb in enumerate(b, 1):
            cur.append(min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (ca != cb)))
        prev = cur
    return prev[-1]


def name_tokens(name):
    s = unicodedata.normalize("NFKC", name).lower()
    toks = re.findall(r"[^\W_]+", s)
    return {t for t in toks if t not in LEGAL_SUFFIXES}


def tok_match(a, b):
    return a == b or (min(len(a), len(b)) >= 5 and lev(a, b) <= 1)


def names_match(a, b):
    A, B = name_tokens(a), name_tokens(b)
    if not A or not B:
        return None
    if A == B:
        return "EXACT"
    short, long_ = (A, B) if len(A) <= len(B) else (B, A)
    if len(long_) - len(short) <= 1 and all(any(tok_match(t, u) for u in long_) for t in short):
        return "SIMILAR"
    return None


def oracle_x4(award, ledger):
    pol = award["documentation_policy"]
    flags = []
    if not ledger.get("complete"):
        return {"x4": "INCOMPLETE", "reason": "LEDGER_INCOMPLETE"}
    seen = {}
    for t in ledger["transactions"]:
        if t["id"] in seen:
            if seen[t["id"]] != t:
                return {"x4": "INCOMPLETE", "reason": "DUPLICATE_ID_CONFLICT"}
            flags.append(f"DUPLICATE_ID:{t['id']}")
            continue
        seen[t["id"]] = t
    rows = [t for t in seen.values() if t["category"] not in pol["excluded_categories"]
            and award["planned_dates"]["start"] <= t["date"] <= award["planned_dates"]["end"]]
    if any(t["currency"] != award["currency"] for t in rows):
        return {"x4": "INCOMPLETE", "reason": "MIXED_CURRENCY"}
    applicable = sum(cents(t["value"]) for t in rows)
    n = len(rows)
    und, pend = 0, 0
    und_ids, pend_ids = [], []
    for t in rows:
        need = set(pol["required_documents"][t["category"]])
        have = {d["type"] for d in t["documents"]}
        if need <= have:
            continue
        if days_between(t["date"], ledger["as_of"]) <= pol["cure_days"]:
            pend += cents(t["value"])
            pend_ids.append(t["id"])
        else:
            und += cents(t["value"])
            und_ids.append(t["id"])
    if n == 0:
        return {"x4": "NA", "n_applicable": 0, "flags": flags}
    x4 = Fraction(und, applicable)
    return {"x4": float(x4), "undocumented_value": und / 100, "applicable_value": applicable / 100,
            "n_applicable": n, "undocumented_ids": und_ids, "pending_ids": pend_ids, "flags": flags}


def oracle_x5(sched):
    if not sched.get("repository_complete"):
        return {"x5": "INCOMPLETE", "reason": "REPOSITORY_INCOMPLETE"}
    due = [r for r in sched["reports"] if r["due_date"] < sched["as_of"]]
    if not due:
        return {"x5": "NA"}
    sub = [r for r in due if r["submitted_date"] and r["submitted_date"] <= sched["as_of"]]
    late = [r["id"] for r in sub if r["submitted_date"] > r["due_date"]]
    missing = [r["id"] for r in due if r not in sub]
    return {"x5": float(Fraction(len(due) - len(sub), len(due))), "n_due": len(due), "n_submitted": len(sub), "late": late, "missing": missing}


def oracle_screen(award, ledger, register):
    parties = {}
    rec = award["recipient_org"]
    parties[rec["name"]] = rec.get("identifiers", [])
    pol = award["documentation_policy"]
    for t in ledger["transactions"]:
        if t["category"] in pol["excluded_categories"]:
            continue
        r = t["receiver_org"]
        parties.setdefault(r["name"], [])
        for i in r.get("identifiers", []):
            if i not in parties[r["name"]]:
                parties[r["name"]].append(i)
    confirmed, conflicting, unverified = [], [], []
    for pname, pids in sorted(parties.items()):
        for e in register["entries"]:
            id_hit = any(p["scheme"] == i["scheme"] and p["value"].strip().upper() == i["value"].strip().upper()
                         for p in pids for i in e.get("identifiers", []))
            nm = any(names_match(pname, x) for x in [e["name"], *e.get("aliases", [])])
            if id_hit and nm:
                confirmed.append([pname, e["uid"]])
            elif id_hit:
                conflicting.append([pname, e["uid"]])
            elif nm:
                unverified.append([pname, e["uid"]])
    x6 = 1 if confirmed else 0
    alert = "NONE" if x6 == 1 else ("CONFLICTING" if conflicting else ("UNVERIFIED" if unverified else "NONE"))
    return {"x6": x6, "alert_status": alert, "confirmed": confirmed, "conflicting": conflicting, "unverified": unverified}


def claim_facts(award, ledger, sched):
    facts = []
    pol = award["documentation_policy"]
    seen = {}
    for t in ledger["transactions"]:
        seen.setdefault(t["id"], t)
    sums = {}
    for t in seen.values():
        if t["category"] in pol["excluded_categories"] or t["currency"] != award["currency"]:
            continue
        y, m = int(t["date"][:4]), int(t["date"][5:7])
        q = f"{y}-Q{(m - 1) // 3 + 1}"
        sums[(t["category"], q)] = sums.get((t["category"], q), 0) + cents(t["value"])
    k = 1
    for (cat, q), v in sorted(sums.items()):
        facts.append({"id": f"CF{k}", "subject": CATEGORY_LABEL[cat], "attribute": "amount spent", "period": q, "value": v / 100, "unit": "USD"})
        k += 1
    for r in sched["reports"]:
        if r["submitted_date"]:
            facts.append({"id": f"CF{k}", "subject": r["name"], "attribute": "submitted on", "period": "2026", "value": r["submitted_date"], "unit": "date"})
            k += 1
    return {"snapshot_id": "FX-014-CLAIMS-LEDGER", "snapshot_date": ledger["as_of"], "facts": facts}


def oracle_claims(facts, narrative):
    index = {}
    for f in facts["facts"]:
        index.setdefault((f["subject"].lower(), f["attribute"].lower(), f["period"].lower(), f["unit"].lower()), []).append(f["value"])
    out = []
    for subject, attribute, period, value, unit in claims_from_narrative(narrative):
        vals = index.get((subject.lower(), attribute.lower(), period.lower(), unit.lower()), [])
        distinct = []
        for v in vals:
            if v not in distinct:
                distinct.append(v)
        if not distinct:
            st = "INSUFFICIENT_EVIDENCE"
        elif len(distinct) > 1:
            st = "AMBIGUOUS_CONFLICT"
        else:
            st = "SUPPORTED" if distinct[0] == value else "CONTRADICTED"
        out.append({"subject": subject, "attribute": attribute, "period": period, "value": value, "unit": unit, "status": st})
    n = len(out)
    halves = sum({"CONTRADICTED": 2, "AMBIGUOUS_CONFLICT": 1, "INSUFFICIENT_EVIDENCE": 1, "SUPPORTED": 0}[c["status"]] for c in out)
    return {"claims": out, "x2": halves / (2 * n)}


def planted_issues(award, ledger, sched, register, claims):
    """The problems a careful screener should find in a scenario, listed from the DATA (so they do not depend on the
    completeness or currency checks that make the pipeline refuse to compute). Used by the AI-judge comparison.
    'tolerated' items are not problems and not errors if mentioned (for example an invoice still inside the grace period)."""
    pol = award["documentation_policy"]
    seen, dupes = {}, []
    for t in ledger["transactions"]:
        if t["id"] in seen:
            if seen[t["id"]] == t and t["id"] not in dupes:
                dupes.append(t["id"])
            continue
        seen[t["id"]] = t
    expected, tolerated = [], []
    for t in seen.values():
        if t["category"] in pol["excluded_categories"] or not (award["planned_dates"]["start"] <= t["date"] <= award["planned_dates"]["end"]):
            continue
        need = set(pol["required_documents"][t["category"]])
        have = {d["type"] for d in t["documents"]}
        if need <= have:
            continue
        item = {"category": "MISSING_DOCUMENT", "ref": t["id"]}
        (tolerated if days_between(t["date"], ledger["as_of"]) <= pol["cure_days"] else expected).append(item)
    for d in dupes:  # a repeated export row is a data note, not a problem: mentioning it is fine, missing it costs nothing
        tolerated.append({"category": "DUPLICATE_RECORD", "ref": d})
    due = [r for r in sched["reports"] if r["due_date"] < sched["as_of"]]
    for r in due:
        if not r["submitted_date"] or r["submitted_date"] > sched["as_of"]:
            expected.append({"category": "REPORT_MISSING", "ref": r["id"]})
        elif r["submitted_date"] > r["due_date"]:
            expected.append({"category": "REPORT_LATE", "ref": r["id"]})
    sc = oracle_screen(award, ledger, register)
    parties = []
    for group in ("confirmed", "conflicting", "unverified"):
        for party, _uid in sc[group]:
            if party not in parties:
                parties.append(party)
    for party in parties:
        expected.append({"category": "WATCHLIST_MATCH", "ref": party})
    for c in claims["claims"]:
        if c["status"] == "CONTRADICTED":
            item = {"category": "NARRATIVE_MISMATCH", "ref": c["subject"]}
            # a statement about a report may be referred to by the report's id in the schedule (found in the pilot run)
            aliases = [r["id"] for r in sched["reports"] if r["name"].lower() == c["subject"].lower()]
            if aliases:
                item["aliases"] = aliases
            expected.append(item)
        elif c["status"] in ("INSUFFICIENT_EVIDENCE", "AMBIGUOUS_CONFLICT"):
            tolerated.append({"category": "*", "ref": c["subject"]})
    return {"expected": expected, "tolerated": tolerated}


# ---------------------------------------------------------------- scenarios


def find(ledger, tid):
    return next(t for t in ledger["transactions"] if t["id"] == tid)


def doc(ledger, tid, dtype):
    t = find(ledger, tid)
    if not any(d["type"] == dtype for d in t["documents"]):
        t["documents"].append({"type": dtype, "ref": f"{dtype[:3].upper()}-{tid[-3:]}", "date": t["date"]})


def s1_clean(award, ledger, sched, narrative):
    doc(ledger, "TX-2026-013", "invoice")
    doc(ledger, "TX-2026-033", "invoice")
    doc(ledger, "TX-2026-018", "invoice")
    find(ledger, "TX-2026-019")["receiver_org"]["name"] = "Pinewood Print & Copy"
    for r in sched["reports"]:
        if r["id"] == "R2":
            r["submitted_date"] = "2026-07-30"
        if r["id"] == "R3":
            r["submitted_date"] = "2026-09-10"
    narrative = narrative.replace("6,500 USD on training", "6,200 USD on training")
    return narrative


def s2_gaps(award, ledger, sched, narrative):
    for t in ledger["transactions"]:
        if t["category"] == "personnel" and t["date"] >= "2026-05-01":
            t["documents"] = []
    return narrative


def s3_confirmed(award, ledger, sched, narrative):
    ledger["transactions"].append(tx(36, "2026-09-22", "subcontract", "Equipment transport", "Delta Harbour Logistics Company", 5000,
                                     ["contract", "invoice"], [{"scheme": "XX-REG", "value": "DH-77120"}]))
    return narrative


def s4_conflicting(award, ledger, sched, narrative):
    ledger["transactions"].append(tx(36, "2026-09-22", "subcontract", "Equipment transport", "Deltaport Freight Services", 5000,
                                     ["contract", "invoice"], [{"scheme": "XX-REG", "value": "DH-77120"}]))
    return narrative


def s5_mixed_currency(award, ledger, sched, narrative):
    t = find(ledger, "TX-2026-020")
    t["value"] = 2450000
    t["currency"] = "KRW"
    return narrative


def s6_small_sample(award, ledger, sched, narrative):
    keep = {"TX-2026-001", "TX-2026-002", "TX-2026-011", "TX-2026-013"}
    ledger["transactions"] = [t for t in ledger["transactions"] if t["id"] in keep]
    return narrative


def s7_ledger_incomplete(award, ledger, sched, narrative):
    ledger["complete"] = False
    return narrative


SCENARIOS = {
    "s0-as-delivered": (lambda a, l, s, n: n, "Typical messy file: two missing documents, one report late, one missing, a near-name watch-list hit, two wrong statements."),
    "s1-clean": (s1_clean, "Everything resolved: documents complete, reports on time, no name hit, statements correct."),
    "s2-documentation-gaps": (s2_gaps, "Payroll records missing from May onward: documentation deficit above the gate threshold (the two most recent are still inside the 30-day grace window and are not counted)."),
    "s3-confirmed-match": (s3_confirmed, "A payee matches a watch-list entry by identifier AND by name: confirmed."),
    "s4-conflicting-match": (s4_conflicting, "A payee matches a watch-list identifier but with a different name: conflicting."),
    "s5-mixed-currency": (s5_mixed_currency, "One expense recorded in another currency: documentation measure cannot be computed."),
    "s6-small-sample": (s6_small_sample, "Only four transactions, with a high ratio: small-sample case."),
    "s7-ledger-incomplete": (s7_ledger_incomplete, "The ledger is not attested complete."),
}


def build(name, patch):
    award = copy.deepcopy(AWARD)
    ledger = {"snapshot_id": f"FX-014-SPEND-{name}", "as_of": AS_OF, "currency": "USD", "complete": True, "transactions": base_transactions()}
    sched = {"as_of": AS_OF, "repository_complete": True, "reports": copy.deepcopy(REPORTS)}
    narrative = patch(award, ledger, sched, NARRATIVE)
    facts = claim_facts(award, ledger, sched)
    claims = oracle_claims(facts, narrative)
    expected = {
        "scenario": name, "as_of": AS_OF,
        "x4": oracle_x4(award, ledger), "x5": oracle_x5(sched), "screening": oracle_screen(award, ledger, REGISTER),
        "claims": claims,
        "planted_issues": planted_issues(award, ledger, sched, REGISTER, claims),
    }
    return award, ledger, sched, facts, narrative, expected


def main():
    os.makedirs(OUT, exist_ok=True)
    index = []
    for name, (patch, desc) in SCENARIOS.items():
        award, ledger, sched, facts, narrative, expected = build(name, patch)
        d = os.path.join(OUT, name)
        os.makedirs(d, exist_ok=True)
        for fname, obj in [("award.json", award), ("spend_ledger.json", ledger), ("reporting_schedule.json", sched),
                           ("register.json", REGISTER), ("claims_ledger.json", facts), ("expected.json", expected)]:
            with open(os.path.join(d, fname), "w") as f:
                json.dump(obj, f, indent=1, ensure_ascii=False)
        with open(os.path.join(d, "report.txt"), "w") as f:
            f.write(narrative)
        index.append({"scenario": name, "description": desc})
    with open(os.path.join(OUT, "scenarios.json"), "w") as f:
        json.dump(index, f, indent=1)
    print(len(index), "scenarios written to", os.path.abspath(OUT))


if __name__ == "__main__":
    main()
