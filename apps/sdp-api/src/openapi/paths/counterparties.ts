import type { OpenAPIRegistry } from "@asteasolutions/zod-to-openapi";

import { createCounterpartyRequestSchema, errorResponseSchema } from "../schemas";
import { errorResponses, jsonContent } from "./helpers";
import { counterpartyResponse } from "./responses";

export function registerCounterpartyPaths(registry: OpenAPIRegistry) {
  registry.registerPath({
    method: "post",
    path: "/v1/counterparties",
    tags: ["Counterparties"],
    summary: "Create counterparty",
    operationId: "createCounterparty",
    description:
      "Creates a counterparty within the (organization, project) scope. Returns 409 if a counterparty with the same externalId already exists in scope.",
    security: [{ apiKeyAuth: [] }],
    request: {
      body: {
        required: true,
        content: jsonContent(createCounterpartyRequestSchema),
      },
    },
    responses: {
      201: {
        description: "Counterparty created",
        content: jsonContent(counterpartyResponse),
      },
      ...errorResponses(errorResponseSchema, [400, 401, 403, 409, 500]),
    },
  });
}
