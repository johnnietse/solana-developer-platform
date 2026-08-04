FROM python:3.12-slim

WORKDIR /app

# Install system deps (for Polars on slim image)
RUN apt-get update && apt-get install -y --no-install-recommends \
    libgomp1 \
    curl \
    && rm -rf /var/lib/apt/lists/*

# Install Python deps
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# Copy application
COPY . .

# Use gunicorn for production
EXPOSE 8080

# --workers must stay at 1: create_app() starts the ingestion scheduler, so a
# second worker would duplicate every 15-minute snapshot. Scale with tasks, not
# workers, or move the scheduler out of the web process first.
#
# The threads worker serves the REST endpoints correctly. flask-socketio needs a
# gevent/eventlet worker class, so /ws/* is degraded in this image — the three
# spec endpoints (/metrics, /rpc, /insert) are unaffected.
CMD ["gunicorn", "--bind", "0.0.0.0:8080", "--workers", "1", "--threads", "4", "--timeout", "120", "--access-logfile", "-", "--error-logfile", "-", "app:create_app()"]
