# Human-reviewed evaluation data

The supplied screenshot cases have regression coverage, but no representative held-out human-reviewed Nigerian transaction dataset has been provided. Do not claim the authored synthetic fixtures are a calibrated evaluation set.

Use sanitized, permissioned cases in a separate JSON file:

```json
{
  "humanReviewed": true,
  "reviewer": "reviewer-reference",
  "reviewedAt": "2026-10-20T00:00:00Z",
  "cases": [
    {
      "id": "case-1",
      "description": "NIP TRANSFER",
      "direction": "debit",
      "expectedCategory": "transfer_unknown",
      "expectedStatus": "requires_user_tagging"
    }
  ]
}
```

Run `npm run evaluate -- /absolute/path/reviewed.json`. Keep real financial datasets outside the repository. Review unknown detection, merchant identity matches, high-confidence errors, calibration and category balance before approving semantic automatic acceptance. Cost is computed only when verified input and output USD-per-million rates are supplied.
