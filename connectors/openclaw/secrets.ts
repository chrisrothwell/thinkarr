/** Narrow runtime SDK boundary; the published SDK check verifies this signature.
 * Keep OpenClaw's runtime tree out of the Thinkarr application's dependencies.
 */
export type PreparedPluginSecretReader = (pluginId: string, path: string) => { value?: string; revision: number };

export async function loadPreparedSecretReader(): Promise<PreparedPluginSecretReader> {
  const specifier = "openclaw/plugin-sdk/secret-input-runtime";
  const sdk = await import(specifier) as { getPreparedPluginSecretInput?: PreparedPluginSecretReader };
  if (typeof sdk.getPreparedPluginSecretInput !== "function") throw new Error("Prepared plugin secrets unavailable");
  return sdk.getPreparedPluginSecretInput;
}
