import type { CachedApiKey } from "@sdp/types";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { getDb } from "@/db";
import app from "@/index";
import { hashString } from "@/lib/hash";
import { createKVStoreSet } from "@/runtime/factory";
import { TEST_API_KEY, TEST_CACHED_API_KEY } from "@/test/fixtures/api-keys";
import { TEST_ORG, TEST_USER } from "@/test/fixtures/organizations";
import { TEST_PROJECT } from "@/test/fixtures/tokens";
import { env } from "@/test/helpers/env";
import { clearTestDatabase, seedTestDatabase } from "@/test/mocks/db";
import { seedCachedApiKey } from "@/test/mocks/kv";

const READ_ONLY_API_KEY = {
  id: "key_cpt_readonly",
  raw: "sk_test_cpt_readonly",
  prefix: "sk_test_cpr",
};

const READ_ONLY_CACHED_KEY: CachedApiKey = {
  id: READ_ONLY_API_KEY.id,
  organizationId: TEST_ORG.id,
  projectId: TEST_PROJECT.id,
  role: "api_admin",
  permissions: ["counterparties:read"],
  environment: "sandbox",
  rateLimitTier: "standard",
  allowedIps: null,
  signingWalletId: null,
  signingWalletIds: [],
  walletBindings: [],
  status: "active",
  expiresAt: null,
};

