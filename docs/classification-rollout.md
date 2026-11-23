# Classification and grouped review rollout

Policy `2.0.0-evidence-first`, ontology `1.1.0` adds explicit-purpose rules,
scoped recipient memory, optional grouped review and three incoming categories.
The supplied screenshots are regression examples, not a representative evaluation.

## Release order

1. Run `npm run db:generate`, the backend checks and isolated PostgreSQL integration
   tests. Deploy the additive migration with `npm run db:migrate` before starting
   the new backend. Historical rows and audits retain their original versions.
2. Deploy the backend with `SEMANTIC_AUTO_ACCEPT=false`, then release the app.
   Existing individual transaction and confirmation endpoints remain supported.
3. Preview old unresolved rows with
   `node --env-file=.env --import tsx scripts/reclassify-unresolved.ts`.
   Add `--user=<user-id>` to scope a trial. After reviewing the count, add
   `--apply` to queue identifier-only jobs for the current revisions. Workers must
   be enabled. Confirmed, extraction-invalid and current-policy rows are excluded.
   Reprocessing creates normal revisioned decisions; it never rewrites history.
4. Review outcomes before enabling any semantic acceptance. Roll back the app or
   backend independently if necessary; keep the additive database columns.

Identifiers must be explicit bank-code/account pairs associated with a source row.
Local/Paddle rows support explicitly labelled pairs such as
`BENEFICIARY 999:1234567890`; structured OCR identifiers use the existing extraction
contract. Unavailable identifiers remain absent. Raw identifiers are not persisted
or sent to Jev. Historical imports cannot recover discarded identifiers without
fresh source evidence. Changing a draft narration or direction clears its identity
hashes because the previous association no longer applies.

## API contract

All routes are authenticated beneath `/api/moneylens` and derive ownership from
the session. Money values are decimal strings.

- `GET /classification/review-groups?statementId=...&cursor=...`: up to 50 groups,
  opaque keys, count, direction/currency, exact total, a unanimous suggestion,
  three previews, memory eligibility and proposed scope. `transactionCount` and
  `groupCount` cover the entire statement. Groups contain reviewable unresolved
  rows; extraction corrections stay separate. Ordering/cursors use group keys.
- `GET /classification/review-groups/:key/transactions?statementId=...&cursor=...`:
  up to 100 members, current revisions and a transaction-ID cursor. Groups are
  recomputed; stale row revisions are rejected during confirmation.
- `POST /transactions/classification/bulk`:
  `{items:[{transactionId,revision}],category,rememberForFuture?,conditions?}`.
  Maximum 100 distinct rows. Each request is atomic. Ownership failures return
  404, revision conflicts 409, invalid categories/directions/scopes 400.
  Remembered conditions use direction, currency, inclusive min/max amounts and
  all narration tokens. They must match every selected row and one reliable
  counterparty. A rule affects future classifications, not unselected history.
- `GET /classification/summary?statementId=...`: optional statement scope,
  known expense total, unresolved debit/credit totals, accepted count/value
  coverage, current automatic coverage, unresolved transfers and observed
  automatic correction counts/rate. Without a statement ID it covers the user.

The app caps selected rows at 100, permits per-row exclusions and category
changes, and saves each group/category batch separately. A later failed batch
leaves earlier successes intact and refreshes all revisions before retry.
Future memory is offered only after the complete group is inspected and given
one category; partial selections do not create broader future rules.

`gift_received`, `loan_received` and `repayment_received` are credit-only. They
have separate financial facts (`gifts_received`, `loans_received`,
`repayments_received`), are not earned income, and are not netted against expenses.
An explicit bank-posted Stamp Duty charge uses `financial_fees`, displayed as
“Bank fees & levies”; other explicit tax purposes remain distinct.

## Evaluate and monitor

Use permissioned, sanitized human-reviewed held-out cases in the documented
`test/fixtures/human-reviewed` format. Optional `amount` supports value coverage;
if omitted it defaults to 45000.00 for compatibility, so supply real sanitized
amounts for meaningful value metrics. Normal evaluation is offline; live Jev
usage requires explicit `EVALUATE_LIVE=true`.

`npm run evaluate -- /absolute/path/reviewed.json` reports automatic precision,
category sample sizes/precision, prospective semantic candidates above the acceptance
threshold (using the smaller confidence/probability), count/value coverage, unresolved transfers,
suggestions and routing. Synthetic regression results never authorize deployment.
Confidence calibration excludes deterministic/user-rule confidence values.
Monitor `groupCount / transactionCount` from grouped review alongside coverage
and unresolved amounts. Summary correction rates count recorded changes from an
automatic category; they are observed feedback, not measured population accuracy.
Historical corrections lacking the new reason code are not retroactively counted.

Semantic acceptance requires unexpired evidence bound to the configured and
returned model, policy, ontology, registry checksum and acceptance threshold.
Only explicitly evaluated categories with at least 100 automatic held-out
examples under the prospective semantic policy and observed precision >= 0.98 can be enabled.
Evaluation keeps semantic acceptance off and reports `semanticCandidateByCategory`
for this purpose; it does not require enabling unvalidated automation to gather evidence. These are minimum gates,
not statistical proof of a 98% population guarantee. Review representativeness,
errors and sample sizes before signing off. Inspect expiry/model changes and
repeat evaluation after policy, model, ontology or registry changes.

A generic incoming transfer still needs user context. A company name, recurring
amount or payment processor never proves earnings or common account ownership.
