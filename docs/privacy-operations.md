# Privacy and deployment operations

## Data boundary

Documents, inline Base64 payloads, provider response bodies, page markdown, document images and original filenames must never enter durable storage. Request-bound in-memory processing is permitted. PostgreSQL contains minimized transaction fields, user-scoped keyed identifier/fingerprint hashes, classification evidence and audit revisions. These are still sensitive financial data.

After OCR succeeds, durable classification jobs contain only `transactionId` and `taskId`. The transactional task/outbox table prevents extraction success from losing jobs if the process stops before pg-boss dispatch. Jobs are safe to repeat: revision checks preserve newer corrections. Provider failures fall back to tagging rather than invented categories.

On extraction failure the user reuploads. Failed statements contain only ownership, a keyed fingerprint, status, safe error code and a processing lease. A crashed extraction lease expires, permitting reupload; no raw bytes survive for server-side retry. If invalid rows are dropped, the import is `needs_review`, with `INVALID_ROWS_REUPLOAD_REQUIRED`. The user must reupload with `?retry=true` to recover missing rows (existing corrected/confirmed rows are preserved); raw invalid rows cannot be retrieved.

Buffer clearing is best effort. Base64 strings, V8 copies and network buffers cannot be guaranteed securely erased. The promise is **no persistent document storage**, not zero transient copies.

## Provider approval gate

Mistral documents ZDR for supported stateless `/v1/ocr` calls, excluding `/v1/files` and batch files:
https://docs.mistral.ai/admin/monitor-comply/zero-data-retention

A local environment variable does not activate provider ZDR. An authorized reviewer must:

1. Obtain provider confirmation covering the actual organization, API credential, OCR model, structured annotations, endpoint, region and processing configuration. Verify activation in provider settings and retain the confirmation in the organization's compliance record, outside this repository.
2. Review the DPA, retention, subprocessors, residency, transfer conditions and training controls for the intended deployment. Review Jev's applicable terms independently; no Jev retention guarantees are assumed.
3. Issue a short-lived signed approval envelope. Its signature attests to that external review; the application cannot independently query or prove Mistral's account-side ZDR status.
4. Mount the envelope and approval public key read-only into the API. Keep the private signing key in a separate approval environment. Rotate approval when credentials, organization, model, scope or terms change; reverify account-side settings before renewal.

Signed payload (Mistral example; these are placeholders, not valid approval):

```json
{
  "provider": "mistral",
  "organizationId": "provider-organization-reference",
  "approvedBy": "authorized-reviewer-reference",
  "confirmationReference": "external-confirmation-record-reference",
  "expiresAt": "2026-11-01T00:00:00Z",
  "model": "approved-model-name",
  "zeroRetentionConfirmed": true,
  "processingTermsReviewed": true
}
```

Generate an Ed25519 approval key outside the application environment, then use the helper with metadata matching an actual completed review:

```sh
# On the approval workstation, using secure paths and file permissions:
openssl genpkey -algorithm ED25519 -out /secure/approval-private.pem
openssl pkey -in /secure/approval-private.pem -pubout -out /secure/approver.pub
# Supply the approved provider API key through the approval environment/secret manager:
node --import tsx scripts/sign-approval.ts /secure/metadata.json /secure/approval-private.pem > /secure/mistral.json
```

The helper reads `APPROVED_PROVIDER_API_KEY` from the environment and adds its SHA-256 fingerprint and the exact endpoint. It never prints the API key. The envelope is `{ "payload": "<exact JSON string>", "signature": "<base64 Ed25519 signature over payload bytes>" }`.

Production configuration:

- `NODE_ENV=production`
- `MISTRAL_ORGANIZATION_ID` and `MISTRAL_API_KEY` matching the approved organization/credential
- `MISTRAL_MODEL` matching the approval (prefer a pinned model)
- `ZDR_EVIDENCE_PATH=/run/privacy/mistral.json`
- `PROVIDER_EVIDENCE_PUBLIC_KEY_PATH=/run/privacy/approver.pub`
- For Jev: matching `JEV_ORGANIZATION_ID`, `JEV_API_KEY`, `JEV_MODEL`, and `JEV_EVIDENCE_PATH=/run/privacy/jev.json`; payload provider `jev`, endpoint `/v1/systemone`

