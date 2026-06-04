import { Hono } from "hono";
import { requirePermissions, unifiedAuthMiddleware } from "@/middleware/auth";
import { projectContextMiddleware } from "@/middleware/project-context";
import type { Env } from "@/types/env";
import {
  archiveCounterparty,
  archiveCounterpartyAccount,
  createCounterparty,
  createCounterpartyAccount,
  getCounterparty,
  getCounterpartyAccount,
  listCounterparties,
  listCounterpartyAccounts,
  updateCounterparty,
  updateCounterpartyAccount,
} from "./handlers";

const counterparties = new Hono<{ Bindings: Env }>();

counterparties.use("*", unifiedAuthMiddleware({ allowClerk: true, allowSession: true }));
counterparties.use("*", projectContextMiddleware());

counterparties.get("/", requirePermissions("counterparties:read"), listCounterparties);
counterparties.post("/", requirePermissions("counterparties:write"), createCounterparty);
counterparties.get(
  "/:counterpartyId/accounts",
  requirePermissions("counterparties:read"),
  listCounterpartyAccounts
);
counterparties.post(
  "/:counterpartyId/accounts",
  requirePermissions("counterparties:write"),
  createCounterpartyAccount
);
counterparties.get(
  "/:counterpartyId/accounts/:accountId",
  requirePermissions("counterparties:read"),
  getCounterpartyAccount
);
counterparties.patch(
  "/:counterpartyId/accounts/:accountId",
  requirePermissions("counterparties:write"),
  updateCounterpartyAccount
);
counterparties.delete(
  "/:counterpartyId/accounts/:accountId",
  requirePermissions("counterparties:write"),
  archiveCounterpartyAccount
);
counterparties.get("/:counterpartyId", requirePermissions("counterparties:read"), getCounterparty);
counterparties.patch(
  "/:counterpartyId",
  requirePermissions("counterparties:write"),
  updateCounterparty
);
counterparties.delete(
  "/:counterpartyId",
  requirePermissions("counterparties:write"),
  archiveCounterparty
);

export default counterparties;
