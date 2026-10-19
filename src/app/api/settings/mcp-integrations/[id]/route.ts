import { integrationAdminApi, integrationJson } from "@/lib/mcp/integration-api";
import { getIntegration, updateIntegration, updateIntegrationSchema } from "@/lib/mcp/service-principals";

type Context = { params: Promise<{ id: string }> };

export async function GET(_request: Request, context: Context) {
  return integrationAdminApi(async () => getIntegration((await context.params).id));
}

export async function PATCH(request: Request, context: Context) {
  return integrationAdminApi(async (actor) => updateIntegration(
    (await context.params).id, updateIntegrationSchema.parse(await integrationJson(request)), actor,
  ));
}
