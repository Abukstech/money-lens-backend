# MoneyLens table-aware Paddle OCR service

The CPU service uses Paddle PP-OCRv5 text models, Paddle table-region detection
and Paddle SLANet-plus table structure recognition through ONNX Runtime
(RapidOCR, RapidLayout and RapidTable). No bank templates or bank-specific
coordinate rules are used in the new path.

A request follows PDF rendering → table regions → OCR text → structured cells.
The backend maps named columns into transactions and checks dates, amounts,
direction, coverage and running balances. It does not reconstruct page columns
from coordinates when structured cells are available. It never invents a missing
date, debit/credit direction or amount. Valid wrapped text is part of a cell;
summary rows and repeated headers are not transactions.

## HTTP contract

- `GET /health` returns `{status:"ok",contractVersion:2,tablesEnabled:true}` after
  model warm-up completes.
- `POST /ocr` accepts a PDF and `Authorization: Bearer <PADDLE_OCR_TOKEN>`.
- The v2 response is `{contractVersion:2,pages:[{index,items,tables,tableCoverageComplete,blank}]}`.
  `tables` is an ordered array of `{rows:string[][]}`. `items` retains the legacy
  text boxes, so existing backend deployments remain compatible.
- Every input page must be returned once with its zero-based index. Tables are
  ordered top-to-bottom. HTML stays inside the service and is converted with a
  bounded standard-library parser; it is never rendered or persisted.
- `tableCoverageComplete` is false if a region has no usable structure, numbers
  are lost/duplicated in cell mapping, or monetary OCR text is left outside table
  regions (except explicitly labelled statement summaries). It describes OCR
  evidence, not a guarantee that the document/model contains no errors.
- `PADDLE_TABLES_ENABLED=false` restores the original text-box response for a
  rollback. The backend also accepts existing v1 service responses.

PDFs, recognized text, table cells and images stay in memory. There is one upload
and inference worker, a 20 MiB/40-page limit and a bounded processing deadline.
Financial content is not logged. A synthetic table warms the models during image
build and again before the service is ready. Model files are cached in the image;
uploads never trigger model installation or downloads.

## Railway deployment

Deploy **only the `ocr` service**, not the API or database. Keep the existing
`PADDLE_OCR_TOKEN`, domain and target port. The deployment includes `railway.json`
with `/health` and a 300-second startup health-check timeout. The current OCR
service is deployed with this folder as the archive root and no Root Directory:

```sh
railway up services/ocr --path-as-root --service ocr --environment production --ci
```

The Dockerfile installs the pinned CPU dependencies, verifies the existing text
model checksums, runs the table-format tests and preloads the models. A failed
image warm-up fails the build. Check Railway memory and latency on representative
statements; lightweight table models do not establish production accuracy by
themselves. The current public domain may also be used by a local backend over
HTTPS with the same shared token. Within Railway, prefer the private hostname.

After deployment, `/health` must report `contractVersion:2`. The updated local API
logs `STRUCTURED_TABLE_EXTRACTION` with page/table/transaction counts and review
reasons, never raw text. Restart a backend not running in watch mode before
retesting a statement. No Prisma migration is required for this upgrade.

Do not claim a real statement is fixed based on synthetic smoke tests. Re-upload
it and compare row counts, debit/credit totals and balances. Actual ambiguous
financial data still goes to extraction review; it is not silently imported.

## Local checks

```sh
python -m unittest discover -s services/ocr/tests -v
npm run typecheck
npm test -- --run src/statements/extraction/structured-table.test.ts test/ocr-fallback.test.ts
# With Docker Desktop running:
docker compose up -d --build ocr
```

The container uses Python 3.12. To run engines directly outside Docker, set
`OCR_MODEL_DIR` to this folder's `models` directory. The model libraries need a
compatible Python/ONNX Runtime; your system Python is not modified by this repo.

Upstream APIs: [RapidTable](https://github.com/RapidAI/RapidTable),
[RapidLayout](https://github.com/RapidAI/RapidLayout), and
[Paddle table structure models](https://github.com/PaddlePaddle/PaddleOCR/blob/main/docs/version3.x/module_usage/table_structure_recognition.en.md).
