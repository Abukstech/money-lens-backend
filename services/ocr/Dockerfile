FROM python:3.12-slim-bookworm

ENV PYTHONUNBUFFERED=1 PYTHONDONTWRITEBYTECODE=1 OMP_NUM_THREADS=1 OPENBLAS_NUM_THREADS=1
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends fonts-liberation libgomp1 \
    && rm -rf /var/lib/apt/lists/*
COPY requirements.txt ./
RUN pip install --no-cache-dir --timeout 90 --retries 5 -r requirements.txt
COPY app.py ./
COPY models /opt/ocr-models
RUN cd /opt/ocr-models && sha256sum -c SHA256SUMS \
    && useradd --create-home --uid 10001 ocr
USER ocr
RUN python -X faulthandler -c 'from app import load_model; load_model()'
EXPOSE 8080
CMD ["python", "app.py"]
