# Agent-led Thinkarr connection setup

This guide ships with the plugin so the owner's main/setup agent can discover the procedure itself. Use supported local operator tools for host changes and the Thinkarr API for enrollment. **Do not automate a Plex login in a gateway browser.**

If discovery or enrollment is unavailable on an older Thinkarr build, stop and request the compatible app update. Do not fall back to browser automation. Upgrade the installed companion before running its new helper; an older manifest cannot accept native-secret configuration.

## Public metadata needs no login

```bash
curl --fail --silent --show-error https://thinkarr.example.com/api/mcp/info
```

Response: `{"version":1,"audience":"<public instance ID>"}`. This is available before creating an integration or credential and is not an authorization token. The helper performs this lookup; the owner does not need to copy the audience.

## Owner authorization

In the owner's normal browser, open Thinkarr **Settings → MCP → Service integrations** and select the intended integration. Save the native group ID, public linking origin and bot number. Set the desired curated operation scopes and enable when ready. No container variables or restart are required.

For linking and reads, allow `account_link_start`, `account_link_confirm`, `media_search` and `media_details`. To offer confirmed requests, additionally allow `media_select` and `media_confirm_request`. The helper does not expand the owner's operation allowlist.

Choose **Create setup code**, not **Issue credential**. This authorizes exactly one public-key enrollment and service credential for that integration for ten minutes. It does not give the agent an administrator session or permission to manage other integrations. New codes replace old ones; configuration changes, disablement and credential issuance invalidate pending codes.

An active service credential prevents new enrollment. Reuse its existing protected setup if available; otherwise the owner must explicitly revoke/rotate it. Do not rotate credentials silently.

## Run the trusted helper locally

Find the installed package directory with `openclaw plugins inspect thinkarr --json`. With the plugin disabled, run as the gateway OS user:

```bash
node /path/to/installed/thinkarr/dist/openclaw/setup.js \
  --origin https://thinkarr.example.com \
  --account default
```

The owner enters the setup code into the helper's **hidden terminal prompt**. For a trusted secure-input integration, the helper also accepts the code on stdin. Never put it in command arguments, agent chat or model-visible output. This is the owner's authorization step; local file/key/config work belongs to the agent/helper.

To reuse an already-prepared dedicated Ed25519 key, add `--key-file /protected/path/to/existing-key.pem`. The helper checks the regular file's ownership/permissions and imports it without printing it. Without that option, it generates the key in process memory; it does not create a private-key file. Do not regenerate an existing prepared key merely because a browser cannot launch.

If the native store uses a non-default provider alias, pass `--secret-provider <configured-store-provider>`. The helper does not replace global secret providers or security policy.

The helper:
1. Checks the installed plugin/current entry and preserves an existing native connection rather than reenrolling it. Disable a legacy active instance before migration.
2. Fetches public audience metadata over verified HTTPS.
3. Calls `POST /api/mcp/setup` with the one-use code in Authorization and only issuer/key ID/public key in JSON. No Plex session/cookie is used. Never send a private key to Thinkarr.
4. Saves the bearer and private key using `openclaw secrets store set <name> --kind secret` with values on **stdin**, not arguments, environment or custom credentials files.
5. Writes only this plugin's public settings and native SecretRefs using the supported config command, keeping unrelated routing/configuration intact. The integration's group and bot identity come from the authorized API response.
6. Reports only safe setup status, public service/key/credential IDs and that the plugin is still disabled. `already_configured` is not a readiness claim.

An enrollment reply may be lost after a real credential issuance. Do not blindly retry: inspect the integration's credential metadata in Thinkarr. If storage/configuration fails after issuance, the helper reports the public credential ID so the owner can revoke it before a fresh enrollment. It never falls back to plaintext storage or prints raw API/CLI errors.

## Activate and verify

The normal plugin build includes structured Gateway diagnostics. For a failed authorized attempt, enable the plugin's **Debug logs** setting (`plugins.entries.thinkarr.config.debug: true`), apply the configuration normally, then inspect `[thinkarr]` records from the next owner-initiated attempt. Collect its random `traceId`, stage/reason, HTTP/error codes and prepared-secret availability flags. See README → Diagnostics and debug mode for CLI commands and stage meanings. Set `debug: false` and apply again to stop detailed progress records; errors and operation summaries remain available. Do not dump configuration, secrets, chat/message payloads or raw upstream errors. A `registration.ready` record confirms the active debug setting.

For latency investigations, use a timing-enabled Thinkarr app and companion 0.3.7 or later. With debug enabled, match each HTTP `requestId` between client records and app `MCP_HTTP_TIMING` logs. Compare fetch-to-headers duration against the app's `Server-Timing` total, then inspect server phase starts/ends and client body completion. `serverTimingAvailable: false` indicates the server response lacks the new metrics. App totals include awaited SDK cleanup; the client remainder includes network/proxy/framework/client-scheduling time and is not proof of a network fault. Request IDs are diagnostics only, not JWT nonces, identities or credentials.

For upgrade drain timeouts, companion 0.3.8 adds executing-version/instance IDs, whole-operation work accounting, ten-second debug snapshots (including idle), cancellation/disposal observations and timed MCP cleanup settlement. Follow README → Diagnosing an upgrade that does not drain. Capture the host's saved-versus-active status and drain facts as well as companion logs before recovery. The lifecycle abort can occur after pre-replacement drain; a missing abort is not itself a plugin fault. These diagnostics do not instrument an older already-stuck runtime or establish a lifecycle fix without a managed-upgrade reproduction. Preserve existing binding/enrollment/SecretRefs/keys and never replay uncertain writes.

