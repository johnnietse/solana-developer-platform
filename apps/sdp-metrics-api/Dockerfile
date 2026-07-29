# syntax=docker/dockerfile:1.7
#
# sdp-metrics-api — Flask + Polars service that serves Solana overview
# metrics read from a Delta table in S3. Build context is this directory:
#
#     docker build -t sdp-metrics-api apps/sdp-metrics-api

FROM python:3.12-slim AS base
ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1

FROM base AS deps
WORKDIR /app
COPY requirements.txt ./
RUN pip install --user -r requirements.txt

FROM base AS runner
WORKDIR /app

# Needed for the HEALTHCHECK below; OS security patches for the base image.
RUN apt-get update && apt-get upgrade -y \
 && apt-get install -y --no-install-recommends curl \
 && rm -rf /var/lib/apt/lists/*

RUN groupadd --system --gid 1001 metrics \
 && useradd --system --uid 1001 --gid metrics metrics

COPY --from=deps --chown=metrics:metrics /root/.local /home/metrics/.local
COPY --chown=metrics:metrics app.py ./

# HOME is set explicitly because boto3 resolves ~/.aws from it; without it
# a mounted credentials/config file is invisible to the credential provider.
ENV PATH=/home/metrics/.local/bin:$PATH \
    HOME=/home/metrics \
    PORT=8080

ARG GIT_SHA=""
ARG IMAGE_SOURCE="https://github.com/solana-foundation/solana-developer-platform"
LABEL org.opencontainers.image.title="sdp-metrics-api" \
      org.opencontainers.image.description="Solana Developer Platform — metrics API (Flask + Polars, reads a Delta table from S3)" \
      org.opencontainers.image.source="$IMAGE_SOURCE" \
      org.opencontainers.image.revision="$GIT_SHA" \
      org.opencontainers.image.licenses="MIT"

USER metrics
EXPOSE 8080

# Liveness only — /healthz never touches S3, so it can't flap on Delta
# table availability. Suitable as-is for the ECS container health check too.
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
    CMD curl -f "http://127.0.0.1:${PORT}/healthz" || exit 1

CMD ["gunicorn", "--bind", "0.0.0.0:8080", "--workers", "2", "--threads", "4", "--timeout", "60", "app:app"]
