import type { Counterparty, CounterpartyEntityType, CounterpartyIdentity } from "@sdp/types";
import type {
  CounterpartiesRepository,
  CounterpartyRow,
} from "@/db/repositories/counterparty.repository";

export interface CreateCounterpartyInput {
  organizationId: string;
  projectId: string;
  createdBy: string | null;
  externalId?: string | null;
  entityType: CounterpartyEntityType;
  displayName: string;
  email: string;
  identity?: CounterpartyIdentity;
}

export type CounterpartyServiceErrorCode = "DUPLICATE_EXTERNAL_ID";

export class CounterpartyServiceError extends Error {
  constructor(
    public readonly code: CounterpartyServiceErrorCode,
    message?: string
  ) {
    super(message ?? code);
    this.name = "CounterpartyServiceError";
  }
}

export class CounterpartyService {
  constructor(private repository: CounterpartiesRepository) {}

  /**
   * Create a counterparty within the (organization, project) scope.
   * Throws CounterpartyServiceError("DUPLICATE_EXTERNAL_ID") when an active
   * counterparty with the same externalId already exists in scope.
   */
  async createCounterparty(input: CreateCounterpartyInput): Promise<Counterparty> {
    const externalId = input.externalId ?? null;

    if (externalId) {
      const existing = await this.repository.getCounterpartyByExternalId({
        externalId,
        organizationId: input.organizationId,
        projectId: input.projectId,
      });

      if (existing) {
        throw new CounterpartyServiceError("DUPLICATE_EXTERNAL_ID");
      }
    }

    const now = new Date().toISOString();

    const row = await this.repository.createCounterparty({
      id: this.generateCounterpartyId(),
      organizationId: input.organizationId,
      projectId: input.projectId,
      externalId,
      entityType: input.entityType,
      displayName: input.displayName,
      email: input.email,
      identity: input.identity ?? {},
      createdBy: input.createdBy,
      createdAt: now,
      updatedAt: now,
    });

    if (!row) {
      throw new Error("Counterparty creation did not return a row");
    }

    return this.mapRowToCounterparty(row);
  }

  private generateCounterpartyId(): string {
    return `cpt_${crypto.randomUUID()}`;
  }

  private mapRowToCounterparty(row: CounterpartyRow): Counterparty {
    return {
      id: row.id,
      organizationId: row.organization_id,
      projectId: row.project_id,
      externalId: row.external_id,
      entityType: row.entity_type,
      displayName: row.display_name,
      email: row.email,
      identity: row.identity,
      isActive: row.is_active,
      createdBy: row.created_by,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }
}
