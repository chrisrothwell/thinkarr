import { z } from "zod";
import { eq } from "drizzle-orm";
import { getDb, schema } from "@/lib/db";

export const whatsappGroupSchema = z.string().trim().max(512).regex(/^[0-9]+(?:-[0-9]+)?@g\.us$/);

/** Group policy is stored with the integration and rechecked on every call. */
export function requireIntegrationGroup(context: { principalId: string; delegation: { channel: string; kind: string; conversation: string } }) {
  const principal = getDb().select({ enabled: schema.mcpServicePrincipals.enabled, group: schema.mcpServicePrincipals.pilotGroup })
    .from(schema.mcpServicePrincipals).where(eq(schema.mcpServicePrincipals.id, context.principalId)).get();
  const c = context.delegation;
  if (!principal?.enabled || !whatsappGroupSchema.safeParse(principal.group).success || c.channel !== "whatsapp" || c.kind !== "group" || c.conversation !== principal.group) throw new Error("This group is not permitted for the integration.");
}
