import { Hono } from "hono";
import { requirePermissions, unifiedAuthMiddleware } from "@/middleware/auth";
import type { Env } from "@/types/env";
import { createCounterparty } from "./handlers/counterparties";

const counterparties = new Hono<{ Bindings: Env }>();

counterparties.use("*", unifiedAuthMiddleware({ allowClerk: true, allowSession: true }));

counterparties.post("/", requirePermissions("counterparties:write"), createCounterparty);

export default counterparties;
