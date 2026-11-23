# Verified provider contracts and policy

Verified against the official API references on 2026-10-20. Runtime requests use direct HTTP with typed Zod response validation, avoiding invented SDK methods.

## Mistral

- `POST https://api.mistral.ai/v1/ocr`, bearer API key.
- `document.type=document_url` with inline `data:application/pdf;base64,...`, or `image_url` with inline image data. No external document URL, Files API or Batch API.
- `document_annotation_format.type=json_schema`, nested JSON schema and extraction-only annotation instructions. OCR extraction performs no economic classification.
- When enabled, Mistral is the primary extractor. The client sends sequential chunks of up to 20 pages, reduced to fit the configured page budget. Each response must include exactly the requested zero-based page indexes.
- `document_annotation` is a JSON **string** that must be parsed and validated. Page markdown and images are discarded. Unknown required fields invalidate the row.
- Automatic acceptance of OCR rows requires local text evidence for each row's date, signed amount and running balance, plus balance reconciliation. Recovered rows from layouts without independently verifiable fields can be saved for review.
- A single API process shares one in-flight OCR request and paces attempts using the configured request rate and rolling page budget. It retries a chunk once for network/transient server failures or 429. On 429, all callers observe the provider's `Retry-After` or bounded backoff. When a known wait exceeds the remaining deadline or 429 retries run out, the API returns `503 OCR_RATE_LIMITED` with `Retry-After`.
- Do not log the JSON parser's error object or Zod issues: both may contain sensitive inputs. Error responses expose fixed codes only.

References:
https://docs.mistral.ai/api/endpoint/ocr
https://docs.mistral.ai/studio/document-processing/basic_ocr
https://docs.mistral.ai/studio/document-processing/annotations
https://docs.mistral.ai/admin/monitor-comply/zero-data-retention

## Jev / TypeSafe

- `POST https://api.typesafe.ai/v1/systemone`, bearer API key.
- Request: `model`, minimized `state`, and `questions.category={type:"choice",instructions,criteria}`. All 33 ontology categories have definitions, including `unknown` and `transfer_unknown`.
- Response: `model`, `answers.category={type:"choice",choice,confidence,probabilities}`, `usage={input_tokens,output_tokens}`. Validate all keys/ranges, approximate probability sum and that the selected choice has a maximal probability.
- `GET /v1/models` is the provider's authenticated model-discovery endpoint. `jev-latest` is configurable; record the returned `model` verbatim. It may still be an alias, so do not claim an immutable model version if the provider does not return one.
- No multi-transaction batch endpoint is assumed. Workers use identifier-only jobs and the client bounds concurrent requests. At most three attempts, 15 seconds each by default, with exponential jitter and rate-limit handling within a bounded total deadline.
- Amounts, balances, user IDs, account numbers, identifiers and full documents are omitted from semantic state. Unknown transfer counterparts are reduced to known channel/purpose tokens. Merchant evidence includes only public registry data.
- Usage records describe successful responses, not necessarily all provider billing for failed/retried calls. Cost estimates require operator-supplied verified rates; no pricing is invented.

Official schema:
https://api.typesafe.ai/openapi.json

## Semantic automatic acceptance

Off by default. To opt in after independent human-reviewed evaluation, set `SEMANTIC_AUTO_ACCEPT=true` and mount `CALIBRATION_EVIDENCE_PATH` with:

```json
{
  "policyVersion": "2.0.0-evidence-first",
  "ontologyVersion": "1.1.0",
  "datasetChecksum": "<current-registry-sha256>",
  "returnedModel": "<exact-returned-model>",
  "autoClassifyThreshold": 0.90,
  "categories": { "housing": { "precision": 0.99, "sampleSize": 200 } },
  "model": "configured-model-name",
  "humanReviewed": true,
  "reportSha256": "<64-character SHA-256 of reviewed evaluation report>",
  "expiresAt": "<future-ISO-8601-expiry>"
}
```

The deployment review must confirm that report actually exists, uses representative held-out labels and supports the selected thresholds. This record is a deployment attestation, not a substitute for calibration. Each enabled category also requires observed held-out precision >= 0.98 and at least 100 automatic examples; these minimum gates do not establish a statistical guarantee. Semantic automatic acceptance remains restricted to explicit purpose cues without generic transfer ambiguity; seed hints, processor-only evidence, contradictory direction, extraction issues and unresolved refunds cannot be auto-accepted. Re-evaluate model aliases after provider updates.

Fixture metrics are reported as suggestion accuracy, macro-F1, unknown detection and pending routing. Deterministic rule confidence is not model calibration. No behavioral score or psychological inference is produced.

## Dependency security overrides

`package.json` pins patched `deepmerge-ts` 8.0.2 and `js-yaml` 5.5.0 through npm overrides, avoiding known recursive-merge and YAML resource-exhaustion advisories in transitive Prisma CLI and Swagger dependencies. Prisma's configuration loader uses `deepmerge` for ordinary configuration objects; schema generation/migrations and Swagger generation are verified with these overrides. Revisit the overrides when upgrading their parent packages.

## OpenAI insights

Verified against official Responses, structured-output, function-calling, and data-control documentation on 2026-10-25. `POST https://api.openai.com/v1/responses` uses `store:false`, `background:false`, strict `text.format` JSON schema, and a read-only `simulate_category_cut` function. Default model: `gpt-5.4-mini-2026-03-17`. Requests contain aggregate financial facts and sanitized temporary questions/history only. Monetary prose is rendered from validated backend metric references. Production requires signed organization/project/credential/model-bound ZDR evidence; `store:false` alone is insufficient. See [insights API](insights-api.md) for the full contract, configuration, failure behavior, and official reference links.
