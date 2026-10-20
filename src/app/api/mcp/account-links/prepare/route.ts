import { accountLinkSessionApi, accountLinkToken } from "@/lib/mcp/account-link-api";
import { prepareAccountLink } from "@/lib/mcp/account-linking";

export async function POST(request: Request) {
  return accountLinkSessionApi(async (session) => prepareAccountLink(await accountLinkToken(request), session.sessionId, session.user.id));
}
