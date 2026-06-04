import type {
  Counterparty,
  CounterpartyAccount,
  CounterpartyAccountResponse,
  CounterpartyResponse,
  ListCounterpartiesResponse,
  ListCounterpartyAccountsResponse,
} from "@sdp/types";
import { z } from "zod";
import { getDb } from "@/db";
import type { CounterpartyRow } from "@/db/repositories/counterparty.repository";
import type { CounterpartyAccountRow } from "@/db/repositories/counterparty-account.repository";
import { getAuth, requireProjectId } from "@/lib/auth";
import { resolveCreatorUserId } from "@/lib/creator";
import {
  badRequest,
  badRequestParams,
  badRequestQuery,
  conflict,
  internalError,
  notFound,
} from "@/lib/errors";
import { created, noContent, success } from "@/lib/response";
import { AuditService } from "@/services/audit.service";
import {
  type AppContext,
  getCounterpartiesRepository,
  getCounterpartyAccountsRepository,
} from "./context";
import {
  counterpartyAccountIdParamsSchema,
  counterpartyIdParamsSchema,
  createCounterpartyAccountSchema,
  createCounterpartySchema,
  cryptoWalletAccountDetailsSchema,
  listCounterpartiesQuerySchema,
  listCounterpartyAccountsQuerySchema,
  updateCounterpartyAccountSchema,
  updateCounterpartySchema,
} from "./schemas";

