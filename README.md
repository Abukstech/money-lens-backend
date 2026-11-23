# MoneyLens backend

NestJS / TypeScript API for Nigerian statement extraction and conservative transaction classification. PostgreSQL stores minimized transaction records, classifications and audit revisions. **Uploaded documents and raw OCR output are never intentionally persisted.**

## Run locally

Requires Node 22 and PostgreSQL 15+ (Docker Compose uses PostgreSQL 16).

```sh
cp .env.example .env
# Replace JWT_SECRET and IDENTIFIER_HASH_KEY with distinct random secrets.
npm ci
npm run db:generate
docker compose up -d db
# The Node CLI does not implicitly load .env:
node --env-file=.env node_modules/prisma/build/index.js migrate deploy
npm run build
node --env-file=.env dist/main.js
```

Alternatively, after creating `.env`, run `docker compose up --build`. The one-shot migration container completes before the API starts. The Compose database credentials are for local use; configure production secrets separately. The local API uses the `.env` NODE_ENV setting; the image defaults to production.

Run `npm run dev` for source watching, or `npm start` after building. Both commands load `.env` automatically when present and print a startup/ready message. A terminal that stays open after the ready message is the running server; use Ctrl+C to stop it. Swagger UI: [http://localhost:3000/api/docs](http://localhost:3000/api/docs); OpenAPI: `/api/openapi.json`. Swagger is disabled in production. Liveness/readiness: `/api/health` checks PostgreSQL.

Both statement upload routes use Mistral as the primary extractor when `MISTRAL_OCR_ENABLED=true`. Supply a Mistral API key and set `MISTRAL_OCR_REQUESTS_PER_SECOND` and `MISTRAL_OCR_PAGES_PER_MINUTE` at or below the account limits. The local engine checks the original PDF and can provide a verified result if OCR fails or its result cannot be verified. With OCR disabled, the local extractor handles all statements. The limiter is shared within one API process. Production also requires the signed [provider approval](docs/privacy-operations.md#provider-approval-gate).

Set `PADDLE_OCR_URL` and `PADDLE_OCR_TOKEN` to use the self-hosted [CPU OCR service](services/ocr/README.md) as the primary extractor on both routes. The upgraded service returns structured tables plus legacy text boxes. The backend maps table cells into transactions without page-coordinate parsing and accepts reconciled scanned statements with complete OCR coverage. Older service responses keep the existing parser path. Run it on Docker Desktop or a private Railway service.

Use `POST /api/moneylens/statements/extraction-drafts` to review recovered rows when source coverage cannot be verified. Direct import requires source coverage and balance reconciliation. A `503 OCR_RATE_LIMITED` response includes `Retry-After` in seconds and `X-RateLimit-Source` (`local` or `mistral`). Reupload after that interval. If a single statement consistently exceeds the local budget within one upload deadline, use a shorter statement or adjust the local budget within your account's limits. Legacy partial imports with `INVALID_ROWS_REUPLOAD_REQUIRED` can still use `?retry=true`, preserving existing rows and user corrections.

Missing provider keys do not prevent local startup. OCR returns `OCR_NOT_CONFIGURED`; unresolved classification requires user tagging. Seed merchant recognition and user confirmation work without Jev.

## Use the API

```sh
# First request a registration code, then verify the emailed code:
curl -X POST http://localhost:3000/api/auth/email/request-code \
  -H 'Content-Type: application/json' \
  -d '{"email":"demo@example.test","purpose":"registration"}'
# POST /api/auth/email/verify-code with email, purpose, challengeId, and code.
# Use the returned grant as registrationGrant:
curl -X POST http://localhost:3000/api/auth/register \
  -H 'Content-Type: application/json' \
  -d '{"email":"demo@example.test","password":"replace-with-a-long-password","registrationGrant":"<verified-grant>"}'
# Use the returned access token in subsequent requests:
curl -X POST http://localhost:3000/api/moneylens/transactions/classify \
  -H "Authorization: Bearer $ACCESS_TOKEN" -H 'Content-Type: application/json' \
  -d '{"id":"import-1-row-1","date":"2026-10-15","description":"POS SPAR IKEJA","amount":"45800.00","direction":"debit","currency":"NGN"}'
curl -X POST http://localhost:3000/api/moneylens/statements/extract \
  -H "Authorization: Bearer $ACCESS_TOKEN" -F 'document=@/path/to/statement.pdf'
```

JSON money values are decimal strings, with at most two fraction digits for NGN. Numeric legacy input is accepted only within the safe minor-unit range and without excess precision. Only NGN is supported. Positive `amount` plus an explicit `direction` replaces signed transaction amounts.

| Route | Behavior |
| --- | --- |
| `POST /api/auth/register`, `/login`, `/refresh`, `/logout` | Accounts and rotating refresh sessions |
| `GET /api/auth/me`, `DELETE /api/auth/account` | Identity and cascading live-data deletion |
| `POST /api/moneylens/statements/extract` | In-memory, request-bound extraction; returns import and transaction IDs |
| `GET /api/moneylens/statements/:id` | Import status, no document download |
| `GET /api/moneylens/statements/:id/transactions` | Retained rows; cursor pagination |
| `POST /api/moneylens/statements/:id/classify` | Queue identifier-only classification jobs |
| `POST /api/moneylens/transactions/classify` | Submit structured JSON; `id` is a per-user idempotency key |
| `POST /api/moneylens/transactions/:id/classify` | Retry classification, preserving confirmations |
| `GET /api/moneylens/transactions`, `/transactions/pending` | Cursor-paginated transaction lists |
| `GET /api/moneylens/transactions/:id` | Current row, classification and versioned evidence |
| `PATCH /api/moneylens/transactions/:id/extraction` | Correct retained fields using `revision`; resets classification |
| `PATCH /api/moneylens/transactions/:id/classification` | Confirm/correct known purpose using `revision` |
| `GET /api/moneylens/transactions/:id/classification/history` | Classification audit trail |
| `GET /api/moneylens/classification/categories`, `/summary` | Ontology, live totals and unresolved amounts |
| `GET /api/moneylens/classification/rules` | Active recipient rules |
| `PATCH`, `DELETE /api/moneylens/classification/rules/:id` | Version-checked rule changes; audit history retained |

Grouped optional review, atomic batch confirmation and release instructions: [classification rollout](docs/classification-rollout.md).

Correction example: `{"revision":1,"category":"housing"}`. `unknown` and `transfer_unknown` cannot complete user classification. Deferral simply leaves a row pending. Known purpose outside the taxonomy may use `other`.

To remember a rule, confirmation includes `rememberForFuture:true` and `conditions:{"direction":"debit","currency":"NGN","minAmount":"40000","maxAmount":"50000","narrationTokens":["RENT"]}`. The transaction needs a stable recipient identifier in `bankCode:10DigitAccountNumber` format, supplied transiently by ingestion and stored only as a user-scoped keyed hash. Display names cannot create rules. Rule changes use `version`; deletion body is `{"version":1}`. Amounts, direction, currency, recipient and all narration tokens must match. Conflicting rules require tagging.

All owned resources derive user identity from a validated access token and live session. Refresh is single-use; logout invalidates its associated access session. Account deletion cascades live financial records and rules. Backup expiry is an operational responsibility: see [privacy operations](docs/privacy-operations.md).

## Mobile authentication

For local testing without Resend, set `NODE_ENV=development` and `EMAIL_DELIVERY_MODE=console`. Verification codes print to the backend terminal. Start with `node --env-file=.env dist/main.js` after building. Console delivery is rejected outside development; production requires Resend.

Email verification, password reset, first-name personalization, Resend configuration, API contracts, and compatibility changes are documented in [mobile authentication](docs/mobile-auth.md). New accounts require a verification grant; existing accounts can still sign in.

## Classification behavior

Order: preserve user confirmation → extraction/reversal checks → matching conditional user rule → explicit deterministic purpose evidence → Jev → unknown. Model failures never fabricate categories. Unknown recipients and processor-only payments without independent purpose evidence stay unresolved even with high model confidence. Transfers sent to Jev omit private counterparty names and retain only recognized purpose/channel terms.

The supplied 248-vendor seed is preserved at `src/merchants/data/nigeria-merchants.json`. Its source labels are claims, not independent verification. The runtime validates its schema and aliases and records a canonical JSON SHA-256 checksum. All seed-only category hints require confirmation; `official_verified` does not bypass this restriction. Conflicting merchant matches remain unresolved. Short aliases still use full token boundaries. Fuel/delivery hints have no universal category mapping.

Explicit telecom top-ups, utility bills, identified subscriptions, cash withdrawals and bank fee/levy narrations can classify deterministically; deterministic confidence `1` denotes a rule result, not an empirically calibrated probability. Refunds require a unique same-user original debit with matching reference, amount and compatible account/time context for automatic linkage; otherwise review is required. Credits are not automatically income. Internal transfer purpose requires explicit user confirmation or a scoped confirmed rule; a narration saying "own account" is insufficient.

Semantic suggestions use thresholds 0.75 and 0.90. Automatic semantic acceptance is **off by default**. Enabling it also requires a calibration evidence record bound to the configured model and policy. See [provider contracts](docs/provider-contracts.md). User-confirmed rows cannot be overwritten by stale workers.

Summary expense totals are gross accepted debit expenses; refunds are separate movements and are not blindly netted against purchases. Cash movements, internal transfers and savings/investments are excluded from consumption expense totals. Pending debits remain explicitly unclassified. Behavioral score is always `null`, `pending_context`.

## Conversational financial insights

Authenticated monthly context, aggregate analysis, and temporary follow-up conversations are available under `/api/moneylens/insights`. Backend decimal calculations supply financial facts; OpenAI explains them, while Jev classification stays unchanged. Only monthly context persists; reports and chats expire in process memory. Missing OpenAI configuration returns facts without a generated report. See [insights API and setup](docs/insights-api.md) for endpoints, examples, limits, privacy controls, and the production signed ZDR approval requirement.

## Tests and evaluation

```sh
npm run typecheck
npm run lint
npm run build
npm test
# Use an isolated database; migrations must be applied first:
TEST_DATABASE_URL=postgresql://... npm run test:integration
# Supply DATABASE_URL, JWT_SECRET and IDENTIFIER_HASH_KEY (or use --env-file):
node --env-file=.env --import tsx scripts/evaluate.ts
```

The 200 narration fixtures are **authored synthetic regression cases**, not a representative human-reviewed evaluation or production confidence calibration. Cases include intermediaries, unknown people, informal merchants, OCR noise, refunds, cash withdrawals, fees and recognized merchants. Human-reviewed evaluation input and limitations are described in [the evaluation directory](test/fixtures/human-reviewed/README.md).

The PostgreSQL integration suite covers real migrations, authentication, ownership, idempotency, atomic feedback, recipient scope, pg-boss jobs, safe extraction, document/OCR marker non-persistence, timeout, restart and deletion. It is skipped unless `TEST_DATABASE_URL` is set. Do not point tests at production.

Live provider tests are opt-in and synthetic only: `RUN_LIVE_SMOKE=true LIVE_JEV_API_KEY=... LIVE_MISTRAL_API_KEY=... npm run test:live`. They incur provider usage and do not prove production ZDR activation. Normal tests never call providers. An evaluation call uses Jev only with explicit `EVALUATE_LIVE=true`.

Production document processing remains blocked until signed evidence is mounted and validated. Infrastructure and provider contracts still need deployment-specific verification; passing application tests is not a legal compliance certification.
