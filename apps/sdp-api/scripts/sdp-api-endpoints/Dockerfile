FROM python:3.12-slim

# libgomp1 is a runtime dependency of Polars' native engine — without it the
# import fails at container start with "libgomp.so.1: cannot open shared object
# file", which looks like a Python packaging problem but is a missing OS library.
# curl is here for the ECS health check, which runs inside the container.
RUN apt-get update \
    && apt-get install -y --no-install-recommends libgomp1 curl \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Dependencies before source, so an application change does not invalidate the
# pip layer and force a full reinstall on every build.
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY *.py ./

# Run as a non-root user. Nothing here needs root, and a container that does not
# have it cannot be talked into using it.
RUN useradd --system --uid 1001 --create-home appuser \
    && chown -R appuser:appuser /app
USER appuser

ENV PORT=8080 \
    PYTHONUNBUFFERED=1
EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
    CMD curl -fsS http://localhost:8080/healthz || exit 1

# Threads rather than extra workers: the work here is waiting on S3 and the
# Solana RPC, not burning CPU, so threads carry the concurrency at a fraction of
# the memory. 120s timeout because an uncached /rpc call paginates the RPC and
# can legitimately outlast gunicorn's 30s default.
CMD ["gunicorn", "--bind", "0.0.0.0:8080", \
     "--workers", "1", "--threads", "4", "--timeout", "120", \
     "--access-logfile", "-", "--error-logfile", "-", \
     "app:app"]
