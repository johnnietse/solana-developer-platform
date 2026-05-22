import type { CounterpartyResponse } from "@sdp/types";
import type { Context } from "hono";
import { getDb } from "@/db";
import { createCounterpartiesRepository } from "@/db/repositories";
import { getAuth } from "@/lib/auth";
import { AppError } from "@/lib/errors";
import { created } from "@/lib/response";
import { AuditService } from "@/services/audit.service";
import { CounterpartyService, CounterpartyServiceError } from "@/services/counterparty.service";
import type { Env } from "@/types/env";
import { createCounterpartySchema } from "../schemas";

type AppContext = Context<{ Bindings: Env }>;

/**
 * Reject a body-supplied projectId that conflicts with the auth-scoped projectId.
 * Org-scoped keys may omit projectId in the body; project-scoped keys may not override their scope.
 */
function assertCounterpartyProjectScope(
  bodyProjectId: string | undefined,
  authProjectId: string | null
): void {
  if (!bodyProjectId || !authProjectId) {
    return;
  }

  if (bodyProjectId !== authProjectId) {
    throw new AppError(
      "BAD_REQUEST",
      "projectId does not match the authenticated API key scope"
    );
  }
}

async function resolveCreatorUserId(c: AppContext): Promise<string | null> {
  const auth = getAuth(c);

  if (auth.userId) {
    return auth.userId;
  }

  if (!auth.apiKeyId) {
    return null;
  }

  const creator = await getDb(c.env)
    .prepare("SELECT created_by FROM api_keys WHERE id = ?")
    .bind(auth.apiKeyId)
    .first<{ created_by: string }>();

  return creator?.created_by ?? null;
}

export const createCounterparty = async (c: AppContext) => {
  const auth = getAuth(c);

  const body = await c.req.json();
  const parsed = createCounterpartySchema.safeParse(body);

  if (!parsed.success) {
    throw new AppError("BAD_REQUEST", "Invalid request body", {
      errors: parsed.error.flatten().fieldErrors,
    });
  }

  assertCounterpartyProjectScope(parsed.data.projectId, auth.projectId);

  const projectId = parsed.data.projectId ?? auth.projectId;
  if (!projectId) {
    throw new AppError("BAD_REQUEST", "projectId is required for org-scoped API keys");
  }

  const createdBy = await resolveCreatorUserId(c);

  const service = new CounterpartyService(createCounterpartiesRepository(c.env));

  try {
    const counterparty = await service.createCounterparty({
      organizationId: auth.organizationId,
      projectId,
      createdBy,
      externalId: parsed.data.externalId,
      entityType: parsed.data.entityType,
      displayName: parsed.data.displayName,
      email: parsed.data.email,
      identity: parsed.data.identity,
    });

    const auditService = new AuditService(getDb(c.env));
    await auditService.log(c, {
      action: "create",
      resourceType: "counterparty",
      resourceId: counterparty.id,
      metadata: {
        projectId: counterparty.projectId,
        entityType: counterparty.entityType,
        externalId: counterparty.externalId,
      },
    });

    const response: CounterpartyResponse = { counterparty };
    return created(c, response);
  } catch (error) {
    if (error instanceof CounterpartyServiceError && error.code === "DUPLICATE_EXTERNAL_ID") {
      throw new AppError(
        "CONFLICT",
        "A counterparty with this externalId already exists for this project"
      );
    }
    throw error;
  }
};
