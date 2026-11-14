import asyncio
from contextlib import asynccontextmanager, closing
from hmac import compare_digest
import os
import socket
from time import monotonic

from fastapi import FastAPI, HTTPException, Request
from starlette.concurrency import run_in_threadpool
import cv2
import numpy as np
import pypdfium2 as pdfium
from rapidocr import ModelType, OCRVersion, RapidOCR
import uvicorn


MAX_BYTES = 20 * 1024 * 1024
MAX_PAGES = 40
MAX_PIXELS = 4_000_000
MAX_SECONDS = 95
MODEL_CONFIG = {
    "Det.ocr_version": OCRVersion.PPOCRV5,
    "Rec.ocr_version": OCRVersion.PPOCRV5,
    "Det.model_type": ModelType.MOBILE,
    "Rec.model_type": ModelType.MOBILE,
    "Det.lang_type": "multi",
    "Rec.lang_type": "en",
    "Det.model_path": "/opt/ocr-models/ch_PP-OCRv5_det_mobile.onnx",
    "Rec.model_path": "/opt/ocr-models/en_PP-OCRv5_rec_mobile.onnx",
    "Global.use_cls": False,
    "EngineConfig.onnxruntime.intra_op_num_threads": 1,
    "EngineConfig.onnxruntime.inter_op_num_threads": 1,
    "Det.limit_side_len": 1600,
    "Det.limit_type": "max",
}


def load_model():
    cv2.setNumThreads(1)
    model = RapidOCR(params=MODEL_CONFIG)
    # RapidOCR loads models lazily. Warm up detection and recognition.
    image = np.full((160, 500, 3), 255, np.uint8)
    cv2.putText(image, "OCR 12345", (20, 100), cv2.FONT_HERSHEY_SIMPLEX, 2, (0, 0, 0), 3)
    if not model(image, use_cls=False).txts:
        raise RuntimeError("OCR_WARMUP_FAILED")
    return model


@asynccontextmanager
async def lifespan(app):
    token = os.environ.get("PADDLE_OCR_TOKEN", "")
    if len(token) < 32:
        raise RuntimeError("OCR_TOKEN_REQUIRED")
    app.state.authorization = f"Bearer {token}".encode()
    app.state.model = load_model()
    app.state.slot = asyncio.Lock()
    yield


app = FastAPI(lifespan=lifespan, docs_url=None, redoc_url=None, openapi_url=None)


@app.get("/health")
def health():
    return {"status": "ok"}


def read_pages(model, data, deadline):
    try:
        pdf = pdfium.PdfDocument(data)
    except pdfium.PdfiumError:
        raise HTTPException(400, "INVALID_PDF") from None

    with pdf:
        if not 1 <= len(pdf) <= MAX_PAGES:
            raise HTTPException(422, "OCR_PAGE_LIMIT")
        pages = []
        for index in range(len(pdf)):
            if monotonic() >= deadline:
                raise HTTPException(503, "OCR_DEADLINE_EXCEEDED")
            with closing(pdf[index]) as page:
                width, height = page.get_size()
                scale = min(2.5, (MAX_PIXELS / max(1, width * height)) ** 0.5)
                if min(width, height) <= 0 or max(width, height) * scale > 4096:
                    raise HTTPException(422, "OCR_PAGE_DIMENSIONS")
                with closing(page.render(scale=scale)) as bitmap:
                    image = bitmap.to_numpy()
                    if image.shape[2] == 4:
                        image = cv2.cvtColor(image, cv2.COLOR_BGRA2BGR)
                    result = model(image, use_cls=False)
                    items = []
                    if result.boxes is not None and result.txts is not None:
                        for box, text in zip(result.boxes, result.txts, strict=True):
                            x1, y1 = box.min(axis=0)
                            x2, y2 = box.max(axis=0)
                            if text.strip() and x2 > x1 and y2 > y1:
                                items.append({
                                    "text": text,
                                    "x": float(x1) / scale,
                                    "y": height - float(y1 + y2) / (2 * scale),
                                    "width": float(x2 - x1) / scale,
                                    "height": float(y2 - y1) / scale,
                                })
                    pages.append({"index": index, "items": items})
        return {"pages": pages}


@app.post("/ocr")
async def ocr(request: Request):
    supplied = request.headers.get("authorization", "").encode()
    if not compare_digest(supplied, app.state.authorization):
        raise HTTPException(401, "OCR_UNAUTHORIZED")
    if request.headers.get("content-type") != "application/pdf":
        raise HTTPException(415, "PDF_REQUIRED")
    if app.state.slot.locked():
        raise HTTPException(503, "OCR_BUSY", headers={"Retry-After": "2"})

    async with app.state.slot:
        deadline = monotonic() + MAX_SECONDS
        data = bytearray()
        try:
            async with asyncio.timeout(15):
                async for chunk in request.stream():
                    if len(data) + len(chunk) > MAX_BYTES:
                        raise HTTPException(413, "OCR_UPLOAD_TOO_LARGE")
                    data.extend(chunk)
        except TimeoutError:
            raise HTTPException(408, "OCR_UPLOAD_TIMEOUT") from None
        if not data.startswith(b"%PDF-"):
            raise HTTPException(400, "INVALID_PDF")
        try:
            return await run_in_threadpool(read_pages, app.state.model, bytes(data), deadline)
        except HTTPException:
            raise
        except Exception:
            raise HTTPException(503, "OCR_FAILED") from None


if __name__ == "__main__":
    port = int(os.environ.get("PORT", "8080"))
    listener = socket.create_server(("::", port), family=socket.AF_INET6, dualstack_ipv6=True)
    server = uvicorn.Server(uvicorn.Config(app, access_log=False))
    server.run(sockets=[listener])
