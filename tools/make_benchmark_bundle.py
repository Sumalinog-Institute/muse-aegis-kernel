"""Writes fixtures/grant-xx-nmf-0001-2026-014/benchmark-bundle.json: all scenarios' inputs and planted problems in one compact file.
The app reads this file on the server to run the comparison; the whole bundle is not sent to the browser."""
import json
import os

BASE = os.path.join(os.path.dirname(__file__), "..", "fixtures", "grant-xx-nmf-0001-2026-014")


def load(sc, name):
    with open(os.path.join(BASE, sc, name)) as f:
        return json.load(f)


def main():
    index = {s["scenario"]: s["description"] for s in json.load(open(os.path.join(BASE, "scenarios.json")))}
    scenarios = []
    for sc in sorted(index):
        with open(os.path.join(BASE, sc, "report.txt")) as f:
            report = f.read()
        scenarios.append({
            "id": sc,
            "description": index[sc],
            "inputs": {
                "documentText": report,
                "award": load(sc, "award.json"),
                "spendLedger": load(sc, "spend_ledger.json"),
                "schedule": load(sc, "reporting_schedule.json"),
                "register": load(sc, "register.json"),
                "claimsLedger": load(sc, "claims_ledger.json"),
            },
            "planted": load(sc, "expected.json")["planted_issues"],
        })
    out = {"format_version": 1, "note": "All data are invented. Planted problems are the known answers.", "scenarios": scenarios}
    path = os.path.join(BASE, "benchmark-bundle.json")
    with open(path, "w") as f:
        json.dump(out, f, separators=(",", ":"), ensure_ascii=False)
    print(len(scenarios), "scenarios,", os.path.getsize(path), "bytes ->", os.path.abspath(path))


if __name__ == "__main__":
    main()
