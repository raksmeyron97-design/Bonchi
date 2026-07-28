# Product requirements

## Positioning

A simple Khmer-first, offline-first mobile debt ledger that helps small shop owners
record credit sales, track repayments, remind customers politely, and protect their
records.

It must be **easier and faster than a paper notebook**. That is the bar; anything
that makes the app slower than a notebook is a defect regardless of how much it
adds.

## Who this is for

Clothing shops, grocers, general stores, construction-material and agricultural
suppliers, small wholesalers, salons, Facebook and Telegram sellers. Typically one
owner, sometimes one or two staff, on a low-end Android phone with intermittent
signal.

Many users have limited experience with accounting software. Accounting vocabulary
(debit, credit, reconciliation, ledger, sync queue) appears nowhere a merchant can
see it — a localization test asserts this.

## Merchant vocabulary

| Concept | Khmer | Never say |
|---|---|---|
| Who owes | អ្នកជំពាក់ | debtor account |
| Give on credit | ឱ្យជំពាក់ | debit |
| Money received | បានទទួលប្រាក់ | credit |
| Remaining | នៅសល់ | outstanding liability |
| Due today | ត្រូវសងថ្ងៃនេះ | maturity date |
| Overdue | ហួសថ្ងៃសង | delinquent |
| History | ប្រវត្តិ | transaction log |
| Send a reminder | ផ្ញើការរំលឹក | dunning |

## Speed targets

- Record a debt: **under 15 seconds** for a returning user.
- Record a repayment: **under 10 seconds**.

This is why the record form puts customer, amount and currency on one screen and
collapses everything optional; why the central Add button is raised and
thumb-reachable; and why due dates offer one-tap presets (none / tomorrow / +7 /
+30) instead of opening a calendar.

## P0 scope

- Shop onboarding with multi-tenant foundations
- Customers: add, edit, search offline, archive, notes, optional contact details
- Record debt: customer + amount + currency required; description, due date,
  product, note, reference optional
- Record payment: full, partial, repeated, with method and optional allocation
- Balances per customer **per currency**, with overdue and next due date
- Transaction timeline with filters
- Due-today and overdue lists
- Dashboard with actionable figures only
- Local reminders and shareable, editable, polite messages
- Reports, CSV export, PDF customer statement
- Offline creation with idempotent sync and new-device restore
- Reversal workflow with mandatory reason and audit trail

## Explicitly out of scope

Full POS, inventory, payroll, tax filing, double-entry UI, loan issuance, interest,
credit scoring, marketplace, supplier procurement, public customer portal, social
features, public debtor blacklist, AI advice, forecasting.

## Ethical guardrails

These are product requirements, not aspirations, and several are enforced in code:

- **No public debtor list, no cross-shop scoring, no sale of debt data.** Nothing in
  the schema supports it.
- **No automated messaging to customers.** Reminders notify the *merchant*. A
  customer message exists only when the merchant opens the share sheet themselves.
- **No threatening templates.** `containsProhibitedLanguage` fails the test suite if
  a shipped template mentions police, courts, blacklists or shaming.
- **No contact harvesting.** `READ_CONTACTS` is in `blockedPermissions`. No
  location, SMS-read, microphone or call-log permissions either.
- **Notification permission is asked contextually**, when the merchant enables a
  reminder — never at launch.
- **Lock-screen notifications hide the customer and amount by default.**
- **Analytics carry no customer detail and no amounts.** Scale is bucketed.

## Currency rule

KHR and USD are separate obligations and are never combined. There is no
cross-currency total anywhere — asserted by a test that scans the schema for one.
Paying $5 does not change a riel balance. Should conversion ever be added, the exact
rate and timestamp used must be stored.
