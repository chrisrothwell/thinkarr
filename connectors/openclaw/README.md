# Thinkarr OpenClaw beta pilot plugin

Native, separately packaged adapter for **OpenClaw 2026.10.4** on POSIX hosts. It registers optional `thinkarr_account_link` and an admitted `before_dispatch` hook over signed standard MCP. With an explicit `pilotGroup`, it additionally registers optional `thinkarr_media_search`, `thinkarr_media_details` and `thinkarr_media_select` only for that native group. Existing finance routing is retained.

## Build and verify

From the Thinkarr repository after `npm ci`:

```bash
npm run check:openclaw
npm run build:openclaw
npm pack ./connectors/openclaw
```

The archive is `thinkarr-openclaw-0.2.0.tgz`. It contains compiled ESM for the adapter and portable connector/contracts, its manifest and this README. Runtime MCP/JOSE/Zod dependencies are declared separately; OpenClaw remains an optional exact-version peer, not an application dependency. Its own lockfile supports reproducible dependency checks; CI also runs `npm audit --prefix connectors/openclaw --omit=dev --audit-level=low`. The build requires this repository's development dependencies; consumers install the built archive rather than the source directory.

`check:openclaw` downloads integrity-pinned published OpenClaw and TypeBox archives into ignored `node_modules/.cache`, extracts declarations only, and checks the adapter's structural registration surface against the actual SDK. It never executes or installs the OpenClaw runtime. CI runs that check and builds the plugin. Unit tests exercise source-shaped factories/hooks, real local credential files and the real Thinkarr backend with synthetic provider sends. This is not a live gateway/provider proof.

## Operator configuration

The controlled beta pilot is opt-in. The package does not install itself, send messages or activate an integration. General Thinkarr integration activation is still unavailable; only the exact server-configured beta principal/group can be enabled in Settings.

Example OpenClaw plugin entry:

```json
{
  "plugins": {
    "entries": {
      "thinkarr": {
        "enabled": false,
        "config": {
          "credentialsFile": "/secure/thinkarr-mcp.json",
          "accounts": { "default": "+15555550100" },
          "pilotGroup": "120300000000@g.us"
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

## Minimal beta pilot

1. Deploy the reviewed build to beta through the normal release workflow. In beta Settings → Service integrations, create the disabled integration, copy its ID, configure the phone-reachable HTTPS link origin and bot E.164 number, issue its credential and register a dedicated public signing key.
2. Configure **beta only** with `THINKARR_MCP_PILOT_PRINCIPAL=<integration UUID>` and `THINKARR_MCP_PILOT_GROUP=<native @g.us group ID>`, then restart beta. These identifiers are not credentials. The native group must match `pilotGroup` above. Removing/changing either environment setting invalidates the enabled pilot; it does not enable other integrations.
3. Select `account_link_start`, `account_link_confirm`, `media_search`, `media_details`, `media_select` and `media_confirm_request` in the operation allowlist. Save, then choose **Enable beta pilot**. The Disable button remains the immediate stop control.
4. Install the built archive on the gateway using the normal OpenClaw plugin installation mechanism. Configure the mode-0600 credentials file described above and the actual receiving account/self number. Enable the plugin and add the four optional `thinkarr_*` tools to Helga's **additive** tool policy; preserve existing tools, Splitwise credentials and routing. No model tool can submit requests directly.
5. In the isolated self-and-bot group, ask Helga to link Plex. Open the private link, sign in, tap **Finish in WhatsApp** and send the prefilled verification. Then ask for a title, choose it (and explicit TV seasons), and reply **request it** to the separately delivered confirmation. Check the actual requester and pending/approved result in Seerr.

Search/details reuse the web's Seerr/TMDB endpoints and basic title facts. They deliberately omit global availability, personal activity, request history and token-bearing URLs. No current Plex share is required to search the public title catalog or submit a request Seerr permits. Existing normal web registration rules still apply during linking; use an existing eligible Plex/Thinkarr account for this pilot.

The trusted adapter physically sends the server-fetched title/season prompt and validates the provider destination/message receipt before signing a hidden presentation acknowledgement. Only then does Thinkarr activate the two-minute confirmation. Model-generated text alone never activates it. New choices supersede old prompts immediately; after replacement reply directly to the latest prompt. `request 1` confirms the single current choice; other numbered replies ask for clarification. Generic `yes`/`yes please` is claimed only when quoting the exact active media prompt; unrelated finance messages are unclaimed.

Thinkarr atomically consumes the provider event and claims the selection, rechecks current identity/permission/quota, and submits with server-owned effective `X-Api-User` (no body `userId`). It checks returned requester, title/type, exact TV seasons and pending/approved status. A timeout, attribution mismatch, malformed response or crash after claiming is retained as submitting/unknown; fresh nonces/selections do not retry that target blindly. Check Seerr before further action. Completion emails remain Seerr's responsibility. Existing globally tracked/requested titles are conservatively blocked without disclosing another user's activity.

The pilot is where actual native-route formats, PN/LID identity consistency, admission/self echoes, private receipts, quoted prompt IDs and handset HTTPS behavior must be verified. Unsupported identities fail closed. Do not disable TLS verification to work around an ingress certificate problem. This package has not been installed or tested on a live gateway by the build itself.
