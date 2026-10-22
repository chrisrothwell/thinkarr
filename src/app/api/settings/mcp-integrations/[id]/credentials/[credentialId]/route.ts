import { integrationAdminApi } from "@/lib/mcp/integration-api";
import { revokeServiceCredential } from "@/lib/mcp/service-principals";

export async function DELETE(_request: Request, context: { params: Promise<{ id: string; credentialId: string }> }) {
  return integrationAdminApi(async (actor) => {
    const { id, credentialId } = await context.params;
    revokeServiceCredential(id, credentialId, actor);
    return { revoked: true };
  });
}
