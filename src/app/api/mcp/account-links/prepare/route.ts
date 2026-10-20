import { accountLinkBrowserOrigin, accountLinkSessionApi, accountLinkToken } from "@/lib/mcp/account-link-api";
import { AccountLinkError, prepareAccountLink } from "@/lib/mcp/account-linking";

export async function POST(request: Request) {
  return accountLinkSessionApi(async (session) => {
    const expected = request.headers.get("Thinkarr-Link-Expected-User");
    if (expected !== null && expected !== String(session.user.id)) throw new AccountLinkError("Your sign-in changed. Check the selected Plex account and try again.", 409);
    const prepared = prepareAccountLink(await accountLinkToken(request), session.sessionId, session.user.id, accountLinkBrowserOrigin(request));
    return { handoffUrl: prepared.handoffUrl, expiresAt: prepared.expiresAt };
  });
}
