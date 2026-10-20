import { accountLinkSessionApi } from "@/lib/mcp/account-link-api";
import { revokeAccountBinding } from "@/lib/mcp/account-linking";

export async function DELETE(_request: Request, context: { params: Promise<{ id: string }> }) {
  return accountLinkSessionApi(async (session) => {
    revokeAccountBinding((await context.params).id, session.user.id);
    return { unlinked: true };
  });
}
