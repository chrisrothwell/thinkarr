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

Use the normal OpenClaw owner capability review and plugin enable action. Grant the four optional `thinkarr_*` tools additively to the intended agent/context; retain unrelated tools and finance routing. The helper does not replace the agent's tool allowlist.

Refresh secrets/reload the plugin as required and run `openclaw secrets audit --check`. Inspect the plugin's **actual runtime registrations** and the intended group's effective tools. Confirm missing references, wrong group/account/self identity or revoked credentials fail closed. Do not report ready on the basis of installed package metadata alone.

After native secret storage and runtime access are verified, retire only temporary plaintext key/credential copies created for this connection. Never delete an unknown file or an active signing key before its replacement is verified.

Do not send messages, create account-link challenges or submit media merely to prove setup. Once ready, the owner initiates normal private Plex linking and a deliberately confirmed request. If a required owner approval, secure-input channel or supported API is unavailable, stop at that exact blocker; do not broaden a diagnostic device, use an admin bearer as a participant credential, or reconstruct authority from chat text.
