

import os

import polars as pl
from flask import Flask, jsonify

app = Flask(__name__)

S3_PARQUET_PATH = os.environ.get("S3_PARQUET_PATH", "s3://tmp-sdp-data/dev/mlh/**/*.parquet")

# Static keys if they're set, otherwise polars falls back to the default AWS
# chain (~/.aws/credentials, ECS task role, instance profile).
STORAGE_OPTIONS = {
    key: value
    for key, value in {
        "aws_region": os.environ.get("AWS_REGION", "us-east-1"),
        "aws_access_key_id": os.environ.get("AWS_ACCESS_KEY_ID"),
        "aws_secret_access_key": os.environ.get("AWS_SECRET_ACCESS_KEY"),
        "aws_session_token": os.environ.get("AWS_SESSION_TOKEN"),
    }.items()
    if value
}


@app.get("/healthz")
def healthz():
    return jsonify(status="ok")


@app.get("/metric")
def get_data():
    df = pl.read_parquet(S3_PARQUET_PATH, storage_options=STORAGE_OPTIONS)
    return jsonify(data=df.to_dicts())


if __name__ == "__main__":
    app.run(host="0.0.0.0", port=int(os.environ.get("PORT", "8080")))
