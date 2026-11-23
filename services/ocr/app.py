import asyncio
from contextlib import asynccontextmanager, closing
from hmac import compare_digest
import os
import socket
import math
from time import monotonic

from fastapi import FastAPI, HTTPException, Request
from starlette.concurrency import run_in_threadpool
import cv2
import numpy as np
import pypdfium2 as pdfium
from rapidocr import ModelType, OCRVersion, RapidOCR
import uvicorn
from table_output import html_cells, unmapped_numeric_tokens, uncovered_amounts


MAX_BYTES = 20 * 1024 * 1024
MAX_PAGES = 40
MAX_PIXELS = 4_000_000
MAX_SECONDS = 95
MODEL_DIRECTORY = os.environ.get("OCR_MODEL_DIR", "/opt/ocr-models")
MODEL_CONFIG = {
    "Det.ocr_version": OCRVersion.PPOCRV5,
    "Rec.ocr_version": OCRVersion.PPOCRV5,
    "Det.model_type": ModelType.MOBILE,
    "Rec.model_type": ModelType.MOBILE,
    "Det.lang_type": "multi",
    "Rec.lang_type": "en",
    "Det.model_path": os.path.join(MODEL_DIRECTORY, "ch_PP-OCRv5_det_mobile.onnx"),
    "Rec.model_path": os.path.join(MODEL_DIRECTORY, "en_PP-OCRv5_rec_mobile.onnx"),
    "Global.use_cls": False,
    "EngineConfig.onnxruntime.intra_op_num_threads": 1,
    "EngineConfig.onnxruntime.inter_op_num_threads": 1,
    "Det.limit_side_len": 1600,
    "Det.limit_type": "max",
}


TABLES_ENABLED = os.environ.get("PADDLE_TABLES_ENABLED", "true").lower() == "true"


def warmup_image():
    image = np.full((540, 1100, 3), 255, np.uint8)
    columns = [20, 240, 640, 800, 1080]
    for x in columns:
        cv2.line(image, (x, 30), (x, 510), (0, 0, 0), 2)
    for y in range(30, 511, 60):
        cv2.line(image, (20, y), (1080, y), (0, 0, 0), 2)
    for index, cells in enumerate([
        ["Date", "Description", "Amount NGN", "Balance"],
        ["01/10/2026", "PAYMENT ONE", "-100.00", "900.00"],
        ["02/10/2026", "PAYMENT TWO", "+50.00", "950.00"],
        ["03/10/2026", "PAYMENT THREE", "-100.00", "850.00"],
        ["04/10/2026", "PAYMENT FOUR", "-100.00", "750.00"],
        ["05/10/2026", "PAYMENT FIVE", "-100.00", "650.00"],
        ["06/10/2026", "PAYMENT SIX", "-100.00", "550.00"],
    ]):
        for x, text in zip(columns, cells):
            cv2.putText(image, text, (x + 10, 70 + index * 60), cv2.FONT_HERSHEY_SIMPLEX, 0.65, (0, 0, 0), 1)
    return image


def load_model():
    cv2.setNumThreads(1)
    model = RapidOCR(params=MODEL_CONFIG)
    image = warmup_image()
    recognized = model(image, use_cls=False)
    if not recognized.txts:
        raise RuntimeError("OCR_WARMUP_FAILED")
    engines = {"ocr": model}
    if TABLES_ENABLED:
        from rapid_layout import RapidLayout, RapidLayoutInput, ModelType as LayoutType
        from rapid_table import RapidTable, RapidTableInput, ModelType as TableType
        threads = {"intra_op_num_threads": 1, "inter_op_num_threads": 1}
        layout = RapidLayout(RapidLayoutInput(model_type=LayoutType.PP_LAYOUT_TABLE, engine_cfg=threads))
        table = RapidTable(RapidTableInput(model_type=TableType.SLANETPLUS,
            engine_cfg=threads, ocr_params=MODEL_CONFIG))
        layout(image)
        result = table(image, ocr_results=[(recognized.boxes, recognized.txts, recognized.scores)])
        if not result.pred_htmls or not html_cells(result.pred_htmls[0]):
            raise RuntimeError("TABLE_WARMUP_FAILED")
        engines.update({"layout": layout, "table": table})
    return engines


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
    return {"status": "ok", "contractVersion": 2 if TABLES_ENABLED else 1, "tablesEnabled": TABLES_ENABLED}


def structured_tables(engines, image, recognized, deadline):
    layout = engines["layout"](image)
    height, width = image.shape[:2]
    boxes = layout.boxes if layout.boxes is not None else []
    labels = layout.class_names if layout.class_names is not None else []
    regions = []
    for box, label in zip(boxes, labels):
        if str(label).lower() != "table":
            continue
        x1, y1, x2, y2 = [float(value) for value in box]
        if not all(math.isfinite(v) for v in [x1, y1, x2, y2]):
            continue
        region = (max(0, int(x1)), max(0, int(y1)), min(width, int(np.ceil(x2))), min(height, int(np.ceil(y2))))
        if region[2] > region[0] and region[3] > region[1]:
            regions.append(region)
    regions.sort(key=lambda box: (box[1], box[0]))
    tables, complete = [], bool(regions)
    covered = set()
    for x1, y1, x2, y2 in regions:
        if monotonic() >= deadline:
            raise HTTPException(503, "OCR_DEADLINE_EXCEEDED")
        selected = []
        if recognized.boxes is not None:
            for item_index, (polygon, text, score) in enumerate(zip(recognized.boxes, recognized.txts, recognized.scores)):
                center = np.mean(polygon, axis=0)
                if x1 <= center[0] <= x2 and y1 <= center[1] <= y2:
                    selected.append((polygon - np.array([x1, y1]), text, score))
                    covered.add(item_index)
        if not selected:
            complete = False
            continue
        polygons, texts, scores = zip(*selected)
        result = engines["table"](image[y1:y2, x1:x2],
            ocr_results=[(np.asarray(polygons), texts, scores)])
        if len(result.pred_htmls) != 1:
            complete = False
            continue
        try:
            rows = html_cells(result.pred_htmls[0])
        except ValueError:
            complete = False
            continue
        if not rows or unmapped_numeric_tokens(texts, rows):
            complete = False
        tables.append({"rows": rows})
    if uncovered_amounts(list(recognized.txts or []), covered):
        complete = False
    return tables, complete


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
                    result = model["ocr"](image, use_cls=False)
                    items = []
                    if result.boxes is not None and result.txts is not None:
                        if len(result.boxes) != len(result.txts):
                            raise HTTPException(503, "OCR_FAILED")
                        for box, text in zip(result.boxes, result.txts):
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
                    output = {"index": index, "items": items}
                    if TABLES_ENABLED:
                        blank = not items and float(np.std(image)) < 2.0
                        tables, complete = ([], True) if blank else structured_tables(model, image, result, deadline)
                        output.update({"tables": tables, "tableCoverageComplete": complete, "blank": blank})
                    pages.append(output)
        return {"pages": pages, **({"contractVersion": 2} if TABLES_ENABLED else {})}


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
