import { accountLinkSessionApi } from "@/lib/mcp/account-link-api";
import { listAccountBindings } from "@/lib/mcp/account-linking";

export async function GET() {
  return accountLinkSessionApi((session) => listAccountBindings(session.user.id));
}