Production verifies approval before each Mistral OCR request. Local extraction works independently of provider approval. Set `MISTRAL_OCR_ENABLED=true` only after verifying existing API access and setting both OCR limits in `.env.example` to match the account. Unapproved Jev calls safely leave transactions pending tagging. Public-key trust and approval file mounts must be managed by deployment operators. No approval artifacts or production keys are included in the repository.

## Deployment verification

The Compose file is a local example. Review the actual entire request path before production:

- Terminate TLS at a configured ingress. Use authenticated database TLS (`sslmode=verify-full` with the correct CA), encrypted database volumes/backups and least-privilege application credentials. Run schema migrations with a separate deployment role; pg-boss requires its schema/tables to be provisioned or permissions for its migrations.
- Disable body buffering and temporary upload files in every proxy, ingress, WAF, CDN and framework layer. The sample Nginx location disables request buffering, response buffering, cache and proxy temporary files. Validate behavior with chunked uploads as well as fixed-length requests; do not inherit an ingress configuration that re-buffers requests before this proxy.
- Do not enable request mirroring, packet capture, body sampling, provider debug mode, HTTP client instrumentation, request/response snapshots, session replay, or upload inspection that retains payloads.
- Disable swap for the host/workload and all core/heap dumps, crash attachments, automatic diagnostic memory capture and container checkpoints. Compose sets equal memory/memory+swap limits, `core=0`, a read-only root filesystem and drops capabilities. Confirm enforcement on the actual container runtime/host; read-only filesystems alone do not prevent swapped or dumped memory.
- Disable access logging for upload paths; never record authorization headers, request/response bodies, original filenames, financial narrations or provider error objects. Application logging is disabled by default except fixed operational error codes. Any added telemetry must use an explicit allowlist.
- Set finite database statement/lock timeouts and ingress request deadlines. Enforce process-wide and shared perimeter limits. Capacity is reserved before multipart parsing; no durable upload queue exists. The 120-second deadline includes upload and OCR, so large/slow uploads may need reupload.
- Persist only PostgreSQL and its explicitly encrypted backups. Do not create application upload volumes, writable document temp paths, general request caches or disk-based retries.
- Mount provider approvals/public key as read-only files. Never mount the private approval key. Use independently managed secrets for JWT and identifier HMAC keys. Rotating the identifier key without a migration will change fingerprints/rule matches; plan that rotation explicitly.
- Verify synthetic markers do not appear in database snapshots, logs, queues, temporary files, traces, failed-request attachments or backups after success, failure, interruption and restart. Application tests cover database/queue contents and parser lifecycles; production tooling and host settings require separate operational checks.

## Deletion and backup expiry

`DELETE /api/auth/account` deletes the user, sessions, statements, transactions, classification revisions, rules, rule revisions and monthly financial context from the live application tables by database cascades. Task rows cascade with transactions. pg-boss retains only opaque transaction/task IDs for up to its configured one-day retention; these jobs have no financial payload and become no-ops after deletion.

Set an approved, documented backup expiry period before production. Deletion from the live database does not remove historical backups immediately. Keep deletion tombstones in a separate controlled operational process so a restore cannot reactivate deleted accounts; apply deletions before reopening a restored service. Do not claim immediate removal from immutable backups. Users and operators must receive an accurate retention statement covering derived transaction data and backup expiry.

There is no basis here to certify legal compliance or pick a jurisdiction-specific retention period. Record the actual obligations and agreements for MoneyLens's deployment before launch.

## Temporary insights and OpenAI approval

Insights persists only user-owned monthly context and operational rate counts. Reports, conversations, prompts, tool results, and provider bodies remain transient. Extend all body-capture exclusions and dump/swap controls above to insights routes and outbound OpenAI HTTP. Logout, password reset, account deletion, expiry, and restart clear temporary chats; this process-local implementation requires a single API process to guarantee logout cleanup across all its conversations.

OpenAI production approval follows the signed review process above with provider `openai`, endpoint `/v1/responses`, exact `OPENAI_INSIGHTS_MODEL`, matching `OPENAI_ORGANIZATION_ID`, required `OPENAI_PROJECT_ID`, credential fingerprint, and confirmed ZDR. Mount `OPENAI_EVIDENCE_PATH` read-only. Review the actual Responses structured-output/function-calling configuration and [OpenAI data controls](https://developers.openai.com/api/docs/guides/your-data); `store:false` is not evidence of activated ZDR. Full configuration and lifecycle limits: [insights API](insights-api.md).
