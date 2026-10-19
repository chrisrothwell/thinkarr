/** Caller identity is supplied by the server, never by tool arguments. */
export interface PersonalMcpContext {
  kind: "personal";
  permission: "admin" | "user";
  userId?: number;
}

/** No human identity or administrator permission is inherited from the creator. */
export interface ServiceMcpContext {
  kind: "service";
  principalId: string;
  credentialId: string;
  enabled: boolean;
  allowedOperations: readonly string[];
}

export type McpExecutionContext = PersonalMcpContext | ServiceMcpContext;
