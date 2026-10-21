import { z } from "zod";

/** Opt-in on beta only; no general activation or participant allowlist. */
export function pilotConfiguration() {
  const principalId = process.env.THINKARR_MCP_PILOT_PRINCIPAL;
  const group = process.env.THINKARR_MCP_PILOT_GROUP;
  return z.string().uuid().safeParse(principalId).success && typeof group === "string"
    && group.length <= 512 && /^[0-9]+(?:-[0-9]+)?@g\.us$/.test(group) ? { principalId: principalId!, group } : undefined;
}
export function isPilotIntegration(id: string) { return pilotConfiguration()?.principalId === id; }
export function requirePilotGroup(context: { principalId: string; delegation: { channel: string; kind: string; conversation: string } }) {
  const pilot = pilotConfiguration(); const c = context.delegation;
  if (!pilot || context.principalId !== pilot.principalId || c.channel !== "whatsapp" || c.kind !== "group" || c.conversation !== pilot.group) throw new Error("Beta pilot is not available in this context.");
}