describe("Counterparties Routes", () => {
  let apiKeyHash: string;
  let readOnlyKeyHash: string;

  beforeAll(async () => {
    await seedTestDatabase(env as Parameters<typeof seedTestDatabase>[0]);

    apiKeyHash = await hashString(
      TEST_API_KEY.raw,
      (env as { API_KEY_PEPPER: string }).API_KEY_PEPPER
    );
    readOnlyKeyHash = await hashString(
      READ_ONLY_API_KEY.raw,
      (env as { API_KEY_PEPPER: string }).API_KEY_PEPPER
    );
  });

  afterAll(async () => {
    await clearTestDatabase(env as Parameters<typeof clearTestDatabase>[0]);
  });

  beforeEach(async () => {
    const db = getDb(env);
    const kv = createKVStoreSet(env);

    const rateLimitKeys = await kv.rateLimits.list();
    for (const key of rateLimitKeys.keys) {
      await kv.rateLimits.delete(key.name);
    }

    await db
      .prepare("DELETE FROM counterparties")
      .run()
      .catch(() => {});
    await db
      .prepare("DELETE FROM projects")
      .run()
      .catch(() => {});

    await db
      .prepare(
        "INSERT INTO organizations (id, name, slug, tier, status) VALUES (?, ?, ?, 'individual', 'active') ON CONFLICT (id) DO NOTHING"
      )
      .bind(TEST_ORG.id, TEST_ORG.name, TEST_ORG.slug)
      .run();

    await db
      .prepare(
        "INSERT INTO users (id, email, email_verified, status) VALUES (?, ?, 1, 'active') ON CONFLICT (id) DO NOTHING"
      )
      .bind(TEST_USER.id, TEST_USER.email)
      .run();

    await db
      .prepare(
        `INSERT INTO projects (id, organization_id, name, slug, environment, status, created_by)
         VALUES (?, ?, ?, ?, 'sandbox', 'active', ?)
         ON CONFLICT (id) DO NOTHING`
      )
      .bind(TEST_PROJECT.id, TEST_ORG.id, TEST_PROJECT.name, TEST_PROJECT.slug, TEST_USER.id)
      .run();

    await db
      .prepare(
        `INSERT INTO api_keys
         (id, organization_id, created_by, name, key_prefix, key_hash, role, permissions, environment, status)
         VALUES (?, ?, ?, 'Test Key', ?, ?, 'api_admin', '["*"]', 'sandbox', 'active')
         ON CONFLICT (id) DO NOTHING`
      )
      .bind(TEST_API_KEY.id, TEST_ORG.id, TEST_USER.id, TEST_API_KEY.prefix, apiKeyHash)
      .run();

    await db
      .prepare(
        `INSERT INTO api_keys
         (id, organization_id, project_id, created_by, name, key_prefix, key_hash, role, permissions, environment, status)
         VALUES (?, ?, ?, ?, 'Read-Only Key', ?, ?, 'api_admin', '["counterparties:read"]', 'sandbox', 'active')
         ON CONFLICT (id) DO NOTHING`
      )
      .bind(
        READ_ONLY_API_KEY.id,
        TEST_ORG.id,
        TEST_PROJECT.id,
        TEST_USER.id,
        READ_ONLY_API_KEY.prefix,
        readOnlyKeyHash
      )
      .run();

    await seedCachedApiKey(env, apiKeyHash, TEST_CACHED_API_KEY);
    await seedCachedApiKey(env, readOnlyKeyHash, READ_ONLY_CACHED_KEY);
  });

  describe("POST /v1/counterparties", () => {
    it("creates a counterparty when projectId is supplied", async () => {
      const res = await app.request(
        "/v1/counterparties",
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${TEST_API_KEY.raw}`,
          },
          body: JSON.stringify({
            projectId: TEST_PROJECT.id,
            entityType: "individual",
            displayName: "Ada Lovelace",
            email: "ada@example.com",
            externalId: "cust_001",
            identity: { firstName: "Ada", lastName: "Lovelace" },
          }),
        },
        env
      );

      expect(res.status).toBe(201);
      const body = await res.json();
      expect(body.data.counterparty).toBeDefined();
      expect(body.data.counterparty.id).toMatch(/^cpt_/);
      expect(body.data.counterparty.organizationId).toBe(TEST_ORG.id);
      expect(body.data.counterparty.projectId).toBe(TEST_PROJECT.id);
      expect(body.data.counterparty.entityType).toBe("individual");
      expect(body.data.counterparty.displayName).toBe("Ada Lovelace");
      expect(body.data.counterparty.email).toBe("ada@example.com");
      expect(body.data.counterparty.externalId).toBe("cust_001");
      expect(body.data.counterparty.isActive).toBe(true);
    });

    it("returns 401 without auth", async () => {
      const res = await app.request(
        "/v1/counterparties",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            projectId: TEST_PROJECT.id,
            entityType: "individual",
            displayName: "Ada",
            email: "ada@example.com",
          }),
        },
        env
      );

      expect(res.status).toBe(401);
    });

    it("returns 403 when API key lacks counterparties:write", async () => {
      const res = await app.request(
        "/v1/counterparties",
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${READ_ONLY_API_KEY.raw}`,
          },
          body: JSON.stringify({
            entityType: "individual",
            displayName: "Ada",
            email: "ada@example.com",
          }),
        },
        env
      );

      expect(res.status).toBe(403);
    });

    it("returns 400 when required fields are missing", async () => {
      const res = await app.request(
        "/v1/counterparties",
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${TEST_API_KEY.raw}`,
          },
          body: JSON.stringify({
            projectId: TEST_PROJECT.id,
            displayName: "No Entity Type",
          }),
        },
        env
      );

      expect(res.status).toBe(400);
    });

    it("returns 400 when org-scoped key omits projectId", async () => {
      const res = await app.request(
        "/v1/counterparties",
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${TEST_API_KEY.raw}`,
          },
          body: JSON.stringify({
            entityType: "individual",
            displayName: "Ada",
            email: "ada@example.com",
          }),
        },
        env
      );

      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error.message).toContain("projectId");
    });

    it("returns 400 when body projectId conflicts with project-scoped key", async () => {
      const conflictKeyHash = await hashString(
        "sk_test_conflict_key",
        (env as { API_KEY_PEPPER: string }).API_KEY_PEPPER
      );
      await seedCachedApiKey(env, conflictKeyHash, {
        ...READ_ONLY_CACHED_KEY,
        id: "key_cpt_writer",
        permissions: ["counterparties:write"],
      });
      await getDb(env)
        .prepare(
          `INSERT INTO api_keys
           (id, organization_id, project_id, created_by, name, key_prefix, key_hash, role, permissions, environment, status)
           VALUES (?, ?, ?, ?, 'Project Writer Key', 'sk_test_con', ?, 'api_admin', '["counterparties:write"]', 'sandbox', 'active')
           ON CONFLICT (id) DO NOTHING`
        )
        .bind(
          "key_cpt_writer",
          TEST_ORG.id,
          TEST_PROJECT.id,
          TEST_USER.id,
          conflictKeyHash
        )
        .run();

      const res = await app.request(
        "/v1/counterparties",
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: "Bearer sk_test_conflict_key",
          },
          body: JSON.stringify({
            projectId: "prj_some_other_project",
            entityType: "individual",
            displayName: "Mismatch",
            email: "mismatch@example.com",
          }),
        },
        env
      );

      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error.message).toContain("scope");
    });

    it("returns 409 on duplicate externalId in same project", async () => {
      const baseBody = {
        projectId: TEST_PROJECT.id,
        entityType: "individual" as const,
        displayName: "First",
        email: "first@example.com",
        externalId: "dup_001",
      };

      const first = await app.request(
        "/v1/counterparties",
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${TEST_API_KEY.raw}`,
          },
          body: JSON.stringify(baseBody),
        },
        env
      );
      expect(first.status).toBe(201);

      const dup = await app.request(
        "/v1/counterparties",
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${TEST_API_KEY.raw}`,
          },
          body: JSON.stringify({ ...baseBody, displayName: "Second" }),
        },
        env
      );

      expect(dup.status).toBe(409);
      const body = await dup.json();
      expect(body.error.code).toBe("CONFLICT");
    });

    it("writes a counterparty audit log entry", async () => {
      const res = await app.request(
        "/v1/counterparties",
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${TEST_API_KEY.raw}`,
          },
          body: JSON.stringify({
            projectId: TEST_PROJECT.id,
            entityType: "business",
            displayName: "Audit Test Co",
            email: "ops@audit.test",
          }),
        },
        env
      );
      expect(res.status).toBe(201);
      const body = await res.json();
      const counterpartyId = body.data.counterparty.id;

      const auditRow = await getDb(env)
        .prepare(
          "SELECT action, resource_type, resource_id, api_key_id FROM audit_logs WHERE resource_id = ? AND resource_type = 'counterparty'"
        )
        .bind(counterpartyId)
        .first<{
          action: string;
          resource_type: string;
          resource_id: string;
          api_key_id: string;
        }>();

      expect(auditRow).toBeTruthy();
      expect(auditRow?.action).toBe("create");
      expect(auditRow?.resource_type).toBe("counterparty");
      expect(auditRow?.api_key_id).toBe(TEST_API_KEY.id);
    });
  });
});
