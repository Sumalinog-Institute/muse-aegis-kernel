# Held-out test: ledgers (2026-11-28)

Source: the GCF IATI activities file (dataset `gcf-activities`, 350 activities, IATI 2.03, `generated-datetime` 2026-07-03T08:34:00Z),
opened by the author in a browser at https://bulk-data.iatistandard.org/gcf/gcf-activities.xml and saved as text on 2026-11-28
(the address https://static.greenclimate.fund/public/gcf-activities.xml returned BlobNotFound).
SHA-256 of the file as saved: `754e81e0480925d8125e309525e0b682158da3e2ee8a94add5686089dd0f3724` (kept compressed in `source/`).

The saved copy would not parse: 117 `&` signs and one `<` inside text were unescaped. `tools/phase5b/build_heldout_inputs.py` escapes
them (no other change) and then builds the five ledger files per project (award, spend_ledger, reporting_schedule, register, claims_ledger)
with the frozen mapping v2 and the frozen as-of date 2026-11-04 (so the ledgers are comparable to stage 1 and 2).

Check against stage 2: for the 15 stage 2 projects the new builder gives identical award, claims ledger, schedule and register files
and identical ledger transactions; only the order of transactions (and so their IATI-nnn numbers) differs, because the XML order is not the
order of the old CSV exports. Order does not enter any rule.

Four of the 30 projects have no disbursement in IATI (FP224, FP247, FP276, FP278): their cumulative disbursement is 0 as published.
The report.txt files are not built yet; they need the proposal and annual report excerpts.
