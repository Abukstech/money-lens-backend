# Conversational financial insights

This backend feature explains a selected calendar month using accepted classifications. Jev still classifies transactions. Decimal arithmetic in MoneyLens calculates facts and hypothetical reductions; OpenAI explains the supplied aggregates. The existing classification summary contract is unchanged.

## Local configuration

Apply migrations, rebuild, and configure these settings in `.env`:

```dotenv
OPENAI_API_KEY=
OPENAI_ORGANIZATION_ID=
OPENAI_PROJECT_ID=
OPENAI_INSIGHTS_MODEL=gpt-5.4-mini-2026-03-17
OPENAI_EVIDENCE_PATH=/run/privacy/openai.json
INSIGHTS_DEADLINE_MS=45000
INSIGHTS_CONCURRENCY=4
INSIGHTS_REQUESTS_PER_HOUR=30
```

The key is optional for startup. Without it, analysis returns calculated facts with `status: "unavailable"`, `metadata.reasonCode: "OPENAI_NOT_CONFIGURED"`, and no fabricated narrative. Do not put keys in mobile/frontend configuration. Model, concurrency (maximum four), deadline (maximum 45 seconds), and shared per-user hourly request allowance are configurable. Provider HTTP requests have at most two attempts for transient failures within the shared deadline. Tool execution is limited to three scenarios and three Responses rounds.

