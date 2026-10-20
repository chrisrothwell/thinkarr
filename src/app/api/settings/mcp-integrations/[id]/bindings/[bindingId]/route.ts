import { integrationAdminApi } from "@/lib/mcp/integration-api";
import { revokeAccountBinding } from "@/lib/mcp/account-linking";

export async function DELETE(_request: Request, context: { params: Promise<{ id: string; bindingId: string }> }) {
  return integrationAdminApi(async (actor) => {
    const { id, bindingId } = await context.params;
    revokeAccountBinding(bindingId, actor, id);
    return { revoked: true };
  });
}
