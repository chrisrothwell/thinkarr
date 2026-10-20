import { z } from "zod";

export const publicLinkOriginSchema = z.string().trim().min(1).max(2048).superRefine((value, ctx) => {
  try {
    const url = new URL(value);
    const local = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
    if (!(url.protocol === "https:" || (url.protocol === "http:" && local))
      || url.username || url.password || url.pathname !== "/" || url.search || url.hash) throw new Error();
  } catch { ctx.addIssue({ code: "custom", message: "Use an HTTPS origin without credentials, path, query or fragment (HTTP loopback is allowed for development)" }); }
}).transform((value) => new URL(value).origin);

export const whatsappBotNumberSchema = z.string().trim().regex(/^\+?[1-9][0-9]{6,14}$/)
  .transform((value) => value.replace(/^\+/, ""));

export function linkHandoffConfig(value: { publicLinkOrigin?: string | null; whatsappBotNumber?: string | null }) {
  return {
    publicLinkOrigin: publicLinkOriginSchema.parse(value.publicLinkOrigin),
    whatsappBotNumber: whatsappBotNumberSchema.parse(value.whatsappBotNumber),
  };
}

/** A fragment never travels in the HTTP request, server logs or Referer. */
export function privateAccountLinkUrl(publicLinkOrigin: string, token: string) {
  const origin = publicLinkOriginSchema.parse(publicLinkOrigin);
  if (!/^[a-f0-9]{64}$/.test(token)) throw new Error("Invalid link token");
  const url = new URL("/mcp/connect", origin);
  url.hash = `token=${token}`;
  return url.href;
}

export function privateLinkFragmentToken(fragment: string): string | null {
  return /^#token=([a-f0-9]{64})$/.exec(fragment)?.[1] ?? null;
}

/** Only the administrator-configured bot destination is accepted. */
export function whatsappVerificationUrl(botNumber: string, completionCode: string) {
  const number = whatsappBotNumberSchema.parse(botNumber);
  if (!/^[a-f0-9]{64}$/.test(completionCode)) throw new Error("Invalid completion code");
  const url = new URL(`https://wa.me/${number}`);
  url.searchParams.set("text", `Link account ${completionCode}`);
  return url.href;
}
