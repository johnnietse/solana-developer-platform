import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { queryDatabricks } from "./databricks-query";

const mockEnv = {
  DATABRICKS_HOST: "dbc-abc123.cloud.databricks.com",
  DATABRICKS_TOKEN: "dapi-test-token",
  DATABRICKS_WAREHOUSE_ID: "test-warehouse-id",
};

beforeEach(() => {
  vi.spyOn(globalThis, "fetch").mockReset();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("queryDatabricks", () => {
  it("returns null when credentials are missing", async () => {
    const result = await queryDatabricks(
      { DATABRICKS_HOST: "", DATABRICKS_TOKEN: "", DATABRICKS_WAREHOUSE_ID: "" },
      "SELECT 1"
    );
    expect(result).toBeNull();
  });

  it("returns null on non-200 response", async () => {
    vi.mocked(globalThis.fetch).mockResolvedValueOnce(
      new Response("Unauthorized", { status: 401, statusText: "Unauthorized" })
    );

    const result = await queryDatabricks(mockEnv, "SELECT 1");
    expect(result).toBeNull();
  });

  it("returns null on non-SUCCEEDED status", async () => {
    vi.mocked(globalThis.fetch).mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          status: { state: "FAILED" },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      )
    );

    const result = await queryDatabricks(mockEnv, "SELECT 1");
    expect(result).toBeNull();
  });

  it("returns data_array on successful response", async () => {
    const dataArray = [
      ["col1", "col2"],
      ["val1", "val2"],
    ];
    vi.mocked(globalThis.fetch).mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          status: { state: "SUCCEEDED" },
          result: { data_array: dataArray },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      )
    );

    const result = await queryDatabricks(mockEnv, "SELECT * FROM table");
    expect(result).toEqual(dataArray);
  });
});