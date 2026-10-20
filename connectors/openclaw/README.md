# Thinkarr OpenClaw linking plugin

Native, separately packaged linking adapter for **OpenClaw 2026.10.4** on POSIX hosts. It registers the optional `thinkarr_account_link` tool and a narrowly claimed `before_dispatch` private-verification hook. It calls Thinkarr through standard MCP with the signed delegated profile. It does not expose media/request tools or alter existing finance routing.

## Build and verify

From the Thinkarr repository after `npm ci`:

```bash
npm run check:openclaw
npm run build:openclaw
npm pack ./connectors/openclaw
```

The archive is `thinkarr-openclaw-0.1.0.tgz`. It contains compiled ESM for the adapter and portable linking core, its manifest and this README. Runtime MCP/JOSE/Zod dependencies are declared separately; OpenClaw remains an optional exact-version peer, not an application dependency. Its own lockfile supports reproducible dependency checks; CI also runs `npm audit --prefix connectors/openclaw --omit=dev --audit-level=low`. The build requires this repository's development dependencies; consumers install the built archive rather than the source directory.

`check:openclaw` downloads integrity-pinned published OpenClaw and TypeBox archives into ignored `node_modules/.cache`, extracts declarations only, and checks the adapter's structural registration surface against the actual SDK. It never executes or installs the OpenClaw runtime. CI runs that check and builds the plugin. Unit tests exercise source-shaped factories/hooks, real local credential files and the real Thinkarr backend with synthetic provider sends. This is not a live gateway/provider proof.

## Operator configuration

Keep the plugin disabled until the controlled integration test is approved. This PR does not install anything into a gateway, send WhatsApp messages, or make Thinkarr integrations activatable. Thinkarr management still rejects activation.

Example OpenClaw plugin entry:

```json
{
  "plugins": {
    "entries": {
      "thinkarr": {
        "enabled": false,
        "config": {
          "credentialsFile": "/secure/thinkarr-mcp.json",
          "accounts": { "default": "+15555550100" }
        }
      }
    }
  }
}
```

`accounts` maps receiving WhatsApp account IDs to the bot's own E.164 identity for self/echo rejection. It is not a participant allowlist. Use exact host account IDs; no missing-account default is inferred. The bot number must match the WhatsApp handoff configured in Thinkarr. OpenClaw's existing channel admission policy remains the authority for who may address the assistant. When testing is approved, grant `thinkarr_account_link` through the agent's **additive** tool policy, retaining existing tools and Splitwise routing.

The credentials file is an operator-owned JSON object with these fields:

| Field | Value |
| --- | --- |
| `endpoint` | Configured HTTPS Thinkarr URL ending exactly in `/api/mcp` |
| `publicLinkOrigin` | Independently configured handset-reachable HTTPS origin used by Thinkarr private links |
| `service` | Thinkarr service principal UUID |
| `issuer`, `keyId` | Connector issuer and public-key ID registered on that principal |
| `audience` | Stable delegation audience shown in Thinkarr integration settings |
| `bearer` | One-time issued `thk_svc_` service credential |
| `privateKeyPem` | Dedicated Ed25519 PKCS#8 private key; register only its public key in Thinkarr |

Use a regular file owned by the gateway process UID with mode `0600`, outside model-accessible workspaces and denied to agent file/exec tools. Do not put bearer/private-key values in plugin config, prompts, tool arguments or a repository. Symlinked, oversized, non-owned or group/world-accessible files fail closed. The file is reread for each operation, so local key/credential rotation needs no cached-connection refresh. Read/parser errors return only a safe failed outcome.

## Identity and delivery contract

- Tool factories capture host channel/account/sender/native conversation and use `assertInvocationCurrent`; they never parse session keys or cache the latest sender. Tool arguments must be exactly `{}`.
- Canonical sender namespace is the provider PN JID (`digits@s.whatsapp.net`). Exact E.164 and PN-JID host aliases normalize to that namespace. Group kind is classified only from a validated native `@g.us` provider address; direct conversation must normalize to the exact sender. Conflicting current-route metadata is rejected.
- **LID-only, hosted/device-scoped, unknown and ambiguous identities are unsupported and fail closed.** No local LID files, guessed digits, model-supplied aliases or unauthenticated mappings are used. Supporting these identities requires verified provider alias resolution and separate tests. Identity reassignment recovery remains a launch prerequisite.
- Private delivery loads `runtime.channel.outbound.loadAdapter("whatsapp")`, resolves the exact sender and verifies the resolver cannot redirect it to a group/other identity. It calls `sendText` on the receiving account, never a current-group `delivery.send` helper. The pinned WhatsApp implementation forwards `onPlatformSendDispatch` to every physical send; the adapter uses that fence to recheck cancellation/lifecycle/invocation authority. The related handoff callback is also supplied, but the pinned implementation does not forward it, so it is not relied upon.
- A nonempty provider-accepted message ID and actual returned `toJid` matching the canonical private sender are required. LID/unknown/different destinations, missing dispatch fences, partial/unknown sends and exceptions return safe failure, with no automatic retry or public fallback. Acceptance is not proof of handset delivery/read.
- The hook handles only the exact browser-prefilled `Link account <64 lowercase hex>` message on WhatsApp. It requires explicit direct-chat metadata, matching event/context sender and message IDs, original millisecond timestamp, receiving account and matching private conversation. Invalid matching attempts are handled with a safe failure so codes do not enter the ordinary model turn. Other messages remain unclaimed.
- Self identities are rejected; human-only channel admission remains the host's responsibility. The hook uses its admitted invocation lifetime and plugin lifecycle signal; it does not invent a provider ID or reuse a tool-turn sender. Thinkarr independently checks browser/session ownership and durable provider-event replay.

Before launch, validate actual tool/native conversation formats, PN/LID identity consistency, human admission/self echoes, callback fences, returned private receipts, transcript privacy, interleaved participants/groups and the handset handoff in an explicitly approved isolated gateway. Service activation, no-library-share admission and the actor-scoped media facade remain separate prerequisites.
