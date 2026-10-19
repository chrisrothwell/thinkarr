import { integrationAdminApi, integrationJson } from "@/lib/mcp/integration-api";
import { createIntegration, createIntegrationSchema, DELEGATED_MCP_AVAILABLE, listIntegrations, SERVICE_OPERATIONS } from "@/lib/mcp/service-principals";

export async function GET() {
  return integrationAdminApi(() => ({
    integrations: listIntegrations(), delegatedAccessAvailable: DELEGATED_MCP_AVAILABLE,
    availableOperations: SERVICE_OPERATIONS,
  }));
}

export async function POST(request: Request) {
  return integrationAdminApi(async (actor) => createIntegration(createIntegrationSchema.parse(await integrationJson(request)), actor));
}
