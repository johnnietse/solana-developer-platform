import urllib.request
import urllib.error
import json
import sys

BASE_URL = "http://localhost:8080"

def test_metrics():
    print("Testing GET /metrics...")
    try:
        req = urllib.request.Request(f"{BASE_URL}/metrics?days=1")
        with urllib.request.urlopen(req) as resp:
            data = json.loads(resp.read().decode())
            print(f"[SUCCESS] /metrics success: {len(data)} records returned")
            return True
    except urllib.error.HTTPError as e:
        print(f"[FAIL] /metrics failed: {e.code} {e.reason} - {e.read().decode()}")
        return False
    except Exception as e:
        print(f"[FAIL] /metrics failed: {e}")
        return False

def test_insert():
    print("Testing POST /insert...")
    payload = json.dumps({"data": [{"test_col": "test_val", "value": 123}]}).encode()
    try:
        req = urllib.request.Request(
            f"{BASE_URL}/insert?table_name=dev.mlh.smoke_test&mode=overwrite",
            data=payload,
            headers={"Content-Type": "application/json"},
            method="POST"
        )
        with urllib.request.urlopen(req) as resp:
            data = json.loads(resp.read().decode())
            print(f"[SUCCESS] /insert success: {data}")
            return True
    except urllib.error.HTTPError as e:
        print(f"[FAIL] /insert failed: {e.code} {e.reason} - {e.read().decode()}")
        return False
    except Exception as e:
        print(f"[FAIL] /insert failed: {e}")
        return False

def test_rpc():
    print("Testing GET /rpc...")
    # devnet USDC
    mint = "Gh9ZwEmdLJ8DscKNTkTqPbNwLNNBjuSzaG9Vp2KGtKJr"
    try:
        req = urllib.request.Request(f"{BASE_URL}/rpc?token_address={mint}&limit=10")
        with urllib.request.urlopen(req) as resp:
            data = json.loads(resp.read().decode())
            print(f"[SUCCESS] /rpc success: found {data.get('total')} transfers")
            return True
    except urllib.error.HTTPError as e:
        print(f"[FAIL] /rpc failed: {e.code} {e.reason} - {e.read().decode()}")
        return False
    except Exception as e:
        print(f"[FAIL] /rpc failed: {e}")
        return False

def main():
    print(f"Running smoke tests against {BASE_URL}")
    print("Make sure the server is running!")
    print("-" * 40)
    
    success = True
    success &= test_metrics()
    print()
    success &= test_insert()
    print()
    success &= test_rpc()
    
    print("-" * 40)
    if success:
        print("All smoke tests passed!")
        sys.exit(0)
    else:
        print("Some smoke tests failed.")
        sys.exit(1)

if __name__ == "__main__":
    if len(sys.argv) > 1:
        BASE_URL = sys.argv[1].rstrip("/")
    main()
