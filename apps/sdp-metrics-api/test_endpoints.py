#!/usr/bin/env python3
"""Hit each Flask route and print status + body."""

from app import app

ENDPOINTS = (
    "/healthz",
    "/metrics",
    "/rpc?days=1",
)


def main():
    client = app.test_client()
    for path in ENDPOINTS:
        resp = client.get(path)
        print(f"=== {path} ===")
        print(f"status: {resp.status_code}")
        print(f"body: {resp.get_data(as_text=True)}")
        print()

    resp = client.post(
        "/insert?table_name=dev.mlh.polars_metrics",
        json={"data": [{"id": 1, "name": "Supply", "unit": "USD", "tab": "Stablecoins"}]},
    )
    print("=== POST /insert ===")
    print(f"status: {resp.status_code}")
    print(f"body: {resp.get_data(as_text=True)}")


if __name__ == "__main__":
    main()