Registration errors identify schema-owned fields, validation codes and connection-value types only. Report that bounded error and generation receipt, not configuration snapshots, Zod error objects or secret values. Version `0.3.3` accepts native SecretRefs at registration and obtains prepared credentials only inside an admitted invocation. Existing references and enrollment need no changes. If a native secrets refresh has already succeeded and registration still fails, stop; do not repeat refresh/reload or reenroll. An update may itself attempt activation; collect that result before deciding whether a separate reload is necessary. Runtime activation alone does not prove prepared-secret access; the owner's authorized WhatsApp linking turn verifies that boundary.

Use the normal OpenClaw owner capability review and plugin enable action. Grant the four optional `thinkarr_*` tools additively to the intended agent/context; retain unrelated tools and finance routing. The helper does not replace the agent's tool allowlist.

Refresh secrets as required and run `openclaw secrets audit --check`. Separate this integration's unresolved references from pre-existing unrelated audit findings; do not start a broad secret migration as an activation repair.

Apply the managed plugin update/reload once and wait for its generation receipt. Check the **running Gateway's** `plugins.list` runtime state and any concrete error. Installed/enabled configuration and cold or scoped CLI inspection are not proof that the Gateway loaded the instance. If it remains unloaded, stop and report the manifest/activation/policy/error evidence; repeated reloads and source/catalog inspection are not a recovery strategy. Follow an explicit restart-required receipt if the platform returns one. Use managed archive replacement and ordinary capability consent; do not edit installed bundle files or bypass provenance/trust checks.

The manifest must own all four tool names and activate at startup for its message hook. Generic `tools.catalog` and even session-metadata `tools.effective` inspections can omit the executable tools: version-2 factories require actual host WhatsApp sender/account/native-conversation metadata and an admitted invocation. Do not invent an identity, relax factory guards, widen the agent profile or keep reloading just to make those names appear in a context-free catalog.

Once native secrets resolve and the Gateway runtime is active, report **configured/runtime-active; awaiting an authorized WhatsApp turn**, rather than treating missing context-free tools as failed enrollment. The owner's next admitted message in the configured group provides the real context for checking tool availability and initiating private linking. Check role/group/account/self/revocation failures through that authorized interaction; no autonomous challenge/message/request is needed for offline readiness.

The manifest also declares the packaged [Thinkarr interaction skill](skills/thinkarr/SKILL.md). Ensure it is available to the intended agent under normal skill policy. Use native scoped Thinkarr tools instead of legacy administrator MCP tools. After `media_select` reports `prompt_sent`, the agent should end with `NO_REPLY` because the real prompt already contains all instructions. The participant replies directly to that prompt; full post-admission native group facts reach `reply_dispatch`, and the plugin owns submission/status. Normal foreground group `message_tool_only` suppression applies to automatic finals and permits the explicit native result; hard send-policy denial and other delivery suppression remain authoritative. Do not infer group authority from the bot recipient or session key, take over observed-only/synthetic/internal or ACP/background turns, or fabricate confirmation events. A media-confirmation permission error is an integration/operator check, not a reason to relink an existing participant.

For private verification, use the latest browser-generated prefilled WhatsApp message. The companion handles the pinned host's peer/receiving-bot DM address forms and sends an explicit private acknowledgement. In logs, `verification.result` reports the backend linking outcome; `verification.reply_delivered` confirms its acknowledgement, and `verification.reply_unconfirmed` reports an uncertain send without retrying it. `operation.completed` includes `acknowledgementConfirmed`. Rejected input records identify the specific event/account/sender/conversation check without printing identities or codes. After updating from a failed/expired attempt, initiate one fresh link through the authorized group turn and complete its new verification message; existing integration enrollment and protected credentials stay valid.

Do not replace an arrived private link merely because its delivery receipt is unconfirmed. Tell the participant to follow those private instructions. A handshake timeout is reported as `unavailable`, not as an invalid code; retry that step only while its link remains valid. A timeout after the tool call starts is `unknown`: check linked-account status before another attempt, because the binding may already be committed. HTTP diagnostics identify each initialization/notification/tool-call phase. The linking deadline is bounded at 45 seconds, with separate acknowledgement headroom; no automatic reconnect, send or verification retry is introduced.

If setup has already succeeded, retain the existing native secrets and registered key. Activation repair is not a reason to issue a new setup code, rotate the bearer, regenerate keys or rerun enrollment. Resume a blocked setup only after meaningful new evidence or a relevant package/config change, not another unchanged polling/heartbeat pass.

After native secret storage and runtime access are verified, retire only temporary plaintext key/credential copies created for this connection. Never delete an unknown file or an active signing key before its replacement is verified.

Do not send messages, create account-link challenges or submit media merely to prove setup. Once ready, the owner initiates normal private Plex linking and a deliberately confirmed request. If a required owner approval, secure-input channel or supported API is unavailable, stop at that exact blocker; do not broaden a diagnostic device, use an admin bearer as a participant credential, or reconstruct authority from chat text.
