import type { Context, Next } from "hono";
import { getDb } from "@/db";
import { AppError } from "@/lib/errors";
import type { Env } from "@/types/env";

const PROJECT_HEADER = "x-project-id";

export function projectContextMiddleware() {
  return async (c: Context<{ Bindings: Env }>, next: Next) => {
    const apiKey = c.get("apiKey");
    if (apiKey) {
      c.set("projectId", apiKey.projectId);
      return next();
    }

    const clerk = c.get("clerk");
    const session = c.get("session");
    const orgId = clerk?.organizationId ?? session?.organizationId;
    const userId = clerk?.userId ?? session?.userId;

    if (!orgId || !userId) {
      return next();
    }

    const requested = c.req.header(PROJECT_HEADER) ?? c.req.query("projectId") ?? null;

    const projectId = requested
      ? await assertProjectMembership(c, orgId, userId, requested)
      : await findDefaultSandboxProjectId(c, orgId, userId);

    if (!projectId) {
      throw new AppError("FORBIDDEN", "No project associated with this organization");
    }

    c.set("projectId", projectId);
    await next();
  };
}

async function assertProjectMembership(
  c: Context<{ Bindings: Env }>,
  organizationId: string,
  userId: string,
  projectId: string
): Promise<string> {
  const row = await getDb(c.env)
    .prepare(
      `SELECT p.id
       FROM projects p
       JOIN project_members pm ON pm.project_id = p.id
       WHERE p.id = ? AND p.organization_id = ? AND p.status = 'active' AND pm.user_id = ?
       LIMIT 1`
    )
    .bind(projectId, organizationId, userId)
    .first<{ id: string }>();

  if (!row) {
    throw new AppError("FORBIDDEN", "Requested project is not accessible");
  }

  return row.id;
}

async function findDefaultSandboxProjectId(
  c: Context<{ Bindings: Env }>,
  organizationId: string,
  userId: string
): Promise<string | null> {
  const row = await getDb(c.env)
    .prepare(
      `SELECT p.id
       FROM projects p
       JOIN project_members pm ON pm.project_id = p.id
       WHERE p.organization_id = ? AND p.slug = 'default-sandbox' AND p.status = 'active' AND pm.user_id = ?
       LIMIT 1`
    )
    .bind(organizationId, userId)
    .first<{ id: string }>();

  return row?.id ?? null;
}
