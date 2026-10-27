# Fictional grant XX-NMF-0001-2026-014

**Everything here is invented.** The funder, the recipient, the vendors and the watch list do not exist. Organisation
identifiers use the prefix `XX-` (ISO 3166's "user-assigned" code) so none can collide with a real organisation.

## What it is modelled on

- **Grant record**: field names follow the 360Giving data standard (identifier, title, description, currency, amount awarded,
  award date, funding and recipient organisation identifiers, amount disbursed).
- **Spend ledger**: IATI-style transactions (type, date, value, currency, a providing and a receiving organisation), with
  the supporting documents a funder would ask for (invoice, receipt, contract, payroll record).
- **Reporting schedule**: the usual quarterly financial and narrative reports, a mid-term evaluation and an annual audit.
- **Watch list**: the general shape of public sanctions lists (name, aliases, identifiers, programme, listing date).
- **Narrative report**: a grantee's progress report in plain prose, which the extractor reads.

## The grant

Brightwater Neighbourhood Alliance, funded by the Northern Meridian Fund: 240,000 USD for 2026 in three tranches,
spent on personnel, equipment, training, travel, rent and subcontracts. The data are "as of" 2026-10-26.

## Scenarios (each in its own folder, with `expected.json`)

| Folder | What it shows |
|---|---|
| `s0-as-delivered` | A typical messy file: 2 missing documents (17,000 USD), 1 pending invoice, 1 duplicated export row, Q2 report 6 days late, mid-term evaluation missing, a near-name watch-list hit, and two wrong statements in the narrative |
| `s1-clean` | Everything resolved |
| `s2-documentation-gaps` | Payroll records missing from May: documentation deficit above 0.25 |
| `s3-confirmed-match` | A payee matches a watch-list entry by identifier and name |
| `s4-conflicting-match` | A payee matches a watch-list identifier but with a different name |
| `s5-mixed-currency` | One expense in another currency |
| `s6-small-sample` | Only four transactions, with a high ratio |
| `s7-ledger-incomplete` | The ledger is not attested complete |

`expected.json` holds the values the proposed rules (`spec/FEATURES.md`) should produce, computed by an independent Python
oracle. Regenerate everything with `python3 tools/make_fictional_grant.py`.

## Planted problems in the baseline (`s0`), with the answer key

| Item | Expected result |
|---|---|
| Tablets 9,800 USD: invoice missing, 161 days old | undocumented |
| Safe-space audit 7,200 USD: invoice missing, 98 days old | undocumented |
| Q3 facilitator fees 4,500 USD: invoice missing, 12 days old | pending (inside the 30-day window) |
| Q2 facilitator fees appear twice in the export | counted once |
| Bank charges 45 USD | out of scope |
| x4 | 17,000 / 164,810 = 0.1031 (33 applicable records) |
| Reports due by 2026-10-26: Q1, Q2, mid-term | Q2 late, mid-term missing: x5 = 1/3 |
| Payee "Northgate Supply Company" vs "Northgate Supply Co." | UNVERIFIED alert |
| Look-alike names (Corvane, Lindqvist, Meridian) | no alert |
| Narrative: training 6,500 USD | contradicted (ledger 6,200) |
| Narrative: Q2 report submitted 2026-07-30 | contradicted (submitted 2026-08-06) |
| Narrative: 250 beneficiaries | insufficient evidence |
| Narrative: "roughly twelve thousand dollars" on outreach | not extractable, so not checked (a known limit) |
| x2 | 5/12 = 0.4167 |
