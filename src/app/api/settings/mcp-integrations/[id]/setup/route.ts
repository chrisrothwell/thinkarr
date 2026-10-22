import { z } from "zod";
import { integrationAdminApi, integrationJson } from "@/lib/mcp/integration-api";
import { createConnectionSetup } from "@/lib/mcp/connection-setup";

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  return integrationAdminApi(async (actor) => {
    z.object({}).strict().parse(await integrationJson(request));
    return createConnectionSetup((await context.params).id, actor);
  });
}