function mapToCounterparty(row: CounterpartyRow): Counterparty {
  return {
    id: row.id,
    organizationId: row.organization_id,
    projectId: row.project_id,
    externalId: row.external_id,
    entityType: row.entity_type,
    displayName: row.display_name,
    email: row.email,
    identity: row.identity,
    status: row.status,
    createdBy: row.created_by,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapToCounterpartyAccount(row: CounterpartyAccountRow): CounterpartyAccount {
  return {
    id: row.id,
    organizationId: row.organization_id,
    projectId: row.project_id,
    counterpartyId: row.counterparty_id,
    accountKind: row.account_kind,
    label: row.label,
    details: row.details,
    providerAccountData: row.provider_account_data,
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

async function requireActiveCounterparty(c: AppContext, counterpartyId: string) {
  const auth = getAuth(c);
  const projectId = requireProjectId(c);
  const counterparty = await getCounterpartiesRepository(c).getCounterpartyById({
    counterpartyId,
    organizationId: auth.organizationId,
    projectId,
  });

  if (!counterparty) {
    throw notFound("Counterparty");
  }

  return counterparty;
}

export const listCounterparties = async (c: AppContext) => {
  const auth = getAuth(c);
  const projectId = requireProjectId(c);
  const parsed = listCounterpartiesQuerySchema.safeParse(c.req.query());

  if (!parsed.success) {
    throw badRequestQuery({ errors: z.treeifyError(parsed.error) });
  }

  const { page, pageSize, includeArchived } = parsed.data;

  const repo = getCounterpartiesRepository(c);
  const { rows, total } = await repo.listCounterparties({
    organizationId: auth.organizationId,
    projectId,
    includeArchived,
    limit: pageSize,
    offset: (page - 1) * pageSize,
  });

  const response: ListCounterpartiesResponse = {
    counterparties: rows.map(mapToCounterparty),
    total,
    page,
    pageSize,
  };

  return success(c, response);
};

export const getCounterparty = async (c: AppContext) => {
  const auth = getAuth(c);
  const projectId = requireProjectId(c);
  const params = counterpartyIdParamsSchema.safeParse(c.req.param());

  if (!params.success) {
    throw badRequestParams();
  }

  const repo = getCounterpartiesRepository(c);
  const counterparty = await repo.getCounterpartyById({
    counterpartyId: params.data.counterpartyId,
    organizationId: auth.organizationId,
    projectId,
  });

  if (!counterparty) {
    throw notFound("Counterparty");
  }

  const response: CounterpartyResponse = { counterparty: mapToCounterparty(counterparty) };
  return success(c, response);
};

export const listCounterpartyAccounts = async (c: AppContext) => {
  const auth = getAuth(c);
  const projectId = requireProjectId(c);
  const params = counterpartyIdParamsSchema.safeParse(c.req.param());

  if (!params.success) {
    throw badRequestParams();
  }

  const parsed = listCounterpartyAccountsQuerySchema.safeParse(c.req.query());
  if (!parsed.success) {
    throw badRequestQuery({ errors: z.treeifyError(parsed.error) });
  }

  await requireActiveCounterparty(c, params.data.counterpartyId);

  const { page, pageSize, accountKind, includeArchived } = parsed.data;
  const { rows, total } = await getCounterpartyAccountsRepository(
    c
  ).listCounterpartyAccountsByCounterparty({
    counterpartyId: params.data.counterpartyId,
    organizationId: auth.organizationId,
    projectId,
    accountKind,
    includeArchived,
    limit: pageSize,
    offset: (page - 1) * pageSize,
  });

  const response: ListCounterpartyAccountsResponse = {
    counterpartyAccounts: rows.map(mapToCounterpartyAccount),
    total,
    page,
    pageSize,
  };

  return success(c, response);
};

export const getCounterpartyAccount = async (c: AppContext) => {
  const auth = getAuth(c);
  const projectId = requireProjectId(c);
  const params = counterpartyAccountIdParamsSchema.safeParse(c.req.param());

  if (!params.success) {
    throw badRequestParams();
  }

  await requireActiveCounterparty(c, params.data.counterpartyId);

  const account = await getCounterpartyAccountsRepository(c).getCounterpartyAccountById({
    counterpartyAccountId: params.data.accountId,
    counterpartyId: params.data.counterpartyId,
    organizationId: auth.organizationId,
    projectId,
  });

  if (!account) {
    throw notFound("Counterparty account");
  }

  const response: CounterpartyAccountResponse = {
    counterpartyAccount: mapToCounterpartyAccount(account),
  };
  return success(c, response);
};

export const createCounterparty = async (c: AppContext) => {
  const auth = getAuth(c);
  const projectId = requireProjectId(c);
  const body = await c.req.json();
  const parsed = createCounterpartySchema.safeParse(body);

  if (!parsed.success) {
    throw badRequest("Invalid request body", { errors: z.treeifyError(parsed.error) });
  }

  const repo = getCounterpartiesRepository(c);

  if (parsed.data.externalId) {
    const existing = await repo.getCounterpartyByExternalId({
      externalId: parsed.data.externalId,
      organizationId: auth.organizationId,
      projectId,
    });
    if (existing) {
      throw conflict("A counterparty with this external ID already exists");
    }
  }

  const createdBy = await resolveCreatorUserId(c);

  const counterparty = await repo.createCounterparty({
    organizationId: auth.organizationId,
    projectId,
    externalId: parsed.data.externalId ?? null,
    entityType: parsed.data.entityType,
    displayName: parsed.data.displayName,
    email: parsed.data.email,
    identity: parsed.data.identity ?? {},
    createdBy,
  });

  if (!counterparty) {
    throw internalError("Failed to create counterparty");
  }

  const auditService = new AuditService(getDb(c.env));
  await auditService.log(c, {
    organizationId: auth.organizationId,
    userId: auth.userId ?? undefined,
    apiKeyId: auth.apiKeyId ?? undefined,
    action: "create",
    resourceType: "counterparty",
    resourceId: counterparty.id,
    metadata: {
      entityType: parsed.data.entityType,
      externalId: parsed.data.externalId,
    },
  });

  const response: CounterpartyResponse = { counterparty: mapToCounterparty(counterparty) };
  return created(c, response);
};

export const createCounterpartyAccount = async (c: AppContext) => {
  const auth = getAuth(c);
  const projectId = requireProjectId(c);
  const params = counterpartyIdParamsSchema.safeParse(c.req.param());

  if (!params.success) {
    throw badRequestParams();
  }

  const body = await c.req.json();
  const parsed = createCounterpartyAccountSchema.safeParse(body);

  if (!parsed.success) {
    throw badRequest("Invalid request body", { errors: z.treeifyError(parsed.error) });
  }

  await requireActiveCounterparty(c, params.data.counterpartyId);

  const account = await getCounterpartyAccountsRepository(c).createCounterpartyAccount({
    organizationId: auth.organizationId,
    projectId,
    counterpartyId: params.data.counterpartyId,
    accountKind: parsed.data.accountKind,
    label: parsed.data.label ?? null,
    details: parsed.data.details,
    providerAccountData: parsed.data.providerAccountData,
  });

  if (!account) {
    throw internalError("Failed to create counterparty account");
  }

  const auditService = new AuditService(getDb(c.env));
  await auditService.log(c, {
    organizationId: auth.organizationId,
    userId: auth.userId ?? undefined,
    apiKeyId: auth.apiKeyId ?? undefined,
    action: "create",
    resourceType: "counterparty_account",
    resourceId: account.id,
    metadata: {
      counterpartyId: params.data.counterpartyId,
      accountKind: parsed.data.accountKind,
    },
  });

  const response: CounterpartyAccountResponse = {
    counterpartyAccount: mapToCounterpartyAccount(account),
  };
  return created(c, response);
};

export const updateCounterparty = async (c: AppContext) => {
  const auth = getAuth(c);
  const projectId = requireProjectId(c);
  const params = counterpartyIdParamsSchema.safeParse(c.req.param());

  if (!params.success) {
    throw badRequestParams();
  }

  const body = await c.req.json();
  const parsed = updateCounterpartySchema.safeParse(body);

  if (!parsed.success) {
    throw badRequest("Invalid request body", { errors: z.treeifyError(parsed.error) });
  }

  const { counterpartyId } = params.data;
  const repo = getCounterpartiesRepository(c);

  if (parsed.data.externalId) {
    const existing = await repo.getCounterpartyByExternalId({
      externalId: parsed.data.externalId,
      organizationId: auth.organizationId,
      projectId,
    });
    if (existing && existing.id !== counterpartyId) {
      throw conflict("A counterparty with this external ID already exists");
    }
  }

  const updated = await repo.updateCounterparty({
    counterpartyId,
    organizationId: auth.organizationId,
    projectId,
    ...parsed.data,
  });

  if (!updated) {
    throw notFound("Counterparty");
  }

  const auditService = new AuditService(getDb(c.env));
  await auditService.log(c, {
    organizationId: auth.organizationId,
    userId: auth.userId ?? undefined,
    apiKeyId: auth.apiKeyId ?? undefined,
    action: "update",
    resourceType: "counterparty",
    resourceId: counterpartyId,
    metadata: { changedFields: Object.keys(parsed.data) },
  });

  const response: CounterpartyResponse = { counterparty: mapToCounterparty(updated) };
  return success(c, response);
};

export const updateCounterpartyAccount = async (c: AppContext) => {
  const auth = getAuth(c);
  const projectId = requireProjectId(c);
  const params = counterpartyAccountIdParamsSchema.safeParse(c.req.param());

  if (!params.success) {
    throw badRequestParams();
  }

  const body = await c.req.json();
  const parsed = updateCounterpartyAccountSchema.safeParse(body);

  if (!parsed.success) {
    throw badRequest("Invalid request body", { errors: z.treeifyError(parsed.error) });
  }

  await requireActiveCounterparty(c, params.data.counterpartyId);

  const repo = getCounterpartyAccountsRepository(c);
  const existing = await repo.getCounterpartyAccountById({
    counterpartyAccountId: params.data.accountId,
    counterpartyId: params.data.counterpartyId,
    organizationId: auth.organizationId,
    projectId,
  });

  if (!existing) {
    throw notFound("Counterparty account");
  }

  if (
    existing.account_kind === "crypto_wallet" &&
    parsed.data.details !== undefined &&
    !cryptoWalletAccountDetailsSchema.safeParse(parsed.data.details).success
  ) {
    throw badRequest("Invalid request body", {
      errors: {
        details: {
          errors: [
            'crypto_wallet accounts require details.network = "solana" and details.address as a Solana wallet address',
          ],
        },
      },
    });
  }

  const updated = await repo.updateCounterpartyAccount({
    counterpartyAccountId: params.data.accountId,
    counterpartyId: params.data.counterpartyId,
    organizationId: auth.organizationId,
    projectId,
    label: parsed.data.label,
    details: parsed.data.details,
    providerAccountData: parsed.data.providerAccountData,
  });

  if (!updated) {
    throw notFound("Counterparty account");
  }

  const auditService = new AuditService(getDb(c.env));
  await auditService.log(c, {
    organizationId: auth.organizationId,
    userId: auth.userId ?? undefined,
    apiKeyId: auth.apiKeyId ?? undefined,
    action: "update",
    resourceType: "counterparty_account",
    resourceId: params.data.accountId,
    metadata: {
      counterpartyId: params.data.counterpartyId,
      changedFields: Object.keys(parsed.data),
    },
  });

  const response: CounterpartyAccountResponse = {
    counterpartyAccount: mapToCounterpartyAccount(updated),
  };
  return success(c, response);
};

export const archiveCounterparty = async (c: AppContext) => {
  const auth = getAuth(c);
  const projectId = requireProjectId(c);
  const params = counterpartyIdParamsSchema.safeParse(c.req.param());

  if (!params.success) {
    throw badRequestParams();
  }

  const { counterpartyId } = params.data;
  const repo = getCounterpartiesRepository(c);

  const archived = await repo.archiveCounterparty({
    counterpartyId,
    organizationId: auth.organizationId,
    projectId,
  });

  if (!archived) {
    throw notFound("Counterparty");
  }

  const auditService = new AuditService(getDb(c.env));
  await auditService.log(c, {
    organizationId: auth.organizationId,
    userId: auth.userId ?? undefined,
    apiKeyId: auth.apiKeyId ?? undefined,
    action: "delete",
    resourceType: "counterparty",
    resourceId: counterpartyId,
  });

  return noContent(c);
};

export const archiveCounterpartyAccount = async (c: AppContext) => {
  const auth = getAuth(c);
  const projectId = requireProjectId(c);
  const params = counterpartyAccountIdParamsSchema.safeParse(c.req.param());

  if (!params.success) {
    throw badRequestParams();
  }

  await requireActiveCounterparty(c, params.data.counterpartyId);

  const archived = await getCounterpartyAccountsRepository(c).archiveCounterpartyAccount({
    counterpartyAccountId: params.data.accountId,
    counterpartyId: params.data.counterpartyId,
    organizationId: auth.organizationId,
    projectId,
  });

  if (!archived) {
    throw notFound("Counterparty account");
  }

  const auditService = new AuditService(getDb(c.env));
  await auditService.log(c, {
    organizationId: auth.organizationId,
    userId: auth.userId ?? undefined,
    apiKeyId: auth.apiKeyId ?? undefined,
    action: "delete",
    resourceType: "counterparty_account",
    resourceId: params.data.accountId,
    metadata: { counterpartyId: params.data.counterpartyId },
  });

  return noContent(c);
};
