# Delegated MCP linking connector core

`linking.ts` is a harness-neutral trusted connector core, independent of Next.js and Thinkarr's database. It uses the standard MCP SDK and JOSE dependencies already pinned by this repository. The separately packaged [OpenClaw adapter](../openclaw/README.md) wraps this core. General integration activation remains disabled; the explicitly configured beta pilot can be enabled through Settings.

## Host contract

Create the connector in trusted host code with the configured Thinkarr endpoint, stable audience, service principal, service bearer, independent Ed25519 PKCS#8 private key, registered issuer/key ID and mobile public link origin. Keep those credentials outside model-accessible files and tools. Generate a dedicated connector key; never reuse diagnostic/gateway device credentials. HTTPS is required except for explicit HTTP loopback development.

For each invocation, supply canonical provider channel/account/sender/conversation identities, an explicit direct/group kind, cancellation signal where available, and a live `assertCurrent` guard. These are host metadata, not tool arguments. The connector snapshots identities, creates/disposes a separate MCP client, signs the final serialized body for every HTTP POST, pins the exact endpoint and refuses redirects. It does not cache the latest sender, pool actor headers or retry private sends. Only the model-safe status (`linked`, `private_link_sent`, `failed`) is returned; raw MCP output and errors never escape.

`sendPrivate` is a trusted host capability. It must resolve the canonical sender to that sender's **private** provider target on the exact receiving account, recheck `delivery.assertCurrent()` immediately before each physical send, honor cancellation, and return an actual platform acceptance receipt with channel/account/canonical recipient/message ID. A group/current-route helper is insufficient. Missing or ambiguous alias/LID relationships must fail closed. Never echo the URL in a public fallback or log it. `private_link_sent` means provider acceptance, not handset read/delivery. Failure/unknown delivery returns only `failed` and is never automatically retried; a later explicit link attempt supersedes the old challenge on Thinkarr.

Expose `startLink` through a zero-argument tool closure over the immutable host invocation. The connector validates the private handoff's target, configured origin, fragment-only token URL, expiry and exact wire outcome before delivery, and strips all metadata from its return value. Private link initiation is not public acknowledgment of successful delivery until a matching receipt is checked.

Call `handlePrivateLinkMessage` only from an admitted human inbound hook. The exact `Link account <64 lowercase hex>` browser-prefilled message requires direct chat, canonical provider event ID and original millisecond timestamp. Other content returns `undefined` for the existing router; a matching but invalid/failed attempt returns a safe failed outcome. Bind claimed outcomes to the host's handled response so the verification code is not sent to the model. Thinkarr independently verifies sender ownership, challenge/session state and durable event replay. Do not expose completion as a model tool.

## OpenClaw adapter boundary

Source inspected at `openclaw/openclaw` tag `v2026.10.4`:

- `src/plugins/tool-types.ts`: version-2 tool factories supply `requesterSenderId`, `messageChannel`, `agentAccountId`, `nativeChannelId`, `assertInvocationCurrent`. They do **not** provide an explicit chat-kind field. Do not guess it from `sessionKey` or mutable session caches.
- `src/plugins/hook-types.ts`: `before_dispatch` supplies sender/message/timestamp and explicit `isGroup` on the event, with channel/account/conversation context, and returns handled/text. Missing/conflicting metadata must fail closed; bot/self-event suppression and host admission need adapter proof.
- `src/plugins/runtime/types-channel.ts`: supported outbound adapter loading is `runtime.channel.outbound.loadAdapter`.
- `extensions/whatsapp/src/channel-outbound.ts`: the channel's send path has message receipts. Its private target normalization and canonical sender/LID equality must be validated in the host adapter; a receipt-shaped object alone cannot prove private routing.

The OpenClaw adapter checks registration against the published SDK and provides conservative PN-JID/E.164 identity normalization, native-address conversation classification, private outbound fences and receipt validation. Unresolved LID/hosted/device identities fail closed. Tests exercise source-shaped host calls against the actual Thinkarr route and synthetic provider delivery, not a live WhatsApp installation. Live alias/routing/receipt/handset proof and any broader identity support remain launch gates. No plugin installation, live delivery or activation is performed by this module.

## Beta media flow

`media-contract.ts` defines strict public argument/result projections and deterministic confirmation grammar. `mediaTool` accepts only exact search/details/selection names and their bounded arguments. A selection draft is never returned to the model: the optional trusted `sendPrompt` capability delivers its server-owned text to the exact captured group, returns an accepted message ID/destination, and the connector signs a hidden command-source presentation acknowledgement. Only a checked acknowledgement produces `prompt_sent`; failed/uncertain sends are not retried or publicly reconstructed.

`confirmMediaMessage` accepts only admitted inbound message metadata and ordinary text, derives the signed intent/choice from that text and carries verified native quote IDs. It is not a model tool. Unrelated text is unclaimed; `unclaimed` from Thinkarr also leaves the normal router alone. The same isolated-client signing, cancellation, URL pinning, metadata stripping and current-invocation checks apply. Public results are validated through the explicit nested allowlist; unknown upstream data/errors never pass through. The actual request claim and write-attribution enforcement live on Thinkarr, not in client memory.
