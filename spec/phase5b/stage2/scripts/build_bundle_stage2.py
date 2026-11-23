"""Phase 5b stage 2: pack the built inputs of the listed projects into one bundle file (same shape as the stage 1 bundle).
Usage: python3 build_bundle_stage2.py <inputs_dir> <out.json> <bundle_name> <built_date> <PROJECT>..."""
import json, sys, hashlib
d, out, name, built, *ids = sys.argv[1:]
L = lambda p: json.load(open(p, encoding="utf-8"))
projects = []
for k in ids:
    b = f"{d}/{k}/"
    projects.append({"id": k, "inputs": {"documentText": open(b + "report.txt", encoding="utf-8").read(), "award": L(b + "award.json"),
        "spendLedger": L(b + "spend_ledger.json"), "schedule": L(b + "reporting_schedule.json"),
        "register": L(b + "register.json"), "claimsLedger": L(b + "claims_ledger.json")}})
bundle = {"bundle": name, "built": built,
          "judge_prompt_sha256": "b9559ce87ddb0fbf51d56e65c3d4da3d0553243596539d840ef757244a6883f3", "projects": projects}
open(out, "w", encoding="utf-8").write(json.dumps(bundle, indent=1, ensure_ascii=False) + "\n")
print(out, hashlib.sha256(open(out, "rb").read()).hexdigest(), len(projects), "projects")
