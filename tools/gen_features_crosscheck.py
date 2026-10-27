"""Writes tools/features_crosscheck_cases.jsonl: random inputs with the results of the INDEPENDENT Python oracle in
tools/make_fictional_grant.py. ts/features_crosscheck.test.ts replays them through the TypeScript calculators and
requires identical results (numbers compared exactly)."""
import copy
import json
import os
import random
import sys

sys.path.insert(0, os.path.dirname(__file__))
import make_fictional_grant as g  # noqa: E402

N = int(sys.argv[1]) if len(sys.argv) > 1 else 3000
r = random.Random(20261027)
CATS = list(g.AWARD["documentation_policy"]["required_documents"].keys()) + ["bank_charges"]
DOC_TYPES = ["invoice", "receipt", "contract", "payroll_record", "bank_statement"]
VOCAB = ["northgate", "supply", "harbour", "harbor", "delta", "logistics", "corvane", "electronics", "trading", "meridian",
         "field", "services", "lindqvist", "training", "partners", "capital", "holdings", "brightwater", "alliance", "nordic",
         "pinewood", "print", "copy", "coastal", "evaluation", "dockside", "property", "management", "halden", "office"]
SUFFIX = ["Ltd", "Co.", "Company", "Inc", "LLC", "Limited", "Corp", "PLC", "GmbH", "FZE", "SA"]
UNI = ["서울", "무역", "Привет", "Мир", "Ｎｏｒｔｈｇａｔｅ", "Café", "ÉCOLE", "naïve", "Ünal", "東京", "e\u0301toile", "straße"]


def date(y0, m0, d0, span):
    from datetime import date as D, timedelta
    return (D(y0, m0, d0) + timedelta(days=r.randint(0, span))).isoformat()


def typo(w):
    if len(w) < 2:
        return w
    i = r.randrange(len(w))
    k = r.random()
    if k < 0.34:
        return w[:i] + w[i + 1:]
    if k < 0.67:
        return w[:i] + r.choice("abcdefghijklmnopqrstuvwxyz") + w[i + 1:]
    return w[:i] + r.choice("abcdefghijklmnopqrstuvwxyz") + w[i:]


def rand_name():
    toks = [r.choice(VOCAB) if r.random() < 0.85 else r.choice(UNI) for _ in range(r.randint(1, 4))]
    toks = [t.capitalize() if r.random() < 0.6 else t for t in toks]
    if r.random() < 0.5:
        toks.append(r.choice(SUFFIX))
    sep = r.choice([" ", "  ", " - ", ", ", "&"])
    return sep.join(toks) if sep != "&" else " & ".join(toks)


def near(name):
    parts = name.split(" ")
    k = r.random()
    if k < 0.3:
        return name.upper()
    if k < 0.55 and parts:
        i = r.randrange(len(parts))
        parts[i] = typo(parts[i])
        return " ".join(parts)
    if k < 0.7 and len(parts) > 1:
        parts.pop(r.randrange(len(parts)))
        return " ".join(parts)
    if k < 0.85:
        return " ".join(parts + [r.choice(VOCAB)])
    return rand_name()


def rand_ledger(award):
    n = r.choice([0, 1, 2, 5, 8, 12, 20, 30])
    txs = []
    for i in range(n):
        cat = r.choice(CATS)
        docs = r.sample(DOC_TYPES, r.randint(0, 3))
        txs.append({
            "id": f"T{i}", "type": "expenditure", "date": date(2025, 12, 20, 400), "category": cat, "description": "x",
            "provider_org": "XX-BWA-0420",
            "receiver_org": {"name": rand_name(), "identifiers": [{"scheme": "XX-REG", "value": f"ID-{r.randint(1, 30)}"}] if r.random() < 0.5 else []},
            "value": r.randint(1, 2000000) / 100, "currency": "USD" if r.random() < 0.93 else "KRW",
            "documents": [{"type": t, "ref": "R", "date": "2026-01-01"} for t in docs],
        })
        if r.random() < 0.08:
            dup = copy.deepcopy(txs[-1])
            if r.random() < 0.4:
                dup["value"] = dup["value"] + 1
            txs.append(dup)
    return {"snapshot_id": "R", "as_of": date(2026, 6, 1, 214), "currency": "USD", "complete": r.random() < 0.95, "transactions": txs}


def rand_schedule():
    reps = []
    for i in range(r.randint(0, 6)):
        due = date(2026, 1, 1, 400)
        sub = None if r.random() < 0.35 else date(2026, 1, 1, 400)
        reps.append({"id": f"R{i}", "name": "x", "due_date": due, "submitted_date": sub})
    return {"as_of": date(2026, 6, 1, 214), "repository_complete": r.random() < 0.95, "reports": reps}


def rand_register(payees):
    entries = []
    for i in range(r.randint(0, 6)):
        base = r.choice(payees) if payees and r.random() < 0.5 else rand_name()
        entries.append({"uid": f"W{i}", "type": "entity", "name": near(base) if r.random() < 0.7 else base,
                        "aliases": [near(base)] if r.random() < 0.3 else [],
                        "identifiers": [{"scheme": "XX-REG", "value": f"id-{r.randint(1, 30)}" if r.random() < 0.5 else f"ID-{r.randint(1, 30)}"}] if r.random() < 0.6 else []})
    return {"entries": entries}


out = os.path.join(os.path.dirname(__file__), "features_crosscheck_cases.jsonl")
with open(out, "w") as f:
    for _ in range(N):
        award = copy.deepcopy(g.AWARD)
        ledger = rand_ledger(award)
        f.write(json.dumps({"type": "x4", "award": award, "ledger": ledger, "expected": g.oracle_x4(award, ledger)}, ensure_ascii=False) + "\n")
        sched = rand_schedule()
        f.write(json.dumps({"type": "x5", "schedule": sched, "expected": g.oracle_x5(sched)}, ensure_ascii=False) + "\n")
        payees = [t["receiver_org"]["name"] for t in ledger["transactions"]]
        reg = rand_register(payees)
        if not any(t["id"] for t in ledger["transactions"]) or all(len(e["name"]) >= 0 for e in reg["entries"]):
            f.write(json.dumps({"type": "screen", "award": award, "ledger": ledger, "register": reg, "expected": g.oracle_screen(award, ledger, reg)}, ensure_ascii=False) + "\n")
        for _ in range(2):
            a = rand_name()
            b = near(a) if r.random() < 0.7 else rand_name()
            f.write(json.dumps({"type": "names", "a": a, "b": b, "expected": g.names_match(a, b)}, ensure_ascii=False) + "\n")
print("cases written to", out)
