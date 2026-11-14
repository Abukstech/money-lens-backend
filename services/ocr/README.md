# MoneyLens OCR service

This service uses PP-OCRv5 mobile through RapidOCR and ONNX Runtime on CPU. It returns text and bounding boxes to MoneyLens, which parses transactions and applies its existing validation. PDFs and OCR output stay in memory. The service accepts one PDF at a time, up to 20 MiB and 40 pages, with one inference worker.

## Docker Desktop

Generate a shared token with `openssl rand -hex 32` and put it in the API's local `.env` as `PADDLE_OCR_TOKEN`. From the MoneyLens repository root, with Docker Desktop running:

```sh
docker compose up -d --build ocr
curl --fail http://127.0.0.1:8080/health
```

For `npm run dev`, set `PADDLE_OCR_URL=http://127.0.0.1:8080`. For the Compose API, set `COMPOSE_PADDLE_OCR_URL=http://ocr:8080`. A configured PaddleOCR URL takes precedence over Mistral. A failed OCR request can fall back to a locally verified result.

## Railway

Create an OCR service from this repository in the same Railway environment as the API. Set its Root Directory to `/services/ocr`. Railway will build the Dockerfile in that directory. Configure `PORT=8080`, set `PADDLE_OCR_TOKEN` to a newly generated shared secret, and set the healthcheck path to `/health`. Leave public networking disabled.

Set `PADDLE_OCR_URL=http://ocr.railway.internal:8080` on the MoneyLens service, substituting the OCR service's internal hostname, and set the same `PADDLE_OCR_TOKEN`. No volume is required. The image includes the two model files and verifies their checksums during the build. Check peak memory with representative redacted statements before selecting a Railway resource limit.

The OCR service supplies recognized text. When the original PDF has no independently verifiable text, MoneyLens can save OCR transactions for review through the draft route.