The default pinned model supports Responses and structured output. The client uses foreground requests with `store:false` and `background:false`, a strict JSON schema, and read-only function calling. See the [model documentation](https://developers.openai.com/api/docs/models/gpt-5.4-mini), [structured outputs](https://developers.openai.com/api/docs/guides/structured-outputs), and [function calling](https://developers.openai.com/api/docs/guides/function-calling).

## Endpoints

All routes are under `/api/moneylens/insights`, require a bearer access token, and derive ownership from the verified session. Bodies reject unknown fields. Responses inherit `Cache-Control: no-store`. Swagger request definitions are available locally at `/api/docs`.

| Method and path                    | Behavior                                                                                    |
| ---------------------------------- | ------------------------------------------------------------------------------------------- |
| `GET /context/:month`              | Saved monthly context or empty nullable defaults                                            |
| `PUT /context/:month`              | Replace monthly income, target, and coverage settings                                       |
| `DELETE /context/:month`           | Delete only the authenticated user's context                                                |
| `POST /analyze`                    | Facts and an initial report for `{ "month": "2026-09" }`                                    |
| `POST /conversations`              | Create an empty temporary conversation for `{ "month": "2026-09" }`                         |
| `POST /conversations/:id/messages` | Fresh facts and an answer to `{ "message": "What if I reduced dining by thirty percent?" }` |
| `DELETE /conversations/:id`        | Clear the temporary conversation                                                            |

`month` uses `YYYY-MM`. Statement dates are retained calendar dates represented at UTC midnight; month queries use an inclusive first day and exclusive next-month boundary. Whether the selected month is still in progress is evaluated in Africa/Lagos time.

```sh
curl -X PUT http://localhost:3001/api/moneylens/insights/context/2026-09 \
  -H "Authorization: Bearer $ACCESS_TOKEN" -H 'Content-Type: application/json' \
  -d '{"takeHomeIncome":"500000.00","savingsTarget":"50000.00","spendingCoverageConfirmed":true}'
curl -X POST http://localhost:3001/api/moneylens/insights/analyze \
  -H "Authorization: Bearer $ACCESS_TOKEN" -H 'Content-Type: application/json' \
  -d '{"month":"2026-09"}'
curl -X POST http://localhost:3001/api/moneylens/insights/conversations \
  -H "Authorization: Bearer $ACCESS_TOKEN" -H 'Content-Type: application/json' \
  -d '{"month":"2026-09"}'
# Use the returned conversationId:
curl -X POST http://localhost:3001/api/moneylens/insights/conversations/CONVERSATION_ID/messages \
  -H "Authorization: Bearer $ACCESS_TOKEN" -H 'Content-Type: application/json' \
  -d '{"message":"Which flexible changes could help me meet my savings target?"}'
```

PUT requires all three fields; income and target may be `null` to clear them. NGN is the only currency. Money uses nonnegative decimal strings with at most two decimal places and the existing precision bounds. Zero is a known value, distinct from missing income. A target means contributions during this month, not a savings-account balance.

## Interpreting facts and reports

`facts.metrics` maps stable metric IDs to `{value,kind,label}`. Values are decimal strings; kinds are `money`, `percent`, or `count`. Examples include `net_expenses`, `expenses.dining`, `observed_income`, `reported_income`, `income_basis`, `savings_contributions`, `remaining_savings_target`, `remaining_after_known_allocations`, `savings_funding_gap`, and unresolved movement totals. Category income shares are omitted when the selected income basis is absent or zero.

Entered take-home income is explicitly user-reported. When supplied it is the income basis; otherwise accepted classified income is used. Observed income stays separate and is never added to reported income. Ordinary credits do not become income.

Only accepted, direction-compatible classifications without extraction issues enter category expenses. Savings contributions, investments, internal transfers, cash withdrawals, other credits, pending rows, and unresolved amounts have separate metrics. Cash withdrawn may later have been spent: it is not automatically assigned to consumption categories. Money remaining after expenses and known allocations is a hypothetical residual before unrecorded costs, not measured savings.

Linked refunds are checked against a same-user accepted original expense and the cumulative accepted linked refunds. Valid refunds against purchases within the month reduce that month's category expense once. Earlier-month refunds are separate inflows and do not reduce current-month purchases. Unlinked, conflicting, or excessive refunds stay separate and raise review limitations. Possible duplicates are flagged from existing validation issues; insights does not silently deduplicate or implement a new matching classifier.

Coverage and metrics list accepted and unresolved record counts, incomplete imports, current/future-month flags, and account coverage confirmation. Records need not prove every day had transactions. Even a confirmed coverage flag cannot prove all accounts were uploaded. Unknown-period failed imports are flagged conservatively. Missing income/goals yield clarification questions. No score, inferred income, savings balance, or universal spending benchmark is produced.

Each successful report includes `status`, `facts`, `narrative`, `findings`, `actions`, `scenarios`, `limitations`, `questions`, and version/usage metadata. Findings contain observation, evidence IDs, consequence, suggested action, assumptions, and missing context. The model writes metric placeholders such as `{{expenses.dining}}`; the backend validates their references and renders the actual figures. Literal numeric figures, unknown references, common insulting or unsafe claims, and malformed output are rejected. These checks supplement prompting; they do not prove every possible natural-language claim is correct.

A savings target already met by recorded contributions must be acknowledged. Criticism must be grounded in a stated goal or demonstrated cash-flow constraint and must recognize incomplete records. Flexibility is for the user to confirm. Reports cannot recommend skipping essential bills or debt obligations, make psychological judgments, or recommend investment products.

Report statuses:

- `ready`: a validated report with the configured completeness checks satisfied.
- `limited`: validated report with missing context, unresolved data, or coverage limitations.
- `facts_only`: no records or a future month; no model call.
- `unavailable`: provider/configuration/approval failure; calculated facts remain available.
- `refused`: provider refusal; no generated report returned.
- `invalid_output`: invalid structured response, evidence, tool behavior, or rejected prose; no generated report returned.

Provider failures expose safe codes, never provider bodies. Cancellation or the overall request deadline returns HTTP 408. Ownership/missing conversations return 404; expired or exhausted conversations return 410; concurrent messages on the same conversation return 409; the shared hourly request limit returns 429; bounded processing or conversation capacity returns 503 (or an unavailable report for provider capacity). Token totals describe received successful provider responses, not guaranteed complete billing for failed/retried requests.

## Read-only scenarios

OpenAI may call `simulate_category_cut` with an expense category and exactly one of a percentage (zero through one hundred) or a nonnegative NGN amount no larger than known net category spending. The backend validates inputs and calculates the reduction, resulting category amount, residual after known allocations, and remaining potential goal-funding gap with decimal arithmetic and half-up kobo rounding.

For reported income of ₦500,000, accepted expenses of ₦480,000 including ₦100,000 dining, a ₦50,000 contribution target, and no recorded contributions, the residual is ₦20,000 and potential funding gap is ₦30,000. A ₦30,000 dining reduction could free that amount if those expenses are flexible and everything else stays unchanged. It does not prove the money will be saved. If contributions already meet the goal, the report cannot claim the goal is missed. Scenarios never change classifications, monthly settings, or balances.

## Privacy and lifecycle

Only monthly context persists in the new Prisma table. It cascades on account deletion and remains sensitive financial data subject to the same database encryption, access controls, and backup expiry as transactions. Rate buckets persist identifiers and counts only. Reports, transcripts, prompts, provider bodies, and scenario results never enter databases, jobs, logs, or durable caches.

Provider requests contain aggregate category metrics, coverage limitations, sanitized questions, and bounded temporary history. They omit transaction narrations, recipient details, account IDs, emails, user IDs, documents, and OCR. Common identifiers typed into questions are redacted locally. Free text redaction is heuristic; clients should tell users to ask about aggregate finances and avoid pasting private statements or identities. Never add transaction retrieval tools to this integration without a separate privacy review.

Conversations use process memory: maximum 128 globally, three per user, twelve successful answered exchanges, thirty minutes idle, and two hours total lifetime. History is bounded and periodically swept. Every follow-up recalculates authoritative facts; changed classifications/context clear old history before answering. Conversation deletion, logout, password reset, account deletion, and process restart invalidate temporary state; logout/reset/deletion also abort active user operations. Garbage collection does not guarantee secure erasure of JavaScript memory.

Deploy as a single API process for this implementation. Multiple independent replicas would have different conversations and cannot broadcast logout cleanup; scaling requires explicit coordinated invalidation and routing without introducing durable transcripts. Apply the existing no-body-capture, no-swap/dumps, no-cache, read-only-filesystem controls to these routes and outgoing HTTP instrumentation. See [privacy operations](privacy-operations.md).

## Production approval

`store:false` prevents Responses application-state storage; it does not establish account-side ZDR or eliminate default abuse-monitoring retention. Review [OpenAI data controls](https://developers.openai.com/api/docs/guides/your-data) and obtain confirmed applicable ZDR for the organization/project, credentials, model, Responses endpoint, and foreground tool/structured-output configuration.

Production calls fail closed through the existing Ed25519 signed approval mechanism. Use `provider:"openai"`, `endpoint:"/v1/responses"`, the actual `organizationId`, matching `projectId` (required in production), exact model, credential SHA-256, future expiry, `zeroRetentionConfirmed:true`, and `processingTermsReviewed:true`. The separate reviewer signs evidence with `scripts/sign-approval.ts`; mount evidence and the public key read-only using `OPENAI_EVIDENCE_PATH` and `PROVIDER_EVIDENCE_PUBLIC_KEY_PATH`. Both `OPENAI_ORGANIZATION_ID` and `OPENAI_PROJECT_ID` are required in production and are sent as matching request headers. A signed local assertion attests to external verification; it cannot activate or independently prove provider-side retention settings.

## Validation

Normal tests mock OpenAI and cover facts, decimal boundaries, refunds, incomplete data, scenarios, evidence rendering, tone guardrails, retries, deadlines, ownership, deletion, expiry, and safe fallbacks. PostgreSQL tests require `TEST_DATABASE_URL` pointing at an isolated migrated database. Run `npm test` with that variable to include both original and insights integration suites.

An opt-in synthetic live test runs with `RUN_OPENAI_INSIGHTS_SMOKE=true LIVE_OPENAI_API_KEY=... npm exec vitest -- run test/insights-live.test.ts`. It sends only authored synthetic aggregates, incurs provider usage, and does not prove ZDR or representative report quality. Before production, independently review live report tone and evidence grounding across representative goals and coverage limitations; mocked regression checks are not a substitute for that evaluation.
