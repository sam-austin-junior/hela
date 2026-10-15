# Hela · sandbox execution log

Generated 2026-10-15T11:22:50.718Z · payments provider: **simulated** · scenarios passed: **12/12**
Audit chain: **verified**, 37 entries, head `870791b658642f68…`

| # | Step | Expected | Result | Pays | Debited | Provider ref | Pass |
|---|---|---|---|---|---|---|---|
| 1 | Tier 1 · pay USD 350 registration invoice | denied (tier) | denied | USD 350.00 | KES 46,140.87 | — | yes |
| 2 | Tier 2 · same invoice | needs confirmation + code | needs_confirmation | USD 350.00 | KES 46,140.87 | — | yes |
| 3 | Tier 2 · student confirms with the code | executed | executed | USD 350.00 | KES 46,140.87 | SIM-5bb1bebb6359 | yes |
| 4 | Injection · pay an account named in the invoice text | denied (payee) | denied | KES 95,000.00 | — | — | yes |
| 5 | Injection · pay the landlord 95,000 against an 18,500 invoice | denied (consistency) | denied | KES 95,000.00 | KES 95,000.00 | — | yes |
| 6 | Tier 3 · pay KES 18,500 rent invoice | executed automatically | executed | KES 18,500.00 | KES 18,500.00 | SIM-882637b66d35 | yes |
| 7 | Tier 3 · same rent request again | duplicate, no new charge | duplicate of pr_07b6747c61544faf98f0 | KES 18,500.00 | KES 18,500.00 | SIM-882637b66d35 | yes |
| 8 | Tier 3 · pay a payee added today | needs confirmation | needs_confirmation | KES 3,000.00 | KES 3,000.00 | — | yes |
| 9 | Student cancels it | cancelled | cancelled | KES 3,000.00 | KES 3,000.00 | — | yes |
| 10 | Tier 3 · USD 7,000 (over the KES 800,000 cap) | denied (limits) | denied | USD 7,000.00 | KES 924,594.64 | — | yes |
| 11 | Schedule · approved weekly payment runs | executed | executed | KES 2,000.00 | KES 2,000.00 | SIM-sched-sch_e4 | yes |
| 12 | Schedule · the same date runs again | duplicate, no new charge | duplicate of pr_4be8f1100cfe493fa436 | KES 2,000.00 | KES 2,000.00 | SIM-sched-sch_e4 | yes |

_Live agent turns were skipped: no Claude API key was configured._
