# Acceptance checklist

Status legend: ✅ automated test (runs in `npm test`) · 🖥️ verified manually in the browser during development ·
🔑 needs your credentials · 🔌 needs physical hardware.

| # | Workflow | Status | Where |
|---|---|---|---|
| 1 | Create the business and its first branch | ✅ | first-run setup service; `security.test.ts` (single business), seed |
| 2 | Create an owner and cashier | ✅ | setup + seed; users API (`Settings → Users`) |
| 3 | Configure menu products and modifiers | ✅ 🖥️ | seed + `pos-flow.test.ts` (modifier min/max validation) |
| 4 | Open a table and create an order | ✅ 🖥️ | `pos-flow.test.ts`, browser run (POS → table → place order) |
| 5 | Route food and drinks to their stations | ✅ | kitchen and bar tickets created once per submission |
| 6 | Update preparation and service statuses | ✅ | invalid transitions rejected; chef cannot update bar tickets |
| 7 | Add ingredients and recipes | ✅ | recipe versions; later changes don't rewrite past consumption |
| 8 | Record stock deductions exactly once | ✅ | idempotent ledger keys; retries, duplicate callbacks and offline re-syncs do not double-deduct |
| 9 | Complete a cash sale and print a receipt | ✅ 🖥️ | cash drawer required; original vs duplicate receipt; browser printing |
| 10 | M-Pesa sandbox payment + simulated callback | ✅ 🔑 | simulated provider + public callback token check; live sandbox needs your Daraja keys |
| 11 | Failed M-Pesa payment cannot mark an order paid | ✅ | cancelled, mismatched amount and forged callbacks |
| 12 | Real test SMS (Talk Sasa) | 🔑 | Integrations → Talk Sasa → Send test (adapter unverified against a live account) |
| 13 | Real test email (SMTP) | 🔑 | Integrations → SMTP email → Send test |
| 14 | Connect a fingerprint device via its SDK/protocol | 🔌 | bridge adapters (ZKTeco protocol, SecuGen WebAPI); devices stay *unverified* until tested |
| 15 | Record attendance and generate a report | ✅ | bridge ingest is idempotent; report computes worked/late/overtime; CSV export |
| 16 | Cashier cannot access restricted accounting | ✅ | `security.test.ts` |
| 17 | Records are scoped / no cross-branch access | ✅ | branch header validation; query guard rejects unscoped queries |
| 18 | Synchronise an offline sale without duplication | ✅ | `sync-notify-attendance.test.ts`, `web/src/lib/offline.test.ts` |
| 19 | Reconcile cash, M-Pesa and split payments | ✅ | reconciliation report; cash session expected vs counted |
| 20 | Branch-specific sales and inventory reports | ✅ | branch scoping and "all branches" for owners |
| 21 | Printer disconnection doesn't lose the transaction | ✅ | failed print leaves the order paid; bridge reports failed jobs |
| 22 | Restore a backup in a test environment | 🖥️ | `scripts/backup.sh` → `scripts/restore.sh` into a test DB: identical counts and indexes |
| 23 | Mobile, tablet and desktop layouts | 🖥️ | Playwright screenshots at 390, 1024 and 1440 px |
| 24 | All critical automated tests pass | ✅ | API 40, web 5, bridge 3 |

Also covered by tests: refresh-token rotation and reuse detection, account lockout, PIN sign-in on registered
terminals only, PIN rules and lockout, encrypted integration secrets never returned, honest (simulated) integration
status, marketing consent, notification de-duplication, plan-free single-business setup, business name/logo changes.

## Not verified in this environment

- Live Safaricom Daraja (sandbox or production), Talk Sasa and SMTP accounts — need your credentials.
- Physical ZKTeco/SecuGen devices and physical printers — need hardware; printing was verified with a TCP printer emulator.
