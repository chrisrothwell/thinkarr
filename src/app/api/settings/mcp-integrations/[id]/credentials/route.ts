import { integrationAdminApi, integrationJson } from "@/lib/mcp/integration-api";
import { issueCredentialSchema, issueServiceCredential } from "@/lib/mcp/service-principals";

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  return integrationAdminApi(async (actor) => issueServiceCredential(
    (await context.params).id, issueCredentialSchema.parse(await integrationJson(request)), actor,
  ));
}
