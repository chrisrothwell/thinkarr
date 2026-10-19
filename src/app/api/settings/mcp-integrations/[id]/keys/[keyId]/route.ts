import { integrationAdminApi } from "@/lib/mcp/integration-api";
import { revokeServiceKey } from "@/lib/mcp/service-principals";

export async function DELETE(_request: Request, context: { params: Promise<{ id: string; keyId: string }> }) {
  return integrationAdminApi(async (actor) => {
    const { id, keyId } = await context.params;
    revokeServiceKey(id, keyId, actor);
    return { revoked: true };
  });
}
