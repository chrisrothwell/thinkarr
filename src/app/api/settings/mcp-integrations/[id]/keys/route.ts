import { integrationAdminApi, integrationJson } from "@/lib/mcp/integration-api";
import { registerKeySchema, registerServiceKey } from "@/lib/mcp/service-principals";

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  return integrationAdminApi(async (actor) => registerServiceKey(
    (await context.params).id, registerKeySchema.parse(await integrationJson(request)), actor,
  ));
}
